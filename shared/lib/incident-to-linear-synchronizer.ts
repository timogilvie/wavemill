import { basename } from 'node:path';
import {
  addLabelsToIssue,
  classifyLinearError,
  createComment,
  createIssue,
  getIssue,
  getOrCreateLabel,
  getProjects,
  getTeams,
  searchIssues,
  updateIssue,
  type LinearIssue,
  type LinearIssueSummary,
  type LinearLabel,
  type LinearProject,
  type LinearTeam,
} from './linear.ts';
import { IncidentStore } from './wavemill-incident-store.ts';
import type { IncidentCategory, IncidentEvidence, IncidentRecord } from './wavemill-incident-model.ts';
import {
  reconcileIncidentForFiling,
  type IncidentFilingReconciliation,
} from './incident-filing-reconciler.ts';

export type IncidentPolicyStrategy = 'create' | 'no_create' | 'threshold' | 'create_if_persistent';

export interface IncidentClassPolicy {
  strategy: IncidentPolicyStrategy;
  threshold?: number;
  persistentThreshold?: number;
  correlateIssueIds?: string[];
}

export interface IncidentLinearRedactionConfig {
  enabled: boolean;
  patterns: string[];
  redactPaths: boolean;
  redactEmails: boolean;
  truncateTranscripts: boolean;
  truncateLength: number;
  markFormat: string;
}

export type ObserverLinearMode = 'off' | 'offline' | 'shadow' | 'live';

export interface ObserverLinearShadowConfig {
  auditPath: string;
  countersPath: string;
  maxEntries: number;
  maxAgeDays: number;
  maxLookupsPerPass: number;
}

export interface ObserverLinearLifecyclePolicy {
  /** Auto-resolution by absence: comment only by default. */
  autoResolvedComment: boolean;
  autoResolvedCloseState?: string;
  /** Operator resolution: optionally move to completed state. */
  operatorResolvedComment: boolean;
  operatorResolvedCloseState?: string;
  /** Operator archival: comment and optionally close. */
  operatorArchivedComment: boolean;
  operatorArchivedCloseState?: string;
  /** Recurrence: reopen only Observer-owned auto-closed issues. */
  recurrenceComment: boolean;
  recurrenceReopenState?: string;
}

export interface ObserverLinearConfig {
  enabled: boolean;
  detectionOnly: boolean;
  mode: ObserverLinearMode;
  project?: string;
  team?: string;
  label?: string;
  retryQueuePath: string;
  updateCooldownMinutes: number;
  maxIncidentsPerPass: number;
  maxRetryEntriesPerPass: number;
  requestDelayMs: number;
  rateLimitBackoffMs: number;
  policies: Record<IncidentCategory, IncidentClassPolicy>;
  redaction: IncidentLinearRedactionConfig;
  shadow: ObserverLinearShadowConfig;
  lifecycle?: ObserverLinearLifecyclePolicy;
}

export type SyncAction =
  | 'create'
  | 'update_comment'
  | 'correlate'
  | 'skip'
  | 'skip_recovered'
  | 'no_op'
  | 'unknown_needs_lookup'
  | 'queued'
  | 'failed';

export interface RedactionSummary {
  redactionEnabled: boolean;
  patternsApplied: number;
  redactedEmails: boolean;
  redactedPaths: boolean;
  truncatedTranscripts: boolean;
  markersFound: string[];
}

export interface ShadowCorrelationTarget {
  issueId?: string;
  identifier?: string;
  url?: string;
  matchedBy: 'linked_metadata' | 'fingerprint_label' | 'content_search' | 'related_issue' | 'none';
  candidateCount: number;
}

export interface ShadowSyncPlan {
  fingerprint: string;
  class: IncidentCategory;
  task?: string;
  evidenceRevision: string;
  action: SyncAction;
  reason?: string;
  plannedTitle: string;
  plannedBody?: string;
  plannedCommentBody?: string;
  correlationTarget: ShadowCorrelationTarget;
  reconciliation: IncidentFilingReconciliation;
  redactionSummary: RedactionSummary;
  policyDecision: {
    allowed: boolean;
    reason?: string;
    strategy: IncidentPolicyStrategy;
  };
}

export interface SyncResult {
  fingerprint: string;
  action: SyncAction;
  status: 'created' | 'updated' | 'skipped' | 'queued' | 'failed';
  issueId?: string;
  issueUrl?: string;
  evidenceRevision: string;
  reason?: string;
  dryRun?: boolean;
  nextRetryAt?: string;
  plannedTitle?: string;
  reconciliation?: IncidentFilingReconciliation;
  shadowPlan?: ShadowSyncPlan;
}

export interface IncidentLinearRetryEnqueuer {
  enqueueIncidentSync(input: {
    incidentFingerprint: string;
    linearAction: 'create' | 'update_comment' | 'lifecycle_comment' | 'lifecycle_state';
    linearIssueId?: string;
    lifecycleRevision?: string;
    lifecycleSubstep?: 'comment' | 'state';
    lastError: ReturnType<typeof classifyLinearError>;
    now?: Date;
  }): Promise<{ nextRetryAt: string }> | { nextRetryAt: string };
}

export interface IncidentLinearClient {
  getTeams: typeof getTeams;
  getProjects: typeof getProjects;
  searchIssues: typeof searchIssues;
  getIssue: typeof getIssue;
  createIssue: typeof createIssue;
  createComment: typeof createComment;
  getOrCreateLabel: typeof getOrCreateLabel;
  addLabelsToIssue: typeof addLabelsToIssue;
  updateIssue?: typeof import('./linear.ts').updateIssue;
}

export interface SyncIncidentOptions {
  incident: IncidentRecord;
  store?: IncidentStore;
  config: ObserverLinearConfig;
  dryRun?: boolean;
  replay?: boolean;
  now?: Date;
  client?: IncidentLinearClient;
  retryQueue?: IncidentLinearRetryEnqueuer;
  audit?: (message: string, fields?: Record<string, unknown>) => void;
  /** Repository whose persisted workflow state is the filing authority. */
  repoDir?: string;
  /** Injectable read-only gate for tests and alternate read-only stores. */
  reconciler?: (incident: IncidentRecord, repoDir: string) => IncidentFilingReconciliation;
  /** Force shadow-mode planning (equivalent to config.mode === 'shadow'). */
  shadow?: boolean;
  /**
   * Optional bounded-lookup accountant shared across a whole shadow pass.
   * When present, correlation reads are counted and stopped once the ceiling
   * is reached so shadow cannot hammer Linear across many incidents.
   */
  lookupBudget?: LookupBudget;
}

