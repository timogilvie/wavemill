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

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveProjectsDir } from './workflow-cost.ts';
import { loadWavemillConfig } from './config.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
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
  type: 'review_comment' | 'post_pr_commit' | 'manual_edit' | 'test_fix' | 'session_redirect';
  count: number;
  details: string[];
  timestamps?: string[]; // ISO 8601 timestamps parallel to details array
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
  post_pr_commit: 0.08,
  manual_edit: 0.10,
  test_fix: 0.06,
  session_redirect: 0.12,
};

// ────────────────────────────────────────────────────────────────
// GitHub repo resolution
// ────────────────────────────────────────────────────────────────

/**
 * Resolve the GitHub owner/repo string (e.g. "timogilvie/wavemill") from
 * the git remote in the given directory.
 *
 * `gh api` supports `{owner}/{repo}` template placeholders, but they only
 * resolve when gh can detect the current repo from git remotes. When the
 * cwd is missing or the remote isn't a GitHub URL, the API call returns a
 * 404. Resolving once up front makes errors obvious and avoids repeated
 * template-expansion failures.
 *
 * Returns undefined on error so callers can degrade gracefully.
 */
export function resolveOwnerRepo(repoDir?: string): string | undefined {
  const cwd = repoDir || process.cwd();
  try {
    const nwo = execShellCommand(
      `gh repo view --json nameWithOwner --jq .nameWithOwner`,
      { encoding: 'utf-8', cwd, timeout: 10_000 }
    ).trim();
    return nwo || undefined;
  } catch {
    // Fallback: parse git remote directly (works offline / without gh auth)
    try {
      const remoteUrl = execShellCommand('git remote get-url origin', {
        encoding: 'utf-8', cwd, timeout: 5_000,
      }).trim();
      const match =
        remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/) ;
      return match?.[1];
    } catch {
      return undefined;
    }
  }
}

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
    // Fetch reviews (top-level review submissions with state)
    const reviewsRaw = execShellCommand(
      `gh api repos/${escapeShellArg(repo)}/pulls/${escapeShellArg(prNumber)}/reviews --jq '[.[] | {author: .user.login, state: .state, body: .body, submittedAt: .submitted_at}]'`,
      { encoding: 'utf-8', cwd, timeout: 15_000 }
    ).trim();

    if (reviewsRaw) {
      const reviews: ReviewComment[] = JSON.parse(reviewsRaw);
      const changeRequests = reviews.filter(
        (r) => r.state === 'CHANGES_REQUESTED' || r.state === 'COMMENTED'
      );
      for (const r of changeRequests) {
        if (r.body && r.body.trim()) {
          event.details.push(`[${r.state}] ${r.author}: ${r.body.slice(0, 200)}`);
          event.timestamps!.push(r.submittedAt);
        }
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
    const message = err instanceof Error ? err.message : String(err);
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
    const message = err instanceof Error ? err.message : String(err);
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

    // The first commit(s) are part of the initial PR; commits after creation are post-PR fixes.
    // We consider any commit with a date after the PR creation as a post-PR commit.
    const postPrCommits = commits.filter((c) => {
      const commitDate = new Date(c.date);
      return commitDate > prCreatedAt;
    });

    for (const c of postPrCommits) {
      event.details.push(`${c.sha.slice(0, 7)}: ${c.message.split('\n')[0].slice(0, 200)}`);
      event.timestamps!.push(c.date);
    }
    event.count = postPrCommits.length;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[intervention-detector] Failed to fetch PR commits: ${message}`);
  }

  return event;
}

// ────────────────────────────────────────────────────────────────
// Session Metadata Detection
// ────────────────────────────────────────────────────────────────

/**
 * Check whether a commit looks like it was made by an AI agent
 * based on co-author tags, author name, or subject markers.
 */
function isAgentCommit(subject: string, author: string, body: string): boolean {
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
 * Detect manual file edits — commits not attributed to the agent.
 *
 * When a prNumber is provided, uses GitHub API to get the exact set of PR
 * commits (avoids false positives from `git log main..branch` which can
 * include commits from other merged PRs post-squash-merge).
 *
 * Falls back to `git log` when no PR number is available.
 */
export function detectManualEdits(
  branchName: string,
  baseBranch: string,
  repoDir?: string,
  prNumber?: string,
  prCommits?: PrCommit[],
): InterventionEvent {
  const cwd = repoDir || process.cwd();
  const event: InterventionEvent = { type: 'manual_edit', count: 0, details: [], timestamps: [] };

  try {
    if (prNumber) {
      // Preferred path: use GitHub API PR commits (exact set, no leakage)
      const commits = prCommits ?? fetchPrCommits(prNumber, repoDir);
      for (const c of commits) {
        const subject = c.message.split('\n')[0];
        const body = c.message.includes('\n') ? c.message.slice(c.message.indexOf('\n') + 1) : '';
        if (!isAgentCommit(subject, c.author, body)) {
          event.details.push(`${c.sha.slice(0, 7)}: ${subject} (by ${c.author})`);
          event.timestamps!.push(c.date);
        }
      }
    } else {
      // Fallback: git log (less reliable post-merge, but works without a PR)
      const commitsRaw = execShellCommand(
        `git log ${escapeShellArg(baseBranch)}..${escapeShellArg(branchName)} --format='%H|%s|%an|%ad|%b%x00' --date=iso-strict 2>/dev/null || echo ''`,
        { encoding: 'utf-8', cwd, timeout: 10_000 }
      ).trim();

      if (!commitsRaw) return event;

      const records = commitsRaw.split('\0').filter((r) => r.trim());
      for (const record of records) {
        const trimmed = record.trim();
        const [sha, subject, author, date, ...bodyParts] = trimmed.split('|');
        const body = bodyParts.join('|');

        if (!isAgentCommit(subject, author, body) && sha) {
          event.details.push(`${sha.slice(0, 7)}: ${subject} (by ${author})`);
          event.timestamps!.push(date || new Date().toISOString());
        }
      }
    }
    event.count = event.details.length;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[intervention-detector] Failed to detect manual edits: ${message}`);
  }

  return event;
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
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[intervention-detector] Failed to detect test fixes: ${message}`);
  }

  return event;
}

// ────────────────────────────────────────────────────────────────
// Session-based Detection
// ────────────────────────────────────────────────────────────────

/**
 * Detect user redirections from Claude session JSONL data.
 *
 * Reads session files from `~/.claude/projects/<encoded-worktree>/`.
 * Real user messages have `message.content` as a string (not an array of
 * tool_result blocks). The first string-content user message is the automated
 * task prompt injected by wavemill — all subsequent ones are user redirections.
 */
export function detectSessionRedirects(worktreePath: string, branchName: string): InterventionEvent {
  const event: InterventionEvent = { type: 'session_redirect', count: 0, details: [], timestamps: [] };

  try {
    const projectsDir = resolveProjectsDir(worktreePath);
    if (!existsSync(projectsDir)) return event;

    let sessionFiles: string[];
    try {
      sessionFiles = readdirSync(projectsDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => join(projectsDir, f));
    } catch {
      return event;
    }

    interface UserMessage {
      content: string;
      timestamp: string;
    }
    const userMessages: UserMessage[] = [];

    for (const filePath of sessionFiles) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        for (const line of lines) {
          if (!line.trim()) continue;

          let entry: Record<string, unknown>;
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }

          if (entry.type !== 'user') continue;
          if (entry.gitBranch !== branchName) continue;

          const message = entry.message as Record<string, unknown> | undefined;
          if (!message) continue;

          // Real user text has content as a string.
          // Tool results / approvals have content as an array.
          if (typeof message.content !== 'string') continue;

          const timestamp = typeof entry.timestamp === 'string'
            ? entry.timestamp
            : new Date().toISOString();
          userMessages.push({
            content: message.content as string,
            timestamp,
          });
        }
      } catch {
        continue;
      }
    }

    // Skip the first string-content user message (automated task prompt from wavemill)
    const redirections = userMessages.slice(1);

    for (const msg of redirections) {
      event.details.push(msg.content.slice(0, 200));
      event.timestamps!.push(msg.timestamp);
    }
    event.count = redirections.length;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[intervention-detector] Failed to detect session redirects: ${message}`);
  }

  return event;
}

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
// Aggregation
// ────────────────────────────────────────────────────────────────

