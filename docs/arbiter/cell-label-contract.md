---
title: Rework-risk cell label contract (`cell-0.1.0`)
---

# Rework-risk cell label contract (`cell-0.1.0`) — HOK-3361

## What this is (and is not)

`cell-0.1.0` is a **derived interpretation stream** over the authoritative
rework label (`cr-0.1.0`, HOK-3267). For every PR the rework labeler marks as
`reworked`, the cell labeller answers one question: *where did the defect
live?* — as a review layer x lens cell:

| | correctness | security | history | reversibility |
|---|---|---|---|---|
| **form** | | | | |
| **local_meaning** | | | | |
| **wiring** | | | | |
| **runtime** | | | | |
| **use** | | | | |

It is **not another corrective detector**. It never rewrites, re-derives, or
second-guesses the core rework fact: a cell row exists only for a `cr-0.1.0`
row the rework labeler already confirmed, referenced by source label version
(`cr-0.1.0`) and the canonical row hash — fix/original links are never
re-discovered here. When HOK-3267's reader lands, `loadCorrectivePairRows` in
`shared/lib/cell-backfill.ts` is replaced by that reader; the
`CorrectivePairRowV0` pair-identity shape is the merge surface.

`unknown` is a valid measured outcome, never imputed. Precision beats recall.

## Row contract

* Types + validation: `shared/lib/cell-label-contract.ts`
  (`validateCellLabelRow`, `buildCellLabelRow`, canonical hash)
* Frozen schema: `shared/schemas/cell-label.schema.json` (contract-pinned by
  `shared/lib/cell-label-contract.test.ts`)
* Storage: `shared/lib/cell-label-store.ts` — append-only JSONL; a re-run
  appends and never rewrites; the **latest `computed_at` per natural key**
  (`repo`, `original_pr_url`, `corrective_pr_url`) wins at query time.

Every row persists, for replay and human review:

- the chosen cell or `unknown` with typed reason codes;
- the **structural** decision (decided layer/lens, fired signal ids, reasons);
- the **LLM** decision (decided layer/lens, prompt version + SHA-256 prompt
  hash, diff SHA-256, model, attempt count, failure reasons);
- `agreement` (`agree` / `disagree` / `not_comparable`) with reason codes;
- the orthogonal `review_evidence` block for the **original** PR;
- a reproducibility envelope (schema/labeller/classifier/prompt versions,
  source label version + row hash, both head SHAs, `computed_at`).

Raw prompts and diffs are never stored — only stable references, hashes,
typed reason codes, and provenance.

## Decision composition (deterministic)

1. **Structural first** (`shared/lib/cell-classifier.ts`): path/diff-structure
   signals (migration/schema, callers/config/entrypoint, lifecycle/runtime,
   docs/usage/tests, dependency manifests, declarative shape changes,
   in-module edits) weighted per layer; keyword signals (security, history,
   reversibility) pick the lens. A clear layer/lens majority decides;
   conflicting or missing substrate yields `unknown`
   (`ambiguous_signals` / `no_substrate`).
2. **LLM second opinion / fallback** (`shared/lib/cell-llm-adapter.ts`):
   schema-constrained `{"layer":…,"lens":…}` response over the corrective
   diff, bounded attempts (default 2). Malformed/invalid/outage responses are
   typed failures (`llm_malformed_response`, `llm_invalid_cell`,
   `llm_unavailable`, `llm_retries_exhausted`) — never silently substituted.
3. **Composition** (`buildCellLabelRow`): a decided structural cell wins; an
   LLM disagreement is flagged (`structural_llm_disagree`), never obeyed;
   structural `unknown` + decided LLM → LLM fallback cell flagged
   `structural_unknown`; both undecided → explicit `unknown`.

## Review evidence (orthogonal enrichment)

`shared/lib/cell-review-evidence.ts` normalizes durable artifacts for the
*original* PR (`.review-result.json`, `.ready-result.json`,
`.challenge-*-result.json` in its feature directory; HOK-3338 lifecycle events
replace the reader when they land — the normalized run shape is the merge
surface). Semantics:

- missing data is **`unavailable`** (`feature_dir_missing`,
  `no_stage_artifact`) — never proof that no reviewer ran;
- a run is positive reviewer coverage only when completed, with a **pinned**
  execution identity (`executionEvidence.status === 'direct'`) and a head SHA
  that matches (stale-head evidence and unverifiable head identity never
  count); `intendedModel` alone is never coverage;
- the enrichment never feeds cell assignment — only the report cross-tabs.

## CLI

```bash
# Backfill (deterministic; LLM channel disabled unless --llm is passed)
npx tsx tools/backfill-cell-labels.ts \\
  --cr-labels .wavemill/evals/corrective-labels.jsonl \\
  --repo-dir /path/to/repo \\
  --out .wavemill/evals/cell-labels.jsonl \\
  [--computed-at 2026-03-01T00:00:00Z]   # pin for replays

# Report (dedup by natural key, then aggregate)
npx tsx tools/backfill-cell-labels.ts \\
  --report --labels .wavemill/evals/cell-labels.jsonl \\
  [--sample-size 12] [--min-cell-support 5]
```

Report JSON: `totals` (labelled/unknown/unknownShare), `byLayer` (row x
lens counts), `byLens`, `cells` (populated cells, descending), `agreement`
(agree/disagree/notComparable + agreementRate over comparable rows),
`reviewCrossTabs` (per layer: `reviewerMisses` = rework with an
evidence-backed reviewer run on record; `noEvidenceBackedRun`;
`coverageUnavailable`), `adequacy`, `verdict`, and `disagreementSample`.

## Human review procedure

1. Run the report; take the `disagreementSample` (default 12, clamped to
   10-15, deterministically ordered by label key).
2. For each sample row, read the corrective diff (by SHA) and decide whether
   the structural cell, the LLM cell, or neither is right; record the verdict
   beside the row's label key.
3. Feed systematic wins back as classifier signal or prompt-version changes -
   bump `CELL_CLASSIFIER_VERSION` / `CELL_LLM_PROMPT_VERSION` when behaviour
   changes, re-run, and append; history is never rewritten.

## Verdict semantics (conservative by construction)

- **Targeted reviewer**: recommended only when a cell has at least
  `minCellSupport` (default 5) labelled reviewer misses **and** those misses
  concentrate at least `concentrationThreshold` (default 50%) of the layer's
  misses. Anything less reports `insufficient_evidence`.
- **Adequacy** is stated separately: the cell label is adequate for Rework
  Risk diagnosis / v2 check-menu use only when the structural-vs-LLM
  agreement rate is >= 80% over comparable rows **and** the unknown share is
  <= 20%. `adequacy.reasons` names each failed bar.

## Measured verdict

Pending: the bounded historical backfill and the 10-15-row disagreement
review are operator `manual_steps` (see the HOK-3361 plan's Release
Readiness). This section is to be filled with the measured distributions,
agreement/unknown rates, and the resulting reviewer recommendation after the
first backfill run against the landed `cr-0.1.0` corpus.

## Tests

Unit coverage lives beside the modules (`cell-label-*.test.ts`) and is
registered in `tests/run-unit-tests.sh`: schema validation, append-only/dedup
semantics, every layer/lens structural signal, ambiguity-to-unknown, LLM
validation/failure/retry, evidence provenance, aggregation, disagreement
selection, and verdict thresholds - all against schema-validated fixtures in
temp paths.