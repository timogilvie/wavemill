import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getIntegrationConfig, getReadyConfig } from './config.ts';
import { errorMessage } from './error-utils.ts';
import { resolveOwnerRepo } from './github.ts';
import { cachedRequiredChecks, findCachedPullRequest } from './session-gh-cache.ts';

const execFileAsync = promisify(execFile);

export type NormalizedCheckStatus = 'success' | 'pending' | 'failure' | 'neutral' | 'skipped' | 'unknown';
export type CiConclusion = 'pass' | 'fail' | 'pending' | 'none' | 'unknown';
export type RequiredContextsSource = 'branch-protection' | 'config' | 'none';
export type CheckReadErrorType = 'command-failed' | 'timeout' | 'malformed-json' | 'network' | 'head-mismatch' | 'unknown';

export interface NormalizedCheckSummary {
  name: string;
  status: NormalizedCheckStatus;
  rawStatus: string;
  text?: string;
  annotations?: string[];
  detailsUrl?: string;
  databaseId?: number;
  details?: unknown;
}

export interface CheckReadError {
  reason: string;
  errorType: CheckReadErrorType;
}

export interface RequiredContextsResult {
  contexts: string[];
  source: RequiredContextsSource;
  readError?: CheckReadError;
}

export interface CiEvaluation {
  conclusion: Exclude<CiConclusion, 'unknown'>;
  observed: number;
  passing: number;
  failing: string[];
  pending: string[];
  missingRequired: string[];
  requiredContexts: string[];
  requiredSource?: RequiredContextsSource;
}

export interface PrCiStatus extends Omit<CiEvaluation, 'conclusion'> {
  conclusion: CiConclusion;
  checks: NormalizedCheckSummary[];
  headSha?: string;
  state?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  requiredSource: RequiredContextsSource;
  readError?: CheckReadError;
}

export interface PrCiStatusDeps {
  execFile: typeof execFileAsync;
  resolveOwnerRepo: (repoDir?: string) => string | undefined;
  getIntegrationRequiredChecks: (repoDir?: string) => string[];
}

export const prCiStatusDeps: PrCiStatusDeps = {
  execFile: execFileAsync,
  resolveOwnerRepo,
  getIntegrationRequiredChecks(repoDir?: string) {
    return getIntegrationConfig(repoDir).requiredChecks ?? [];
  },
};

function uniqueOrdered(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function timestampMs(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function checkTimestamp(check: NormalizedCheckSummary): number {
  const details = typeof check.details === 'object' && check.details !== null
    ? check.details as Record<string, unknown>
    : {};
  return Math.max(
    timestampMs(details.completedAt),
    timestampMs(details.startedAt),
    timestampMs(details.updatedAt),
  );
}

export function normalizeStatusCheckRollup(raw: unknown): NormalizedCheckSummary[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const byName = new Map<string, NormalizedCheckSummary>();

  raw.forEach((item, index) => {
    const entry = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {};
    const rawValue = [entry.conclusion, entry.state, entry.status, entry.bucket]
      .find((value) => value != null && String(value).trim() !== '') ?? '';
    const rawStatus = String(rawValue).toUpperCase();
    const name = String(entry.name ?? entry.context ?? `check-${index + 1}`);
    const text = [
      typeof entry.title === 'string' ? entry.title : '',
      typeof entry.summary === 'string' ? entry.summary : '',
      typeof entry.text === 'string' ? entry.text : '',
      typeof entry.detailsUrl === 'string' ? entry.detailsUrl : '',
    ].filter(Boolean).join('\n');
    const detailsUrl = typeof entry.detailsUrl === 'string' ? entry.detailsUrl : undefined;
    const databaseId = typeof entry.databaseId === 'number' ? entry.databaseId : undefined;
    let status: NormalizedCheckStatus = 'unknown';

    if (['SUCCESS', 'PASS'].includes(rawStatus)) status = 'success';
    else if (rawStatus === 'NEUTRAL') status = 'neutral';
    else if (rawStatus === 'SKIPPED') status = 'skipped';
    else if (['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING', 'ACTION_REQUIRED', 'REQUESTED'].includes(rawStatus)) {
      status = 'pending';
    } else if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'FAIL'].includes(rawStatus)) {
      status = 'failure';
    }
    if (status === 'unknown') {
      console.warn(`[pr-ci-status] Unknown CI check state for "${name}": "${rawStatus}"`);
    }

    const check = { name, status, rawStatus, text: text || undefined, detailsUrl, databaseId, details: entry };
    const existing = byName.get(name);
    if (!existing || checkTimestamp(check) >= checkTimestamp(existing)) {
      byName.set(name, check);
    }
  });

  return [...byName.values()];
}

