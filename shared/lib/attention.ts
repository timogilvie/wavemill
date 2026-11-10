/**
 * The one attention decision (HOK-3423): "does this task need a human, and
 * why?" is answered here and nowhere else.
 *
 * {@link deriveAttentionItems} is pure. It reads only the records the existing
 * primitives already produce and makes no liveness, failure-class or retry
 * decision of its own:
 *
 *   | Item kind                    | Source (owner)                                                   |
 *   |------------------------------|------------------------------------------------------------------|
 *   | `approve-plan`               | `.planning-result.json` awaiting_user + `.plan-packet-hash` that |
 *   |                              | names the current packet bytes (HOK-3253), or a planning         |
 *   |                              | out-of-scope rejection asking for re-approval                    |
 *   | `answer-agent`               | task-progress `blockingPrompt` / agent-own `agentState` (HOK-3101)|
 *   | `resolve-blocked-completion` | `.coding-blocked-completion.json` / `.coding-uncommitted-output.json` |
 *   | `operator-decision`          | `.needs-attention` basis `operator-decision:<code>` (HOK-3360)   |
 *   | `exhausted`                  | `.needs-attention` basis `exhausted:<bucket>` (HOK-3360)         |
 *   | `policy-terminal`            | `.needs-attention` basis `policy-terminal:<class>` (HOK-3360)    |
 *   | `incident`                   | `reconcileIncidentForFiling` → `confirmed_active` (HOK-3324)     |
 *   | `queue-health`               | `queue-health.json` currentAlertProjection (HOK-3314)            |
 *   | `backstage-health`           | `backstage-health.json` unhealthy service                        |
 *   | `openrouter`                 | the cached OpenRouter balance warning                            |
 *   | `malformed-challenge`        | challenge stubs with no slug (HOK-2926)                          |
 *
 * The last four are non-task `free items` (HOK-3424): no `taskId`, so the
 * Observer's task-scoped push skips them while the inbox renders them.
 *
 * What never produces an item: a raw hook `error`/`blocked` state (the failure
 * policy owns it until the escalation step writes `.needs-attention`), a
 * retryable first-occurrence failure, a ready-watchdog classification without
 * an escalation marker, and any marker the HOK-3172 condition reconciler has
 * already expired (it is gone from disk, so it is never read).
 *
 * The monitor writes the projection as the `attention-projection` tracked job
 * (`monitor_attention_projection_tick`, HOK-3206) to `.wavemill/attention.json`
 * through {@link writeAttentionProjection}; the dashboard inbox renders only
 * that file. Enforced by `tools/check-attention.ts`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isOperatorDecisionCode } from './failure-policy.ts';
import {
  readAuthoritativeWorkflowJobs,
  reconcileIncidentForFiling,
  type IncidentFilingReconciliation,
} from './incident-filing-reconciler.ts';
import type { IncidentRecord } from './wavemill-incident-model.ts';
import { IncidentStore } from './wavemill-incident-store.ts';
import type { ReadyWatchdogStateEntry, ReadyWatchdogStateFile } from './ready-watchdog.ts';
import {
  getTaskProgress,
  progressCacheIsFresh,
  type BlockingPrompt,
  type HookState,
  type TaskProgress,
} from './task-progress.ts';
import { getResultFilePath } from './stage-result.ts';
import { isSettled } from './task-settlement.ts';
import { termCapture } from './terminal-backend.ts';
import type { MarkerCondition, MarkerPayload } from './transient-marker.ts';
import {
  deriveQueueAlertProjection,
  type QueueHealthStateLike,
} from './queue-inference-status.ts';
import { readWorkflowState, workflowTaskEntries, type TaskRecord, type WorkflowState } from './workflow-state.ts';

export const ATTENTION_PROJECTION_SCHEMA_VERSION = 1 as const;
export const ATTENTION_PROJECTION_FILE = 'attention.json';

export type AttentionKind =
  | 'approve-plan'
  | 'answer-agent'
  | 'resolve-blocked-completion'
  | 'operator-decision'
  | 'exhausted'
  | 'policy-terminal'
  | 'incident'
  | 'queue-health'
  | 'backstage-health'
  | 'openrouter'
  | 'malformed-challenge';

/**
 * Fixed precedence: work blocked on a human answer first, then escalations,
 * then incidents, then non-task operational signals (HOK-3424). Ties break on
 * age (oldest first), then id. No thresholds.
 */
export const ATTENTION_KIND_RANK: Readonly<Record<AttentionKind, number>> = Object.freeze({
  'approve-plan': 0,
  'answer-agent': 1,
  'resolve-blocked-completion': 2,
  'operator-decision': 3,
  exhausted: 4,
  'policy-terminal': 5,
  incident: 6,
  'queue-health': 7,
  'backstage-health': 8,
  openrouter: 9,
  'malformed-challenge': 10,
});

export interface AttentionCommand {
  label: string;
  argv: string[];
}

export interface AttentionEvidence {
  source: string;
  path?: string;
  summary: string;
}

