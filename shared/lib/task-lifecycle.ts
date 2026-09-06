export const TASK_LIFECYCLE_SCHEMA_VERSION = 1 as const;

export const WORKFLOW_OUTCOMES = ['active', 'merged', 'closed', 'aborted', 'error'] as const;
export const RESOURCE_DISPOSITIONS = [
  'allocated',
  'released',
  'retained',
  'reaping',
  'reaped',
  'verification-required',
] as const;

export type WorkflowOutcome = typeof WORKFLOW_OUTCOMES[number];
export type ResourceDisposition = typeof RESOURCE_DISPOSITIONS[number];

export interface LifecycleRetention {
  reason: string;
  policy?: string;
  actor?: string;
  timestamp?: string;
  evidence?: unknown;
}

export interface RemoteBranchDeletionPolicy {
  allowed: boolean;
  mode?: string;
  reason?: string;
  source?: string;
}

export interface LaunchContract {
  baseBranch?: string;
  baseSha?: string;
  integrationMode?: string;
  mergeMethod?: string;
  remoteBranchDeletionPolicy: RemoteBranchDeletionPolicy;
  challengeRole?: string;
  challengePairId?: string;
  session?: string;
  runEpoch?: string;
  windowId?: string;
}

export interface DeliveryEvidence {
  reviewedHeadSha?: string;
  publishedHeadSha?: string;
  prHeadSha?: string;
  prNumber?: string;
  prState?: string;
  prBaseBranch?: string;
  mergeSha?: string;
  [key: string]: unknown;
}

export interface TaskLifecycleState {
  schemaVersion: typeof TASK_LIFECYCLE_SCHEMA_VERSION;
  workflowOutcome: WorkflowOutcome;
  resourceDisposition: ResourceDisposition;
  retention?: LifecycleRetention;
  launchContract?: LaunchContract;
  deliveryEvidence?: DeliveryEvidence;
  normalizedFromLegacy?: boolean;
  verificationRequiredReason?: string;
  [key: string]: unknown;
}

export interface NormalizedTaskLifecycle {
  lifecycle: TaskLifecycleState;
  slotConsumes: boolean;
  branchDeletionAuthorized: boolean;
  validationErrors: string[];
}

const WORKFLOW_OUTCOME_SET = new Set<string>(WORKFLOW_OUTCOMES);
const RESOURCE_DISPOSITION_SET = new Set<string>(RESOURCE_DISPOSITIONS);
const TERMINAL_STATUS = new Set(['merged', 'complete', 'completed', 'completed-external', 'closed', 'done', 'aborted']);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function isWorkflowOutcome(value: unknown): value is WorkflowOutcome {
  return typeof value === 'string' && WORKFLOW_OUTCOME_SET.has(value);
}

export function isResourceDisposition(value: unknown): value is ResourceDisposition {
  return typeof value === 'string' && RESOURCE_DISPOSITION_SET.has(value);
}

export function workflowOutcomeFromLegacy(taskInput: unknown): WorkflowOutcome {
  const task = record(taskInput);
  const status = text(task.status);
  const phase = text(task.phase);

  if (status === 'merged' || phase === 'done') return 'merged';
  if (status === 'closed' || status === 'completed-external' || status === 'complete' || status === 'completed' || status === 'done' || phase === 'closed') return 'closed';
  if (status === 'aborted' || phase === 'aborted') return 'aborted';
  if (status === 'error' || phase === 'error') return 'error';
  return 'active';
}

export function legacyIsTerminal(taskInput: unknown): boolean {
  const task = record(taskInput);
  const status = text(task.status);
  const phase = text(task.phase);
  return (status !== undefined && TERMINAL_STATUS.has(status)) || status === 'error' || phase === 'error' || phase === 'closed' || phase === 'aborted' || phase === 'done';
}

function hasRetention(lifecycle: Record<string, unknown>): boolean {
  const retention = record(lifecycle.retention);
  return typeof retention.reason === 'string' && retention.reason.length > 0;
}

function deletionPolicyAllowed(policy: unknown): boolean {
  const value = record(policy);
  return bool(value.allowed) === true && typeof value.mode === 'string' && value.mode.length > 0;
}

function normalizeLaunchContract(value: unknown): LaunchContract | undefined {
  const contract = record(value);
  const policy = record(contract.remoteBranchDeletionPolicy);
  const allowed = bool(policy.allowed);
  if (allowed === undefined) return undefined;

  return {
    ...(text(contract.baseBranch) ? { baseBranch: text(contract.baseBranch) } : {}),
    ...(text(contract.baseSha) ? { baseSha: text(contract.baseSha) } : {}),
    ...(text(contract.integrationMode) ? { integrationMode: text(contract.integrationMode) } : {}),
    ...(text(contract.mergeMethod) ? { mergeMethod: text(contract.mergeMethod) } : {}),
    remoteBranchDeletionPolicy: {
      allowed,
      ...(text(policy.mode) ? { mode: text(policy.mode) } : {}),
      ...(text(policy.reason) ? { reason: text(policy.reason) } : {}),
      ...(text(policy.source) ? { source: text(policy.source) } : {}),
    },
    ...(text(contract.challengeRole) ? { challengeRole: text(contract.challengeRole) } : {}),
    ...(text(contract.challengePairId) ? { challengePairId: text(contract.challengePairId) } : {}),
    ...(text(contract.session) ? { session: text(contract.session) } : {}),
    ...(text(contract.runEpoch) ? { runEpoch: text(contract.runEpoch) } : {}),
    ...(text(contract.windowId) ? { windowId: text(contract.windowId) } : {}),
  };
}

