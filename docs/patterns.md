# Patterns — TypeSafe patterns → router implementation

Source: https://docs.typesafe.ai/patterns.

| Pattern | Idea | Where in jev-router |
|---|---|---|
| **Speculative fan-out** | Put every question that shares a `state` in ONE request; all are evaluated in parallel; keep the answers you need in code. | **The default everywhere.** `jev_fan_out`, `jev_plan_workstreams`, and every handler sends all its questions in a single `POST /v1/systemone`. `jev_batch` is the only multi-request tool, and only because each item has its *own* state. |
| **Companion Noul** | A Choice always picks an option; pair it with a Noul asking whether any option fits. | `jev_route` → `any_fit`; `jev_plan_workstreams` → `<id>__lane_fits` per candidate; `jev_box` → `present`. |
| **Noul screen** | One cheap yes/no first; run the expensive step only on a clear yes (>0.7); <0.3 is a clear no; between is its own outcome. | Recipe: `jev_ask` with a single noul on the small state, then `jev_batch`/`jev_fan_out` only for clear yeses (documented in SKILL.md). |
| **Confidence routing** | Check `confidence` first (the "is this settled?" axis); below the floor, escalate instead of acting. | `jev_route` `confidence_floor` (default 0.5); `jev_review` `quality_uncertain`; `jev_plan_workstreams` `lane_uncertain`; `jev_fan_out` `min_confidence` (+ `noul_confidence`). |
| **Probability routing** | Threshold the probability of the action you will take; riskier actions get higher thresholds. | `jev_route` acts only when the chosen destination's probability ≥ `threshold` (default 0.6). |
| **Composite scoring** | Score each dimension separately, normalize, combine with weights in code. | `jev_plan_workstreams` `weights` (default `{priority: 1, risk: -1, size: 0}`) → `composite` ordering of workstreams. |

## Anti-patterns avoided

- One question per request (the opposite of fan-out) — never; there is no question-count limit.
- Asking Jev to generate text / do math / compare dates — option sets come from `jev_draft_options` (small LLM), arithmetic stays in code.
- Hiding several judgments in one question — each question asks exactly one thing.
- Fat `state` with irrelevant detail (context rot) — filter first; `MAX_CONTEXT_CHARS` caps file context.
