# Architecture

## Layout

```
jev-router/
├── plugin.json               # Agent Plugins 1.0 manifest (Mistral Vibe native + compliant harnesses)
├── mcp.json                  # Vibe plugin: stdio MCP server at ${PLUGIN_ROOT}/mcp-server/server.js
├── .mcp.json                 # Claude Code / generic MCP client config (env passthrough with defaults)
├── .claude-plugin/           # Claude Code marketplace packaging (plugin.json + marketplace.json)
├── mcp-server/
│   ├── server.js             # MCP stdio server: hand-rolled JSON-RPC 2.0, newline-delimited
│   ├── client.js             # zero-dep TypeSafe client: POST /v1/systemone, GET /v1/models,
│   │                         #   retries w/ backoff + Retry-After, danger-zone headers, timeouts
│   ├── questions.js          # noul/choice/score/box builders + validation (255-option cap, ≥2 levels, …)
│   └── tools.js              # the 9 jev_* handlers: ask, fan-out, plan, route, review, batch, box, models, draft-options
├── bin/jev-router.js         # CLI twin of the MCP server (npm bin "jev-router")
├── skills/jev-router/SKILL.md    # agent-agnostic skill (Vibe / Claude Code / Codex / skills.sh)
├── commands/parallel-jev.md  # Claude Code slash command
├── agents/workstream-planner.md  # Claude Code subagent
├── scripts/verify.sh         # smoke test: syntax, MCP handshake, tools/list, missing-key, optional live call
├── scripts/set-typesafe-key.sh   # safely store TYPESAFE_API_KEY in .claude/settings.local.json
├── examples/                 # ready-made inputs (task, candidates, triage items)
└── test/                     # node:test suite against mock TypeSafe + Mistral APIs
```

## Data flow

```
agent (Vibe / Claude Code / Codex / shell)
   │  MCP tools/call  ──────────────┐   ┌── CLI (bin/jev-router.js)
   ▼                                ▼   ▼
mcp-server/server.js ──► mcp-server/tools.js ──► mcp-server/client.js ──► POST {TYPESAFE_API_BASE}/v1/systemone
                                                        │                      GET  /v1/models
                                                        ▼
                                              { model, answers, usage }   (Bearer TYPESAFE_API_KEY)

jev_draft_options ──► Mistral chat completions (default mistral-small-latest, Bearer MISTRAL_API_KEY)
                     drafts closed option sets only — Jev never generates; it only picks
```

- **MCP transport**: stdio, JSON-RPC 2.0, newline-delimited; supports protocol versions `2025-06-18`, `2025-03-26`, `2024-11-05`; answers `initialize` / `ping` / `tools/list` / `tools/call`; tool errors come back as `isError` results, never crashes. Same hand-rolled approach as `chrismarchant/mistral-code-router` — zero npm dependencies.
- **Retries**: 429/529/5xx and network errors are retried with exponential backoff + jitter, honoring `Retry-After`; 400/401/413/415/422 fail immediately with the response body in the error. Per-request timeout via `AbortController`.
- **Danger-zone headers**: `TypeSafe-Danger-Zone-Images: true` is sent automatically when a request has assets or a box question (opt out with `JEV_ROUTER_ALLOW_IMAGES=false`); `TypeSafe-Danger-Zone-Long-Context: true` when `JEV_ROUTER_LONG_CONTEXT=true`.
- **Context hygiene**: file context is read relative to the agent's cwd and capped by `MAX_CONTEXT_CHARS` (default 120000) because Jev's limits are 64k tokens per-request and 32k per-question and `state` counts against both.
- **Plugin packaging**: the repo root is a native Agent Plugins 1.0 package (`plugin.json` + `mcp.json` + `skills/`) for Vibe; `.claude-plugin/` + `.mcp.json` + `commands/` + `agents/` serve Claude Code; `skills/` alone serves skills.sh agents. One repo, every harness.

## Answer shapes (from the API)

```json
{ "model": "jev-1.14.0",
  "answers": {
    "billing":   { "type": "noul",   "noul": 0.98 },
    "category":  { "type": "choice", "choice": "billing", "probabilities": {"billing": 0.9, "...": 0.1}, "confidence": 0.8 },
    "severity":  { "type": "score",  "score": 1.43, "legend": {"0": "…", "1": "…"}, "probabilities": {"0": 0.0, "1": 0.57, "2": 0.43}, "confidence": 0.35 },
    "banner":    { "type": "box",    "box": {"left": 0.44, "top": 0.25, "right": 0.84, "bottom": 0.82}, "confidence": 0.92 }
  },
  "usage": { "input_tokens": 332, "output_tokens": 18 } }
```

Noul answers have **no** `confidence` — the single probability is the complete answer. Log `model` (the versioned ID) and `usage` on every call.