export interface AttentionItem {
  /** Stable identity: (task or incident fingerprint, kind, condition key). */
  id: string;
  kind: AttentionKind;
  /** `operator-decision` code. */
  decisionCode?: string;
  /** `exhausted` bucket. */
  bucket?: string;
  /** `policy-terminal` decision class. */
  decisionClass?: string;
  /** `incident` fingerprint. */
  incidentId?: string;
  taskId?: string;
  affectedTaskIds?: string[];
  paneTarget?: string;
  /** Epoch ms the blocker first appeared (from the source record). */
  since: number;
  /** One-line text the inbox row renders. */
  summary: string;
  evidence: AttentionEvidence[];
  /** Existing commands that act on the item. Data only. */
  commands: AttentionCommand[];
  /** The marker condition shape, so a stale item is recognisable. */
  condition?: MarkerCondition;
}

export interface AttentionProjection {
  schemaVersion: typeof ATTENTION_PROJECTION_SCHEMA_VERSION;
  /** Monitor pass (start epoch ms) this projection was computed against. */
  passStampMs: number;
  /** A reader treats the projection as stale once its clock passes this. */
  staleAfterMs: number;
  computedAt: string;
  items: AttentionItem[];
}

// ── Inputs (all read by gatherAttentionInputs; derive does no I/O) ─────────

export type AttentionTaskRecord = Pick<TaskRecord, 'slug' | 'phase' | 'status' | 'worktree' | 'windowId'>;

export interface AttentionMarkerInput {
  payload: MarkerPayload;
}

export interface AttentionPlanningInput {
  resultStatus: string | null;
  resultAtMs: number | null;
  planPresent: boolean;
  planApproved: boolean;
  recordedPacketHash: string | null;
  currentPacketHash: string | null;
  reapprovalReason: string | null;
  rejection: {
    reason: string | null;
    outOfScopeFiles: string[];
    notifiedAt: string | null;
    notifyStatus: string | null;
    notifyAttempts: number | null;
    notifyTarget: string | null;
    atMs: number;
  } | null;
}

export interface AttentionBlockedCompletionInput {
  /** `.coding-auto-advance.json` present: the mill advanced on its own. */
  autoAdvanced: boolean;
  blocked: { summary: string | null; atMs: number } | null;
  uncommitted: { summary: string | null; action: string | null; atMs: number } | null;
}

export interface AttentionTaskInput {
  taskId: string;
  task: AttentionTaskRecord;
  featureDir: string | null;
  progress: Pick<TaskProgress, 'agentState' | 'blockingPrompt' | 'agentRecord'> | null;
  needsAttention: AttentionMarkerInput | null;
  planning: AttentionPlanningInput | null;
  blockedCompletion: AttentionBlockedCompletionInput | null;
  readyWatchdog: Pick<ReadyWatchdogStateEntry, 'classification' | 'detail' | 'recoveryCommand' | 'updatedAt'> | null;
}

export interface AttentionIncidentInput {
  incident: Pick<IncidentRecord, 'fingerprint' | 'taskId' | 'summary' | 'operatorAction' | 'firstObservedAt' | 'severity' | 'lifecycle' | 'metadata'>;
  reconciliation: Pick<IncidentFilingReconciliation, 'outcome'>;
}

/**
 * A non-task operational signal (HOK-3424): queue health, backstage health,
 * the OpenRouter balance and malformed challenge state were dashboard header
 * lines read from four private files. They are free items — no `taskId` — so
 * the inbox renders them and the Observer's task-scoped push skips them.
 */
export type AttentionFreeKind = Extract<
  AttentionKind,
  'queue-health' | 'backstage-health' | 'openrouter' | 'malformed-challenge'
>;

export interface AttentionFreeItemInput {
  kind: AttentionFreeKind;
  /** Stable condition key, so the item id survives a repeated poll. */
  key: string;
  summary: string;
  /** Epoch ms the condition was first observed, when the source records it. */
  sinceMs?: number;
  evidence: AttentionEvidence[];
  /** Tasks the signal implicates, when known (never item ownership). */
  affectedTaskIds?: string[];
}

export interface AttentionInputs {
  passStampMs: number;
  staleAfterMs: number;
  nowMs: number;
  tasks: AttentionTaskInput[];
  incidents: AttentionIncidentInput[];
  freeItems?: AttentionFreeItemInput[];
}

// ── Pure derivation ────────────────────────────────────────────────────────

const BLOCKED_SUMMARY_MAX = 80;
const DEFAULT_BLOCKED_SUMMARY = 'coding done; verification blocked';
const DEFAULT_UNCOMMITTED_SUMMARY =
  'coding completed marker detected, but review cannot start until the coding output is committed';
const DEFAULT_UNCOMMITTED_ACTION = 'Commit the coding output, then retry review.';
/** Agent-own hook states that mean "I am waiting on a human" (not a failure). */
const AGENT_WAITING_STATES: ReadonlySet<HookState> = new Set<HookState>(['waiting', 'approval-needed']);
/**
 * Ready-gate refusals written before the agent was relaunched (HOK-2915):
 * while the review/Ready agent is working again, the marker describes the
 * previous attempt and the reconciler expires it when the new verdict lands.
 */
