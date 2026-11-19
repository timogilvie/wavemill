# Attempt Lineage Invariant (HOK-3476)

## Summary

Every launch mints explicit, joinable run and stage-attempt identity before execution begins. These identities propagate through all execution evidence (launch ownership, stage results, evaluation records) so downstream consumers can establish deterministic relationships from explicit identity alone, never relying on fragile timestamp or head-derived heuristics.

## Key Rules

1. **Lineage mints before execution** - Every launch creates concrete `runId` and `stageAttemptId` identifiers before any work begins.
2. **Identity propagates through ownership → stage-result → eval** - All execution evidence carries the same lineage identifiers, preserving relationships across all artifacts.
3. **Never fabricate relationships** - Legacy records without lineage identifiers must explicitly represent missing lineage as `undefined/null`, never inventing relationships from timestamps or commit hashes.
4. **One minting site** - `shared/lib/attempt-identity.ts` is the sole source of truth for lineage identifier generation.
5. **Canonical writers only** - Lineage fields may only flow through the established canonical writers (`recordLaunch`, `writeStageResult`, etc.), never through hand-written JSON blocks.

## Implementation Details

### Identity Fields

- `runId`: Task run identity in format `<issue>:<runEpoch>:<launchedAtEpochSeconds>` (preserved for backward compatibility)
- `stageAttemptId`: random UUID (v4) identifier for each stage attempt (new primary join key)
- `parentRunId`: Parent run identity for retries
- `retryOf`: Previous attempt this replaces

### Data Flow

1. **Launch**: `mintRunId()` + `mintStageAttemptId()` create identifiers, passed to `recordLaunch()`
2. **Ownership**: `session-ownership.ts` stores lineage in `.session-ownership.jsonl`
3. **Stage Results**: `stage-result.ts` resolves missing lineage by reading latest launch row via `resolveLineageForStageResult()`
4. **Evaluation**: `eval-record-builder.ts`'s `attachAttemptLineage()` is wired into `enrichTrainingMetadata`, the canonical enrichment flow, using the same null-safe attachment pattern as the other eval fields.

## Enforcement

This invariant is enforced by:
- `tools/check-executed-model-resolver.ts` - rejects a hand-written `runId:`/`stageAttemptId:`/`parentRunId:`/`retryOf:` literal in TypeScript outside the canonical writers
- `tools/check-session-ownership.ts` does not yet reject a bypassed lineage write in a jsonl-append call (plan Phase 5 follow-up; not implemented in this change)

## Known gap: SDK `run_id` conformance

`shared/lib/sdk-task-cost/contract.ts` re-exports the shipped `@hokusai/core`
`task_attempt/v1` validators (`validateTaskAttemptRef`,
`validateTaskAttemptLogEntryV1`) and `attempt-identity.ts` exposes
`taskAttemptRefConforms()`, which calls the real SDK validator (never
fabricating a pass) and is exercised by `attempt-identity.test.ts`.

Every ref it checks fails today, including a freshly minted one: the SDK
contract requires `run_id` to be a minted UUID or ULID, "never derived
from... a timestamp" (`@hokusai/core`'s own `attempt.ts` doc comment,
enforced by `requireMintedId`/`MINTED_ID_PATTERN` in `validators.ts`), while
Wavemill's `mintRunId()` (HOK-3373) is the deterministic
`<issue>:<runEpoch>:<launchedAtEpochSeconds>` string, by design, so the shell
twin (`attempt-identity.sh`) produces byte-identical ids and so
`runIdIssue()`/`runIdStartedAt()` can parse it.

This is a genuine format mismatch between the pre-existing run-identity
primitive this task reuses (HOK-3373, "Propagate; do not replace lifecycle
policy" per the task's primitive-reuse table) and the SDK contract it wires
through — not a wiring bug fixable by calling the validator in another
place. `stage_attempt_id` (`mintStageAttemptId()`, a real UUID v4) already
satisfies the SDK's minted-id check on its own. Closing the `run_id` gap
means deciding whether to re-mint a UUID/ULID alongside the existing
deterministic `runId` (additive) or to change `mintRunId`'s format outright
(a breaking change to the shell twin and every reader of `runIdIssue`/
`runIdStartedAt`) — both out of scope for HOK-3476, which propagates
identity rather than rewriting it. Track as a follow-up before any consumer
is allowed to assert that a Wavemill `run_id` is SDK-conformant.

## Related Files

- `shared/lib/attempt-identity.ts` - identity generation
- `shared/lib/session-ownership.ts` - launch row storage
- `shared/lib/stage-result.ts` - stage result lineage resolution
- `shared/lib/eval-record-builder.ts` - evaluation record attachment