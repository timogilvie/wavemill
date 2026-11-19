/**
 * attempt-identity — the one run identity of a task row (HOK-3373).
 *
 * Every launch of an issue mints a `runId` and stamps it on the task row it
 * allocates (`save_task_state` in launch mode). The id never changes for the
 * life of that row. A relaunch of an issue whose last run settled mints a new
 * one and starts a fresh row; it never merges into, or re-adopts the PR of,
 * the settled row (HOK-3369 / HOK-2595).
 *
 * Format: `<issue>:<runEpoch>:<launchedAtEpochSeconds>`. Deterministic from
 * its inputs so the shell twin (`attempt-identity.sh`
 * `attempt_identity_mint_run_id`) produces byte-identical ids; the pair is
 * pinned by `tests/attempt-identity.test.sh`.
 *
 * Session-ownership `attemptId`s (`<kind>@<head7>#<epoch>`) identify one
 * stage launch inside a run and are orthogonal to this id.
 *
 * @module attempt-identity
 */

import { randomUUID } from 'crypto';
import { validateTaskAttemptRef } from './sdk-task-cost/contract.ts';
import type { TaskAttemptRef } from './sdk-task-cost/contract.ts';

/** Inputs of {@link mintRunId}. */
export interface MintRunIdArgs {
  /** The `.tasks` key (challenger keys included). */
  issue: string;
  /** `WAVEMILL_RUN_EPOCH` of the launching mill session; `''` when unset. */
  runEpoch: string;
  /** Launch time. Only whole seconds are used, so the shell twin can match. */
  launchedAt: Date;
}

/** Mint the run id for one launch of `issue`. */
export function mintRunId(args: MintRunIdArgs): string {
  if (!args.issue) throw new Error('mintRunId: issue is required');
  const seconds = Math.floor(args.launchedAt.getTime() / 1000);
  if (!Number.isFinite(seconds)) throw new Error('mintRunId: launchedAt is not a valid date');
  return `${args.issue}:${args.runEpoch ?? ''}:${seconds}`;
}

/** Mint a stage attempt id (random UUID v4) for one launch. */
export function mintStageAttemptId(): string {
  return randomUUID();
}

/** The minimal shape {@link projectTaskAttemptRef} reads from an ownership row. */
export interface ProjectableOwnershipRow {
  issue: string;
  runId?: string;
  stageAttemptId?: string;
}

/**
 * {@link TaskAttemptRef}'s fields, but `run_id` may be absent — a row minted
 * before HOK-3373 has none. Never asserted to actually satisfy the SDK
 * contract; call {@link taskAttemptRefConforms} to check that separately.
 */
export type ProjectedTaskAttemptRef = Omit<TaskAttemptRef, 'run_id'> & { run_id?: string };

/**
 * Project a TaskAttemptRef shape from an ownership row.
 *
 * Returns undefined run_id for legacy rows with no runId field.
 * The stage_attempt_id is always present for new rows.
 */
export function projectTaskAttemptRef(ownershipRow: ProjectableOwnershipRow): ProjectedTaskAttemptRef {
  return {
    task_id: ownershipRow.issue,
    run_id: ownershipRow.runId,
    stage_attempt_id: ownershipRow.stageAttemptId
  };
}

/**
 * Whether a projected ref satisfies the SDK `task_attempt/v1` `TaskAttemptRef`
 * contract (HOK-3476), using the SDK's own `validateTaskAttemptRef`. Never
 * throws, so a caller can record Wavemill's own lineage either way and
 * decide separately whether to surface it as SDK-conformant.
 *
 * Wavemill's `runId` ({@link mintRunId}) is deterministic —
 * `<issue>:<runEpoch>:<launchSeconds>` — for shell-twin byte parity and
 * timestamp parsing ({@link runIdIssue}, {@link runIdStartedAt}). The SDK's
 * `run_id` must be a minted UUID/ULID, "never derived from... a timestamp"
 * (`@hokusai/core`). Every ref projected from today's `mintRunId` therefore
 * fails this check — a documented gap (`docs/invariants/attempt-lineage.md`),
 * not a caller bug. Closing it means revisiting the minted format, which is
 * out of scope for HOK-3476 (it propagates identity, it does not rewrite it).
 */
export function taskAttemptRefConforms(ref: ProjectedTaskAttemptRef): ref is TaskAttemptRef {
  try {
    validateTaskAttemptRef(ref);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strict run-id equality. A missing id (legacy row written before HOK-3373)
 * matches nothing, including another missing id, so a caller can never treat
 * "both unknown" as "same run".
 */
export function isSameRunId(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === 'string' && a.length > 0 && a === b;
}

/** The issue a run id was minted for, or `null` for a malformed id. */
export function runIdIssue(runId: string | null | undefined): string | null {
  if (typeof runId !== 'string') return null;
  const parts = runId.split(':');
  if (parts.length < 3 || !parts[0]) return null;
  return parts.slice(0, parts.length - 2).join(':');
}

/** Launch boundary of a canonical run id; legacy/malformed ids are unknown. */
export function runIdStartedAt(runId: string | null | undefined): number | null {
  if (!runIdIssue(runId)) return null;
  const seconds = Number(runId!.split(':').at(-1));
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds * 1000 : null;
}
