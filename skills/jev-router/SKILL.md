---
name: jev-router
description: Offload parallel-workstream decisions to TypeSafe's Jev System One model — speculative fan-out (many questions in one request), routing with companion noul, confidence/probability thresholds, review checks, parallel batch triage, and Box image localization. Use when a task decomposes into independent workstreams that need classification, prioritization, conflict detection, routing, or verification. Available as MCP tools (jev_*) or CLI (jev-router) in any harness.
user-invocable: true
---

# Jev Router

Jev (https://typesafe.ai) is TypeSafe's first **System One model**. It is **not** a chat or code-generation LLM: it does not write text or code. You send it a `state` (string or JSON) plus typed **questions**, and it returns structured answers your code can branch on directly:

- `noul` → `{ noul: 0..1 }` — probability that the answer to a yes/no question is yes
- `choice` → `{ choice, probabilities, confidence }` — one of a fixed option set (criteria = map of option → description, up to 255 options)
- `score` → `{ score, probabilities, legend, confidence }` — a position on an ordered rubric (criteria = array of ≥2 level descriptions)
- `box` → `{ box: {left, top, right, bottom}, confidence }` — bounding box in an image, as fractions of its size (experimental; needs an image asset and the images header)

One request = one `POST https://api.typesafe.ai/v1/systemone` with `{ model, state, questions }`; every question in it is evaluated **in parallel** — that is the **speculative fan-out** pattern: ask everything you might need in one call and discard what you don't (https://docs.typesafe.ai/patterns/fan-out.md).

## Setup

Get a key at https://console.typesafe.ai/keys (or via the Vercel AI gateway) and set `TYPESAFE_API_KEY` in the environment (e.g. `~/.vibe/.env` for Mistral Vibe, `.claude/settings.local.json` → `env` for Claude Code, or `export` in your shell). Optional: `TYPESAFE_API_BASE` (default `https://api.typesafe.ai`), `TYPESAFE_MODEL` (default `jev-latest`), `JEV_ROUTER_TIMEOUT_MS` (60000), `JEV_ROUTER_MAX_RETRIES` (3), `JEV_ROUTER_CONCURRENCY` (6), `JEV_ROUTER_ALLOW_IMAGES` (true), `MAX_CONTEXT_CHARS` (200000). Cost: input tokens only (~$0.042/M); output tokens are free. Check `usage` in results.

## How to reach the router

Depending on the harness, either call the **MCP tools** (prefixed `jev_`) or run the **CLI** (`jev-router <command>`, JSON on stdout; any `--value` may be `@file`):

| MCP tool | CLI command | Purpose |
|---|---|---|
| `jev_models` | `jev-router models` | List available models |
| `jev_ask` | `jev-router ask --state … --questions …` | One request: state + typed questions → answers |
| `jev_fan_out` | `jev-router fan-out … [--min-confidence F]` | Many questions in ONE request; optional confidence-based discard list |
| `jev_plan_workstreams` | `jev-router plan --task … --candidates …` | Decompose a task into scored/routed parallel workstreams |
| `jev_route` | `jev-router route --item … --destinations …` | Route an item to a destination (choice + companion noul + threshold) |
| `jev_review` | `jev-router review --output … --criteria …` | Verify a workstream output against acceptance criteria |
| `jev_batch` | `jev-router batch --items … [--concurrency N]` | Many independent items, each its own request, run in parallel |
| `jev_box` | `jev-router box --image … --instructions …` | Locate something in an image (Box primitive) |

## When to use what

- **Planning parallel workstreams**: decompose the task yourself into `candidates`, then call `jev_plan_workstreams` with the task + candidates (+ relevant `files`). It fires ONE fan-out request asking per candidate for lane (choice), priority/risk/size (scores), independence and merge-conflict risk (nouls), plus a global parallel/sequential/hybrid approach. Execute `parallel_safe` workstreams concurrently with your subagents; run `needs_sequential` ones after. Then verify each result with `jev_review`.
- **Triage/routing at volume**: `jev_batch` with one item per ticket/PR/message (own state + questions each), concurrency ~6. Or `jev_route` for single items with a `threshold` (default 0.6) — `act=false` means escalate.
- **Verification**: `jev_review` with `criteria: [{id, check}]` (per-check noul, pass threshold default 0.7) and optional `rubric` for an overall quality score. `needs_human_review` flags low-confidence answers (confidence routing).
- **Fan-out by hand**: `jev_fan_out` whenever one state needs many decisions at once (classify + severity + urgency + flags in one call — the ticket-triage pattern).
- **Images/UI**: `jev_box` to localize an element in a screenshot (e.g. "the error banner"); coordinates are resolution-independent fractions.

## Guardrails

- **Never send secrets.** `TYPESAFE_API_KEY` lives in the environment, never in `state`/questions. Pass targeted files, not whole repos (`MAX_CONTEXT_CHARS` caps context; body limit 32 MiB).
- Jev decides; **you** execute. Don't ask Jev to write code, prose, or JSON blobs — ask noul/choice/score/box questions and branch in your own code.
- Give `choice` an `other`/`none_of_the_above` option (plus the companion `none_fit` noul in `jev_route`) when the list might not cover the input.
- 429/529/5xx are retried automatically with backoff; 401 means a bad/missing key; 422 means a malformed question — read the error body.
- Images/Box are "dreamer-ready" (experimental): the request format and accuracy can change between releases.
- If a Jev call fails in an agent loop, fall back to doing that decision locally rather than blocking.

## Examples

```bash
# Triage one ticket with speculative fan-out (one request, 4 questions)
jev-router fan-out --state "My invoice is wrong, I want a refund NOW" --questions '{
  "category": {"type": "choice", "instructions": "What is this ticket about?",
               "criteria": {"billing": "Charges, invoices, refunds", "technical": "Bugs", "other": "Anything else"}},
  "severity": {"type": "score", "instructions": "How severe?",
               "criteria": ["cosmetic", "degraded", "blocking"]},
  "refund":   {"type": "noul", "instructions": "Is a refund requested?"},
  "urgent":   {"type": "noul", "instructions": "Does the message convey urgency?"}
}'

# Plan parallel workstreams for a coding task
jev-router plan --task "Add rate limiting to the public API" \
  --candidates '["implement token-bucket limiter in src/rate-limit.js", "add config + env vars", "write tests", "update API docs"]' \
  --files '["src/server.js", "src/routes.js"]'

# Review a worker's output
jev-router review --output @pr-diff.patch --criteria '[
  {"id": "tests", "check": "The diff adds or updates tests"},
  {"id": "no-secrets", "check": "The diff contains no API keys or credentials"},
  {"id": "breaking", "check": "The diff does not change public API signatures"}
]'
```
