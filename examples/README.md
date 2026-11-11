# Examples

All commands assume `TYPESAFE_API_KEY` is set (https://console.typesafe.ai/keys).
Run from the repo root with the CLI (`node bin/jev-router.js …`), or use the
equivalent MCP tool (`jev_*`) from any agent.

```bash
# 1. Plan parallel workstreams for a coding task (one fan-out request)
node bin/jev-router.js plan \
  --task @examples/task.txt \
  --candidates @examples/plan-candidates.json \
  --files '["src/server.js"]'

# 2. Batch-triage many tickets in parallel (one request per item, concurrency 6)
node bin/jev-router.js batch --items @examples/triage-items.json --concurrency 3

# 3. Route a single item with a companion noul + threshold
node bin/jev-router.js route \
  --item "The webhook signature check fails on retry" \
  --destinations '{"billing": "charges/invoices/refunds", "technical": "bugs and integration problems", "sales": "pricing and accounts"}'

# 4. Review a workstream output against acceptance criteria
node bin/jev-router.js review \
  --output @pr-diff.patch \
  --criteria '[{"id":"tests","check":"adds or updates tests"},{"id":"no-secrets","check":"contains no API keys or credentials"}]'

# 5. Speculative fan-out by hand: everything in ONE request
node bin/jev-router.js fan-out --state "I was charged twice. Please refund ASAP." --questions '{
  "category": {"type":"choice","instructions":"What is this about?","criteria":{"billing":"charges/refunds","technical":"bugs","other":"rest"}},
  "severity": {"type":"score","instructions":"How severe?","criteria":["cosmetic","degraded","blocking"]},
  "refund":   {"type":"noul","instructions":"Is a refund requested?"},
  "urgent":   {"type":"noul","instructions":"Is it urgent?"}
}'

# 6. Box: locate an element in a screenshot (experimental images header, needs Jev 1.14+)
node bin/jev-router.js box --image screenshot.png --instructions "the red error banner in `img`"

# 7. Draft a closed option set with a small LLM (Jev never generates text, it only picks)
#    Requires MISTRAL_API_KEY; default draft model is mistral-small-latest.
node bin/jev-router.js draft-options --topic "lanes for a coding task" --count 8
# -> feed the returned "criteria" into: plan --lanes, route --destinations, or ask --questions
```
