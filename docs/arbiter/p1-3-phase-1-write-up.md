# Arbiter Phase 1 proof point and gate

Date: 2026-09-09 America/New_York

Issue: HOK-2802

Gate call: decision-layer branch. `arbitrate()` remains a model, Showdown v0 remains in scope, and Arbiter Phases 2-4 proceed as planned. The scanner proceeds either way; Phase 1 gates the pairwise model story, not the scan, report, or Check verification product.

## Summary

Phase 1 tested the incumbent comparison judge from three angles against the same frozen challenge corpus:

- P1.1 replayed each adjudicated pair twice with candidate order reversed. The judge flipped 35 of 155 usable pairs: 22.6% (95% Wilson CI 16.7%-29.8%).
- The flip curve rises with raw difficulty: 2/16 easy collapsed pairs, 12.5% (3.5%-36.0%); 7/50 medium, 14.0% (7.0%-26.2%); 13/52 hard, 25.0% (15.2%-38.2%); 11/32 very hard, 34.4% (20.4%-51.7%).
- Probe B found that the comparison judge's kept side survived 30 days for 3 of 98 analyzed pairs: 3.1% (1.0%-8.6%). This uses the strict R5 survival mapping where `followup`, `substantially_rewritten`, and `reverted` all count as rework.
- Probe C found comparison/eval disagreement on 33 of 143 analyzed non-tie pairs: 23.1% (16.9%-30.6%). The disagreement rate is not flat: coder-only is 20/80, 25.0% (16.8%-35.5%); multi-variable is 7/27, 25.9% (13.2%-44.7%); reviewer-only is 6/20, 30.0% (14.5%-51.9%).

The observed result is not a flat, above-90% agreement surface. It shows order-sensitive flips and concentrated comparison/eval disagreement in the intended hard strata. The gate therefore stays on the decision-layer branch.

## Provenance

| Item | Value |
|---|---|
| Git HEAD | `c09e74b55765306b864b169eb4a91094769d599f` |
| Corpus file | `<repo>/.wavemill/evals/challenge-records.jsonl` |
| Corpus SHA-256 | `d4f592613dc96c812213680c4001add5b9aee0486f50dd77a9a7aefdc21b7e2c` |
| Eval file | `<repo>/.wavemill/evals/evals.jsonl` |
| Eval SHA-256 | `aa8a069c0182ca420a837b18a333783417bcd081c99c409b094acf47c1f56d8b` |
| Survival labels | `/tmp/hok-2802-arbiter/survival-labels.jsonl` |
| Survival labels SHA-256 | `972e3a40910e0255e4f3d0542b3bd9f0b5de9d76a54cacdd8d10ef9bad889124` |
| Swap run ID | `p1-3-incumbent-2026-09-09-usable` |
| Swap judge model | `claude-opus-4-7` |
| Swap judge template hash | `a1ab8d59320103b11ed0715e9217c10fb6d99af8a288de994b4d220bb7b87951` |
| Swap results SHA-256 | `e352be3ccc97d031abc4373882f9bc4997b1fdcf53c5a2a444dec1721abaa5e2` |
| Swap manifest SHA-256 | `b60111aca40ff61c3c2171509a874740d0786c1077464ca075cfb815f54ce090` |
| Swap summary SHA-256 | `e2eb87aac0632f7badcd0fdc3479fa2d81b53f37a6aef634b2758d1d7aef8a54` |
| Probe B JSON SHA-256 | `95d9a15d243d8ec8b405cf834bfb917312a780ba675d8d6568cf148279ae9ca6` |
| Probe C JSON SHA-256 | `cd3632161b6e1d8aab22d51a9fed17aff5ed52d1f99ed540eb92d419db9757c9` |

The source challenge ledger contained 264 comparison records. Selection retained 156 newest adjudicated pairs after dropping 4 duplicate pair rows, 3 manual-resolution rows, and 101 non-verdict rows. Swap replay used the 155 hydrated pairs; HOK-2844 had no hydrated challenger diff and is excluded from P1.1 only. Probes B and C analyze the full 156 selected-pair population because they do not require hydrated replay diffs.

The swap replay executed 310 latest-key orderings successfully, with 0 latest-key judge errors and 0 dry-run placeholders. The full append-only run file includes retries from transient session-limit and malformed-JSON failures; the report logic uses the latest row per `(pairId, order)`. The final run cost was $286.3255, used 33,967,072 total tokens, and had 22 truncated prompts at the 500,000 byte prompt cap.