const RELAUNCH_SUPERSEDED_REASONS: readonly RegExp[] = [
  /^Review verdict does not pass readiness gate/,
  /^Review recorded no verdict/,
  /blocked by scope guard/,
];

function truncateSummary(summary: string): string {
  return summary.length > BLOCKED_SUMMARY_MAX ? `${summary.slice(0, BLOCKED_SUMMARY_MAX - 3)}...` : summary;
}

function shortKey(value: string | null | undefined): string {
  if (!value) return 'none';
  return /^[0-9a-f]{12,}$/.test(value) ? value.slice(0, 12) : createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function isoToMs(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : fallback;
}

function paneTargetFor(input: AttentionTaskInput): string | undefined {
  return input.task.windowId || undefined;
}

function planningRejectionText(rejection: NonNullable<AttentionPlanningInput['rejection']>): string {
  const files = rejection.outOfScopeFiles.length > 0 ? rejection.outOfScopeFiles.join(', ') : 'out-of-scope files';
  let suffix: string;
  if (rejection.notifiedAt) {
    suffix = ' Agent notified.';
  } else {
    const attempts = rejection.notifyAttempts ?? '?';
    const target = rejection.notifyTarget;
    switch (rejection.notifyStatus) {
      case 'stranded':
        suffix = ` Agent NOT notified: message stranded in pane input after ${attempts} attempts${target ? ` — press Enter in ${target}` : ''}.`;
        break;
      case 'unconfirmed':
        suffix = ` Agent NOT notified: delivery unconfirmed after ${attempts} attempts${target ? ` — check ${target}` : ''}.`;
        break;
      case 'unavailable':
        suffix = ' Agent NOT notified: pane unavailable.';
        break;
      case null:
      case '':
        suffix = ' Agent not notified.';
        break;
      default:
        suffix = ` Agent NOT notified: ${rejection.notifyStatus}.`;
    }
  }
  return `Planning needs attention: edited ${files}; reverted. Review plan.md and re-approve.${suffix}`;
}

function approvePlanItem(input: AttentionTaskInput, nowMs: number): AttentionItem | null {
  const planning = input.planning;
  if (!planning || input.task.phase !== 'planning' || planning.planApproved) return null;
  const rejection = planning.rejection?.reason === 'planning_modified_out_of_scope_files' ? planning.rejection : null;
  // HOK-3253: an approval request exists only once the inputs gate passed,
  // i.e. the recorded binding names the packet bytes on disk.
  const bindingCurrent = Boolean(planning.recordedPacketHash)
    && planning.recordedPacketHash === planning.currentPacketHash;
  const awaiting = planning.resultStatus === 'awaiting_user' && planning.planPresent && bindingCurrent;
  if (!awaiting && !rejection) return null;

  const evidence: AttentionEvidence[] = [];
  const fd = input.featureDir ?? undefined;
  if (awaiting) {
    evidence.push({
      // allow-stage-artifact-lookup: evidence label naming the file; the path comes from getResultFilePath
      source: '.planning-result.json',
      ...(fd ? { path: getResultFilePath(fd, 'planning') } : {}),
      summary: planning.reapprovalReason
        ? `Plan ready — waiting for re-approval: ${planning.reapprovalReason}`
        : 'Plan ready — waiting for approval',
    });
  }
  if (rejection) {
    evidence.push({
      source: '.planning-rejected.json',
      ...(fd ? { path: join(fd, '.planning-rejected.json') } : {}),
      summary: planningRejectionText(rejection),
    });
  }
  const since = Math.min(
    awaiting ? planning.resultAtMs ?? nowMs : nowMs,
    rejection ? rejection.atMs : nowMs,
  );
  // A rejection is the more specific instruction; it leads the row.
  const summary = (rejection ? evidence[evidence.length - 1] : evidence[0]).summary;
  const packetKey = planning.recordedPacketHash ?? planning.currentPacketHash;
  return {
    id: `${input.taskId}:approve-plan:${shortKey(packetKey)}`,
    kind: 'approve-plan',
    taskId: input.taskId,
    ...(paneTargetFor(input) ? { paneTarget: paneTargetFor(input) } : {}),
    since,
    summary,
    evidence,
    commands: fd ? [{ label: `approve the plan for ${input.taskId}`, argv: ['touch', join(fd, '.plan-approved')] }] : [],
    condition: { expiresOn: ['operator-event'], observed: { packetHash: packetKey ?? '' } },
  };
}

function answerAgentItem(input: AttentionTaskInput, nowMs: number, planItem: AttentionItem | null): AttentionItem | null {
  const progress = input.progress;
  if (!progress) return null;
  // The plan approval is the question the planner is waiting on.
  if (planItem) return null;
  const prompt: BlockingPrompt | null = progress.blockingPrompt ?? null;
  const agentWaiting = progress.agentState != null && AGENT_WAITING_STATES.has(progress.agentState);
  if (!prompt && !agentWaiting) return null;
  const record = progress.agentRecord;
  const recordAtMs = typeof record?.timestamp === 'number' ? record.timestamp * 1000 : nowMs;
  const detail = prompt?.detail
    || record?.detail
    || `agent is ${progress.agentState}`;
  const key = prompt ? prompt.id : `${progress.agentState}:${record?.timestamp ?? ''}`;
  const pane = paneTargetFor(input);
  return {
    id: `${input.taskId}:answer-agent:${shortKey(key)}`,
    kind: 'answer-agent',
    taskId: input.taskId,
    ...(pane ? { paneTarget: pane } : {}),
    since: recordAtMs,
    summary: `${input.taskId} is waiting on you: ${detail}`,
    evidence: [{
      source: 'task-progress',
      summary: prompt ? `blocking prompt ${prompt.id} (${prompt.agent})` : `agentState=${progress.agentState}`,
    }],
    commands: pane ? [{ label: `answer the agent in ${pane}`, argv: ['tmux', 'select-window', '-t', pane] }] : [],
  };
}

function blockedCompletionItem(input: AttentionTaskInput): AttentionItem | null {
  const bc = input.blockedCompletion;
  if (!bc || input.task.phase !== 'coding' || bc.autoAdvanced) return null;
  const fd = input.featureDir ?? undefined;
  const issue = input.taskId;
  if (bc.uncommitted) {
    const summary = truncateSummary(bc.uncommitted.summary || DEFAULT_UNCOMMITTED_SUMMARY);
    const action = bc.uncommitted.action || DEFAULT_UNCOMMITTED_ACTION;
    return {
      id: `${issue}:resolve-blocked-completion:uncommitted-${bc.uncommitted.atMs}`,
      kind: 'resolve-blocked-completion',
      taskId: issue,
      ...(paneTargetFor(input) ? { paneTarget: paneTargetFor(input) } : {}),
      since: bc.uncommitted.atMs,
      summary: `${issue} needs attention: ${summary}. ${action}`,
      evidence: [{
        source: '.coding-uncommitted-output.json',
        ...(fd ? { path: join(fd, '.coding-uncommitted-output.json') } : {}),
        summary,
      }],
      commands: [{ label: `advance ${issue}`, argv: ['advance', issue] }],
      condition: { observed: { artifactAtMs: String(bc.uncommitted.atMs) } },
    };
  }
  if (!bc.blocked) return null;
  const summary = truncateSummary(bc.blocked.summary || DEFAULT_BLOCKED_SUMMARY);
  return {
    id: `${issue}:resolve-blocked-completion:${bc.blocked.atMs}`,
    kind: 'resolve-blocked-completion',
    taskId: issue,
    ...(paneTargetFor(input) ? { paneTarget: paneTargetFor(input) } : {}),
    since: bc.blocked.atMs,
    summary: `${issue} needs attention: ${summary}. Type "advance ${issue}" to launch review.`,
    evidence: [{
      source: '.coding-blocked-completion.json',
      ...(fd ? { path: join(fd, '.coding-blocked-completion.json') } : {}),
      summary,
    }],
    commands: [{ label: `advance ${issue}`, argv: ['advance', issue] }],
    condition: { observed: { artifactAtMs: String(bc.blocked.atMs) } },
  };
}

type EscalationKind = Extract<AttentionKind, 'operator-decision' | 'exhausted' | 'policy-terminal'>;

/** Parse the HOK-3360 `escalationBasis` label; null when the marker has none. */
export function parseEscalationBasis(label: unknown): { kind: EscalationKind; arg: string } | null {
  if (typeof label !== 'string') return null;
  const idx = label.indexOf(':');
  if (idx <= 0) return null;
  const kind = label.slice(0, idx);
  const arg = label.slice(idx + 1);
  if (!arg) return null;
  if (kind === 'operator-decision' || kind === 'exhausted' || kind === 'policy-terminal') return { kind, arg };
  return null;
}

function escalationItem(input: AttentionTaskInput, nowMs: number): AttentionItem | null {
  const marker = input.needsAttention?.payload;
  if (!marker) return null;
  // Only the escalation step's marker pages (HOK-3360). A marker without a
  // basis predates the step or was not written by it: no item.
  const basis = parseEscalationBasis(marker.detail?.escalationBasis);
  if (!basis) return null;
  if (basis.kind === 'operator-decision' && !isOperatorDecisionCode(basis.arg)) return null;
  const reason = (marker.reason ?? '').trim();
  const phase = input.task.phase;
  if (
    (phase === 'review' || phase === 'ready')
    && input.progress?.agentState === 'working'
    && RELAUNCH_SUPERSEDED_REASONS.some((re) => re.test(reason))
  ) {
    return null;
  }

  const issue = input.taskId;
  const fd = input.featureDir ?? undefined;
  const evidence: AttentionEvidence[] = [{
    source: '.needs-attention',
    ...(fd ? { path: join(fd, '.needs-attention') } : {}),
    summary: reason || `escalated: ${basis.kind} ${basis.arg}`,
  }];
  const watchdog = input.readyWatchdog;
  if (watchdog && watchdog.classification === 'needs-user' && watchdog.detail) {
    evidence.push({ source: 'ready-watchdog-state.json', summary: watchdog.detail });
  }
  const commands: AttentionCommand[] = [];
  if (watchdog?.recoveryCommand) {
    commands.push({ label: watchdog.recoveryCommand, argv: ['sh', '-c', watchdog.recoveryCommand] });
  }
  if (phase === 'review' || phase === 'ready') {
    commands.push({ label: `re-review ${issue}`, argv: ['re-review', issue] });
  }
  commands.push({ label: `wavemill abort ${issue}`, argv: ['wavemill', 'abort', issue] });

  const condition: MarkerCondition = marker.condition ?? { head: marker.headSha };
  return {
    id: `${issue}:${basis.kind}:${basis.arg}:${shortKey(marker.headSha)}`,
    kind: basis.kind,
    ...(basis.kind === 'operator-decision' ? { decisionCode: basis.arg } : {}),
    ...(basis.kind === 'exhausted' ? { bucket: basis.arg } : {}),
    ...(basis.kind === 'policy-terminal' ? { decisionClass: basis.arg } : {}),
    taskId: issue,
    ...(paneTargetFor(input) ? { paneTarget: paneTargetFor(input) } : {}),
    since: isoToMs(marker.writtenAt, nowMs),
    summary: reason || `${issue} escalated (${basis.kind} ${basis.arg})`,
    evidence,
    commands,
    condition,
  };
}

function incidentItems(incidents: readonly AttentionIncidentInput[], nowMs: number): AttentionItem[] {
  const byFingerprint = new Map<string, AttentionItem>();
  for (const { incident, reconciliation } of incidents) {
    // Escalated (lifecycle `active`, as the incidents panel shows) and still
    // current by the one HOK-3324 job-truth disposition.
    if (incident.lifecycle !== 'active' || reconciliation.outcome !== 'confirmed_active') continue;
    const affected = [incident.taskId, ...(incident.metadata?.knownIssueIds ?? [])]
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    const existing = byFingerprint.get(incident.fingerprint);
    if (existing) {
      existing.affectedTaskIds = [...new Set([...(existing.affectedTaskIds ?? []), ...affected])].sort();
      continue;
    }
    byFingerprint.set(incident.fingerprint, {
      id: `incident:${incident.fingerprint}`,
      kind: 'incident',
      incidentId: incident.fingerprint,
      affectedTaskIds: [...new Set(affected)].sort(),
      since: isoToMs(incident.firstObservedAt, nowMs),
      summary: incident.summary,
      evidence: [{ source: 'incident', summary: `${incident.severity}: ${incident.summary}` }],
      commands: incident.operatorAction
        ? [{ label: incident.operatorAction, argv: [] }]
        : [],
    });
  }
  return [...byFingerprint.values()];
}

function freeItems(inputs: readonly AttentionFreeItemInput[], nowMs: number): AttentionItem[] {
  return inputs.map((input) => ({
    id: `${input.kind}:${input.key}`,
    kind: input.kind,
    ...(input.affectedTaskIds && input.affectedTaskIds.length > 0
      ? { affectedTaskIds: [...new Set(input.affectedTaskIds)].sort() }
      : {}),
    since: input.sinceMs ?? nowMs,
    summary: input.summary,
    evidence: input.evidence,
    commands: [],
  }));
}

/** Sort by the fixed kind precedence, then age, then id. */
export function compareAttentionItems(a: AttentionItem, b: AttentionItem): number {
  return ATTENTION_KIND_RANK[a.kind] - ATTENTION_KIND_RANK[b.kind]
    || a.since - b.since
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The one inbox membership and ordering decision (HOK-3423). Pure: every
 * input is a record an existing primitive already wrote.
 */
export function deriveAttentionItems(inputs: AttentionInputs): AttentionProjection {
  const items: AttentionItem[] = [];
  for (const task of inputs.tasks) {
    const plan = approvePlanItem(task, inputs.nowMs);
    if (plan) items.push(plan);
    const answer = answerAgentItem(task, inputs.nowMs, plan);
    if (answer) items.push(answer);
    const blocked = blockedCompletionItem(task);
    if (blocked) items.push(blocked);
    const escalated = escalationItem(task, inputs.nowMs);
    if (escalated) items.push(escalated);
  }
  items.push(...incidentItems(inputs.incidents, inputs.nowMs));
  items.push(...freeItems(inputs.freeItems ?? [], inputs.nowMs));
  items.sort(compareAttentionItems);
  return {
    schemaVersion: ATTENTION_PROJECTION_SCHEMA_VERSION,
    passStampMs: inputs.passStampMs,
    staleAfterMs: inputs.staleAfterMs,
    computedAt: new Date(inputs.nowMs).toISOString(),
    items,
  };
}

// ── Gather (I/O) and write ─────────────────────────────────────────────────

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Hash the task packet exactly as `plan_packet_current_hash`
 * (plan-packet-binding.sh) does: header+details when both exist, then the
 * single-file packet, concatenated.
 */
export function currentPacketHash(featureDir: string): string | null {
  const header = join(featureDir, 'task-packet-header.md');
  const details = join(featureDir, 'task-packet-details.md');
  const single = join(featureDir, 'task-packet.md');
  const files: string[] = [];
  if (existsSync(header) && existsSync(details)) files.push(header, details);
  if (existsSync(single)) files.push(single);
  if (files.length === 0) return null;
  const hash = createHash('sha256');
  try {
    for (const file of files) hash.update(readFileSync(file));
  } catch {
    return null;
  }
  return hash.digest('hex');
}

/** Read the HOK-3360 `.needs-attention` marker. Legacy (non-JSON) bodies carry no basis. */
export function readAttentionMarker(featureDir: string): AttentionMarkerInput | null {
  const payload = readJson<MarkerPayload>(join(featureDir, '.needs-attention'));
  if (!payload || typeof payload !== 'object' || payload.schemaVersion !== 1 || typeof payload.headSha !== 'string') {
    return null;
  }
  return { payload };
}

export function readPlanningInput(featureDir: string): AttentionPlanningInput {
  const resultPath = getResultFilePath(featureDir, 'planning');
  const result = readJson<{ status?: string; finishedAt?: string; startedAt?: string }>(resultPath);
  const binding = readJson<{ packetHash?: string }>(join(featureDir, '.plan-packet-hash'));
  const rejectionPath = join(featureDir, '.planning-rejected.json');
  const rejected = readJson<{
    reason?: string;
    outOfScopeFiles?: string[];
    notifiedAt?: string;
    notifyStatus?: string;
    notifyAttempts?: number | string;
    notifyTarget?: string;
  }>(rejectionPath);
  let reapprovalReason: string | null = null;
  try {
    reapprovalReason = readFileSync(join(featureDir, '.plan-reapproval-reason'), 'utf-8').split(/\r?\n/, 1)[0]?.trim() || null;
  } catch {
    reapprovalReason = null;
  }
  const attempts = rejected?.notifyAttempts;
  return {
    resultStatus: result?.status ?? null,
    resultAtMs: mtimeMs(resultPath),
    planPresent: existsSync(join(featureDir, 'plan.md')),
    planApproved: existsSync(join(featureDir, '.plan-approved')),
    recordedPacketHash: typeof binding?.packetHash === 'string' && binding.packetHash ? binding.packetHash : null,
    currentPacketHash: currentPacketHash(featureDir),
    reapprovalReason,
    rejection: rejected
      ? {
          reason: rejected.reason ?? null,
          outOfScopeFiles: Array.isArray(rejected.outOfScopeFiles) ? rejected.outOfScopeFiles.map(String) : [],
          notifiedAt: rejected.notifiedAt || null,
          notifyStatus: rejected.notifyStatus ?? null,
          notifyAttempts: attempts == null || attempts === '' ? null : Number(attempts),
          notifyTarget: rejected.notifyTarget || null,
          atMs: mtimeMs(rejectionPath) ?? 0,
        }
      : null,
  };
}

export function readBlockedCompletionInput(featureDir: string): AttentionBlockedCompletionInput {
  const blockedPath = join(featureDir, '.coding-blocked-completion.json');
  const uncommittedPath = join(featureDir, '.coding-uncommitted-output.json');
  const blockedAt = mtimeMs(blockedPath);
  const uncommittedAt = mtimeMs(uncommittedPath);
  const blocked = blockedAt === null ? null : readJson<{ summary?: string }>(blockedPath);
  const uncommitted = uncommittedAt === null ? null : readJson<{ summary?: string; action?: string }>(uncommittedPath);
  return {
    autoAdvanced: existsSync(join(featureDir, '.coding-auto-advance.json')),
    blocked: blockedAt === null ? null : { summary: blocked?.summary?.trim() || null, atMs: blockedAt },
    uncommitted: uncommittedAt === null
      ? null
      : { summary: uncommitted?.summary?.trim() || null, action: uncommitted?.action?.trim() || null, atMs: uncommittedAt },
  };
}

/** The feature dir a task's stage artifacts live in (features/, else bugs/). */
export function taskFeatureDir(task: AttentionTaskRecord): string | null {
  if (!task.worktree || !task.slug) return null;
  const features = join(task.worktree, 'features', task.slug);
  if (existsSync(features)) return features;
  const bugs = join(task.worktree, 'bugs', task.slug);
  return existsSync(bugs) ? bugs : null;
}

/** Atomically replace the projection file (single writer: the tracked job). */
export function writeAttentionProjection(outputPath: string, projection: AttentionProjection): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  const tmp = `${outputPath}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(projection, null, 2)}\n`, 'utf-8');
  renameSync(tmp, outputPath);
}

