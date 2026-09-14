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

import { readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from './error-utils.ts';
import { fetchPrReviews, resolveOwnerRepo } from './github.ts';
import { readJsonlFile } from './jsonl-utils.ts';
import { escapeShellArg, execArgvCommand, execShellCommand } from './shell-utils.ts';
import { loadReviewInterventions } from './review-intervention-mapper.ts';
import {
  collectStaticFeatures,
  type StaticFeaturesResult,
} from './static-features.ts';

// Maps gh CLI's `bucket` field (pass/fail/pending/skipping/cancel) to the
// legacy `conclusion` values the collectors below were written against.
// `gh pr checks --json conclusion` was removed in gh ≥ 2.72.0.
function bucketToConclusion(bucket: string | null | undefined): string | null {
  switch (bucket) {
    case 'pass': return 'success';
    case 'fail': return 'failure';
    case 'skipping': return 'skipped';
    case 'cancel': return 'cancelled';
    case 'pending': return null;
    default: return null;
  }
}
import type {
  CiOutcome,
  TestsOutcome,
  StaticAnalysisOutcome,
  ReviewOutcome,
  ReworkOutcome,
  DeliveryOutcome,
} from './eval-schema.ts';
import type { InterventionSummary } from './intervention-detector.ts';
import { resolveProjectsDirs } from './workflow-cost.ts';

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
    // Fetch all fields needed by any collector. gh CLI removed `conclusion`
    // from `gh pr checks --json` (gh ≥ 2.72.0); we now request `bucket`
    // (pre-categorized pass/fail/pending) and synthesize a `conclusion`
    // field below so the rest of this file's collectors keep working.
    const checksRaw = execShellCommand(
      `gh pr checks ${escapeShellArg(prNumber)} --json name,state,bucket,startedAt,completedAt 2>/dev/null || echo '[]'`,
      { encoding: 'utf-8', cwd, timeout: 15_000 }
    ).trim();

    if (!checksRaw || checksRaw === '[]') {
      prChecksCache.set(cacheKey, []);
      return [];
    }

    const parsed = JSON.parse(checksRaw);
    if (!Array.isArray(parsed)) {
      prChecksCache.set(cacheKey, []);
      return [];
    }

    const checks = parsed.map((entry: { conclusion?: unknown; bucket?: unknown }) => ({
      ...entry,
      conclusion: typeof entry.conclusion === 'string'
        ? entry.conclusion
        : bucketToConclusion(typeof entry.bucket === 'string' ? entry.bucket : null),
    }));

    // Cache and return
    prChecksCache.set(cacheKey, checks);
    return checks;
  } catch (err: unknown) {
    const message = errorMessage(err);
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
          if (durationSeconds < 0) {
            durationSeconds = undefined;
          }
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
    const message = errorMessage(err);
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
    const message = errorMessage(err);
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
  checkoutDir?: string,
): StaticAnalysisOutcome {
  const cwd = repoDir || process.cwd();
  const outcome: StaticAnalysisOutcome = {};

  // Legacy CI-check-name matches (kept for backward compat with historical
  // consumers). These were empty in 100% of records; they remain as-is.
  try {
    const checks = fetchPrChecks(prNumber, cwd);
    if (checks.length > 0) {
      const typecheckCheck = checks.find((c: { name: string }) =>
        /type|tsc|typecheck/i.test(c.name)
      );
      if (typecheckCheck) {
        outcome.typecheckPassed = typecheckCheck.conclusion === 'success';
      }
      const lintCheck = checks.find((c: { name: string }) =>
        /lint|eslint|prettier/i.test(c.name)
      );
      if (lintCheck) {
        outcome.lintDelta = lintCheck.conclusion === 'success' ? 0 : 1;
      }
      const securityCheck = checks.find((c: { name: string }) =>
        /security|codeql|snyk|dependabot/i.test(c.name)
      );
      if (securityCheck) {
        outcome.securityFindingsDelta = securityCheck.conclusion === 'success' ? 0 : 1;
      }
    }
  } catch (err: unknown) {
    const message = errorMessage(err);
    console.warn(`[outcome-collectors] Failed to collect legacy CI check names: ${message}`);
  }

  // S1 Static feature group (HOK-2806).
  try {
    const s1 = resolveStaticFeatures(prNumber, cwd, checkoutDir);
    outcome.type_errors = s1.type_errors;
    outcome.lint_errors = s1.lint_errors;
    outcome.build_ok = s1.build_ok;
    outcome.complexity_delta = s1.complexity_delta;
    outcome.build_evidence = s1.build_evidence;
    outcome.complexity_metric = s1.complexity_metric;
  } catch (err: unknown) {
    const message = errorMessage(err);
    console.warn(`[outcome-collectors] Failed to collect S1 static features: ${message}`);
    // Leave S1 fields absent on hard collector failure. Downstream consumers
    // treat absent and null identically (both = evidence unavailable).
  }

  return outcome;
}

