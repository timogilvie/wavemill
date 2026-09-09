export const WAVEMILL_INCIDENT_SCHEMA_VERSION = '1.1';

export type IncidentCategory =
  | 'product_defect'
  | 'model_task_harness_outcome'
  | 'external_transient_dependency'
  | 'configuration_operator_condition'
  | 'stale_orphaned_state';

export type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type IncidentConfidence = 'definite' | 'high' | 'medium' | 'low';
export type IncidentLifecycle = 'observed' | 'active' | 'resolved' | 'archived';

/**
 * Bounded root-cause taxonomy. `rootCauseClass` must always be one of these
 * values; raw diagnostic text belongs in evidence `redactedData`, never in the
 * class itself. Unbounded free-text classes defeat fingerprint dedup (HOK-2929).
 */
export const INCIDENT_ROOT_CAUSE_CLASSES = [
  // Planning terminal reasons (model_task_harness_outcome)
  'turn_limit',
  'tool_call_limit',
  'wall_clock_limit',
  'tool_stagnation',
  'invalid_plan',
  'empty_final_plan',
  'provider_error',
  'aborted',
  // Workflow / background-job state
  'orphaned_completion_marker',
  'failed_background_job',
  'failed_job_no_result',
  'missing_eval_records_for_comparison',
  // Affirmatively remote dependency failures (external_transient_dependency)
  'remote_ssh_failure',
  'remote_timeout',
  'remote_auth_failure',
  'remote_dependency_failure',
  // Local harness / configuration conditions
  'local_parse_failure',
  'local_config_failure',
  'native_completion_protocol_failure',
  'harness_liveness_deadlock',
  'queue_planner_degraded',
  // Ready/Tend stalled lifecycle correlation
  'review_context_overflow_stale_base',
  'provider_quota_exhaustion_blocking_review',
  'challenge_arm_missing_current_head_eval',
  'inspection_required',
  'cleanup_retained_by_policy',
  'cleanup_unpublished_at_risk',
  'cleanup_verification_unavailable',
  'cleanup_dirty_worktree',
  'config_drift_base_branch',
  'config_drift_confirm',
  'unclassified_local_failure',
] as const;

export type IncidentRootCauseClass = typeof INCIDENT_ROOT_CAUSE_CLASSES[number];

const ROOT_CAUSE_CLASS_SET = new Set<string>(INCIDENT_ROOT_CAUSE_CLASSES);

/**
 * Map raw diagnostic text (or a legacy slugified class) to a stable bounded
 * class. Local harness signatures are checked before remote ones so hook text
 * mentioning git/github incidentally is not mislabelled as a remote dependency
 * failure; typed native completion-protocol reasons (HOK-2933) take precedence.
 */
export function canonicalizeRootCauseClass(raw: string): IncidentRootCauseClass {
  const value = (raw ?? '').trim();
  if (ROOT_CAUSE_CLASS_SET.has(value)) return value as IncidentRootCauseClass;
  const lower = value.toLowerCase();
  if (/native[-_ ]completion[-_ ]protocol|no_completion_artifact|invalid_completion_artifact|coding[-_ ]complete|coding[-_ ]blocked[-_ ]completion/.test(lower)) {
    return 'native_completion_protocol_failure';
  }
  if (/blocked[-_ ]completion|live blocking command|auto[-_ ]advance[-_ ]refused/.test(lower)) {
    return 'harness_liveness_deadlock';
  }
  if (/failed[-_ ]to[-_ ]parse|unexpected[-_ ]token|parse[-_ ]error|syntax[-_ ]error|malformed[-_ ]json/.test(lower)) {
    return 'local_parse_failure';
  }
  if (/invalid[-_ ]config|schema[-_ ]validation|missing[-_ ]config/.test(lower)) {
    return 'local_config_failure';
  }
  if (/cleanup[-_ ]retained[-_ ]by[-_ ]policy/.test(lower)) return 'cleanup_retained_by_policy';
  if (/cleanup[-_ ]unpublished[-_ ]at[-_ ]risk/.test(lower)) return 'cleanup_unpublished_at_risk';
  if (/cleanup[-_ ]verification[-_ ]unavailable/.test(lower)) return 'cleanup_verification_unavailable';
  if (/cleanup[-_ ]dirty[-_ ]worktree/.test(lower)) return 'cleanup_dirty_worktree';
  if (/config[-_ ]drift[-_ ]base[-_ ]branch/.test(lower)) return 'config_drift_base_branch';
  if (/config[-_ ]drift[-_ ]confirm/.test(lower)) return 'config_drift_confirm';
  if (/ls-remote|ssh|publickey|github/.test(lower)) return 'remote_ssh_failure';
  if (/timeout|timed[-_ ]out/.test(lower)) return 'remote_timeout';
  if (/credential|permission|auth/.test(lower)) return 'remote_auth_failure';
  return 'unclassified_local_failure';
}

/** True when the class describes an affirmatively remote dependency failure. */
export function isRemoteRootCauseClass(rootCauseClass: IncidentRootCauseClass): boolean {
  return rootCauseClass.startsWith('remote_');
}

export type IncidentResolutionAction = 'auto_resolved' | 'operator_resolved' | 'operator_archived';

export interface IncidentResolutionMetadata {
  action: IncidentResolutionAction;
  at: string;
  reason?: string;
}

export interface IncidentRecurrenceMetadata {
  /** Number of times a resolved/archived record was reopened by a new distinct event. */
  count: number;
  lastRecurredAt: string;
  /** Lifecycle the record held when the recurrence reopened it. */
  reopenedFrom: IncidentLifecycle;
}