const DEFAULT_CLIENT: IncidentLinearClient = {
  getTeams,
  getProjects,
  searchIssues,
  getIssue,
  createIssue,
  createComment,
  getOrCreateLabel,
  addLabelsToIssue,
  updateIssue,
};

const CLASS_LABEL_PREFIX = 'incident:class:';
const FINGERPRINT_LABEL_PREFIX = 'incident:fingerprint:';

export const DEFAULT_INCIDENT_LINEAR_CONFIG: ObserverLinearConfig = {
  enabled: false,
  detectionOnly: false,
  mode: 'off',
  retryQueuePath: '.wavemill/registry/linear-incident-queue.jsonl',
  updateCooldownMinutes: 5,
  maxIncidentsPerPass: 10,
  maxRetryEntriesPerPass: 5,
  requestDelayMs: 250,
  rateLimitBackoffMs: 1000,
  policies: {
    product_defect: { strategy: 'create' },
    model_task_harness_outcome: {
      strategy: 'no_create',
      correlateIssueIds: ['HOK-2593'],
    },
    external_transient_dependency: { strategy: 'threshold', threshold: 3 },
    configuration_operator_condition: { strategy: 'create_if_persistent', persistentThreshold: 3 },
    stale_orphaned_state: { strategy: 'create_if_persistent', persistentThreshold: 3 },
  },
  redaction: {
    enabled: true,
    patterns: [
      'api[_-]?key',
      'token',
      'secret',
      'password',
      'credential',
      'private[_-]?key',
    ],
    redactPaths: true,
    redactEmails: true,
    truncateTranscripts: true,
    truncateLength: 200,
    markFormat: '[REDACTED: {type}]',
  },
  shadow: {
    auditPath: '.wavemill/observer/shadow-audit.jsonl',
    countersPath: '.wavemill/observer/shadow-counters.json',
    maxEntries: 500,
    maxAgeDays: 14,
    maxLookupsPerPass: 40,
  },
  lifecycle: {
    autoResolvedComment: true,
    operatorResolvedComment: true,
    operatorArchivedComment: true,
    recurrenceComment: true,
  },
};

function marker(config: IncidentLinearRedactionConfig, type: string): string {
  return config.markFormat.replace('{type}', type);
}

export function redactLinearIssueContent(text: string, config: IncidentLinearRedactionConfig): string {
  if (!config.enabled) return text;
  let redacted = text;
  for (const pattern of config.patterns) {
    try {
      const keyValue = new RegExp(`(${pattern})(\\s*[=:]\\s*)[^\\s,;]+`, 'gi');
      redacted = redacted.replace(keyValue, `$1$2${marker(config, 'secret')}`);
      const bearer = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
      redacted = redacted.replace(bearer, `$1 ${marker(config, 'secret')}`);
    } catch {
      // Invalid operator-supplied redaction patterns are ignored instead of
      // blocking incident sync. Config validation still catches normal cases.
    }
  }
  if (config.redactEmails) {
    redacted = redacted.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, marker(config, 'email'));
  }
  if (config.redactPaths) {
    redacted = redacted.replace(/((?:\/[A-Za-z0-9._ -]+){3,})/g, (match) => {
      const parts = match.split('/').filter(Boolean);
      return parts.length <= 2 ? match : `.../${parts.slice(-2).join('/')}`;
    });
  }
  if (config.truncateTranscripts && redacted.length > config.truncateLength * 2 && /\b(prompt|transcript|conversation)\b/i.test(redacted)) {
    redacted = `${redacted.slice(0, config.truncateLength)}\n[TRUNCATED]\n${redacted.slice(-config.truncateLength)}`;
  }
  return redacted;
}

export function redactEvidence(evidence: IncidentEvidence[], config: IncidentLinearRedactionConfig): IncidentEvidence[] {
  return evidence.map((item) => ({
    ...item,
    source: config.redactPaths ? redactLinearIssueContent(item.source, config) : item.source,
    redactedData: redactLinearIssueContent(item.redactedData, config),
  }));
}

export function generateIssueTitle(incident: IncidentRecord): string {
  const subject = incident.taskId ? `${incident.taskId}: ${incident.summary}` : incident.summary;
  return `[wavemill incident/${incident.category}] ${subject}`.slice(0, 250);
}

function evidenceLine(evidence: IncidentEvidence): string {
  const location = evidence.lineNumber ? `${basename(evidence.source)}:${evidence.lineNumber}` : basename(evidence.source);
  return `- ${evidence.type}: ${location} [${evidence.timestamp}] ${evidence.redactedData}`;
}

function relatedIssues(incident: IncidentRecord, policy?: IncidentClassPolicy): string[] {
  return [
    ...(Array.isArray(incident.metadata?.knownIssueIds) ? incident.metadata.knownIssueIds : []),
    ...(policy?.correlateIssueIds ?? []),
  ].filter((value, index, array) => array.indexOf(value) === index);
}

