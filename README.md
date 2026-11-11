# jev-router

An **agent- and harness-agnostic router** that opens up **parallel workstreams** whose *decisions* are offloaded to [**TypeSafe's Jev System One model**](https://typesafe.ai/) (`POST https://api.typesafe.ai/v1/systemone`) — using its **speculative fan-out** pattern (many typed questions answered in parallel in one request, https://docs.typesafe.ai/patterns/fan-out) and its **Box** primitive for image localization (https://docs.typesafe.ai/primitives/box).

> Jev is a *System One* decision model, not a chat LLM: it does not write code or prose. It takes a `state` plus typed questions (`noul` / `choice` / `score` / `box`) and returns structured answers — probabilities, choices, scores, bounding boxes — that your code branches on. So this router offloads the *routing, triage, prioritization, conflict detection and verification* of parallel workstreams to Jev, while **your** agent (Claude Code, Mistral Vibe, Codex, …) still executes the work itself. Same spirit as [`chrismarchant/mistral-code-router`](https://github.com/chrismarchant/mistral-code-router), but for decision offload instead of generation offload.

Zero dependencies (Node ≥ 18 standard library only). MIT licensed.

## Documentation

| Page | Contents |
|---|---|
| [docs/installation.md](docs/installation.md) | Install in Mistral Vibe, Claude Code, Codex/skills.sh, any MCP client, or plain CLI |
| [docs/architecture.md](docs/architecture.md) | Repo layout, data flow, MCP transport, retries, plugin packaging |
| [docs/tools.md](docs/tools.md) | Reference for all 9 `jev_*` MCP tools / CLI commands (args, returns, examples) |
| [docs/cli.md](docs/cli.md) | CLI commands, flags, `@file` convention, exit codes |
| [docs/configuration.md](docs/configuration.md) | Every environment variable |
| [docs/primitives.md](docs/primitives.md) | How the router uses noul / choice / score / box (+ structured questions) |
| [docs/patterns.md](docs/patterns.md) | TypeSafe patterns → where each is implemented in the router |
| [docs/confidence-and-thresholds.md](docs/confidence-and-thresholds.md) | How confidence works, noul bands, probability vs confidence, the router's thresholds |
| [docs/limitations.md](docs/limitations.md) | Jev's limits (AI primer, model jaggedness, model limits) and how they are encoded |
| [docs/examples.md](docs/examples.md) | End-to-end walkthroughs with sample output |
| [docs/development.md](docs/development.md) | Tests, `scripts/verify.sh`, committing/releasing |

## Quick start

```bash
# 1. key (https://console.typesafe.ai/keys, or the Vercel AI gateway)
export TYPESAFE_API_KEY=...

# 2. run from a checkout of this repo (no npm install needed — zero deps)
node bin/jev-router.js models

# 3. plan parallel workstreams for a task — ONE fan-out request to Jev
node bin/jev-router.js plan \
  --task @examples/task.txt \
  --candidates @examples/plan-candidates.json \
  --files '["src/server.js"]'
```

Or install it into your agent — see [docs/installation.md](docs/installation.md) — and call the `jev_*` MCP tools directly.

## The 60-second mental model

1. **Fan-out by default.** Every question that shares a `state` goes in **one** request; Jev evaluates them all in parallel (no question-count limit — only context limits), and your code keeps the answers it needs. `jev_plan_workstreams` and `jev_fan_out` do this for you; `jev_batch` is for items that each have their *own* state.
2. **Jev decides, you execute.** Jev never generates text, does math, or compares dates — closed option sets are drafted by a small LLM (`jev_draft_options`, default **mistral-small-latest**) and Jev only picks; arithmetic/ordering happens in your code.
3. **Threshold responsibly.** Nouls: >0.7 yes, <0.3 no, between = its own outcome. Choices: threshold the probability of the option you'll act on; use `confidence` only to decide whether to act at all (below ~0.5, escalate). See [docs/confidence-and-thresholds.md](docs/confidence-and-thresholds.md).

## Tools at a glance

| MCP tool | CLI | One-liner |
|---|---|---|
| `jev_models` | `models` | List available Jev models + limits |
| `jev_ask` | `ask` | One `POST /v1/systemone`: state + typed questions → answers |
| `jev_fan_out` | `fan-out` | Many questions in ONE request (default mode) + optional confidence discard |
| `jev_plan_workstreams` | `plan` | Decompose a task into scored/routed parallel workstreams (one fan-out request) |
| `jev_route` | `route` | Route an item: choice + companion noul + probability threshold + confidence floor |
| `jev_review` | `review` | Verify an output against acceptance criteria (three-band nouls) |
| `jev_batch` | `batch` | Many items with their own states, parallel bounded pool |
| `jev_box` | `box` | Locate something in an image (Box + `present` noul; Jev 1.14+) |
| `jev_draft_options` | `draft-options` | Draft closed option sets with mistral-small-latest (Jev only picks) |

Full reference: [docs/tools.md](docs/tools.md).

## Guardrails

- Never send secrets — API keys stay in the environment, never in `state`/questions/draft prompts.
- Keep `state` lean (Jev suffers context rot); request bodies ≤ 32 MiB, nesting ≤ 64.
- 401 → bad key; 422 → malformed question (error names the field); 429/529/5xx → auto-retried with backoff.
- On tool failure inside an agent loop: retry once, then decide locally — never block the workstream.

## Development

```bash
node --test test/*.test.js   # 36 tests against mock APIs (no keys needed)
bash scripts/verify.sh       # syntax + MCP handshake + tools/list + missing-key + optional live test
```

See [docs/development.md](docs/development.md).

## License

MIT — see [LICENSE](LICENSE).
