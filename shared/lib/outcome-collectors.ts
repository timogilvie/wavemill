/**
 * Outcome collectors for decomposed eval metrics.
 *
 * Each collector gathers data for a specific outcome dimension (CI, tests,
 * static analysis, review, rework, delivery) from available sources:
 * - GitHub API (via gh CLI)
 * - Git history
 * - Session files
 * - Intervention detector output
 *
 * All collectors are non-throwing and return partial data on errors.
 *
 * @module outcome-collectors
 */

import { execSync } from 'child_process';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import type {
  CiOutcome,
  TestsOutcome,
  StaticAnalysisOutcome,
  ReviewOutcome,
  ReworkOutcome,
  DeliveryOutcome,
} from './eval-schema.ts';
import type { InterventionSummary } from './intervention-detector.ts';
import { resolveOwnerRepo } from './intervention-detector.ts';
import { resolveProjectsDir } from './workflow-cost.ts';

// ────────────────────────────────────────────────────────────────
// PR Checks Cache
// ────────────────────────────────────────────────────────────────

/**
 * In-memory cache of PR checks, keyed by "${prNumber}:${repoDir}".
 * Lifetime: process-level singleton (cleared manually or on process exit).
 */
const prChecksCache = new Map<string, any[]>();

/**
 * Clear the PR checks cache for a specific PR or all PRs.
 *
 * @param prNumber - PR number (omit to clear all cached checks)
 * @param repoDir - Repository directory
 */
export function clearPrChecksCache(prNumber?: string, repoDir?: string): void {
  if (prNumber !== undefined && repoDir !== undefined) {
    const key = `${prNumber}:${repoDir}`;
    prChecksCache.delete(key);
  } else {
    prChecksCache.clear();
  }
}

/**
 * Fetch PR checks from GitHub, with in-process caching.
 *
 * Makes a single `gh pr checks` call per PR and caches the result.
 * Subsequent calls for the same PR return cached data.
 *
 * @param prNumber - GitHub PR number
 * @param repoDir - Repository directory (defaults to cwd)
 * @returns Array of check objects, or empty array on error
 */
function fetchPrChecks(prNumber: string, repoDir?: string): any[] {
  const cwd = repoDir || process.cwd();
  const cacheKey = `${prNumber}:${cwd}`;

  // Check cache first
  const cached = prChecksCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  try {
    // Fetch all fields needed by any collector
    const checksRaw = execShellCommand(
      `gh pr checks ${escapeShellArg(prNumber)} --json name,state,conclusion,startedAt,completedAt 2>/dev/null || echo '[]'`,
      { encoding: 'utf-8', cwd, timeout: 15_000 }
    ).trim();

    if (!checksRaw || checksRaw === '[]') {
      prChecksCache.set(cacheKey, []);
      return [];
    }

    const checks = JSON.parse(checksRaw);
    if (!Array.isArray(checks)) {
      prChecksCache.set(cacheKey, []);
      return [];
    }

    // Cache and return
    prChecksCache.set(cacheKey, checks);
    return checks;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[outcome-collectors] Failed to fetch PR checks: ${message}`);
    prChecksCache.set(cacheKey, []);
    return [];
  }
}

// ────────────────────────────────────────────────────────────────
// CI Outcome Collector
// ────────────────────────────────────────────────────────────────

/**
 * Collect CI/CD check results from GitHub PR.
 *
 * Uses `gh pr checks` to fetch check run data.
 *
 * @param prNumber - GitHub PR number
 * @param repoDir - Repository directory (defaults to cwd)
 * @returns CI outcome with check results
 */
export function collectCiOutcome(
  prNumber: string,
  repoDir?: string,
): CiOutcome {
  const cwd = repoDir || process.cwd();
  const outcome: CiOutcome = {
    ran: false,
    passed: true,
    checks: [],
  };

  try {
    // Fetch PR checks via shared cache
    const checks = fetchPrChecks(prNumber, cwd);

    if (checks.length === 0) {
      return outcome; // No checks ran
    }

    outcome.ran = true;

    for (const check of checks) {
      const name = check.name || 'unknown';
      let status: 'success' | 'failure' | 'pending' | 'skipped' | 'cancelled' = 'pending';

      // Map GitHub check conclusion to our status enum
      const conclusion = (check.conclusion || '').toLowerCase();
      const state = (check.state || '').toLowerCase();

      if (conclusion === 'success') {
        status = 'success';
      } else if (conclusion === 'failure') {
        status = 'failure';
        outcome.passed = false;
      } else if (conclusion === 'skipped' || conclusion === 'neutral') {
        status = 'skipped';
      } else if (conclusion === 'cancelled') {
        status = 'cancelled';
        outcome.passed = false;
      } else if (state === 'pending' || state === 'in_progress') {
        status = 'pending';
        outcome.passed = false; // Treat pending as not-passed
      }

      // Calculate duration if both timestamps are available
      let durationSeconds: number | undefined;
      if (check.startedAt && check.completedAt) {
        try {
          const start = new Date(check.startedAt).getTime();
          const end = new Date(check.completedAt).getTime();
          durationSeconds = Math.round((end - start) / 1000);
        } catch {
          // Ignore parse errors
        }
      }

      outcome.checks.push({
        name,
        status,
        ...(durationSeconds !== undefined && { durationSeconds }),
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[outcome-collectors] Failed to fetch CI checks: ${message}`);
  }

  return outcome;
}

