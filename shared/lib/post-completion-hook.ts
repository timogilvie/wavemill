/**
 * Post-completion hook for wavemill workflows.
 *
 * Automatically triggers eval after a workflow finishes (PR created).
 * Non-blocking: eval failures log a warning but never fail the workflow.
 */

import { readFileSync, existsSync, appendFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { evaluateTask } from './eval.js';
import { appendEvalRecord } from './eval-persistence.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import {
  detectAllInterventions,
  toInterventionMeta,
  toInterventionRecords,
  formatForJudge,
  loadPenalties,
} from './intervention-detector.ts';
import { computeWorkflowCost, loadPricingTable } from './workflow-cost.ts';
import { analyzePrDifficulty } from './difficulty-analyzer.ts';
import { analyzeTaskContext } from './task-context-analyzer.ts';
import { analyzeRepoContext } from './repo-context-analyzer.ts';
import { callClaude } from './llm-cli.js';
import { loadWavemillConfig } from './config.ts';
import { detectSubsystems } from './subsystem-detector.ts';
import { updateAffectedSubsystems } from './subsystem-updater.ts';
import { detectAffectedSubsystems } from './subsystem-mapper.ts';

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
  agentType?: string;
}

/**
 * Resolve the evalsDir from config, falling back to the default.
 */
function resolveEvalsDir(repoDir: string): string | undefined {
  const config = loadWavemillConfig(repoDir);
  if (config.eval?.evalsDir) return resolve(repoDir, config.eval.evalsDir);
  return undefined;
}

/**
 * Fetch issue description from Linear via the get-issue-json tool.
 */