export interface GatherAttentionOptions {
  repoDir: string;
  stateDir: string;
  stateFile?: string;
  session: string;
  passStampMs: number;
  staleAfterMs: number;
  nowMs?: number;
  /** Max cache age before the task-progress primitive is recomputed. */
  progressMaxAgeSeconds?: number;
  /** Test seams. */
  progressFor?: (issue: string, task: TaskRecord, featureDir: string | null) => AttentionTaskInput['progress'];
  incidentsFor?: () => Promise<AttentionIncidentInput[]>;
}

/**
 * Task progress through the HOK-3101 primitive: the shared cache when it is
 * fresh, else one computation (with the pane text for the blocking-prompt
 * matcher) that refreshes the cache for the dashboard. Never a raw hook read.
 */
export function readTaskProgressForAttention(
  session: string,
  issue: string,
  task: TaskRecord,
  featureDir: string | null,
  maxAgeSeconds: number,
): AttentionTaskInput['progress'] {
  const cachePath = `/tmp/wavemill-${session}-${issue}.progress.json`;
  const hookPath = `/tmp/wavemill-${session}-${issue}.hook`;
  const cached = readJson<TaskProgress>(cachePath);
  if (cached && progressCacheIsFresh(cached, maxAgeSeconds, new Date(), mtimeMs(hookPath))) return cached;
  const paneText = task.windowId ? termCapture(task.windowId, { lines: 200, timeoutMs: 3000 }) ?? undefined : undefined;
  try {
    const progress = getTaskProgress({
      issue,
      session,
      task,
      ...(featureDir ? { featureDir } : {}),
      ...(task.phase ? { phase: task.phase } : {}),
      ...(paneText ? { paneText } : {}),
    });
    try {
      const tmp = `${cachePath}.tmp.${process.pid}`;
      writeFileSync(tmp, JSON.stringify(progress), 'utf-8');
      renameSync(tmp, cachePath);
    } catch {
      // cache refresh is best-effort
    }
    return progress;
  } catch {
    return null;
  }
}

