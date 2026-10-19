/**
 * The one shape of `.wavemill/workflow-state.json` (HOK-3220).
 *
 * Before this module about 22 files each declared their own task-record
 * shape (`interface TaskState`, `{ tasks?: Record<string, unknown> }`,
 * `JSON.parse(...) as {...}`). Those shapes compiled whatever field names the
 * author guessed, which is how HOK-3181 shipped a merge-label reconciler that
 * read `prNumber` / `headSha` from task records that never carry them (fixed
 * in HOK-3212). Every TypeScript reader and writer now takes its types from
 * here.
 *
 * Rules:
 *
 * - **Writer-derived.** {@link TaskRecord} and
 *   `shared/schemas/workflow-task.schema.json` list exactly the fields that
 *   some writer sets (`save_task_state`, `state_mutate` /
 *   `task_state_mutate_existing` sites that set `.tasks[$id].*`, and the
 *   `mutateJsonState` callers). `workflow-state.writer-coverage.test.ts`
 *   fails when the schema names a field no writer sets, so a reader can never
 *   "fix" a type error by adding the name it wished existed.
 * - **Reader-only names are absent on purpose**: `prNumber`, `headSha`,
 *   `prHeadSha`, `pullRequest`. The PR is `.pr`; PR head evidence lives in
 *   `.lifecycle.deliveryEvidence`.
 * - **No index signature on {@link TaskRecord}.** `task.prNumber` is a
 *   compile error, which is the point. It is a `type` alias rather than an
 *   `interface` so a record still passes where `Record<string, unknown>` is
 *   expected.
 * - **Permissive on the wire.** The schema keeps `additionalProperties: true`
 *   so an in-flight writer that adds a field is never rejected and a reader
 *   never crashes on one; tightening is a later, separate ratchet.
 * - **Reads never throw** (the `stage-result.ts` rule). A missing or
 *   unparseable file reads as `null`; a schema violation is reported and the
 *   parsed value is still returned, so one bad write cannot wedge every
 *   reader.
 * - **Writes are validated too** (`mutateWorkflowState`): task records the
 *   transform changed are checked against the schema after the transform.
 *
 * The `tools/check-task-record-shape.ts` preflight guard forbids any other
 * file from declaring a `tasks?: Record<...>` / `WorkflowState` shape.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mutateJsonState, type MutateJsonStateOptions } from './state-mutex.ts';
import type { MillJob } from './job-tracker.ts';
import type { TaskLifecycleState } from './task-lifecycle.ts';
import {
  compileSchemaValidator,
  DEFAULT_REPO_ROOT,
  loadPrecompiledValidator,
  PRECOMPILED_SCHEMAS,
  readRefSchemas,
  schemaSourceText,
  type SchemaValidatorFunction,
  type ValidationErrorLike,
} from './schema-validators.ts';

/** Repo-relative path of the canonical schema. */
export const WORKFLOW_STATE_SCHEMA_PATH = 'shared/schemas/workflow-task.schema.json';

/**
 * Names readers have reached for that no writer sets (HOK-3181 / HOK-3212).
 * The schema must never declare them as task-record properties.
 */
export const FORBIDDEN_TASK_RECORD_FIELDS = ['prNumber', 'headSha', 'prHeadSha', 'pullRequest'] as const;

type JsonObject = Record<string, unknown>;

/**
 * One task row under `.tasks[<task id>]`. Mirrors the schema's
 * `$defs.TaskRecord` one-for-one; every field is optional because several
 * writers (`set_task_phase_local`, startup seeding, `set_task_queue_owned`)
 * create partial rows before `save_task_state` runs.
 */