/**
 * Resolve a PR-head checkout and run `collectStaticFeatures`.
 *
 * When `checkoutDir` is already at the PR head, run in place. Otherwise
 * create a disposable worktree at the head SHA inside `repoDir` (so
 * `node_modules` resolution walks up to the repo's dev deps — required for
 * `npx --no-install tsc/eslint`). Always cleans up the temp worktree.
 */
function resolveStaticFeatures(
  prNumber: string,
  repoDir: string,
  checkoutDir?: string,
): StaticFeaturesResult {
  // Fast-fail short-circuits so we don't shell out on obviously bogus inputs.
  const empty: StaticFeaturesResult = {
    type_errors: null,
    lint_errors: null,
    build_ok: null,
    complexity_delta: null,
    build_evidence: null,
    complexity_metric: null,
  };
  if (!prNumber || !/^\d+$/.test(prNumber)) return empty;
  if (!isExistingDir(repoDir)) return empty;
  if (checkoutDir && !isExistingDir(checkoutDir)) return empty;

  const prHeadSha = fetchPrHeadSha(prNumber, repoDir);

  if (checkoutDir && prHeadSha) {
    const localHead = execArgvCommand(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: checkoutDir, timeout: 10_000, encoding: 'utf-8' },
    );
    if (!localHead.failed && localHead.stdout.trim() === prHeadSha) {
      return collectStaticFeatures({
        checkoutDir,
        prNumber,
        repoDir,
      });
    }
  }

  if (!prHeadSha) {
    // No head SHA and no verified checkout ⇒ tool-based signals cannot run.
    // CI-evidence build_ok may still work if repoDir has gh access.
    return collectStaticFeatures({
      checkoutDir: checkoutDir ?? repoDir,
      prNumber,
      repoDir,
    });
  }

  // Create a disposable worktree at the head SHA.
  const workDir = join(repoDir, '.static-collect-worktrees', `pr-${prNumber}-${process.pid}`);
  pruneStaleWorktrees(repoDir);

  // Ensure the SHA exists locally; fetch if not.
  const shaExists = execArgvCommand(
    'git',
    ['cat-file', '-e', prHeadSha],
    { cwd: repoDir, timeout: 10_000, encoding: 'utf-8' },
  );
  if (shaExists.exitCode !== 0) {
    const fetchResult = execArgvCommand(
      'git',
      ['fetch', 'origin', `refs/pull/${prNumber}/head:refs/wavemill/static/pr-${prNumber}`],
      { cwd: repoDir, timeout: 60_000, encoding: 'utf-8' },
    );
    if (fetchResult.exitCode !== 0) {
      return {
        type_errors: null,
        lint_errors: null,
        build_ok: null,
        complexity_delta: null,
        build_evidence: null,
        complexity_metric: null,
      };
    }
  }

  const addResult = execArgvCommand(
    'git',
    ['worktree', 'add', '--detach', workDir, prHeadSha],
    { cwd: repoDir, timeout: 60_000, encoding: 'utf-8' },
  );
  if (addResult.exitCode !== 0) {
    return {
      type_errors: null,
      lint_errors: null,
      build_ok: null,
      complexity_delta: null,
      build_evidence: null,
      complexity_metric: null,
    };
  }

  try {
    return collectStaticFeatures({
      checkoutDir: workDir,
      prNumber,
      repoDir,
    });
  } finally {
    try {
      execArgvCommand('git', ['worktree', 'remove', '--force', workDir], {
        cwd: repoDir, timeout: 30_000, encoding: 'utf-8',
      });
    } catch {
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

function fetchPrHeadSha(prNumber: string, repoDir: string): string | null {
  const result = execArgvCommand(
    'gh',
    ['pr', 'view', prNumber, '--json', 'headRefOid', '-q', '.headRefOid'],
    { cwd: repoDir, timeout: 15_000, encoding: 'utf-8' },
  );
  if (result.failed || result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  return sha.length === 40 ? sha : null;
}

function isExistingDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pruneStaleWorktrees(repoDir: string): void {
  try {
    // git worktree prune removes worktrees whose directories are gone.
    execArgvCommand('git', ['worktree', 'prune'], {
      cwd: repoDir, timeout: 10_000, encoding: 'utf-8',
    });
  } catch { /* best effort */ }
}

// ────────────────────────────────────────────────────────────────
// Review Outcome Collector
// ────────────────────────────────────────────────────────────────

/**
 * Collect review outcome from PR review data and intervention summary.
 *
 * Combines intervention detector data with GitHub PR review API to get
 * complete review activity picture. Optionally includes self-review metrics
 * if issueId or branchName are provided.
 *
 * @param prNumber - GitHub PR number
 * @param interventionSummary - Intervention summary from intervention-detector
 * @param repoDir - Repository directory (defaults to cwd)
 * @param nwo - GitHub owner/repo string (optional, will be resolved if needed)
 * @param issueId - Linear issue ID (optional, for self-review lookup)
 * @param branchName - Git branch name (optional, for self-review lookup)
 * @returns Review outcome
 */
export function collectReviewOutcome(
  prNumber: string,
  interventionSummary: InterventionSummary,
  repoDir?: string,
  nwo?: string,
  issueId?: string,
  branchName?: string,
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

    const reviews = fetchPrReviews(prNumber, cwd, repo);
    if (reviews.length === 0) {
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
    const message = errorMessage(err);
    console.warn(`[outcome-collectors] Failed to collect review outcome: ${message}`);
  }

  // Load self-review metrics if issueId or branchName provided
  if ((issueId || branchName) && cwd) {
    try {
      const reviewData = loadReviewInterventions({
        issueId,
        branchName,
        repoDir: cwd,
      });

      if (reviewData.totalIterations > 0) {
        outcome.selfReviewIterations = reviewData.totalIterations;
        outcome.selfReviewBlockers = reviewData.blockerCount;
        outcome.selfReviewWarnings = reviewData.warningCount;
      }
    } catch (err: unknown) {
      // Non-throwing - continue without self-review data
      const message = errorMessage(err);
      console.warn(`[outcome-collectors] Failed to load self-review metrics: ${message}`);
    }
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
      const sessionFiles = resolveProjectsDirs(worktreePath)
        .filter((projectsDir) => existsSync(projectsDir))
        .flatMap((projectsDir) =>
          readdirSync(projectsDir)
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => join(projectsDir, f))
        );

      if (sessionFiles.length > 0) {
        let toolFailures = 0;
        for (const filePath of sessionFiles) {
          try {
            for (const entry of readJsonlFile<Record<string, unknown>>(filePath)) {

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
    const message = errorMessage(err);
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
    const message = errorMessage(err);
    console.warn(`[outcome-collectors] Failed to collect delivery outcome: ${message}`);
  }

  return outcome;
}