// ── Non-task signals (HOK-3424) ────────────────────────────────────────────
//
// The four dashboard header lines each read one file privately. They become
// free attention items here so the inbox renders them and no reader re-derives
// "does this need a human". None carries a taskId.

function readQueueHealthFreeItem(stateDir: string): AttentionFreeItemInput | null {
  const path = join(stateDir, 'queue-health.json');
  const health = readJson<QueueHealthStateLike & { currentAlertProjection?: unknown }>(path);
  if (!health || typeof health !== 'object') return null;
  const stored = health.currentAlertProjection;
  const projection = stored && typeof stored === 'object'
    ? stored as { status?: unknown; summary?: unknown; nextAction?: unknown; episode?: { startedAt?: unknown } | null }
    : deriveQueueAlertProjection({ queueHealth: health, nowMs: Date.now() });
  const status = typeof projection.status === 'string' ? projection.status : 'unknown';
  if (status === 'healthy') return null;
  const summary = typeof projection.summary === 'string' && projection.summary.trim()
    ? projection.summary.trim()
    : `queue status: ${status}`;
  const nextAction = typeof projection.nextAction === 'string' ? projection.nextAction : null;
  const startedAt = projection.episode?.startedAt;
  const sinceMs = typeof startedAt === 'string' ? Date.parse(startedAt) : NaN;
  return {
    kind: 'queue-health',
    key: status,
    summary,
    ...(Number.isFinite(sinceMs) ? { sinceMs } : {}),
    evidence: [{
      source: 'queue-health.json',
      path,
      summary: nextAction ? `${status} (next: ${nextAction})` : status,
    }],
  };
}