export type TaskRecord = {
  // save_task_state core
  slug?: string;
  branch?: string;
  worktree?: string;
  /** Shell writers store a string; `''` means no PR yet. */
  pr?: string | number;
  status?: string;
  phase?: string;
  agent?: string;
  linearIssueId?: string;
  updated?: string;
  traceId?: string;
  windowId?: string;
  /** Validated against `task-lifecycle-state.schema.json`; legacy rows may be partial. */
  lifecycle?: Partial<TaskLifecycleState>;

  // routing
  plannerModel?: string;
  coderModel?: string;
  reviewerModel?: string;
  planDepth?: string;
  codeDepth?: string;
  reviewMode?: string;
  model?: string;
  provider?: string;
  stageRole?: string;

  // challenge pair
  challenge?: boolean;
  challengePairId?: string;
  /** `primary` | `challenger`; legacy rows may carry `''`. */
  challengeRole?: string;
  challengeModel?: string;
  challengeStage?: string;
  challengeVariedModel?: string;
  challengeVariedAgent?: string;
  challengeExecutionIntent?: JsonObject;
  challengeArms?: JsonObject[];
  challengerLaunched?: boolean;
  challengeAborted?: string;
  challengeAbortedDetail?: string;
  challengeAbortedStage?: string | null;
  challengeAbortedNextAction?: string;
  challengeCollapseReason?: string;
  challengeCollapseDetail?: string;
  challengeRouteDriftDetail?: string;
  challengeDivergenceReason?: string;
  challengeCompared?: boolean;
  challengeComparedSource?: string;
  challengeRepairAction?: string;
  invalidChallengeReason?: string;
  invalidChallengeDetails?: string;

  // comparison (`null` values are legacy rows from before clear-by-del())
  comparisonState?: string | null;
  comparisonRunning?: JsonObject | null;
  comparisonRetryCount?: number | null;
  comparisonRetryMaxAttempts?: number | null;
  comparisonRetryTargetIssue?: string | null;
  comparisonBlockedReason?: string | null;
  comparisonTimedOutSides?: string[] | null;
  comparisonLaunchEvidence?: string;
  comparisonPairingRepaired?: boolean;
  manualComparisonArtifact?: string | null;

  // eval
  evalRunning?: JsonObject | null;
  evalCompleted?: boolean;
  evalFailed?: boolean;
  evalHardFailureRetryCount?: number;

  // ownership / pane (HOK-3102)
  executionOwner?: 'task' | 'queue' | 'reconciliation';
  paneState?: 'active' | 'rehydrating' | 'released';
  paneReleased?: boolean;
  paneReleasedAt?: string;
  queueHandoffAt?: number;
  capsuleDigest?: string;
  terminalRecordWritten?: boolean;

  // attempts / reconciliation
  attempt?: JsonObject | null;
  prReconciliation?: JsonObject | null;
  rehydration?: JsonObject;
  dependsOnPr?: JsonObject;

  // failures / stops
  launchFailure?: JsonObject | null;
  retryFailure?: string;
  retryFailureDetail?: string;
  stopReason?: string;
  stopSubReason?: string;
  stopDetail?: string;
  statusClearedBy?: JsonObject;

  // terminal
  abortedReason?: string;
  abortedAt?: string;
  abortedCleanupReason?: string;
  abortedCleanupAt?: string;
  supersededReason?: string;
  supersededAt?: string;
};

/** The whole state file. Top-level keys beyond these belong to their owners. */
export type WorkflowState = {
  session?: string;
  started?: string;
  updated?: string;
  tasks?: Record<string, TaskRecord>;
  /** Owned by `job-tracker.ts`; legacy files store an array (see `normalizeJobs`). */
  jobs?: Record<string, MillJob> | MillJob[];
  /** Owned by `terminal-inbox-cleanup.ts` / the terminal reconciler. */
  terminalTaskHistory?: JsonObject;
  /** Owned by `terminal-inbox-cleanup.ts`. */
  terminalTaskTombstones?: JsonObject;
  [key: string]: unknown;
};

/** A task record paired with its `.tasks` key. */
export type KeyedTaskRecord = TaskRecord & { issue: string };

export interface WorkflowStateIssue {
  /** JSON pointer into the state file (`/tasks/HOK-1/pr`). */
  path: string;
  message: string;
}

export interface WorkflowStateValidation {
  valid: boolean;
  issues: WorkflowStateIssue[];
}

export interface ReadWorkflowStateOptions {
  /**
   * Called with schema violations. Defaults to one stderr line per state
   * file per process, so a hot reader never floods logs.
   */
  onInvalid?: (statePath: string, issues: WorkflowStateIssue[]) => void;
}

let cachedValidator: SchemaValidatorFunction | null = null;

/**
 * The schema validator: the committed standalone artifact when it matches the
 * schema bytes (the hot path, no Ajv load), else a runtime compile.
 */
function validator(): SchemaValidatorFunction {
  if (cachedValidator) return cachedValidator;
  const spec = PRECOMPILED_SCHEMAS.find((entry) => entry.name === 'workflow-state');
  if (!spec) throw new Error('workflow-state is missing from PRECOMPILED_SCHEMAS');
  cachedValidator =
    loadPrecompiledValidator(spec.name, schemaSourceText(spec), spec.ajvOptions, spec.ajvModule) ??
    compileSchemaValidator(
      JSON.parse(readFileSync(join(DEFAULT_REPO_ROOT, spec.schemaPath), 'utf-8')),
      spec.ajvOptions,
      spec.ajvModule,
      readRefSchemas(spec),
    );
  return cachedValidator;
}

