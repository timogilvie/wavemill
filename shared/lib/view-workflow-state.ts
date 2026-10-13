/**
 * Ledger H Phase 4 (HOK-3187) — render `workflow-state.json` from the ledger.
 *
 * Phase 4 of the durable task ledger retires `workflow-state.json` as a
 * primary writer and keeps it only as a *render view*: a compact JSON file
 * regenerated from the ledger each time an authoritative write lands. This
 * module is the pure render — it reads the ledger and returns a plain object
 * shaped like the legacy state file, so legacy readers can still parse it.
 *
 * Design: `docs/mill-task-ledger-design.md` §8e / §10c.
 *
 * The renderer is **deterministic**: the same ledger state produces the same
 * bytes. Downstream readers never see churn from field reordering.
 */
import { createHash } from 'node:crypto';
import type {
  EvidenceRow,
  Ledger,
  OperatorEventRow,
  SettledAs,
  TaskRow,
  WaitingOnRow,
} from './ledger.ts';
import { parseTaskId } from './task-identity.ts';

/**
 * The slice of the ledger surface the renderer reads. Narrowing to this
 * subset lets the CLI inject an empty-ledger stub when the SQLite file does
 * not yet exist, so a first boot still emits a valid render view.
 */
export type RenderableLedger = Pick<
  Ledger,
  | 'listTasks'
  | 'listChildren'
  | 'listWaitingOn'
  | 'listEvidence'
  | 'listOperatorEvents'
>;

export interface RenderedTask {
  issue: string;
  phase: string | null;
  status: string | null;
  settledAs: SettledAs | null;
  settledReason: string | null;
  settledAt: string | null;
  slug: string | null;
  owner: string | null;
  nextAction: string | null;
  createdAt: string;
  retryBuckets: Record<string, RetryBucketView>;
  steps: StepView[];
  waitingOn: WaitingOnView[];
  pair?: PairView;
  challengePairId?: string;
  challengeRole?: string;
}

export interface RetryBucketView {
  bucket: string;
  attempts: number;
  maxAttempts: number | null;
  exhausted: boolean;
  settledReason: string | null;
}

export interface StepView {
  id: string;
  kind: string;
  state: string;
  settledAs: SettledAs | null;
  settledReason: string | null;
  settledAt: string | null;
  attempt: number;
  maxAttempts: number | null;
  owner: string | null;
  nextAction: string | null;
  deadline: string | null;
  createdAt: string;
  waitingOn: WaitingOnView[];
}

export interface WaitingOnView {
  trigger: string;
  conditionHash: string;
  recheckAfter: string | null;
  recordedAt: string;
}

export interface PairView {
  id: string;
  slug: string;
  state: string;
  settledAs: SettledAs | null;
  settledReason: string | null;
  arms: ArmView[];
}

export interface ArmView {
  id: string;
  slug: string;
  role: string | null;
  state: string;
  settledAs: SettledAs | null;
  settledReason: string | null;
}

export interface RenderedWorkflowState {
  schemaVersion: number;
  source: 'ledger-h-phase-4';
  renderedAt: string;
  tasks: Record<string, RenderedTask>;
  operatorEvents: Record<string, OperatorEventView[]>;
}

export interface OperatorEventView {
  seq: number;
  kind: string;
  recordedAt: string;
  consumedAt: string | null;
  payloadHash: string | null;
}

export interface RenderOptions {
  renderedAt?: string;
}

const SCHEMA_VERSION = 1;

function conditionHash(condition: string): string {
  return createHash('sha256').update(condition).digest('hex').slice(0, 16);
}

function renderWaitingOn(rows: WaitingOnRow[]): WaitingOnView[] {
  return rows
    .map((row) => ({
      trigger: row.trigger,
      conditionHash: conditionHash(row.condition),
      recheckAfter: row.recheck_after,
      recordedAt: row.recorded_at,
    }))
    .sort((a, b) =>
      a.trigger < b.trigger ? -1 : a.trigger > b.trigger ? 1 : 0,
    );
}

function parseExhaustedBucket(reason: string | null): string | null {
  if (!reason) return null;
  const prefix = 'exhausted:';
  if (!reason.startsWith(prefix)) return null;
  const rest = reason.slice(prefix.length);
  const colon = rest.indexOf(':');
  return colon >= 0 ? rest.slice(0, colon) : rest;
}

