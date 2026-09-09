# Arbiter P1.2 Probes — Operator Guide

Probes B and C analyze judge accuracy by comparing verdicts against two ground truths:
- **Probe B**: Does the head-to-head comparison judge pick the side that survives?
- **Probe C**: Where do comparison and eval judges disagree?

Together with P1.1 (the swap test), these three probes characterize the judge's:
- **Consistency** (P1.1) — same pair, flipped presentation, same winner?
- **Accuracy vs survival** (P1.2 Probe B) — kept side survives 30 days?
- **Alignment with eval judge** (P1.2 Probe C) — both judges reach same verdict?

## Running the probes

```bash
# Both probes (Probe B requires survival labels)
npx tsx tools/arbiter-probe-p1-2.ts

# Probe B only (judge vs survival)
npx tsx tools/arbiter-probe-p1-2.ts --probe b

# Probe C only (judge vs eval judge disagreement)
npx tsx tools/arbiter-probe-p1-2.ts --probe c

# Custom horizon (default 30 days)
npx tsx tools/arbiter-probe-p1-2.ts --horizon 14
npx tsx tools/arbiter-probe-p1-2.ts --horizon 60

# JSON output for scripting
npx tsx tools/arbiter-probe-p1-2.ts --json
```

## Probe B — Judge vs kept-side survival

The comparison judge picks a "kept" side (the winner). Did it survive 30 days?

### Agreement definition

Judge is **right** iff the kept-side's 30-day survival label has `report_outcome === 'survived'`.

Any of {`followup`, `substantially_rewritten`, `reverted`} counts as **needed rework**.

This definition is frozen in `docs/arbiter/survival-label-reconciliation.md` (R5
reconciliation). Probe B uses it verbatim; we do not invent a second mapping.

### Classification

**Analyzed**: Pair has a 30-day survival label with a terminal outcome (`survived`,
`followup`, `substantially_rewritten`, or `reverted`).

**Excluded**:
- `excluded_no_label` — No 30-day label at all for the kept PR.
- `excluded_missing_horizon` — Label present, but `report_outcome === null` (too
  recent, unmerged PR, or missing history). Reason codes: `missing_horizon`,
  `insufficient_history`, `insufficient_line_range_substrate`, `inaccessible_history`, `ambiguous_change`.
- `excluded_kept_pr_unmerged` — The kept side (winner) never merged. Reason code:
  `unmerged_pr`.

### Output

**Markdown report**: `docs/arbiter/p1-2-survival-probe-report.md`
- Overall agreement rate + 95% Wilson CI
- Exclusion counts
- Stratified rates by challenge type, difficulty bucket, difficulty collapsed

**JSON data**: `.wavemill/evals/arbiter-probes/p1-2-survival-probe.json`
- Per-pair rows with classification, outcome, and stratification
- Full summary with cells for every stratum

### Edge cases

- **Loser never merged**: Impossible for Probe B (the *winner* is merged by definition).
  Loser-side diagnostics are included in JSON for context.
- **Multiple rows per pairId**: Handled by `selectAdjudicatedPairs` (newest timestamp
  wins; already deduplicated before reaching Probe B).
- **Unrecoverable challenge type**: Included in overall rate, excluded from stratified
  analysis (marked `excludedFromStratifiedAnalysis: true`).
- **Missing survival labels**: Probe B gracefully reports n=0 analyzed. Cross-phase
  dependency: Probe B can run in parallel with Phase 2 (the labeller), picking up
  labels as they arrive.

## Probe C — Judge vs eval judge disagreement

The per-PR eval judge and the head-to-head comparison judge sometimes disagree. This
probe characterises where and why.

### Score selection

For each side, `selectChallengeEvalScore(record, challengeType.type)` picks:
- **Stage-specific score** (when available): selected by challenge type
  (planner-only → plan stage, coder-only → implementation, reviewer-only → review).
- **Overall score** (fallback): when stage scores are unavailable or challenge type
  does not map to a stage (multi-variable, full-stack, unrecoverable).

This is the production score selection; Probe C uses it verbatim so verdicts are
reproducible.

### Eval-implied winner

Strictly higher score wins. Ties (`|delta| < 1e-6`) are labeled `eval_tie` and
reported separately (not counted as disagreements or agreements).

### Classification

**Analyzed**: Pair has eval records for both sides, scores selected (with or without
fallback).

**Excluded**:
- `excluded_missing_eval_primary` — Primary side has no eval record.
- `excluded_missing_eval_challenger` — Challenger side has no eval record.

**Flagged but analyzed**:
- `excluded_score_fallback` — Both sides have evals, but at least one score fell back
  to overall (stage score unavailable). Included in the analyzed denominator and
  separately counted so the write-up can decide weight given to disagreements under
  fallback.

### Disagreement classification

- `agree` — Comparison judge winner == eval implied winner.
- `disagree` — Comparison judge winner ≠ eval implied winner.
- `eval_tie` — Eval scores too close (`|delta| < 1e-6`). Reported separately.

### Characterisation of disagreements

For each disagreement:
1. **Judge margin** — Sum of dimension differences (same formula as swap-test):
   `sum(primary - challenger)` across all dimensions.