function toIssues(errors: ValidationErrorLike[] | null | undefined): WorkflowStateIssue[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath || '/',
    message: error.message ?? error.keyword,
  }));
}

/** Validate a parsed state value against `workflow-task.schema.json`. */
export function validateWorkflowState(value: unknown): WorkflowStateValidation {
  const validate = validator();
  const valid = validate(value);
  return { valid, issues: valid ? [] : toIssues(validate.errors) };
}

/** Validate one task record (as it would sit under `.tasks[issue]`). */
export function validateTaskRecord(issue: string, record: unknown): WorkflowStateValidation {
  return validateWorkflowState({ tasks: { [issue]: record } });
}

const reportedStatePaths = new Set<string>();

function defaultOnInvalid(statePath: string, issues: WorkflowStateIssue[]): void {
  if (reportedStatePaths.has(statePath)) return;
  reportedStatePaths.add(statePath);
  const shown = issues.slice(0, 5).map((issue) => `${issue.path} ${issue.message}`).join('; ');
  const more = issues.length > 5 ? ` (+${issues.length - 5} more)` : '';
  process.stderr.write(`workflow-state: schema violations in ${statePath}: ${shown}${more}\n`);
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read and validate `workflow-state.json`.
 *
 * Returns `null` when the file is missing, unreadable, unparseable, or not a
 * JSON object. A schema violation is reported through `onInvalid` and the
 * parsed value is still returned. Never throws.
 */
export function readWorkflowState(statePath: string, options: ReadWorkflowStateOptions = {}): WorkflowState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  try {
    const { valid, issues } = validateWorkflowState(parsed);
    if (!valid) (options.onInvalid ?? defaultOnInvalid)(statePath, issues);
  } catch {
    // A broken schema is a preflight failure (check-schema-validators.ts),
    // never a reason for a runtime reader to lose the state.
  }
  return parsed as WorkflowState;
}

/** Tasks of a state file as `[issue, record]` pairs; `[]` when absent. */
export function workflowTaskEntries(state: WorkflowState | null | undefined): Array<[string, TaskRecord]> {
  const tasks = state?.tasks;
  if (!isObject(tasks)) return [];
  return Object.entries(tasks).filter((entry): entry is [string, TaskRecord] => isObject(entry[1]));
}

export interface MutateWorkflowStateOptions extends MutateJsonStateOptions<WorkflowState> {
  /** Called with schema violations in task records this mutation changed. */
  onInvalid?: (statePath: string, issues: WorkflowStateIssue[]) => void;
}

function taskSnapshot(state: WorkflowState | null | undefined): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const [issue, record] of workflowTaskEntries(state)) snapshot.set(issue, JSON.stringify(record));
  return snapshot;
}

/**
 * `mutateJsonState` for `workflow-state.json`, typed and validated on write.
 *
 * Task records that the transform added or changed are validated after the
 * transform runs. Violations are reported (stderr by default), never thrown:
 * rejecting the write would strand the lock holder's intent (an abort, a
 * supersede) behind an unrelated pre-existing bad field in the same row.
 */
export async function mutateWorkflowState(
  statePath: string,
  transform: (current: WorkflowState) => WorkflowState,
  options: MutateWorkflowStateOptions = {},
): Promise<WorkflowState> {
  const { onInvalid, ...mutateOptions } = options;
  return mutateJsonState<WorkflowState>(statePath, (current) => {
    const before = taskSnapshot(current);
    const next = transform(current);
    const issues: WorkflowStateIssue[] = [];
    for (const [issue, record] of workflowTaskEntries(next)) {
      if (before.get(issue) === JSON.stringify(record)) continue;
      try {
        issues.push(...validateTaskRecord(issue, record).issues);
      } catch {
        // See readWorkflowState: a broken schema never blocks a writer.
      }
    }
    if (issues.length > 0) {
      (onInvalid ?? ((path, found) => {
        const shown = found.slice(0, 5).map((issue) => `${issue.path} ${issue.message}`).join('; ');
        process.stderr.write(`workflow-state: write produced schema violations in ${path}: ${shown}\n`);
      }))(statePath, issues);
    }
    return next;
  }, mutateOptions);
}
