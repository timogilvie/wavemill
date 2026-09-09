/**
 * Artifact Diagnostics — read-only observer for normalized task artifacts (HOK-2260)
 *
 * Inspects task-contract.json, feature-state.json, and trace.jsonl artifacts
 * and reports coverage gaps, stale hashes, and inconsistencies against existing
 * controller state. Never mutates task state or fails active workflows.
 *
 * @module artifact-diagnostics
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveEvalsDir, resolveRouteArtifactArchiveDir } from './evals-paths.ts';
import type { TaskContract } from './task-contract.ts';
import type { FeatureState } from './feature-state.ts';
import type { TraceEvent } from './trace-event.ts';
import type { EvalRecord } from './eval-schema.ts';

// ── Public Types ──────────────────────────────────────────────────────────────

export type ArtifactFindingSeverity = 'info' | 'warn' | 'error';

export type ArtifactFindingCode =
  | 'coverage_gap'
  | 'malformed'
  | 'contract_hash_drift'
  | 'feature_outcome_state_mismatch'
  | 'coding_complete_without_evidence'
  | 'eval_without_outcome'
  | 'trace_id_missing'
  | 'trace_event_unreflected';

export interface ArtifactDiagnosticFinding {
  code: ArtifactFindingCode;
  severity: ArtifactFindingSeverity;
  message: string;
  file?: string;
  reason?: string;
  taskId?: string;
  slug?: string;
  details?: Record<string, unknown>;
}

export interface ArtifactDiagnosticsReport {
  repoDir: string;
  featureDir: string | null;
  taskId: string | null;
  slug: string | null;
  generatedAt: string;
  artifacts: {
    taskContract: { path: string; present: boolean; malformed: boolean };
    featureState: { path: string; present: boolean; malformed: boolean };
    trace: { path: string; present: boolean; malformedLines: number };
  };
  findings: ArtifactDiagnosticFinding[];
  summary: { info: number; warn: number; error: number };
}

export interface DiagnoseArtifactsOptions {
  repoDir: string;
  taskId?: string;
  slug?: string;
  featureDir?: string;
}

export interface PlanningResultDiagnostic {
  status?: 'completed' | 'failed';
  failureReason?: string;
  agent?: string;
  model?: string;
  startedAt?: string;
  finishedAt?: string;
  planFile?: string;
  transcriptFile?: string;
  error?: string;
}

export interface JobStateDiagnostic {
  id?: string;
  kind?: 'eval' | 'comparison';
  status?: 'running' | 'succeeded' | 'failed' | 'timeout';
  issueId?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  reason?: string;
  error?: string;
  resultPath?: string;
  logPath?: string;
  pairId?: string;
}

export interface HookStatusDiagnostic {
  state?: string;
  event?: string;
  detail?: string;
  timestamp?: number;
  agent?: string;
  error?: string;
}

export interface PrIdentityDiagnostic {
  number: number;
  headSha?: string;
  baseSha?: string;
  headRef?: string;
  baseRef?: string;
  changedFileCount?: number;
  additions?: number;
  deletions?: number;
  labels: string[];
  mergeStateStatus?: string;
  latestCheckRollup: string[];
  source: string;
}

export interface ReviewResultDiagnostic {
  verdict?: string;
  failureCategory?: string;
  reviewedHead?: string;
  reviewedBase?: string;
  reviewedFileCount?: number;
  reviewedAtIso?: string;
  source: string;
}

export interface ChallengePairStateDiagnostic {
  pairId?: string;
  role?: 'primary' | 'challenger';
  comparisonState?: string;
  comparisonBlockedReason?: string;
  comparisonRetryCount?: number;
  comparisonRetryMaxAttempts?: number;
  comparisonRetryTargetIssue?: string;
  comparisonTimedOutSides: string[];
  manualComparisonArtifactPath?: string;
  source: string;
}

export interface QuotaSnapshotDiagnostic {
  exhaustedProviders: string[];
  exhaustedModels: string[];
  lastLimitErrorAtIso?: string;
  source: string;
}

export interface EvalFallbackEventDiagnostic {
  issueId?: string;
  challengePairId?: string;
  taskType?: string;
  outcome: 'all_exhausted';
  failedProviders: string[];
  failedModels: string[];
  timestamp?: string;
  source: string;
}

// ── Internal Read Result Types ────────────────────────────────────────────────

type JsonReadResult<T> =
  | { status: 'missing' }
  | { status: 'ok'; value: T }
  | { status: 'malformed'; reason: string };

type JsonlReadResult<T> = {
  records: T[];
  malformedLines: Array<{ line: number; reason: string }>;
  missing: boolean;
};

// ── Tolerant Readers ──────────────────────────────────────────────────────────

function readJsonTolerant<T = Record<string, unknown>>(filePath: string): JsonReadResult<T> {
  if (!existsSync(filePath)) {
    return { status: 'missing' };
  }
  try {
    const content = readFileSync(filePath, 'utf-8');
    if (!content.trim()) {
      return { status: 'malformed', reason: 'file is empty' };
    }
    const parsed = JSON.parse(content) as T;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { status: 'malformed', reason: 'top-level value is not an object' };
    }
    return { status: 'ok', value: parsed };
  } catch (err) {
    return { status: 'malformed', reason: err instanceof Error ? err.message : String(err) };
  }
}

export function readPlanningResult(filePath: string): PlanningResultDiagnostic | null {
  const result = readJsonTolerant<Record<string, unknown>>(filePath);
  if (result.status === 'missing') return null;
  if (result.status === 'malformed') return { error: result.reason };

  const value = result.value;
  return {
    status: stringEnum(value.status, ['completed', 'failed']),
    failureReason: stringField(value.failureReason) ?? stringField(value.terminalReason) ?? stringField(value.reason),
    agent: stringField(value.agent) ?? stringField(value.agentCmd) ?? stringField(value.planner),
    model: stringField(value.model) ?? stringField(value.modelId),
    startedAt: stringField(value.startedAt),
    finishedAt: stringField(value.finishedAt) ?? stringField(value.completedAt),
    planFile: stringField(value.planFile) ?? stringField(value.planPath),
    transcriptFile: stringField(value.transcriptFile) ?? stringField(value.transcriptPath),
  };
}

export function readJobState(jobPath: string): JobStateDiagnostic | null {
  const result = readJsonTolerant<Record<string, unknown>>(jobPath);
  if (result.status === 'missing') return null;
  if (result.status === 'malformed') return { error: result.reason };

  const value = result.value;
  return {
    id: stringField(value.id),
    kind: stringEnum(value.kind, ['eval', 'comparison']),
    status: stringEnum(value.status, ['running', 'succeeded', 'failed', 'timeout']),
    issueId: stringField(value.issueId),
    startedAt: stringField(value.startedAt),
    finishedAt: stringField(value.finishedAt),
    exitCode: numberField(value.exitCode),
    reason: stringField(value.reason),
    error: stringField(value.error) ?? stringField(value.excerpt),
    resultPath: stringField(value.resultPath),
    logPath: stringField(value.logPath),
    pairId: stringField(value.pairId),
  };
}

export function readHookStatus(hookPath: string): HookStatusDiagnostic | null {
  const result = readJsonTolerant<Record<string, unknown>>(hookPath);
  if (result.status === 'missing') return null;
  if (result.status === 'malformed') return { error: result.reason, state: 'error' };

  const value = result.value;
  return {
    state: stringField(value.state) ?? stringField(value.status),
    event: stringField(value.event),
    detail: stringField(value.detail) ?? stringField(value.message),
    timestamp: numberField(value.timestamp),
    agent: stringField(value.agent),
    error: stringField(value.error),
  };
}

export function readPrIdentity(prNumber: number, repoDir: string): PrIdentityDiagnostic | null {
  const fixture = readPrIdentityFixture(prNumber, repoDir);
  if (fixture) return fixture;

  let stdout: string;
  try {
    stdout = execFileSync('gh', [
      'pr',
      'view',
      String(prNumber),
      '--json',
      'number,headRefOid,baseRefOid,headRefName,baseRefName,files,labels,mergeStateStatus,statusCheckRollup',
    ], {
      cwd: repoDir,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }

  return projectPrIdentity(prNumber, parseJsonObject(stdout), `gh:pr:${prNumber}`);
}

export function readReviewResultDiagnostic(taskDir: string): ReviewResultDiagnostic | null {
  const source = join(taskDir, '.review-result.json');
  const result = readJsonTolerant<Record<string, unknown>>(source);
  if (result.status !== 'ok') return null;
  const value = result.value;
  const artifacts = objectField(value.artifacts);
  const review = objectField(value.review) ?? objectField(value.result) ?? objectField(value.outcome);
  const scope = objectField(value.scope)
    ?? objectField(artifacts?.scope)
    ?? objectField(review?.scope)
    ?? objectField(artifacts?.reviewScope);
  const files = arrayField(scope?.files)
    ?? arrayField(value.files)
    ?? arrayField(artifacts?.files)
    ?? arrayField(review?.files);
  return {
    verdict: stringField(value.verdict)
      ?? stringField(value.status)
      ?? stringField(review?.verdict)
      ?? stringField(artifacts?.verdict),
    failureCategory: stringField(value.failureCategory)
      ?? stringField(artifacts?.failureCategory)
      ?? stringField(review?.failureCategory),
    reviewedHead: stringField(value.reviewedHead)
      ?? stringField(value.reviewedHeadSha)
      ?? stringField(value.headSha)
      ?? stringField(scope?.headSha)
      ?? stringField(artifacts?.reviewedHead)
      ?? stringField(artifacts?.headSha),
    reviewedBase: stringField(value.reviewedBase)
      ?? stringField(value.reviewedBaseSha)
      ?? stringField(value.baseSha)
      ?? stringField(scope?.baseSha)
      ?? stringField(artifacts?.reviewedBase)
      ?? stringField(artifacts?.baseSha),
    reviewedFileCount: numberField(value.reviewedFileCount)
      ?? numberField(scope?.changedFileCount)
      ?? numberField(scope?.fileCount)
      ?? numberField(artifacts?.reviewedFileCount)
      ?? (files ? files.length : undefined),
    reviewedAtIso: stringField(value.reviewedAt)
      ?? stringField(value.completedAt)
      ?? stringField(value.finishedAt)
      ?? stringField(artifacts?.reviewedAt),
    source,
  };
}

export function readChallengePairState(taskDir: string): ChallengePairStateDiagnostic | null {
  const source = firstExistingPath([
    join(taskDir, 'workflow-state.json'),
    join(taskDir, '.workflow-state.json'),
    join(taskDir, 'feature-state.json'),
  ]);
  if (!source) return null;
  const result = readJsonTolerant<Record<string, unknown>>(source);
  if (result.status !== 'ok') return null;
  const direct = objectField(result.value);
  const task = firstObjectEntry(objectField(direct?.tasks)) ?? direct;
  if (!task) return null;
  return projectChallengePairState(task, source);
}

export function readQuotaSnapshotDiagnostic(repoDir: string): QuotaSnapshotDiagnostic | null {
  const source = join(repoDir, '.wavemill', 'quota-state.json');
  const result = readJsonTolerant<Record<string, unknown>>(source);
  if (result.status !== 'ok') return null;
  const models = objectField(result.value.models);
  const exhaustedModels: string[] = [];
  let lastLimitErrorAtIso: string | undefined;
  if (models) {
    for (const [model, raw] of Object.entries(models).slice(0, 100)) {
      const entry = objectField(raw);
      if (!entry) continue;
      if (entry.status === 'exhausted') exhaustedModels.push(clampText(model, 120));
      const at = stringField(entry.lastLimitErrorAt);
      if (at && (!lastLimitErrorAtIso || at > lastLimitErrorAtIso)) lastLimitErrorAtIso = at;
    }
  }
  const exhaustedProviders = new Set<string>();
  for (const model of exhaustedModels) {
    const provider = model.includes('/') ? model.split('/')[0] : model.split(':')[0];
    if (provider) exhaustedProviders.add(clampText(provider, 80));
  }
  const providers = objectField(result.value.providers);
  const openrouter = objectField(providers?.openrouter);
  const lastFetchError = objectField(openrouter?.lastFetchError);
  if (lastFetchError) {
    const message = stringField(lastFetchError.message) ?? '';
    if (/402|credit|quota|limit|exhaust/i.test(message)) {
      exhaustedProviders.add('openrouter');
      const at = stringField(lastFetchError.at);
      if (at && (!lastLimitErrorAtIso || at > lastLimitErrorAtIso)) lastLimitErrorAtIso = at;
    }
  }
  return {
    exhaustedProviders: [...exhaustedProviders].slice(0, 20),
    exhaustedModels: exhaustedModels.slice(0, 50),
    lastLimitErrorAtIso,
    source,
  };
}

export function readEvalFallbackEventsDiagnostic(repoDir: string, sinceIso?: string): EvalFallbackEventDiagnostic[] {
  const source = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
  const result = readJsonlTolerant<Record<string, unknown>>(source);
  const sinceMs = sinceIso ? Date.parse(sinceIso) : Number.NaN;
  const events: EvalFallbackEventDiagnostic[] = [];
  for (const record of result.records.slice(-200)) {
    const fallbackEvent = objectField(record.fallbackEvent);
    if (!fallbackEvent || fallbackEvent.outcome !== 'all_exhausted') continue;
    const timestamp = stringField(record.timestamp) ?? stringField(fallbackEvent.timestamp);
    if (!Number.isNaN(sinceMs) && timestamp && Date.parse(timestamp) < sinceMs) continue;
    const chain = arrayField(fallbackEvent.fallback_chain) ?? [];
    const failedModels = chain
      .map((entry) => stringField(objectField(entry)?.model))
      .filter((model): model is string => Boolean(model))
      .slice(0, 50);
    const failedProviders = new Set<string>();
    for (const model of failedModels) {
      const provider = model.includes('/') ? model.split('/')[0] : model.split(':')[0];
      if (provider) failedProviders.add(clampText(provider, 80));
    }
    const reasons = chain
      .map((entry) => stringField(objectField(entry)?.reason) ?? '')
      .join(' ');
    if (!/quota|credit|provider|402|limit|exhaust/i.test(`${reasons} ${failedModels.join(' ')}`)) continue;
    events.push({
      issueId: stringField(record.issueId),
      challengePairId: stringField(record.challengePairId),
      taskType: stringField(fallbackEvent.task_type),
      outcome: 'all_exhausted',
      failedProviders: [...failedProviders].slice(0, 20),
      failedModels: failedModels.map((model) => clampText(model, 120)),
      timestamp,
      source,
    });
  }
  return events.slice(-50);
}

export function redactIncidentData(text: string): string {
  if (text.length > 2_000 && /\b(prompt|system|user|assistant|transcript)\b/i.test(text)) {
    return `[REDACTED_PROMPT: ${text.length} chars]`;
  }

  const redacted = text
    .replace(/Authorization:\s*[^\r\n]+/gi, 'Authorization: [REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[REDACTED_TOKEN]')
    .replace(/\b([A-Z0-9_]*(?:API_)?KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S{12,}/gi, '$1=[REDACTED]')
    .replace(/\b(key|token|secret|password)\s*[:=]\s*\S{20,}/gi, '$1=[REDACTED]')
    .replace(/([^\s"'=]+\/)?([^\/\s"'=]+\.jsonl)\b/g, '$2');

  if (redacted.length > 500) {
    return `${redacted.slice(0, 100)} [TRUNCATED ${redacted.length} chars]`;
  }
  return redacted;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function arrayField(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function stringEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    return objectField(JSON.parse(text) as unknown) ?? null;
  } catch {
    return null;
  }
}

function firstExistingPath(paths: string[]): string | null {
  for (const path of paths) {
    if (existsSync(path)) return path;
  }
  return null;
}

function firstObjectEntry(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  for (const entry of Object.values(value)) {
    const object = objectField(entry);
    if (object) return object;
  }
  return undefined;
}

function clampText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function readPrIdentityFixture(prNumber: number, repoDir: string): PrIdentityDiagnostic | null {
  const source = firstExistingPath([
    join(repoDir, '.wavemill', 'prs', `${prNumber}.json`),
    join(repoDir, '.wavemill', 'prs', `pr-${prNumber}.json`),
    join(repoDir, '.wavemill', 'pr', `${prNumber}.json`),
  ]);
  if (!source) return null;
  const result = readJsonTolerant<Record<string, unknown>>(source);
  if (result.status !== 'ok') return null;
  return projectPrIdentity(prNumber, result.value, source);
}

function projectPrIdentity(prNumber: number, value: Record<string, unknown> | null, source: string): PrIdentityDiagnostic | null {
  if (!value) return null;
  const files = normalizeArrayNodes(value.files);
  const labels = normalizeArrayNodes(value.labels)
    .map((label) => stringField(label) ?? stringField(objectField(label)?.name))
    .filter((label): label is string => Boolean(label))
    .map((label) => clampText(label, 120))
    .slice(0, 100);
  const checks = normalizeArrayNodes(value.statusCheckRollup)
    .map((check) => stringField(check) ?? stringField(objectField(check)?.name) ?? stringField(objectField(check)?.context))
    .filter((check): check is string => Boolean(check))
    .map((check) => clampText(check, 120))
    .slice(0, 100);
  const changedFileCount = numberField(value.changedFileCount) ?? files.length;
  const additions = numberField(value.additions)
    ?? sumNumberFields(files, 'additions');
  const deletions = numberField(value.deletions)
    ?? sumNumberFields(files, 'deletions');
  return {
    number: numberField(value.number) ?? prNumber,
    headSha: stringField(value.headRefOid) ?? stringField(value.headSha),
    baseSha: stringField(value.baseRefOid) ?? stringField(value.baseSha),
    headRef: stringField(value.headRefName) ?? stringField(value.headRef),
    baseRef: stringField(value.baseRefName) ?? stringField(value.baseRef),
    changedFileCount,
    additions,
    deletions,
    labels,
    mergeStateStatus: stringField(value.mergeStateStatus),
    latestCheckRollup: checks,
    source,
  };
}

function normalizeArrayNodes(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const object = objectField(value);
  const nodes = object ? arrayField(object.nodes) : undefined;
  return nodes ?? [];
}

function sumNumberFields(values: unknown[], key: string): number | undefined {
  let total = 0;
  let seen = false;
  for (const value of values) {
    const number = numberField(objectField(value)?.[key]);
    if (number === undefined) continue;
    seen = true;
    total += number;
  }
  return seen ? total : undefined;
}

function projectChallengePairState(task: Record<string, unknown>, source: string): ChallengePairStateDiagnostic {
  const comparison = objectField(task.comparison) ?? task;
  const timedOut = arrayField(comparison.comparisonTimedOutSides)
    ?? arrayField(task.comparisonTimedOutSides)
    ?? [];
  const role = stringEnum(task.challengeRole, ['primary', 'challenger'])
    ?? stringEnum(task.role, ['primary', 'challenger']);
  return {
    pairId: stringField(task.challengePairId)
      ?? stringField(task.pairId)
      ?? stringField(comparison.pairId),
    role,
    comparisonState: stringField(comparison.comparisonState)
      ?? stringField(task.comparisonState),
    comparisonBlockedReason: stringField(comparison.comparisonBlockedReason)
      ?? stringField(task.comparisonBlockedReason),
    comparisonRetryCount: numberField(comparison.comparisonRetryCount)
      ?? numberField(task.comparisonRetryCount),
    comparisonRetryMaxAttempts: numberField(comparison.comparisonRetryMaxAttempts)
      ?? numberField(task.comparisonRetryMaxAttempts),
    comparisonRetryTargetIssue: stringField(comparison.comparisonRetryTargetIssue)
      ?? stringField(task.comparisonRetryTargetIssue),
    comparisonTimedOutSides: timedOut
      .map((side) => stringField(side))
      .filter((side): side is string => Boolean(side))
      .slice(0, 10),
    manualComparisonArtifactPath: stringField(comparison.manualComparisonArtifact)
      ?? stringField(comparison.manualComparisonArtifactPath)
      ?? stringField(task.manualComparisonArtifact),
    source,
  };
}

function readJsonlTolerant<T>(filePath: string): JsonlReadResult<T> {
  if (!existsSync(filePath)) {
    return { records: [], malformedLines: [], missing: true };
  }
  const records: T[] = [];
  const malformedLines: Array<{ line: number; reason: string }> = [];

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return {
      records: [],
      malformedLines: [{ line: 0, reason: err instanceof Error ? err.message : String(err) }],
      missing: false,
    };
  }

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as T;
      records.push(parsed);
    } catch (err) {
      malformedLines.push({ line: i + 1, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { records, malformedLines, missing: false };
}

function readWorkflowState(repoDir: string): Record<string, unknown> | null {
  const statePath = join(repoDir, '.wavemill', 'workflow-state.json');
  const result = readJsonTolerant(statePath);
  return result.status === 'ok' ? result.value : null;
}

function readEvalRecordsTolerant(repoDir: string): { records: EvalRecord[]; malformedLines: Array<{ line: number; reason: string }> } {
  let evalsDir: string;
  try {
    evalsDir = resolveEvalsDir(undefined, repoDir).dir;
  } catch {
    return { records: [], malformedLines: [] };
  }
  const evalsPath = join(evalsDir, 'evals.jsonl');
  const result = readJsonlTolerant<EvalRecord>(evalsPath);
  return { records: result.records, malformedLines: result.malformedLines };
}

// ── Feature Directory Resolution ──────────────────────────────────────────────

interface ResolvedIdentity {
  featureDir: string | null;
  taskId: string | null;
  slug: string | null;
  ambiguous?: boolean;
  candidates?: string[];
}

function resolveIdentity(opts: DiagnoseArtifactsOptions): ResolvedIdentity {
  const { repoDir } = opts;

  // Explicit featureDir — highest priority
  if (opts.featureDir) {
    const absDir = resolve(opts.featureDir);
    const slug = opts.slug ?? readSlugFromFeatureDir(absDir);
    const taskId = opts.taskId ?? readTaskIdFromFeatureDir(absDir);
    return { featureDir: absDir, taskId, slug };
  }

  // Explicit slug
  if (opts.slug) {
    const featureDir = join(repoDir, 'features', opts.slug);
    const taskId = opts.taskId ?? readTaskIdFromFeatureDir(featureDir);
    return { featureDir, taskId, slug: opts.slug };
  }

  // Explicit taskId — search workflow-state, then scan features/
  if (opts.taskId) {
    const workflowState = readWorkflowState(repoDir);
    if (workflowState) {
      const tasks = workflowState.tasks as Record<string, unknown> | undefined;
      if (tasks && typeof tasks === 'object') {
        for (const [id, task] of Object.entries(tasks)) {
          if (id === opts.taskId && task && typeof task === 'object') {
            const t = task as Record<string, unknown>;
            // Try worktree path first
            if (typeof t.worktree === 'string' && existsSync(t.worktree)) {
              const slug = typeof t.slug === 'string' ? t.slug : readSlugFromFeatureDir(t.worktree);
              return { featureDir: t.worktree, taskId: opts.taskId, slug };
            }
            // Try slug-based path
            if (typeof t.slug === 'string') {
              const featureDir = join(repoDir, 'features', t.slug);
              return { featureDir, taskId: opts.taskId, slug: t.slug };
            }
          }
        }
      }
    }

    // Fall back to scanning features/ directories
    const featuresDir = join(repoDir, 'features');
    if (existsSync(featuresDir)) {
      const matches: string[] = [];
      for (const entry of safeReaddirSync(featuresDir)) {
        const candidate = join(featuresDir, entry);
        const tid = readTaskIdFromFeatureDir(candidate);
        if (tid === opts.taskId) {
          matches.push(candidate);
        }
      }
      if (matches.length === 1) {
        const slug = readSlugFromFeatureDir(matches[0]);
        return { featureDir: matches[0], taskId: opts.taskId, slug };
      }
      if (matches.length > 1) {
        return { featureDir: null, taskId: opts.taskId, slug: null, ambiguous: true, candidates: matches };
      }
    }

    return { featureDir: null, taskId: opts.taskId, slug: null };
  }

  // No identity provided — check if exactly one feature dir has selected-task.json
  const featuresDir = join(repoDir, 'features');
  if (existsSync(featuresDir)) {
    const withTask: string[] = [];
    for (const entry of safeReaddirSync(featuresDir)) {
      const candidate = join(featuresDir, entry);
      if (existsSync(join(candidate, 'selected-task.json'))) {
        withTask.push(candidate);
      }
    }
    if (withTask.length === 1) {
      const featureDir = withTask[0];
      const slug = readSlugFromFeatureDir(featureDir);
      const taskId = readTaskIdFromFeatureDir(featureDir);
      return { featureDir, taskId, slug };
    }
  }

  return { featureDir: null, taskId: null, slug: null };
}

function safeReaddirSync(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readSlugFromFeatureDir(featureDir: string): string | null {
  const selectedTaskPath = join(featureDir, 'selected-task.json');
  const result = readJsonTolerant<Record<string, unknown>>(selectedTaskPath);
  if (result.status === 'ok' && typeof result.value.featureName === 'string') {
    return result.value.featureName;
  }
  return null;
}

function readTaskIdFromFeatureDir(featureDir: string): string | null {
  const selectedTaskPath = join(featureDir, 'selected-task.json');
  const result = readJsonTolerant<Record<string, unknown>>(selectedTaskPath);
  if (result.status === 'ok' && typeof result.value.taskId === 'string') {
    return result.value.taskId;
  }
  return null;
}

// ── SHA-256 helper ────────────────────────────────────────────────────────────

function sha256Hex(filePath: string): string | null {
  try {
    const bytes = readFileSync(filePath);
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return null;
  }
}

// ── Finding builders ──────────────────────────────────────────────────────────

function makeFinding(
  code: ArtifactFindingCode,
  severity: ArtifactFindingSeverity,
  message: string,
  extras?: Partial<ArtifactDiagnosticFinding>,
): ArtifactDiagnosticFinding {
  return { code, severity, message, ...extras };
}

// ── Cross-source checks ───────────────────────────────────────────────────────

function checkContractHashDrift(
  featureDir: string,
  contract: TaskContract,
): ArtifactDiagnosticFinding[] {
  const findings: ArtifactDiagnosticFinding[] = [];
  const contractPath = join(featureDir, 'task-contract.json');

  for (const source of contract.sources) {
    if (!source.exists || source.sha256 === null) continue;
    const absPath = join(featureDir, source.path);
    if (!existsSync(absPath)) continue;

    const currentHash = sha256Hex(absPath);
    if (currentHash && currentHash !== source.sha256) {
      findings.push(makeFinding(
        'contract_hash_drift',
        'warn',
        `Source file hash has changed since contract was built: ${source.path}`,
        {
          file: contractPath,
          details: {
            sourcePath: source.path,
            storedSha256: source.sha256,
            currentSha256: currentHash,
          },
        },
      ));
    }
  }
  return findings;
}

function checkFeatureOutcomeStateMismatch(
  featureDir: string,
  featureState: FeatureState,
  workflowState: Record<string, unknown> | null,
  taskId: string | null,
  slug: string | null,
): ArtifactDiagnosticFinding[] {
  if (!workflowState) return [];

  const tasks = workflowState.tasks as Record<string, Record<string, unknown>> | undefined;
  if (!tasks || typeof tasks !== 'object') return [];

  // Find the matching task entry
  let taskEntry: Record<string, unknown> | null = null;
  for (const [id, task] of Object.entries(tasks)) {
    if (taskId && id === taskId) {
      taskEntry = task;
      break;
    }
    // Match by slug or worktree
    if (slug && typeof task.slug === 'string' && task.slug === slug) {
      taskEntry = task;
      break;
    }
    if (typeof task.worktree === 'string' && task.worktree === featureDir) {
      taskEntry = task;
      break;
    }
  }

  if (!taskEntry) return [];

  const workflowPhase = typeof taskEntry.phase === 'string' ? taskEntry.phase : null;
  const workflowStatus = typeof taskEntry.status === 'string' ? taskEntry.status : null;
  const featurePhase = featureState.currentPhase;
  const featureNormalized = featureState.normalizedState;

  const findings: ArtifactDiagnosticFinding[] = [];
  const statePath = join(featureDir, 'feature-state.json');

  // Phase mismatch check
  if (workflowPhase && featurePhase !== 'unknown' && workflowPhase !== featurePhase) {
    // Allow 'done' feature phase when workflow says 'ready' completed
    const compatible = (featurePhase === 'done' && workflowPhase === 'ready');
    if (!compatible) {
      findings.push(makeFinding(
        'feature_outcome_state_mismatch',
        'warn',
        `Phase mismatch: workflow-state says "${workflowPhase}", feature-state says "${featurePhase}"`,
        {
          file: statePath,
          details: {
            workflowPhase,
            featurePhase,
            workflowStatus,
            featureNormalizedState: featureNormalized,
          },
        },
      ));
    }
  }

  // Status mismatch check
  if (workflowStatus && featureNormalized !== 'unknown') {
    const isCompatible = checkStatusCompatibility(workflowStatus, featureNormalized, featurePhase);
    if (!isCompatible) {
      findings.push(makeFinding(
        'feature_outcome_state_mismatch',
        'warn',
        `State mismatch: workflow-state status is "${workflowStatus}", feature-state normalizedState is "${featureNormalized}"`,
        {
          file: statePath,
          details: {
            workflowStatus,
            featureNormalizedState: featureNormalized,
            featurePhase,
          },
        },
      ));
    }
  }

  return findings;
}

function checkStatusCompatibility(
  workflowStatus: string,
  featureNormalized: string,
  featurePhase: string,
): boolean {
  if (workflowStatus === featureNormalized) return true;
  // workflow complete/done/merged is compatible with feature 'completed' when phase is done
  if (
    ['complete', 'done', 'merged'].includes(workflowStatus) &&
    featureNormalized === 'completed' &&
    featurePhase === 'done'
  ) {
    return true;
  }
  // running/active is compatible with running
  if (['active', 'running'].includes(workflowStatus) && featureNormalized === 'running') {
    return true;
  }
  return false;
}

function checkCodingCompleteWithoutEvidence(
  featureDir: string,
  featureState: FeatureState,
): ArtifactDiagnosticFinding[] {
  const codingCompleteMarker = join(featureDir, '.coding-complete');
  const codingResultPath = join(featureDir, '.coding-result.json');

  const markerExists = existsSync(codingCompleteMarker);
  const codingResult = readJsonTolerant<Record<string, unknown>>(codingResultPath);
  const codingResultCompleted = codingResult.status === 'ok' && codingResult.value.status === 'completed';

  if (!markerExists && !codingResultCompleted) return [];

  // Check for positive evidence
  const passEvidence = featureState.evidence.filter(e => e.status === 'pass');
  const nonMarkerPassEvidence = passEvidence.filter(e => e.kind !== 'legacy_marker');

  const outcome = featureState.outcome;
  const hasPositiveOutcome =
    outcome.readyPassed === true ||
    outcome.reviewPassed === true ||
    outcome.ciPassed === true ||
    outcome.merged === true ||
    (outcome.evalScore !== null && outcome.evalScore >= 0.5);

  if (nonMarkerPassEvidence.length === 0 && !hasPositiveOutcome) {
    return [makeFinding(
      'coding_complete_without_evidence',
      'warn',
      'Coding is marked complete but feature-state has no passing evidence beyond legacy markers',
      {
        file: join(featureDir, 'feature-state.json'),
        details: {
          markerExists,
          codingResultCompleted,
          evidenceCount: featureState.evidence.length,
          passEvidenceCount: passEvidence.length,
        },
      },
    )];
  }

  return [];
}

function checkEvalWithoutOutcome(
  featureDir: string,
  featureStateResult: JsonReadResult<FeatureState>,
  evalRecords: EvalRecord[],
  taskId: string | null,
  slug: string | null,
  traceId: string | null,
  repoDir: string,
): ArtifactDiagnosticFinding[] {
  // Find matching eval records. Match by traceId, issueId, or challengePairId
  // derived from the taskId (the `<id>_c` challenger convention) so challenge
  // pair evals are not silently missed.
  const challengePairId = taskId ? `${taskId}_c` : null;
  const matchingEvals = evalRecords.filter(r => {
    if (traceId && r.traceId === traceId) return true;
    if (taskId && r.issueId === taskId) return true;
    if (challengePairId && r.challengePairId === challengePairId) return true;
    return false;
  });

  if (matchingEvals.length === 0) return [];

  // Check if feature state is final
  const isFinal = featureStateResult.status === 'ok' &&
    (featureStateResult.value.outcome.completed === true || featureStateResult.value.currentPhase === 'done');

  // Also check archive dir for archived feature-state
  if (!isFinal && taskId) {
    let archiveDir: string | undefined;
    try {
      archiveDir = resolveRouteArtifactArchiveDir(taskId, repoDir);
    } catch {
      archiveDir = undefined;
    }
    if (archiveDir) {
      const archivedStatePath = join(archiveDir, 'feature-state.json');
      const archivedResult = readJsonTolerant<FeatureState>(archivedStatePath);
      if (archivedResult.status === 'ok' &&
        (archivedResult.value.outcome.completed === true || archivedResult.value.currentPhase === 'done')) {
        return [];
      }
    }
  }

  if (!isFinal) {
    return [makeFinding(
      'eval_without_outcome',
      'warn',
      `${matchingEvals.length} eval record(s) found but feature-state is absent or non-final`,
      {
        file: join(featureDir, 'feature-state.json'),
        details: {
          evalCount: matchingEvals.length,
          featureStatePresent: featureStateResult.status !== 'missing',
          featurePhase: featureStateResult.status === 'ok' ? featureStateResult.value.currentPhase : null,
        },
      },
    )];
  }

  return [];
}

function checkTraceIdMissing(
  featureDir: string,
  traceId: string | null,
): ArtifactDiagnosticFinding[] {
  if (!traceId) return [];

  const findings: ArtifactDiagnosticFinding[] = [];
  const routePaths = ['.initial-route.json', '.post-expansion-route.json'];

  for (const routePath of routePaths) {
    const absPath = join(featureDir, routePath);
    if (!existsSync(absPath)) continue;
    const result = readJsonTolerant<Record<string, unknown>>(absPath);
    if (result.status === 'ok' && !result.value.traceId) {
      findings.push(makeFinding(
        'trace_id_missing',
        'info',
        `Route artifact does not include traceId: ${routePath}`,
        { file: absPath, details: { traceId, artifactClass: 'route' } },
      ));
    }
  }

  const stageResultPaths = ['.planning-result.json', '.coding-result.json', '.review-result.json', '.ready-result.json'];
  let stagesMissingTraceId = 0;
  const stagesPresent: string[] = [];
  for (const stagePath of stageResultPaths) {
    const absPath = join(featureDir, stagePath);
    if (!existsSync(absPath)) continue;
    const result = readJsonTolerant<Record<string, unknown>>(absPath);
    if (result.status === 'ok' && !result.value.traceId) {
      stagesMissingTraceId++;
      stagesPresent.push(stagePath);
    }
  }
  if (stagesMissingTraceId > 0) {
    findings.push(makeFinding(
      'trace_id_missing',
      'info',
      `${stagesMissingTraceId} stage result(s) do not include traceId`,
      { file: featureDir, details: { traceId, artifactClass: 'stage', stages: stagesPresent } },
    ));
  }

  return findings;
}

function checkTraceEventUnreflected(
  featureDir: string,
  traceEvents: TraceEvent[],
  featureState: FeatureState | null,
): ArtifactDiagnosticFinding[] {
  if (traceEvents.length === 0 || !featureState) return [];

  const findings: ArtifactDiagnosticFinding[] = [];

  const routeEvents = traceEvents.filter(e =>
    e.event === 'route_assigned' || e.event === 'route_promoted',
  );
  const fallbackEvents = traceEvents.filter(e => e.event === 'fallback_used');
  const checkFailedEvents = traceEvents.filter(e => e.event === 'check_failed');

  // Route events should be reflected in feature-state route provenance
  if (routeEvents.length > 0 && !featureState.route) {
    findings.push(makeFinding(
      'trace_event_unreflected',
      'info',
      `${routeEvents.length} route event(s) in trace but feature-state has no route provenance`,
      {
        file: join(featureDir, 'trace.jsonl'),
        details: {
          routeEventCount: routeEvents.length,
          eventNames: [...new Set(routeEvents.map(e => e.event))],
        },
      },
    ));
  }

  // Fallback events should be reflected in blockers or failure reason
  if (fallbackEvents.length > 0) {
    const hasBlockerOrFailure = featureState.blockers.length > 0 || featureState.failureReason !== null;
    const hasFallbackEvidence = featureState.evidence.some(
      e => e.status === 'fail' || e.kind === 'blocked_completion',
    );
    if (!hasBlockerOrFailure && !hasFallbackEvidence) {
      findings.push(makeFinding(
        'trace_event_unreflected',
        'info',
        `${fallbackEvents.length} fallback event(s) in trace not reflected in feature-state blockers or failure signals`,
        {
          file: join(featureDir, 'trace.jsonl'),
          details: { fallbackEventCount: fallbackEvents.length },
        },
      ));
    }
  }

  // Check-failure events should be reflected in blockers or failing evidence
  if (checkFailedEvents.length > 0) {
    const hasFailEvidence = featureState.evidence.some(e => e.status === 'fail');
    const hasBlockers = featureState.blockers.length > 0;
    if (!hasFailEvidence && !hasBlockers) {
      findings.push(makeFinding(
        'trace_event_unreflected',
        'info',
        `${checkFailedEvents.length} check_failed event(s) in trace not reflected in feature-state blockers or evidence`,
        {
          file: join(featureDir, 'trace.jsonl'),
          details: { checkFailedEventCount: checkFailedEvents.length },
        },
      ));
    }
  }

  return findings;
}

// ── Main Diagnostic Function ──────────────────────────────────────────────────

/**
 * Diagnose normalized task artifacts for a given feature.
 *
 * Read-only. Never throws. Reports coverage gaps, hash drift, state
 * mismatches, and trace inconsistencies as structured findings.
 */
