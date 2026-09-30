# Subsystem: eval-system

**Last updated:** 2026-08-22
**Files touched:** 18

## Purpose

The eval system persists autonomous-workflow outcomes into `.wavemill/evals/evals.jsonl` using an additive schema so downstream readers can aggregate training signals without migrations.

It now also captures quota-driven cross-model fallback events through the same eval pipeline, which keeps prompt attribution, aggregation, and router-training consumers on one record stream.

Historical and aggregated eval datasets now also carry explicit rubric provenance so training consumers can distinguish judge-emitted rubric metadata from legacy records that were later marked as missing rubric.

Eval records now also carry optional `harnessId` attribution when a resource manifest is available, allowing downstream analysis to group outcomes by the behavior-relevant prompt, memory, runtime, and agent-config resources used by the run.

Provisional model-identity holds are enforced at read time through `shared/lib/model-evidence-policy.ts`. Raw JSONL rows remain in the single append-only stream, but default training export, router benchmark, Hokusai projection, and launch-priority persistence partition records before flattening, scoring, submission, or writes. Each filtered consumer reports stable reason counts such as `provisional_model_identity`, `provisional_candidate_decision`, `registry_provisional_fallback`, and `provisional-observation-only`; operational export can include held rows with the hold reasons preserved.

## Key Files

| File | Role | Notes |
|------|------|-------|
| `shared/lib/eval-schema.ts` | Canonical TypeScript schema and changelog | Schema `1.42.0` adds `pr_diff_unavailable` fast-fail records and `eval_fast_failed` eligibility diagnostics for HOK-2853. |
| `shared/lib/eval-schema.json` | JSON Schema mirror for validator-style tests | Must stay in sync with `eval-schema.ts`, including additive optional fields. |
| `shared/lib/eval.ts` | Builds judge-backed eval records | Owns the top-level `SCHEMA_VERSION`. |
| `shared/lib/eval-record-builder.ts` | Pure metadata attachment helpers | `attachAttemptedModel()` follows the same null-safe no-op pattern as the other field helpers. |
| `shared/lib/eval-backfill.ts` | Historical rubric provenance backfill | Must parse strictly and rewrite atomically. |
| `shared/lib/eval-persistence.ts` | Appends and reads `evals.jsonl` | Persistence failures should never corrupt prior records. |
| `shared/lib/llm-cli.ts` | Emits fallback eval records on quota-triggered model swaps | Uses best-effort logging only after fallback events. |
| `tools/backfill-rubric-eval-records.ts` | CLI wrapper for rubric provenance backfill | Safe to re-run; supports `--dry-run`. |

## Architectural Constraints

### DO

- Keep schema evolution additive. New fields must be optional so old `evals.jsonl` rows continue to parse unchanged.
- Bump the eval schema minor version on additive changes and document the change in `eval-schema.ts`.
- Keep `eval-record-builder.ts` helpers pure and local: mutate the provided record, but treat `null` and `undefined` as "do nothing".
- Preserve pre-fallback routing evidence in `attempted_model` and `model_alias` when a launch-priority audit needs to distinguish "attempted but fell back" from "never attempted".
- Keep `shared/lib/eval-validator.ts` as the single authoritative source of eval validation error codes; tolerant readers may continue skipping malformed rows silently, but explicit validation must flow through that module.
- Route fallback telemetry through `appendEvalRecord()` so prompt-registry and aggregation tooling continue to observe a single eval pipeline.
- Treat telemetry writes as best-effort metadata. Fallback logging must never change the success or failure semantics of the LLM call itself.

### DON'T

- Do not introduce required fields for new training metadata.
- Do not create a parallel fallback-event store unless aggregation consumers are intentionally being split.
- Do not make eval persistence failures fatal to workflow execution or `llm-cli` request handling.
- Do not raw-write `.tasks[$issue].x = …` from post-reap-capable paths (background eval, job-poll completions, retry bookkeeping). Route them through `task_state_mutate_existing` in `wavemill-common.sh` so a late completion cannot recreate a reaped task as a slot-consuming stub (HOK-3125).

