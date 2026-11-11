---
description: Fan a task out to parallel workstreams whose routing/prioritization/conflict decisions are offloaded to the TypeSafe Jev System One model via jev_plan_workstreams, then execute and verify with jev_review. Use "/parallel-jev <task>".
---

# /parallel-jev — parallel workstreams routed by Jev

Goal: $ARGUMENTS

1. **Decompose.** Break the goal into independent candidate workstreams (strings or `{id, description}`). Keep candidates ≤ 24; pass the most relevant repo files via `files` (paths relative to cwd, capped by MAX_CONTEXT_CHARS).
2. **Plan with Jev.** Call the `jev_plan_workstreams` MCP tool (or `jev-router plan --task … --candidates … --files …` from a shell) with the goal as `task`, your candidates, and files. It sends ONE speculative fan-out request — per candidate a lane (choice), priority/risk/size (scores), independence + conflict (nouls), plus a global approach — and returns `{ approach, workstreams[], parallel_safe[], needs_sequential[], usage }`.
3. **Execute.** Run the `parallel_safe` workstreams concurrently (subagents/Task tool, one per workstream — tell each worker it owns only its workstream and must not edit files another workstream owns). Run `needs_sequential` workstreams afterwards, in the returned priority order. The coordinator merges results to avoid conflicts.
4. **Verify each workstream** with `jev_review`: `output` = the workstream's diff/report, `criteria` = acceptance checks (tests included, no secrets, no breaking changes, matches the task). `pass=false` or `needs_human_review=true` → re-run that workstream locally or flag it for review.
5. **Route follow-ups** (bugs found, tickets, PRs) with `jev_route` when useful; batch-triage many items with `jev_batch`.
6. **Report** the plan, which workstreams ran in parallel vs sequentially, per-workstream review verdicts, and `usage` (input tokens are the only cost; output tokens are free).

Guardrails: never put secrets in `state`/questions; Jev only makes typed decisions (it does not write code — your workers do); if a `jev_*` call fails or times out, retry once, then make that decision locally and continue.
