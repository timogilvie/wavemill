# Arbiter Phase 1 Gate Write-up

Status: evidence snapshot incomplete as of 2026-09-09.

## Gate call

**Not called from this repository snapshot.** HOK-2802 requires one of two public
gate branches, but the local and sibling worktrees do not contain the frozen
Phase 1 artifacts needed to make that call without manufacturing evidence:

- P1.1 swap-test `summary.json`: missing.
- P1.2 30-day survival-agreement JSON: missing.
- P1.2 judge/eval-disagreement JSON: missing.
- `survival-labels.jsonl`: missing, so the 30-day survival denominator cannot be
  reconstructed without running the backfill.

The scanner still proceeds after the eventual gate call. Phase 1 gates the
model and the pairwise story, not the scan/report/Survival Check product. Closing
HOK-2802 lifts the generator freeze for developing and landing the new pair
generator, but it does not authorize live stage-attributed reviewer comparisons
until P2.4 validity, direct review evidence, executed-model identity, lifecycle
safety, reviewer-stage adjudication and integration-test gates pass.

## Required evidence

The final public report must be generated from immutable aggregate artifacts,
not from raw prompts or diffs:

| Probe | Required artifact | Metric |
|---|---|---|
| P1.1 swap test | `<evals-dir>/swap-test/runs/<run-id>/summary.json` | Flip rate under blinded two-order replay |
| P1.2 survival | `<evals-dir>/arbiter-probes/p1-2-survival-probe.json` | Kept-side 30-day survival agreement |
| P1.2 eval disagreement | `<evals-dir>/arbiter-probes/p1-2-eval-disagreement.json` | Head-to-head judge versus eval-implied winner disagreement |

Each table must report `n`, event count, rate and Wilson 95% confidence interval
overall and by challenge type, difficulty bucket and collapsed difficulty.
Denominators are probe-specific and must not be pooled. Ties, missing labels,
missing eval rows, non-terminal horizons and unmerged kept-side PRs are never
treated as agreements.

## Methodology

Population: adjudicated challenge pairs with an LLM comparison verdict, excluding
manual resolutions, non-verdict outcomes, voided records and older duplicate
rows for the same `challengePairId`.

P1.1 replays each usable pair through the same blind judge twice, once in
`primary-first` order and once in `challenger-first` order. A flip means those
two blinded presentations pick different winners.

P1.2 survival evaluates only the kept side. A row is analyzed only when the kept
PR has a terminal survival label at the configured horizon. `report_outcome =
survived` counts as agreement; `followup`, `substantially_rewritten` and
`reverted` count as needed rework. Null outcomes are exclusions with typed
reason codes.

P1.2 eval disagreement compares the head-to-head comparison winner with the
strict higher per-side eval score. Exact ties (`|delta| < 1e-6`) are reported
separately and excluded from the denominator. Stage-score fallback rows remain
in the analyzed denominator and must be annotated.

Strata use the shared swap-test derivation helpers for challenge type,
difficulty bucket and collapsed difficulty. Unrecoverable challenge type is
included in overall counts and marked in stratified tables.

## Reproduction commands

If the frozen P1.1 run exists, render its summary without rerunning the judge:

```bash
npx tsx tools/swap-test.ts \
  --report \
  --run-id <run-id> \
  --repo-dir /Users/timothyogilvie/Dropbox/wavemill \
  --evals-dir /Users/timothyogilvie/Dropbox/wavemill/.wavemill/evals
```

If P1.2 aggregate outputs are absent, produce them from the frozen records and
the survival labels; the 30-day survival section must disclose missing labels
and horizon exclusions rather than imputing outcomes:

```bash
npx tsx tools/arbiter-probe-p1-2.ts \
  --repo-dir /Users/timothyogilvie/Dropbox/wavemill \
  --evals-dir /Users/timothyogilvie/Dropbox/wavemill/.wavemill/evals \
  --records /Users/timothyogilvie/Dropbox/wavemill/.wavemill/evals/challenge-records.jsonl \
  --survival-labels /Users/timothyogilvie/Dropbox/wavemill/.wavemill/evals/survival-labels.jsonl \
  --horizon 30
```

Then generate the combined JSON snapshot and Markdown report:

```bash
npx tsx tools/arbiter-analyze-p1-probes.ts \
  --swap-summary /Users/timothyogilvie/Dropbox/wavemill/.wavemill/evals/swap-test/runs/<run-id>/summary.json \
  --survival-summary /Users/timothyogilvie/Dropbox/wavemill/.wavemill/evals/arbiter-probes/p1-2-survival-probe.json \
  --eval-disagreement-summary /Users/timothyogilvie/Dropbox/wavemill/.wavemill/evals/arbiter-probes/p1-2-eval-disagreement.json \
  --horizon 30 \
  --out-json /Users/timothyogilvie/Dropbox/wavemill/.wavemill/evals/arbiter-probes/p1-3-phase-1-analysis.json \
  --out-md docs/arbiter/p1-3-phase-1-gate-write-up.md
```

## Decision Log draft

Do not append this as the final gate call. Append only after the required
artifacts exist and exactly one branch is called.

`**2026-09-09 · HOK-2802 · wavemill** — Phase 1 gate not called from this source
snapshot because required frozen probe artifacts are missing. Why: a public gate
call must be backed by P1.1 flip rate, P1.2 survival agreement and P1.2
judge/eval disagreement with denominators and confidence intervals. Affects:
HOK-2802 remains open; the P2.4 generator freeze remains in place until a
complete frozen snapshot is analyzed.`
