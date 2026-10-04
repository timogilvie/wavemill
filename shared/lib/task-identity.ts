/**
 * Task identity invariant (HOK-3113 / HOK-3114) — the one helper for turning a
 * mill task ID into a Linear issue ID and a challenge role.
 *
 * Vocabulary:
 * - **Linear issue ID** — `TEAM-123`, matching {@link ISSUE_ID_RE}. Team keys
 *   start with an uppercase letter and may contain digits (`H2O-7`).
 * - **Task ID** — the key under `.tasks` in workflow-state.json. A primary
 *   task ID is the Linear issue ID itself; a challenger task ID is the Linear
 *   issue ID plus {@link CHALLENGER_SUFFIX} (`HOK-123_c`).
 *
 * Invariants:
 * 1. A `_c` suffix means challenger regardless of any recorded metadata; a
 *    missing role never makes a `_c` ID primary.
 * 2. A valid recorded `linearIssueId` wins over the parsed base ID, but when
 *    the two disagree the result is an error — never a silent pick.
 * 3. Garbage (lowercase IDs, whitespace, unknown shapes) fails closed: parse
 *    returns `null`, resolve returns an error, and predicates return `false`.
 *
 * `shared/lib/task-identity.sh` is the bash twin. Both are pinned against
 * `tests/fixtures/task-identity-cases.json`; change them together.
 */

/** Canonical Linear issue ID shape: uppercase team key (digits allowed after the first letter), dash, number. */
export const ISSUE_ID_RE = /^[A-Z][A-Z0-9]*-\d+$/;

const issueIdSource = ISSUE_ID_RE.source.slice(1, -1);

/** Anchored primary or challenger task ID. */
export const TASK_ID_RE = new RegExp(`^${issueIdSource}(?:_c)?$`);
/** A task ID followed by the slug in a tmux window name. */
export const WINDOW_TASK_PREFIX_RE = new RegExp(`^(${issueIdSource}(?:_c)?)-(.+)$`);
/** Find primary issue IDs throughout prose. */
export const ISSUE_ID_GLOBAL_RE = new RegExp(`\\b${issueIdSource}\\b`, 'g');
/** Find a task ID in prose or a log line. */
export const ISSUE_ID_WORD_RE = new RegExp(`\\b${issueIdSource}(?:_c)?\\b`);
/** Match a task ID at the end of a session filename. */
export const TASK_ID_SUFFIX_RE = new RegExp(`-${issueIdSource}(?:_c)?$`);

/** Match a Linear issue URL, optionally allowing lowercase pasted IDs. */
export function linearIssueUrlRe(flags = ''): RegExp {
  return new RegExp(`^https?://linear\\.app/[^/]+/issue/(${issueIdSource})(?:[/?#].*)?$`, flags);
}

/** Task-ID suffix that marks the challenger arm of a challenge pair. */
export const CHALLENGER_SUFFIX = '_c';

/**
 * Linear issue URL shape accepted by `get_linear_issue_id` today:
 * `http(s)://linear.app/<workspace>/issue/<ID>` with an optional `/slug`,
 * `?query` or `#fragment` tail.
 */
const LINEAR_URL_RE = linearIssueUrlRe();

const CHALLENGER_TASK_ID_RE = new RegExp(`^(${issueIdSource})_c$`);

export type TaskRole = 'primary' | 'challenger';

/** A successfully parsed task ID. */
export interface ParsedTaskId {
  /** Canonical task ID (`HOK-1` or `HOK-1_c`; a URL input is reduced to its ID). */
  taskId: string;
  /** Linear issue ID derived structurally from the task ID. */
  linearId: string;
  /** `challenger` iff the task ID carries {@link CHALLENGER_SUFFIX}. */
  role: TaskRole;
}

/** The subset of a workflow-state task record this module reads. */
export interface TaskIdentityMeta {
  linearIssueId?: unknown;
  challengeRole?: unknown;
}

