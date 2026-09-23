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
  'module_export_contract_mismatch',
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
  // Active-task delivery risk (HOK-2972): not a cleanup class - the task is
  // still alive, the work is unpublished, and the task has stopped progressing.
  'active_unpublished_work_stalled',
  'cleanup_verification_unavailable',
  'cleanup_dirty_worktree',
  'config_drift_base_branch',
  'config_drift_confirm',
  // Parked/terminal-arm delivery gaps (HOK-2927; stale_orphaned_state)
  'arm_parked_awaiting_operator_commit',
  'stage_marker_not_advanced',
  'terminal_arm_parked_with_residue',
  'arm_died_with_unpushed_work',
  'pr_create_failed',
  // Task pane blocked on a known interactive agent lifecycle prompt (HOK-3045).
  // Captured only from a correlated task pane against a closed prompt-signature
  // catalog; evidence carries only the signature id, not raw prompt text.
  'agent_interactive_prompt_blocked',
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
  // Parked/terminal-arm legacy slugs (HOK-2927); before the generic local/remote
  // signatures so branch/commit vocabulary is not mislabelled.
  if (/parked[-_ ]awaiting[-_ ]operator[-_ ]commit/.test(lower)) {
    return 'arm_parked_awaiting_operator_commit';
  }
  if (/(?:stage[-_ ])?marker[-_ ]not[-_ ]advanced/.test(lower)) {
    return 'stage_marker_not_advanced';
  }
  if (/terminal[-_ ](?:arm|task)[-_ ]parked/.test(lower)) {
    return 'terminal_arm_parked_with_residue';
  }
  if (/(?:arm[-_ ]died[-_ ]with[-_ ])?unpushed[-_ ]work/.test(lower)) {
    return 'arm_died_with_unpushed_work';
  }
  if (/pr[-_ ]create[-_ ]failed|pull[-_ ]request[-_ ]create[-_ ]failed/.test(lower)) {
    return 'pr_create_failed';
  }
  if (/agent[-_ ]interactive[-_ ]prompt[-_ ]blocked|interactive[-_ ]prompt[-_ ]blocked/.test(lower)) {
    return 'agent_interactive_prompt_blocked';
  }
  if (/does[-_ ]not[-_ ]provide[-_ ]an[-_ ]export|export[-_ ]named|module[-_ ]export[-_ ]contract/.test(lower)) {
    return 'module_export_contract_mismatch';
  }
  if (/failed[-_ ]to[-_ ]parse|unexpected[-_ ]token|parse[-_ ]error|syntax[-_ ]error|malformed[-_ ]json/.test(lower)) {
    return 'local_parse_failure';
  }
  if (/invalid[-_ ]config|schema[-_ ]validation|missing[-_ ]config/.test(lower)) {
    return 'local_config_failure';
  }
  if (/active[-_ ]unpublished[-_ ]work[-_ ]stalled|stalled[-_ ]active[-_ ]unpublished/.test(lower)) {
    return 'active_unpublished_work_stalled';
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

/**
 * The distinct lifecycle transition kinds the Observer synchronizes to Linear.
 * Each maps to exactly one comment shape and, optionally, one state mutation.
 */
export type IncidentLifecycleTransitionKind = 'resolved' | 'archived' | 'recurred';

/**
 * Persisted record of the last lifecycle transition the Observer delivered to a
 * linked Linear issue. Comment and state delivery are tracked independently so a
 * replay after a partial failure performs only the remaining work. `transitionRevision`
 * is a stable hash of the particular resolution/archive/recurrence event, so a new
 * distinct transition resets delivery while a re-run of the same one is a no-op.
 */
export interface IncidentLifecycleSyncMetadata {
  /** Lifecycle last successfully reflected to Linear (comment and/or state). */
  lastSyncedLifecycle?: IncidentLifecycle;
  /** Kind of the transition currently being (or last) delivered. */
  kind?: IncidentLifecycleTransitionKind;
  /** Stable revision of the specific transition event being delivered. */
  transitionRevision?: string;
  /** True once the transition's comment has been posted for `transitionRevision`. */
  commentDelivered?: boolean;
  /** True once the transition's state mutation has been applied for `transitionRevision`. */
  stateApplied?: boolean;
  /** Last time any lifecycle step for this record succeeded. */
  syncedAt?: string;
  /**
   * True when the Observer itself moved the linked Linear issue into a completed/
   * canceled state. Recurrence may only reopen an issue the Observer auto-closed;
   * a human-closed issue never carries this flag and is never reopened.
   */
  observerClosedIssue?: boolean;
  /** Name of the workflow state the Observer moved the issue into, when it did. */
  observerSetStateName?: string;
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
  /** Immutable lineage captured from a job-backed detector event. */
  jobId?: string;
  jobKind?: string;
  side?: string;
  resultPath?: string;
  authoritativeFailureAt?: string;
  /** Consecutive successful observer cycles without a fresh distinct event. */
  missedCycles?: number;
  /** How and when the record last transitioned to resolved/archived. */
  resolution?: IncidentResolutionMetadata;
  /** Recurrence audit trail: set when a resolved/archived record is reopened. */
  recurrence?: IncidentRecurrenceMetadata;
  /** Lifecycle transition sync state for the linked Linear issue (HOK-3035). */
  lifecycleSync?: IncidentLifecycleSyncMetadata;
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

/**
 * The pending lifecycle transition a linked record wants delivered to Linear,
 * or null when there is none. Auto vs operator resolution is preserved via
 * `resolutionAction` so the synchronizer can apply the conservative default
 * (comment-only) for absence-based resolution while honouring the opt-in close
 * policy for explicit operator actions.
 */
export interface IncidentLifecycleTransition {
  kind: IncidentLifecycleTransitionKind;
  /** Stable revision of this specific transition event. */
  revision: string;
  /** For resolved/archived: which store action produced the transition. */
  resolutionAction?: IncidentResolutionAction;
}

function stableRevision(parts: Array<string | number | undefined>): string {
  // A short deterministic revision; a plain join is enough because the parts
  // (action + timestamp, or recurrence count + timestamp) already uniquely
  // identify the transition event across restarts.
  return parts.map((part) => String(part ?? '')).join('|');
}

/**
 * Derive the lifecycle transition that still needs delivery for a linked record.
 * Resolved/archived records carry a `resolution` stamp; a record reopened by
 * recurrence carries a `recurrence` stamp on an observed/active lifecycle. The
 * revision is stable for a given event so repeated loops and restarts converge.
 */
export function classifyLifecycleTransition(record: IncidentRecord): IncidentLifecycleTransition | null {
  const metadata = record.metadata ?? {};
  if (record.lifecycle === 'resolved' || record.lifecycle === 'archived') {
    const resolution = metadata.resolution;
    const kind: IncidentLifecycleTransitionKind = record.lifecycle === 'archived' ? 'archived' : 'resolved';
    return {
      kind,
      resolutionAction: resolution?.action,
      revision: stableRevision([kind, resolution?.action, resolution?.at ?? record.lastObservedAt]),
    };
  }
  // Observed/active record that was reopened by recurrence: reflect the reopen.
  const recurrence = metadata.recurrence;
  if (recurrence && typeof recurrence.count === 'number' && recurrence.count > 0) {
    return {
      kind: 'recurred',
      revision: stableRevision(['recurred', recurrence.count, recurrence.lastRecurredAt]),
    };
  }
  return null;
}

/**
 * True when the record has a lifecycle transition whose revision has not yet been
 * fully synced to Linear. A record with no linked issue is never lifecycle-pending
 * — lifecycle effects only act on an already-linked issue.
 */
export function hasPendingLifecycleTransition(record: IncidentRecord): boolean {
  if (!record.metadata?.linkedLinearId) return false;
  const transition = classifyLifecycleTransition(record);
  if (!transition) return false;
  const synced = record.metadata?.lifecycleSync;
  if (!synced || synced.transitionRevision !== transition.revision) return true;
  // Same revision already seen: pending only if a step still remains. Whether a
  // state step is required depends on config, so the synchronizer makes the
  // final call; here we treat a fully comment+state delivered revision as done
  // and anything else as still worth a (cheap, idempotent) pass.
  return !(synced.commentDelivered === true && synced.stateApplied === true);
}

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
