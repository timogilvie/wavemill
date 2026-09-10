#!/usr/bin/env -S npx tsx
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import { reviewChanges } from '../shared/lib/review-runner.ts';
import {
  initReviewMetric,
  addIteration,
  finalizeMetric,
  saveMetric,
  findIssueIdFromContext,
  loadReviewRunState,
  saveReviewRunState,
  clearReviewRunState,
  type ReviewMetric,
} from '../shared/lib/review-metrics.ts';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createReviewProgressReporter } from '../shared/lib/review-progress.ts';
import {
  detectSinceCommit,
  formatReviewResult,
  parseLogFormat,
} from '../shared/lib/review-formatter.ts';
import { getCurrentOperatingMode, type OperatingMode } from '../shared/lib/operating-mode.ts';

const VALID_OPERATING_MODES: readonly OperatingMode[] = ['normal', 'constrained', 'survival'];

function parseOperatingMode(value: string | undefined): OperatingMode | undefined {
  if (!value) {
    return undefined;
  }

  if ((VALID_OPERATING_MODES as readonly string[]).includes(value)) {
    return value as OperatingMode;
  }

  throw new Error(
    `Invalid --operating-mode value: ${value}. Expected one of: ${VALID_OPERATING_MODES.join(', ')}.`
  );
}

