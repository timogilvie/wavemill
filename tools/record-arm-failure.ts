#!/usr/bin/env node
import { appendArmReliabilityRecord } from '../shared/lib/arm-reliability.ts';
import type { ChallengeArmSide } from '../shared/lib/arm-failure-taxonomy.ts';
import { recordSelectionOutcome } from '../shared/lib/challenge-selection-health.ts';
import type { ChallengeStage } from '../shared/lib/challenge-scheduler.ts';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const issueId = requireArg(args, 'issue');
  const challengePairId = requireArg(args, 'pair-id');
  const challengeRole = requireArg(args, 'role') as ChallengeArmSide;
  const stage = requireArg(args, 'stage');
  const model = requireArg(args, 'model');
  const abortReason = requireArg(args, 'abort-reason');
  const repoDir = args['repo-dir'];

  if (challengeRole !== 'primary' && challengeRole !== 'challenger') {
    throw new Error(`Invalid challenge role: ${challengeRole}`);
  }

  const record = appendArmReliabilityRecord({
    issueId,
    challengePairId,
    challengeRole,
    stage,
    model,
    abortReason,
    detail: args.detail,
    nextAction: args['next-action'],
    // HOK-3362: the stage's typed budget fact; the fault class derives from it.
    budgetExhausted: args['budget-exhausted-json'] || undefined,
  }, repoDir);

  await recordSelectionOutcome({
    repoDir,
    owner: {
      issueId: challengePairId,
      pairId: challengePairId,
    },
    stage: normalizeStage(record.stage),
    model: record.model,
    failureKind: record.failureKind,
    faultClass: record.faultClass,
  });
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      parsed[key] = '';
    } else {
      parsed[key] = value;
      index++;
    }
  }
  return parsed;
}

function requireArg(args: Record<string, string>, name: string): string {
  const value = args[name];
  if (!value) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[record-arm-failure] ${message}`);
  process.exitCode = 0;
});

function normalizeStage(value: string): ChallengeStage {
  const raw = value.trim().toLowerCase();
  if (raw === 'plan' || raw === 'planning' || raw === 'planner') return 'plan';
  if (raw === 'review' || raw === 'reviewer') return 'review';
  return 'implementation';
}
