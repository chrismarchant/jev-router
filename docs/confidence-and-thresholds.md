# Confidence & thresholds

Source: https://docs.typesafe.ai/confidence, https://docs.typesafe.ai/primitives/noul.

## What `confidence` is

- Choice/Score/Box answers include `confidence` (0–1): a summary of how **peaked** the answer's `probabilities` are — 1 when all probability is on one outcome, 0 when spread evenly.
  - Choice (n options, p_max = top probability): `(p_max − 1/n) / (1 − 1/n)`
  - Score (ordered levels): probability-weighted average distance from the most likely level, compared against an even spread.
- **Noul answers carry no `confidence`** — the single `noul` value is the complete distribution over {yes, no}. If you need a confidence-style number, use `|2p − 1|` (that's what `jev_fan_out --noul-confidence` uses).
- Confidence measures *how settled the answer is*, **not** the probability that the selected answer is correct. For a fixed option count they're transformations of each other, so don't threshold both.

## How to read answers (the router's defaults)

- **Noul**: >0.7 = yes, <0.3 = no, 0.3–0.7 = its own outcome ("uncertain" — route to a person, don't round). `jev_review` uses exactly this: `pass` ≥ `pass_threshold` (0.7), `fail` < `fail_below` (0.3), else `uncertain`.
- **Choice — acting**: threshold the **probability of the option your code will act on** (`probabilities[choice]`). `jev_route` requires probability ≥ `threshold` (default 0.6) **and** companion `any_fit` = clear yes **and** `confidence` ≥ `confidence_floor` (default 0.5); otherwise `act=false` with an escalation recommendation.
- **Score**: route on `score`, but check `confidence` first — if the decision depends on which side of a level boundary the answer falls, sum the `probabilities` on the side that matters (a split between two levels can pass a confidence check and land on the wrong side). `jev_review` flags `quality_uncertain` when the quality score's confidence < 0.5.
- **Box**: no recommended threshold — tune per your images; low confidence → re-ask on a larger/cropped image, pad edges before cropping.

## Tuning advice (from the docs)

Thresholds scale with risk: raise them when a false yes is expensive (refunds, paging), lower them when a missed yes is expensive (safety flags). Start conservative, test on your own data, adjust. Pin a versioned model ID (e.g. `jev-1.14.0`) instead of the `jev-latest` alias if you tune thresholds — aliases move between releases (the response's `model` field tells you which version answered).