export function classifyCheckReadError(error: unknown): CheckReadError {
  const message = errorMessage(error);
  const lower = message.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return { errorType: 'timeout', reason: message };
  }
  if (
    lower.includes('could not resolve host') ||
    lower.includes('network') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout')
  ) {
    return { errorType: 'network', reason: message };
  }
  if (lower.includes('spawn') || lower.includes('exit') || lower.includes('command failed')) {
    return { errorType: 'command-failed', reason: message };
  }
  return { errorType: 'unknown', reason: message };
}

export function evaluateCiChecks(
  checks: NormalizedCheckSummary[],
  requiredContexts: string[],
  options: { requireChecks?: boolean; requiredSource?: RequiredContextsSource } = {},
): CiEvaluation {
  const requireChecks = options.requireChecks ?? true;
  const required = uniqueOrdered(requiredContexts);
  const checkNames = new Set(checks.map((check) => check.name));
  const failing = checks.filter((check) => check.status === 'failure').map((check) => check.name);
  const pending = checks.filter((check) => check.status === 'pending' || check.status === 'unknown').map((check) => check.name);
  const passing = checks.filter((check) => ['success', 'neutral', 'skipped'].includes(check.status)).length;
  const missingRequired = required.filter((name) => !checkNames.has(name));

  let conclusion: CiEvaluation['conclusion'];
  if (checks.length === 0 && !requireChecks) {
    conclusion = 'none';
  } else if (failing.length > 0) {
    conclusion = 'fail';
  } else if (checks.length === 0 || pending.length > 0 || missingRequired.length > 0) {
    conclusion = 'pending';
  } else {
    conclusion = 'pass';
  }

  return {
    conclusion,
    observed: checks.length,
    passing,
    failing,
    pending,
    missingRequired,
    requiredContexts: required,
    requiredSource: options.requiredSource,
  };
}

export async function resolveRequiredContexts(
  baseBranch: string,
  repoDir: string,
  deps: Partial<PrCiStatusDeps> = {},
): Promise<RequiredContextsResult> {
  const resolvedDeps = { ...prCiStatusDeps, ...deps };
  // HOK-3206: branch protection is a session constant; the mill records it
  // once per base branch in the session repo cache.
  // A recorded empty list means the base has no protection (GitHub 404):
  // use the configured checks, as a live 404 would, without asking again.
  const cachedContexts = baseBranch ? cachedRequiredChecks(baseBranch) : undefined;
  if (cachedContexts && cachedContexts.length > 0) {
    return { contexts: uniqueOrdered(cachedContexts), source: 'branch-protection' };
  }
  if (cachedContexts) {
    const configured = uniqueOrdered(resolvedDeps.getIntegrationRequiredChecks(repoDir));
    return configured.length > 0 ? { contexts: configured, source: 'config' } : { contexts: [], source: 'none' };
  }
  const repo = resolvedDeps.resolveOwnerRepo(repoDir);
  if (repo && baseBranch) {
    try {
      const { stdout } = await resolvedDeps.execFile(
        'gh',
        ['api', `repos/${repo}/branches/${encodeURIComponent(baseBranch)}/protection/required_status_checks`, '--jq', '.contexts // []'],
        { cwd: repoDir, encoding: 'utf-8', maxBuffer: 1024 * 1024 },
      );
      const parsed = JSON.parse(stdout || '[]') as unknown;
      if (Array.isArray(parsed)) {
        return { contexts: uniqueOrdered(parsed.filter((item): item is string => typeof item === 'string')), source: 'branch-protection' };
      }
    } catch (error) {
      const fallback = uniqueOrdered(resolvedDeps.getIntegrationRequiredChecks(repoDir));
      if (fallback.length > 0) {
        return { contexts: fallback, source: 'config', readError: classifyCheckReadError(error) };
      }
      return { contexts: [], source: 'none', readError: classifyCheckReadError(error) };
    }
  }

  const fallback = uniqueOrdered(resolvedDeps.getIntegrationRequiredChecks(repoDir));
  return fallback.length > 0
    ? { contexts: fallback, source: 'config' }
    : { contexts: [], source: 'none' };
}

