/**
 * attempt-identity — the one run identity of a task row (HOK-3373), and
 * (HOK-3476) the one projector of Wavemill's legacy identity onto the SDK
 * `task_attempt/v1` contract (`@hokusai/core`, re-exported from
 * `sdk-task-cost/contract.ts`).
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
 * `task.runId` and ownership `attemptId` above are legacy *operational
 * labels* — deterministic, never SDK IDs. {@link projectRunAttempt} and
 * {@link projectStageAttempt} mint the SDK's own minted-UUID identity
 * (`TaskAttemptRecordV1`), carrying a legacy label in `legacy_ids` only to
 * join old records; they never derive an SDK id from a head, timestamp or
 * session, and never infer `retry_of` — a caller passes it only when it
 * already knows the specific failed/abandoned sibling being replaced. This is
 * the one place Wavemill builds a `TaskAttemptRecordV1` /
 * {@link TaskAttemptRef}; other modules call these functions rather than
 * constructing the shapes by hand (`tools/check-attempt-lineage.ts`).
 *
 * @module attempt-identity
 */
import { randomUUID } from 'node:crypto';
import {
  TASK_ATTEMPT_SCHEMA_VERSION,
  validateTaskAttemptLogEntryV1,
  validateTaskAttemptRef,
  type TaskAttemptKind,
  type TaskAttemptRecordV1,
  type TaskAttemptRef,
} from './sdk-task-cost/contract.ts';

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

/** Launch boundary of a canonical run id; legacy/malformed ids are unknown. */
export function runIdStartedAt(runId: string | null | undefined): number | null {
  if (!runIdIssue(runId)) return null;
  const seconds = Number(runId!.split(':').at(-1));
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

// ────────────────────────────────────────────────────────────────
// SDK task_attempt/v1 projection (HOK-3476)
// ────────────────────────────────────────────────────────────────

/** A fresh minted SDK entity id (UUID v4). Never derived from a head/timestamp/session. */
export function mintAttemptEntityId(): string {
  return randomUUID();
}

/** Inputs of {@link projectRunAttempt}. */
export interface ProjectRunAttemptInput {
  /** The Linear-issue-derived task id (primary or `<id>_c` challenger). */
  taskId: string;
  /**
   * Structural parent of the run: the task by default, or a challenge arm's
   * id when one has been minted for this run. Wavemill does not yet mint
   * pair/arm entities (HOK-3476 scopes `run`/`stage_attempt`), so callers
   * that have no arm id pass nothing and the run's parent is the task itself
   * — a value the SDK contract explicitly allows ("run: the task, or an arm
   * when the run is a challenge arm").
   */
  parentId?: string;
  /** The legacy `task.runId` label (`<issue>:<runEpoch>:<epochSeconds>`), carried for joins only. */
  legacyRunId?: string | null;
  /** A known failed/abandoned sibling run this one explicitly replaces. Never inferred. */
  retryOfRunId?: string;
  /** ISO-8601 UTC; defaults to now. */
  observedAt?: string;
}

/** One minted run attempt record, plus the {@link TaskAttemptRef} it establishes. */
export interface ProjectedAttempt {
  record: TaskAttemptRecordV1;
  ref: TaskAttemptRef;
}

function baseRecord(kind: TaskAttemptKind, input: {
  taskId: string;
  parentId: string;
  legacyId?: string | null;
  retryOf?: string;
  observedAt?: string;
  stage?: string;
}): TaskAttemptRecordV1 {
  const record: TaskAttemptRecordV1 = {
    schema_version: TASK_ATTEMPT_SCHEMA_VERSION,
    record_type: 'attempt',
    observed_at: input.observedAt ?? new Date().toISOString(),
    kind,
    id: mintAttemptEntityId(),
    task_id: input.taskId,
    parent_id: input.parentId,
    ...(input.stage ? { stage: input.stage } : {}),
    ...(input.retryOf ? { retry_of: input.retryOf } : {}),
    ...(input.legacyId ? { legacy_ids: [input.legacyId] } : {}),
  };
  validateTaskAttemptLogEntryV1(record);
  return record;
}

/**
 * Mint the SDK run attempt for one launch of a task (HOK-3476). Mint once, at
 * launch, alongside (never instead of) the legacy {@link mintRunId}; a
 * relaunch mints a new run exactly like a new `task.runId` does.
 */
export function projectRunAttempt(input: ProjectRunAttemptInput): ProjectedAttempt {
  if (!input.taskId) throw new Error('projectRunAttempt: taskId is required');
  const record = baseRecord('run', {
    taskId: input.taskId,
    parentId: input.parentId ?? input.taskId,
    legacyId: input.legacyRunId,
    retryOf: input.retryOfRunId,
    observedAt: input.observedAt,
  });
  const ref: TaskAttemptRef = { task_id: input.taskId, run_id: record.id };
  validateTaskAttemptRef(ref);
  return { record, ref };
}

/** Inputs of {@link projectStageAttempt}. */
export interface ProjectStageAttemptInput {
  taskId: string;
  /** The minted `run_id` (the `id` of the {@link projectRunAttempt} record it belongs to). */
  runId: string;
  /** Stage slug, e.g. `planning`, `coding`, `review`, or an `ExecutionStage` repair kind. */
  stage: string;
  /** The legacy ownership `attemptId` (`<kind>@<head7>#<epoch>`), carried for joins only. */
  legacyAttemptId?: string | null;
  /** A known failed/abandoned sibling stage attempt this one explicitly replaces. Never inferred. */
  retryOfStageAttemptId?: string;
  observedAt?: string;
}

/**
 * Mint the SDK stage attempt for one launch inside an already-minted run
 * (HOK-3476). Every stage/repair/helper launch that owns a session
 * (`session-ownership.ts`) mints one of these before the child starts; a
 * helper call that does a stage's work but is not itself the stage's launch
 * (per {@link stageLaunchForRow}, re-exported by `session-ownership.ts`) is
 * never minted a stage attempt of its own — it is evidence under the stage's.
 */
export function projectStageAttempt(input: ProjectStageAttemptInput): ProjectedAttempt {
  if (!input.taskId) throw new Error('projectStageAttempt: taskId is required');
  if (!input.runId) throw new Error('projectStageAttempt: runId is required');
  if (!input.stage) throw new Error('projectStageAttempt: stage is required');
  const record = baseRecord('stage_attempt', {
    taskId: input.taskId,
    parentId: input.runId,
    legacyId: input.legacyAttemptId,
    retryOf: input.retryOfStageAttemptId,
    observedAt: input.observedAt,
    stage: input.stage,
  });
  const ref: TaskAttemptRef = { task_id: input.taskId, run_id: input.runId, stage_attempt_id: record.id };
  validateTaskAttemptRef(ref);
  return { record, ref };
}

/**
 * Build and validate a {@link TaskAttemptRef} from already-minted ids (e.g. to
 * stamp a later evidence/control write against an attempt minted earlier).
 * Throws on a malformed ref — a bypass writer building this shape by hand
 * instead of going through {@link projectRunAttempt} /
 * {@link projectStageAttempt} is exactly what `tools/check-attempt-lineage.ts`
 * flags; this function is the one place that shape is still legitimately
 * assembled, from ids this module minted.
 */
export function taskAttemptRef(input: { taskId: string; runId: string; stageAttemptId?: string }): TaskAttemptRef {
  const ref: TaskAttemptRef = {
    task_id: input.taskId,
    run_id: input.runId,
    ...(input.stageAttemptId ? { stage_attempt_id: input.stageAttemptId } : {}),
  };
  validateTaskAttemptRef(ref);
  return ref;
}