// ────────────────────────────────────────────────────────────────
// Tests Outcome Collector
// ────────────────────────────────────────────────────────────────

/**
 * Collect test outcome: whether tests were added and pass rate if available.
 *
 * Detects test file additions via git diff. Attempts to extract pass rate
 * from CI check output if a "test" check exists.
 *
 * @param prNumber - GitHub PR number
 * @param branchName - Git branch name
 * @param baseBranch - Base branch (usually 'main')
 * @param repoDir - Repository directory (defaults to cwd)
 * @returns Tests outcome
 */
export function collectTestsOutcome(
  prNumber: string,
  branchName: string,
  baseBranch: string,
  repoDir?: string,
): TestsOutcome {
  const cwd = repoDir || process.cwd();
  const outcome: TestsOutcome = {
    added: false,
  };

  try {
    // Detect test file additions via git diff
    // Look for files matching common test patterns
    const diffRaw = execShellCommand(
      `git diff --name-status ${escapeShellArg(baseBranch)}...${escapeShellArg(branchName)} 2>/dev/null | grep -E '\\.(test|spec)\\.(js|ts|jsx|tsx)$' || echo ''`,
      { encoding: 'utf-8', cwd, timeout: 10_000 }
    ).trim();

    if (diffRaw) {
      // Check if any files were added (A) or modified (M)
      const lines = diffRaw.split('\n').filter(Boolean);
      outcome.added = lines.some((line) => line.startsWith('A') || line.startsWith('M'));
    }

    // Try to extract test pass rate from CI checks
    // Look for a check with "test" in the name
    const checks = fetchPrChecks(prNumber, cwd);
    const testCheck = checks.find((c: { name: string }) =>
      c.name.toLowerCase().includes('test')
    );

    if (testCheck) {
      // If we found a test check, infer pass rate from conclusion
      // This is a simple heuristic; actual pass rate would require parsing check output
      if (testCheck.conclusion === 'success') {
        outcome.passRate = 1.0;
      } else if (testCheck.conclusion === 'failure') {
        outcome.passRate = 0.0; // Could be partial, but we don't have granular data
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[outcome-collectors] Failed to collect test outcome: ${message}`);
  }

  return outcome;
}

// ────────────────────────────────────────────────────────────────
// Static Analysis Outcome Collector
// ────────────────────────────────────────────────────────────────

/**
 * Collect static analysis results from CI checks.
 *
 * Looks for lint, typecheck, and security scan checks. Since we don't have
 * access to detailed check output in most cases, this provides basic
 * pass/fail status rather than deltas.
 *
 * @param prNumber - GitHub PR number
 * @param branchName - Git branch name (unused currently, for future expansion)
 * @param baseBranch - Base branch (unused currently, for future expansion)
 * @param repoDir - Repository directory (defaults to cwd)
 * @returns Static analysis outcome
 */
export function collectStaticAnalysisOutcome(
  prNumber: string,
  branchName: string,
  baseBranch: string,
  repoDir?: string,
): StaticAnalysisOutcome {
  const cwd = repoDir || process.cwd();
  const outcome: StaticAnalysisOutcome = {};

  try {
    // Fetch PR checks via shared cache
    const checks = fetchPrChecks(prNumber, cwd);

    if (checks.length === 0) {
      return outcome;
    }

    // Look for typecheck-related checks
    const typecheckCheck = checks.find((c: { name: string }) =>
      /type|tsc|typecheck/i.test(c.name)
    );
    if (typecheckCheck) {
      outcome.typecheckPassed = typecheckCheck.conclusion === 'success';
    }

    // Look for lint-related checks
    const lintCheck = checks.find((c: { name: string }) =>
      /lint|eslint|prettier/i.test(c.name)
    );
    if (lintCheck) {
      // We can't determine actual delta without detailed output, but we can infer
      // 0 (no change/passed) vs positive (failures) from conclusion
      outcome.lintDelta = lintCheck.conclusion === 'success' ? 0 : 1;
    }

    // Look for security scan checks
    const securityCheck = checks.find((c: { name: string }) =>
      /security|codeql|snyk|dependabot/i.test(c.name)
    );
    if (securityCheck) {
      outcome.securityFindingsDelta = securityCheck.conclusion === 'success' ? 0 : 1;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[outcome-collectors] Failed to collect static analysis outcome: ${message}`);
  }

  return outcome;
}

// ────────────────────────────────────────────────────────────────
// Review Outcome Collector
// ────────────────────────────────────────────────────────────────

/**
 * Collect review outcome from PR review data and intervention summary.
 *
 * Combines intervention detector data with GitHub PR review API to get
 * complete review activity picture.
 *
 * @param prNumber - GitHub PR number
 * @param interventionSummary - Intervention summary from intervention-detector
 * @param repoDir - Repository directory (defaults to cwd)
 * @returns Review outcome
 */
export function collectReviewOutcome(
  prNumber: string,
  interventionSummary: InterventionSummary,
  repoDir?: string,
  nwo?: string,
): ReviewOutcome {
  const cwd = repoDir || process.cwd();
  const repo = nwo || resolveOwnerRepo(cwd);
  const outcome: ReviewOutcome = {
    humanReviewRequired: false,
    rounds: 0,
    approvals: 0,
    changeRequests: 0,
  };

  try {
    // Check intervention summary for review-related interventions
    const reviewCommentEvent = interventionSummary.interventions.find(
      (e) => e.type === 'review_comment'
    );
    outcome.humanReviewRequired = reviewCommentEvent ? reviewCommentEvent.count > 0 : false;

    if (!repo) {
      console.warn('[outcome-collectors] Cannot resolve GitHub repo — skipping review API calls');
      return outcome;
    }

    // Fetch PR reviews via GitHub API
    const reviewsRaw = execShellCommand(
      `gh api repos/${escapeShellArg(repo)}/pulls/${escapeShellArg(prNumber)}/reviews --jq '[.[] | {state: .state, submittedAt: .submitted_at}]' 2>/dev/null || echo '[]'`,
      { encoding: 'utf-8', cwd, timeout: 15_000 }
    ).trim();

    if (!reviewsRaw || reviewsRaw === '[]') {
      return outcome;
    }

    const reviews = JSON.parse(reviewsRaw);
    if (!Array.isArray(reviews)) {
      return outcome;
    }

    // Count review types
    for (const review of reviews) {
      const state = (review.state || '').toUpperCase();
      if (state === 'APPROVED') {
        outcome.approvals++;
      } else if (state === 'CHANGES_REQUESTED') {
        outcome.changeRequests++;
        outcome.humanReviewRequired = true;
      } else if (state === 'COMMENTED') {
        // Counted in intervention summary, don't double-count here
      }
    }

    // Count distinct rounds (unique submission timestamps rounded to nearest hour)
    const timestamps = reviews
      .map((r: { submittedAt: string }) => r.submittedAt)
      .filter(Boolean)
      .map((ts: string) => {
        try {
          return Math.floor(new Date(ts).getTime() / (1000 * 60 * 60)); // Round to hour
        } catch {
          return 0;
        }
      });

    const uniqueRounds = new Set(timestamps);
    outcome.rounds = uniqueRounds.size;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[outcome-collectors] Failed to collect review outcome: ${message}`);
  }

  return outcome;
}

// ────────────────────────────────────────────────────────────────
// Rework Outcome Collector
// ────────────────────────────────────────────────────────────────

/**
 * Collect rework outcome: agent iterations and tool failures.
 *
 * Counts post-PR commits as iterations. Optionally scans session files
 * for assistant turn counts and tool errors.
 *
 * @param worktreePath - Worktree path for session file lookup
 * @param branchName - Git branch name
 * @param agentType - Agent type (claude, codex)
 * @param repoDir - Repository directory (defaults to cwd)
 * @returns Rework outcome
 */
export function collectReworkOutcome(
  worktreePath: string,
  branchName: string,
  agentType?: string,
  repoDir?: string,
): ReworkOutcome {
  const cwd = repoDir || process.cwd();
  const outcome: ReworkOutcome = {
    agentIterations: 0,
  };

  try {
    // Count commits on the branch as iterations
    const commitsRaw = execShellCommand(
      `git rev-list --count main..${escapeShellArg(branchName)} 2>/dev/null || echo '0'`,
      { encoding: 'utf-8', cwd, timeout: 10_000 }
    ).trim();

    outcome.agentIterations = parseInt(commitsRaw, 10) || 0;

    // Try to count tool failures from session files (Claude only)
    if (agentType === 'claude' && worktreePath) {
      const projectsDir = resolveProjectsDir(worktreePath);
      if (existsSync(projectsDir)) {
        const sessionFiles = readdirSync(projectsDir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => join(projectsDir, f));

        let toolFailures = 0;
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

              // Look for assistant messages with tool errors
              if (entry.type === 'assistant' && entry.gitBranch === branchName) {
                const message = entry.message as Record<string, unknown> | undefined;
                if (message?.content && Array.isArray(message.content)) {
                  for (const block of message.content) {
                    if (block.type === 'tool_result' && block.is_error === true) {
                      toolFailures++;
                    }
                  }
                }
              }
            }
          } catch {
            continue;
          }
        }

        if (toolFailures > 0) {
          outcome.toolFailures = toolFailures;
        }
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[outcome-collectors] Failed to collect rework outcome: ${message}`);
  }

  return outcome;
}