export function generateIssueBody(incident: IncidentRecord, config: ObserverLinearConfig, evidenceRevision: string, now: Date): string {
  const policy = config.policies[incident.category];
  const evidence = redactEvidence(incident.evidence, config.redaction).slice(-12);
  const related = relatedIssues(incident, policy);
  const model = extractEvidenceField(incident.evidence, 'model') ?? 'N/A';
  const cooldownUntil = new Date(now.getTime() + config.updateCooldownMinutes * 60_000).toISOString();
  return redactLinearIssueContent([
    '## Incident Summary',
    `- **Type**: ${incident.category}`,
    `- **Severity**: ${incident.severity}`,
    `- **Confidence**: ${incident.confidence}`,
    `- **Root Cause**: ${incident.rootCauseClass}`,
    `- **Observed Symptom**: ${typeof incident.metadata?.observedSymptom === 'string' ? incident.metadata.observedSymptom : incident.rootCauseClass}`,
    `- **Status**: ${incident.lifecycle}`,
    `- **First Seen**: ${incident.firstObservedAt || incident.createdAt}`,
    `- **Last Seen**: ${incident.lastObservedAt}`,
    `- **Occurrences (distinct events)**: ${incident.occurrenceCount}`,
    '',
    '## Impact',
    incident.operatorAction,
    '',
    '## Affected Session/Task/Model',
    `- Session: ${incident.session ?? 'repo-wide'}`,
    `- Task: ${incident.taskId ?? 'N/A'}`,
    `- Model: ${model}`,
    '',
    '## Evidence',
    ...evidence.map(evidenceLine),
    '',
    '## Structured Evidence References',
    ...evidence.map((item) => `- ${item.type}: ${item.source} [${item.timestamp}]`),
    '',
    '## Threshold & Escalation',
    `- Threshold triggered: ${String(incident.metadata?.thresholdTriggered ?? false)}`,
    `- Escalated at: ${String(incident.metadata?.escalatedAt ?? 'N/A')}`,
    '',
    '## Related Issues',
    ...(related.length > 0 ? related.map((id) => `- ${id}`) : ['- None recorded']),
    '',
    '## Operator Recommendation',
    incident.operatorAction,
    '',
    '---',
    `**Incident fingerprint**: ${incident.fingerprint}`,
    `**Evidence revision**: ${evidenceRevision}`,
    `**Evidence updated**: ${now.toISOString()}`,
    `**Occurrences in window**: ${incident.occurrenceCount}`,
    `**Update cooldown until**: ${cooldownUntil}`,
  ].join('\n'), config.redaction);
}

export function generateCommentBody(incident: IncidentRecord, config: ObserverLinearConfig, evidenceRevision: string, now: Date): string {
  const evidence = redactEvidence(incident.evidence, config.redaction).slice(-8);
  return redactLinearIssueContent([
    `## Wavemill Incident Evidence Update`,
    `- **Fingerprint**: ${incident.fingerprint}`,
    `- **Root Cause**: ${incident.rootCauseClass}`,
    `- **Severity/Confidence**: ${incident.severity}/${incident.confidence}`,
    `- **Occurrences**: ${incident.occurrenceCount}`,
    `- **Last Seen**: ${incident.lastObservedAt}`,
    `- **Evidence revision**: ${evidenceRevision}`,
    '',
    '## New Evidence',
    ...evidence.map(evidenceLine),
    '',
    `Recommendation: ${incident.operatorAction}`,
    '',
    `Synced at: ${now.toISOString()}`,
  ].join('\n'), config.redaction);
}

function extractEvidenceField(evidence: IncidentEvidence[], field: string): string | undefined {
  for (const item of evidence) {
    const match = item.redactedData.match(new RegExp(`\\b${field}=([^\\s,;]+)`, 'i'));
    if (match) return match[1];
  }
  return undefined;
}

function issueIsOpen(issue: Pick<LinearIssueSummary, 'completedAt' | 'canceledAt'>): boolean {
  return issue.completedAt == null && issue.canceledAt == null;
}

function fingerprintLabel(incident: IncidentRecord): string {
  return `${FINGERPRINT_LABEL_PREFIX}${incident.fingerprint.slice(0, 16)}`;
}

function classLabel(incident: IncidentRecord): string {
  return `${CLASS_LABEL_PREFIX}${incident.category}`;
}

function issueHasLabel(issue: LinearIssueSummary, label: string): boolean {
  return Boolean(issue.labels?.nodes?.some((node) => node.name === label));
}

function mergeSearchResults(...groups: LinearIssueSummary[][]): LinearIssueSummary[] {
  const byId = new Map<string, LinearIssueSummary>();
  for (const group of groups) {
    for (const issue of group) {
      byId.set(issue.id, issue);
    }
  }
  return [...byId.values()].sort((a, b) => Number(issueIsOpen(b)) - Number(issueIsOpen(a)));
}

async function resolveIssueByIdentifier(client: IncidentLinearClient, identifier: string): Promise<LinearIssueSummary | null> {
  try {
    const issue = await client.getIssue(identifier);
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state,
      labels: issue.labels,
      project: issue.project,
      team: issue.team,
      url: issue.url,
      completedAt: issue.completedAt,
      canceledAt: issue.canceledAt,
    };
  } catch {
    return null;
  }
}

async function findExistingIssue(incident: IncidentRecord, config: ObserverLinearConfig, client: IncidentLinearClient): Promise<LinearIssueSummary | null> {
  const known = await Promise.all(relatedIssues(incident, config.policies[incident.category]).map((id) => resolveIssueByIdentifier(client, id)));
  const knownOpen = known.find((issue): issue is LinearIssueSummary => issue !== null && issueIsOpen(issue));
  if (knownOpen) return knownOpen;

  const fingerprint = fingerprintLabel(incident);
  const fingerprintMatches = (await client.searchIssues(fingerprint, {
    teamKey: config.team,
    projectName: config.project,
    includeCompleted: false,
    first: 10,
  })).filter((issue) => issueHasLabel(issue, fingerprint) || `${issue.title}\n${issue.identifier}`.includes(incident.fingerprint.slice(0, 16)));
  if (fingerprintMatches[0]) return fingerprintMatches[0];

  const contentMatches = await client.searchIssues(`${incident.rootCauseClass} ${incident.category}`, {
    teamKey: config.team,
    projectName: config.project,
    includeCompleted: false,
    first: 10,
  });
  const ranked = mergeSearchResults(contentMatches).filter((issue) =>
    issue.title.toLowerCase().includes(incident.rootCauseClass.toLowerCase())
    || issueHasLabel(issue, classLabel(incident)),
  );
  return ranked[0] ?? null;
}

function policyAllowsCreate(incident: IncidentRecord, config: ObserverLinearConfig): { allowed: boolean; reason?: string } {
  if (incident.lifecycle !== 'active' && incident.metadata?.thresholdTriggered !== true) {
    return { allowed: false, reason: 'incident is not confirmed/escalated' };
  }
  const policy = config.policies[incident.category] ?? DEFAULT_INCIDENT_LINEAR_CONFIG.policies[incident.category];
  if (policy.strategy === 'no_create') return { allowed: false, reason: `${incident.category} policy forbids standalone issue creation` };
  if (policy.strategy === 'threshold' && incident.occurrenceCount < (policy.threshold ?? 3)) {
    return { allowed: false, reason: `${incident.category} below threshold ${policy.threshold ?? 3}` };
  }
  if (policy.strategy === 'create_if_persistent' && incident.occurrenceCount < (policy.persistentThreshold ?? 3)) {
    return { allowed: false, reason: `${incident.category} is not persistent/actionable yet` };
  }
  return { allowed: true };
}

