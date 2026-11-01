/**
 * task-settlement — the one answer to "is this attempt settled, and may
 * anything act on it?" (HOK-3373).
 *
 * Before this module the question had several writers that disagreed: the
 * mill's exit trap reset delivered work to Linear Backlog and deleted its
 * row, launches merged into (and re-adopted the PR of) settled rows, and
 * four lifecycle writers plus five abort writers each settled an arm by its
 * own rule (MQ-1.1 inventory rows D28/D29/D30).
 *
 * The rule now lives at the one task-record seam every `workflow-state.json`
 * write already passes through (`task-record-write-guard.ts`, called by
 * `mutateJsonState` / `mutateJsonStateSync` in TypeScript and by
 * `state_mutate` in shell via `tools/validate-task-record-write.ts`):
 *
 * - A task row is **settled** once `lifecycle.workflowOutcome` is `merged`,
 *   `closed` or `aborted`. `error` is not settled: it is recoverable and the
 *   normal recovery paths relaunch it. Settlement is independent of
 *   `resourceDisposition` (cleanup) and of telemetry: delivered work can
 *   still be archiving, evaluating or comparing.
 * - Fields are partitioned into **control** (outcome, phase/status, PR and
 *   worktree identity, run identity, abort / stop / launch-failure markers),
 *   **cleanup** (resource disposition, pane, queue handoff) and **evidence**
 *   (executed model, cost, review / comparison / eval results, routing
 *   facts). See {@link classifyTaskField}.
 * - A **control write against a settled row** is rejected unless it is
 *   consistent with the settlement (a terminal row stays terminal, abort
 *   markers only on an aborted/closed row, a PR is only backfilled, never
 *   replaced). The outcome itself settles once.
 * - A **control write against a non-current run** (the caller names the
 *   run it acted for through `expectedRunIds`, and the row now carries a
 *   different `runId`) is rejected whether or not the row is settled.
 * - **Evidence and cleanup writes are always accepted**, current run or not.
 * - Deleting a row (reap) and creating one (launch) are never gated. A
 *   launch that replaces a settled row with a fresh row under a new `runId`
 *   (`save_task_state` in launch mode) is a new run, not a control write.
 *
 * A rejected write is reverted field by field in the candidate state (the
 * rest of the write still lands) and appended to
 * `<state dir>/mutator-rejections.jsonl`, which the HOK-3229 evaluator reads
 * as invariant I9. `WAVEMILL_SETTLEMENT_GATE_SHADOW=1` is the kill switch:
 * rejections are still logged but nothing is reverted.
 *
 * @module task-settlement
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isSameRunId } from './attempt-identity.ts';
import { workflowOutcomeFromLegacy } from './task-lifecycle.ts';

type JsonObject = Record<string, unknown>;

/** Workflow outcomes that settle a run. */
export const SETTLED_OUTCOMES: ReadonlySet<string> = new Set(['merged', 'closed', 'aborted']);
export type SettledOutcome = 'merged' | 'closed' | 'aborted';

/** How a field write is governed. */
export type TaskFieldKind = 'control' | 'cleanup' | 'evidence';

/**
 * Control fields: what the run does next and whether it is over. Gated on a
 * settled or non-current run. `lifecycle.workflowOutcome` is the one nested
 * control field; the rest of `lifecycle` is cleanup / delivery evidence.
 */
export const TASK_CONTROL_FIELDS: ReadonlySet<string> = new Set([
  'status',
  'phase',
  'pr',
  'runId',
  'slug',
  'branch',
  'worktree',
  'challengeAborted',
  'challengeAbortedDetail',
  'challengeAbortedNextAction',
  'challengeAbortedStage',
  'abortedAt',
  'abortedReason',
  'abortedCleanupAt',
  'abortedCleanupReason',
  'supersededAt',
  'supersededReason',
  'launchFailure',
  'retryFailure',
  'retryFailureDetail',
  'stopReason',
  'stopSubReason',
  'stopDetail',
]);

/** The nested control path inside `lifecycle`. */
export const OUTCOME_FIELD = 'lifecycle.workflowOutcome';

/**
 * Cleanup fields: resource disposition after the work is over. Never gated
 * by settlement, so a delivered task can still be archived and reaped.
 */
export const TASK_CLEANUP_FIELDS: ReadonlySet<string> = new Set([
  'lifecycle',
  'paneState',
  'paneReleased',
  'paneReleasedAt',
  'executionOwner',
  'queueHandoffAt',
  'windowId',
  'terminalRecordWritten',
  'updated',
  'statusClearedBy',
  'rehydration',
]);