export function slotConsumesResource(disposition: ResourceDisposition): boolean {
  return disposition === 'allocated' || disposition === 'reaping';
}

export function validateTaskLifecycleState(lifecycleInput: unknown): string[] {
  const lifecycle = record(lifecycleInput);
  const errors: string[] = [];
  const workflowOutcome = lifecycle.workflowOutcome;
  const resourceDisposition = lifecycle.resourceDisposition;

  if (!isWorkflowOutcome(workflowOutcome)) errors.push('workflowOutcome is invalid');
  if (!isResourceDisposition(resourceDisposition)) errors.push('resourceDisposition is invalid');

  if (isWorkflowOutcome(workflowOutcome) && isResourceDisposition(resourceDisposition)) {
    if (workflowOutcome === 'active' && resourceDisposition === 'reaped') {
      errors.push('active workflow cannot have reaped resources');
    }
    if (workflowOutcome !== 'active' && (resourceDisposition === 'allocated' || resourceDisposition === 'retained' || resourceDisposition === 'verification-required') && !hasRetention(lifecycle)) {
      errors.push(`${workflowOutcome} + ${resourceDisposition} requires retention.reason`);
    }
  }

  const launchContract = normalizeLaunchContract(lifecycle.launchContract);
  if (lifecycle.launchContract !== undefined && !launchContract) {
    errors.push('launchContract.remoteBranchDeletionPolicy.allowed must be explicit');
  }

  return errors;
}

export function normalizeTaskLifecycle(taskInput: unknown): NormalizedTaskLifecycle {
  const task = record(taskInput);
  const existing = record(task.lifecycle);
  const outcome = isWorkflowOutcome(existing.workflowOutcome) ? existing.workflowOutcome : workflowOutcomeFromLegacy(task);
  let disposition: ResourceDisposition | undefined = isResourceDisposition(existing.resourceDisposition)
    ? existing.resourceDisposition
    : undefined;
  const retention = record(existing.retention);
  const launchContract = normalizeLaunchContract(existing.launchContract);
  const reasons: string[] = [];

  if (!disposition) {
    if ((task.executionOwner === 'queue' && task.paneState === 'released') || task.paneState === 'released') {
      disposition = 'released';
    } else if (legacyIsTerminal(task)) {
      disposition = 'verification-required';
      reasons.push('legacy-terminal-resource-state');
    } else {
      disposition = 'allocated';
    }
  }

  if (!launchContract) {
    reasons.push('missing-launch-contract');
  } else if (!deletionPolicyAllowed(launchContract.remoteBranchDeletionPolicy) && outcome !== 'active') {
    reasons.push('remote-branch-deletion-unauthorized');
  }

  let normalizedRetention: LifecycleRetention | undefined = hasRetention(existing)
    ? {
      reason: String(retention.reason),
      ...(text(retention.policy) ? { policy: text(retention.policy) } : {}),
      ...(text(retention.actor) ? { actor: text(retention.actor) } : {}),
      ...(text(retention.timestamp) ? { timestamp: text(retention.timestamp) } : {}),
      ...(retention.evidence !== undefined ? { evidence: retention.evidence } : {}),
    }
    : undefined;

  if (outcome !== 'active' && (disposition === 'allocated' || disposition === 'retained' || disposition === 'verification-required') && !normalizedRetention) {
    disposition = 'verification-required';
    reasons.push('terminal-resource-retention-unexplained');
    normalizedRetention = {
      reason: 'verification-required',
      policy: 'manual-verification-required',
      actor: 'task-lifecycle-normalizer',
      evidence: {
        status: task.status ?? null,
        phase: task.phase ?? null,
        paneState: task.paneState ?? null,
        executionOwner: task.executionOwner ?? null,
      },
    };
  }

  const deliveryEvidence = record(existing.deliveryEvidence);
  const lifecycle: TaskLifecycleState = {
    ...existing,
    schemaVersion: TASK_LIFECYCLE_SCHEMA_VERSION,
    workflowOutcome: outcome,
    resourceDisposition: disposition,
    ...(normalizedRetention ? { retention: normalizedRetention } : {}),
    ...(launchContract ? { launchContract } : {}),
    ...(Object.keys(deliveryEvidence).length > 0 ? { deliveryEvidence } : {}),
    ...(task.lifecycle === undefined ? { normalizedFromLegacy: true } : {}),
    ...(reasons.length > 0 ? { verificationRequiredReason: reasons.join(',') } : {}),
  };
  const validationErrors = validateTaskLifecycleState(lifecycle);
  const branchDeletionAuthorized = Boolean(launchContract && deletionPolicyAllowed(launchContract.remoteBranchDeletionPolicy) && validationErrors.length === 0);

  return {
    lifecycle,
    slotConsumes: slotConsumesResource(disposition),
    branchDeletionAuthorized,
    validationErrors,
  };
}
