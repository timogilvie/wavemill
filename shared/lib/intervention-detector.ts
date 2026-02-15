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
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

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
  type: 'review_comment' | 'post_pr_commit' | 'manual_edit' | 'test_fix';
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
 * Detect commits made after the initial PR creation.
 * These indicate post-review fixes or manual edits pushed after the PR was opened.
 */
export function detectPostPrCommits(prNumber: string, repoDir?: string): InterventionEvent {
  const cwd = repoDir || process.cwd();
  const event: InterventionEvent = { type: 'post_pr_commit', count: 0, details: [] };

  try {
    // Get PR creation timestamp and head branch commits
    const prDataRaw = execSync(
      `gh api repos/{owner}/{repo}/pulls/${prNumber} --jq '{createdAt: .created_at, head: .head.sha, commits: .commits}'`,
      { encoding: 'utf-8', cwd, shell: '/bin/bash', timeout: 15_000 }
    ).trim();

    if (!prDataRaw) return event;

    const prData = JSON.parse(prDataRaw);
    const prCreatedAt = new Date(prData.createdAt);

    // Fetch all commits on the PR
    const commitsRaw = execSync(
      `gh api repos/{owner}/{repo}/pulls/${prNumber}/commits --jq '[.[] | {sha: .sha, message: .commit.message, author: .commit.author.name, date: .commit.author.date}]'`,
      { encoding: 'utf-8', cwd, shell: '/bin/bash', timeout: 15_000 }
    ).trim();

    if (commitsRaw) {
      const commits: PrCommit[] = JSON.parse(commitsRaw);

      // The first commit(s) are part of the initial PR; commits after creation are post-PR fixes.
      // We consider any commit with a date after the PR creation as a post-PR commit.
      // Skip the very first commit (it's the initial implementation).
      const postPrCommits = commits.filter((c) => {
        const commitDate = new Date(c.date);
        return commitDate > prCreatedAt;
      });

      for (const c of postPrCommits) {
        event.details.push(`${c.sha.slice(0, 7)}: ${c.message.split('\n')[0].slice(0, 200)}`);
      }
      event.count = postPrCommits.length;
    }
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
 * Detect manual file edits from session metadata.
 * Looks for commits in the branch not attributed to the agent (Co-Authored-By patterns).
 */
export function detectManualEdits(branchName: string, baseBranch: string, repoDir?: string): InterventionEvent {
  const cwd = repoDir || process.cwd();
  const event: InterventionEvent = { type: 'manual_edit', count: 0, details: [] };

  try {
    // Get all commits on this branch that don't have the agent co-author tag
    const commitsRaw = execSync(
      `git log ${baseBranch}..${branchName} --format='%H|%s|%an|%b' 2>/dev/null || echo ''`,
      { encoding: 'utf-8', cwd, shell: '/bin/bash', timeout: 10_000 }
    ).trim();

    if (!commitsRaw) return event;

    const lines = commitsRaw.split('\n').filter(Boolean);
    for (const line of lines) {
      const [sha, subject, author, ...bodyParts] = line.split('|');
      const body = bodyParts.join('|');

      // Heuristic: commits without "Co-Authored-By: Claude" are likely manual edits
      const isAgentCommit =
        body.includes('Co-Authored-By: Claude') ||
        body.includes('Co-authored-by: Claude') ||
        subject.includes('[agent]') ||
        author.toLowerCase().includes('claude');

      if (!isAgentCommit && sha) {
        event.details.push(`${sha.slice(0, 7)}: ${subject} (by ${author})`);
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
 * Detect interactive test fixes from session metadata.
 * Looks for patterns like "fix test", "fix failing", re-run indicators in commit messages.
 */
export function detectTestFixes(branchName: string, baseBranch: string, repoDir?: string): InterventionEvent {
  const cwd = repoDir || process.cwd();
  const event: InterventionEvent = { type: 'test_fix', count: 0, details: [] };

  try {
    const commitsRaw = execSync(
      `git log ${baseBranch}..${branchName} --format='%H|%s' 2>/dev/null || echo ''`,
      { encoding: 'utf-8', cwd, shell: '/bin/bash', timeout: 10_000 }
    ).trim();

    if (!commitsRaw) return event;

    const testFixPatterns = [
      /fix.*test/i,
      /test.*fix/i,
      /fix.*spec/i,
      /fix.*failing/i,
      /failing.*test/i,
      /repair.*test/i,
      /correct.*test/i,
    ];

    const lines = commitsRaw.split('\n').filter(Boolean);
    for (const line of lines) {
      const [sha, ...subjectParts] = line.split('|');
      const subject = subjectParts.join('|');

      if (testFixPatterns.some((p) => p.test(subject))) {
        event.details.push(`${sha.slice(0, 7)}: ${subject}`);
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
// Aggregation
// ────────────────────────────────────────────────────────────────

export interface DetectOptions {
  prNumber?: string;
  branchName?: string;
  baseBranch?: string;
  repoDir?: string;
}

/**
 * Run all intervention detectors and produce a summary with weighted score.
 */
export function detectAllInterventions(opts: DetectOptions): InterventionSummary {
  const penalties = loadPenalties(opts.repoDir);
  const interventions: InterventionEvent[] = [];

  // GitHub-based detection (requires PR number)
  if (opts.prNumber) {
    interventions.push(detectReviewComments(opts.prNumber, opts.repoDir));
    interventions.push(detectPostPrCommits(opts.prNumber, opts.repoDir));
  }

  // Session/git-based detection (requires branch info)
  const branch = opts.branchName || '';
  const base = opts.baseBranch || 'main';
  if (branch) {
    interventions.push(detectManualEdits(branch, base, opts.repoDir));
    interventions.push(detectTestFixes(branch, base, opts.repoDir));
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
      event.type === 'manual_edit' || event.type === 'post_pr_commit' ? 'major' : 'minor';

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
