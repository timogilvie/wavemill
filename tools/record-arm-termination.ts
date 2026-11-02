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
import { recordArmTermination, ARM_FAILURE_KINDS } from '../shared/lib/arm-termination.ts';
import { runTool } from './lib/tool-runner.ts';

const options = {
  'issue': { type: 'string' as const, description: 'Linear issue ID (e.g., HOK-1234)' },
  'feature-dir': { type: 'string' as const, description: 'Feature directory path' },
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
  'dry-run': { type: 'boolean' as const, description: 'Dry-run mode' },
  'stamp-only': { type: 'boolean' as const, description: 'Stamp state only (fallback)' },
};

runTool({
  name: 'record-arm-termination',
  description: 'Record an arm termination with typed cause and attribution',
  options,
  async run({ args }) {
    const {
      issue,
      'feature-dir': featureDir,
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
      'dry-run': dryRun,
      'stamp-only': stampOnly,
    } = args;

    // Validation
    if (!issue) throw new Error('--issue is required');
    if (!actor) throw new Error('--actor is required');
    if (!failureKind) throw new Error('--failure-kind is required');

    const kind = failureKind as any;
    if (!ARM_FAILURE_KINDS.includes(kind)) {
      throw new Error(`unknown failure kind: ${kind}\nvalid kinds: ${ARM_FAILURE_KINDS.join(', ')}`);
    }

    if (dryRun) {
      console.log(JSON.stringify({
        action: 'dry-run',
        issue,
        actor,
        failureKind,
        detail,
        evidence,
      }, null, 2));
      return;
    }

    if (stampOnly) {
      // Fallback: stamp only, no records (D5)
      if (!stateFile) throw new Error('--state-file required for --stamp-only');
      // TODO: Implement stamp-only path
      console.log(JSON.stringify({ action: 'stamp-only', issue }, null, 2));
      return;
    }

    // Full record path
    const result = await recordArmTermination({
      repoDir: process.cwd(),
      stateFile,
      issueId: issue,
      featureDir,
      stage,
      model,
      failureKind: kind,
      detail: detail || abortReason || '',
      nextAction,
      actor: actor as any,
      evidencePath: evidence,
      scope: scope as 'single' | 'pair',
    });

    if ('error' in result) {
      throw new Error(`${result.error}: ${JSON.stringify(result.validationErrors)}`);
    }

    console.log(JSON.stringify(result, null, 2));
  },
});
