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