function shouldUpdateIncident(incident: IncidentRecord, evidenceRevision: string, now: Date, replay: boolean): { allowed: boolean; reason?: string } {
  if (replay) return { allowed: true };
  if (incident.metadata?.lastSyncedEvidenceRevision === evidenceRevision) {
    return { allowed: false, reason: 'evidence revision already synced' };
  }
  const cooldownUntil = typeof incident.metadata?.syncCooldownUntil === 'string' ? Date.parse(incident.metadata.syncCooldownUntil) : 0;
  if (Number.isFinite(cooldownUntil) && cooldownUntil > now.getTime()) {
    return { allowed: false, reason: `cooldown active until ${incident.metadata.syncCooldownUntil}` };
  }
  return { allowed: true };
}

async function resolveRouting(config: ObserverLinearConfig, client: IncidentLinearClient): Promise<{ teamId: string; projectId?: string; labelIds: string[] }> {
  const teams = await client.getTeams();
  const team = resolveTeam(teams, config.team);
  const projects = config.project ? await client.getProjects() : [];
  const project = config.project ? resolveProject(projects, config.project) : undefined;
  const labels: LinearLabel[] = [];
  for (const name of [config.label, 'wavemill-incident'].filter((value): value is string => Boolean(value))) {
    labels.push(await client.getOrCreateLabel(name, team.id));
  }
  return {
    teamId: team.id,
    projectId: project?.id,
    labelIds: labels.map((label) => label.id),
  };
}

function resolveTeam(teams: LinearTeam[], requested?: string): LinearTeam {
  const team = requested ? teams.find((item) => item.id === requested || item.key === requested || item.name === requested) : teams[0];
  if (!team) throw new Error(`Linear team not found: ${requested ?? '(first team)'}`);
  return team;
}

function resolveProject(projects: LinearProject[], requested: string): LinearProject {
  const project = projects.find((item) => item.id === requested || item.name === requested);
  if (!project) throw new Error(`Linear project not found: ${requested}`);
  return project;
}

async function addIncidentLabels(issue: LinearIssueSummary | LinearIssue, incident: IncidentRecord, config: ObserverLinearConfig, client: IncidentLinearClient): Promise<void> {
  const teamId = issue.team?.id;
  if (!teamId) return;
  const current = issue.labels?.nodes ?? [];
  const labels = await Promise.all([
    client.getOrCreateLabel(fingerprintLabel(incident), teamId),
    client.getOrCreateLabel(classLabel(incident), teamId),
    config.label ? client.getOrCreateLabel(config.label, teamId) : null,
  ]);
  const labelIds = [...current.map((label) => label.id), ...labels.filter((label): label is LinearLabel => label !== null).map((label) => label.id)];
  await client.addLabelsToIssue(issue.id, [...new Set(labelIds)]);
}

