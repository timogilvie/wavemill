/**
 * Session-scoped GitHub read caches (HOK-3206).
 *
 * The mill monitor makes ONE batched `gh pr list --search 'head:<b1> head:<b2> …'`
 * query per pass and writes the rows to the per-pass PR cache
 * (`WAVEMILL_SESSION_PR_CACHE`, a JSON array in `gh pr list --json` shape).
 * Repo-level constants (`nameWithOwner`, branch-protection required checks)
 * live in the session repo cache (`WAVEMILL_SESSION_REPO_CACHE`), written once
 * per mill session.
 *
 * Every reader here is best-effort and fail-open to the network: a missing,
 * unreadable, stale or malformed cache returns `null`, and the caller falls
 * back to its own direct `gh` call. A cache hit is never allowed to change a
 * verdict on its own — head-sensitive callers must pass `expectedHeadSha` so a
 * row for another head reads as a miss.
 *
 * Kill switch: `WAVEMILL_DISABLE_GH_BATCH_CACHE=1` makes every reader return
 * `null` (restores the pre-HOK-3206 direct `gh` call pattern at every site).
 */

import { readFileSync, statSync } from 'node:fs';

/** Default max age for the per-pass PR cache before readers ignore it. */
export const DEFAULT_PR_CACHE_MAX_AGE_MS = 180_000;

/** One row of the per-pass PR cache (`gh pr list --json` shape, all optional). */
export interface CachedPullRequest {
  number: number;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  state?: string;
  mergedAt?: string | null;
  mergeable?: string;
  mergeStateStatus?: string;
  statusCheckRollup?: unknown;
  labels?: Array<{ name?: string }>;
  url?: string;
  title?: string;
  body?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Session repo cache shape written by `wavemill_session_repo_cache_refresh`. */
export interface SessionRepoCache {
  nameWithOwner?: string;
  defaultBranch?: string;
  /** Branch-protection required contexts keyed by base branch name. */
  requiredChecks?: Record<string, string[]>;
  updatedAt?: string;
}

export interface CacheReadOptions {
  env?: NodeJS.ProcessEnv;
  /** Override "now" for age checks (tests). */
  nowMs?: number;
  /** Max cache file age before it is ignored. Default 180 s. */
  maxAgeMs?: number;
}

export function ghBatchCacheDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WAVEMILL_DISABLE_GH_BATCH_CACHE === '1';
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch {
    return undefined;
  }
}

