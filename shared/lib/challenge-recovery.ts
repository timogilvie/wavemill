import { join } from 'node:path';
import { getPullRequest } from './github.ts';
import { prStateLabelDeps, WM_LABELS } from './pr-state-labels.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import { mutateWorkflowState } from './workflow-state.ts';
import { resolvePrTask } from './pr-task-resolver.ts';

export interface RecoverSupersededPrOptions {
  prNumber: number;
  repoDir: string;
  dryRun?: boolean;
  github?: {
    getPullRequest?: (prNumber: number, repoDir: string) => { state?: string; labels?: Array<{ name: string }> } | null;
    removeLabelFromPr?: (prNumber: number, label: string, repoDir: string) => void;
    reopenPr?: (prNumber: number, repoDir: string) => void;
    commentOnPr?: (prNumber: number, comment: string, repoDir: string) => void;
  };
}

export interface RecoverSupersededPrResult {
  status: 'recovered' | 'already_recovered' | 'not_superseded' | 'not_found' | 'error';
  prNumber: number;
  message: string;
}

/**
 * Recovers a PR that was erroneously closed with wm:superseded label.
 * This operator recovery path:
 * - Removes the wm:superseded label
 * - Reopens the PR if it's closed
 * - Posts a correction comment
 * - Updates workflow state to manual_comparison_needed
 * - Does NOT reroute, relaunch agents, or alter task contracts
 * - Supports idempotent repeated runs and dry-run planned actions
 */
export async function recoverSupersededPr(options: RecoverSupersededPrOptions): Promise<RecoverSupersededPrResult> {
  const { prNumber, repoDir, dryRun = false } = options;

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return {
      status: 'error',
      prNumber,
      message: `Invalid PR number: ${prNumber}`,
    };
  }

  const getPr = options.github?.getPullRequest ?? getPullRequest;
  const removeLabelFn = options.github?.removeLabelFromPr ?? defaultRemoveLabelFromPr;
  const reopenPrFn = options.github?.reopenPr ?? defaultReopenPr;
  const commentFn = options.github?.commentOnPr ?? defaultCommentOnPr;

  try {
    const pr = getPr(prNumber, repoDir);
    if (!pr) {
      return {
        status: 'not_found',
        prNumber,
        message: `PR #${prNumber} not found`,
      };
    }

    const labels = new Set((pr.labels ?? []).map((label) => label.name));
    const hasSuperseded = labels.has(WM_LABELS.superseded);

    if (!hasSuperseded) {
      return {
        status: 'not_superseded',
        prNumber,
        message: `PR #${prNumber} does not have ${WM_LABELS.superseded} label`,
      };
    }

    if (!dryRun) {
      // Remove the label
      try {
        removeLabelFn(prNumber, WM_LABELS.superseded, repoDir);
      } catch (error) {
        console.warn(`[challenge-recovery] Failed to remove label from PR #${prNumber}: ${error}`);
      }

      // Reopen if closed
      if (pr.state === 'closed') {
        try {
          reopenPrFn(prNumber, repoDir);
        } catch (error) {
          console.warn(`[challenge-recovery] Failed to reopen PR #${prNumber}: ${error}`);
        }
      }

      // Post correction comment
      try {
        commentFn(
          prNumber,
          `Recovered: removed erroneous ${WM_LABELS.superseded} label and restored PR to active workflow state.\nThis correction was applied because a prior evaluation or comparison failure incorrectly triggered automatic closure.`,
          repoDir,
        );
      } catch (error) {
        console.warn(`[challenge-recovery] Failed to post recovery comment on PR #${prNumber}: ${error}`);
      }

      // Update workflow state to manual_comparison_needed if active
      try {
        await updateWorkflowStateToManualComparison(prNumber, repoDir);
      } catch (error) {
        console.warn(`[challenge-recovery] Failed to update workflow state for PR #${prNumber}: ${error}`);
      }
    }

    return {
      status: 'recovered',
      prNumber,
      message: dryRun
        ? `[DRY RUN] Would recover PR #${prNumber}: remove ${WM_LABELS.superseded}, reopen if closed, comment, and update workflow state`
        : `Recovered PR #${prNumber}: removed ${WM_LABELS.superseded}, reopened if closed, posted comment`,
    };
  } catch (error) {
    return {
      status: 'error',
      prNumber,
      message: `Recovery failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function defaultRemoveLabelFromPr(prNumber: number, label: string, repoDir: string): void {
  prStateLabelDeps.removeLabelFromPullRequest(prNumber, label);
}

function defaultReopenPr(prNumber: number, repoDir: string): void {
  execShellCommand(
    `gh pr reopen ${prNumber}`,
    { encoding: 'utf-8', cwd: repoDir },
  );
}

function defaultCommentOnPr(prNumber: number, comment: string, repoDir: string): void {
  execShellCommand(
    `gh pr comment ${prNumber} --body ${escapeShellArg(comment)}`,
    { encoding: 'utf-8', cwd: repoDir },
  );
}

async function updateWorkflowStateToManualComparison(prNumber: number, repoDir: string): Promise<void> {
  const workflowStatePath = join(repoDir, '.wavemill', 'workflow-state.json');

  try {
    await mutateWorkflowState(workflowStatePath, (state) => {
      const { location, miss } = resolvePrTask(prNumber, state, {
        site: 'challenge-recovery.updateWorkflowStateToManualComparison',
      });

      if (location && state.tasks) {
        const taskEntry = state.tasks[location.taskId];
        // Only update if there's a challenge pair (indicating this is a comparison-related PR)
        if (taskEntry && taskEntry.challengePairId) {
          taskEntry.comparisonState = 'manual_comparison_needed';
        }
      } else if (miss) {
        console.warn(
          `[challenge-recovery] Failed to resolve PR ${prNumber} for manual comparison: ${miss.reason}`,
        );
      }

      return state;
    });
  } catch {
    // Workflow state update is best-effort; it's OK if the file doesn't exist
    // The recovery will still succeed
  }
}
