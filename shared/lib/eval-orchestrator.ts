/**
 * Eval Orchestrator
 *
 * Orchestrates complete workflow evaluation:
 * 1. Context gathering (issue, PR, auto-detection)
 * 2. Intervention detection
 * 3. Difficulty/task/repo analysis
 * 4. Outcome collection
 * 5. LLM judging
 * 6. Record enrichment
 * 7. Persistence
 *
 * @module eval-orchestrator
 */

import path from 'node:path';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import {
  autoDetectContext,
  gatherEvalContext,
  fetchIssueData,
  type EvalContext,
} from './eval-context-gatherer.ts';
import {
  detectAllInterventions,
  toInterventionMeta,
  toInterventionRecords,
  formatForJudge,
  loadPenalties,
} from './intervention-detector.ts';
import { analyzePrDifficulty } from './difficulty-analyzer.ts';
import { analyzeTaskContext } from './task-context-analyzer.ts';
import { analyzeRepoContext } from './repo-context-analyzer.ts';
import {
  collectCiOutcome,
  collectTestsOutcome,
  collectStaticAnalysisOutcome,
  collectReviewOutcome,
  collectReworkOutcome,
  collectDeliveryOutcome,
} from './outcome-collectors.ts';
import { evaluateTask } from './eval.js';
import { enrichEvalRecord } from './eval-record-builder.ts';
import { appendEvalRecord } from './eval-persistence.ts';
import type { EvalRecord, Outcomes } from './eval-schema.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * Options for running evaluation.
 */
