/**
 * CLI tool for recording arm termination with typed cause (HOK-3358).
 * Wraps recordArmTermination for shell integration (monitor, operator, resolver).
 *
 * Usage:
 *   npx tsx tools/record-arm-termination.ts --issue HOK-1234 --feature-dir <path> \
 *     --stage coding --model <model> --failure-kind <kind> --abort-reason "..." \
 *     --actor monitor [--evidence <path>] [--dry-run]
 */

import { parseArgs } from 'node:util';
import { recordArmTermination, stampTermination } from '../shared/lib/arm-termination.ts';
import { mutateWorkflowState } from '../shared/lib/workflow-state.ts';
import { ARM_FAILURE_KINDS } from '../shared/lib/arm-failure-taxonomy.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

const options = {
  'issue': { type: 'string' as const, description: 'Linear issue ID (e.g., HOK-1234)' },
  'feature-dir': { type: 'string' as const, description: 'Feature directory path' },
  'archive': { type: 'string' as const, description: 'Archived feature directory for a one-time backfill' },
  'state-file': { type: 'string' as const, description: 'Path to workflow-state.json' },
  'stage': { type: 'string' as const, description: 'Stage name (planning, coding, review)' },
  'model': { type: 'string' as const, description: 'Model ID' },
  'failure-kind': { type: 'string' as const, description: 'Typed failure kind' },
  'abort-reason': { type: 'string' as const, description: 'Full abort reason (for parsing)' },
  'detail': { type: 'string' as const, description: 'Human-readable detail' },
  'next-action': { type: 'string' as const, description: 'Suggested next action' },
  'actor': { type: 'string' as const, description: 'Who is terminating (operator, monitor, etc.)' },
  'evidence': { type: 'string' as const, description: 'Evidence file path (for model-fault)' },
  'scope': { type: 'string' as const, description: 'Termination scope (single, pair)' },
  'budget-exhausted': { type: 'string' as const, description: 'JSON budget-exhaustion fact' },
  'dry-run': { type: 'boolean' as const, description: 'Dry-run mode' },
  'stamp-only': { type: 'boolean' as const, description: 'Stamp state only (fallback)' },
  'backfill': { type: 'boolean' as const, description: 'Record an archived termination without a live state row' },
};

runTool({
  name: 'record-arm-termination',
  description: 'Record an arm termination with typed cause and attribution',
  options,
  async run({ args }) {
    const {
      issue,
      'feature-dir': featureDir,
      archive,
      'state-file': stateFile,
      stage,
      model,
      'failure-kind': failureKind,
      'abort-reason': abortReason,
      detail,
      'next-action': nextAction,
      actor,
      evidence,
      scope = 'single',
      'budget-exhausted': budgetExhaustedRaw,
      'dry-run': dryRun,
      'stamp-only': stampOnly,
      backfill,
    } = args;

    const recordFeatureDir = archive || featureDir;
    if (backfill && !archive) throw new Error('--backfill requires --archive <feature-dir>');

    // Validation
    if (!issue) throw new Error('--issue is required');
    if (!actor) throw new Error('--actor is required');
    if (!failureKind) throw new Error('--failure-kind is required');

    const kind = failureKind as any;
    if (!ARM_FAILURE_KINDS.includes(kind)) {
      throw new Error(`unknown failure kind: ${kind}\nvalid kinds: ${ARM_FAILURE_KINDS.join(', ')}`);
    }
    let budgetExhausted: Record<string, unknown> | undefined;
    if (budgetExhaustedRaw) {
      try { budgetExhausted = JSON.parse(budgetExhaustedRaw); } catch { throw new Error('--budget-exhausted must be JSON'); }
    }

    if (dryRun) {
      console.log(JSON.stringify({
        action: 'dry-run',
        issue,
        actor,
        failureKind,
        detail,
        evidence,
        archive,
      }, null, 2));
      return;
    }

    if (stampOnly) {
      // Fallback: stamp only, no records (D5)
      if (!stateFile) throw new Error('--state-file required for --stamp-only');
      await mutateWorkflowState(stateFile, (state) => {
        const task = state.tasks[issue];
        if (!task) throw new Error(`task ${issue} is not present in workflow state`);
        stampTermination(task, {
          repoDir: process.cwd(), stateFile, issueId: issue, stage, model,
          failureKind: kind, detail: detail || abortReason || '', nextAction,
          actor: actor as any, evidencePath: evidence, abortReason, budgetExhausted, scope: scope as 'single' | 'pair',
        });
        return state;
      });
      console.log(JSON.stringify({ action: 'stamp-only', issue, failureKind: kind }, null, 2));
      return;
    }

    // Full record path
    const result = await recordArmTermination({
      repoDir: process.cwd(),
      stateFile: backfill ? undefined : stateFile,
      issueId: issue,
      featureDir: recordFeatureDir,
      stage,
      model,
      failureKind: kind,
      abortReason,
      detail: detail || abortReason || '',
      nextAction,
      actor: actor as any,
      evidencePath: evidence,
      budgetExhausted,
      scope: scope as 'single' | 'pair',
    });

    if ('error' in result) {
      throw new Error(`${result.error}: ${JSON.stringify(result.validationErrors)}`);
    }

    console.log(JSON.stringify(result, null, 2));
  },
});