## RubricEval (1.10.0)

`EvalRecord.rubricEval` is an optional top-level field added in schema v1.10.0. It captures per-criterion scores from the eval judge as durable training signal, converting what was previously prompt-only rubric text into machine-readable data.

Fields:

- `schema_version`: always `"1.0"` for this shape.
- `rubric_version`: semantic version of the rubric (currently `"1.0"`); bump when criteria labels/weights change.
- `criteria`: five normalized 0.0–1.0 scores with 1-sentence rationales — `completeness`, `correctness`, `code_quality`, `intervention_impact`, `autonomy`.
- `determinative_boundary`: optional; which scoring boundary from "Scoring boundaries (strict)" was the binding constraint on the final score.

Compatibility rules:

- `rubricEval` is optional; old records parse without it — absence means pre-1.10.0 record.
- `rubricVersion` is NOT a separate top-level field; it lives inside `rubricEval.rubric_version`.
- Neither Hokusai submission payloads nor `taskDescriptor` include rubric criteria — those are evaluation metadata, not routing or outcome signals.

## Rubric Provenance (1.12.0)

`EvalRecord.rubric_provenance` is an optional top-level field added in schema v1.12.0. It makes mixed historical datasets explicit instead of overloading `rubricEval` absence to mean both "legacy row" and "judge omitted rubric".

Values:

- `judge`: `rubricEval` was emitted directly by the eval judge at write time.
- `backfill_derived`: a later backfill derived rubric semantics from historical data.
- `legacy_absent`: a historical row was explicitly marked as lacking rubric metadata.

Aggregation and backfill rules:

- Dedup prefers richer provenance: `judge` > `backfill_derived` > `legacy_absent` > unset.
- The backfill tool marks only previously unmarked rows and preserves unknown fields verbatim.
- Trainers should treat missing `rubric_provenance` as pre-backfill legacy data if they read old snapshots directly.

## Fallback Event Records (1.6.0)

`EvalRecord.fallbackEvent` is an optional nested payload for quota-aware attribution. It is only emitted when a cross-model fallback actually occurs.

Fields:

- `preferred_model`: first candidate attempted before fallback.
- `fallback_model`: model that ultimately succeeded, or `null` if no candidate did.
- `task_type`: routing ladder type used by `llm-cli`.
- `difficulty`: optional caller-supplied `DifficultyBand`.
- `quota_snapshot`: `{ snapshotAt, models }` copy of `readQuotaSnapshot()` reduced to training-relevant fields.
- `human_intervention`: currently always `false` for `llm-cli`-emitted records.
- `outcome`: one of `success`, `all_exhausted`, or `non_quota_error`.
- `latency_ms`: total wall-clock duration across the fallback sequence.
- `cost_usd`: final surfaced cost when available, otherwise `null`.
- `fallback_chain`: ordered failures that preceded the terminal outcome.
- `schema_version`: nested payload version, currently `1.0`.

Emission rules:

- No record is emitted when the first model succeeds and no fallback occurs.
- A `success` record is emitted when at least one quota fallback happens and a later model succeeds.
- An `all_exhausted` record is emitted before `LLMQuotaError` is thrown after every candidate hits quota.
- A `non_quota_error` record is emitted when quota fallback has already started and a later candidate fails for a different reason.

Compatibility and aggregation notes:

- Missing `fallbackEvent` must be interpreted as "older record", not a parse failure.
- Fallback records use the same top-level `EvalRecord` shape and `schemaVersion = 1.6.0`.
- Aggregation remains schema-version agnostic; dedup still keys on existing top-level fields.

## Known Failure Modes