/** Statuses that mean a service needs a look (mirrors the old header line). */
function backstageServiceUnhealthy(status: string, progressState: string | null): boolean {
  if (!status) return false;
  if (progressState === 'stalled' && status === 'healthy') return true;
  if (status === 'healthy' || status === 'disabled') return false;
  return /^(degraded|needs-user|stalled|alive-|missing-|stale-|backstage-missing)/.test(status);
}

function readBackstageHealthFreeItem(stateDir: string): AttentionFreeItemInput | null {
  const path = join(stateDir, 'backstage-health.json');
  const health = readJson<{
    status?: unknown;
    services?: Record<string, { status?: unknown; progressState?: unknown } | undefined>;
  }>(path);
  if (!health || typeof health !== 'object') return null;
  const lines: string[] = [];
  for (const service of ['tend', 'observer'] as const) {
    const entry = health.services?.[service];
    const status = typeof entry?.status === 'string' ? entry.status : '';
    const progressState = typeof entry?.progressState === 'string' ? entry.progressState : null;
    if (backstageServiceUnhealthy(status, progressState)) {
      lines.push(`${service}: ${status === 'healthy' && progressState === 'stalled' ? 'alive-not-progressing' : status}`);
    }
  }
  if (lines.length === 0) return null;
  return {
    kind: 'backstage-health',
    key: lines.map((line) => line.split(':')[0]).join(','),
    summary: `backstage unhealthy — ${lines.join(' │ ')}`,
    ...(mtimeMs(path) !== null ? { sinceMs: mtimeMs(path) as number } : {}),
    evidence: [{ source: 'backstage-health.json', path, summary: lines.join(' │ ') }],
  };
}

