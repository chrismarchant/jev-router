# Primitives — how the router uses them

Source: https://docs.typesafe.ai/primitives (choice / score / noul / box / advanced structure).

| Type | Question fields | Answer fields | Router usage |
|---|---|---|---|
| `noul` | `instructions`, optional `criteria: {true, false}` descriptions | `noul` (0..1) — **no confidence** | screens, checks, independence/conflict flags, companion nouls |
| `choice` | `instructions`, `criteria`: map option → description (≤255; values may be string/object/array/null) | `choice`, `probabilities`, `confidence` | lanes, destinations, approach |
| `score` | `instructions`, `criteria`: ordered array of ≥2 level descriptions | `score` (can fall between levels), `legend`, `probabilities`, `confidence` | priority / risk / size / quality rubrics |
| `box` | `instructions` only; needs an image asset + images header; Jev 1.14+ | `box: {left, top, right, bottom}` (fractions of image size), `confidence` | `jev_box` (always paired with a `present` noul) |

## Rules the router encodes

- **One snap judgment per question.** Complex judgments are split into atomic questions and combined in code (composite scoring with weights — see `jev_plan_workstreams`).
- **Question IDs are for your code, not the model.** Write the full question in `instructions` and reference state fields by path in backticks, e.g. `` Does `candidates[0].description` … `` — avoids indirection (a known jagged edge).
- **Structured questions** (`instructions`/criteria as objects/arrays) are passed through unchanged — see *Advanced: structure*.
- **Companion noul on every Choice** (a Choice always picks one, even when nothing fits): `jev_route` (`any_fit`), `jev_plan_workstreams` (`<id>__lane_fits`), `jev_box` (`present`). Prefer this over an `other` option, which competes for probability.
- **No question-count limit** — only context limits (64k tokens/request, 32k/question). That is why fan-out in one request is the default.
- **Images**: PNG/JPEG only, sent as `assets` (`{placeholder: {path | data_base64, format}}`); the placeholder string is replaced wherever it appears in `state`/`instructions`/`criteria`. Requests with images/box need `TypeSafe-Danger-Zone-Images: true` (sent automatically; `JEV_ROUTER_ALLOW_IMAGES`).
- **Box**: edges are fractions from the top-left, so they work at any resolution. No recommended confidence threshold — tune your own; on low confidence re-ask on a larger/cropped image and pad edges before cropping. If the companion `present` noul is a clear no, the box is meaningless.

## Builders (`mcp-server/questions.js`)

```js
const { noul, choice, score, box } = require('./questions');
noul('Does `msg` request a refund?', { true: 'asks for money back', false: 'nothing to answer' });
choice('Which lane?', { feature: 'new behavior', bugfix: 'fixes broken behavior' }); // or ['feature', 'bugfix']
score('How severe?', ['0 cosmetic', '1 degraded', '2 blocking']);
box('the error banner in `img`');
```

`normalizeQuestions` accepts `{name: question}` or `[{id, ...question}]`; `validateQuestions` enforces type/criteria shapes before anything is sent.
