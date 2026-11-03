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
/**
 * Find every task ID embedded anywhere in a session filename or run-dir name
 * (`expansion-expansion-HOK-1309-1788901038378`), not just at the end.
 */
export const TASK_ID_EMBEDDED_GLOBAL_RE = new RegExp(
  `(?<![A-Za-z0-9])${issueIdSource}(?:_c)?(?![A-Za-z0-9])`,
  'g',
);

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
 * Build the challenger state key for a recorded challenge pair ID.
 *
 * Pair IDs are base task IDs, so for every valid pair ID this equals
 * `challengerTaskId(pairId)`. Unlike `challengerTaskId` it never throws and
 * never collapses: read paths (state lookups, artifact paths, eval matching)
 * receive whatever pair ID was recorded, so an opaque ID (legacy state, test
 * fixtures) or a drifted `<ID>_c` pair ID gets the suffix appended verbatim.
 * The resulting key then matches no real task rather than throwing mid-read
 * or resolving an arm to itself as its own sibling. Use `challengerTaskId`
 * when the input must be a valid task ID.
 */
export function challengerTaskKey(pairId: string): string {
  return `${pairId}${CHALLENGER_SUFFIX}`;
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

/** Kind of prose dependency reference (issue ID, series code, or unresolved). */
export type ProseDepReferenceKind = 'issue' | 'series' | 'unresolved';

/** A dependency reference extracted from prose text. */
export interface ProseDepReference {
  /** 'issue' for normalized Linear IDs, 'series' for series codes, 'unresolved' for unparseable references. */
  kind: ProseDepReferenceKind;
  /** For 'issue': normalized Linear ID (e.g., "HOK-123"). For 'series': raw series code (e.g., "B2"). For 'unresolved': the unparseable text. */
  target: string;
  /** The matched phrase and surrounding sentence context (up to 300 chars). */
  evidence: string;
  /** The verb phrase that introduced the reference ("Blocked by", "Depends on", "After", "Once...lands"). */
  verb: string;
}

/** Pattern for series codes: uppercase letter followed by 1-3 digits. */
const SERIES_CODE_RE = /[A-Z]\d{1,3}/;

/**
 * Extract prose-written dependency references from issue text.
 *
 * Matches phrases like "Blocked by HOK-123.", "Depends on B2.", "After the review.", "Once B3 lands."
 * Returns references with kind 'issue' (for Linear IDs), 'series' (for series codes),
 * or 'unresolved' (for unmatched references or ambiguous text).
 *
 * @param text - The issue description or text to search.
 * @returns Array of extracted prose dependency references.
 */
export function extractProseDependencies(text: string | null | undefined): ProseDepReference[] {
  if (!text || typeof text !== 'string') return [];

  const results: ProseDepReference[] = [];

  // Patterns for different verb phrases
  const issueIdPattern = issueIdSource;
  const seriesPattern = SERIES_CODE_RE.source;

  // Match four types of patterns:
  // 1. "Blocked by IDENTIFIER"
  // 2. "Depends on IDENTIFIER"
  // 3. "After IDENTIFIER"
  // 4. "Once IDENTIFIER lands"
  const patterns: Array<[RegExp, string, boolean]> = [
    [new RegExp(`\\b(Blocked\\s+by)\\s+(${issueIdPattern}|${seriesPattern})`, 'gi'), 'Blocked by', false],
    [new RegExp(`\\b(Depends\\s+on)\\s+(${issueIdPattern}|${seriesPattern})`, 'gi'), 'Depends on', false],
    [new RegExp(`\\b(After)\\s+(${issueIdPattern}|${seriesPattern})`, 'gi'), 'After', false],
    [new RegExp(`\\b(Once)\\s+(${issueIdPattern}|${seriesPattern})\\s+(lands?)`, 'gi'), 'Once', true],
  ];

  // Collect all matches with their positions
  const matches: Array<{
    index: number;
    matchText: string;
    verb: string;
    target: string;
    isOnceLands: boolean;
    landsWord?: string;
  }> = [];

  for (const [regex, verbLabel, isOnceLands] of patterns) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      // Patterns have the structure:
      // 1-3: verb (group 1), identifier (group 2), optional word (group 3)
      const target = match[2]; // identifier is always in group 2
      if (target) {
        matches.push({
          index: match.index,
          matchText: match[0],
          verb: verbLabel,
          target,
          isOnceLands,
          landsWord: isOnceLands ? match[3] : undefined, // "lands" or "land" is in group 3 for Once pattern
        });
      }
    }
  }

  // Sort by index to process in order (handles overlapping matches)
  matches.sort((a, b) => a.index - b.index);

  // Process matches and extract evidence
  for (const matchInfo of matches) {
    // Extract evidence: find sentence boundaries
    let sentenceEnd = text.length;
    for (let i = matchInfo.index + matchInfo.matchText.length; i < text.length; i++) {
      if (text[i] === '.' || text[i] === '!' || text[i] === '?') {
        sentenceEnd = i + 1;
        break;
      }
    }

    let sentenceStart = 0;
    for (let i = matchInfo.index - 1; i >= 0; i--) {
      if (text[i] === '.' || text[i] === '!' || text[i] === '?') {
        sentenceStart = i + 1;
        break;
      }
    }

    let evidence = text.substring(sentenceStart, sentenceEnd).trim();
    if (evidence.length > 300) {
      evidence = evidence.substring(0, 297) + '...';
    }

    // Determine if target is an issue ID or series code
    const isIssueId = new RegExp(`^${issueIdPattern}$`).test(matchInfo.target);
    const isSeriesCode = new RegExp(`^${seriesPattern}$`).test(matchInfo.target);

    if (isIssueId || isSeriesCode) {
      // Build verb string
      const verb = matchInfo.isOnceLands
        ? `Once ${matchInfo.target} ${matchInfo.landsWord}`
        : matchInfo.verb;

      results.push({
        kind: isIssueId ? 'issue' : 'series',
        target: matchInfo.target,
        verb,
        evidence,
      });
    }
  }

  return results;
}