export function openRouterWarningCachePath(session: string): string {
  return `/tmp/${session}-openrouter-warning.txt`;
}

function readOpenRouterFreeItem(session: string): AttentionFreeItemInput | null {
  const path = openRouterWarningCachePath(session);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  const warning = raw.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  if (!warning) return null;
  return {
    kind: 'openrouter',
    key: shortKey(warning),
    summary: warning,
    ...(mtimeMs(path) !== null ? { sinceMs: mtimeMs(path) as number } : {}),
    evidence: [{ source: 'openrouter-warning-cache', path, summary: warning }],
  };
}

function readMalformedChallengeFreeItem(state: WorkflowState, stateDir: string): AttentionFreeItemInput | null {
  const keys = workflowTaskEntries(state)
    // HOK-2926: a challenge stub with no slug is filtered out of the task list
    // but may still have a live window. Diagnostic only; no state inference.
    .filter(([, task]) => typeof task.challengePairId === 'string' && task.challengePairId !== '' && !task.slug)
    .map(([taskId]) => taskId)
    .sort();
  if (keys.length === 0) return null;
  const summary = keys.length === 1
    ? `challenge pair entry ${keys[0]} has no slug: arm is hidden but may still be running; repair state (HOK-2926)`
    : `${keys.length} challenge pair entries have no slug (${keys.join(', ')}): arms are hidden but may still be running; repair state (HOK-2926)`;
  const statePath = join(stateDir, 'workflow-state.json');
  return {
    kind: 'malformed-challenge',
    key: keys.join(','),
    summary,
    ...(mtimeMs(statePath) !== null ? { sinceMs: mtimeMs(statePath) as number } : {}),
    evidence: [{ source: 'workflow-state.json', path: statePath, summary: `no-slug challenge entries: ${keys.join(', ')}` }],
    affectedTaskIds: keys,
  };
}