// ────────────────────────────────────────────────────────────────
// Delivery Outcome Collector
// ────────────────────────────────────────────────────────────────

/**
 * Collect delivery outcome: PR creation, merge status, and timing.
 *
 * Uses GitHub API to fetch PR metadata including merge status and timestamps.
 *
 * @param prNumber - GitHub PR number
 * @param repoDir - Repository directory (defaults to cwd)
 * @returns Delivery outcome
 */
export function collectDeliveryOutcome(
  prNumber: string,
  repoDir?: string,
  nwo?: string,
): DeliveryOutcome {
  const cwd = repoDir || process.cwd();
  const repo = nwo || resolveOwnerRepo(cwd);
  const outcome: DeliveryOutcome = {
    prCreated: false,
    merged: false,
  };

  if (!repo) {
    console.warn('[outcome-collectors] Cannot resolve GitHub repo — skipping delivery outcome');
    return outcome;
  }

  try {
    // Fetch PR metadata via GitHub API
    const prDataRaw = execShellCommand(
      `gh api repos/${escapeShellArg(repo)}/pulls/${escapeShellArg(prNumber)} --jq '{merged: .merged, mergedAt: .merged_at, createdAt: .created_at}' 2>/dev/null || echo '{}'`,
      { encoding: 'utf-8', cwd, timeout: 15_000 }
    ).trim();

    if (!prDataRaw || prDataRaw === '{}') {
      return outcome;
    }

    const prData = JSON.parse(prDataRaw);
    outcome.prCreated = true;
    outcome.merged = prData.merged === true;

    // Calculate time to merge if merged
    if (outcome.merged && prData.createdAt && prData.mergedAt) {
      try {
        const created = new Date(prData.createdAt).getTime();
        const merged = new Date(prData.mergedAt).getTime();
        outcome.timeToMergeSeconds = Math.round((merged - created) / 1000);
      } catch {
        // Ignore parse errors
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[outcome-collectors] Failed to collect delivery outcome: ${message}`);
  }

  return outcome;
}