export type TaskIdentityErrorCode = 'invalid_task_id' | 'linear_id_mismatch';

export type LinearIssueIdResult =
  | { ok: true; linearId: string }
  | { ok: false; error: TaskIdentityErrorCode; message: string };

/**
 * Normalize a Linear issue ID or Linear issue URL to a bare issue ID.
 *
 * @param value - `HOK-123` or `https://linear.app/<ws>/issue/HOK-123[/slug]`.
 * @returns The issue ID, or `null` when the value is neither shape.
 */
export function normalizeIssueId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (ISSUE_ID_RE.test(value)) return value;
  const match = LINEAR_URL_RE.exec(value);
  return match ? match[1] : null;
}

/**
 * Parse a task ID into its canonical task ID, Linear issue ID and role.
 *
 * Accepts `HOK-123`, `HOK-123_c`, and Linear issue URLs (always primary).
 * Role is purely structural: metadata is not consulted.
 *
 * @returns The parsed identity, or `null` for anything else (fail closed).
 */
export function parseTaskId(taskId: unknown): ParsedTaskId | null {
  if (typeof taskId !== 'string') return null;
  const challenger = CHALLENGER_TASK_ID_RE.exec(taskId);
  if (challenger) {
    return { taskId, linearId: challenger[1], role: 'challenger' };
  }
  const linearId = normalizeIssueId(taskId);
  return linearId ? { taskId: linearId, linearId, role: 'primary' } : null;
}

/** True iff `taskId` parses as a challenger task ID (`<ID>_c`). */
export function isChallengerTaskId(taskId: unknown): boolean {
  return parseTaskId(taskId)?.role === 'challenger';
}

/**
 * Build the challenger task ID for a task. Idempotent on challenger IDs.
 *
 * @throws Error when `taskId` does not parse.
 */
export function challengerTaskId(taskId: string): string {
  const parsed = parseTaskId(taskId);
  if (!parsed) throw new Error(`Invalid task ID: ${JSON.stringify(taskId)}`);
  return `${parsed.linearId}${CHALLENGER_SUFFIX}`;
}

/**
 * Resolve the Linear issue ID a task should read from / write to.
 *
 * Precedence: the task ID must parse (fail closed even when metadata is
 * present). A recorded `linearIssueId` (whitespace-trimmed; ID or URL) that
 * normalizes to a valid ID wins, unless it disagrees with the parsed base ID,
 * in which case `linear_id_mismatch` is returned. An unusable recorded value
 * is ignored and the parsed base ID is used.
 */
export function resolveLinearIssueId(taskId: unknown, task?: TaskIdentityMeta | null): LinearIssueIdResult {
  const parsed = parseTaskId(taskId);
  if (!parsed) {
    return { ok: false, error: 'invalid_task_id', message: `Invalid task ID: ${JSON.stringify(taskId)}` };
  }
  const raw = task?.linearIssueId;
  const recorded = typeof raw === 'string' ? normalizeIssueId(raw.trim()) : null;
  if (recorded && recorded !== parsed.linearId) {
    return {
      ok: false,
      error: 'linear_id_mismatch',
      message: `Task ${parsed.taskId} records linearIssueId ${recorded} but its ID resolves to ${parsed.linearId}`,
    };
  }
  return { ok: true, linearId: recorded ?? parsed.linearId };
}

/**
 * True iff this task may write to its Linear issue (status, comments).
 *
 * Only a primary task with a resolvable, non-conflicting Linear ID writes.
 * Challengers never write; a primary-shaped ID whose metadata records
 * `challengeRole: "challenger"` is also refused, since the two sources
 * disagree and the safe answer is "no".
 */
export function isLinearWriter(taskId: unknown, task?: TaskIdentityMeta | null): boolean {
  const parsed = parseTaskId(taskId);
  if (!parsed || parsed.role !== 'primary') return false;
  if (task?.challengeRole === 'challenger') return false;
  return resolveLinearIssueId(taskId, task).ok;
}