export type IncidentEvidenceType =
  | 'planning_result'
  | 'workflow_state'
  | 'job_state'
  | 'hook_status'
  | 'backstage_health'
  | 'pr_metadata'
  | 'review_result'
  | 'challenge_pair_state'
  | 'eval_fallback_event'
  | 'quota_state'
  | 'log_excerpt';

export type RemediationProposalKind =
  | 'refresh_base_and_rereview'
  | 'provider_retry_or_forfeit_inspection'
  | 'inspection_only';

export type RemediationForbiddenAction =
  | 'add_ready_label'
  | 'merge'
  | 'destructive_git'
  | 'delete_branch';

export interface RemediationProposal {
  schemaVersion: '1.1';
  kind: RemediationProposalKind;
  prerequisites: string[];
  retryKey: string;
  safetyLevel: 'inspect' | 'safe_read' | 'operator_only';
  evidenceRefs: Array<{ index: number; type: IncidentEvidenceType; source: string }>;
  forbiddenActions: RemediationForbiddenAction[];
  recoveryPredicate?: {
    kind: 'head_changed' | 'review_now_ready' | 'current_head_eval_present' | 'comparison_present';
    details: Record<string, string>;
  };
}

export interface CausalChainEntry {
  cause: string;
  evidenceIndex: number;
  detail?: string;
}

export interface IncidentEvidence {
  type: IncidentEvidenceType;
  source: string;
  timestamp: string;
  lineNumber?: number;
  redactedData: string;
  key?: string;
}

export interface IncidentMetadata {
  thresholdTriggered?: boolean;
  cooldownExpiresAt?: string;
  escalatedAt?: string;
  /** Linear issue identifier such as HOK-2596 linked to this incident fingerprint. */
  linkedLinearId?: string;
  /** Full Linear URL for the linked issue when Linear returned one. */
  linkedLinearUrl?: string;
  /** Last successful Observer-to-Linear sync timestamp. */
  lastSyncedAt?: string;
  /** Stable SHA256 revision of the evidence bundle last written to Linear. */
  lastSyncedEvidenceRevision?: string;
  /** Earliest timestamp at which a changed evidence revision may add another comment. */
  syncCooldownUntil?: string;
  /** Number of successful issue create/comment syncs for this incident. */
  updateCount?: number;
  /** Recent sync failures retained for audit without crashing the observer. */
  syncErrors?: Array<{
    at: string;
    action: string;
    category?: string;
    message: string;
    retryQueued?: boolean;
  }>;
  /** Explicit issue identifiers supplied by the incident detector for correlation. */
  knownIssueIds?: string[];
  /** Stable keys of distinct source events already counted, capped; polling an unchanged event is a no-op. */
  seenEventKeys?: string[];
  /** Timestamp of the last distinct source event (as opposed to the last poll). */
  lastEventAt?: string;
  proposal?: RemediationProposal;
  causalChain?: CausalChainEntry[];
  authoritativeHead?: string;
  authoritativeBase?: string;
  pairId?: string;
  /** Consecutive successful observer cycles without a fresh distinct event. */
  missedCycles?: number;
  /** How and when the record last transitioned to resolved/archived. */
  resolution?: IncidentResolutionMetadata;
  /** Recurrence audit trail: set when a resolved/archived record is reopened. */
  recurrence?: IncidentRecurrenceMetadata;
  [key: string]: unknown;
}

export interface IncidentRecord {
  schemaVersion: typeof WAVEMILL_INCIDENT_SCHEMA_VERSION;
  id: string;
  fingerprint: string;
  taskId?: string | null;
  session?: string | null;
  category: IncidentCategory;
  severity: IncidentSeverity;
  confidence: IncidentConfidence;
  lifecycle: IncidentLifecycle;
  createdAt: string;
  /** When the first distinct event for this fingerprint was observed; backfilled on legacy records. */
  firstObservedAt: string;
  lastObservedAt: string;
  /** Number of distinct source events (not poll cycles) attributed to this fingerprint. */
  occurrenceCount: number;
  rootCauseClass: IncidentRootCauseClass;
  summary: string;
  operatorAction: string;
  evidence: IncidentEvidence[];
  metadata: IncidentMetadata;
}

export type NewIncidentRecord = Omit<
  IncidentRecord,
  'schemaVersion' | 'id' | 'fingerprint' | 'createdAt' | 'firstObservedAt' | 'lastObservedAt' | 'occurrenceCount'
> & Partial<Pick<IncidentRecord, 'schemaVersion' | 'id' | 'fingerprint' | 'createdAt' | 'firstObservedAt' | 'lastObservedAt' | 'occurrenceCount'>>;

export function createIncidentDraft(input: NewIncidentRecord): IncidentRecord {
  return {
    schemaVersion: WAVEMILL_INCIDENT_SCHEMA_VERSION,
    id: input.id ?? '',
    fingerprint: input.fingerprint ?? '',
    taskId: input.taskId ?? null,
    session: input.session ?? null,
    category: input.category,
    severity: input.severity,
    confidence: input.confidence,
    lifecycle: input.lifecycle,
    createdAt: input.createdAt ?? '',
    firstObservedAt: input.firstObservedAt ?? '',
    lastObservedAt: input.lastObservedAt ?? '',
    occurrenceCount: input.occurrenceCount ?? 0,
    rootCauseClass: input.rootCauseClass,
    summary: input.summary,
    operatorAction: input.operatorAction,
    evidence: input.evidence,
    metadata: input.metadata ?? {},
  };
}
