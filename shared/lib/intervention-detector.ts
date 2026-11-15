/**
 * Intervention detector — identifies human intervention events from
 * GitHub PR data and session metadata for eval scoring.
 *
 * Uses `gh` CLI for GitHub API calls (consistent with existing codebase patterns).
 * All functions are non-throwing: errors are caught and logged, returning
 * empty/partial results so eval can proceed with degraded data.
 *
 * @module intervention-detector
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolveClaudeProjectsDirsFor } from './session-adapters.ts';
import { loadWavemillConfig } from './config.ts';
import { errorMessage } from './error-utils.ts';
import { fetchPrReviews, resolveOwnerRepo } from './github.ts';
import { readJsonlFile } from './jsonl-utils.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import { loadReviewInterventions } from './review-intervention-mapper.ts';
import { resolveRouteArtifactArchiveDir } from './evals-paths.ts';
import type { StageName, StageResult, StageResultHistoryEntry, StageStatus } from './stage-result.ts';
import {
  OPERATOR_INTERVENTION_FILENAME,
  formatOperatorInterventionDetail,
  parseOperatorInterventions,
  readOperatorInterventions,
  type OperatorInterventionSeverity,
} from './operator-intervention.ts';
import {
  locateOwnershipRows,
  ownedSessionWindows,
  indexBySessionRef,
  type OwnedSessionWindow,
  type SessionOwnershipRow,
} from './session-ownership.ts';
import type {
  InterventionRecord,
  InterventionType,
  InterventionSeverity,
} from './eval-schema.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface ReviewComment {
  author: string;
  body: string;
  state: string;
  submittedAt: string;
}

export interface PrCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface InterventionEvent {
  type: 'review_comment' | 'post_pr_commit' | 'manual_edit' | 'test_fix' | 'session_redirect' | 'self_review_blocker' | 'self_review_warning' | 'operator_recovery' | 'prior_failed_attempt' | 'unknown_attribution';
  count: number;
  details: string[];
  timestamps?: string[]; // ISO 8601 timestamps parallel to details array
  severities?: InterventionSeverity[]; // Structured severity parallel to details array
  /** post_pr_commit only: agent-authored commits excluded from `count` (informational, never scored). */
  agentCount?: number;
}

export interface InterventionSummary {
  interventions: InterventionEvent[];
  totalInterventionScore: number;
}

export interface InterventionPenalties {
  review_comment: number;
  post_pr_commit: number;
  manual_edit: number;
  test_fix: number;
  session_redirect: number;
  self_review_blocker: number;
  self_review_warning: number;
  operator_recovery: number;
  prior_failed_attempt: number;
  unknown_attribution: number;
}

/** Format expected by evaluateTask() in eval.js */
export interface InterventionMeta {
  description: string;
  severity: 'minor' | 'major';
}

// ────────────────────────────────────────────────────────────────
// Defaults
// ────────────────────────────────────────────────────────────────

export const DEFAULT_PENALTIES: InterventionPenalties = {
  review_comment: 0.05,
  test_fix: 0.06,
  post_pr_commit: 0.08,
  manual_edit: 0.10,
  session_redirect: 0.12,
  self_review_warning: 0.05,   // Minor issue caught in review
  self_review_blocker: 0.20,   // Critical issue that blocks PR
  operator_recovery: 0.15,     // Operator-recorded diagnosis/recovery outside agent output
  prior_failed_attempt: 0.10,  // Earlier failed/aborted attempt before the scored run
  unknown_attribution: 0.05,   // Commit could not be attributed to agent or operator (fail loud, not silent)
};

// ────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────

/**
 * Read intervention penalty weights from .wavemill-config.json.
 * Falls back to DEFAULT_PENALTIES for any missing keys.
 */
export function loadPenalties(repoDir?: string): InterventionPenalties {
  const config = loadWavemillConfig(repoDir);
  const configured = config.eval?.interventionPenalties || {};
  return {
    review_comment: configured.reviewComment ?? DEFAULT_PENALTIES.review_comment,
    post_pr_commit: configured.postPrCommit ?? DEFAULT_PENALTIES.post_pr_commit,
    manual_edit: configured.manualEdit ?? DEFAULT_PENALTIES.manual_edit,
    test_fix: configured.testFix ?? DEFAULT_PENALTIES.test_fix,
    session_redirect: configured.sessionRedirect ?? DEFAULT_PENALTIES.session_redirect,
    self_review_blocker: configured.selfReviewBlocker ?? DEFAULT_PENALTIES.self_review_blocker,
    self_review_warning: configured.selfReviewWarning ?? DEFAULT_PENALTIES.self_review_warning,
    operator_recovery: configured.operatorRecovery ?? DEFAULT_PENALTIES.operator_recovery,
    prior_failed_attempt: configured.priorFailedAttempt ?? DEFAULT_PENALTIES.prior_failed_attempt,
    unknown_attribution: configured.unknownAttribution ?? DEFAULT_PENALTIES.unknown_attribution,
  };
}

// ────────────────────────────────────────────────────────────────
// GitHub Detection
// ────────────────────────────────────────────────────────────────

/**
 * Fetch PR review comments that request changes (not approvals/comments-only).
 * Uses `gh api` to get review data.
 */
export function detectReviewComments(prNumber: string, repoDir?: string, nwo?: string): InterventionEvent {
  const cwd = repoDir || process.cwd();
  const repo = nwo || resolveOwnerRepo(cwd);
  const event: InterventionEvent = { type: 'review_comment', count: 0, details: [], timestamps: [] };

  if (!repo) {
    console.warn('[intervention-detector] Cannot resolve GitHub repo — skipping review comment detection');
    return event;
  }

  try {
    const reviews = fetchPrReviews(prNumber, cwd, repo);
    const changeRequests = reviews.filter(
      (review) => review.state === 'CHANGES_REQUESTED' || review.state === 'COMMENTED',
    );
    for (const review of changeRequests) {
      if (review.body && review.body.trim()) {
        event.details.push(`[${review.state}] ${review.author}: ${review.body.slice(0, 200)}`);
        event.timestamps!.push(review.submittedAt);
      }
    }

    // Fetch inline review comments (code-level feedback)
    const commentsRaw = execShellCommand(
      `gh api repos/${escapeShellArg(repo)}/pulls/${escapeShellArg(prNumber)}/comments --jq '[.[] | {author: .user.login, body: .body, path: .path, line: .line, createdAt: .created_at}]'`,
      { encoding: 'utf-8', cwd, timeout: 15_000 }
    ).trim();

    if (commentsRaw) {
      const comments = JSON.parse(commentsRaw);
      for (const c of comments) {
        const location = c.path ? ` (${c.path}:${c.line || '?'})` : '';
        event.details.push(`[INLINE] ${c.author}${location}: ${c.body.slice(0, 200)}`);
        event.timestamps!.push(c.createdAt || new Date().toISOString());
      }
    }

    event.count = event.details.length;
  } catch (err: unknown) {
    const message = errorMessage(err);
    console.warn(`[intervention-detector] Failed to fetch PR review comments: ${message}`);
  }

  return event;
}

/**
 * Fetch all commits on a PR via GitHub API.
 * Returns parsed PrCommit array, or empty array on error.
 * Shared by detectPostPrCommits and detectManualEdits.
 */
