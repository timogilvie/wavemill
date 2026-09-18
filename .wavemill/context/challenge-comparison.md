# Challenge Comparison

Challenge pairs now persist an explicit comparison state on both tasks in the pair.

Launch invariant: non-control challenge pairs must differ on at least one routing dimension before any challenger work starts. Comparable routing dimensions are `planner`, `coder`, `reviewer`, `planDepth`, `codeDepth`, and `reviewMode`.

Challenge coverage and performance consumers enforce provisional evidence holds through `shared/lib/model-evidence-policy.ts` before ranking, coverage counting, or win-rate aggregation. Held executed-model rows do not contribute coverage cells, challenge performance, stage-quality, variant, or cost statistics. The raw eval and comparison records remain observable, and summaries expose excluded counts plus stable reason counts so coverage gaps can be audited without mutating JSONL.

## States

- `comparison_running`: comparison job is in flight.
- `retrying_eval`: at least one eval timed out and wavemill is retrying within the configured cap.
- `manual_comparison_needed`: automatic comparison reached a terminal manual-attention state, including bounded retry exhaustion and settled comparison job failures.

## Stored Fields

- `comparisonState`
- `comparisonBlockedReason`
- `comparisonRetryCount`
- `comparisonRetryMaxAttempts`
- `comparisonRetryTargetIssue`
- `comparisonTimedOutSides`
- `manualComparisonArtifact`

## Timeout Flow

1. An eval job times out.
2. Wavemill records the pair-level timeout on both tasks.
3. If `challenge.eval.retryMaxAttempts` has not been exhausted, the pair moves to `retrying_eval` and the timed-out eval is relaunched through the normal eval path.
4. If retries are exhausted, the pair moves to `manual_comparison_needed` and wavemill writes `ready/challenge-comparison-needed.md` under the primary task feature directory.

## Merge-Lane Expectations

- `retrying_eval` should remain an active, non-terminal wait.
- `manual_comparison_needed` is a `needs-user` condition. The pair should not look merge-ready until an operator resolves the comparison manually.
- Failed comparison jobs must not leave `comparison_running` behind after settlement. They transition the pair to `manual_comparison_needed` and preserve the failure in `comparisonBlockedReason`.
- Identical-routing pairs are a terminal skipped-comparison outcome, not a failed comparison job. The compare backstop records `comparisonOutcome=skipped`, `skipReason=identical-routing-dimensions`, and `cleanupPolicy=primary-wins-close-challenger`.
- Skipped identical pairs deterministically declare the primary as winner and the challenger as the cleanup target. This keeps the merge lane moving and prevents watchdog retry spam.
- `pair-unresolvable` is terminal once the resolver writes a forfeit or double-forfeit comparison record. Orphaned siblings can be resolved by the mill automatically or with `tools/resolve-orphan-challenge-pair.ts`.
- Post-review cleanup deletes remote `task/*` refs only after GitHub reports the PR as `MERGED`; stale merged leftovers can be audited with `tools/cleanup-stale-branches.ts`.

## Stage-Specific Score Selection (HOK-2373)

`compare-prs.ts` derives the comparison score from the stage that was actually varied, not the overall post-completion score.

### Selection rules

| challengeType | Preferred source | Fallback |
|---|---|---|
| `reviewer-only` | `metadata.stageScores.review.score`, then `stageOutcomes.review.score` | `record.score` |
| `planner-only` | `metadata.stageScores.plan.score`, then `stageOutcomes.plan.score` | `record.score` |
| `coder-only` | `metadata.stageScores.implementation.score`, then `stageOutcomes.implementation.score` | `record.score` |
| `multi-variable` / `full-stack` / unknown | `record.score` (overall) | — |

`metadata.stageScores` takes precedence over `stageOutcomes` for backward compatibility with older records that were backfilled into metadata rather than stageOutcomes.

### Fallback behavior

When the preferred stage score is missing, null, or non-finite:
- The comparison falls back to `record.score` (overall).
- A data-quality warning is logged to stderr.
- The warning is also persisted on the comparison record in `dataQualityWarnings`.

### Persisted score-source metadata

`ChallengeComparison` records now include:
- `primaryEvalScoreSource` — source string, e.g. `"stage.review"`, `"stage.plan"`, `"stage.implementation"`, `"overall"`.
- `challengerEvalScoreSource` — same for challenger.
- `dataQualityWarnings` — array of warning strings when stage score was unavailable (absent when no warnings).

### Prompt labeling

The comparison prompt names the score source explicitly:
- `"Primary review-stage eval score"` when source is `stage.review`
- `"Primary plan-stage eval score"` when source is `stage.plan`
- `"Primary implementation-stage eval score"` when source is `stage.implementation`
- `"Primary eval score (overall)"` when source is overall or unknown

For `multi-variable` and `full-stack` challenges, per-stage scores (when available) are included in the Workflow Context section of the prompt so the judge has full visibility without changing the headline score semantics.

### Key files

- `shared/lib/challenge-score-selector.ts` — pure selector and label helpers
- `shared/lib/challenge-comparison.ts` — `ChallengeComparison` type (new source fields)
- `shared/lib/pr-comparison.ts` — `buildComparisonPrompt` (source-aware labels)
- `tools/compare-prs.ts` — orchestrates classification before score selection

## Coder-override Contract (HOK-2272)

The coding-phase handoff in `shared/lib/wavemill-mill.sh` resolves the coder from `.phase-config.json.coding.model` (or `coderModel` in task state) and only substitutes `challengeModel` when the persisted `challengeStage` is `implementation`. Plan-stage and review-stage challenges keep the route's coder; their `challengeModel` names the varied stage's model, not the coder. Missing/unparseable `challengeStage` for a challenge task fails safe to the phase-config coder with a warning log.