function fileAgeMs(path: string, nowMs: number): number | null {
  try {
    return nowMs - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the per-pass PR cache. Returns `null` when disabled, unset, missing,
 * older than `maxAgeMs`, or not a JSON array — callers then use direct `gh`.
 */
export function readSessionPrCache(options: CacheReadOptions = {}): CachedPullRequest[] | null {
  const env = options.env ?? process.env;
  if (ghBatchCacheDisabled(env)) return null;
  const path = env.WAVEMILL_SESSION_PR_CACHE;
  if (!path) return null;

  const age = fileAgeMs(path, options.nowMs ?? Date.now());
  if (age === null || age > (options.maxAgeMs ?? DEFAULT_PR_CACHE_MAX_AGE_MS)) return null;

  const parsed = readJsonFile(path);
  if (!Array.isArray(parsed)) return null;
  return parsed.filter(
    (row): row is CachedPullRequest => isRecord(row) && typeof row.number === 'number',
  );
}

/**
 * Find one PR row by number. When `expectedHeadSha` is given, a row whose
 * `headRefOid` differs (or is absent) is a miss: never serve another head.
 */
export function findCachedPullRequest(
  prNumber: number,
  options: CacheReadOptions & { expectedHeadSha?: string } = {},
): CachedPullRequest | null {
  const rows = readSessionPrCache(options);
  if (!rows) return null;
  const row = rows.find((candidate) => candidate.number === prNumber);
  if (!row) return null;
  const expected = options.expectedHeadSha?.trim();
  if (expected && row.headRefOid !== expected) return null;
  return row;
}

/** All cached PR rows for a head branch, newest first by number. */
export function findCachedPullRequestsForBranch(
  branch: string,
  options: CacheReadOptions = {},
): CachedPullRequest[] | null {
  const rows = readSessionPrCache(options);
  if (!rows) return null;
  return rows
    .filter((row) => row.headRefName === branch)
    .sort((a, b) => b.number - a.number);
}

/** Read the session repo cache, or `null` when disabled/unset/unreadable. */
export function readSessionRepoCache(options: Omit<CacheReadOptions, 'maxAgeMs'> = {}): SessionRepoCache | null {
  const env = options.env ?? process.env;
  if (ghBatchCacheDisabled(env)) return null;
  const path = env.WAVEMILL_SESSION_REPO_CACHE;
  if (!path) return null;
  const parsed = readJsonFile(path);
  return isRecord(parsed) ? (parsed as SessionRepoCache) : null;
}

/** Cached `nameWithOwner`, or `undefined` on any miss. */
export function cachedNameWithOwner(options: Omit<CacheReadOptions, 'maxAgeMs'> = {}): string | undefined {
  const value = readSessionRepoCache(options)?.nameWithOwner;
  return typeof value === 'string' && value.includes('/') ? value : undefined;
}

/**
 * Cached branch-protection required contexts for `baseBranch`. Returns
 * `undefined` when the base was never recorded (a miss, so the caller asks
 * GitHub) and an array (possibly empty) when it was.
 */
export function cachedRequiredChecks(
  baseBranch: string,
  options: Omit<CacheReadOptions, 'maxAgeMs'> = {},
): string[] | undefined {
  const required = readSessionRepoCache(options)?.requiredChecks;
  if (!required || !Object.prototype.hasOwnProperty.call(required, baseBranch)) return undefined;
  const contexts = required[baseBranch];
  return Array.isArray(contexts) ? contexts.filter((item): item is string => typeof item === 'string') : undefined;
}

// ── Batched per-pass PR fetch ───────────────────────────────────────────────

/**
 * The superset of `gh pr list --json` fields every per-task PR reader needs.
 * Keep in sync with `WAVEMILL_PR_CACHE_FIELDS` in `wavemill-common.sh`.
 */
export const PR_CACHE_FIELDS = [
  'number',
  'headRefName',
  'headRefOid',
  'baseRefName',
  'state',
  'mergedAt',
  'mergeable',
  'mergeStateStatus',
  'statusCheckRollup',
  'labels',
  'url',
  'title',
  'body',
  'createdAt',
  'updatedAt',
] as const;

/** Upper bound on rows per batched query (GitHub search page). */
export const PR_CACHE_BATCH_LIMIT = 100;

export type GhRunner = (args: string[]) => Promise<string>;

/**
 * Build the `gh pr list` argv for one batched query. GitHub search ORs
 * repeated `head:` qualifiers, so N task branches cost one request.
 * With no branches, falls back to the unfiltered open-PR dump.
 */
export function buildBatchPrListArgs(branches: string[]): string[] {
  const unique = [...new Set(branches.map((branch) => branch.trim()).filter(Boolean))].sort();
  const args = ['pr', 'list', '--json', PR_CACHE_FIELDS.join(',')];
  if (unique.length === 0) {
    return [...args, '--limit', '50'];
  }
  return [
    ...args,
    '--state', 'all',
    '--limit', String(PR_CACHE_BATCH_LIMIT),
    '--search', unique.map((branch) => `head:${branch}`).join(' '),
  ];
}

/**
 * Fetch PR rows for `branches` in one `gh` call, deduplicated by number and
 * restricted to the requested heads (search is token-based, so a row for a
 * different branch is dropped rather than trusted).
 */
export async function fetchBatchedPullRequests(
  branches: string[],
  runGh: GhRunner,
): Promise<CachedPullRequest[]> {
  const stdout = await runGh(buildBatchPrListArgs(branches));
  const parsed = JSON.parse(stdout || '[]') as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('gh pr list returned a non-array payload');
  }
  const wanted = new Set(branches.map((branch) => branch.trim()).filter(Boolean));
  const byNumber = new Map<number, CachedPullRequest>();
  for (const row of parsed) {
    if (!isRecord(row) || typeof row.number !== 'number') continue;
    if (wanted.size > 0 && !wanted.has(String(row.headRefName ?? ''))) continue;
    byNumber.set(row.number, row as unknown as CachedPullRequest);
  }
  return [...byNumber.values()].sort((a, b) => b.number - a.number);
}
