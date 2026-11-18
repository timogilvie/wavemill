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
4. **Evaluation**: `eval-record-builder.ts` carries an `attachAttemptLineage()` helper for the same null-safe attachment pattern as the other eval fields; no caller wires it into the eval pipeline yet (follow-up).

## Enforcement

This invariant is enforced by:
- `tools/check-session-ownership.ts` - prevents bypass writing of lineage fields
- `tools/check-executed-model-resolver.ts` - prevents hand-written lineage construction
- Guards ensure lineage fields only flow through canonical writers

## Related Files

- `shared/lib/attempt-identity.ts` - identity generation
- `shared/lib/session-ownership.ts` - launch row storage
- `shared/lib/stage-result.ts` - stage result lineage resolution
- `shared/lib/eval-record-builder.ts` - evaluation record attachment