export interface DetectOptions {
  prNumber?: string;
  branchName?: string;
  baseBranch?: string;
  repoDir?: string;
  worktreePath?: string;
  agentType?: string;
}

/**
 * Run all intervention detectors and produce a summary with weighted score.
 */
export function detectAllInterventions(opts: DetectOptions): InterventionSummary {
  const penalties = loadPenalties(opts.repoDir);
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

  // Manual edit detection: skip for Codex — it runs autonomously and commits
  // under the user's git identity with no agent markers. Human interventions
  // on Codex tasks are caught by detectPostPrCommits and detectReviewComments.
  if ((branch || opts.prNumber) && opts.agentType !== 'codex') {
    manualEditEvent = detectManualEdits(branch, base, opts.repoDir, opts.prNumber, prCommits);
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
  // Only applies to Claude — Codex autonomous mode has no user messages.
  if (opts.worktreePath && branch && (!opts.agentType || opts.agentType === 'claude')) {
    interventions.push(detectSessionRedirects(opts.worktreePath, branch));
  }

  // Calculate weighted score
  let totalScore = 0;
  for (const event of interventions) {
    const weight = penalties[event.type] || 0;
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

    const severity: 'minor' | 'major' =
      event.type === 'manual_edit' || event.type === 'post_pr_commit' || event.type === 'session_redirect'
        ? 'major' : 'minor';

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
    default:
      return 'clarification';
  }
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

    const legacySeverity: 'minor' | 'major' =
      event.type === 'manual_edit' || event.type === 'post_pr_commit' || event.type === 'session_redirect'
        ? 'major' : 'minor';

    const severity = mapToSeverity(legacySeverity);

    for (let i = 0; i < event.details.length; i++) {
      const detail = event.details[i];
      const timestamp = event.timestamps?.[i] || new Date().toISOString();
      const type = mapToInterventionType(event.type, detail);

      records.push({
        timestamp,
        type,
        severity,
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
  // Load penalties
  const penalties = loadPenalties(opts.repoDir);

  // Detect all interventions
  const summary = detectAllInterventions(opts);

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