2. **Eval closeness** — Bucket `|eval_primary - eval_challenger|`:
   - `< 0.05` — very close
   - `[0.05, 0.15)` — close
   - `[0.15, 0.30)` — moderate gap
   - `>= 0.30` — large gap

**Finding**: Small eval deltas should produce more disagreements than large deltas.
If they don't, that signals the eval judge is less decisive or less aligned with the
comparison judge.

### Output

**Markdown report**: `docs/arbiter/p1-2-eval-disagreement-report.md`
- Overall disagreement rate + 95% Wilson CI
- Ties (excluded from rate calculation)
- Exclusion counts (missing evals) and fallback counts/rate
- Stratified disagreement rates by challenge type, difficulty bucket, difficulty collapsed
- Disagreement margin and closeness distributions
- Full listing of disagreement pairs

**JSON data**: `.wavemill/evals/arbiter-probes/p1-2-eval-disagreement.json`
- Per-pair rows with classification, scores, margins, closeness
- Full summary with stratified cells and distribution tables

### Edge cases

- **Unrecoverable challenge type**: Included in overall, excluded from stratified
  analysis.
- **Multiple rows per pairId**: Deduplicated before reaching Probe C (newest timestamp).
- **Tie handling**: Separately counted, not forced into agree/disagree bins.

## Stratification axes (both probes)

Probes B and C stratify identically using the same functions as P1.1 (swap-test):

1. **By Challenge Type** — Derived from `variedDimensions`, `challengeType`, or
   eval-stage recovery:
   - `planner-only`, `coder-only`, `reviewer-only`
   - `depth-varied` (depth only, roles unchanged)
   - `multi-variable` (more than one dimension varied)
   - `full-stack` (cross-role) 
   - `unrecoverable` (cannot classify)

2. **By Difficulty Bucket** — `1, 2, 3, 4, 5, unknown`
   - Source: whichever side reports a difficulty band (primary > challenger > none).

3. **By Difficulty Collapsed** — `1-2 easy`, `3 medium`, `4 hard`, `5 very_hard`, `unknown`
   - Collapses buckets 1–2 for readability.

## Reading the reports

### How to compare P1.1, P1.2 Probe B, and P1.2 Probe C

```
P1.1 swap-test (consistency):
  "The judge flipped verdict 5.1% of the time under presentation order swap."

P1.2 Probe B (accuracy vs survival):
  "The judge kept sides that survived 87.3% of the time (95% CI: 81% - 92%)."

P1.2 Probe C (eval alignment):
  "The comparison and eval judges disagreed on 22.5% of the 138 pairs (95% CI: 16% - 30%)."
  Sub-finding: Disagreements cluster in low-margin, close-score cases.
```

High inconsistency (P1.1) + high disagreement with eval (Probe C) but OK survival
agreement (Probe B) suggests the judge has a **stable bias** favoring one side.
High Probe B agreement + low Probe C agreement suggests the eval judge has **lower
fidelity** than the comparison judge.

### Wilson 95% Confidence Intervals

All rates are reported with [Wilson score intervals](https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval#Wilson_score_interval)
(not Wald / ± SE), which:
- Handle extreme rates (0%, 100%) gracefully
- Tighten as n grows
- Are symmetric when p ≈ 0.5, skewed when p extreme

Cells with n < 5 are useful for detecting absences (all_zero, all_success) but CIs
are wide.

## File manifest

- **Input**: `challenge-records.jsonl` (from P1.0), `evals.jsonl`, `survival-labels.jsonl` (from P2.1)
- **Output**:
  - Markdown: `docs/arbiter/p1-2-survival-probe-report.md`, `docs/arbiter/p1-2-eval-disagreement-report.md`
  - JSON: `.wavemill/evals/arbiter-probes/p1-2-survival-probe.json`, `.wavemill/evals/arbiter-probes/p1-2-eval-disagreement.json`

All reports include a header block: run timestamp, input file paths, SHA-256 hashes,
git HEAD commit (provenance).

## Known limitations

1. **Survival labels are the one cross-phase dependency**: Probes B and C cannot run
   until Phase 2 (R2b — the survival labeller) produces labels. Phase 1 and Phase 2
   are specified to run in parallel.
2. **Too-recent pairs**: If a pair merged less than 30 days ago, it has no 30-day label
   yet. Probe B excludes it as `excluded_missing_horizon`. Re-run the probe later.
3. **Unmerged PRs**: A PR that the judge picked as the winner but was never merged is
   excluded as `excluded_kept_pr_unmerged` (reason code `unmerged_pr` in the label).
4. **Eval fallback**: When a stage score is unavailable (stage-specific score data
   missing), Probe C falls back to overall score. These pairs are flagged
   `excluded_score_fallback` in the analyzed set. Write-up can decide whether to weight
   them.

## References

- **R5 survival label reconciliation**: `docs/arbiter/survival-label-reconciliation.md`
- **Arbiter plan of record**: Hokusai Linear doc "Hokusai Arbiter Plan of Record"
  (§18 Phase 1 probes B and C; Appendix B)
- **Swap-test (P1.1)**: `tools/swap-test.ts`, `shared/lib/swap-test/`
- **Survival labels (R2b)**: `tools/backfill-survival.ts`, `shared/lib/survival-labeller.ts`
