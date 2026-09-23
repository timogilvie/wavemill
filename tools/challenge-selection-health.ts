#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  ackLaunch,
  clearSelectionHealth,
  formatSelectionHealthStatus,
  readSelectionHealth,
  recordSelectionOutcome,
  releaseReservation,
  type SelectionAttemptStatus,
  type SelectionHealthOwner,
} from '../shared/lib/challenge-selection-health.ts';
import type { ChallengeStage } from '../shared/lib/challenge-scheduler.ts';

runTool({
  name: 'challenge-selection-health',
  description: 'Inspect or mutate temporary challenge selection reservations and circuits.',
  options: {
    'repo-dir': { type: 'string', description: 'Repository directory' },
    issue: { type: 'string', description: 'Issue id or arm key' },
    'pair-id': { type: 'string', description: 'Challenge pair id' },
    model: { type: 'string', description: 'Model alias' },
    provider: { type: 'string', description: 'Provider name for clear' },
    stage: { type: 'string', description: 'Challenge stage (plan|implementation|review)' },
    'failure-kind': { type: 'string', description: 'Typed terminal failure kind' },
    'fault-class': { type: 'string', description: 'Typed fault class' },
    'terminal-status': { type: 'string', description: 'Explicit terminal attempt status (success|failure|forfeit|invalid)' },
    success: { type: 'boolean', description: 'Record a successful terminal outcome' },
    json: { type: 'boolean', description: 'Emit JSON status' },
    all: { type: 'boolean', description: 'Clear all health state' },
  },
  positional: {
    name: 'command',
    description: 'status|clear|ack-launch|record-outcome|release',
    required: true,
  },
  async run({ args, positional }) {
    const command = positional[0];
    const repoDir = args['repo-dir'] || process.cwd();
    const stage = normalizeStage(args.stage);

    if (command === 'status') {
      const status = formatSelectionHealthStatus(readSelectionHealth({ repoDir }));
      console.log(JSON.stringify(status, null, args.json ? 2 : 0));
      return;
    }

    if (command === 'clear') {
      const state = await clearSelectionHealth({
        repoDir,
        all: args.all === true,
        provider: args.provider,
        model: args.model,
        stage,
      });
      console.log(JSON.stringify(formatSelectionHealthStatus(state), null, args.json ? 2 : 0));
      return;
    }

    if (command === 'ack-launch') {
      await ackLaunch({
        repoDir,
        model: requireString(args.model, '--model'),
        stage: requireStage(stage),
        owner: ownerFromArgs(args),
      });
      return;
    }

    if (command === 'record-outcome') {
      await recordSelectionOutcome({
        repoDir,
        model: requireString(args.model, '--model'),
        stage: requireStage(stage),
        owner: ownerFromArgs(args),
        success: args.success === true,
        terminalStatus: normalizeTerminalStatus(args['terminal-status']),
        failureKind: args['failure-kind'] || undefined,
        faultClass: args['fault-class'] as never,
      });
      return;
    }

    if (command === 'release') {
      await releaseReservation({
        repoDir,
        model: args.model,
        stage,
        owner: ownerFromArgs(args),
      });
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  },
});

function ownerFromArgs(args: { issue?: string; 'pair-id'?: string }): SelectionHealthOwner {
  const pairId = requireString(args['pair-id'], '--pair-id');
  return {
    issueId: pairId,
    pairId,
  };
}

function requireString(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new Error(`Missing required ${name}`);
  }
  return value.trim();
}

function requireStage(stage: ChallengeStage | undefined): ChallengeStage {
  if (!stage) {
    throw new Error('Missing required --stage');
  }
  return stage;
}

function normalizeStage(value: string | undefined): ChallengeStage | undefined {
  const raw = value?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === 'plan' || raw === 'planning' || raw === 'planner') return 'plan';
  if (raw === 'review' || raw === 'reviewer') return 'review';
  if (raw === 'implementation' || raw === 'coding' || raw === 'coder') return 'implementation';
  throw new Error(`Invalid --stage: ${value}`);
}

function normalizeTerminalStatus(value: string | undefined): SelectionAttemptStatus | undefined {
  const raw = value?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === 'success' || raw === 'failure' || raw === 'forfeit' || raw === 'invalid') return raw;
  throw new Error(`Invalid --terminal-status: ${value}`);
}