| Symptom | Root Cause | Fix |
|---------|------------|-----|
| New fallback fields validate in TypeScript but schema tests fail | `eval-schema.json` was not updated with the additive field | Update both schema files in the same change. |
| Launch-priority audits undercount attempted challenger models | Fallback changed `modelId` and the record omitted `attempted_model` / `model_alias` | Use `attachAttemptedModel()` before persistence; older rows remain valid but lose that extra attribution. |
| Fallback occurred but no eval row was written | `logFallbackEvents` was disabled or persistence failed | Check `LLMCallOptions.logFallbackEvents`, then inspect `console.warn` output from `llm-cli`. |
| Older eval readers reject records | A new field was made required or parsing assumed presence | Restore optional semantics and add backward-compat coverage. |
| Fallback logging changes request behavior | Telemetry exception leaked out of the emitter | Keep `appendEvalRecord()` calls wrapped in local `try/catch`. |
| Large PRs are scored as empty work | GitHub refuses `gh pr diff` above its file limit or local diff output exceeds the byte cap | Use `fetchPrDiff()` local fallback; if no diff can be obtained, emit `pr_diff_unavailable` / `diff_unavailable` instead of judging placeholder content. |
| `0 slots available` with few live tasks | Post-reap eval writers re-created reaped tasks as phase/status-less stubs that fell through to `wm_resource_disposition = allocated` | Fixed by HOK-3125: writers must go through `task_state_mutate_existing`; counter classifies orphan stubs as `orphan`; startup preflight drops tombstoned stubs. |

## Testing Patterns

- Validate both TypeScript and JSON Schema surfaces when adding eval fields.
- Keep builder tests focused on null-safe attachment behavior.
- For historical backfills, fail fast on malformed JSONL and write through a temp file plus rename.
- For `llm-cli` fallback telemetry, use a temp repo and assert directly on `.wavemill/evals/evals.jsonl`.
- Cover success, all-exhausted, non-quota-abort, and opt-out paths for fallback emission.

## Dependencies

- `shared/lib/quota-state.ts` for projected quota snapshots.
- `shared/lib/evals-paths.ts` and `shared/lib/eval-persistence.ts` for repo-aware JSONL writes.
- `shared/lib/eval-aggregator.ts` and router consumers for downstream reads.
- `shared/lib/prompt-registry.ts` for adjacent attribution tooling that shares the eval storage area.

## Related Subsystems

- [quota-tracking](./quota-tracking.md) — source of model health and snapshot data used in fallback records.
- [router](./router.md) — consumes quota-aware signals and informs task-type-based model selection.

## Recent Changes

- 2026-08-23: Added read-time provisional evidence enforcement for HOK-2859. Default training export omits held rows with reason-count telemetry, operational export keeps them observable, and fail-closed consumers use `model-evidence-policy.ts` instead of trusting stale `trainingEligible` booleans.
- 2026-08-22: Added structured PR diff availability and local diff fallback for HOK-2853. Eval records now fast-fail with `failureReason: pr_diff_unavailable` when a PR diff cannot be read, and challenge comparisons persist inconclusive `diff_unavailable` / `eval_unscored` records instead of sending placeholders to judges.
- 2026-04-28: Aligned challenge PR comparison judging with the canonical 5-criterion rubric used by per-PR evals (HOK-1450), replacing legacy comparison dimensions and surfacing the same rubric in planning/coding prompts before implementation.
- 2026-07-13: Added optional `attempted_model` and `model_alias` to eval schema version `1.32.0` plus `attachAttemptedModel()` in `eval-record-builder.ts` (HOK-2234); launch-priority audits can now preserve the model actually attempted before fallback without invalidating older rows.
- 2026-04-27: Added `rubric_provenance` to eval schema version `1.12.0` and `backfill-rubric-eval-records.ts` (HOK-1408); aggregated and historical datasets now preserve rubric provenance explicitly, and dedup prefers rubric-richer duplicates.
- 2026-04-27: Added `rubricEval` to eval schema version `1.10.0` (HOK-1406); per-criterion rubric scores (completeness, correctness, code quality, intervention impact, autonomy) are now persisted as durable training signal alongside the aggregate score. Updated eval-judge.md prompt to emit rubricEval, added parsing in eval.ts, `attachRubricEval()` in eval-record-builder.ts, display in eval-formatter.ts.
- 2026-04-18: Added `fallbackEvent` to eval schema version `1.6.0` and wired `llm-cli` quota fallback emission into `evals.jsonl`.