## Methodology

### Population

An adjudicated pair is a `challenge-records.jsonl` row with an LLM verdict (`winner`, `dimensions`, and `rationale`) and no manual, forfeit, skip, invalid, or voided comparison outcome. Multiple rows for the same `challengePairId` keep the newest timestamp.

Challenge type and difficulty strata are derived by the existing shared P1.1/P1.2 helpers. Type comes from varied dimensions, stored challenge type, eval `challengeStage`, or challenge intent. Difficulty uses the available primary-side difficulty first, then challenger-side difficulty, then `unknown`. Collapsed difficulty maps raw buckets 1-2 to `1-2 easy`, 3 to `3 medium`, 4 to `4 hard`, and 5 to `5 very_hard`.

`unrecoverable` pairs are included in overall rates but excluded from interpreted per-type conclusions, because their challenged stage cannot be recovered. Empty-diff and original-tie pairs are reported in the degenerate sensitivity cell for P1.1.

### P1.1 Swap Replay

For each hydrated pair, the production blind judge path replayed the same primary/challenger diff pair twice:

- `primary-first`: primary rendered as Candidate A, challenger as Candidate B.
- `challenger-first`: challenger rendered as Candidate A, primary as Candidate B.

A flip means the normalized winner differs between the two orderings for the same pair. Position preference records whether a flipped pair picked the first-rendered side in both orders or the second-rendered side in both orders. Original-verdict agreement compares each replayed ordering with the original stored adjudication winner.

### Probe B Survival Agreement

Probe B asks whether the side kept by the comparison judge survived the 30-day horizon. A kept side counts as survival agreement only when the 30-day survival label has `report_outcome === "survived"`. Outcomes `followup`, `substantially_rewritten`, and `reverted` count as rework. Pairs with no label, missing horizon, or unmerged kept PRs are excluded from the Probe B denominator and reported separately.

### Probe C Comparison/Eval Disagreement

Probe C compares the head-to-head comparison winner with the eval-implied winner. For each side, the probe selects the stage-specific eval score when the challenge type maps to a stage and that score exists; otherwise it falls back to the overall score. Strictly higher eval score wins. Eval ties, defined as `|delta| < 1e-6`, are reported separately and excluded from the agreement/disagreement denominator. Missing evals exclude a side from analysis. Score fallback is counted separately.

### Intervals

All rates use Wilson 95% confidence intervals from `shared/lib/stats-utils.ts`. Small cells are shown with their intervals instead of being generalized from.

## Results

### P1.1 Flip Rate

| Cell | n | flips | rate | 95% CI |
|---|---:|---:|---:|---:|
| All usable pairs | 155 | 35 | 22.6% | 16.7% - 29.8% |
| Excluding degenerate pairs | 151 | 35 | 23.2% | 17.2% - 30.5% |

Degenerate sensitivity excluded 4 pairs: two original ties, one challenger empty diff, and one primary empty diff. Removing them does not remove the effect.

| Challenge type | n | flips | rate | 95% CI |
|---|---:|---:|---:|---:|
| coder-only | 90 | 16 | 17.8% | 11.2% - 26.9% |
| multi-variable | 29 | 6 | 20.7% | 9.8% - 38.4% |
| planner-only | 3 | 2 | 66.7% | 20.8% - 93.9% |
| reviewer-only | 20 | 8 | 40.0% | 21.9% - 61.3% |
| unrecoverable | 13 | 3 | 23.1% | 8.2% - 50.3% |

The reviewer-only cell has the clearest hard-stratum signal among recovered types: 8/20 flips, 40.0% (21.9%-61.3%). The planner-only cell is too small to generalize from.

| Difficulty bucket | n | flips | rate | 95% CI |
|---|---:|---:|---:|---:|
| 1 | 1 | 0 | 0.0% | 0.0% - 79.3% |
| 2 | 15 | 2 | 13.3% | 3.7% - 37.9% |
| 3 | 50 | 7 | 14.0% | 7.0% - 26.2% |
| 4 | 52 | 13 | 25.0% | 15.2% - 38.2% |
| 5 | 32 | 11 | 34.4% | 20.4% - 51.7% |
| unknown | 5 | 2 | 40.0% | 11.8% - 76.9% |