export async function syncIncident(options: SyncIncidentOptions): Promise<SyncResult> {
  const now = options.now ?? new Date();
  const config = options.config;
  const evidenceRevision = options.store?.computeEvidenceRevision(options.incident) ?? new IncidentStore('').computeEvidenceRevision(options.incident);
  const dryRun = options.dryRun === true || config.detectionOnly === true || config.mode === 'offline' || config.mode === 'shadow';
  const shadowMode = options.shadow === true || config.mode === 'shadow';
  const incident = options.incident;
  const audit = options.audit ?? (() => {});
  const reconciliation = (options.reconciler ?? reconcileIncidentForFiling)(incident, options.repoDir ?? process.cwd());
  const baseResult = { fingerprint: incident.fingerprint, evidenceRevision, dryRun, reconciliation };

  // An unlinked incident proven recovered/superseded must not cause even a
  // lookup: queue replay and dry-run both pass through this same early gate.
  // Shadow mode surfaces this as skip_recovered so operators can see the
  // suppression separately from generic policy-based skips.
  if (!incident.metadata?.linkedLinearId && (reconciliation.outcome === 'recovered' || reconciliation.outcome === 'superseded')) {
    audit('incident filing suppressed by reconciliation', { fingerprint: incident.fingerprint, ...reconciliation });
    if (shadowMode) {
      const plan = planShadowSync({
        incident,
        config,
        evidenceRevision,
        now,
        reconciliation,
        correlation: { matchedBy: 'none', candidateCount: 0 },
        forcedAction: 'skip_recovered',
        forcedReason: `reconciliation: ${reconciliation.outcome}`,
      });
      return {
        ...baseResult,
        action: 'skip_recovered',
        status: 'skipped',
        reason: `reconciliation: ${reconciliation.outcome}`,
        plannedTitle: plan.plannedTitle,
        shadowPlan: plan,
      };
    }
    return { ...baseResult, action: 'skip', status: 'skipped', reason: `reconciliation: ${reconciliation.outcome}` };
  }

  if (shadowMode) {
    return await runShadowSync({ ...options, now, evidenceRevision, reconciliation, audit });
  }

  if (dryRun) {
    return { ...planOfflineSync(incident, config, evidenceRevision, now, options.replay === true), reconciliation };
  }

  if (!config.enabled && !dryRun) {
    return { ...baseResult, action: 'skip', status: 'skipped', reason: 'observer.linear.enabled is false' };
  }

  const client = withRequestPacing(options.client ?? DEFAULT_CLIENT, config);

  try {
    const existing = incident.metadata?.linkedLinearId
      ? await resolveIssueByIdentifier(client, incident.metadata.linkedLinearId)
      : await findExistingIssue(incident, config, client);
    const createPolicy = policyAllowsCreate(incident, config);

    if (!existing && !createPolicy.allowed) {
      audit('incident linear skip', { fingerprint: incident.fingerprint, reason: createPolicy.reason });
      return { ...baseResult, action: 'skip', status: 'skipped', reason: createPolicy.reason };
    }

    if (existing) {
      const update = shouldUpdateIncident(incident, evidenceRevision, now, options.replay === true);
      if (!update.allowed) {
        return {
          ...baseResult,
          action: 'no_op',
          status: 'skipped',
          issueId: existing.identifier,
          issueUrl: existing.url,
          reason: update.reason,
        };
      }
      if (dryRun) {
        return {
          ...baseResult,
          action: 'update_comment',
          status: 'skipped',
          issueId: existing.identifier,
          issueUrl: existing.url,
          reason: 'dry-run planned evidence update',
        };
      }
      await client.createComment(existing.id, generateCommentBody(incident, config, evidenceRevision, now));
      await addIncidentLabels(existing, incident, config, client);
      await options.store?.recordLinearSync(incident.fingerprint, {
        linearIssueId: existing.identifier,
        linearIssueUrl: existing.url,
        evidenceRevision,
        syncedAt: now.toISOString(),
        cooldownUntil: new Date(now.getTime() + config.updateCooldownMinutes * 60_000).toISOString(),
      });
      return { ...baseResult, action: 'update_comment', status: 'updated', issueId: existing.identifier, issueUrl: existing.url };
    }

    const plannedTitle = generateIssueTitle(incident);
    if (dryRun) {
      return { ...baseResult, action: 'create', status: 'skipped', plannedTitle, reason: 'dry-run planned issue create' };
    }

    const routing = await resolveRouting(config, client);
    const fingerprint = await client.getOrCreateLabel(fingerprintLabel(incident), routing.teamId);
    const className = await client.getOrCreateLabel(classLabel(incident), routing.teamId);
    const created = await client.createIssue({
      title: plannedTitle,
      description: generateIssueBody(incident, config, evidenceRevision, now),
      teamId: routing.teamId,
      projectId: routing.projectId,
      labelIds: [...new Set([...routing.labelIds, fingerprint.id, className.id])],
      priority: incident.severity === 'critical' ? 1 : incident.severity === 'high' ? 2 : undefined,
    });
    await options.store?.recordLinearSync(incident.fingerprint, {
      linearIssueId: created.identifier,
      linearIssueUrl: created.url,
      evidenceRevision,
      syncedAt: now.toISOString(),
      cooldownUntil: new Date(now.getTime() + config.updateCooldownMinutes * 60_000).toISOString(),
    });
    return { ...baseResult, action: 'create', status: 'created', issueId: created.identifier, issueUrl: created.url };
  } catch (error) {
    const classified = classifyLinearError(error);
    const action = incident.metadata?.linkedLinearId ? 'update_comment' : 'create';
    let retryQueued = false;
    let nextRetryAt: string | undefined;
    if (classified.category === 'rate_limit' && config.rateLimitBackoffMs > 0) {
      await sleep(config.rateLimitBackoffMs);
    }
    if (classified.isRetryable && options.retryQueue && !dryRun) {
      const queued = await options.retryQueue.enqueueIncidentSync({
        incidentFingerprint: incident.fingerprint,
        linearAction: action,
        linearIssueId: typeof incident.metadata?.linkedLinearId === 'string' ? incident.metadata.linkedLinearId : undefined,
        lastError: classified,
        now,
      });
      retryQueued = true;
      nextRetryAt = queued.nextRetryAt;
    }
    await options.store?.recordSyncError(incident.fingerprint, {
      action,
      category: classified.category,
      message: classified.message,
      retryQueued,
      at: now.toISOString(),
    });
    if (retryQueued) {
      return { ...baseResult, action: 'queued', status: 'queued', reason: classified.message, nextRetryAt };
    }
    return { ...baseResult, action: 'failed', status: 'failed', reason: classified.message };
  }
}

export class ShadowMutationBlockedError extends Error {
  readonly method: string;
  constructor(method: string) {
    super(`shadow mode blocked Linear mutation: ${method}()`);
    this.name = 'ShadowMutationBlockedError';
    this.method = method;
  }
}

export interface LookupBudget {
  readonly max: number;
  used: number;
  exhausted: boolean;
  /** Ordered list of method names that were counted, for debugging/audit. */
  callLog: string[];
}

export function createLookupBudget(max: number): LookupBudget {
  return { max: Math.max(0, max), used: 0, exhausted: false, callLog: [] };
}

export interface ReadOnlyIncidentLinearClient {
  client: IncidentLinearClient;
  mutationAttempts: number;
  mutationCallLog: string[];
}

/**
 * Wrap an incident linear client so every mutation method throws
 * ShadowMutationBlockedError and increments a counter on the returned object.
 * The read methods are passed through unchanged, so shadow correlation still
 * works but a bug that reaches a write path is loudly caught.
 */
export function wrapReadOnlyIncidentLinearClient(client: IncidentLinearClient): ReadOnlyIncidentLinearClient {
  const wrapper: ReadOnlyIncidentLinearClient = {
    mutationAttempts: 0,
    mutationCallLog: [],
    client: client, // replaced below with the real proxy
  };
  const block = (method: string) => async () => {
    wrapper.mutationAttempts += 1;
    wrapper.mutationCallLog.push(method);
    throw new ShadowMutationBlockedError(method);
  };
  wrapper.client = {
    getTeams: client.getTeams,
    getProjects: client.getProjects,
    searchIssues: client.searchIssues,
    getIssue: client.getIssue,
    createIssue: block('createIssue') as unknown as IncidentLinearClient['createIssue'],
    createComment: block('createComment') as unknown as IncidentLinearClient['createComment'],
    getOrCreateLabel: block('getOrCreateLabel') as unknown as IncidentLinearClient['getOrCreateLabel'],
    addLabelsToIssue: block('addLabelsToIssue') as unknown as IncidentLinearClient['addLabelsToIssue'],
  };
  return wrapper;
}

function withLookupBudget(client: IncidentLinearClient, budget?: LookupBudget): IncidentLinearClient {
  if (!budget) return client;
  const guard = (method: string) => {
    if (budget.used >= budget.max) {
      budget.exhausted = true;
      throw new Error(`shadow lookup budget exhausted after ${budget.used}/${budget.max} calls (blocking ${method})`);
    }
    budget.used += 1;
    budget.callLog.push(method);
  };
  return {
    ...client,
    searchIssues: async (...args) => {
      guard('searchIssues');
      return client.searchIssues(...args);
    },
    getIssue: async (...args) => {
      guard('getIssue');
      return client.getIssue(...args);
    },
    getTeams: async (...args) => {
      guard('getTeams');
      return client.getTeams(...args);
    },
    getProjects: async (...args) => {
      guard('getProjects');
      return client.getProjects(...args);
    },
  };
}