/**
 * Evidence fields: facts about what a run did. Always accepted against
 * their own run, current or not (a late Codex session resolution, a late
 * cost, a recomputed comparison).
 */
export const TASK_EVIDENCE_FIELDS: ReadonlySet<string> = new Set([
  'agent',
  'attempt',
  'capsuleDigest',
  'challenge',
  'challengeArms',
  'challengeCollapseDetail',
  'challengeCollapseReason',
  'challengeCompared',
  'challengeComparedSource',
  'challengeDivergenceReason',
  'challengeExecutionIntent',
  'challengeModel',
  'challengePairId',
  'challengeRepairAction',
  'challengeRole',
  'challengeRouteDriftDetail',
  'challengeStage',
  'challengeVariedAgent',
  'challengeVariedModel',
  'challengerLaunched',
  'codeDepth',
  'coderModel',
  'comparisonBlockedReason',
  'comparisonLaunchEvidence',
  'comparisonPairingRepaired',
  'comparisonRetryCount',
  'comparisonRetryMaxAttempts',
  'comparisonRetryTargetIssue',
  'comparisonRunning',
  'comparisonState',
  'comparisonTimedOutSides',
  'dependsOnPr',
  'evalCompleted',
  'evalFailed',
  'evalHardFailureRetryCount',
  'evalRunning',
  'invalidChallengeDetails',
  'invalidChallengeReason',
  'linearIssueId',
  'linearSyncedState',
  'manualComparisonArtifact',
  'model',
  'planDepth',
  'plannerModel',
  'prReconciliation',
  'provider',
  'reviewMode',
  'reviewerModel',
  'stageRole',
  'title',
  'traceId',
]);

/**
 * Classify one task-record field. Unknown names are evidence: a new field
 * must never be blocked by a guard that has not heard of it (the
 * classification test fails on any schema field missing from the three sets,
 * so an unclassified field cannot ship silently).
 */
