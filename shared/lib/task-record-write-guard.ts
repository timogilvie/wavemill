/**
 * task-record-write-guard — the one write-time check of task records in
 * `workflow-state.json` (HOK-3222).
 *
 * Every write to `workflow-state.json` goes through one of two seams, and both
 * call into this module:
 *
 * - TypeScript: `mutateJsonState` / `mutateJsonStateSync` (`state-mutex.ts`),
 *   which `mutateWorkflowState` wraps. A caller that writes the state file
 *   through `mutateJsonState` directly is covered identically.
 * - Shell: `state_mutate` (`wavemill-common.sh`, and so
 *   `task_state_mutate_existing` / `save_task_state`) runs
 *   `tools/validate-task-record-write.ts` on the jq output before the atomic
 *   rename, through Node type stripping (never `tsx`; HOK-3206 hot path).
 *
 * Validation reuses the HOK-3220 precompiled schema validator
 * (`workflow-state.ts` `changedTaskRecordIssues`); there is no second schema.
 * Only task records the write added or changed are checked.
 *
 * **Phase 1 (shadow, current):** a violation never refuses the write. It is
 * appended to `<state dir>/state-schema-violations.jsonl` (one line per
 * violation), reported to stderr (or the caller's `onInvalid`), and forwarded
 * as an observer finding the first time the shadow log sees its signature.
 * `WAVEMILL_TASK_RECORD_WRITE_VALIDATE_SHADOW=0` is the operator kill switch
 * (skip validation entirely). **Phase 2** (after a 7-day soak with no
 * violations) deletes the flag and the shadow log and refuses the write.
 *
 * @module task-record-write-guard
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { appendObserverFinding } from './observer-findings.ts';
import {
  changedTaskRecordIssues,
  taskRecordSnapshot,
  type TaskRecordWriteIssue,
  type WorkflowStateIssue,
} from './workflow-state.ts';

/** Basename of the one state file this guard applies to. */
export const WORKFLOW_STATE_BASENAME = 'workflow-state.json';

/** Basename of the Phase 1 shadow log, written next to the state file. */
export const STATE_SCHEMA_VIOLATIONS_BASENAME = 'state-schema-violations.jsonl';

/** Which seam produced the write. */
export type TaskRecordWriter = 'ts' | 'shell';

/** One `state-schema-violations.jsonl` line. */
export interface StateSchemaViolationRecord {
  at: string;
  writer: TaskRecordWriter;
  statePath: string;
  issue: string;
  path: string;
  message: string;
  signature: string;
  mode: 'shadow';
}

export interface ReportTaskRecordWriteOptions {
  /** Replaces the default stderr line (the shadow log is still written). */
  onInvalid?: (statePath: string, issues: WorkflowStateIssue[]) => void;
  /** Injected clock for tests. */
  now?: () => Date;
}

/** True when `statePath` names `workflow-state.json`. */
export function isWorkflowStatePath(statePath: string): boolean {
  return basename(statePath) === WORKFLOW_STATE_BASENAME;
}

/**
 * Whether write validation runs at all. Phase 1 kill switch only; the
 * variable is read here and in `state_mutate`, nowhere else.
 */
export function taskRecordWriteValidationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WAVEMILL_TASK_RECORD_WRITE_VALIDATE_SHADOW !== '0';
}

/** Path of the shadow log for a given state file. */
export function stateSchemaViolationsPath(statePath: string): string {
  return join(dirname(statePath), STATE_SCHEMA_VIOLATIONS_BASENAME);
}

/**
 * Task-agnostic identity of a violation: the JSON pointer with the task key
 * replaced, plus the validator message. Two tasks with the same bad field
 * share a signature, so the observer sees the defect once, not once per task.
 */
export function violationSignature(violation: TaskRecordWriteIssue): string {
  const prefix = `/tasks/${violation.issue.replace(/~/g, '~0').replace(/\//g, '~1')}`;
  const field = violation.path.startsWith(prefix) ? violation.path.slice(prefix.length) || '/' : violation.path;
  return `/tasks/*${field === '/' ? '' : field} ${violation.message}`;
}