function summarizeRedaction(config: IncidentLinearRedactionConfig, ...texts: string[]): RedactionSummary {
  const combined = texts.join('\n');
  const markers = new Set<string>();
  const escaped = config.markFormat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{type\\}', '([a-z]+)');
  try {
    const markerRe = new RegExp(escaped, 'g');
    let match: RegExpExecArray | null;
    while ((match = markerRe.exec(combined)) !== null) {
      markers.add(match[1]);
    }
  } catch {
    // Ignore malformed operator markFormat rather than blowing up shadow
    // planning; the audit still records the raw counts below.
  }
  return {
    redactionEnabled: config.enabled,
    patternsApplied: config.patterns.length,
    redactedEmails: config.redactEmails,
    redactedPaths: config.redactPaths,
    truncatedTranscripts: /\[TRUNCATED/.test(combined),
    markersFound: [...markers].sort(),
  };
}

export interface PlanShadowSyncOptions {
  incident: IncidentRecord;
  config: ObserverLinearConfig;
  evidenceRevision: string;
  now: Date;
  reconciliation: IncidentFilingReconciliation;
  correlation: ShadowCorrelationTarget;
  forcedAction?: SyncAction;
  forcedReason?: string;
  replay?: boolean;
}

/**
 * Assemble the exact redacted payload the live path would send, plus the
 * reconciliation/policy metadata operators need to review a shadow trial.
 * This is a pure function of its inputs — it never touches a client or store.
 */
export function planShadowSync(options: PlanShadowSyncOptions): ShadowSyncPlan {
  const { incident, config, evidenceRevision, now, reconciliation, correlation } = options;
  const plannedTitle = generateIssueTitle(incident);
  const policy = config.policies[incident.category] ?? DEFAULT_INCIDENT_LINEAR_CONFIG.policies[incident.category];
  const createPolicy = policyAllowsCreate(incident, config);

  let action: SyncAction;
  let reason: string | undefined;
  let plannedBody: string | undefined;
  let plannedCommentBody: string | undefined;

  if (options.forcedAction) {
    action = options.forcedAction;
    reason = options.forcedReason;
    if (action === 'create') {
      plannedBody = generateIssueBody(incident, config, evidenceRevision, now);
    } else if (action === 'update_comment') {
      plannedCommentBody = generateCommentBody(incident, config, evidenceRevision, now);
    }
  } else if (correlation.matchedBy !== 'none' && correlation.identifier) {
    const update = shouldUpdateIncident(incident, evidenceRevision, now, options.replay === true);
    if (!update.allowed) {
      action = 'no_op';
      reason = update.reason;
    } else {
      action = 'update_comment';
      reason = 'shadow: planned evidence update';
      plannedCommentBody = generateCommentBody(incident, config, evidenceRevision, now);
    }
  } else if (!createPolicy.allowed) {
    action = 'skip';
    reason = createPolicy.reason;
  } else {
    action = 'create';
    reason = 'shadow: planned issue create';
    plannedBody = generateIssueBody(incident, config, evidenceRevision, now);
  }

  const redactionSummary = summarizeRedaction(config.redaction, plannedTitle, plannedBody ?? '', plannedCommentBody ?? '');

  return {
    fingerprint: incident.fingerprint,
    class: incident.category,
    task: incident.taskId,
    evidenceRevision,
    action,
    reason,
    plannedTitle,
    plannedBody,
    plannedCommentBody,
    correlationTarget: correlation,
    reconciliation,
    redactionSummary,
    policyDecision: {
      allowed: createPolicy.allowed,
      reason: createPolicy.reason,
      strategy: policy.strategy,
    },
  };
}

interface RunShadowSyncOptions extends SyncIncidentOptions {
  now: Date;
  evidenceRevision: string;
  reconciliation: IncidentFilingReconciliation;
  audit: (message: string, fields?: Record<string, unknown>) => void;
}

async function runShadowSync(options: RunShadowSyncOptions): Promise<SyncResult> {
  const { incident, config, now, evidenceRevision, reconciliation, audit } = options;
  const baseClient = options.client ?? DEFAULT_CLIENT;
  const wrapped = wrapReadOnlyIncidentLinearClient(baseClient);
  const budgetedClient = withLookupBudget(wrapped.client, options.lookupBudget);
  const pacedClient = withRequestPacing(budgetedClient, config);
  const baseResult = { fingerprint: incident.fingerprint, evidenceRevision, dryRun: true, reconciliation };

  let correlation: ShadowCorrelationTarget = { matchedBy: 'none', candidateCount: 0 };
  let existing: LinearIssueSummary | null = null;
  let failure: { reason: string } | undefined;

  try {
    if (incident.metadata?.linkedLinearId) {
      existing = await resolveIssueByIdentifier(pacedClient, incident.metadata.linkedLinearId);
      if (existing) {
        correlation = {
          issueId: existing.id,
          identifier: existing.identifier,
          url: existing.url,
          matchedBy: 'linked_metadata',
          candidateCount: 1,
        };
      }
    } else {
      existing = await findExistingIssue(incident, config, pacedClient);
      if (existing) {
        correlation = {
          issueId: existing.id,
          identifier: existing.identifier,
          url: existing.url,
          matchedBy: 'fingerprint_label',
          candidateCount: 1,
        };
      }
    }
  } catch (error) {
    failure = { reason: error instanceof Error ? error.message : String(error) };
    audit('shadow correlation lookup failed', { fingerprint: incident.fingerprint, reason: failure.reason });
  }

  if (failure) {
    const failPlan = planShadowSync({
      incident, config, evidenceRevision, now, reconciliation,
      correlation,
      forcedAction: 'failed',
      forcedReason: `shadow correlation failed: ${failure.reason}`,
    });
    if (wrapped.mutationAttempts > 0) {
      throw new Error(`shadow contract violated: mutation attempted (${wrapped.mutationCallLog.join(',')})`);
    }
    return {
      ...baseResult,
      action: 'failed',
      status: 'failed',
      reason: failPlan.reason,
      plannedTitle: failPlan.plannedTitle,
      shadowPlan: failPlan,
    };
  }

  const plan = planShadowSync({
    incident,
    config,
    evidenceRevision,
    now,
    reconciliation,
    correlation,
    replay: options.replay === true,
  });

  if (wrapped.mutationAttempts > 0) {
    // Contract violation: even one attempt is a bug we want to loudly fail on.
    throw new Error(`shadow contract violated: mutation attempted (${wrapped.mutationCallLog.join(',')})`);
  }

  const status: SyncResult['status'] = plan.action === 'failed'
    ? 'failed'
    : 'skipped';

  return {
    ...baseResult,
    action: plan.action,
    status,
    issueId: correlation.identifier,
    issueUrl: correlation.url,
    reason: plan.reason,
    plannedTitle: plan.plannedTitle,
    shadowPlan: plan,
  };
}

function planOfflineSync(
  incident: IncidentRecord,
  config: ObserverLinearConfig,
  evidenceRevision: string,
  now: Date,
  replay: boolean,
): SyncResult {
  const baseResult = { fingerprint: incident.fingerprint, evidenceRevision, dryRun: true, plannedTitle: generateIssueTitle(incident) };
  if (incident.metadata?.linkedLinearId) {
    const update = shouldUpdateIncident(incident, evidenceRevision, now, replay);
    if (!update.allowed) {
      return {
        ...baseResult,
        action: 'no_op',
        status: 'skipped',
        issueId: incident.metadata.linkedLinearId,
        issueUrl: incident.metadata.linkedLinearUrl,
        reason: update.reason,
      };
    }
    return {
      ...baseResult,
      action: 'update_comment',
      status: 'skipped',
      issueId: incident.metadata.linkedLinearId,
      issueUrl: incident.metadata.linkedLinearUrl,
      reason: 'dry-run planned evidence update from local linked issue metadata',
    };
  }

  const related = relatedIssues(incident, config.policies[incident.category]);
  if (related.length > 0) {
    return {
      ...baseResult,
      action: 'unknown_needs_lookup',
      status: 'skipped',
      reason: `dry-run needs Linear lookup to resolve related issue(s): ${related.join(', ')}`,
    };
  }

  const createPolicy = policyAllowsCreate(incident, config);
  if (!createPolicy.allowed) {
    return { ...baseResult, action: 'skip', status: 'skipped', reason: createPolicy.reason };
  }

  return {
    ...baseResult,
    action: 'unknown_needs_lookup',
    status: 'skipped',
    reason: 'dry-run needs Linear lookup to determine create versus update',
  };
}

function withRequestPacing(client: IncidentLinearClient, config: ObserverLinearConfig): IncidentLinearClient {
  const delayMs = Math.max(0, config.requestDelayMs);
  if (delayMs === 0) return client;
  const pace = async () => sleep(delayMs);
  return {
    getTeams: async (...args) => {
      await pace();
      return client.getTeams(...args);
    },
    getProjects: async (...args) => {
      await pace();
      return client.getProjects(...args);
    },
    searchIssues: async (...args) => {
      await pace();
      return client.searchIssues(...args);
    },
    getIssue: async (...args) => {
      await pace();
      return client.getIssue(...args);
    },
    createIssue: async (...args) => {
      await pace();
      return client.createIssue(...args);
    },
    createComment: async (...args) => {
      await pace();
      return client.createComment(...args);
    },
    getOrCreateLabel: async (...args) => {
      await pace();
      return client.getOrCreateLabel(...args);
    },
    addLabelsToIssue: async (...args) => {
      await pace();
      return client.addLabelsToIssue(...args);
    },
    updateIssue: client.updateIssue ? async (...args) => {
      await pace();
      return client.updateIssue!(...args);
    } : undefined,
  };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate lifecycle transition comment for resolution, archival, or recurrence.
 */
export function generateLifecycleComment(incident: IncidentRecord): string | null {
  const { lifecycle, metadata } = incident;

  if (lifecycle === 'resolved' && metadata?.resolution) {
    const { action, at, reason } = metadata.resolution;
    if (action === 'auto_resolved') {
      return `**Incident auto-resolved**\n\nThis incident was automatically resolved at ${at} because it was not re-observed for multiple consecutive observer cycles.\n\n${reason ? `Reason: ${reason}` : ''}`;
    } else if (action === 'operator_resolved') {
      return `**Incident resolved by operator**\n\nThis incident was manually resolved at ${at}.${reason ? `\n\nReason: ${reason}` : ''}`;
    }
  }

  if (lifecycle === 'archived' && metadata?.resolution?.action === 'operator_archived') {
    const { at, reason } = metadata.resolution;
    return `**Incident archived**\n\nThis incident was archived at ${at}.${reason ? `\n\nReason: ${reason}` : ''}`;
  }

  if (metadata?.recurrence) {
    const { count, lastRecurredAt, reopenedFrom } = metadata.recurrence;
    return `**Incident recurred**\n\nThis incident has recurred at ${lastRecurredAt}. Previous state: ${reopenedFrom}. Total recurrence count: ${count}.`;
  }

  return null;
}

export interface SyncLifecycleOptions {
  incident: IncidentRecord;
  store: IncidentStore;
  config: ObserverLinearConfig;
  now?: Date;
  client?: IncidentLinearClient;
  retryQueue?: IncidentLinearRetryEnqueuer;
  audit?: (message: string, fields?: Record<string, unknown>) => void;
  repoDir?: string;
  reconciler?: (incident: IncidentRecord, repoDir: string) => IncidentFilingReconciliation;
  shadow?: boolean;
}

export interface SyncLifecycleResult {
  fingerprint: string;
  action: 'lifecycle_sync' | 'no_op' | 'skip' | 'failed';
  status: 'synced' | 'skipped' | 'queued' | 'failed';
  lifecycleRevision: string;
  commentPosted?: boolean;
  stateChanged?: boolean;
  reason?: string;
  dryRun?: boolean;
}

/**
 * Synchronize lifecycle transitions (resolution, archival, recurrence) to Linear.
 * Comment-only by default; state changes are opt-in via config.
 */
export async function syncLifecycle(options: SyncLifecycleOptions): Promise<SyncLifecycleResult> {
  const { incident, store, config, now = new Date(), shadow = false } = options;
  const baseClient = options.client ?? DEFAULT_CLIENT;
  const pacedClient = withRequestPacing(baseClient, config);
  const audit = options.audit ?? (() => {});
  const repoDir = options.repoDir ?? process.cwd();
  const reconciler = options.reconciler ?? reconcileIncidentForFiling;

  const lifecycleRevision = store.computeLifecycleRevision(incident);
  const baseResult = { fingerprint: incident.fingerprint, lifecycleRevision, dryRun: shadow };

  // Must be linked to Linear
  if (!incident.metadata?.linkedLinearId) {
    return { ...baseResult, action: 'skip', status: 'skipped', reason: 'not linked to Linear' };
  }

  const lastSynced = incident.metadata?.lastSyncedLifecycle;

  // Reconciliation gate: suppress lifecycle sync if incident is recovered or superseded
  const reconciliation = reconciler(incident, repoDir);
  if (reconciliation.verdict === 'recovered' || reconciliation.verdict === 'superseded') {
    return { ...baseResult, action: 'skip', status: 'skipped', reason: `reconciliation: ${reconciliation.verdict}` };
  }

  // Lifecycle policy
  const lifecyclePolicy = config.lifecycle ?? DEFAULT_INCIDENT_LINEAR_CONFIG.lifecycle!;
  const comment = generateLifecycleComment(incident);
  if (!comment) {
    return { ...baseResult, action: 'skip', status: 'skipped', reason: 'no lifecycle transition to sync' };
  }

  // Determine required actions based on lifecycle and policy. When a prior sync at
  // this same revision already completed a substep, do not repeat it — this keeps
  // replay idempotent when comment succeeds but state fails, and vice versa.
  const priorAtSameRevision = lastSynced?.revision === lifecycleRevision;
  const needsComment = !(priorAtSameRevision && lastSynced?.commentPosted);
  let needsStateChange = false;
  let targetStateId: string | undefined;

  if (incident.lifecycle === 'resolved' && incident.metadata?.resolution) {
    const { action } = incident.metadata.resolution;
    if (action === 'auto_resolved' && lifecyclePolicy.autoResolvedCloseState) {
      needsStateChange = !(priorAtSameRevision && lastSynced?.stateChanged);
      targetStateId = lifecyclePolicy.autoResolvedCloseState;
    } else if (action === 'operator_resolved' && lifecyclePolicy.operatorResolvedCloseState) {
      needsStateChange = !(priorAtSameRevision && lastSynced?.stateChanged);
      targetStateId = lifecyclePolicy.operatorResolvedCloseState;
    }
  } else if (incident.lifecycle === 'archived' && incident.metadata?.resolution?.action === 'operator_archived') {
    if (lifecyclePolicy.operatorArchivedCloseState) {
      needsStateChange = !(priorAtSameRevision && lastSynced?.stateChanged);
      targetStateId = lifecyclePolicy.operatorArchivedCloseState;
    }
  } else if (incident.metadata?.recurrence && lifecyclePolicy.recurrenceReopenState) {
    // Recurrence: only reopen if Observer previously auto-closed the issue AND we
    // have not already reopened at this same revision.
    const observerOwned = !!(lastSynced?.stateChanged && lastSynced.observerStateId);
    const alreadyReopened = priorAtSameRevision
      && lastSynced?.stateChanged === true
      && lastSynced.observerStateId === lifecyclePolicy.recurrenceReopenState;
    if (observerOwned && !alreadyReopened) {
      needsStateChange = true;
      targetStateId = lifecyclePolicy.recurrenceReopenState;
    }
  }

  if (!needsComment && !needsStateChange) {
    return { ...baseResult, action: 'no_op', status: 'skipped', reason: 'lifecycle already synced' };
  }

  // Shadow mode: plan only
  if (shadow || config.mode === 'shadow') {
    return {
      ...baseResult,
      action: 'lifecycle_sync',
      status: 'skipped',
      commentPosted: needsComment,
      stateChanged: needsStateChange,
      reason: `shadow: would ${needsComment ? 'comment' : ''}${needsComment && needsStateChange ? ' and ' : ''}${needsStateChange ? `change state to ${targetStateId}` : ''}`,
    };
  }

  const issueId = incident.metadata.linkedLinearId;

  // Execute lifecycle sync
  try {
    // Post comment if needed
    if (needsComment) {
      try {
        await pacedClient.createComment(issueId, comment);
        await store.recordLifecycleSubstep(incident.fingerprint, {
          lifecycleRevision,
          commentPosted: true,
          at: now.toISOString(),
        });
        audit('lifecycle_comment_posted', { fingerprint: incident.fingerprint, issueId });
      } catch (error) {
        const classified = classifyLinearError(error);
        if (options.retryQueue && classified.isRetryable) {
          options.retryQueue.enqueueIncidentSync({
            incidentFingerprint: incident.fingerprint,
            linearAction: 'lifecycle_comment',
            linearIssueId: issueId,
            lifecycleRevision,
            lifecycleSubstep: 'comment',
            lastError: classified,
            now,
          });
          return { ...baseResult, action: 'lifecycle_sync', status: 'queued', reason: 'comment failed, queued for retry' };
        }
        throw error;
      }
    }

    // Change state if needed
    if (needsStateChange && targetStateId && pacedClient.updateIssue) {
      try {
        await pacedClient.updateIssue(issueId, { stateId: targetStateId });
        await store.recordLifecycleSubstep(incident.fingerprint, {
          lifecycleRevision,
          stateChanged: true,
          observerStateId: targetStateId,
          at: now.toISOString(),
        });
        audit('lifecycle_state_changed', { fingerprint: incident.fingerprint, issueId, targetStateId });
      } catch (error) {
        const classified = classifyLinearError(error);
        if (options.retryQueue && classified.isRetryable) {
          options.retryQueue.enqueueIncidentSync({
            incidentFingerprint: incident.fingerprint,
            linearAction: 'lifecycle_state',
            linearIssueId: issueId,
            lifecycleRevision,
            lifecycleSubstep: 'state',
            lastError: classified,
            now,
          });
          return { ...baseResult, action: 'lifecycle_sync', status: 'queued', reason: 'state change failed, queued for retry' };
        }
        throw error;
      }
    }

    return {
      ...baseResult,
      action: 'lifecycle_sync',
      status: 'synced',
      commentPosted: needsComment,
      stateChanged: needsStateChange,
    };
  } catch (error) {
    await store.recordSyncError(incident.fingerprint, {
      action: 'lifecycle_sync',
      message: error instanceof Error ? error.message : String(error),
      category: 'lifecycle',
    });
    return { ...baseResult, action: 'failed', status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}
