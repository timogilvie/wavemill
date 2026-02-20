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

import { execSync } from 'child_process';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { resolveProjectsDir } from './workflow-cost.ts';

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
// Config
// ────────────────────────────────────────────────────────────────

/**
 * Read intervention penalty weights from .wavemill-config.json.
 * Falls back to DEFAULT_PENALTIES for any missing keys.
 */
export function loadPenalties(repoDir?: string): InterventionPenalties {
  const configPath = join(repoDir || process.cwd(), '.wavemill-config.json');
  if (!existsSync(configPath)) return { ...DEFAULT_PENALTIES };
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const configured = config.eval?.interventionPenalties || {};
    return {
      review_comment: configured.reviewComment ?? DEFAULT_PENALTIES.review_comment,
      post_pr_commit: configured.postPrCommit ?? DEFAULT_PENALTIES.post_pr_commit,
      manual_edit: configured.manualEdit ?? DEFAULT_PENALTIES.manual_edit,
      test_fix: configured.testFix ?? DEFAULT_PENALTIES.test_fix,
      session_redirect: configured.sessionRedirect ?? DEFAULT_PENALTIES.session_redirect,
    };
  } catch {
    return { ...DEFAULT_PENALTIES };
  }
}

// ────────────────────────────────────────────────────────────────
// GitHub Detection
// ────────────────────────────────────────────────────────────────

/**
 * Fetch PR review comments that request changes (not approvals/comments-only).
 * Uses `gh api` to get review data.
 */
export function detectReviewComments(prNumber: string, repoDir?: string): InterventionEvent {
  const cwd = repoDir || process.cwd();
  const event: InterventionEvent = { type: 'review_comment', count: 0, details: [] };

  try {
    // Fetch reviews (top-level review submissions with state)
    const reviewsRaw = execSync(
      `gh api repos/{owner}/{repo}/pulls/${prNumber}/reviews --jq '[.[] | {author: .user.login, state: .state, body: .body, submittedAt: .submitted_at}]'`,
      { encoding: 'utf-8', cwd, shell: '/bin/bash', timeout: 15_000 }
    ).trim();

    if (reviewsRaw) {
      const reviews: ReviewComment[] = JSON.parse(reviewsRaw);
      const changeRequests = reviews.filter(
        (r) => r.state === 'CHANGES_REQUESTED' || r.state === 'COMMENTED'
      );
      for (const r of changeRequests) {
        if (r.body && r.body.trim()) {
          event.details.push(`[${r.state}] ${r.author}: ${r.body.slice(0, 200)}`);
        }
      }
    }

    // Fetch inline review comments (code-level feedback)
    const commentsRaw = execSync(
      `gh api repos/{owner}/{repo}/pulls/${prNumber}/comments --jq '[.[] | {author: .user.login, body: .body, path: .path, line: .line}]'`,
      { encoding: 'utf-8', cwd, shell: '/bin/bash', timeout: 15_000 }
    ).trim();

    if (commentsRaw) {
      const comments = JSON.parse(commentsRaw);
      for (const c of comments) {
        const location = c.path ? ` (${c.path}:${c.line || '?'})` : '';
        event.details.push(`[INLINE] ${c.author}${location}: ${c.body.slice(0, 200)}`);
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
export function fetchPrCommits(prNumber: string, repoDir?: string): PrCommit[] {
  const cwd = repoDir || process.cwd();
  try {
    const commitsRaw = execSync(
      `gh api repos/{owner}/{repo}/pulls/${prNumber}/commits --jq '[.[] | {sha: .sha, message: .commit.message, author: .commit.author.name, date: .commit.author.date}]'`,
      { encoding: 'utf-8', cwd, shell: '/bin/bash', timeout: 15_000 }
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
export function detectPostPrCommits(prNumber: string, repoDir?: string, prCommits?: PrCommit[]): InterventionEvent {
  const cwd = repoDir || process.cwd();
  const event: InterventionEvent = { type: 'post_pr_commit', count: 0, details: [] };

  try {
    // Get PR creation timestamp
    const prDataRaw = execSync(
      `gh api repos/{owner}/{repo}/pulls/${prNumber} --jq '{createdAt: .created_at, head: .head.sha, commits: .commits}'`,
      { encoding: 'utf-8', cwd, shell: '/bin/bash', timeout: 15_000 }
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
  const event: InterventionEvent = { type: 'manual_edit', count: 0, details: [] };

  try {
    if (prNumber) {
      // Preferred path: use GitHub API PR commits (exact set, no leakage)
      const commits = prCommits ?? fetchPrCommits(prNumber, repoDir);
      for (const c of commits) {
        const subject = c.message.split('\n')[0];
        const body = c.message.includes('\n') ? c.message.slice(c.message.indexOf('\n') + 1) : '';
        if (!isAgentCommit(subject, c.author, body)) {
          event.details.push(`${c.sha.slice(0, 7)}: ${subject} (by ${c.author})`);
        }
      }
    } else {
      // Fallback: git log (less reliable post-merge, but works without a PR)
      const commitsRaw = execSync(
        `git log ${baseBranch}..${branchName} --format='%H|%s|%an|%b%x00' 2>/dev/null || echo ''`,
        { encoding: 'utf-8', cwd, shell: '/bin/bash', timeout: 10_000 }
      ).trim();

      if (!commitsRaw) return event;

      const records = commitsRaw.split('\0').filter((r) => r.trim());
      for (const record of records) {
        const trimmed = record.trim();
        const [sha, subject, author, ...bodyParts] = trimmed.split('|');
        const body = bodyParts.join('|');

        if (!isAgentCommit(subject, author, body) && sha) {
          event.details.push(`${sha.slice(0, 7)}: ${subject} (by ${author})`);
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
  const event: InterventionEvent = { type: 'test_fix', count: 0, details: [] };

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
        }
      }
    } else {
      const commitsRaw = execSync(
        `git log ${baseBranch}..${branchName} --format='%H|%s' 2>/dev/null || echo ''`,
        { encoding: 'utf-8', cwd, shell: '/bin/bash', timeout: 10_000 }
      ).trim();

      if (!commitsRaw) return event;

      const lines = commitsRaw.split('\n').filter(Boolean);
      for (const line of lines) {
        const trimmed = line.trim();
        const [sha, ...subjectParts] = trimmed.split('|');
        const subject = subjectParts.join('|');

        if (testFixPatterns.some((p) => p.test(subject))) {
          event.details.push(`${sha.slice(0, 7)}: ${subject}`);
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
  const event: InterventionEvent = { type: 'session_redirect', count: 0, details: [] };

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

    const userMessages: string[] = [];

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

          userMessages.push(message.content as string);
        }
      } catch {
        continue;
      }
    }

    // Skip the first string-content user message (automated task prompt from wavemill)
    const redirections = userMessages.slice(1);

    for (const text of redirections) {
      event.details.push(text.slice(0, 200));
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

  // Fetch PR commits once (shared by multiple detectors)
  const prCommits = opts.prNumber ? fetchPrCommits(opts.prNumber, opts.repoDir) : [];

  // GitHub-based detection (requires PR number)
  let postPrEvent: InterventionEvent = { type: 'post_pr_commit', count: 0, details: [] };
  if (opts.prNumber) {
    interventions.push(detectReviewComments(opts.prNumber, opts.repoDir));
    postPrEvent = detectPostPrCommits(opts.prNumber, opts.repoDir, prCommits);
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
 * expected by evaluateTask() in eval.js.
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
