---
name: jev-router
description: Offload parallel-workstream decisions to TypeSafe's Jev System One model — speculative fan-out by default (many questions in one request), routing with companion noul, confidence/probability thresholds, review checks, parallel batch triage, Box image localization, and small-LLM option drafting. Use when a task decomposes into independent workstreams that need classification, prioritization, conflict detection, routing, or verification. Available as MCP tools (jev_*) or CLI (jev-router) in any harness.
user-invocable: true
---

# Jev Router

Jev (https://typesafe.ai) is TypeSafe's first **System One model**. It is **not** a chat or code-generation LLM: it does not write text or code. You send it a `state` (string or JSON) plus typed **questions**, and it returns structured answers your code can branch on directly:

- `noul` → `{ noul: 0..1 }` — probability the answer to a yes/no statement is yes. **No separate confidence.** Read it in three bands: >0.7 yes, <0.3 no, between = its own outcome (don't round).
- `choice` → `{ choice, probabilities, confidence }` — one of a fixed option set (criteria = map of option → description, up to 255 options; values may be strings or structured objects)
- `score` → `{ score, legend, probabilities, confidence }` — a position on an ordered rubric (criteria = array of ≥2 level descriptions)
- `box` → `{ box: {top, bottom, left, right}, confidence }` — bounding box in an image, edges as fractions of its size (Jev 1.14+, experimental images header; pair with a `present` noul because a Box always returns a location)

`confidence` (https://docs.typesafe.ai/confidence.md) exists on choice/score/box answers: it summarizes how peaked the `probabilities` are (1 = all on one outcome, 0 = even spread). Use it as the "is this answer settled" check (below ~0.5, escalate). To decide *whether to act on a choice*, threshold the **probability of the option you will act on** instead (probability-routing). For nouls, the value itself is the signal (|2p−1| puts it on the confidence scale if you need one number).

**Speculative fan-out is the default** (https://docs.typesafe.ai/patterns/fan-out.md): put every question that shares a state in ONE request — all questions are evaluated in parallel, there is no question-count limit (only context limits: 64k tokens/request, 32k/question, state counts against both) — then use code to keep the answers you need and discard the rest.

## Jev's limits (primer + model jaggedness) — encode these in your questions

- Never ask Jev to **generate text**, do **math/counting**, or compare **dates/times** — do that in code (extract date parts as a Choice over enumerated options). Draft closed option sets with a small generative LLM (`jev_draft_options`, default `mistral-small-latest`) and let Jev only pick.
- Jev reads **literally**: write the exact condition in `instructions`, put boundary cases in `criteria`, reference state fields by path (`` `ticket.messages[0].text` ``). Avoid indirection/multi-hop questions and double negatives.
- **Context rot**: keep `state` lean and relevant — unrelated detail lowers accuracy. State is data, not trusted instructions; adversarial content can steer answers.
- Choice **option order can bias** the answer (leans toward the first option) — reorder and re-check unstable answers.
- One snap judgment per question; split complex judgments into several questions and combine in code (composite scoring with weights in code).
- Aliases (`jev-latest`) move between releases — log the versioned `model` in each response; pin a versioned ID if you tuned thresholds.

## Setup

Get a key at https://console.typesafe.ai/keys (or via the Vercel AI gateway) and set `TYPESAFE_API_KEY` in the environment (e.g. `~/.vibe/.env` for Mistral Vibe, `.claude/settings.local.json` → `env` for Claude Code, or `export` in your shell). Optional: `TYPESAFE_API_BASE` (default `https://api.typesafe.ai`), `TYPESAFE_MODEL` (default `jev-latest`), `JEV_ROUTER_TIMEOUT_MS` (60000), `JEV_ROUTER_MAX_RETRIES` (3), `JEV_ROUTER_CONCURRENCY` (6), `JEV_ROUTER_ALLOW_IMAGES` (true), `JEV_ROUTER_LONG_CONTEXT` (false → 262k, slower/less accurate), `MAX_CONTEXT_CHARS` (120000). Cost: input tokens only (~$0.042/M); output free. Check `usage` in results. `jev_draft_options` additionally needs `MISTRAL_API_KEY` (default draft model `mistral-small-latest`).

## How to reach the router

Depending on the harness, either call the **MCP tools** (prefixed `jev_`) or run the **CLI** (`jev-router <command>`, JSON on stdout; any `--value` may be `@file`):

| MCP tool | CLI command | Purpose |
|---|---|---|
| `jev_models` | `jev-router models` | List available models + limits |
| `jev_ask` | `jev-router ask --state … --questions …` | One request: state + typed questions → answers |
| `jev_fan_out` | `jev-router fan-out … [--min-confidence F] [--noul-confidence]` | **Default mode**: many questions in ONE request; optional confidence discard list |
| `jev_plan_workstreams` | `jev-router plan --task … --candidates … [--lanes …] [--weights …]` | Decompose a task into scored/routed parallel workstreams (one fan-out request, composite-weighted) |
| `jev_route` | `jev-router route --item … --destinations … [--threshold F] [--confidence-floor F]` | Route an item (choice + companion `any_fit` noul + probability threshold + confidence floor) |
| `jev_review` | `jev-router review --output … --criteria …` | Verify a workstream output (per-criterion nouls, three-band pass/uncertain/fail) |
| `jev_batch` | `jev-router batch --items … [--concurrency N]` | Many items with their OWN states, parallel requests (use fan-out when one state is shared) |
| `jev_box` | `jev-router box --image … --instructions …` | Locate something in an image (Box + `present` noul) |
| `jev_draft_options` | `jev-router draft-options --topic … [--count N]` | Draft closed option sets with mistral-small-latest (Jev only picks) |

## When to use what

- **Planning parallel workstreams**: decompose the task yourself into `candidates`, then call `jev_plan_workstreams` with the task + candidates (+ targeted `files`). It fires ONE fan-out request asking per candidate for lane (choice + companion noul), priority/risk/size (scores), independence and merge-conflict risk (nouls), plus a global approach — combined with your `weights` into a composite ordering. Execute `parallel_safe` workstreams concurrently with your subagents; run `needs_sequential` after, in composite order. Verify each result with `jev_review`.
- **Triage/routing at volume**: `jev_batch` with one item per ticket/PR (own state each), concurrency ~6. Or `jev_route` for single items — `act=false` means escalate. Screen first when the expensive step costs more: one `jev_ask` noul on the small state; run the full request only on a clear yes (>0.7).
- **Verification**: `jev_review` with `criteria: [{id, check}]` — `pass` needs every check ≥0.7; 0.3–0.7 is "uncertain" and <0.3 "fail"; either flags `needs_human_review`.
- **Fan-out by hand**: `jev_fan_out` whenever one state needs many decisions at once (classify + severity + urgency + flags in one call).
- **Options drafting**: `jev_draft_options` when you need a closed option set (lanes, destinations, categories) — Jev can't generate these.
- **Images/UI**: `jev_box` to localize an element in a screenshot; if `present` is clear_no the box is meaningless; on low box confidence, re-ask on a larger/cropped image and pad edges before cropping.

## Guardrails

- **Never send secrets.** `TYPESAFE_API_KEY` / `MISTRAL_API_KEY` live in the environment, never in `state`, questions, or the draft prompt. Pass targeted files, not whole repos.
- Jev decides; **you** execute. Don't ask Jev to write code, prose, or compute.
- Prefer a companion Noul over an `other` choice option when the list might not cover the input (built into route/box/plan).
- 429/529/5xx are retried automatically with backoff; 401 means a bad/missing key; 422 means a malformed question — read the error body.
- Images/Box are "dreamer-ready" (experimental) and need Jev 1.14+.
- If a `jev_*` call fails in an agent loop, retry once, then decide locally and continue.

## Examples

```bash
# Draft option sets with the small LLM, then route with Jev picking from them
jev-router draft-options --topic "support ticket categories" --count 8
jev-router route --item "My invoice is wrong, refund NOW" \
  --destinations '{"billing": "charges/invoices/refunds", "technical": "bugs", "other": "rest"}'

# Triage one ticket with speculative fan-out (ONE request, 4 questions)
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
