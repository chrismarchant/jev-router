# Configuration

All via environment variables. In Vibe put them in `~/.vibe/.env`; in Claude Code in `.claude/settings.local.json` → `env` (see `scripts/set-typesafe-key.sh`); `.mcp.json` passes them through with defaults.

| Env var | Default | Used by | Meaning |
|---|---|---|---|
| `TYPESAFE_API_KEY` | — (required) | all Jev tools | TypeSafe API key — https://console.typesafe.ai/keys or Vercel AI gateway |
| `TYPESAFE_API_BASE` | `https://api.typesafe.ai` | client | API base (endpoints: `/v1/systemone`, `/v1/models`) |
| `TYPESAFE_MODEL` | `jev-latest` | client | Default model; pin a versioned ID (e.g. `jev-1.14.0`) when thresholds are tuned |
| `JEV_ROUTER_TIMEOUT_MS` | `60000` | client | Per-request timeout (AbortController) |
| `JEV_ROUTER_MAX_RETRIES` | `3` | client | Retries on 429/529/5xx/network errors; backoff + `Retry-After` |
| `JEV_ROUTER_CONCURRENCY` | `6` (max 16) | `jev_batch` | Max in-flight requests |
| `JEV_ROUTER_ALLOW_IMAGES` | `true` | client | Send `TypeSafe-Danger-Zone-Images: true` when assets/box are present |
| `JEV_ROUTER_LONG_CONTEXT` | `false` | client | Send `TypeSafe-Danger-Zone-Long-Context: true` (262k context; slower, less accurate) |
| `JEV_ROUTER_MAX_CANDIDATES` | `24` | `jev_plan_workstreams` | Cap on candidate workstreams per plan |
| `MAX_CONTEXT_CHARS` | `120000` | `jev_plan_workstreams` file context | Keep `state` under Jev's 32k-token per-question limit |
| `MISTRAL_API_KEY` | — | `jev_draft_options` | Mistral key for the drafting LLM only |
| `MISTRAL_API_BASE` | `https://api.mistral.ai/v1` | `jev_draft_options` | Mistral API base |
| `JEV_ROUTER_DRAFT_MODEL` | `mistral-small-latest` | `jev_draft_options` | Drafting model (any Mistral chat model) |

Per-call overrides: every tool accepts `model` and `timeout_ms`; `jev_ask`/`jev_fan_out` also accept `headers` (e.g. `{"TypeSafe-Danger-Zone-Long-Context": "true"}` for one request).
