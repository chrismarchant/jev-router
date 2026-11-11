# Tool reference

9 MCP tools (`jev_*`) with a 1:1 CLI twin (`bin/jev-router.js`). All Jev tools return JSON including `model` (versioned ID) and `usage`.

## jev_models / `models`
`GET /v1/models`. Returns `{ endpoint, default_model, models, limits_note }`. No args except `timeout_ms`.

## jev_ask / `ask --state S --questions Q`
Raw passthrough: one `POST /v1/systemone`.
- args: `state` (string|JSON), `questions` (map or `[{id, ...}]`), optional `model`, `assets`, `headers`, `timeout_ms`
- returns the API response verbatim: `{ model, answers, usage }`

## jev_fan_out / `fan-out --state S --questions Q`
Speculative fan-out (default mode): many questions in ONE request.
- extra args: `min_confidence` (list answers below it in `discarded_below_confidence`), `noul_confidence` (score nouls as `|2p−1|`), `model`, `assets`, `headers`, `timeout_ms`
- returns `{ model, answers, usage, question_count, discarded_below_confidence }`

## jev_plan_workstreams / `plan --task T --candidates C`
Opens parallel workstreams. ONE fan-out request asks per candidate: `lane` (choice), `lane_fits` (companion noul), `priority`/`risk`/`size` (scores), `independent`/`conflicts` (nouls); plus global `approach` (parallel/sequential/hybrid) and `task_complexity`.
- args: `task`, `candidates` (strings or `{id, description}`, ≤ `max_candidates` = 24), optional `files`, `lanes`, `weights` (composite scoring, default `{priority:1, risk:-1, size:0}`), `model`, `timeout_ms`
- returns `{ approach, task_complexity, weights, workstreams[] (composite-ordered; each with lane, lane_fits, lane_uncertain, priority, risk, size, independent, conflicts, composite), parallel_safe[], needs_sequential[], model, usage, question_count }`

## jev_route / `route --item I --destinations D`
- args: `item`, `destinations` (map name→description or array), `threshold` (0.6), `confidence_floor` (0.5), `model`, `timeout_ms`
- returns `{ route, probability, confidence, any_fit, fit_band, act, recommendation, answers, usage, model }`
- `act=true` only when probability ≥ threshold AND `any_fit` clear yes (>0.7) AND confidence ≥ floor.

## jev_review / `review --output O --criteria C`
- args: `output`, `criteria: [{id, check, threshold?, fail_below?}]`, optional `rubric` (≥2 levels → one quality score), `pass_threshold` (0.7), `fail_below` (0.3), `model`, `timeout_ms`
- returns `{ pass, checks[] ({id, noul, status: pass|uncertain|fail|unknown, …}), quality, quality_confidence, quality_uncertain, needs_human_review, usage, model }`

## jev_batch / `batch --items F`
- args: `items: [{id, state, questions, assets?, model?, timeout_ms?}]` (each item = own request), `concurrency` (6, max 16), `model`, `timeout_ms`
- returns `{ item_count, ok_count, failed_count, concurrency, results[] ({id, ok, answers|error, usage}), total_usage }`

## jev_box / `box --image P --instructions T`
- args: `image` (PNG/JPEG path or base64), `instructions` (e.g. "the error banner in `img`"), optional `format`, `model` (Jev 1.14+), `timeout_ms`
- returns `{ present, present_band, box: {left, top, right, bottom}, confidence, model, usage }`

## jev_draft_options / `draft-options --topic T`
Drafts a closed option set with a small generative LLM; Jev only picks from it.
- args: `topic`, optional `context`, `count` (8, max 64), `model` (default `JEV_ROUTER_DRAFT_MODEL` or **mistral-small-latest**), `timeout_ms`
- needs `MISTRAL_API_KEY` (`MISTRAL_API_BASE` default `https://api.mistral.ai/v1`)
- returns `{ draft_model, topic, options: [{name, description}], criteria, usage }` — feed `criteria` into `plan --lanes`, `route --destinations`, or `ask --questions`.

## Errors

Tool errors surface as MCP `isError` results (or CLI exit 1 with the message on stderr). Missing keys produce actionable messages (`TYPESAFE_API_KEY is not set … console.typesafe.ai/keys`). HTTP 422 bodies name the offending field.
