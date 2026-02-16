/**
 * Post-completion hook for wavemill workflows.
 *
 * Automatically triggers eval after a workflow finishes (PR created).
 * Non-blocking: eval failures log a warning but never fail the workflow.
 */

import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { evaluateTask } from './eval.js';
import { appendEvalRecord } from './eval-persistence.ts';
import {
  detectAllInterventions,
  toInterventionMeta,
  formatForJudge,
  loadPenalties,
} from './intervention-detector.ts';
import { computeWorkflowCost } from './workflow-cost.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface PostCompletionContext {
  issueId?: string;
  prNumber?: string;
  prUrl?: string;
  workflowType: string;
  repoDir?: string;
  branchName?: string;
  worktreePath?: string;
}

/**
 * Read the autoEval setting from .wavemill-config.json.
 * Returns false if the config file is missing or the key is absent.
 */
function isAutoEvalEnabled(repoDir: string): boolean {
  const configPath = join(repoDir, '.wavemill-config.json');
  if (!existsSync(configPath)) return false;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return config.autoEval === true;
  } catch {
    return false;
  }
}

/**
 * Resolve the evalsDir from config, falling back to the default.
 */
function resolveEvalsDir(repoDir: string): string | undefined {
  const configPath = join(repoDir, '.wavemill-config.json');
  if (!existsSync(configPath)) return undefined;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (config.eval?.evalsDir) return resolve(repoDir, config.eval.evalsDir);
  } catch { /* fall through */ }
  return undefined;
}

/**
 * Fetch issue description from Linear via the get-issue-json tool.
 */
function fetchIssuePrompt(issueId: string, repoDir: string): string {
  const toolPath = resolve(__dirname, '../../tools/get-issue-json.ts');
  try {
    const raw = execSync(
      `npx tsx "${toolPath}" "${issueId}" 2>/dev/null | sed '/^\\[dotenv/d'`,
      { encoding: 'utf-8', cwd: repoDir, shell: '/bin/bash' }
    ).trim();
    const issue = JSON.parse(raw);
    return `# ${issue.identifier}: ${issue.title}\n\n${issue.description || ''}`;
  } catch {
    return `Issue: ${issueId} (details unavailable)`;
  }
}

/**
 * Fetch PR diff and URL from GitHub.
 */
function fetchPrContext(prNumber: string, repoDir: string): { diff: string; url: string } {
  let url = '';
  let diff = '';

  try {
    url = execSync(`gh pr view ${prNumber} --json url --jq .url 2>/dev/null`, {
      encoding: 'utf-8', cwd: repoDir, shell: '/bin/bash',
    }).trim();
  } catch { /* best-effort */ }

  try {
    diff = execSync(`gh pr diff ${prNumber}`, {
      encoding: 'utf-8', cwd: repoDir, maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    diff = '(PR diff unavailable)';
  }

  return { diff, url };
}

/**
 * Run the post-completion eval hook.
 *
 * - Checks autoEval config; returns early if disabled.
 * - Gathers context (issue details, PR diff).
 * - Invokes the LLM judge via evaluateTask().
 * - Persists the result via appendEvalRecord() from eval-persistence.
 * - Never throws: all errors are caught and logged as warnings.
 */
export async function runPostCompletionEval(ctx: PostCompletionContext): Promise<void> {
  const repoDir = ctx.repoDir || process.cwd();

  // 1. Check config
  if (!isAutoEvalEnabled(repoDir)) {
    console.log('Post-completion eval: skipped (autoEval is disabled in config)');
    return;
  }

  if (!ctx.issueId && !ctx.prNumber) {
    console.warn('Post-completion eval: skipped (no issue ID or PR number provided)');
    return;
  }

  try {
    console.log('Post-completion eval: gathering context...');

    // 2. Gather context
    const taskPrompt = ctx.issueId
      ? fetchIssuePrompt(ctx.issueId, repoDir)
      : '(No issue context available)';

    let prReviewOutput = '';
    let prUrl = ctx.prUrl || '';
    if (ctx.prNumber) {
      const prCtx = fetchPrContext(ctx.prNumber, repoDir);
      prReviewOutput = prCtx.diff;
      if (!prUrl) prUrl = prCtx.url;
    }

    // 3. Detect intervention events
    console.log('Post-completion eval: detecting interventions...');
    let branchName = ctx.branchName || '';
    if (!branchName) {
      try {
        branchName = execSync('git branch --show-current', {
          encoding: 'utf-8', cwd: repoDir,
        }).trim();
      } catch { /* best-effort */ }
    }

    const interventionSummary = detectAllInterventions({
      prNumber: ctx.prNumber,
      branchName,
      baseBranch: 'main',
      repoDir,
    });
    const interventionMeta = toInterventionMeta(interventionSummary);
    const penalties = loadPenalties(repoDir);
    const interventionText = formatForJudge(interventionSummary, penalties);

    const totalInterventions = interventionSummary.interventions.reduce((sum, e) => sum + e.count, 0);
    console.log(`Post-completion eval: ${totalInterventions} intervention(s) detected`);

    // 4. Run eval
    console.log('Post-completion eval: invoking LLM judge...');
    const record = await evaluateTask({
      taskPrompt,
      prReviewOutput,
      interventions: interventionMeta,
      interventionText,
      issueId: ctx.issueId || undefined,
      prUrl: prUrl || undefined,
      metadata: { workflowType: ctx.workflowType, hookTriggered: true, interventionSummary },
    });

    // 5. Compute workflow cost from Claude session data
    if (ctx.worktreePath && branchName) {
      console.log('Post-completion eval: computing workflow cost...');
      try {
        const costResult = computeWorkflowCost({
          worktreePath: ctx.worktreePath,
          branchName,
          repoDir,
        });
        if (costResult) {
          record.workflowCost = costResult.totalCostUsd;
          record.workflowTokenUsage = costResult.models;
          console.log(
            `Post-completion eval: workflow cost $${costResult.totalCostUsd.toFixed(4)} ` +
            `(${costResult.turnCount} turns across ${costResult.sessionCount} session(s))`
          );
        } else {
          console.log('Post-completion eval: no session data found for workflow cost');
        }
      } catch (costErr: unknown) {
        const costMsg = costErr instanceof Error ? costErr.message : String(costErr);
        console.warn(`Post-completion eval: workflow cost computation failed — ${costMsg}`);
      }
    }

    // 6. Persist via eval-persistence
    const evalsDir = resolveEvalsDir(repoDir);
    appendEvalRecord(record, evalsDir ? { dir: evalsDir } : undefined);

    // 7. Print summary
    const scoreDisplay = (record.score as number).toFixed(2);
    const costSuffix = record.workflowCost !== undefined
      ? `, workflow cost: $${record.workflowCost.toFixed(4)}`
      : '';
    console.log(`Post-completion eval: ${record.scoreBand} (${scoreDisplay}${costSuffix}) — saved to eval store`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Post-completion eval: failed (workflow unaffected) — ${message}`);
  }
}
