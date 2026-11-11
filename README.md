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
│   └── tools.js              # the 8 jev_* tool handlers (incl. fan-out planner, router, reviewer, batch, box)
├── bin/jev-router.js         # CLI twin: jev-router models|ask|fan-out|plan|route|review|batch|box (npm bin)
├── skills/jev-router/SKILL.md    # agent-agnostic skill (Vibe / Claude Code / Codex / skills.sh)
├── commands/parallel-jev.md  # Claude Code slash command
├── agents/workstream-planner.md  # Claude Code subagent definition
├── scripts/verify.sh         # syntax + MCP handshake + tools/list + missing-key + optional live test
├── scripts/set-typesafe-key.sh   # safely store TYPESAFE_API_KEY for Claude Code projects
├── examples/                 # task/candidates/triage inputs + walkthrough
└── test/                     # node:test suite (mock TypeSafe API; no key needed)
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
| `TYPESAFE_API_KEY` | — (required) | API key |
| `TYPESAFE_API_BASE` | `https://api.typesafe.ai` | API base URL |
| `TYPESAFE_MODEL` | `jev-latest` | Default model |
| `JEV_ROUTER_TIMEOUT_MS` | `60000` | Per-request timeout |
| `JEV_ROUTER_MAX_RETRIES` | `3` | Retries on 429/529/5xx (exponential backoff, honors `Retry-After`) |
| `JEV_ROUTER_CONCURRENCY` | `6` | Max in-flight requests in `jev_batch` (max 16) |
| `JEV_ROUTER_ALLOW_IMAGES` | `true` | Send `TypeSafe-Danger-Zone-Images: true` for assets/box (experimental) |
| `JEV_ROUTER_LONG_CONTEXT` | `false` | Send `TypeSafe-Danger-Zone-Long-Context: true` |
| `JEV_ROUTER_MAX_CANDIDATES` | `24` | Cap on workstream candidates in `jev_plan_workstreams` |
| `MAX_CONTEXT_CHARS` | `200000` | Cap on file context sent as `state` |

## Tools (MCP `jev_*` / CLI command)

| MCP tool | CLI | What it does |
|---|---|---|
| `jev_models` | `models` | `GET /v1/models` — list models for your key |
| `jev_ask` | `ask --state … --questions …` | One `POST /v1/systemone`: state + typed questions → `{ model, answers, usage }` |
| `jev_fan_out` | `fan-out … [--min-confidence F]` | **Speculative fan-out**: many questions in ONE request, all evaluated in parallel; optional confidence-based discard list |
| `jev_plan_workstreams` | `plan --task … --candidates … [--files …]` | **Opens parallel workstreams**: per candidate, one fan-out request asks lane (choice), priority/risk/size (scores), independence + conflict risk (nouls), plus global approach → structured plan with `parallel_safe` / `needs_sequential` |
| `jev_route` | `route --item … --destinations … [--threshold F]` | Choice over destinations + companion `none_fit` noul + probability/confidence threshold → `act` / escalate |
| `jev_review` | `review --output … --criteria …` | One noul per acceptance criterion (+ optional quality score) → `pass`, per-check results, `needs_human_review` |
| `jev_batch` | `batch --items … [--concurrency N]` | Many independent items, each its own request, run in a bounded parallel pool; per-item failures tolerated; aggregated `usage` |
| `jev_box` | `box --image <path\|base64> --instructions …` | **Box primitive**: sends the image as an asset (images header) + one box question → `{left, top, right, bottom}` fractions + confidence |

Every tool returns JSON with `usage` (`input_tokens` are the only billable tokens — output tokens are free; ~$0.042/M input).

## Example: parallel workstreams in any agent

```bash
node bin/jev-router.js plan \
  --task @examples/task.txt \
  --candidates @examples/plan-candidates.json \
  --files '["src/server.js"]'
```
returns `{ approach, workstreams: [{id, lane, priority, risk, size, independent, conflicts}], parallel_safe, needs_sequential, usage }`.
The agent then runs `parallel_safe` workstreams concurrently (subagents), runs `needs_sequential` afterwards, and verifies each result with `jev_review`. See `commands/parallel-jev.md` (Claude Code) and `skills/jev-router/SKILL.md` for the full workflow; `examples/README.md` has more one-liners (triage batch, routing, fan-out, box).

## Guardrails

- Never send secrets: `TYPESAFE_API_KEY` stays in the environment; pass targeted files as context (capped by `MAX_CONTEXT_CHARS`; request bodies are limited to 32 MiB, nesting ≤ 64).
- Jev decides, you execute — don't ask it to generate text/code.
- Give `choice` an `other`/`none_of_the_above` option when the option list might not cover the input (see the companion-noul pattern in `jev_route`).
- 401 → bad/missing key; 422 → malformed question (error body names the field); 429/529/5xx → retried automatically.
- Images/Box are "dreamer-ready" (experimental): request format and accuracy can change between releases.
- On tool failure inside an agent loop: retry once, then fall back to deciding locally — never block the workstream.

## Development

```bash
node --test test/     # unit + MCP + CLI tests against a mock API (no key needed)
bash scripts/verify.sh   # syntax, MCP handshake, tools/list, missing-key, optional live test
```

## License

MIT — see [LICENSE](LICENSE).