export function fetchPrCommits(prNumber: string, repoDir?: string, nwo?: string): PrCommit[] {
  const cwd = repoDir || process.cwd();
  const repo = nwo || resolveOwnerRepo(cwd);
  if (!repo) {
    console.warn('[intervention-detector] Cannot resolve GitHub repo — skipping PR commit fetch');
    return [];
  }
  try {
    const commitsRaw = execShellCommand(
      `gh api repos/${escapeShellArg(repo)}/pulls/${escapeShellArg(prNumber)}/commits --jq '[.[] | {sha: .sha, message: .commit.message, author: .commit.author.name, date: .commit.author.date}]'`,
      { encoding: 'utf-8', cwd, timeout: 15_000 }
    ).trim();
    if (!commitsRaw) return [];
    return JSON.parse(commitsRaw) as PrCommit[];
  } catch (err: unknown) {
    const message = errorMessage(err);
    console.warn(`[intervention-detector] Failed to fetch PR commits: ${message}`);
    return [];
  }
}

/**
 * Detect commits made after the initial PR creation.
 * These indicate post-review fixes or manual edits pushed after the PR was opened.
 *
 * Accepts pre-fetched commits to avoid duplicate API calls when used alongside
 * detectManualEdits in detectAllInterventions.
 */
export function detectPostPrCommits(prNumber: string, repoDir?: string, prCommits?: PrCommit[], nwo?: string): InterventionEvent {
  const cwd = repoDir || process.cwd();
  const repo = nwo || resolveOwnerRepo(cwd);
  const event: InterventionEvent = { type: 'post_pr_commit', count: 0, details: [], timestamps: [] };

  if (!repo) {
    console.warn('[intervention-detector] Cannot resolve GitHub repo — skipping post-PR commit detection');
    return event;
  }

  try {
    // Get PR creation timestamp
    const prDataRaw = execShellCommand(
      `gh api repos/${escapeShellArg(repo)}/pulls/${escapeShellArg(prNumber)} --jq '{createdAt: .created_at, head: .head.sha, commits: .commits}'`,
      { encoding: 'utf-8', cwd, timeout: 15_000 }
    ).trim();

    if (!prDataRaw) return event;

    const prData = JSON.parse(prDataRaw);
    const prCreatedAt = new Date(prData.createdAt);

    const commits = prCommits ?? fetchPrCommits(prNumber, repoDir);
    return buildPostPrCommitEvent(commits, prCreatedAt);
  } catch (err: unknown) {
    const message = errorMessage(err);
    console.warn(`[intervention-detector] Failed to fetch PR commits: ${message}`);
  }

  return event;
}

/**
 * Classify a PR's commits against its creation time. A commit dated after
 * creation is a post-PR commit; agent-authored ones (`isAgentCommit`: review
 * remediation, ready-check fixes) are not operator touches, so they are kept
 * out of `count`/`details` and reported as `agentCount` instead (HOK-3245).
 *
 * The commit body is not returned separately by the PR commits API, so the
 * full message is passed as both subject and body — the trailer check still
 * fires on it.
 */
export function buildPostPrCommitEvent(commits: PrCommit[], prCreatedAt: Date): InterventionEvent {
  const event: InterventionEvent = { type: 'post_pr_commit', count: 0, details: [], timestamps: [], agentCount: 0 };
  for (const c of commits) {
    if (!(new Date(c.date) > prCreatedAt)) continue;
    if (isAgentCommit(c.message, c.author, c.message)) {
      event.agentCount! += 1;
      continue;
    }
    event.details.push(`${c.sha.slice(0, 7)}: ${c.message.split('\n')[0].slice(0, 200)}`);
    event.timestamps!.push(c.date);
  }
  event.count = event.details.length;
  return event;
}

// ────────────────────────────────────────────────────────────────
// Session Metadata Detection
// ────────────────────────────────────────────────────────────────

/**
 * Check whether a commit looks like it was made by an AI agent
 * based on co-author tags, author name, or subject markers.
 */
export function isAgentCommit(subject: string, author: string, body: string): boolean {
  const lowerBody = body.toLowerCase();
  const lowerAuthor = author.toLowerCase();
  return (
    lowerBody.includes('co-authored-by: claude') ||
    lowerBody.includes('co-authored-by: codex') ||
    lowerBody.includes('generated by codex') ||
    lowerBody.includes('generated by openai') ||
    subject.includes('[agent]') ||
    lowerAuthor.includes('claude') ||
    lowerAuthor.includes('codex')
  );
}

/**
 * Check whether a branch is managed by a wavemill workflow by looking for
 * task metadata files (selected-task.json or .coding-complete) in the
 * corresponding features/ or bugs/ directory.
 *
 * A wavemill-managed branch does NOT mean every commit on it is
 * agent-authored (see HOK-2894) — every mill task branch satisfies this
 * check by construction, so treating it as a blanket exemption would disable
 * manual-edit detection for the entire fleet. Instead this flag *enables*
 * window-based attribution in `detectManualEdits`: it tells the detector to
 * classify each commit against the agent's recorded activity windows and
 * operator-handoff intervals rather than relying solely on commit markers.
 */
/**
 * Whether an agent commits under the user's own git identity, leaving nothing
 * for `isAgentCommit` to recognise.
 *
 * Claude tags its commits (Co-Authored-By trailer), so its work is
 * distinguishable from a human's. Codex and every native/provider-backed
 * harness (`native`, `native-openrouter`, …) do not, so attributing authorship
 * from git metadata would mark all of their output as human manual edits.
 */
export function agentCommitsAsUser(agentType?: string): boolean {
  if (!agentType) return false;
  return agentType === 'codex' || agentType.startsWith('native');
}