| Collapsed difficulty | n | flips | rate | 95% CI |
|---|---:|---:|---:|---:|
| 1-2 easy | 16 | 2 | 12.5% | 3.5% - 36.0% |
| 3 medium | 50 | 7 | 14.0% | 7.0% - 26.2% |
| 4 hard | 52 | 13 | 25.0% | 15.2% - 38.2% |
| 5 very_hard | 32 | 11 | 34.4% | 20.4% - 51.7% |
| unknown | 5 | 2 | 40.0% | 11.8% - 76.9% |

Among the 35 flips, 9 chose the first-rendered side in both orderings and 26 chose the second-rendered side in both orderings. Replay agreement with the original verdict was 110/155, 71.0% (63.4%-77.5%) in primary-first order and 111/155, 71.6% (64.1%-78.1%) in challenger-first order.

### P1.2 Probe B Survival Agreement

| Population | analyzed | excluded | survived | survival agreement | 95% CI |
|---:|---:|---:|---:|---:|---:|
| 156 | 98 | 58 | 3 | 3.1% | 1.0% - 8.6% |

Exclusions: 34 pairs had no 30-day label for the kept PR, 24 had a label with missing horizon, and 0 had an unmerged kept PR.

| Challenge type | n | survived | rate | 95% CI |
|---|---:|---:|---:|---:|
| coder-only | 52 | 2 | 3.8% | 1.1% - 13.0% |
| multi-variable | 15 | 0 | 0.0% | 0.0% - 20.4% |
| planner-only | 3 | 0 | 0.0% | 0.0% - 56.2% |
| reviewer-only | 15 | 0 | 0.0% | 0.0% - 20.4% |
| unrecoverable | 13 | 1 | 7.7% | 1.4% - 33.3% |

| Difficulty bucket | n | survived | rate | 95% CI |
|---|---:|---:|---:|---:|
| unknown | 98 | 3 | 3.1% | 1.0% - 8.6% |

| Collapsed difficulty | n | survived | rate | 95% CI |
|---|---:|---:|---:|---:|
| unknown | 98 | 3 | 3.1% | 1.0% - 8.6% |

Probe B is an intentionally strict verification signal, not a standalone model gate. The very low survival agreement says most kept sides later required follow-up under the current 30-day mapping. That supports continuing the scanner and Check verification product, but it does not erase the independent order-sensitivity and comparison/eval disagreement shown by P1.1 and Probe C.

### P1.2 Probe C Judge/Eval Disagreement

| Population | analyzed | ties | disagreements | disagreement rate | 95% CI |
|---:|---:|---:|---:|---:|---:|
| 156 | 143 | 8 | 33 | 23.1% | 16.9% - 30.6% |

Exclusions: 5 pairs were missing primary evals and 5 were missing challenger evals. Score fallback occurred in 0 analyzed pairs, so no disagreement depends on fallback scoring.

| Challenge type | n | disagreements | rate | 95% CI |
|---|---:|---:|---:|---:|
| coder-only | 80 | 20 | 25.0% | 16.8% - 35.5% |
| multi-variable | 27 | 7 | 25.9% | 13.2% - 44.7% |
| planner-only | 3 | 0 | 0.0% | 0.0% - 56.2% |
| reviewer-only | 20 | 6 | 30.0% | 14.5% - 51.9% |
| unrecoverable | 13 | 0 | 0.0% | 0.0% - 22.8% |

| Difficulty bucket | n | disagreements | rate | 95% CI |
|---|---:|---:|---:|---:|
| unknown | 143 | 33 | 23.1% | 16.9% - 30.6% |

| Collapsed difficulty | n | disagreements | rate | 95% CI |
|---|---:|---:|---:|---:|
| unknown | 143 | 33 | 23.1% | 16.9% - 30.6% |

| Eval score delta among disagreements | count |
|---|---:|
| < 0.05 | 17 |
| 0.05 - 0.15 | 12 |
| 0.15 - 0.30 | 1 |
| >= 0.30 | 3 |

| Absolute comparison-judge margin among disagreements | count |
|---:|---:|
| 0 | 1 |
| 1 | 3 |
| 2 | 4 |
| 3 | 5 |
| 4 | 4 |
| 5 | 3 |
| 6 | 2 |
| 7 | 3 |
| 8 | 2 |
| 9 | 3 |
| 10 | 2 |
| 31 | 1 |