/** Signatures already recorded in the shadow log (`[]` when absent/unreadable). */
function loggedSignatures(logPath: string): Set<string> {
  const signatures = new Set<string>();
  if (!existsSync(logPath)) return signatures;
  try {
    for (const line of readFileSync(logPath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const signature = (JSON.parse(line) as Partial<StateSchemaViolationRecord>).signature;
        if (typeof signature === 'string') signatures.add(signature);
      } catch {
        // A torn line is skipped, never fatal.
      }
    }
  } catch {
    // Unreadable log: every signature counts as new (over-notify, never drop).
  }
  return signatures;
}

/**
 * Shadow-report violations a write introduced: one shadow-log line per
 * violation, one stderr line (or `onInvalid` call) per write, and one
 * observer finding per signature the shadow log has never recorded, so a
 * writer that repeats the same defect every tick (in-process or one shell
 * spawn per write) surfaces once. Best-effort: every sink swallows its own
 * failure, so reporting can never fail the write it describes.
 */
export function reportTaskRecordWriteViolations(
  statePath: string,
  writer: TaskRecordWriter,
  violations: TaskRecordWriteIssue[],
  opts: ReportTaskRecordWriteOptions = {},
): void {
  if (violations.length === 0) return;
  const at = (opts.now ?? (() => new Date()))().toISOString();
  const records: StateSchemaViolationRecord[] = violations.map((violation) => ({
    at,
    writer,
    statePath,
    issue: violation.issue,
    path: violation.path,
    message: violation.message,
    signature: violationSignature(violation),
    mode: 'shadow',
  }));

  const logPath = stateSchemaViolationsPath(statePath);
  const seen = loggedSignatures(logPath);
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    appendFileSync(
      logPath,
      records.map((record) => `${JSON.stringify(record)}\n`).join(''),
      'utf-8',
    );
  } catch {
    // Best-effort: the stderr line below still carries the violation.
  }

  try {
    if (opts.onInvalid) {
      opts.onInvalid(statePath, violations);
    } else {
      const shown = violations.slice(0, 5).map((v) => `${v.path} ${v.message}`).join('; ');
      const more = violations.length > 5 ? ` (+${violations.length - 5} more)` : '';
      process.stderr.write(`workflow-state: write produced schema violations in ${statePath}: ${shown}${more}\n`);
    }
  } catch {
    // A throwing callback must not fail the write in shadow mode.
  }

  // The state file lives in `<repo>/.wavemill/`; the observer keys on the repo.
  const repoDir = dirname(dirname(statePath));
  for (const record of records) {
    if (seen.has(record.signature)) continue;
    seen.add(record.signature);
    appendObserverFinding(repoDir, {
      subsystem: 'state-mutex',
      title: 'Task record schema violation on write',
      body: `A ${writer} write to ${statePath} produced \`${record.path}\` ${record.message} `
        + `(task ${record.issue}). Phase 1 (HOK-3222) logs and lets the write through; once enforced `
        + `this write would be refused. See ${STATE_SCHEMA_VIOLATIONS_BASENAME}.`,
      severity: 'medium',
      at,
      context: {
        subsystem: 'state-mutex',
        invariantId: 'task-record-write',
        signature: record.signature,
        taskId: record.issue,
        writer,
      },
    });
  }
}

/**
 * Prepare a write to `statePath`: when it is `workflow-state.json` and
 * validation is enabled, snapshot the task rows of `current` and return a
 * check to run on the transform result. Returns `null` (nothing to do)
 * otherwise. The snapshot must be taken before the transform runs, since
 * transforms may mutate `current` in place.
 */
export function prepareTaskRecordWriteCheck(
  statePath: string,
  current: unknown,
  writer: TaskRecordWriter,
  opts: ReportTaskRecordWriteOptions = {},
): ((next: unknown) => TaskRecordWriteIssue[]) | null {
  if (!isWorkflowStatePath(statePath) || !taskRecordWriteValidationEnabled()) return null;
  const before = taskRecordSnapshot(current);
  return (next) => {
    const violations = changedTaskRecordIssues(before, next);
    reportTaskRecordWriteViolations(statePath, writer, violations, opts);
    return violations;
  };
}

