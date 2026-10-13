#!/usr/bin/env -S npx tsx

/**
 * Post-Completion Eval Hook — CLI wrapper
 *
 * Triggers eval automatically after a workflow completes.
 * Exits non-zero when the eval record was not persisted.
 */

import { errorMessage } from '../shared/lib/error-utils.ts';
import { writeJobResultFile } from '../shared/lib/job-tracker.ts';
import type { PostCompletionContext } from '../shared/lib/post-completion-hook.ts';
import { runTool } from '../shared/lib/tool-runner.ts';
import { runPostCompletionEval } from '../shared/lib/post-completion-hook.ts';
import { EvalValidationError } from '../shared/lib/eval-persistence.ts';
import { shouldSkipAbortedTaskEval } from '../shared/lib/eval-skip-guard.ts';

runTool({
  name: 'run-eval-hook',
  description: 'Automatically evaluate a completed workflow',
  options: {
    issue: { type: 'string', description: 'Linear issue identifier (e.g., HOK-123)' },
    pr: { type: 'string', description: 'GitHub PR number' },
    'pr-url': { type: 'string', description: 'GitHub PR URL (auto-detected if not provided)' },
    'workflow-type': { type: 'string', description: 'Workflow type: workflow, bugfix, mill, or plan' },
    branch: { type: 'string', description: 'Git branch name' },
    worktree: { type: 'string', description: 'Worktree directory' },
    agent: { type: 'string', description: 'Agent type: claude or codex (default: claude)' },
    'solution-model': { type: 'string', description: 'Model that produced the solution being evaluated' },
    'challenge-pair': { type: 'string', description: 'Shared challenge pair identifier' },
    'challenge-side': { type: 'string', description: 'Authoritative challenge side (primary|challenger) from the task key' },
    'challenge-stage': { type: 'string', description: 'Varied challenge stage: plan, implementation, or review' },
    'repo-dir': { type: 'string', description: 'Repository directory (default: current directory)' },
    'result-file': { type: 'string', description: 'Optional path for structured job results' },
    debug: { type: 'boolean', description: 'Enable detailed cost computation diagnostics' },
  },
  examples: [
    'npx tsx tools/run-eval-hook.ts --issue HOK-123 --pr 456 --workflow-type workflow',
    'npx tsx tools/run-eval-hook.ts --issue HOK-123 --pr 456 --workflow-type bugfix',
  ],
  additionalHelp: `Notes:
  - Reads autoEval from .wavemill-config.json; skips eval if disabled
  - Exits non-zero when eval persistence fails or no record is written
  - Results are appended to .wavemill/evals/evals.jsonl
  - When --result-file is provided, writes structured success/failure metadata
  - Use --debug to troubleshoot "no session data found" issues`,
  async run({ args }) {
    // Enable debug mode if requested
    if (args.debug) {
      process.env.DEBUG_COST = '1';
    }

    const debug = process.env.DEBUG_COST === '1';

    if (debug) {
      console.error('[DEBUG_COST] ========================================');
      console.error('[DEBUG_COST] Eval hook invoked with CLI arguments:');
      console.error(`[DEBUG_COST]   --issue: ${args.issue || '(not provided)'}`);
      console.error(`[DEBUG_COST]   --pr: ${args.pr || '(not provided)'}`);
      console.error(`[DEBUG_COST]   --pr-url: ${args['pr-url'] || '(not provided)'}`);
      console.error(`[DEBUG_COST]   --workflow-type: ${args['workflow-type'] || '(not provided)'}`);
      console.error(`[DEBUG_COST]   --branch: ${args.branch || '(not provided)'}`);
      console.error(`[DEBUG_COST]   --worktree: ${args.worktree || '(not provided)'}`);
      console.error(`[DEBUG_COST]   --agent: ${args.agent || '(not provided)'}`);
      console.error(`[DEBUG_COST]   --repo-dir: ${args['repo-dir'] || '(not provided)'}`);
      console.error('[DEBUG_COST] ========================================');
    }

    const rawChallengeStage = args['challenge-stage'];
    const challengeStage: PostCompletionContext['challengeStage'] =
      rawChallengeStage === 'plan' || rawChallengeStage === 'implementation' || rawChallengeStage === 'review'
        ? rawChallengeStage
        : undefined;

    const context: PostCompletionContext = {
      issueId: args.issue,
      prNumber: args.pr,
      prUrl: args['pr-url'],
      workflowType: args['workflow-type'] || 'unknown',
      repoDir: args['repo-dir'],
      branchName: args.branch,
      worktreePath: args.worktree,
      agentType: args.agent,
      solutionModel: args['solution-model'],
      challengePairId: args['challenge-pair'],
      challengeSide: args['challenge-side'] as 'primary' | 'challenger' | undefined,
      challengeStage,
    };

    if (debug) {
      console.error('[DEBUG_COST] Resolved context object:');
      console.error(`[DEBUG_COST]   issueId: ${context.issueId || '(undefined)'}`);
      console.error(`[DEBUG_COST]   prNumber: ${context.prNumber || '(undefined)'}`);
      console.error(`[DEBUG_COST]   prUrl: ${context.prUrl || '(undefined)'}`);
      console.error(`[DEBUG_COST]   workflowType: ${context.workflowType}`);
      console.error(`[DEBUG_COST]   repoDir: ${context.repoDir || '(undefined)'}`);
      console.error(`[DEBUG_COST]   branchName: ${context.branchName || '(undefined)'}`);
      console.error(`[DEBUG_COST]   worktreePath: ${context.worktreePath || '(undefined)'}`);
      console.error(`[DEBUG_COST]   agentType: ${context.agentType || '(undefined)'}`);
      console.error(`[DEBUG_COST]   solutionModel: ${context.solutionModel || '(undefined)'}`);
      console.error(`[DEBUG_COST]   challengePairId: ${context.challengePairId || '(undefined)'}`);
      console.error(`[DEBUG_COST]   challengeStage: ${context.challengeStage || '(undefined)'}`);
      console.error('[DEBUG_COST] ========================================');
    }

    const resultFile = args['result-file'] as string | undefined;
    let persisted = false;
    let exitCode = 0;
    let failureMessage = '';
    let quarantinePath: string | undefined;
    const writeResultFile = (code: number) => {
      if (!resultFile) {
        return;
      }
      writeJobResultFile(resultFile, {
        ok: persisted,
        persisted,
        exitCode: code,
        reason: persisted ? undefined : 'eval_not_persisted',
        error: failureMessage || undefined,
        quarantinePath,
      });
    };
    const handleSigterm = () => {
      writeResultFile(143);
      process.exit(143);
    };

    process.once('SIGTERM', handleSigterm);

    try {
      const skipReason = shouldSkipAbortedTaskEval(args['repo-dir'], args.issue, args.pr, args['challenge-side']);
      if (skipReason) {
        failureMessage = skipReason;
        if (resultFile) {
          writeJobResultFile(resultFile, {
            ok: false,
            persisted: false,
            exitCode: 0,
            reason: skipReason,
          });
        }
        return;
      }
	      context.onPersisted = () => {
	        persisted = true;
        writeResultFile(0);
      };
      persisted = await runPostCompletionEval(context);
      if (!persisted) {
        exitCode = 1;
        failureMessage = 'eval_not_persisted';
      }
    } catch (err) {
      const message = errorMessage(err);
      console.warn(`Post-completion eval hook: unexpected error — ${message}`);
      exitCode = 1;
      failureMessage = message;
      if (err instanceof EvalValidationError && err.quarantinePath) {
        quarantinePath = err.quarantinePath;
      }
    } finally {
      process.removeListener('SIGTERM', handleSigterm);
      writeResultFile(exitCode);
    }

    process.exit(exitCode);
  },
});
