# jev-router

An **agent- and harness-agnostic router** that opens up **parallel workstreams** whose *decisions* are offloaded to [**TypeSafe's Jev System One model**](https://typesafe.ai/) (`POST https://api.typesafe.ai/v1/systemone`) — using its **speculative fan-out** pattern (many typed questions answered in parallel in one request, https://docs.typesafe.ai/patterns/fan-out) and its **Box** primitive for image localization (https://docs.typesafe.ai/primitives/box).

> Jev is a *System One* decision model, not a chat LLM: it does not write code or prose. It takes a `state` plus typed questions (`noul` / `choice` / `score` / `box`) and returns structured answers — probabilities, choices, scores, bounding boxes — that your code branches on. So this router offloads the *routing, triage, prioritization, conflict detection and verification* of parallel workstreams to Jev, while **your** agent (Claude Code, Mistral Vibe, Codex, …) still executes the work itself. Same spirit as [`chrismarchant/mistral-code-router`](https://github.com/chrismarchant/mistral-code-router), but for decision offload instead of generation offload.

Zero dependencies (Node ≥ 18 standard library only). MIT licensed.

## Layout

```
jev-router/
├── plugin.json               # native Agent Plugins 1.0 manifest (Mistral Vibe + any compliant harness)
├── mcp.json                  # Vibe plugin MCP server definition (${PLUGIN_ROOT}/mcp-server/server.js)
├── .mcp.json                 # Claude Code / generic MCP client config
├── .claude-plugin/           # Claude Code plugin marketplace packaging
├── mcp-server/
│   ├── server.js             # MCP stdio server (hand-rolled JSON-RPC 2.0, newline-delimited)
│   ├── client.js             # zero-dep TypeSafe API client (retries w/ backoff, danger-zone headers, timeouts)
│   ├── questions.js          # noul/choice/score/box builders + validation
│   └── tools.js              # the 9 jev_* tool handlers (fan-out planner, router, reviewer, batch, box, option drafting)
├── bin/jev-router.js         # CLI twin: jev-router models|ask|fan-out|plan|route|review|batch|box|draft-options
├── skills/jev-router/SKILL.md    # agent-agnostic skill (Vibe / Claude Code / Codex / skills.sh)
├── commands/parallel-jev.md  # Claude Code slash command
├── agents/workstream-planner.md  # Claude Code subagent definition
├── scripts/verify.sh         # syntax + MCP handshake + tools/list + missing-key + optional live test
├── scripts/set-typesafe-key.sh   # safely store TYPESAFE_API_KEY for Claude Code projects
├── examples/                 # task/candidates/triage inputs + walkthrough
└── test/                     # node:test suite (mock TypeSafe + Mistral APIs; no keys needed)
```

## Install per harness (all from this one repo)

**Mistral Vibe** — as a native plugin (skills + MCP server):
```bash
mkdir -p ~/.vibe/plugins && cp -r jev-router ~/.vibe/plugins/jev-router   # then /reload-plugins in Vibe
# or per project: .vibe/plugins/jev-router (trusted folder)
```
or just the MCP server: `vibe mcp add jev-router --transport stdio --command node --arg /abs/path/to/mcp-server/server.js`
Add `TYPESAFE_API_KEY=...` to `~/.vibe/.env` yourself, then `/reload`.

**Claude Code** — as a plugin from a marketplace:
```bash
claude plugin marketplace add chrismarchant/jev-router
claude plugin install jev-router@chrismarchant
# or project-local: drop .mcp.json in the repo and set TYPESAFE_API_KEY in
# .claude/settings.local.json "env" (scripts/set-typesafe-key.sh does this safely)
```

**Codex / any skills.sh agent** — `npx skills add chrismarchant/jev-router --skill jev-router`

**Any agent that can shell out** — the CLI:
```bash
node bin/jev-router.js models        # or: npm i -g . && jev-router models
```

**Any MCP client** — point it at `node mcp-server/server.js` over stdio (see `.mcp.json`).

## Setup

Get a key at https://console.typesafe.ai/keys (or via the Vercel AI gateway) and set `TYPESAFE_API_KEY` in the environment of the harness (never in prompts or `state`).

| Env var | Default | Meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | — (required) | TypeSafe API key |
| `TYPESAFE_API_BASE` | `https://api.typesafe.ai` | API base URL |
| `TYPESAFE_MODEL` | `jev-latest` | Default model. Pin a versioned ID (e.g. `jev-1.14.0`) if you tuned thresholds — aliases move between releases |
| `JEV_ROUTER_TIMEOUT_MS` | `60000` | Per-request timeout |
| `JEV_ROUTER_MAX_RETRIES` | `3` | Retries on 429/529/5xx (exponential backoff, honors `Retry-After`) |
| `JEV_ROUTER_CONCURRENCY` | `6` | Max in-flight requests in `jev_batch` (max 16) |
| `JEV_ROUTER_ALLOW_IMAGES` | `true` | Send `TypeSafe-Danger-Zone-Images: true` for assets/box (experimental) |
| `JEV_ROUTER_LONG_CONTEXT` | `false` | Send `TypeSafe-Danger-Zone-Long-Context: true` (raises context to 262k, but slower and less accurate) |
| `JEV_ROUTER_MAX_CANDIDATES` | `24` | Cap on workstream candidates in `jev_plan_workstreams` |
| `MAX_CONTEXT_CHARS` | `120000` | Cap on file context sent as `state` (Jev limits: 64k tokens/request, 32k/question — `state` counts against both) |
| `MISTRAL_API_KEY`, `MISTRAL_API_BASE`, `JEV_ROUTER_DRAFT_MODEL` | — , `https://api.mistral.ai/v1`, `mistral-small-latest` | Only for `jev_draft_options` (drafting closed option sets with a small LLM) |

## How Jev works — and its limits, encoded in this router

From the [AI primer](https://docs.typesafe.ai/introduction/machine-learning-primer.md), [System One](https://docs.typesafe.ai/concepts/system-one.md), [model jaggedness](https://docs.typesafe.ai/model-jaggedness.md), and [models](https://docs.typesafe.ai/models.md):

- **Jev returns calibrated decisions, never generated text** (trained with RLCD, not RLHF/RLVR). Calibration is a group-level property, not a per-answer guarantee. → The router never asks Jev to write anything; closed option sets are drafted by a small generative LLM (`jev_draft_options`, default `mistral-small-latest`) and Jev only *picks*.
- **Jev is literal** — write the exact condition in `instructions`, put boundary cases in `criteria`, reference state fields by name/path (`` `candidates[0].description` ``). → All built-in questions follow this.
- **No math, counting, or date comparison** — keep arithmetic in code; extract date parts as Choice over enumerated options. → The router does sorting/weighting/normalization in code, never via Jev.
- **Context rot**: accuracy falls as `state` grows with irrelevant detail. Limits: 64k tokens per-request / 32k per-question (state counts against both); no limit on question count. → `MAX_CONTEXT_CHARS` caps file context; pass targeted files; `JEV_ROUTER_LONG_CONTEXT` opts into 262k when truly needed.
- **Indirection and multi-hop reasoning** cost accuracy; adversarial content in `state` can steer answers. → One snap judgment per question; never send secrets in `state`.
- **Choice option order can bias toward the first option.** → Reorder options and re-check if an answer looks unstable.
- **Box needs Jev 1.14+** and images are "dreamer-ready" (experimental, via the images danger-zone header). → `jev_box` sends the header and pairs the Box with a companion `present` Noul (a Box always returns a location).
- **Noul thresholds**: >0.7 reads as yes, <0.3 as no, between is its own outcome — don't round it. → `jev_review` uses three-band `pass`/`uncertain`/`fail`; `jev_route` uses the same bands for `any_fit`.
- **Confidence** (https://docs.typesafe.ai/confidence.md): Choice/Score/Box answers carry `confidence` (a 0–1 summary of how peaked the `probabilities` are); **Nouls carry none** — the `noul` value is the whole answer (use `|2p−1|` to put it on the same scale). For acting on a Choice, threshold the **probability of the option you will act on**, not confidence; use confidence as the "is this answer settled at all" check (below the floor → escalate). → `jev_route` acts only when probability ≥ `threshold` AND `any_fit` is a clear yes AND confidence ≥ `confidence_floor` (0.5); `jev_review` flags low-confidence quality scores; `jev_fan_out` can discard below `min_confidence`.
- Pricing: input tokens only (~$0.042/M), output free; every result carries `usage`. Rate limits are per-org (429 + `Retry-After`; the client retries).

## Patterns (https://docs.typesafe.ai/patterns) — where each lives in the router

| Pattern | Where |
|---|---|
| **Speculative fan-out** — all questions for one state in ONE request, decide in code afterwards. **This is the default everywhere** (no question-count limit, only context limits). | `jev_fan_out`, `jev_plan_workstreams` (one request per plan), `jev_ask`/`jev_review`/`jev_route`/`jev_box` (all their questions in one request) |
| **Companion Noul** — pair every Choice with a Noul asking whether any option fits. | `jev_route` (`any_fit`), `jev_plan_workstreams` (`<id>__lane_fits`), `jev_box` (`present`) |
| **Noul screen** — cheap yes/no first, expensive step only on a clear yes. | Recipe in the skill: `jev_ask` with one noul on the small state, then `jev_batch`/`jev_fan_out` only for clear yeses |
| **Confidence routing** — check confidence first; below the floor, escalate. | `jev_route` (`confidence_floor`), `jev_review` (`quality_uncertain`, `needs_human_review`), `jev_plan_workstreams` (`lane_uncertain`), `jev_fan_out` (`min_confidence`) |
| **Probability routing** — threshold on the probability of the action you take; riskier actions get higher thresholds. | `jev_route` (`threshold` on the chosen option's probability) |
| **Composite scoring** — atomic scores combined with weights in code. | `jev_plan_workstreams` (`weights` {priority, risk, size}, normalized 0–1, combined into `composite`) |

`jev_batch` is the one tool that sends multiple *requests*: it is for items that each have their **own** state (tickets, PRs, files). When many questions share one state, fan-out in a single request instead.

## Tools (MCP `jev_*` / CLI command)

| MCP tool | CLI | What it does |
|---|---|---|
| `jev_models` | `models` | `GET /v1/models` — list models for your key + the model limits |
| `jev_ask` | `ask --state … --questions …` | One `POST /v1/systemone`: state + typed questions → `{ model, answers, usage }` |
| `jev_fan_out` | `fan-out … [--min-confidence F] [--noul-confidence]` | **Speculative fan-out (default mode)**: many questions in ONE request; optional confidence-based discard list |
| `jev_plan_workstreams` | `plan --task … --candidates … [--files …] [--lanes …] [--weights …]` | **Opens parallel workstreams**: one fan-out request → per-candidate lane (+companion noul), priority/risk/size, independence/conflict, global approach → plan ordered by composite score with `parallel_safe` / `needs_sequential` |
| `jev_route` | `route --item … --destinations … [--threshold F] [--confidence-floor F]` | Choice + companion `any_fit` noul + probability threshold + confidence floor → `act` / escalate |
| `jev_review` | `review --output … --criteria … [--rubric …]` | One noul per acceptance criterion (three-band pass/uncertain/fail) + optional quality score with confidence check → `pass`, `needs_human_review` |
| `jev_batch` | `batch --items … [--concurrency N]` | Many items with their own states, each its own request, bounded parallel pool; per-item failures tolerated; aggregated `usage` |
| `jev_box` | `box --image <path\|base64> --instructions …` | **Box primitive** (Jev 1.14+, images header): image asset + box question + companion `present` noul → `{present, box, confidence}` |
| `jev_draft_options` | `draft-options --topic … [--count N] [--model M]` | Draft a closed option set with a small LLM (**default `mistral-small-latest`**, needs `MISTRAL_API_KEY`) → `{ options, criteria }` ready for Choice criteria / destinations / lanes. Jev still makes every decision |

Every Jev result includes `usage` and the versioned `model` that answered (log it — aliases move between releases).

## Example: parallel workstreams in any agent

```bash
node bin/jev-router.js draft-options --topic "lanes for a coding task" --count 8   # optional; or write lanes yourself
node bin/jev-router.js plan \
  --task @examples/task.txt \
  --candidates @examples/plan-candidates.json \
  --files '["src/server.js"]'
```
returns `{ approach, weights, workstreams: [{id, lane, lane_fits, priority, risk, size, independent, conflicts, composite, …}], parallel_safe, needs_sequential, usage }`.
The agent then runs `parallel_safe` workstreams concurrently (subagents), runs `needs_sequential` afterwards in composite order, and verifies each result with `jev_review`. See `commands/parallel-jev.md` (Claude Code) and `skills/jev-router/SKILL.md` for the full workflow; `examples/README.md` has more one-liners (triage batch, routing, fan-out, box, draft-options).

## Guardrails

- Never send secrets: `TYPESAFE_API_KEY`/`MISTRAL_API_KEY` stay in the environment; pass targeted files as context (capped by `MAX_CONTEXT_CHARS`; request bodies are limited to 32 MiB, nesting ≤ 64).
- Jev decides, you execute — don't ask it to generate text, do math, count, or compare dates.
- Give every Choice a companion Noul (built into `jev_route`/`jev_box`/`jev_plan_workstreams`); when writing your own, prefer the companion Noul over an `other` option.
- 401 → bad/missing key; 422 → malformed question (error body names the field); 429/529/5xx → retried automatically with backoff.
- Images/Box are "dreamer-ready" (experimental) and need Jev 1.14+.
- On tool failure inside an agent loop: retry once, then fall back to deciding locally — never block the workstream.

## Development

```bash
node --test test/*.test.js   # unit + MCP + CLI tests against mock APIs (no keys needed)
bash scripts/verify.sh       # syntax, MCP handshake, tools/list, missing-key, optional live test
```

## License

MIT — see [LICENSE](LICENSE).
