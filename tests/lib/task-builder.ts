/**
 * Schema-validated workflow-state fixtures for tests (HOK-3223).
 *
 * Tests used to hand-write `tasks: { ... }` literals, which compile whatever
 * field names the author guessed — the HOK-3212 "real-state" test passed
 * against a shape no writer produces. These builders accept only the keys that
 * `shared/schemas/workflow-task.schema.json` `$defs.TaskRecord` declares (the
 * writer-derived shape, HOK-3220) and run the result through the same Ajv
 * validator production readers use, so a fixture can only seed what a writer
 * writes. `tools/check-test-task-literals.ts` forbids new hand-written
 * literals; the shell twin is `tests/lib/state-fixtures.sh` (`fixture_task`),
 * which goes through this module via `tests/lib/bin/build-fixture-task.ts`.
 *
 * @example
 * const state = buildWorkflowState({
 *   'HOK-1': { pr: '12', phase: 'ready', worktree },
 *   'HOK-1_c': { phase: 'review', challengeRole: 'challenger' },
 * });
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FORBIDDEN_TASK_RECORD_FIELDS,
  validateWorkflowState,
  WORKFLOW_STATE_SCHEMA_PATH,
  type TaskRecord,
  type WorkflowState,
  type WorkflowStateIssue,
} from '../../shared/lib/workflow-state.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface SchemaProperty {
  type?: string | string[];
  $ref?: string;
}

/**
 * `$defs.TaskRecord.properties` of the canonical schema. Read from the schema
 * (not a hand-kept list) so a field added there is accepted here at once.
 */
export const TASK_RECORD_SCHEMA_PROPERTIES: Readonly<Record<string, SchemaProperty>> = (() => {
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, WORKFLOW_STATE_SCHEMA_PATH), 'utf-8'));
  const properties = schema?.$defs?.TaskRecord?.properties;
  if (!properties || typeof properties !== 'object') {
    throw new Error(`task-builder: ${WORKFLOW_STATE_SCHEMA_PATH} has no $defs.TaskRecord.properties`);
  }
  return properties as Record<string, SchemaProperty>;
})();

const KNOWN_TASK_KEYS = new Set(Object.keys(TASK_RECORD_SCHEMA_PROPERTIES));

/**
 * The row `save_task_state` always writes, minus run-specific values: a task
 * that was just saved and is planning. Override any field; pass `undefined`
 * to drop one, or `{ bare: true }` to start from an empty row.
 */
export const DEFAULT_TASK: Readonly<TaskRecord> = Object.freeze({
  slug: '',
  branch: '',
  worktree: '',
  pr: '',
  status: 'active',
  phase: 'planning',
});

export interface BuildTaskOptions {
  /**
   * Skip {@link DEFAULT_TASK}: the row holds exactly the overrides. Use for
   * partial rows that writers really produce (`set_task_phase_local`,
   * startup seeding) and for orphan stubs (HOK-3125).
   */
  bare?: boolean;
}

export interface BuildWorkflowStateOptions extends BuildTaskOptions {
  /** Top-level keys other than `tasks` (`session`, `jobs`, `terminalTaskHistory`, ...). */
  topLevel?: Omit<WorkflowState, 'tasks'>;
}

/** Thrown when a fixture would not match what the writers produce. */
export class TaskFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskFixtureError';
  }
}

function formatIssues(issues: WorkflowStateIssue[]): string {
  return issues.map((issue) => `${issue.path} ${issue.message}`).join('; ');
}

function assertKnownKeys(overrides: object, label: string): void {
  for (const key of Object.keys(overrides)) {
    if (KNOWN_TASK_KEYS.has(key)) continue;
    const forbidden = (FORBIDDEN_TASK_RECORD_FIELDS as readonly string[]).includes(key);
    throw new TaskFixtureError(
      `${label}: unknown task field "${key}". ` +
      (forbidden
        ? 'No writer sets it (HOK-3181/HOK-3212): the PR is `pr`; PR head evidence lives in `lifecycle.deliveryEvidence`.'
        : `Task fields are declared in ${WORKFLOW_STATE_SCHEMA_PATH} $defs.TaskRecord.properties. ` +
          'If a writer really sets this field, add it to the schema + TaskRecord first (HOK-3220).'),
    );
  }
}

/**
 * One schema-valid task row: {@link DEFAULT_TASK} (unless `bare`) merged with
 * `overrides`. Keys whose value is `undefined` are dropped from the result.
 *
 * @throws TaskFixtureError on an override key the schema does not declare, or
 *   when the merged row violates the schema (wrong type, bad lifecycle, ...).
 */
export function buildTask(overrides: TaskRecord = {}, options: BuildTaskOptions = {}): TaskRecord {
  assertKnownKeys(overrides, 'buildTask');
  const merged: Record<string, unknown> = { ...(options.bare ? {} : DEFAULT_TASK), ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[key];
  }
  const { valid, issues } = validateWorkflowState({ tasks: { __fixture__: merged } });
  if (!valid) {
    throw new TaskFixtureError(`buildTask: schema violations: ${formatIssues(issues).replaceAll('/tasks/__fixture__', '')}`);
  }
  return merged as TaskRecord;
}

/**
 * A schema-valid workflow state whose `.tasks` holds one {@link buildTask} row
 * per entry. `options.bare` applies to every row; build mixed rows with
 * separate `buildTask` calls when a test needs both.
 *
 * @throws TaskFixtureError as {@link buildTask} does (the message names the
 *   task id), or when `topLevel` violates the schema.
 */
export function buildWorkflowState(
  tasks: Record<string, TaskRecord> = {},
  options: BuildWorkflowStateOptions = {},
): WorkflowState {
  const built: Record<string, TaskRecord> = {};
  for (const [id, overrides] of Object.entries(tasks)) {
    try {
      built[id] = buildTask(overrides, options);
    } catch (error) {
      if (!(error instanceof TaskFixtureError)) throw error;
      throw new TaskFixtureError(`buildWorkflowState: task ${id}: ${error.message.replace(/^buildTask: /, '')}`);
    }
  }
  const state: WorkflowState = { ...options.topLevel, tasks: built };
  const { valid, issues } = validateWorkflowState(state);
  if (!valid) throw new TaskFixtureError(`buildWorkflowState: schema violations: ${formatIssues(issues)}`);
  return state;
}