/** Read the four non-task signals from their existing files. Never throws. */
export function readNonTaskAttentionInputs(opts: {
  stateDir: string;
  session: string;
  state: WorkflowState;
}): AttentionFreeItemInput[] {
  const items: AttentionFreeItemInput[] = [];
  const queue = readQueueHealthFreeItem(opts.stateDir);
  if (queue) items.push(queue);
  const backstage = readBackstageHealthFreeItem(opts.stateDir);
  if (backstage) items.push(backstage);
  const openrouter = readOpenRouterFreeItem(opts.session);
  if (openrouter) items.push(openrouter);
  const challenge = readMalformedChallengeFreeItem(opts.state, opts.stateDir);
  if (challenge) items.push(challenge);
  return items;
}

async function readConfirmedIncidents(repoDir: string, stateDir: string): Promise<AttentionIncidentInput[]> {
  const incidentsDir = join(stateDir, 'incidents');
  if (!existsSync(join(incidentsDir, 'index.json'))) return [];
  const incidents = await new IncidentStore(incidentsDir).getIncidents();
  if (incidents.length === 0) return [];
  const jobs = readAuthoritativeWorkflowJobs(repoDir);
  return incidents.map((incident) => ({ incident, reconciliation: reconcileIncidentForFiling(incident, repoDir, jobs) }));
}

/** Read every attention source from disk. The only I/O on the projection path. */
export async function gatherAttentionInputs(opts: GatherAttentionOptions): Promise<AttentionInputs> {
  const stateFile = opts.stateFile ?? join(opts.stateDir, 'workflow-state.json');
  const state = readWorkflowState(stateFile);
  const watchdog = readJson<ReadyWatchdogStateFile>(join(opts.stateDir, 'ready-watchdog-state.json'));
  const maxAge = opts.progressMaxAgeSeconds ?? 60;
  const tasks: AttentionTaskInput[] = [];
  for (const [taskId, task] of workflowTaskEntries(state)) {
    if (isSettled(task) || task.status === 'merged') continue;
    const featureDir = taskFeatureDir(task);
    const progress = opts.progressFor
      ? opts.progressFor(taskId, task, featureDir)
      : readTaskProgressForAttention(opts.session, taskId, task, featureDir, maxAge);
    tasks.push({
      taskId,
      task: { slug: task.slug, phase: task.phase, status: task.status, worktree: task.worktree, windowId: task.windowId },
      featureDir,
      progress,
      needsAttention: featureDir ? readAttentionMarker(featureDir) : null,
      planning: featureDir ? readPlanningInput(featureDir) : null,
      blockedCompletion: featureDir ? readBlockedCompletionInput(featureDir) : null,
      readyWatchdog: watchdog?.tasks?.[taskId] ?? null,
    });
  }
  const incidents = opts.incidentsFor
    ? await opts.incidentsFor()
    : await readConfirmedIncidents(opts.repoDir, opts.stateDir);
  const freeItems = readNonTaskAttentionInputs({ stateDir: opts.stateDir, session: opts.session, state });
  return {
    passStampMs: opts.passStampMs,
    staleAfterMs: opts.staleAfterMs,
    nowMs: opts.nowMs ?? Date.now(),
    tasks,
    incidents,
    freeItems,
  };
}