The median absolute comparison-judge margin among disagreements is 4.00. Twenty-nine of 33 disagreements have eval-score deltas below 0.15, so most disagreement is concentrated near the eval judge's own close boundary. Three disagreements have large eval deltas at or above 0.30 and are worth direct inspection in later validity work.

## Gate

The gate takes the decision-layer branch.

P1.1 shows a non-flat flip curve: 35/155 overall, 22.6% (16.7%-29.8%), rising from 12.5% in collapsed easy pairs to 25.0% in hard pairs and 34.4% in very-hard pairs. Probe C shows comparison/eval disagreement of 33/143, 23.1% (16.9%-30.6%), with recovered hard strata at 25.0% coder-only, 25.9% multi-variable, and 30.0% reviewer-only. The incumbent judge is therefore not flat and above 90% agreement everywhere.

`arbitrate()` remains a model rather than collapsing into a de-noising feature. Showdown v0 remains justified as a public instance of the same pairwise experiment. Phases 2-4 proceed as planned.

This is asymmetric with the product decision: the scanner proceeds in either branch. Even if the pairwise story had failed, scan, report, and Check would have continued as the verification product. Because the decision-layer branch passed, closing HOK-2802 lifts the generator-measurement freeze for developing and landing `challenge.fork()`.

The reviewer-stage rollout boundary remains unchanged. Closing HOK-2802 does not authorize live stage-attributed reviewer comparisons. Those remain blocked until P2.4's validity contract, direct review evidence, executed-model identity, lifecycle safety, reviewer-stage adjudication, and integration-test gates pass.

## Reproduction

The measurement can be reproduced from the pinned corpus snapshot and local eval artifacts:

```bash
npx tsx tools/swap-test.ts --hydrate \
  --repo-dir "$PWD" \
  --evals-dir "$PWD/.wavemill/evals"

npx tsx tools/swap-test.ts --run --dry-run \
  --run-id p1-3-incumbent-2026-09-09-usable \
  --repo-dir "$PWD" \
  --evals-dir "$PWD/.wavemill/evals"

npx tsx tools/swap-test.ts --run \
  --run-id p1-3-incumbent-2026-09-09-usable \
  --max-cost-usd 300 \
  --concurrency 2 \
  --repo-dir "$PWD" \
  --evals-dir "$PWD/.wavemill/evals"

npx tsx tools/swap-test.ts --report \
  --run-id p1-3-incumbent-2026-09-09-usable \
  --repo-dir "$PWD" \
  --evals-dir "$PWD/.wavemill/evals"

npx tsx tools/backfill-survival.ts \
  --integration-branch auto/integration \
  --repo-dir "$PWD" \
  --horizons 30 \
  > /tmp/hok-2802-arbiter/survival-labels.jsonl

npx tsx tools/arbiter-probe-p1-2.ts --probe b --horizon 30 \
  --repo-dir "$PWD" \
  --evals-dir "$PWD/.wavemill/evals" \
  --records "$PWD/.wavemill/evals/challenge-records.jsonl" \
  --survival-labels /tmp/hok-2802-arbiter/survival-labels.jsonl \
  --out-dir /tmp/hok-2802-arbiter/reports \
  --data-out-dir /tmp/hok-2802-arbiter/probes \
  --json

npx tsx tools/arbiter-probe-p1-2.ts --probe c \
  --repo-dir "$PWD" \
  --evals-dir "$PWD/.wavemill/evals" \
  --records "$PWD/.wavemill/evals/challenge-records.jsonl" \
  --out-dir /tmp/hok-2802-arbiter/reports \
  --data-out-dir /tmp/hok-2802-arbiter/probes \
  --json
```

The committed document intentionally includes only aggregate summaries and hashes. Raw prompts, diffs, pair contexts, and JSONL rows remain in `.wavemill/evals` or `/tmp/hok-2802-arbiter`.

## Limitations

This is incumbent-judge evidence. It does not measure a future reviewer-stage generator or a changed judge prompt. P1.1 excludes HOK-2844 because hydration could not recover the challenger diff; Probe C still includes that pair because its eval data exists. Probe B's 30-day survival labels are strict and sparse for this corpus, with 58 of 156 selected pairs excluded from its denominator. Probe B/P1.2 difficulty strata are all `unknown` under the current eval descriptor substrate, so difficulty-shape evidence comes from P1.1 rather than from the two P1.2 probes.

The result supports proceeding with the pairwise decision-layer program. It does not claim causal production lift, and it does not authorize reviewer-stage live comparisons before P2.4.
