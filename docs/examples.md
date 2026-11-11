# Examples

All run from a repo checkout with `TYPESAFE_API_KEY` set (`MISTRAL_API_KEY` only for `draft-options`). Inputs live in `examples/`.

## 1. Plan parallel workstreams (the headline flow)

```bash
node bin/jev-router.js plan --task @examples/task.txt --candidates @examples/plan-candidates.json --files '["src/server.js"]'
```

One fan-out request (5 candidates × 7 questions + 2 global) returns composite-ordered workstreams:

```json
{
  "approach": "hybrid",
  "workstreams": [
    { "id": "limiter", "lane": "feature", "lane_fits": 0.97, "priority": 3.0, "risk": 1.2,
      "size": 2.1, "independent": true, "conflicts": false, "composite": 0.7 }
  ],
  "parallel_safe": ["config", "tests", "docs"],
  "needs_sequential": ["limiter", "wire-up"],
  "usage": { "input_tokens": 4210, "output_tokens": 640 }
}
```

Agent loop: run `parallel_safe` concurrently (one subagent each), then `needs_sequential` in order, then `jev_review` each result. See `commands/parallel-jev.md`.

## 2. Draft option sets with the small LLM, then route

```bash
node bin/jev-router.js draft-options --topic "support ticket categories" --count 8
# → { "options": [{ "name": "billing", "description": "…" }, …], "criteria": { "billing": "…", … } }
node bin/jev-router.js route --item "I was charged twice, refund ASAP" \
  --destinations "$(node bin/jev-router.js draft-options --topic 'support ticket categories' --count 8 --compact | jq -c .criteria)"
```

## 3. Triage a batch (each item has its own state)

```bash
node bin/jev-router.js batch --items @examples/triage-items.json --concurrency 3
# → per-item answers (category/severity/refund/urgent) + total_usage; failures are per-item, not fatal
```

## 4. Speculative fan-out by hand — one request, many questions

```bash
node bin/jev-router.js fan-out --state "My invoice is wrong, refund NOW" --questions '{
  "category": {"type":"choice","instructions":"What is this about?","criteria":{"billing":"charges/refunds","technical":"bugs","other":"rest"}},
  "severity": {"type":"score","instructions":"How severe?","criteria":["cosmetic","degraded","blocking"]},
  "refund":   {"type":"noul","instructions":"Is a refund requested?"},
  "urgent":   {"type":"noul","instructions":"Does it convey urgency?"}
}' --min-confidence 0.5
```

## 5. Review a workstream's output

```bash
node bin/jev-router.js review --output @pr-diff.patch --criteria '[
  {"id":"tests","check":"adds or updates tests"},
  {"id":"no-secrets","check":"contains no API keys or credentials"},
  {"id":"breaking","check":"does not change public API signatures"}
]'
# → { "pass": true, "checks": [{"id":"tests","noul":0.97,"status":"pass"}, …], "needs_human_review": false }
```

## 6. Box on a screenshot (Jev 1.14+, experimental images)

```bash
node bin/jev-router.js box --image ui-screenshot.png --instructions "the red error banner in `img`"
# → { "present": 0.95, "present_band": "clear_yes", "box": {"left":0.1,"top":0.05,"right":0.9,"bottom":0.2}, "confidence": 0.8 }
```

## In an agent (MCP tools)

The same flows as tool calls — e.g. `jev_plan_workstreams` with `{task, candidates, files}`, then spawn subagents for `parallel_safe`, then `jev_review` each output. The `jev-router` skill (`skills/jev-router/SKILL.md`) teaches any agent this loop.