export async function fetchPrCiStatus(
  prNumber: number,
  repoDir: string,
  deps: Partial<PrCiStatusDeps> = {},
  options: { baseBranch?: string; requireChecks?: boolean; expectedHeadSha?: string } = {},
): Promise<PrCiStatus> {
  const resolvedDeps = { ...prCiStatusDeps, ...deps };
  let stdout = '';
  // HOK-3206: the monitor's batched per-pass PR query already carries every
  // field below. A cached row is used only when it matches the caller's
  // expected head (when one is given); otherwise read GitHub directly.
  const cached = findCachedPullRequest(prNumber, { expectedHeadSha: options.expectedHeadSha });
  if (cached && cached.statusCheckRollup !== undefined) {
    stdout = JSON.stringify({
      headRefOid: cached.headRefOid,
      state: cached.state,
      mergeable: cached.mergeable,
      mergeStateStatus: cached.mergeStateStatus,
      baseRefName: cached.baseRefName,
      statusCheckRollup: cached.statusCheckRollup,
    });
  } else {
    try {
      const result = await resolvedDeps.execFile(
        'gh',
        [
          'pr',
          'view',
          String(prNumber),
          '--json',
          'headRefOid,state,mergeable,mergeStateStatus,baseRefName,statusCheckRollup',
        ],
        { cwd: repoDir, encoding: 'utf-8', maxBuffer: 1024 * 1024 },
      );
      stdout = result.stdout;
    } catch (error) {
      return unknownCiStatus(classifyCheckReadError(error));
    }
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch (error) {
    return unknownCiStatus({
      errorType: 'malformed-json',
      reason: `gh pr view returned malformed JSON: ${errorMessage(error)}`,
    });
  }

  const observedHeadSha = typeof parsed.headRefOid === 'string' && parsed.headRefOid.trim()
    ? parsed.headRefOid.trim()
    : undefined;

  // Head-provenance guard (HOK-2938): when the caller knows which head it
  // expects (e.g. it just pushed one), never evaluate a rollup belonging to a
  // different head — checks from separate heads must never be combined.
  // Pending is the conservative verdict: the caller keeps waiting for truth
  // about its own head instead of promoting or blocking on another head's
  // checks (a cancelled superseded run must be informational only).
  const expectedHeadSha = options.expectedHeadSha?.trim();
  if (expectedHeadSha && observedHeadSha !== expectedHeadSha) {
    return {
      conclusion: 'pending',
      observed: 0,
      passing: 0,
      failing: [],
      pending: [],
      missingRequired: [],
      requiredContexts: [],
      checks: [],
      headSha: observedHeadSha,
      state: typeof parsed.state === 'string' ? parsed.state : undefined,
      mergeable: typeof parsed.mergeable === 'string' ? parsed.mergeable : undefined,
      mergeStateStatus: typeof parsed.mergeStateStatus === 'string' ? parsed.mergeStateStatus : undefined,
      requiredSource: 'none',
      readError: {
        errorType: 'head-mismatch',
        reason: `PR head is ${observedHeadSha ?? 'unknown'}, expected ${expectedHeadSha}; not evaluating checks from a different head`,
      },
    };
  }

  const baseBranch = options.baseBranch || (typeof parsed.baseRefName === 'string' ? parsed.baseRefName : '');
  const required = await resolveRequiredContexts(baseBranch, repoDir, resolvedDeps);
  const checks = normalizeStatusCheckRollup(parsed.statusCheckRollup);
  const evaluation = evaluateCiChecks(checks, required.contexts, {
    requireChecks: options.requireChecks ?? getReadyConfig(repoDir).requireCiChecks,
    requiredSource: required.source,
  });

  return {
    ...evaluation,
    checks,
    headSha: observedHeadSha,
    state: typeof parsed.state === 'string' ? parsed.state : undefined,
    mergeable: typeof parsed.mergeable === 'string' ? parsed.mergeable : undefined,
    mergeStateStatus: typeof parsed.mergeStateStatus === 'string' ? parsed.mergeStateStatus : undefined,
    requiredSource: required.source,
    readError: required.readError,
  };
}

function unknownCiStatus(readError: CheckReadError): PrCiStatus {
  return {
    conclusion: 'unknown',
    observed: 0,
    passing: 0,
    failing: [],
    pending: [],
    missingRequired: [],
    requiredContexts: [],
    checks: [],
    requiredSource: 'none',
    readError,
  };
}
