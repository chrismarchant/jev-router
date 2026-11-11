# Jev's limitations — and how this router encodes them

Sources: [AI primer](https://docs.typesafe.ai/introduction/machine-learning-primer.md) (RLCD training), [System One](https://docs.typesafe.ai/concepts/system-one.md), [Model jaggedness](https://docs.typesafe.ai/model-jaggedness.md), [Models](https://docs.typesafe.ai/models.md).

| Limitation | What it means | How jev-router handles it |
|---|---|---|
| **Not a generative model** (RLCD, not RLHF/RLVR) | Jev returns calibrated decisions/probabilities, never text or code. Calibration is group-level, not a per-answer guarantee. | Router never asks Jev to generate. Closed option sets are drafted by `jev_draft_options` (default **mistral-small-latest**, needs `MISTRAL_API_KEY`); Jev only picks. All combining/thresholding happens in your code. |
| **Literal reading** | Answers the question written, not the one meant; negations/scoping read at face value. | Built-in questions state the exact condition in `instructions`, put boundary cases in `criteria`, and reference state fields by path (`` `candidates[0].description` ``). |
| **No math, counting, dates** | Not a calculator; unreliable on numeric precision and date/ordering comparison. | Router does sorting, normalization, and weighting (composite score) in code. Never put arithmetic in a question; extract date parts as a Choice over enumerated options. |
| **Indirection costs accuracy** | Multi-hop "property of a property" questions degrade. | One judgment per question; name the relevant state fields explicitly. |
| **Context rot / large state** | Accuracy falls as `state` grows with irrelevant detail. Limits: 64k tokens per-request, 32k per-question; `state` counts against both; bodies ≤ 32 MiB, nesting ≤ 64. | File context capped by `MAX_CONTEXT_CHARS` (default 120000 ≈ under the 32k-token per-question budget); pass targeted files. `JEV_ROUTER_LONG_CONTEXT=true` opts into 262k via the danger-zone header — slower and less accurate, use only when needed. |
| **Adversarial content** | `state` is data; injected instructions can steer answers. | Never put secrets in `state`/questions; test edge cases before deploying. |
| **Choice option-order bias** | Jev can lean toward the first option. | Reorder options and re-check if an answer looks unstable. |
| **Images/Box experimental** | "Dreamer-ready"; format/limits/accuracy can change; Box needs Jev 1.14+; PNG/JPEG only. | `jev_box` sends the images danger-zone header automatically (`JEV_ROUTER_ALLOW_IMAGES`), validates format, and pairs Box with a `present` noul. |
| **Aliases move** | `jev-latest` changes between releases; thresholds tuned on one version may not transfer. | Every result includes the versioned `model` and `usage` — log both; pin e.g. `jev-1.14.0` via `TYPESAFE_MODEL` when tuned. |
| **Rate limits / errors** | Per-org token & request limits; 429 + `Retry-After`; 401 bad key; 422 malformed question; 413 > 32 MiB; 415 bad compression. | `client.js` retries 429/529/5xx with backoff honoring `Retry-After` (`JEV_ROUTER_MAX_RETRIES`, default 3); other statuses fail fast with the body in the error message. |
| **Pricing** | Input tokens only (~$0.042/M), output free. | Every tool result carries `usage`; fan-out keeps cost near one request. |
| **No audio/video** | Text + PNG/JPEG images only. | Enforced at the asset layer. |