function renderStep(ledger: RenderableLedger, step: TaskRow): StepView {
  return {
    id: step.id,
    kind: step.slug,
    state: step.state,
    settledAs: step.settled_as,
    settledReason: step.settled_reason,
    settledAt: step.settled_at,
    attempt: step.attempt,
    maxAttempts: step.max_attempts,
    owner: step.owner,
    nextAction: step.next_action,
    deadline: step.deadline,
    createdAt: step.created_at,
    waitingOn: renderWaitingOn(ledger.listWaitingOn(step.id)),
  };
}

function retryBucketsFromSteps(steps: StepView[]): Record<string, RetryBucketView> {
  const buckets: Record<string, RetryBucketView> = {};
  for (const step of steps) {
    const exhaustedBucket = step.settledAs === 'aborted' ? parseExhaustedBucket(step.settledReason) : null;
    const bucketName = exhaustedBucket ?? `step:${step.kind}`;
    const prior = buckets[bucketName];
    const next: RetryBucketView = {
      bucket: bucketName,
      attempts: Math.max(prior?.attempts ?? 0, step.attempt),
      maxAttempts: step.maxAttempts ?? prior?.maxAttempts ?? null,
      exhausted: Boolean(exhaustedBucket) || prior?.exhausted === true,
      settledReason: exhaustedBucket ? step.settledReason : prior?.settledReason ?? null,
    };
    buckets[bucketName] = next;
  }
  return buckets;
}

function renderArm(arm: TaskRow): ArmView {
  return {
    id: arm.id,
    slug: arm.slug,
    role: arm.owner,
    state: arm.state,
    settledAs: arm.settled_as,
    settledReason: arm.settled_reason,
  };
}

function renderPair(ledger: RenderableLedger, pair: TaskRow): PairView {
  const arms = ledger
    .listChildren(pair.id)
    .filter((row) => row.kind === 'arm')
    .map(renderArm)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return {
    id: pair.id,
    slug: pair.slug,
    state: pair.state,
    settledAs: pair.settled_as,
    settledReason: pair.settled_reason,
    arms,
  };
}

function findPairForIssue(pairs: TaskRow[], issueKey: string): TaskRow | null {
  const parsed = parseTaskId(issueKey);
  const baseIssueKey = parsed?.linearId ?? issueKey;
  for (const pair of pairs) {
    const slug = pair.slug ?? '';
    if (slug === issueKey || slug === baseIssueKey) return pair;
  }
  return null;
}

function renderOperatorEvent(row: OperatorEventRow): OperatorEventView {
  return {
    seq: row.seq,
    kind: row.kind,
    recordedAt: row.recorded_at,
    consumedAt: row.consumed_at,
    payloadHash: row.payload ? conditionHash(row.payload) : null,
  };
}

function sortedTasks<T extends { createdAt: string; issue?: string }>(
  entries: [string, T][],
): [string, T][] {
  return [...entries].sort(([a, aValue], [b, bValue]) => {
    const left = aValue.createdAt;
    const right = bValue.createdAt;
    if (left !== right) return left < right ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function latestEvidenceEvent(rows: EvidenceRow[]): EvidenceRow | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) =>
    a.recorded_at < b.recorded_at ? -1 : a.recorded_at > b.recorded_at ? 1 : 0,
  );
  return sorted[sorted.length - 1];
}

function derivePhase(
  issueRow: TaskRow,
  steps: StepView[],
  latestEvidence: EvidenceRow | null,
): string | null {
  if (issueRow.settled_as === 'done') return 'done';
  if (issueRow.settled_as === 'aborted') return 'aborted';
  if (issueRow.settled_as === 'interrupted') return 'interrupted';
  const running = steps.find((step) => step.state === 'running');
  if (running) return running.kind;
  if (latestEvidence?.event) return `evidence:${latestEvidence.event}`;
  return null;
}