export interface EvalOptions {
  /** Linear issue ID (optional, auto-detected if not provided) */
  issueId?: string;
  /** GitHub PR number (optional, auto-detected if not provided) */
  prNumber?: string;
  /** PR URL (optional) */
  prUrl?: string;
  /** Repository directory */
  repoDir: string;
  /** Agent type (claude, codex, etc.) */
  agentType?: string;
  /** Solution model used by the agent */
  solutionModel?: string;
  /** Routing decision metadata (optional) */
  routingDecision?: any;
  /** Override eval model (optional) */
  evalModel?: string;
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Run complete evaluation workflow.
 *
 * Orchestrates:
 * - Context gathering (auto-detect or explicit)
 * - Intervention detection
 * - Difficulty/task/repo analysis
 * - Outcome collection (CI, tests, review, rework, delivery)
 * - LLM judging
 * - Record enrichment
 * - Persistence to eval store
 *
 * @param options - Evaluation options
 * @returns Complete eval record
 *
 * @example
 * ```typescript
 * const record = await runEvaluation({
 *   issueId: 'HOK-123',
 *   prNumber: '456',
 *   repoDir: process.cwd(),
 *   agentType: 'claude',
 * });
 * console.log(`Score: ${record.score}`);
 * ```
 */
export async function runEvaluation(options: EvalOptions): Promise<EvalRecord> {
  const {
    issueId: explicitIssueId,
    prNumber: explicitPrNumber,
    prUrl: explicitPrUrl,
    repoDir,
    agentType = 'claude',
    solutionModel,
    routingDecision,
    evalModel,
  } = options;

  // 1. Gather context (auto-detect or explicit)
  console.log('Gathering workflow context...');

  let issueId = explicitIssueId || '';
  let prNumber = explicitPrNumber || '';
  let branch = '';
  let prUrl = explicitPrUrl || '';

  // Auto-detect if not explicitly provided
  if (!issueId && !prNumber) {
    const detected = autoDetectContext(repoDir);
    issueId = detected.issueId;
    prNumber = detected.prNumber;
    branch = detected.branch;
    prUrl = detected.prUrl;
  }

  const evalContext = gatherEvalContext({
    issueId,
    prNumber,
    prUrl,
    repoDir,
  });

  if (issueId) console.log(`  Issue: ${issueId}`);
  if (prNumber) console.log(`  PR: #${prNumber}`);
  if (evalContext.prDiff) {
    const lines = evalContext.prDiff.split('\n').length;
    console.log(`  Diff: ${lines} lines`);
  }

  // 2. Apply model override if specified
  if (evalModel) {
    process.env.EVAL_MODEL = evalModel;
  }

  // 3. Detect intervention events
  console.log('\nDetecting intervention events...');

  // Ensure we have branch name for intervention detection
  if (!branch) {
    try {
      branch = execShellCommand('git branch --show-current', {
        encoding: 'utf-8',
        cwd: repoDir,
      }).trim();
    } catch {
      // Best-effort
    }
  }

  const interventionSummary = detectAllInterventions({
    prNumber,
    branchName: branch,
    baseBranch: 'main',
    repoDir,
    agentType,
    issueId,
  });

  const interventionMeta = toInterventionMeta(interventionSummary);
  const interventionRecords = toInterventionRecords(interventionSummary);
  const penalties = loadPenalties(repoDir);
  const interventionText = formatForJudge(interventionSummary, penalties);

  const totalInterventions = interventionSummary.interventions.reduce(
    (sum, e) => sum + e.count,
    0
  );
  console.log(
    `  Detected ${totalInterventions} intervention event(s) ` +
      `(weighted penalty: ${interventionSummary.totalInterventionScore})`
  );

  // 4. Analyze difficulty from PR diff
  let difficultyData = null;
  if (prNumber && evalContext.prDiff) {
    try {
      console.log('\nAnalyzing PR difficulty...');
      difficultyData = analyzePrDifficulty({
        prDiff: evalContext.prDiff,
        prNumber,
        repoDir,
      });
      if (difficultyData) {
        console.log(
          `  Difficulty: ${difficultyData.difficultyBand} ` +
            `(${difficultyData.difficultySignals.locTouched} LOC, ` +
            `${difficultyData.difficultySignals.filesTouched} files, ` +
            `stratum: ${difficultyData.stratum})`
        );
      }
    } catch (diffErr) {
      const errorMsg = diffErr instanceof Error ? diffErr.message : String(diffErr);
      console.warn(`  Warning: difficulty analysis failed — ${errorMsg}`);
    }
  }

  // 5. Analyze task context
  let taskContextData = null;
  if (issueId || evalContext.prDiff) {
    try {
      console.log('\nAnalyzing task context...');

      taskContextData = analyzeTaskContext({
        issue: evalContext.issueData,
        prDiff: evalContext.prDiff,
        locTouched: difficultyData?.difficultySignals.locTouched,
        filesTouched: difficultyData?.difficultySignals.filesTouched,
      });

      if (taskContextData) {
        console.log(
          `  Task context: ${taskContextData.taskType} / ` +
            `${taskContextData.changeKind} / complexity ${taskContextData.complexity}`
        );
      }
    } catch (taskErr) {
      const errorMsg = taskErr instanceof Error ? taskErr.message : String(taskErr);
      console.warn(`  Warning: task context analysis failed — ${errorMsg}`);
    }
  }

  // 6. Analyze repo context
  let repoContextData = null;
  try {
    console.log('\nAnalyzing repo context...');
    repoContextData = analyzeRepoContext(repoDir);
    if (repoContextData) {
      console.log(
        `  Repo context: ${repoContextData.primaryLanguage} / ` +
          `${repoContextData.repoVisibility} / ` +
          `${repoContextData.repoSize?.fileCount || 0} files`
      );
    }
  } catch (repoErr) {
    const errorMsg = repoErr instanceof Error ? repoErr.message : String(repoErr);
    console.warn(`  Warning: repo context analysis failed — ${errorMsg}`);
  }

  // 7. Collect outcome components
  console.log('\nCollecting outcome components...');
  const outcomes: Outcomes = {
    success: false, // Will be set after scoring based on score threshold
    ci: prNumber
      ? collectCiOutcome(prNumber, repoDir)
      : undefined,
    tests:
      prNumber && branch
        ? collectTestsOutcome(prNumber, branch, 'main', repoDir)
        : undefined,
    staticAnalysis:
      prNumber && branch
        ? collectStaticAnalysisOutcome(prNumber, branch, 'main', repoDir)
        : undefined,
    review: prNumber
      ? collectReviewOutcome(prNumber, interventionSummary, repoDir, undefined, issueId, branch)
      : {
          humanReviewRequired: interventionSummary.interventions.some(
            (e) => e.type === 'review_comment' && e.count > 0
          ),
          rounds: 0,
          approvals: 0,
          changeRequests: 0,
        },
    rework: collectReworkOutcome(repoDir, branch, agentType, repoDir),
    delivery: prNumber
      ? collectDeliveryOutcome(prNumber, repoDir)
      : {
          prCreated: false,
          merged: false,
        },
  };

  console.log(
    `  CI: ${outcomes.ci?.ran ? (outcomes.ci.passed ? 'passed' : 'failed') : 'not run'}`
  );
  console.log(`  Tests: ${outcomes.tests?.added ? 'added' : 'none added'}`);
  console.log(
    `  Review: ${outcomes.review.approvals} approvals, ${outcomes.review.changeRequests} change requests`
  );
  console.log(`  Rework: ${outcomes.rework.agentIterations} iterations`);
  console.log(
    `  Delivery: ${outcomes.delivery.merged ? 'merged' : outcomes.delivery.prCreated ? 'PR created' : 'no PR'}`
  );

  // 8. Invoke judge via shared evaluateTask()
  console.log('\nInvoking LLM judge...');
  const record = await evaluateTask(
    {
      taskPrompt: evalContext.taskPrompt,
      prReviewOutput: evalContext.prDiff,
      interventions: interventionMeta,
      interventionRecords,
      interventionText,
      issueId: issueId || undefined,
      prUrl: prUrl || undefined,
      routingDecision,
      metadata: { interventionSummary },
    },
    outcomes
  );

  // 9. Set success flag based on score threshold
  if (record.outcomes) {
    record.outcomes.success = (record.score as number) >= 0.5;
  }

  // 10. Enrich record with metadata
  enrichEvalRecord(record, {
    agentType,
    difficulty: difficultyData,
    taskContext: taskContextData,
    repoContext: repoContextData,
  });

  // 11. Set solution model if provided
  if (solutionModel) {
    record.modelId = solutionModel;
    record.modelVersion = solutionModel;
  }

  // 12. Persist eval record to disk
  try {
    appendEvalRecord(record);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`Warning: failed to persist eval record: ${errorMsg}`);
  }

  return record;
}