export function isWavemillManagedBranch(branchName: string, repoDir?: string): boolean {
  const cwd = repoDir || process.cwd();
  const match = branchName.match(/^(?:task|feature|bugfix|bug)\/(.+)$/);
  if (!match) return false;

  const slug = match[1];

  // Task metadata lives in the main repo for interactive runs, but mill mode
  // writes it inside the task's own worktree (<worktreeRoot>/<slug>/features/
  // <slug>/). Checking only the main repo made this return false for every
  // mill task, which in turn let detectManualEdits flag an agent's own commits
  // as human edits for any agent that commits under the user's git identity.
  // Only roots wavemill actually uses: the configured worktreeRoot (resolved
  // relative to the repo, as wavemill-common.sh does) and the default beside
  // it. A bare '../worktrees' would resolve *outside* the repo, where two
  // sibling repos sharing a slug could make this return true for the wrong
  // one — which then suppresses real manual-edit detection on that branch.
  const roots = [cwd];
  const configuredRoot = loadWavemillConfig(repoDir).mill?.worktreeRoot;
  for (const root of [configuredRoot, 'worktrees']) {
    if (root) roots.push(join(resolve(cwd, root), slug));
  }

  for (const root of roots) {
    for (const dir of ['features', 'bugs']) {
      const taskDir = join(root, dir, slug);
      if (
        existsSync(join(taskDir, 'selected-task.json')) ||
        existsSync(join(taskDir, '.coding-complete'))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Detect interactive test fixes from commit messages.
 * Looks for patterns like "fix test", "fix failing", re-run indicators.
 *
 * When prNumber/prCommits are provided, uses GitHub API commits (same as
 * detectManualEdits) to avoid git log leakage.
 */
export function detectTestFixes(
  branchName: string,
  baseBranch: string,
  repoDir?: string,
  prNumber?: string,
  prCommits?: PrCommit[],
): InterventionEvent {
  const cwd = repoDir || process.cwd();
  const event: InterventionEvent = { type: 'test_fix', count: 0, details: [], timestamps: [] };

  const testFixPatterns = [
    /fix.*test/i,
    /test.*fix/i,
    /fix.*spec/i,
    /fix.*failing/i,
    /failing.*test/i,
    /repair.*test/i,
    /correct.*test/i,
  ];

  try {
    if (prNumber) {
      const commits = prCommits ?? fetchPrCommits(prNumber, repoDir);
      for (const c of commits) {
        const subject = c.message.split('\n')[0];
        if (testFixPatterns.some((p) => p.test(subject))) {
          event.details.push(`${c.sha.slice(0, 7)}: ${subject}`);
          event.timestamps!.push(c.date);
        }
      }
    } else {
      const commitsRaw = execShellCommand(
        `git log ${escapeShellArg(baseBranch)}..${escapeShellArg(branchName)} --format='%H|%s|%ad' --date=iso-strict 2>/dev/null || echo ''`,
        { encoding: 'utf-8', cwd, timeout: 10_000 }
      ).trim();

      if (!commitsRaw) return event;

      const lines = commitsRaw.split('\n').filter(Boolean);
      for (const line of lines) {
        const trimmed = line.trim();
        const [sha, subject, date] = trimmed.split('|');

        if (testFixPatterns.some((p) => p.test(subject))) {
          event.details.push(`${sha.slice(0, 7)}: ${subject}`);
          event.timestamps!.push(date || new Date().toISOString());
        }
      }
    }
    event.count = event.details.length;
  } catch (err: unknown) {
    const message = errorMessage(err);
    console.warn(`[intervention-detector] Failed to detect test fixes: ${message}`);
  }

  return event;
}

// ────────────────────────────────────────────────────────────────
// Session-based Detection
// ────────────────────────────────────────────────────────────────



// ────────────────────────────────────────────────────────────────
// Deduplication
// ────────────────────────────────────────────────────────────────

/**
 * Remove entries from `postPrEvent` whose SHA prefix (first 7 chars of detail)
 * also appears in `manualEditEvent`. This prevents double-counting commits
 * that are both post-PR and manual — the manual_edit penalty (higher) is kept.
 *
 * Mutates postPrEvent in place for efficiency.
 */
export function deduplicatePostPrAndManualEdits(
  postPrEvent: InterventionEvent,
  manualEditEvent: InterventionEvent,
): void {
  if (postPrEvent.count === 0 || manualEditEvent.count === 0) return;

  const manualShas = new Set(
    manualEditEvent.details.map((d) => d.slice(0, 7))
  );
  postPrEvent.details = postPrEvent.details.filter(
    (d) => !manualShas.has(d.slice(0, 7))
  );
  postPrEvent.count = postPrEvent.details.length;
}

// ────────────────────────────────────────────────────────────────
// Operator Artifact Detection
// ────────────────────────────────────────────────────────────────

const FAILED_ATTEMPT_STAGES: StageName[] = ['planning', 'coding', 'review'];
const FAILED_ATTEMPT_STATUSES: StageStatus[] = ['failed', 'aborted'];

function branchSlug(branchName?: string): string | undefined {
  if (!branchName) return undefined;
  return branchName.match(/^(?:task|feature|bugfix|bug)\/(.+)$/)?.[1];
}

function existingUnique(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const resolved = resolve(path);
    if (seen.has(resolved) || !existsSync(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

export interface ResolvedTaskArtifactDirs {
  featureDirs: string[];
  archiveDir?: string;
}

export function resolveTaskArtifactDirs(opts: DetectOptions): ResolvedTaskArtifactDirs {
  const repoDir = resolve(opts.repoDir || process.cwd());
  const config = loadWavemillConfig(repoDir);
  const slug = branchSlug(opts.branchName) || (opts.worktreePath ? basename(opts.worktreePath) : undefined);
  const roots = [
    opts.worktreePath,
    repoDir,
    slug && config.mill?.worktreeRoot ? join(resolve(repoDir, config.mill.worktreeRoot), slug) : undefined,
    slug ? join(resolve(repoDir, 'worktrees'), slug) : undefined,
  ].filter((value): value is string => Boolean(value));

  const featureDirs = slug
    ? existingUnique(roots.flatMap((root) => [join(root, 'features', slug), join(root, 'bugs', slug)]))
    : [];
  const archiveDir = resolveRouteArtifactArchiveDir(opts.issueId, repoDir);
  return {
    featureDirs,
    archiveDir: archiveDir && existsSync(archiveDir) ? archiveDir : undefined,
  };
}

// ────────────────────────────────────────────────────────────────
// Session-based Detection (HOK-3455)
// ────────────────────────────────────────────────────────────────

const LAUNCH_PROMPT_PATTERNS: RegExp[] = [
  /^You are working on:/, // allow-human-touch: launch-prompt shape for the one transcript reader
  /^#\s+Code Review/, // allow-human-touch: launch-prompt shape for the one transcript reader
  /^You are remediating a ready-check failure/, // allow-human-touch: launch-prompt shape for the one transcript reader
];

function looksLikeLaunchPrompt(content: string): boolean {
  return LAUNCH_PROMPT_PATTERNS.some((pattern) => pattern.test(content.trim()));
}

/** A user message extracted from a session transcript, with classification facts. */
export interface SessionUserMessage {
  content: string;
  timestamp: string;
  sessionId: string;
  /** Session file it came from (for grouping "first message per session"). */
  sessionFile: string;
  /**
   * `true` when this is the first string-content user message in its session
   * file — the caller's prompt, not a redirect (HOK-3468).
   */
  firstInSession?: boolean;
  provenance?: {
    isMeta?: boolean; // allow-human-touch: one transcript reader feeds classifyOperatorTouch
    isCompactSummary?: boolean; // allow-human-touch: one transcript reader feeds classifyOperatorTouch
    originKind?: string;
    promptSource?: string; // allow-human-touch: one transcript reader feeds classifyOperatorTouch
    /** Top-level Claude Code `entrypoint` (e.g. `sdk-cli`), carried for the classifier. */
    entrypoint?: string; // allow-human-touch: one transcript reader feeds classifyOperatorTouch
  };
}

/** Result of `detectSessionRedirects`: messages plus ownership context. */
export interface SessionRedirectResult {
  type: 'session_redirect';
  count: number;
  details: string[];
  timestamps?: string[];
  /** Full messages with facts for the reliability classifier. */
  messages: SessionUserMessage[];
  /** Owned session windows active for this branch. */
  ownedWindows: OwnedSessionWindow[];
  /** Map from session file to whether it is an owned session. */
  ownedSessionFiles: Set<string>;
  /**
   * True when at least one session transcript for the worktree was readable
   * (HOK-3468). Callers use it to prefer transcript facts over eval copies of
   * the same messages.
   */
  transcriptsRead: boolean;
}

interface SessionTranscriptRead {
  messages: SessionUserMessage[];
  /** Transcript files successfully parsed (whether or not they held user messages). */
  filesRead: number;
}

/**
 * The one Claude Code transcript reader (HOK-3455 / HOK-3468).
 *
 * Provenance flags are read from the top level first, because that is where
 * Claude Code writes `isMeta`, `isCompactSummary` and `entrypoint`; the nested
 * `provenance.*` object is kept as a fallback for older/other writers.
 */
function readSessionUserMessages(worktreePath: string, branchName: string, repoDir?: string, issueId?: string): SessionTranscriptRead {
  const messages: SessionUserMessage[] = [];
  let filesRead = 0;
  const seenFiles = new Set<string>();
  const seenMessages = new Set<string>();
  try {
    const projectsDirs = resolveClaudeProjectsDirsFor([worktreePath], repoDir, issueId).filter((projectsDir) => existsSync(projectsDir));
    if (projectsDirs.length === 0) return { messages, filesRead };

    let sessionFiles: string[];
    try {
      sessionFiles = projectsDirs.flatMap((projectsDir) =>
        readdirSync(projectsDir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => join(projectsDir, f))
      );
    } catch {
      return { messages, filesRead };
    }

    for (const filePath of sessionFiles) {
      try {
        const entries = readJsonlFile<Record<string, unknown>>(filePath);
        filesRead += 1;
        for (const entry of entries) {
          if (entry.type !== 'user') continue;
          if (entry.gitBranch !== branchName) continue;

          const message = entry.message as Record<string, unknown> | undefined;
          if (!message) continue;
          if (typeof message.content !== 'string') continue;

          const timestamp = typeof entry.timestamp === 'string'
            ? entry.timestamp
            : new Date().toISOString();
          const key = JSON.stringify([entry.sessionId, entry.uuid ?? timestamp, message.content]);
          if (seenMessages.has(key)) continue;
          seenMessages.add(key);
          const nested = entry.provenance as Record<string, unknown> | undefined;
          const flag = (key: string): unknown => (entry[key] !== undefined ? entry[key] : nested?.[key]);
          const entrypoint = flag('entrypoint');
          const firstInSession = !seenFiles.has(filePath);
          seenFiles.add(filePath);
          messages.push({
            content: message.content as string,
            timestamp,
            sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : filePath,
            sessionFile: filePath,
            firstInSession,
            provenance: {
              isMeta: Boolean(flag('isMeta')), // allow-human-touch: one transcript reader feeds classifyOperatorTouch
              isCompactSummary: Boolean(flag('isCompactSummary')), // allow-human-touch: one transcript reader feeds classifyOperatorTouch
              originKind: typeof flag('originKind') === 'string' ? (flag('originKind') as string) : undefined,
              promptSource: typeof flag('promptSource') === 'string' ? (flag('promptSource') as string) : undefined, // allow-human-touch: one transcript reader feeds classifyOperatorTouch
              entrypoint: typeof entrypoint === 'string' ? entrypoint : undefined, // allow-human-touch: one transcript reader feeds classifyOperatorTouch
            },
          });
        }
      } catch {
        continue;
      }
    }
  } catch (err: unknown) {
    console.warn(`[intervention-detector] Failed to read session messages: ${errorMessage(err)}`);
  }
  return { messages, filesRead };
}

function findTranscriptEndMs(row: SessionOwnershipRow, worktreePath: string, repoDir?: string, issueId?: string): number | undefined {
  const dirs = resolveClaudeProjectsDirsFor([worktreePath], repoDir, issueId).filter((d) => existsSync(d));
  for (const dir of dirs) {
    const file = join(dir, `${row.sessionRef}.jsonl`);
    if (!existsSync(file)) continue;
    try {
      let lastMs: number | undefined;
      for (const entry of readJsonlFile<{ timestamp?: string | number }>(file)) {
        const ts = typeof entry.timestamp === 'number' ? entry.timestamp : Date.parse(entry.timestamp ?? '');
        if (Number.isFinite(ts)) lastMs = ts;
      }
      return lastMs;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Detect user redirections from Claude session JSONL data.
 *
 * Per-session: the first string-content user message of an owned session is
 * the launch prompt and is not a redirect. All other messages are passed to
 * the classifier with their provenance.
 */
export function detectSessionRedirects(
  worktreePath: string,
  branchName: string,
  issueId?: string,
  repoDir?: string,
): SessionRedirectResult {
  const result: SessionRedirectResult = {
    type: 'session_redirect',
    count: 0,
    details: [],
    timestamps: [],
    messages: [],
    ownedWindows: [],
    ownedSessionFiles: new Set(),
    transcriptsRead: false,
  };

  const { messages, filesRead } = readSessionUserMessages(worktreePath, branchName, repoDir, issueId);
  result.transcriptsRead = filesRead > 0;
  if (messages.length === 0) return result;

  // Resolve ownership for this branch/worktree.
  const slug = branchName.match(/^(?:task|feature|bugfix|bug)\/(.+)$/)?.[1];
  const ownership = locateOwnershipRows({ repoDir, issueId, slug, worktreePath });
  const byRef = indexBySessionRef(ownership.rows);

  // Group messages by session file and mark first string message per session.
  const byFile = new Map<string, SessionUserMessage[]>();
  for (const msg of messages) {
    const list = byFile.get(msg.sessionFile) ?? [];
    list.push(msg);
    byFile.set(msg.sessionFile, list);
  }

  for (const [file, list] of byFile) {
    const sessionId = list[0]?.sessionId ?? '';
    const row = byRef.get(sessionId);
    if (row) result.ownedSessionFiles.add(file);
  }

  result.ownedWindows = ownedSessionWindows(ownership.rows, (row) =>
    findTranscriptEndMs(row, worktreePath, repoDir, issueId),
  );

  const redirections: SessionUserMessage[] = [];
  for (const [file, list] of byFile) {
    const isOwned = result.ownedSessionFiles.has(file);
    for (let i = 0; i < list.length; i++) {
      const msg = list[i];
      // First message of an owned session is the launch prompt. For unowned
      // sessions, skip a first message that matches the launch prompt shape
      // so tests and legacy transcripts behave consistently.
      if (i === 0 && (isOwned || looksLikeLaunchPrompt(msg.content))) continue;
      redirections.push(msg);
    }
  }

  result.count = redirections.length;
  result.details = redirections.map((m) => m.content.slice(0, 200));
  result.timestamps = redirections.map((m) => m.timestamp);
  result.messages = redirections;
  return result;
}

function severityForOperator(severity: OperatorInterventionSeverity): InterventionSeverity {
  return severity === 'major' ? 'high' : 'med';
}

export function detectOperatorInterventions(dirs: ResolvedTaskArtifactDirs): InterventionEvent {
  const event: InterventionEvent = {
    type: 'operator_recovery',
    count: 0,
    details: [],
    timestamps: [],
    severities: [],
  };
  const seen = new Set<string>();
  let foundFeatureRecord = false;

  for (const dir of dirs.featureDirs) {
    const path = join(dir, OPERATOR_INTERVENTION_FILENAME);
    if (!existsSync(path)) continue;
    foundFeatureRecord = true;
    for (const record of readOperatorInterventions(path)) {
      const key = `${record.occurredAt}|${record.stage ?? ''}|${record.attempt ?? ''}|${record.trigger ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      event.details.push(formatOperatorInterventionDetail(record));
      event.timestamps!.push(record.occurredAt);
      event.severities!.push(severityForOperator(record.severity));
    }
  }

  if (!foundFeatureRecord && dirs.archiveDir) {
    // HOK-2891: archive keeps the live basename (.operator-intervention.json).
    const path = join(dirs.archiveDir, OPERATOR_INTERVENTION_FILENAME);
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        for (const record of parseOperatorInterventions(raw, path)) {
          const key = `${record.occurredAt}|${record.stage ?? ''}|${record.attempt ?? ''}|${record.trigger ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          event.details.push(formatOperatorInterventionDetail(record));
          event.timestamps!.push(record.occurredAt);
          event.severities!.push(severityForOperator(record.severity));
        }
      } catch (err) {
        console.warn(`[intervention-detector] Failed to read operator intervention archive: ${errorMessage(err)}`);
      }
    }
  }

  event.count = event.details.length;
  return event;
}

/** Read one stage result file; `undefined` when absent/unparseable (tolerant). */
export function readStageResultSync(path: string): StageResult | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<StageResult>;
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (!parsed.stage || !parsed.status || !parsed.startedAt) return undefined;
    return parsed as StageResult;
  } catch (err) {
    console.warn(`[intervention-detector] Failed to read stage result ${path}: ${errorMessage(err)}`);
    return undefined;
  }
}

function truncateDetail(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function failedAttemptDetail(stage: StageName, attempt: number, entry: StageResultHistoryEntry | StageResult): string {
  const status = entry.status;
  const agentModel = [entry.agent, entry.model].filter(Boolean).join('/');
  const note = entry.failureReason || entry.notes || '';
  return truncateDetail(`${stage} attempt ${attempt} ${status}${agentModel ? ` (${agentModel})` : ''}${note ? `: ${note}` : ''}`, 200);
}

export function detectPriorFailedAttempts(dirs: ResolvedTaskArtifactDirs): InterventionEvent {
  const event: InterventionEvent = { type: 'prior_failed_attempt', count: 0, details: [], timestamps: [] };
  const seen = new Set<string>();
  const resultDirs = dirs.featureDirs.length > 0 ? dirs.featureDirs : [];
  if (dirs.archiveDir) resultDirs.push(dirs.archiveDir);

  // HOK-2891: live and archive share one basename for stage results.
  for (const dir of existingUnique(resultDirs)) {
    for (const stage of FAILED_ATTEMPT_STAGES) {
      const resultPath = join(dir, `.${stage}-result.json`);
      const result = readStageResultSync(resultPath);
      result?.history?.forEach((entry, index) => {
        if (!FAILED_ATTEMPT_STATUSES.includes(entry.status)) return;
        const key = `${stage}|${entry.startedAt}`;
        if (seen.has(key)) return;
        seen.add(key);
        event.details.push(failedAttemptDetail(stage, index + 1, entry));
        event.timestamps!.push(entry.finishedAt || entry.startedAt);
      });

      try {
        if (!existsSync(dir)) continue;
        const prefix = `.${stage}-result.attempt-`;
        const suffix = '-failed.json';
        for (const file of readdirSync(dir)) {
          if (!file.startsWith(prefix) || !file.endsWith(suffix)) continue;
          const sidecar = readStageResultSync(join(dir, file));
          if (!sidecar || !FAILED_ATTEMPT_STATUSES.includes(sidecar.status)) continue;
          const key = `${stage}|${sidecar.startedAt}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const attempt = Number(file.slice(prefix.length, -suffix.length)) || event.details.length + 1;
          event.details.push(failedAttemptDetail(stage, attempt, sidecar));
          event.timestamps!.push(sidecar.finishedAt || sidecar.startedAt);
        }
      } catch (err) {
        console.warn(`[intervention-detector] Failed to scan failed attempt sidecars in ${dir}: ${errorMessage(err)}`);
      }
    }
  }

  event.count = event.details.length;
  return event;
}

// ────────────────────────────────────────────────────────────────
// Manual-Edit Attribution (HOK-2894)
// ────────────────────────────────────────────────────────────────
//
// Positive agent-attribution for commits on wavemill-managed branches (and
// for agents that commit under the user's identity — see agentCommitsAsUser).
// Rather than presuming every commit is agent-authored (the HOK-2769
// over-correction this replaces), each commit is classified against the
// agent's recorded stage-result activity windows and any resolved
// operator-handoff intervals. Author dates (not committer dates) are used
// throughout because they survive the mill's auto-rebases onto the base
// branch, while recorded SHAs would not.

/** A span of time during which a stage's agent process was live. */
export interface AgentActivityWindow {
  /** Epoch ms — stage `startedAt`. */
  start: number;
  /** Epoch ms — stage `finishedAt`, or "now" for a still-running stage. */
  end: number;
  stage: StageName;
}

/** A resolved (or still-open) operator-handoff episode. */
export interface OperatorHandoffInterval {
  /** Epoch ms — when the mill detected uncommitted coding output. */
  detectedAt: number;
  /** Epoch ms — when the guard cleared (or "now" for a live, unresolved episode). */
  resolvedAt: number;
  dirtyPaths: string[];
  /** Epoch ms — mtime of `.coding-complete` when the episode was recorded, if known. */
  codingCompleteAt?: number;
}

// HOK-2891: archive keeps the live basename.
const CODING_UNCOMMITTED_OUTPUT_RESOLVED_LOG_FILENAME = '.coding-uncommitted-output.resolved.jsonl';
const CODING_UNCOMMITTED_OUTPUT_LIVE_FILENAME = '.coding-uncommitted-output.json';

/** Grace margin absorbing stamp/launch ordering and sub-second clock skew. */
export const AGENT_WINDOW_GRACE_MS = 120_000;

function parseTimestampMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Derive every recorded agent activity window (current stage results, their
 * `history[]` entries, and `attempt-N-failed` sidecars) across feature dirs
 * and the archived route-artifact dir. Windows are read-only evidence — a
 * commit landing inside one is presumed agent-authored under the user's
 * identity; a commit outside all of them is not.
 */
export function deriveAgentActivityWindows(dirs: ResolvedTaskArtifactDirs): AgentActivityWindow[] {
  const windows: AgentActivityWindow[] = [];
  const seen = new Set<string>();
  const nowMs = Date.now();

  const addWindow = (stage: StageName, startedAt: string | undefined, finishedAt: string | null | undefined) => {
    const start = parseTimestampMs(startedAt);
    if (start === undefined) return;
    const key = `${stage}|${startedAt}`;
    if (seen.has(key)) return;
    seen.add(key);
    const end = parseTimestampMs(finishedAt ?? undefined) ?? nowMs;
    windows.push({ stage, start, end });
  };

  const resultDirs = dirs.featureDirs.length > 0 ? [...dirs.featureDirs] : [];
  if (dirs.archiveDir) resultDirs.push(dirs.archiveDir);

  // HOK-2891: live and archive share one basename for stage results.
  for (const dir of existingUnique(resultDirs)) {
    for (const stage of FAILED_ATTEMPT_STAGES) {
      const resultPath = join(dir, `.${stage}-result.json`);
      const result = readStageResultSync(resultPath);
      if (result) {
        addWindow(stage, result.startedAt, result.finishedAt);
        for (const entry of result.history ?? []) {
          addWindow(stage, entry.startedAt, entry.finishedAt);
        }
      }

      try {
        if (!existsSync(dir)) continue;
        const prefix = `.${stage}-result.attempt-`;
        const suffix = '-failed.json';
        for (const file of readdirSync(dir)) {
          if (!file.startsWith(prefix) || !file.endsWith(suffix)) continue;
          const sidecar = readStageResultSync(join(dir, file));
          if (!sidecar) continue;
          addWindow(stage, sidecar.startedAt, sidecar.finishedAt);
        }
      } catch (err) {
        console.warn(`[intervention-detector] Failed to scan activity windows in ${dir}: ${errorMessage(err)}`);
      }
    }
  }

  return windows;
}

interface RawOperatorHandoffRecord {
  detectedAt?: string;
  resolvedAt?: string;
  dirtyPaths?: unknown;
  codingCompleteAt?: string | null;
}

function toDirtyPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Read every recorded operator-handoff episode: resolved episodes from
 * `.coding-uncommitted-output.resolved.jsonl` (feature dirs) / the archived
 * dotless copy, plus a still-live `.coding-uncommitted-output.json` as an
 * open interval (`resolvedAt = now`) for evals that run mid-handoff.
 */
export function readOperatorHandoffIntervals(dirs: ResolvedTaskArtifactDirs): OperatorHandoffInterval[] {
  const intervals: OperatorHandoffInterval[] = [];
  const seen = new Set<string>();
  const nowMs = Date.now();

  const addInterval = (record: RawOperatorHandoffRecord, resolvedFallbackMs?: number) => {
    const detectedAt = parseTimestampMs(record.detectedAt);
    if (detectedAt === undefined) return;
    const resolvedAt = parseTimestampMs(record.resolvedAt) ?? resolvedFallbackMs;
    if (resolvedAt === undefined) return;
    const key = `${detectedAt}|${resolvedAt}`;
    if (seen.has(key)) return;
    seen.add(key);
    intervals.push({
      detectedAt,
      resolvedAt,
      dirtyPaths: toDirtyPaths(record.dirtyPaths),
      codingCompleteAt: parseTimestampMs(record.codingCompleteAt ?? undefined),
    });
  };

  for (const dir of dirs.featureDirs) {
    const resolvedLogPath = join(dir, CODING_UNCOMMITTED_OUTPUT_RESOLVED_LOG_FILENAME);
    if (existsSync(resolvedLogPath)) {
      try {
        for (const record of readJsonlFile<RawOperatorHandoffRecord>(resolvedLogPath)) {
          addInterval(record);
        }
      } catch (err) {
        console.warn(`[intervention-detector] Failed to read resolved handoff log ${resolvedLogPath}: ${errorMessage(err)}`);
      }
    }

    const livePath = join(dir, CODING_UNCOMMITTED_OUTPUT_LIVE_FILENAME);
    if (existsSync(livePath)) {
      try {
        const raw = JSON.parse(readFileSync(livePath, 'utf-8')) as RawOperatorHandoffRecord;
        addInterval(raw, nowMs);
      } catch (err) {
        console.warn(`[intervention-detector] Failed to read live handoff artifact ${livePath}: ${errorMessage(err)}`);
      }
    }
  }

  if (dirs.archiveDir) {
    const archivedLogPath = join(dirs.archiveDir, CODING_UNCOMMITTED_OUTPUT_RESOLVED_LOG_FILENAME);
    if (existsSync(archivedLogPath)) {
      try {
        for (const record of readJsonlFile<RawOperatorHandoffRecord>(archivedLogPath)) {
          addInterval(record);
        }
      } catch (err) {
        console.warn(`[intervention-detector] Failed to read archived handoff log ${archivedLogPath}: ${errorMessage(err)}`);
      }
    }
  }

  return intervals;
}

export type CommitAttribution = 'agent' | 'operator_handoff' | 'operator_out_of_window' | 'unattributed' | 'unknown';

function isDuringHandoffEpisode(commitDateMs: number, intervals: OperatorHandoffInterval[]): boolean {
  return intervals.some((interval) => commitDateMs >= interval.detectedAt && commitDateMs <= interval.resolvedAt);
}

function isInOwnedSession(commitDateMs: number, windows: OwnedSessionWindow[]): boolean {
  return windows.some((w) => commitDateMs >= w.fromMs && commitDateMs <= w.toMs);
}

function ownedSessionLaunchedDuringHandoff(
  commitDateMs: number,
  ownershipRows: SessionOwnershipRow[],
  intervals: OperatorHandoffInterval[],
): boolean {
  for (const row of ownershipRows) {
    const launched = Date.parse(row.launchedAt);
    if (!Number.isFinite(launched)) continue;
    if (launched > commitDateMs) continue;
    if (!isDuringHandoffEpisode(launched, intervals)) continue;
    // A session launched during a handoff and still active at commit time
    // is the mill recovering itself (HOK-3128).
    if (isInOwnedSession(commitDateMs, ownedSessionWindows([row], () => undefined))) return true;
  }
  return false;
}

/**
 * Classify one commit's author-date against recorded evidence.
 *
 * Priority order (HOK-3455):
 * 1. Commit inside an owned session launched during a handoff episode → agent.
 * 2. Commit inside any handoff interval → operator handoff.
 * 3. Commit inside an owned session window → agent.
 * 4. Task has ownership rows, commit outside them → operator.
 * 5. No ownership rows, commit inside a stage window → agent.
 * 6. No ownership rows, outside all windows → unattributed.
 */
export function classifyCommitAttribution(
  commitDateMs: number,
  windows: AgentActivityWindow[],
  intervals: OperatorHandoffInterval[],
  hasAttributionData: boolean,
  ownership?: { rows: SessionOwnershipRow[]; windows: OwnedSessionWindow[]; hasRows: boolean },
): CommitAttribution {
  if (ownership && ownedSessionLaunchedDuringHandoff(commitDateMs, ownership.rows, intervals)) {
    return 'agent';
  }

  for (const interval of intervals) {
    if (commitDateMs >= interval.detectedAt && commitDateMs <= interval.resolvedAt) {
      return 'operator_handoff';
    }
  }

  if (ownership) {
    if (isInOwnedSession(commitDateMs, ownership.windows)) return 'agent';
    if (ownership.hasRows) return 'operator_out_of_window';
  }

  for (const window of windows) {
    if (commitDateMs >= window.start - AGENT_WINDOW_GRACE_MS && commitDateMs <= window.end + AGENT_WINDOW_GRACE_MS) {
      return 'agent';
    }
  }

  return (ownership && !ownership.hasRows) || hasAttributionData ? 'unattributed' : 'unknown';
}

interface ParsedCommit {
  sha: string;
  subject: string;
  author: string;
  body: string;
  date: string;
}

function parsePrCommits(commits: PrCommit[]): ParsedCommit[] {
  return commits.map((c) => {
    const subject = c.message.split('\n')[0];
    const body = c.message.includes('\n') ? c.message.slice(c.message.indexOf('\n') + 1) : '';
    return { sha: c.sha, subject, author: c.author, body, date: c.date };
  });
}

function parseGitLogCommits(branchName: string, baseBranch: string, cwd: string): ParsedCommit[] {
  const commitsRaw = execShellCommand(
    `git log ${escapeShellArg(baseBranch)}..${escapeShellArg(branchName)} --format='%H|%s|%an|%ad|%b%x00' --date=iso-strict 2>/dev/null || echo ''`,
    { encoding: 'utf-8', cwd, timeout: 10_000 }
  ).trim();
  if (!commitsRaw) return [];

  const commits: ParsedCommit[] = [];
  for (const record of commitsRaw.split('\0').filter((r) => r.trim())) {
    const trimmed = record.trim();
    const [sha, subject, author, date, ...bodyParts] = trimmed.split('|');
    if (!sha) continue;
    commits.push({ sha, subject, author, body: bodyParts.join('|'), date: date || new Date().toISOString() });
  }
  return commits;
}

export interface ManualEditsResult {
  manualEdit: InterventionEvent;
  unknownAttribution: InterventionEvent;
}

/**
 * Detect manual file edits — commits not attributed to the agent — and
 * emit an `unknown_attribution` event for commits that cannot be classified
 * at all (HOK-2894: fail loud rather than a silent zero).
 *
 * When a prNumber is provided, uses GitHub API to get the exact set of PR
 * commits (avoids false positives from `git log main..branch` which can
 * include commits from other merged PRs post-squash-merge). Falls back to
 * `git log` when no PR number is available.
 *
 * On wavemill-managed branches (`isWavemillManagedBranch`) and for agents
 * that commit under the user's own git identity (`agentCommitsAsUser`),
 * commits without an agent marker are classified against recorded agent
 * activity windows and operator-handoff intervals instead of being flagged
 * outright — this is the HOK-2769 protection. All other branches keep the
 * original marker-only behavior unchanged.
 */
export function detectManualEdits(opts: DetectOptions): ManualEditsResult {
  const branchName = opts.branchName || '';
  const baseBranch = opts.baseBranch || 'main';
  const cwd = opts.repoDir || process.cwd();
  const manualEdit: InterventionEvent = { type: 'manual_edit', count: 0, details: [], timestamps: [], severities: [] };
  const unknownAttribution: InterventionEvent = { type: 'unknown_attribution', count: 0, details: [], timestamps: [], severities: [] };

  const managed = isWavemillManagedBranch(branchName, opts.repoDir);
  const useAttribution = Boolean(opts.attributeByWindows) || managed || agentCommitsAsUser(opts.agentType);

  let windows: AgentActivityWindow[] = [];
  let intervals: OperatorHandoffInterval[] = [];
  let hasAttributionData = false;
  let ownership: { rows: SessionOwnershipRow[]; windows: OwnedSessionWindow[]; hasRows: boolean } | undefined;
  if (useAttribution) {
    const dirs = resolveTaskArtifactDirs({ ...opts, branchName, baseBranch });
    windows = deriveAgentActivityWindows(dirs);
    intervals = readOperatorHandoffIntervals(dirs);
    hasAttributionData = windows.length > 0 || intervals.length > 0;
    const ownershipRead = locateOwnershipRows({ repoDir: opts.repoDir, issueId: opts.issueId, slug: branchSlug(branchName), worktreePath: opts.worktreePath });
    const exactRows = ownershipRead.rows.filter((row) => !row.kind.startsWith('helper:'));
    ownership = {
      rows: exactRows,
      windows: ownedSessionWindows(exactRows, (row) => findTranscriptEndMs(row, opts.worktreePath ?? cwd, opts.repoDir, opts.issueId)),
      hasRows: exactRows.length > 0,
    };
  }

  try {
    const commits = opts.prNumber
      ? parsePrCommits(opts.prCommits ?? fetchPrCommits(opts.prNumber, opts.repoDir))
      : parseGitLogCommits(branchName, baseBranch, cwd);

    for (const c of commits) {
      if (isAgentCommit(c.subject, c.author, c.body)) continue;

      if (!useAttribution) {
        manualEdit.details.push(`${c.sha.slice(0, 7)}: ${c.subject} (by ${c.author})`);
        manualEdit.timestamps!.push(c.date);
        manualEdit.severities!.push('med');
        continue;
      }

      const commitMs = parseTimestampMs(c.date) ?? Date.now();
      const attribution = classifyCommitAttribution(commitMs, windows, intervals, hasAttributionData, ownership);

      if (attribution === 'agent') continue;

      if (attribution === 'operator_handoff') {
        manualEdit.details.push(
          `${c.sha.slice(0, 7)}: ${c.subject} (by ${c.author}) — operator handoff commit completing uncommitted agent output`
        );
        manualEdit.timestamps!.push(c.date);
        manualEdit.severities!.push('high');
      } else if (attribution === 'operator_out_of_window') {
        manualEdit.details.push(
          `${c.sha.slice(0, 7)}: ${c.subject} (by ${c.author}) — commit outside all recorded agent activity windows`
        );
        manualEdit.timestamps!.push(c.date);
        manualEdit.severities!.push('med');
      } else {
        unknownAttribution.details.push(
          `${c.sha.slice(0, 7)}: ${c.subject} (by ${c.author}) — no stage-result attribution data available`
        );
        unknownAttribution.timestamps!.push(c.date);
        unknownAttribution.severities!.push('low');
      }
    }

    manualEdit.count = manualEdit.details.length;
    unknownAttribution.count = unknownAttribution.details.length;
  } catch (err: unknown) {
    const message = errorMessage(err);
    console.warn(`[intervention-detector] Failed to detect manual edits: ${message}`);
  }

  return { manualEdit, unknownAttribution };
}

// ────────────────────────────────────────────────────────────────
// Aggregation
// ────────────────────────────────────────────────────────────────

export interface DetectOptions {
  prNumber?: string;
  branchName?: string;
  baseBranch?: string;
  repoDir?: string;
  worktreePath?: string;
  agentType?: string;
  issueId?: string;
  /** Pre-fetched PR commits, to avoid a duplicate API call (used by detectManualEdits). */
  prCommits?: PrCommit[];
  /**
   * Always attribute commits by recorded agent windows (HOK-3182). A reaped
   * task's branch no longer looks wavemill-managed, so the reliability report
   * opts in rather than fall back to marker-only detection, which flags every
   * commit of an agent that commits as the user.
   */
  attributeByWindows?: boolean;
}

/**
 * Run all intervention detectors and produce a summary with weighted score.
 *
 * @param opts - Detection options
 * @param penalties - Optional pre-loaded penalties (avoids redundant config loading)
 */
export function detectAllInterventions(
  opts: DetectOptions,
  penalties?: InterventionPenalties
): InterventionSummary {
  const penaltyWeights = penalties || loadPenalties(opts.repoDir);
  const interventions: InterventionEvent[] = [];

  // Resolve GitHub owner/repo once for all API calls
  const nwo = opts.prNumber ? resolveOwnerRepo(opts.repoDir) : undefined;

  // Fetch PR commits once (shared by multiple detectors)
  const prCommits = opts.prNumber ? fetchPrCommits(opts.prNumber, opts.repoDir, nwo) : [];

  // GitHub-based detection (requires PR number)
  let postPrEvent: InterventionEvent = { type: 'post_pr_commit', count: 0, details: [] };
  if (opts.prNumber) {
    interventions.push(detectReviewComments(opts.prNumber, opts.repoDir, nwo));
    postPrEvent = detectPostPrCommits(opts.prNumber, opts.repoDir, prCommits, nwo);
  }

  // Commit-based detection (requires branch info or PR number)
  const branch = opts.branchName || '';
  const base = opts.baseBranch || 'main';
  let manualEditEvent: InterventionEvent = { type: 'manual_edit', count: 0, details: [] };

  // Manual edit detection now runs for every agent type, including ones that
  // commit under the user's git identity with no agent markers (Codex, and
  // every native/provider-backed harness). isAgentCommit alone can only
  // recognise Claude- and Codex-tagged commits, so those agents used to be
  // skipped entirely here (HOK-2894: that skip, stacked with the managed-
  // branch short-circuit inside detectManualEdits, meant no operator commit
  // on any mill branch could ever be detected). detectManualEdits now
  // classifies each commit against recorded agent activity windows instead.
  if (branch || opts.prNumber) {
    const manualEditsResult = detectManualEdits({ ...opts, branchName: branch, baseBranch: base, prCommits });
    manualEditEvent = manualEditsResult.manualEdit;
    if (manualEditsResult.unknownAttribution.count > 0) {
      interventions.push(manualEditsResult.unknownAttribution);
    }
  }

  if (branch || opts.prNumber) {
    interventions.push(detectTestFixes(branch, base, opts.repoDir, opts.prNumber, prCommits));
  }

  // Deduplicate: if a commit SHA appears in both post_pr_commit and manual_edit,
  // keep it only in manual_edit (higher penalty) to avoid double-counting.
  deduplicatePostPrAndManualEdits(postPrEvent, manualEditEvent);

  interventions.push(postPrEvent);
  interventions.push(manualEditEvent);

  // Session transcript detection (requires worktree path + branch).
  // Applies to Claude and claude-deepseek — Codex autonomous mode has no user messages.
  const isClaudeLike = !opts.agentType || opts.agentType === 'claude' || opts.agentType === 'claude-deepseek';
  if (opts.worktreePath && branch && isClaudeLike) {
    interventions.push(detectSessionRedirects(opts.worktreePath, branch, opts.issueId, opts.repoDir));
  }

  const artifactDirs = resolveTaskArtifactDirs(opts);
  const operatorEvent = detectOperatorInterventions(artifactDirs);
  if (operatorEvent.count > 0) interventions.push(operatorEvent);
  const priorFailedEvent = detectPriorFailedAttempts(artifactDirs);
  if (priorFailedEvent.count > 0) interventions.push(priorFailedEvent);

  // Self-review findings detection (requires issueId or branchName + repoDir)
  if ((opts.issueId || branch) && opts.repoDir) {
    try {
      const reviewData = loadReviewInterventions({
        issueId: opts.issueId,
        branchName: branch,
        repoDir: opts.repoDir,
      });

      // Add blocker findings as separate intervention event
      if (reviewData.blockerCount > 0) {
        interventions.push({
          type: 'self_review_blocker',
          count: reviewData.blockerCount,
          details: reviewData.blockers.map((r) => r.note),
          timestamps: reviewData.blockers.map((r) => r.timestamp),
        });
      }

      // Add warning findings as separate intervention event
      if (reviewData.warningCount > 0) {
        interventions.push({
          type: 'self_review_warning',
          count: reviewData.warningCount,
          details: reviewData.warnings.map((r) => r.note),
          timestamps: reviewData.warnings.map((r) => r.timestamp),
        });
      }
    } catch (err) {
      // Non-throwing - continue without review interventions
      const message = errorMessage(err);
      console.warn(`[intervention-detector] Failed to load review interventions: ${message}`);
    }
  }

  // Calculate weighted score
  let totalScore = 0;
  for (const event of interventions) {
    const weight = penaltyWeights[event.type] || 0;
    totalScore += event.count * weight;
  }

  return {
    interventions,
    totalInterventionScore: Math.round(totalScore * 100) / 100,
  };
}

/**
 * Convert an InterventionSummary to the InterventionMeta[] format
 * expected by evaluateTask() in eval.js (legacy format).
 */
export function toInterventionMeta(summary: InterventionSummary): InterventionMeta[] {
  const meta: InterventionMeta[] = [];

  for (const event of summary.interventions) {
    if (event.count === 0) continue;

    const severity = legacySeverityFor(event.type);

    for (const detail of event.details) {
      meta.push({ description: `[${event.type}] ${detail}`, severity });
    }
  }

  return meta;
}

/**
 * Map detection event type to semantic intervention type.
 */
function mapToInterventionType(detectionType: string, detail: string): InterventionType {
  switch (detectionType) {
    case 'review_comment':
      // If review requested changes, likely a bugfix; otherwise clarification
      return detail.includes('CHANGES_REQUESTED') ? 'bugfix' : 'clarification';
    case 'post_pr_commit':
      return 'bugfix';
    case 'manual_edit':
      // Could be manual_merge or bugfix depending on context
      // Default to manual_merge, but check if it looks like a fix
      if (/fix|repair|correct/i.test(detail)) {
        return 'bugfix';
      }
      return 'manual_merge';
    case 'test_fix':
      return 'bugfix';
    case 'session_redirect':
      // Could be scope_change or clarification
      // Default to scope_change for user redirections
      return 'scope_change';
    case 'operator_recovery':
      return 'recovery';
    case 'prior_failed_attempt':
      return 'rollback';
    case 'unknown_attribution':
      return 'unknown_attribution';
    default:
      return 'clarification';
  }
}

function legacySeverityFor(detectionType: InterventionEvent['type']): 'minor' | 'major' {
  return detectionType === 'manual_edit'
    || detectionType === 'post_pr_commit'
    || detectionType === 'session_redirect'
    || detectionType === 'operator_recovery'
    || detectionType === 'prior_failed_attempt'
    ? 'major'
    : 'minor';
}

/**
 * Map legacy severity to new severity enum.
 */
function mapToSeverity(legacySeverity: 'minor' | 'major'): InterventionSeverity {
  return legacySeverity === 'minor' ? 'low' : 'med';
}

/**
 * Convert an InterventionSummary to structured InterventionRecord[] format.
 *
 * This is the new structured format that enables ML routing to learn from
 * intervention patterns.
 */
export function toInterventionRecords(summary: InterventionSummary): InterventionRecord[] {
  const records: InterventionRecord[] = [];

  for (const event of summary.interventions) {
    if (event.count === 0) continue;

    const severity = event.severities?.[0] ?? mapToSeverity(legacySeverityFor(event.type));

    for (let i = 0; i < event.details.length; i++) {
      const detail = event.details[i];
      const timestamp = event.timestamps?.[i] || new Date().toISOString();
      const type = mapToInterventionType(event.type, detail);

      records.push({
        timestamp,
        type,
        severity: event.severities?.[i] ?? severity,
        note: `[${event.type}] ${detail}`,
      });
    }
  }

  return records;
}

/**
 * Format intervention summary as structured JSON text for the judge prompt.
 * This provides richer data than the flat InterventionMeta list.
 */
export function formatForJudge(summary: InterventionSummary, penalties: InterventionPenalties): string {
  const data = {
    interventions: summary.interventions.map((e) => ({
      type: e.type,
      count: e.count,
      penaltyPerOccurrence: penalties[e.type],
      details: e.details,
    })),
    totalInterventionScore: summary.totalInterventionScore,
    penaltyWeights: penalties,
  };

  return JSON.stringify(data, null, 2);
}

// ────────────────────────────────────────────────────────────────
// High-Level Orchestrator
// ────────────────────────────────────────────────────────────────

/**
 * All intervention data needed for eval in a single structure.
 */
export interface InterventionData {
  /** Raw intervention summary with all events */
  summary: InterventionSummary;
  /** Legacy format for evaluateTask() */
  meta: InterventionMeta[];
  /** Structured records for eval persistence */
  records: InterventionRecord[];
  /** Formatted text for judge prompt */
  text: string;
  /** Total count of interventions */
  totalCount: number;
}

/**
 * Detect and format all interventions in a single call.
 *
 * This orchestrator consolidates:
 * - detectAllInterventions()
 * - toInterventionMeta()
 * - toInterventionRecords()
 * - formatForJudge()
 * - loadPenalties()
 *
 * Returns all intervention data needed for eval persistence and judging.
 *
 * @param opts - Detection options (PR number, branch, worktree path, etc.)
 * @returns Complete intervention data
 */
export function detectAndFormatInterventions(opts: DetectOptions): InterventionData {
  // Load penalties once
  const penalties = loadPenalties(opts.repoDir);

  // Detect all interventions (pass penalties to avoid redundant loading)
  const summary = detectAllInterventions(opts, penalties);

  // Convert to all needed formats
  const meta = toInterventionMeta(summary);
  const records = toInterventionRecords(summary);
  const text = formatForJudge(summary, penalties);

  // Calculate total count
  const totalCount = summary.interventions.reduce((sum, e) => sum + e.count, 0);

  return {
    summary,
    meta,
    records,
    text,
    totalCount,
  };
}