export function diagnoseArtifacts(options: DiagnoseArtifactsOptions): ArtifactDiagnosticsReport {
  const repoDir = resolve(options.repoDir);
  const identity = resolveIdentity({ ...options, repoDir });
  const { featureDir, taskId, slug } = identity;
  const findings: ArtifactDiagnosticFinding[] = [];

  const generatedAt = new Date().toISOString();

  // Artifact path defaults (even when featureDir is null, for the report shape)
  const contractPath = featureDir ? join(featureDir, 'task-contract.json') : '';
  const statePath = featureDir ? join(featureDir, 'feature-state.json') : '';
  const tracePath = featureDir ? join(featureDir, 'trace.jsonl') : '';

  let contractMeta = { path: contractPath, present: false, malformed: false };
  let stateMeta = { path: statePath, present: false, malformed: false };
  let traceMeta = { path: tracePath, present: false, malformedLines: 0 };

  // Ambiguous feature dir warning — emit candidates and return early
  if (identity.ambiguous) {
    findings.push(makeFinding(
      'coverage_gap',
      'warn',
      `Multiple feature directories match taskId "${taskId ?? ''}" — cannot determine which to inspect`,
      {
        taskId: taskId ?? undefined,
        details: { candidates: identity.candidates ?? [] },
      },
    ));
    return buildReport(repoDir, null, taskId, slug, generatedAt, contractMeta, stateMeta, traceMeta, findings);
  }

  // Coverage gap for repo-level: no feature dir resolved
  if (!featureDir) {
    findings.push(makeFinding(
      'coverage_gap',
      'info',
      'No feature directory could be resolved — reporting repo-level coverage only',
    ));
    return buildReport(repoDir, null, taskId, slug, generatedAt, contractMeta, stateMeta, traceMeta, findings);
  }

  // ── Load artifacts ────────────────────────────────────────────────────────

  const contractResult = readJsonTolerant<TaskContract>(contractPath);
  const stateResult = readJsonTolerant<FeatureState>(statePath);
  const traceResult = readJsonlTolerant<TraceEvent>(tracePath);

  // Update artifact metadata
  contractMeta = {
    path: contractPath,
    present: contractResult.status !== 'missing',
    malformed: contractResult.status === 'malformed',
  };
  stateMeta = {
    path: statePath,
    present: stateResult.status !== 'missing',
    malformed: stateResult.status === 'malformed',
  };
  traceMeta = {
    path: tracePath,
    present: !traceResult.missing,
    malformedLines: traceResult.malformedLines.length,
  };

  // Coverage gap findings
  if (contractResult.status === 'missing') {
    findings.push(makeFinding('coverage_gap', 'info', 'task-contract.json is absent', { file: contractPath }));
  }
  if (stateResult.status === 'missing') {
    findings.push(makeFinding('coverage_gap', 'info', 'feature-state.json is absent', { file: statePath }));
  }
  if (traceResult.missing) {
    findings.push(makeFinding('coverage_gap', 'info', 'trace.jsonl is absent', { file: tracePath }));
  }

  // Malformed artifact findings
  if (contractResult.status === 'malformed') {
    findings.push(makeFinding('malformed', 'error', `task-contract.json is malformed: ${contractResult.reason}`, {
      file: contractPath,
      reason: contractResult.reason,
    }));
  }
  if (stateResult.status === 'malformed') {
    findings.push(makeFinding('malformed', 'error', `feature-state.json is malformed: ${stateResult.reason}`, {
      file: statePath,
      reason: stateResult.reason,
    }));
  }
  for (const { line, reason } of traceResult.malformedLines) {
    findings.push(makeFinding('malformed', 'error', `trace.jsonl line ${line} is malformed: ${reason}`, {
      file: tracePath,
      reason,
      details: { line },
    }));
  }

  // ── Cross-source checks ───────────────────────────────────────────────────

  const workflowState = readWorkflowState(repoDir);
  const { records: evalRecords } = readEvalRecordsTolerant(repoDir);

  // Determine traceId from context or trace events
  const traceContextPath = join(featureDir, '.trace-context.json');
  const traceContextResult = readJsonTolerant<Record<string, unknown>>(traceContextPath);
  let traceId: string | null = null;
  if (traceContextResult.status === 'ok' && typeof traceContextResult.value.traceId === 'string') {
    traceId = traceContextResult.value.traceId;
  } else if (traceResult.records.length > 0 && traceResult.records[0].traceId) {
    traceId = traceResult.records[0].traceId;
  }

  // 1. Contract hash drift
  if (contractResult.status === 'ok') {
    findings.push(...checkContractHashDrift(featureDir, contractResult.value));
  }

  // 2. Feature outcome state mismatch
  if (stateResult.status === 'ok') {
    findings.push(...checkFeatureOutcomeStateMismatch(
      featureDir,
      stateResult.value,
      workflowState,
      taskId,
      slug,
    ));
  }

  // 3. Coding complete without evidence
  if (stateResult.status === 'ok') {
    findings.push(...checkCodingCompleteWithoutEvidence(featureDir, stateResult.value));
  }

  // 4. Eval without final outcome
  findings.push(...checkEvalWithoutOutcome(
    featureDir,
    stateResult,
    evalRecords,
    taskId,
    slug,
    traceId,
    repoDir,
  ));

  // 5. Trace ID missing from route/stage artifacts
  findings.push(...checkTraceIdMissing(featureDir, traceId));

  // 6. Trace events not reflected in outcome
  const featureStateValue = stateResult.status === 'ok' ? stateResult.value : null;
  findings.push(...checkTraceEventUnreflected(featureDir, traceResult.records, featureStateValue));

  return buildReport(repoDir, featureDir, taskId, slug, generatedAt, contractMeta, stateMeta, traceMeta, findings);
}

function buildReport(
  repoDir: string,
  featureDir: string | null,
  taskId: string | null,
  slug: string | null,
  generatedAt: string,
  contractMeta: { path: string; present: boolean; malformed: boolean },
  stateMeta: { path: string; present: boolean; malformed: boolean },
  traceMeta: { path: string; present: boolean; malformedLines: number },
  findings: ArtifactDiagnosticFinding[],
): ArtifactDiagnosticsReport {
  const summary = { info: 0, warn: 0, error: 0 };
  for (const f of findings) {
    summary[f.severity]++;
  }
  return {
    repoDir,
    featureDir,
    taskId,
    slug,
    generatedAt,
    artifacts: {
      taskContract: contractMeta,
      featureState: stateMeta,
      trace: traceMeta,
    },
    findings,
    summary,
  };
}
