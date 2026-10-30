# Rework Risk: Review Layer x Lens Cell Labels (`cell-0.1.0`)

## Overview

The `cell-0.1.0` derived label classifies **where defects lived** for pull requests marked as reworked by the authoritative `cr-0.1.0` corrective labeler (HOK-3267).

### Payoffs
1. **Wavemill reviewer specialization**: Determine whether single-reviewer misses cluster in particular architectural layers (e.g. `wiring` and `runtime`). Materially concentrated misses justify targeted reviewers for those cells.
2. **Rework Risk / I-25 diagnostic vocabulary**: Provide a structured diagnosis of where risk sits in candidate PRs, giving check-menu recommendation engines the vocabulary to select targeted readers.

### Semantic Boundary

`cell-0.1.0` is an **interpretation**, not a fact. It forms a separate, append-only derived-label stream over authoritative `cr-0.1.0` rows:
- It never creates, deletes, or rewrites the core rework fact or corrective PR linkage.
- The versioned natural key is the corrective pair identity (`rework_id` or `cr:<origPr>:<fixPr>`).
- Latest row by `envelope.computed_at` wins at query time.

---

## Cell Vocabulary: 5 Layers x 4 Lenses Product Space

### 1. Layers (Rows)
- `form`: Formatting, whitespace, linter rules, comment typos, imports reordering.
- `local_meaning`: Localized function logic, boundary conditions (`<` vs `<=`), null/undefined checks, local assertions, regex adjustments.
- `wiring`: Cross-module interfaces, schema/migration definitions, configurations, runner arrays, router bindings, manifest/resource registration.
- `runtime`: Concurrency, async/await, race conditions, mutex/locks, process signals/lifecycle, timers/timeouts, resource leak prevention.
- `use`: End-user or operator-facing surfaces: CLI flags, command descriptions, user documentation, prompt templates, user-facing error messages.
- `unknown`: Explicit outcome when evidence cannot support a definitive layer.

### 2. Lenses (Columns)
- `correctness`: Functional defects, crashes, broken assertions, wrong return values.
- `security`: Authentication, authorization, token/secret exposure, injection sanitization, permission gates.
- `history`: Regressions of previously working features, merge conflict fallout, unintended reverts.
- `reversibility`: Rollbacks, down migrations, teardown cleanup handlers, idempotency guards.
- `unknown`: Explicit outcome when evidence cannot support a definitive lens.

---

## Classification Pipeline

The classification follows the behavioral rules + bounded LLM second-opinion pattern (HOK-3341):

1. **Deterministic Structural Signals (First)**:
   - Analyzes changed file paths and diff hunks.
   - Evaluates path markers (`.prettierrc*`, `shared/schemas/*`, `docs/*`, etc.) and code primitives (`async/await`, `mutex`, `export`, etc.).
   - Confidence scoring: `high`, `medium`, `low`, or `none`.
   - Ambiguous or conflicting signals (e.g. equal strength across divergent layers) yield `unknown` with reason code `structural_ambiguous_signals`.
   - Empty or whitespace-only diffs yield `unknown` with reason code `structural_insufficient_substrate`.

2. **Bounded LLM Classifier (Second Opinion / Fallback)**:
   - Invoked over the normalized, bounded corrective diff.
   - Constrained JSON schema output: `{ "layer": "...", "lens": "...", "explanation": "..." }`.
   - Malformed responses or runner timeouts are captured explicitly as `llm_malformed_response` or `llm_unavailable` without crashing.

3. **Reconciliation & Agreement**:
   - Reconciles structural and LLM decisions into `chosen`, `agreement`, `disagreement_state`, and typed `reason_codes`.
   - High-confidence structural signals take precedence over divergent LLM suggestions.
   - If structural signal is `unknown`, valid LLM classification is used as fallback (`llm_fallback_used`).

4. **Orthogonal Original PR Historical Review Evidence**:
   - Reads route artifacts and stage results (`.review-result.json`, `routing.jsonl`) for the original PR using `resolveTaskArtifact`.
   - Normalizes reviewers run (`reviewers_run`) and challenge stages (`challenge_stages`).
   - Stamps evidence provenance: `direct` (live worktree), `archived`, `partial`, or `unavailable`.
   - Missing historical review data is treated as `unavailable` with coverage flag `missing_review_artifact` — **never inferred as "no reviewer ran"**.

---

## CLI Tools

### 1. Backfill CLI (`tools/backfill-rework-cells.ts`)

Extracts diffs and generates `cell-0.1.0` records from a `cr-0.1.0` input corpus:

```bash
# Offline run (structural signals only)
npx tsx tools/backfill-rework-cells.ts \
  --corpus .wavemill/evals/rework-pairs.jsonl \
  --offline \
  --out .wavemill/evals/rework-cell-labels.jsonl

# Online run with LLM second opinion
npx tsx tools/backfill-rework-cells.ts \
  --corpus .wavemill/evals/rework-pairs.jsonl \
  --model anthropic/claude-3.5-sonnet \
  --out .wavemill/evals/rework-cell-labels.jsonl
```

### 2. Analysis & Report CLI (`tools/report-rework-cells.ts`)

Deduplicates label records, generates distributions, reviewer cross-tabs, disagreement review sample, and conservative verdicts:

```bash
# Print human-readable report to stdout
npx tsx tools/report-rework-cells.ts --input .wavemill/evals/rework-cell-labels.jsonl

# Generate structured JSON report
npx tsx tools/report-rework-cells.ts --input .wavemill/evals/rework-cell-labels.jsonl --json

# Save report to markdown with 15 disagreement samples
npx tsx tools/report-rework-cells.ts --sample-size 15 --out cell-report.md
```

---

## Human Review Procedure

Instead of hand-labeling the entire corpus, review is concentrated on a deterministic sample (default 10–15 rows) of cases where structural heuristics and the LLM disagreed:

1. Run `npx tsx tools/report-rework-cells.ts` to inspect the `## 6. Disagreement Review Sample` section.
2. For each disagreement entry:
   - Check the corrective PR diff link.
   - Evaluate whether the structural rule or the LLM's explanation correctly localized the defect.
   - If a structural rule is repeatedly mistaken, refine the signal weights in `shared/lib/rework-cell-classifier.ts`.
   - If an owner correction is required, record a tier-2b override row.

---

## Conservative Verdict Criteria

### Targeted Reviewer Recommendation
- **Threshold**: Requires at least **5 labeled PRs** in a layer/cell AND at least **25% concentration** of all known rework misses.
- **Verdict**: If met, recommends a specialized reviewer targeting that layer (e.g. `wiring` or `runtime`). Otherwise, explicitly reports "Insufficient evidence to justify a targeted wavemill reviewer".

### Adoption Readiness for Rework Risk & v2 Check Menu
- **Agreement threshold**: Evaluated agreement rate must be >= **70%**.
- **Unknown threshold**: Unknown cell rate must be <= **30%**.
- **Verdict**: Only declared ready when both criteria are met on a sample of at least 5 records. Otherwise, reports exact deficits preventing production adoption.