export function classifyTaskField(field: string): TaskFieldKind {
  if (field === OUTCOME_FIELD || TASK_CONTROL_FIELDS.has(field)) return 'control';
  if (TASK_CLEANUP_FIELDS.has(field) || field.startsWith('lifecycle.')) return 'cleanup';
  return 'evidence';
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The row's settled outcome, or `null` while the run is open (or legacy). */
export function settledOutcome(task: unknown): SettledOutcome | null {
  if (!isObject(task)) return null;
  const lifecycle = task.lifecycle;
  const outcome = isObject(lifecycle) ? lifecycle.workflowOutcome : undefined;
  return typeof outcome === 'string' && SETTLED_OUTCOMES.has(outcome) ? (outcome as SettledOutcome) : null;
}

/** True once the row's run has settled. */
export function isSettled(task: unknown): boolean {
  return settledOutcome(task) !== null;
}

/** The row's run id (`null` for legacy rows from before HOK-3373). */
export function taskRunId(task: unknown): string | null {
  if (!isObject(task)) return null;
  return typeof task.runId === 'string' && task.runId.length > 0 ? task.runId : null;
}

/** Why a control write was refused. */
export type SettlementRejectionReason = 'settled-attempt' | 'stale-run-id';

/** One refused control-field write. */
export interface SettlementRejection {
  issue: string;
  field: string;
  reason: SettlementRejectionReason;
  /** The row's run id at the time of the write. */
  currentRunId: string | null;
  /** The run the writer acted for (stale-run-id only). */
  expectedRunId?: string;
  settledOutcome?: SettledOutcome;
  /** JSON of the refused value (truncated), `null` for a deletion. */
  attempted: string | null;
}

export interface SettlementGateOptions {
  /** `.tasks` key → the run id the writer acted for. */
  expectedRunIds?: Record<string, string>;
}

const ABORT_MARKERS = new Set([
  'challengeAborted',
  'challengeAbortedDetail',
  'challengeAbortedNextAction',
  'challengeAbortedStage',
  'abortedAt',
  'abortedReason',
  'abortedCleanupAt',
  'abortedCleanupReason',
  'supersededAt',
  'supersededReason',
]);

/** Markers whose *clearing* is harmless on a settled row; only setting them relaunches. */
const RELAUNCH_MARKERS = new Set(['launchFailure', 'retryFailure', 'retryFailureDetail', 'stopReason', 'stopSubReason', 'stopDetail']);

function fieldValue(task: JsonObject, field: string): unknown {
  if (field === OUTCOME_FIELD) return isObject(task.lifecycle) ? task.lifecycle.workflowOutcome : undefined;
  return task[field];
}

function setFieldValue(task: JsonObject, field: string, value: unknown): void {
  if (field === OUTCOME_FIELD) {
    const lifecycle = isObject(task.lifecycle) ? task.lifecycle : {};
    if (value === undefined) delete lifecycle.workflowOutcome;
    else lifecycle.workflowOutcome = value;
    task.lifecycle = lifecycle;
    return;
  }
  if (value === undefined) delete task[field];
  else task[field] = value;
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/**
 * Whether a change to `field` keeps a row settled as `outcome`. The rule is
 * deliberately narrow: it lets each legacy terminal mirror (`status`,
 * `phase`) move between settled values and lets a missing PR / run id be
 * backfilled as evidence, and refuses everything that would reopen,
 * re-settle, re-adopt or relaunch the run.
 */
function consistentWithSettlement(field: string, before: JsonObject, after: JsonObject, outcome: SettledOutcome): boolean {
  const next = fieldValue(after, field);
  const prev = fieldValue(before, field);
  if (field === OUTCOME_FIELD) return false;
  // Each legacy mirror is judged on its own value: a write that names open
  // work (`planning`, `active`, `needs-user`, `error`, ...) reopens the run.
  if (field === 'status' || field === 'phase') {
    return SETTLED_OUTCOMES.has(workflowOutcomeFromLegacy({ [field]: next }));
  }
  if (field === 'pr' || field === 'runId') return !present(prev) && present(next);
  if (ABORT_MARKERS.has(field)) return outcome !== 'merged';
  if (RELAUNCH_MARKERS.has(field)) return !present(next);
  return false;
}

function attemptedJson(value: unknown): string | null {
  if (value === undefined) return null;
  const json = JSON.stringify(value) ?? null;
  return json !== null && json.length > 200 ? `${json.slice(0, 197)}...` : json;
}

function controlFieldsOf(task: JsonObject): string[] {
  const fields = Object.keys(task).filter((field) => TASK_CONTROL_FIELDS.has(field));
  fields.push(OUTCOME_FIELD);
  return fields;
}

/**
 * True when `after` is a fresh row for a new run replacing the settled
 * `before` row: a different, non-empty run id and an open outcome.
 */
export function isNewRunReplacement(before: unknown, after: unknown): boolean {
  if (!isSettled(before)) return false;
  const nextRunId = taskRunId(after);
  return nextRunId !== null && !isSameRunId(nextRunId, taskRunId(before)) && !isSettled(after);
}

/**
 * Apply the settlement rule to one write. `before` is the serialised row
 * snapshot taken before the transform ran (`taskRecordSnapshot`), `next` is
 * the candidate state; refused control fields are reverted in `next` in
 * place unless `revert` is false (shadow mode). Returns what was refused.
 */
export function applySettlementGate(
  before: Map<string, string>,
  next: unknown,
  opts: SettlementGateOptions & { revert?: boolean } = {},
): SettlementRejection[] {
  const rejections: SettlementRejection[] = [];
  if (!isObject(next) || !isObject(next.tasks)) return rejections;
  const revert = opts.revert !== false;
  for (const [issue, row] of Object.entries(next.tasks)) {
    if (!isObject(row)) continue;
    const previousRaw = before.get(issue);
    if (previousRaw === undefined) continue; // a launch creates the row
    const serialised = JSON.stringify(row);
    if (previousRaw === serialised) continue;
    let previous: unknown;
    try {
      previous = JSON.parse(previousRaw);
    } catch {
      continue;
    }
    if (!isObject(previous)) continue;
    if (isNewRunReplacement(previous, row)) continue;

    const currentRunId = taskRunId(previous);
    const expected = opts.expectedRunIds?.[issue];
    // A legacy row has no run id to compare: grandfathered, never "stale".
    const stale = typeof expected === 'string' && expected.length > 0 && currentRunId !== null
      && !isSameRunId(expected, currentRunId);
    const outcome = settledOutcome(previous);
    if (!stale && outcome === null) continue;

    const fields = new Set([...controlFieldsOf(previous), ...controlFieldsOf(row)]);
    for (const field of fields) {
      const prevValue = fieldValue(previous, field);
      const nextValue = fieldValue(row, field);
      if (JSON.stringify(prevValue) === JSON.stringify(nextValue)) continue;
      let reason: SettlementRejectionReason | null = null;
      if (stale) reason = 'stale-run-id';
      else if (outcome !== null && !consistentWithSettlement(field, previous, row, outcome)) reason = 'settled-attempt';
      if (reason === null) continue;
      rejections.push({
        issue,
        field,
        reason,
        currentRunId,
        ...(stale ? { expectedRunId: expected } : {}),
        ...(outcome !== null ? { settledOutcome: outcome } : {}),
        attempted: attemptedJson(nextValue),
      });
      if (revert) setFieldValue(row, field, prevValue);
    }
  }
  return rejections;
}

// ── Rejection log (read by state-invariants I9) ─────────────────────────────

/** Basename of the rejection log, written next to `workflow-state.json`. */
export const MUTATOR_REJECTIONS_BASENAME = 'mutator-rejections.jsonl';

/** One `mutator-rejections.jsonl` line. */
export interface MutatorRejectionRecord extends SettlementRejection {
  at: string;
  writer: 'ts' | 'shell';
  mode: 'enforce' | 'shadow';
  signature: string;
}

/** Path of the rejection log for a given state file. */
export function mutatorRejectionsPath(statePath: string): string {
  return join(dirname(statePath), MUTATOR_REJECTIONS_BASENAME);
}

/** Stable identity of a rejection: one line per (issue, field, reason, value). */
export function rejectionSignature(rejection: SettlementRejection): string {
  return [rejection.issue, rejection.field, rejection.reason, rejection.attempted ?? 'null'].join('|');
}

/** Whether the kill switch keeps the gate in log-only mode. */
export function settlementGateShadow(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WAVEMILL_SETTLEMENT_GATE_SHADOW === '1';
}

const DEDUPE_TAIL_LINES = 200;

function recentSignatures(logPath: string): Set<string> {
  const signatures = new Set<string>();
  if (!existsSync(logPath)) return signatures;
  try {
    const lines = readFileSync(logPath, 'utf-8').split('\n').filter((line) => line.trim());
    for (const line of lines.slice(-DEDUPE_TAIL_LINES)) {
      try {
        const signature = (JSON.parse(line) as Partial<MutatorRejectionRecord>).signature;
        if (typeof signature === 'string') signatures.add(signature);
      } catch {
        // torn line
      }
    }
  } catch {
    // unreadable: log again rather than drop
  }
  return signatures;
}

/**
 * Append rejections to the log. A writer that repeats the same refused write
 * every tick logs it once (dedupe over the recent tail), so the log measures
 * distinct defects and I9 counts stay meaningful. Best-effort; never throws.
 */
export function recordMutatorRejections(
  statePath: string,
  writer: 'ts' | 'shell',
  rejections: SettlementRejection[],
  opts: { mode: 'enforce' | 'shadow'; now?: () => Date },
): MutatorRejectionRecord[] {
  if (rejections.length === 0) return [];
  const at = (opts.now ?? (() => new Date()))().toISOString();
  const logPath = mutatorRejectionsPath(statePath);
  const seen = recentSignatures(logPath);
  const records: MutatorRejectionRecord[] = [];
  for (const rejection of rejections) {
    const signature = rejectionSignature(rejection);
    if (seen.has(signature)) continue;
    seen.add(signature);
    records.push({ at, writer, mode: opts.mode, signature, ...rejection });
  }
  if (records.length === 0) return records;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, records.map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf-8');
  } catch {
    // best-effort
  }
  try {
    const shown = records.slice(0, 3).map((r) => `${r.issue}.${r.field} (${r.reason})`).join(', ');
    process.stderr.write(`workflow-state: ${opts.mode === 'shadow' ? 'would refuse' : 'refused'} control write(s) to settled/non-current run: ${shown}\n`);
  } catch {
    // ignore
  }
  return records;
}

/** Parse `issue=runId[,issue=runId]` (the shell bridge's `--expected-run-id`). */
export function parseExpectedRunIds(raw: string | undefined | null): Record<string, string> | undefined {
  if (!raw) return undefined;
  const result: Record<string, string> = {};
  for (const entry of raw.split(',')) {
    const at = entry.indexOf('=');
    if (at <= 0) continue;
    const issue = entry.slice(0, at).trim();
    const runId = entry.slice(at + 1).trim();
    if (issue && runId) result[issue] = runId;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