function stepsFor(ledger: RenderableLedger, parent: TaskRow): StepView[] {
  return ledger
    .listChildren(parent.id)
    .filter((row) => row.kind === 'step')
    .map((row) => renderStep(ledger, row))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

function evidenceFor(ledger: RenderableLedger, parent: TaskRow): EvidenceRow[] {
  return ledger
    .listChildren(parent.id)
    .filter((row) => row.kind === 'step')
    .flatMap((row) => ledger.listEvidence(row.id));
}

/**
 * Render the ledger state as a plain object shaped like the legacy
 * `workflow-state.json`. The returned object is deterministic given the
 * input ledger state.
 */
export function renderWorkflowState(ledger: RenderableLedger, options: RenderOptions = {}): RenderedWorkflowState {
  const issues = ledger.listTasks({ kind: 'issue' }).filter((row) => row.parent_id === null);
  const pairs = ledger.listTasks({ kind: 'pair' }).filter((row) => row.parent_id === null);
  const tasks: Record<string, RenderedTask> = {};
  const operatorEvents: Record<string, OperatorEventView[]> = {};

  for (const issue of issues) {
    const steps = stepsFor(ledger, issue);
    const latestEvidence = latestEvidenceEvent(evidenceFor(ledger, issue));
    const pair = findPairForIssue(pairs, issue.slug);
    const task: RenderedTask = {
      issue: issue.slug,
      phase: derivePhase(issue, steps, latestEvidence),
      status: issue.state,
      settledAs: issue.settled_as,
      settledReason: issue.settled_reason,
      settledAt: issue.settled_at,
      slug: issue.slug,
      owner: issue.owner,
      nextAction: issue.next_action,
      createdAt: issue.created_at,
      retryBuckets: retryBucketsFromSteps(steps),
      steps,
      waitingOn: steps.flatMap((step) => step.waitingOn),
    };
    if (pair) {
      task.pair = renderPair(ledger, pair);
      task.challengePairId = pair.slug;
      const arm = task.pair.arms.find((row) => row.slug === issue.slug);
      if (arm?.role) task.challengeRole = arm.role;
    }
    tasks[issue.slug] = task;

    const events = ledger.listOperatorEvents(issue.id).map(renderOperatorEvent);
    if (events.length > 0) operatorEvents[issue.slug] = events;
  }

  // Challenge pairs may hold the slot at parent_id=NULL instead of a per-arm
  // issue root (shared/lib/challenge-pairing-repair.ts shadow writer). Render
  // each arm as its own task so dashboards keyed on issue slug find a row.
  for (const pair of pairs) {
    const renderedPair = renderPair(ledger, pair);
    const armRows = ledger.listChildren(pair.id).filter((row) => row.kind === 'arm');
    for (const arm of armRows) {
      if (tasks[arm.slug]) continue;
      const steps = stepsFor(ledger, arm);
      const latestEvidence = latestEvidenceEvent(evidenceFor(ledger, arm));
      const task: RenderedTask = {
        issue: arm.slug,
        phase: derivePhase(arm, steps, latestEvidence),
        status: arm.state,
        settledAs: arm.settled_as,
        settledReason: arm.settled_reason,
        settledAt: arm.settled_at,
        slug: arm.slug,
        owner: arm.owner,
        nextAction: arm.next_action,
        createdAt: arm.created_at,
        retryBuckets: retryBucketsFromSteps(steps),
        steps,
        waitingOn: steps.flatMap((step) => step.waitingOn),
        pair: renderedPair,
        challengePairId: pair.slug,
      };
      if (arm.owner) task.challengeRole = arm.owner;
      tasks[arm.slug] = task;

      const events = ledger.listOperatorEvents(arm.id).map(renderOperatorEvent);
      if (events.length > 0) operatorEvents[arm.slug] = events;
    }
  }

  const sortedTaskEntries = sortedTasks(Object.entries(tasks));
  const sortedTasksRecord: Record<string, RenderedTask> = {};
  for (const [key, value] of sortedTaskEntries) sortedTasksRecord[key] = value;

  const sortedEvents: Record<string, OperatorEventView[]> = {};
  for (const key of Object.keys(operatorEvents).sort()) {
    sortedEvents[key] = operatorEvents[key];
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'ledger-h-phase-4',
    renderedAt: options.renderedAt ?? new Date().toISOString(),
    tasks: sortedTasksRecord,
    operatorEvents: sortedEvents,
  };
}

/**
 * Serialize the rendered view as compact JSON with a trailing newline.
 * Matches HOK-3190 (`state_mutate` / `mutateJsonState` already use compact).
 */
export function serializeRenderedWorkflowState(rendered: RenderedWorkflowState): string {
  return `${JSON.stringify(rendered)}\n`;
}