## Native Certification Guardrails (HOK-2398)

Challenge mode applies the same native-certification policy as the router. A native model is excluded from a challenge pair when its on-disk certification artifact is missing, stale, malformed, wrong-suite, or does not satisfy the phase required for the slot it would occupy.

### Stage → role → required phase mapping

| Challenge stage | Router role | Required cert phase |
|---|---|---|
| `plan` | `planner` | `workflow` |
| `implementation` | `coder` | `patch` |
| `review` | `reviewer` | `read-only` |

This mapping is defined in `STAGE_TO_ROLE` inside `shared/lib/challenge-mode.ts` and is intentionally kept in lock-step with `STAGE_PHASE_REQUIREMENT` in `shared/lib/native-agent/certification/router-filter.ts`.

### Behavior on exhaustion

When certification filtering removes enough candidates that no valid divergent pair can be formed, the selection result returns `pair: null` with `failureReason: 'selection_failed'` (or `'insufficient_models'` if detected before selection). The orchestrator falls back to single-model launch; no crash occurs.

Skipped native models do **not** block the challenge roll; they are silently dropped from the candidate pool. Only when the pool is so depleted that no divergent pair remains does the whole challenge attempt fail.

### Where to find diagnostics

**JSON output** (`tools/resolve-challenge-task.ts`): When one or more native models are skipped, the decision JSON includes a `nativeCertificationRejections` array. Each entry has:
- `modelId` — the skipped model
- `role` — `planner`, `coder`, or `reviewer`
- `requestedPhase` — the phase that was required
- `certifiedPhase` — the phase found in the artifact (when readable)
- `reason` — `missing`, `malformed`, `wrong-suite`, `stale`, or `insufficient-phase`

**stderr**: For each skipped native model a human-readable line is emitted to stderr before the JSON decision:
```
Challenge skipped native model <id> for <stage> stage (phase=<phase>, reason=<reason>).
```

This mirrors the router's `reasoning` field so dashboard tooling has consistent parity between router-level and challenge-level native rejections.

## Invalid-challenge auto-resolution (HOK-2970)

When the challenge-pair resolver runs on `sibling-challenge-aborted` or `both-challenge-aborted`, it now cross-references the aborted arm(s)' latest eval record in `evals.jsonl`. If that record carries `invalidChallenge: true`, the pair is stamped as `comparisonOutcome: 'invalid_challenge'` (via `buildInvalidChallengeArmComparison`) with no `winner`/`winnerModel`, rather than a phantom `forfeit` handed to the surviving arm. `forkStage` and other retention fields are preserved.

Rules of the road:

- **New records use `invalid_challenge` directly.** Producers must never mint a `forfeit` row where the losing arm's eval was `invalidChallenge: true`.
- **`isDecisiveChallengeComparison` is a belt-and-braces guard.** Any row carrying `invalidChallenge: true` OR a `quarantined` marker is non-decisive regardless of `comparisonOutcome`. Legacy pre-fix rows on disk therefore stop counting even before the quarantine sweep runs.
- **Legacy rewrite tool:** `tools/quarantine-legacy-reviewer-forfeits.ts` sweeps historical `forfeit` rows whose aborted arm's latest eval was invalid and rewrites them to `invalid_challenge` with a `quarantined: {reason: 'aborted-arm-was-invalid', ticket: 'HOK-2970'}` marker. `--dry-run` prints the diff; `--apply` writes atomically after a `.bak.<ISO>` backup and is idempotent.
- **Reviewer-stage adjudicator:** `shared/lib/reviewer-stage-adjudicator.ts` is a thin façade over `foldAttestationsIntoStageAttribution` that fails closed to `insufficient_evidence` when the pair did not fork at `review` or lacks a shared implementation prefix. Delivery selection (`deliveryVerdict`) remains the generic arbiter's job; reviewer-stage adjudication is independent.

## Recent Changes

### 2026-09-18T00:00:00.000Z - HOK-2970: Reviewer-stage adjudication, delivery/stage split, legacy quarantine

Added `buildInvalidChallengeArmComparison`; tightened `isDecisiveChallengeComparison` to exclude any row where `invalidChallenge === true` or `quarantined` is present; wired invalid-arm detection into `challenge-pair-resolver.ts` for both `sibling-challenge-aborted` and `both-challenge-aborted`; added `shared/lib/reviewer-stage-adjudicator.ts` and `tools/quarantine-legacy-reviewer-forfeits.ts`. Extended `ResolveOutcome` union with `invalid_challenge`. Regression fixtures `tests/reviewer-stage-hok2939-shaped.test.sh` and `tests/reviewer-stage-hok2954-shaped.test.sh` cover CI-shard and startup-rehydration abort shapes respectively.

### 2026-08-23T00:00:00.000Z - HOK-2859: Provisional evidence holds

`buildEvalSummary()` now filters challenge coverage with the shared evidence policy before updating total/model/stage/model-stage counters. `computeAggregations()` filters joined challenge rows before any win-rate, role, stage-quality, variant, or cost aggregation when either side's eval evidence is held.

### 2026-07-11T00:00:00.000Z - HOK-2500: Coverage-aware challenge challenger selection at launch

`tools/resolve-challenge-task.ts` now builds the eval coverage grid at launch time and threads a per-stage coverage function into `shared/lib/challenge-mode.ts`. Challenge selection no longer falls back to random distinct challengers when coverage is available: it deterministically chooses the least-used eligible model for the varied stage, treats zero-record launch-priority OpenRouter/native cells as mandatory ahead of already-used incumbents, applies native-certification and OpenRouter eligibility filters before ranking, and persists `selectionReason` plus `challengerCoverageCount` on the pair and the launch JSON for auditability.