function fetchIssuePrompt(issueId: string, repoDir: string): string {
  const toolPath = resolve(__dirname, '../../tools/get-issue-json.ts');
  try {
    const raw = execShellCommand(
      `npx tsx ${escapeShellArg(toolPath)} ${escapeShellArg(issueId)} 2>/dev/null | sed '/^\\[dotenv/d'`,
      { encoding: 'utf-8', cwd: repoDir }
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
    url = execShellCommand(`gh pr view ${escapeShellArg(prNumber)} --json url --jq .url 2>/dev/null`, {
      encoding: 'utf-8', cwd: repoDir,
    }).trim();
  } catch { /* best-effort */ }

  try {
    diff = execShellCommand(`gh pr diff ${escapeShellArg(prNumber)}`, {
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
 * Callers are responsible for gating on autoEval before invoking this function
 * (e.g. the mill script checks AUTO_EVAL, the workflow command calls explicitly).
 *
 * - Gathers context (issue details, PR diff).
 * - Invokes the LLM judge via evaluateTask().
 * - Persists the result via appendEvalRecord() from eval-persistence.
 * - Never throws: all errors are caught and logged as warnings.
 */
export async function runPostCompletionEval(ctx: PostCompletionContext): Promise<void> {
  const repoDir = ctx.repoDir || process.cwd();
  const debug = process.env.DEBUG_COST === '1' || process.env.DEBUG_COST === 'true';

  // Always log that we entered this function (for debugging)
  console.log('Post-completion eval: DEBUG_COST=' + (debug ? 'enabled' : 'disabled'));

  // Log received context for diagnostics
  if (debug) {
    console.log('[DEBUG_COST] ========================================');
    console.log('[DEBUG_COST] runPostCompletionEval() called with context:');
    console.log(`[DEBUG_COST]   issueId: ${ctx.issueId || '(undefined)'}`);
    console.log(`[DEBUG_COST]   prNumber: ${ctx.prNumber || '(undefined)'}`);
    console.log(`[DEBUG_COST]   prUrl: ${ctx.prUrl || '(undefined)'}`);
    console.log(`[DEBUG_COST]   workflowType: ${ctx.workflowType}`);
    console.log(`[DEBUG_COST]   repoDir: ${repoDir}`);
    console.log(`[DEBUG_COST]   branchName: ${ctx.branchName || '(undefined)'}`);
    console.log(`[DEBUG_COST]   worktreePath: ${ctx.worktreePath || '(undefined)'}`);
    console.log(`[DEBUG_COST]   agentType: ${ctx.agentType || '(undefined)'}`);
    console.log('[DEBUG_COST] ========================================');
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
        branchName = execShellCommand('git branch --show-current', {
          encoding: 'utf-8', cwd: repoDir,
        }).trim();
      } catch { /* best-effort */ }
    }

    const interventionSummary = detectAllInterventions({
      prNumber: ctx.prNumber,
      branchName,
      baseBranch: 'main',
      repoDir,
      worktreePath: ctx.worktreePath,
      agentType: ctx.agentType,
    });
    const interventionMeta = toInterventionMeta(interventionSummary);
    const interventionRecords = toInterventionRecords(interventionSummary);
    const penalties = loadPenalties(repoDir);
    const interventionText = formatForJudge(interventionSummary, penalties);

    const totalInterventions = interventionSummary.interventions.reduce((sum, e) => sum + e.count, 0);
    console.log(`Post-completion eval: ${totalInterventions} intervention(s) detected`);

    // 4. Compute difficulty metrics from PR diff (HOK-777)
    let difficultyData: ReturnType<typeof analyzePrDifficulty> = null;
    if (ctx.prNumber && prReviewOutput) {
      try {
        console.log('Post-completion eval: analyzing PR difficulty...');
        difficultyData = analyzePrDifficulty({
          prDiff: prReviewOutput,
          prNumber: ctx.prNumber,
          repoDir,
        });
        if (difficultyData) {
          const uncertainSuffix = difficultyData.difficultySignals.diffUncertain
            ? ' ⚠ UNCERTAIN — diff may be incomplete'
            : '';
          console.log(
            `Post-completion eval: difficulty ${difficultyData.difficultyBand} ` +
            `(${difficultyData.difficultySignals.locTouched} LOC, ` +
            `${difficultyData.difficultySignals.filesTouched} files, ` +
            `stratum: ${difficultyData.stratum})${uncertainSuffix}`
          );
        }
      } catch (diffErr: unknown) {
        const diffMsg = diffErr instanceof Error ? diffErr.message : String(diffErr);
        console.warn(`Post-completion eval: difficulty analysis failed — ${diffMsg}`);
        // Non-blocking: continue without difficulty data
      }
    }

    // 4a. Analyze task context (HOK-774)
    let taskContextData: ReturnType<typeof analyzeTaskContext> | null = null;
    if (ctx.issueId || prReviewOutput) {
      try {
        console.log('Post-completion eval: analyzing task context...');
        // Fetch issue data for task context
        let issueData;
        if (ctx.issueId) {
          try {
            const toolPath = resolve(__dirname, '../../tools/get-issue-json.ts');
            const raw = execShellCommand(
              `npx tsx ${escapeShellArg(toolPath)} ${escapeShellArg(ctx.issueId)} 2>/dev/null | sed '/^\\[dotenv/d'`,
              { encoding: 'utf-8', cwd: repoDir }
            ).trim();
            issueData = JSON.parse(raw);
          } catch {
            // Issue fetch failed - continue with partial data
          }
        }

        taskContextData = analyzeTaskContext({
          issue: issueData,
          prDiff: prReviewOutput,
          locTouched: difficultyData?.difficultySignals.locTouched,
          filesTouched: difficultyData?.difficultySignals.filesTouched,
        });

        if (taskContextData) {
          console.log(
            `Post-completion eval: task context ${taskContextData.taskType} / ` +
            `${taskContextData.changeKind} / complexity ${taskContextData.complexity}`
          );
        }
      } catch (taskErr: unknown) {
        const taskMsg = taskErr instanceof Error ? taskErr.message : String(taskErr);
        console.warn(`Post-completion eval: task context analysis failed — ${taskMsg}`);
        // Non-blocking: continue without task context
      }
    }

    // 4b. Analyze repo context (HOK-774)
    let repoContextData: ReturnType<typeof analyzeRepoContext> | null = null;
    try {
      console.log('Post-completion eval: analyzing repo context...');
      repoContextData = analyzeRepoContext(repoDir);
      if (repoContextData) {
        console.log(
          `Post-completion eval: repo context ${repoContextData.primaryLanguage} / ` +
          `${repoContextData.repoVisibility} / ` +
          `${repoContextData.repoSize?.fileCount || 0} files`
        );
      }
    } catch (repoErr: unknown) {
      const repoMsg = repoErr instanceof Error ? repoErr.message : String(repoErr);
      console.warn(`Post-completion eval: repo context analysis failed — ${repoMsg}`);
      // Non-blocking: continue without repo context
    }

    // 5. Run eval
    console.log('Post-completion eval: invoking LLM judge...');
    const record = await evaluateTask({
      taskPrompt,
      prReviewOutput,
      interventions: interventionMeta,
      interventionRecords,
      interventionText,
      issueId: ctx.issueId || undefined,
      prUrl: prUrl || undefined,
      metadata: { workflowType: ctx.workflowType, hookTriggered: true, interventionSummary },
    });

    // Set agentType unconditionally so eval records always reflect which agent ran
    record.agentType = ctx.agentType || 'claude';

    // 6. Attach difficulty data to record (HOK-777)
    if (difficultyData) {
      record.difficultyBand = difficultyData.difficultyBand;
      record.difficultySignals = difficultyData.difficultySignals;
      record.stratum = difficultyData.stratum;
    }

    // 6a. Attach task context to record (HOK-774)
    if (taskContextData) {
      record.taskContext = taskContextData;
    }

    // 6b. Attach repo context to record (HOK-774)
    if (repoContextData) {
      record.repoContext = repoContextData;
    }

    // 7. Compute workflow cost from agent session data
    //    Pricing lives in the wavemill repo config, not the target repo,
    //    so resolve it from this script's location.
    const debug = process.env.DEBUG_COST === '1' || process.env.DEBUG_COST === 'true';

    if (debug) {
      console.log('[DEBUG_COST] Pre-cost-computation check:');
      console.log(`[DEBUG_COST]   ctx.worktreePath: ${ctx.worktreePath || '(undefined)'}`);
      console.log(`[DEBUG_COST]   branchName: ${branchName || '(undefined)'}`);
      console.log(`[DEBUG_COST]   Condition met: ${!!(ctx.worktreePath && branchName)}`);
    }

    if (ctx.worktreePath && branchName) {
      console.log('Post-completion eval: computing workflow cost...');

      if (debug) {
        console.log('[DEBUG_COST] Cost computation parameters:');
        console.log(`[DEBUG_COST]   worktreePath: ${ctx.worktreePath}`);
        console.log(`[DEBUG_COST]   branchName: ${branchName}`);
        console.log(`[DEBUG_COST]   repoDir: ${repoDir}`);
        console.log(`[DEBUG_COST]   agentType: ${ctx.agentType || 'claude'}`);
      }

      try {
        const wavemillConfigDir = resolve(__dirname, '../..');
        const pricingTable = loadPricingTable(wavemillConfigDir);

        if (debug) {
          const modelCount = Object.keys(pricingTable).length;
          console.log(`[DEBUG_COST]   Loaded pricing for ${modelCount} model(s)`);
        }

        const costResult = computeWorkflowCost({
          worktreePath: ctx.worktreePath,
          branchName,
          repoDir,
          pricingTable,
          agentType: ctx.agentType,
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
          if (!debug) {
            console.log('Post-completion eval: run with DEBUG_COST=1 for detailed diagnostics');
          }
        }
      } catch (costErr: unknown) {
        const costMsg = costErr instanceof Error ? costErr.message : String(costErr);
        console.warn(`Post-completion eval: workflow cost computation failed — ${costMsg}`);
      }
    } else {
      if (debug) {
        console.log('[DEBUG_COST] Skipping cost computation - required parameters missing:');
        if (!ctx.worktreePath) {
          console.log('[DEBUG_COST]   Missing: worktreePath');
        }
        if (!branchName) {
          console.log('[DEBUG_COST]   Missing: branchName');
        }
      }
      console.log('Post-completion eval: skipping workflow cost (missing worktreePath or branchName)');
    }

    // 8. Persist via eval-persistence
    const evalsDir = resolveEvalsDir(repoDir);
    appendEvalRecord(record, evalsDir ? { dir: evalsDir } : undefined);

    // 9. Update project context
    await updateProjectContext(ctx, prReviewOutput, taskPrompt);

    // 10. Print summary
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

/**
 * Update project context after PR merge.
 *
 * Analyzes the PR diff and generates a summary to append to project-context.md.
 * Non-blocking: failures log warnings but don't fail the workflow.
 */
async function updateProjectContext(
  ctx: PostCompletionContext,
  prDiff: string,
  issueContext: string
): Promise<void> {
  const repoDir = ctx.repoDir || process.cwd();
  const contextPath = join(repoDir, '.wavemill', 'project-context.md');

  // Skip if project-context.md doesn't exist (not initialized)
  if (!existsSync(contextPath)) {
    console.log('Project context: skipped (not initialized — run init-project-context.ts)');
    return;
  }

  try {
    console.log('Project context: generating update...');

    // Generate summary using Claude CLI
    const summary = await generateContextUpdate({
      issueId: ctx.issueId || 'Unknown',
      prUrl: ctx.prUrl || '',
      prDiff,
      issueContext,
    });

    // Append to project-context.md
    appendContextUpdate(contextPath, summary);

    console.log('Project context: updated successfully');

    // Update subsystem specs (cold memory)
    await updateSubsystemSpecs(ctx, prDiff, issueContext, repoDir);

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Project context: update failed — ${message}`);
  }
}

/**
 * Update subsystem specs after PR merge.
 *
 * Detects affected subsystems and updates their specifications.
 * Non-blocking: failures log warnings but don't fail the workflow.
 */
async function updateSubsystemSpecs(
  ctx: PostCompletionContext,
  prDiff: string,
  issueContext: string,
  repoDir: string
): Promise<void> {
  const contextDir = join(repoDir, '.wavemill', 'context');

  // Skip if context directory doesn't exist
  if (!existsSync(contextDir)) {
    console.log('Subsystem update: skipped (no subsystem specs found)');
    return;
  }

  try {
    // Detect subsystems
    console.log('Subsystem update: detecting subsystems...');
    const subsystems = detectSubsystems(repoDir, {
      minFiles: 3,
      useGitAnalysis: false, // Skip git analysis for speed
      maxSubsystems: 20,
    });

    if (subsystems.length === 0) {
      console.log('Subsystem update: no subsystems detected');
      return;
    }

    // Extract issue title from context
    const titleMatch = issueContext.match(/^#\s*[A-Z]+-\d+:\s*(.+)$/m);
    const issueTitle = titleMatch ? titleMatch[1] : 'Unknown';

    // Detect affected subsystems before updating
    const affectedSubsystems = detectAffectedSubsystems(prDiff, subsystems, repoDir);

    // Knowledge gap detection: warn if PR has significant changes but no subsystems matched
    if (affectedSubsystems.length === 0) {
      const prSize = prDiff.split('\n').length;
      if (prSize > 100) {
        console.log('');
        console.log('⚠️  KNOWLEDGE GAP: No subsystem specs matched this PR');
        console.log(`   PR has ${prSize} lines of changes, but no subsystem docs were updated`);
        console.log('   This may indicate:');
        console.log('   - New subsystem(s) introduced in this PR');
        console.log('   - Subsystem specs are incomplete or missing');
        console.log('');
        console.log('   Recommendation: Run the following to create/update subsystem docs:');
        console.log('     wavemill context init --force');
        console.log('');
        console.log('   This enables "persistent downstream acceleration" for future tasks');
        console.log('   (per Codified Context paper, Case Study 3)');
        console.log('');
      }
    }

    // Update affected subsystems
    await updateAffectedSubsystems(subsystems, {
      issueId: ctx.issueId || 'Unknown',
      issueTitle,
      prUrl: ctx.prUrl || '',
      prDiff,
      issueDescription: issueContext,
      repoDir,
    });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Subsystem update: failed — ${message}`);
  }
}

/**
 * Generate a context update summary from PR diff using Claude CLI.
 */
async function generateContextUpdate(opts: {
  issueId: string;
  prUrl: string;
  prDiff: string;
  issueContext: string;
}): Promise<string> {
  const promptPath = resolve(__dirname, '../../tools/prompts/context-update-template.md');
  const promptTemplate = readFileSync(promptPath, 'utf-8');

  // Extract issue title from context
  const titleMatch = opts.issueContext.match(/^#\s*[A-Z]+-\d+:\s*(.+)$/m);
  const issueTitle = titleMatch ? titleMatch[1] : 'Unknown';

  // Fill in template placeholders
  const timestamp = new Date().toISOString();
  const prompt = promptTemplate
    .replace('{TIMESTAMP}', timestamp)
    .replace('{ISSUE_ID}', opts.issueId)
    .replace('{ISSUE_TITLE}', issueTitle)
    .replace('{PR_URL}', opts.prUrl)
    .replace('{ISSUE_DESCRIPTION}', opts.issueContext)
    .replace('{PR_DIFF}', opts.prDiff.substring(0, 50000)); // Limit diff size

  const claudeCmd = process.env.CLAUDE_CMD || 'claude';
  const result = await callClaude(prompt, {
    mode: 'stream',
    cliCmd: claudeCmd,
    cliFlags: [
      '--tools', '',
      '--append-system-prompt',
      'You have NO tools available. Output ONLY the markdown summary in the exact format specified. No conversational text, no preamble, no XML tags. Start directly with the heading.',
    ],
  });

  return result.text;
}

/**
 * Append a context update to project-context.md.
 */
function appendContextUpdate(contextPath: string, summary: string): void {
  const update = `\n\n${summary}\n\n---`;
  appendFileSync(contextPath, update, 'utf-8');
}