runTool({
  name: 'review-changes',
  description: 'Review code changes against plan and task packet',
  options: {
    json: { type: 'boolean', description: 'Output as clean JSON (for agent/script consumption)' },
    'log-format': { type: 'string', description: 'Progress log format on stderr: text or json' },
    verbose: { type: 'boolean', description: 'Print full review output and debug info (stderr)' },
    'skip-ui': { type: 'boolean', description: 'Skip UI verification even if design context exists' },
    'ui-only': { type: 'boolean', description: 'Run only UI verification (skip code review)' },
    'since-commit': { type: 'string', description: 'Only review changes after this commit SHA (scopes review to task-specific changes)' },
    'operating-mode': { type: 'string', description: 'Force review mode: normal, constrained, or survival. Auto-detected when omitted.' },
    'reviewer-model': { type: 'string', description: 'Explicit reviewer model to pin for analysis (overrides WAVEMILL_RESOLVED_MODEL)' },
  },
  positional: {
    name: 'targetBranch repoDir',
    description: 'Target branch and optional repository directory',
    multiple: true,
  },
  examples: [
    'npx tsx tools/review-changes.ts',
    'npx tsx tools/review-changes.ts develop',
    'npx tsx tools/review-changes.ts main --json',
    'npx tsx tools/review-changes.ts main --log-format json',
    'npx tsx tools/review-changes.ts main --verbose',
    'npx tsx tools/review-changes.ts main /path/to/repo --skip-ui',
    'npx tsx tools/review-changes.ts main --since-commit abc1234',
    'npx tsx tools/review-changes.ts main --operating-mode constrained',
  ],
  additionalHelp: `Exit Codes:
  0 - Review passed (verdict: ready)
  1 - Review failed (verdict: not_ready)
  2 - Error occurred

Output Modes:
  Default   Human-readable formatted output with colors
  --json    Clean JSON on stdout (for agents and scripts)
  --log-format json  NDJSON progress events on stderr
  --verbose Debug info on stderr (composable with --json)`,
  async run({ args, positional }) {
    const targetBranch = positional[0] || 'main';
    const repoDir = resolveRepoDir(positional[1]);
    const verbose = !!args.verbose;
    const jsonOutput = !!args.json;
    const logFormat = parseLogFormat(args['log-format'] as string | undefined);
    const reporter = createReviewProgressReporter({ format: logFormat });
    const forcedOperatingMode = parseOperatingMode(args['operating-mode'] as string | undefined);

    // Initialize metrics tracking
    let metric: ReviewMetric | undefined;
    let currentBranch = '';

    try {
      // Get current branch name
      try {
        currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: repoDir,
          encoding: 'utf-8',
        }).trim();
      } catch {
        currentBranch = 'unknown';
      }

      // Detect if running from wrong directory (worktree but on main branch)
      if (currentBranch === targetBranch && targetBranch === 'main') {
        try {
          const gitDir = execSync('git rev-parse --git-dir', {
            cwd: repoDir,
            encoding: 'utf-8',
          }).trim();

          // Check if we're in a worktree directory structure
          if (gitDir.includes('/worktrees/') && currentBranch === 'main') {
            const errorMsg = `
Error: Potential working directory mismatch detected.

You appear to be running from a worktree but on branch '${currentBranch}'.
This usually means the review tool was run from the wrong directory.

Expected: Run from the worktree directory where your feature branch is checked out
Current directory: ${repoDir}
Current branch: ${currentBranch}
Git directory: ${gitDir}

Fix: Ensure you run this command from your worktree directory, not the main repo.
Use the relative path: npx tsx tools/review-changes.ts ${targetBranch} --json
            `.trim();

            if (jsonOutput) {
              const errorJson = {
                error: true,
                message: errorMsg,
                verdict: null,
                codeReviewFindings: [],
                uiFindings: [],
                metadata: null,
              };
              console.log(JSON.stringify(errorJson, null, 2));
            }
            await reporter.emit({
              event: 'error',
              level: 'error',
              message: 'Potential working directory mismatch detected',
              details: { currentBranch, targetBranch, repoDir, gitDir },
            });
            console.error(errorMsg);
            process.exitCode = 2;
            return;
          }
        } catch {
          // If git commands fail, continue anyway
        }
      }

      // Load or create metric
      const existingState = loadReviewRunState(repoDir, verbose);
      if (existingState) {
        metric = existingState.metric;
        if (verbose) {
          console.error(`Continuing review run ${metric.id} (iteration ${metric.iterations.length + 1})`);
        }
      } else {
        const issueId = findIssueIdFromContext(repoDir, verbose);
        metric = initReviewMetric(currentBranch, targetBranch, issueId);
        if (verbose) {
          console.error(`Starting new review run ${metric.id}`);
        }
      }

      // Resolve sinceCommit: explicit flag > auto-detect from selected-task.json
      const sinceCommit = (args['since-commit'] as string | undefined)
        || detectSinceCommit(currentBranch, repoDir, verbose);
      const featureDir = resolveReviewFeatureDir(repoDir, currentBranch);
      let operatingMode = forcedOperatingMode;
      if (!operatingMode) {
        try {
          operatingMode = getCurrentOperatingMode(repoDir);
        } catch {
          operatingMode = 'normal';
        }
      }

      await reporter.emit({
        event: 'review_start',
        message: 'Running code review',
        details: {
          targetBranch,
          repoDir,
          skipUi: !!args['skip-ui'],
          uiOnly: !!args['ui-only'],
          sinceCommit: sinceCommit || null,
          featureDir: featureDir || null,
          operatingMode,
        },
      });
      if (verbose) {
        console.error(`  Target branch: ${targetBranch}`);
        console.error(`  Repository: ${repoDir}`);
        console.error(`  Skip UI: ${!!args['skip-ui']}`);
        console.error(`  UI only: ${!!args['ui-only']}`);
        console.error(`  Operating mode: ${operatingMode}`);
        if (sinceCommit) {
          console.error(`  Since commit: ${sinceCommit}`);
        }
        if (featureDir) {
          console.error(`  Feature dir: ${featureDir}`);
        }
        console.error('');
      }

      const reviewerModel = (args['reviewer-model'] as string | undefined)
        || process.env.WAVEMILL_RESOLVED_MODEL;

      const result = await reviewChanges({
        targetBranch,
        repoDir,
        skipUi: !!args['skip-ui'],
        uiOnly: !!args['ui-only'],
        verbose,
        reporter,
        sinceCommit,
        operatingMode,
        featureDir: featureDir ?? undefined,
        reviewerModel,
      });

      // Add iteration to metric
      const iterationNumber = metric.iterations.length + 1;
      addIteration(metric, iterationNumber, result);

      const output = jsonOutput
        ? JSON.stringify(result, null, 2)
        : formatReviewResult(result, verbose);
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(output + '\n', (err: Error | null | undefined) => (err ? reject(err) : resolve()));
      });

      // Determine outcome and finalize
      if (result.verdict === 'ready') {
        // Review passed - finalize and clear state
        finalizeMetric(metric, 'resolved');
        const saved = saveMetric(metric, repoDir, verbose);
        clearReviewRunState(repoDir, verbose);
        if (verbose) {
          console.error(`Review run ${metric.id} completed: resolved after ${metric.totalIterations} iteration(s)`);
          if (!saved) {
            console.error('  (Note: Metrics could not be saved, but review succeeded)');
          }
        }
      } else {
        // Review failed - save state for next iteration
        const saved = saveReviewRunState(metric, repoDir, verbose);
        if (verbose) {
          console.error(`Review run ${metric.id} iteration ${iterationNumber} failed - state saved for retry`);
          if (!saved) {
            console.error('  (Note: State could not be saved, next run will start fresh)');
          }
        }
      }

      process.exitCode = result.verdict === 'ready' ? 0 : 1;
    } catch (error) {
      // On error, finalize metric and save
      if (metric) {
        // Try to save error metric (defensive - won't throw)
        finalizeMetric(metric, 'error', {
          error: (error as Error).message,
        });
        const saved = saveMetric(metric, repoDir, verbose);
        clearReviewRunState(repoDir, verbose);

        if (verbose && !saved) {
          console.error('Note: Error metric could not be saved, but error is being reported below.');
        }
      }

      if (jsonOutput) {
        const errorJson = {
          error: true,
          message: (error as Error).message,
          verdict: null,
          codeReviewFindings: [],
          uiFindings: [],
          metadata: null,
        };
        console.log(JSON.stringify(errorJson, null, 2));
      }
      await reporter.emit({
        event: 'error',
        level: 'error',
        message: (error as Error).message.split('\n')[0],
      });
      console.error(`Error: ${(error as Error).message}`);
      if (verbose && error instanceof Error && error.stack) {
        console.error(error.stack);
      }
      process.exitCode = 2;
    }
  },
});

function resolveReviewFeatureDir(repoDir: string, branchName: string): string | null {
  const match = branchName.match(/^(?:task|feature|bugfix|bug)\/(.+)$/);
  if (!match) {
    return null;
  }

  for (const root of ['features', 'bugs']) {
    const candidate = join(repoDir, root, match[1]);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}
