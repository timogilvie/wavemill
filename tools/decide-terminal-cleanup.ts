#!/usr/bin/env -S npx tsx
/**
 * HOK-3312: the monitor's cleanup-decision async-job runner. Reads workflow
 * state, calls `decideTerminalTask` with `monitorConsumer: true`, and prints
 * `{action, decision}` as a compact JSON line.
 *
 * `action` is one of: `reap`, `archive-and-reap`, `retain`, `kept`,
 * `not-terminal`. `retain` is reserved for work the TS decider refuses
 * because it is not delivered — the monitor shell maps it to the same
 * attention surface it already uses for genuinely non-delivered residue.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  decideTerminalTask,
  statePath,
  type TerminalInboxDecision,
} from '../shared/lib/terminal-inbox-cleanup.ts';
import { readWorkflowState } from '../shared/lib/workflow-state.ts';
import { runTool, resolveRepoDir, type ParsedArgs } from '../shared/lib/tool-runner.ts';

const options = {
  issue: { type: 'string', description: 'Task issue id (e.g. HOK-3312 or HOK-3312_c)' },
  'repo-dir': { type: 'string', description: 'Repository directory that owns the workflow state' },
  'state-file': { type: 'string', description: 'Workflow state file path' },
  'base-branch': { type: 'string', description: 'Fallback base branch when the task has no launchContract' },
  role: { type: 'string', description: 'primary (default) | aborted-arm — the latter grants abandon authority' },
  out: { type: 'string', description: 'Write the compact JSON decision to this file (defaults to stdout)' },
} as const;

type CliArgs = ParsedArgs<typeof options>;

export type CleanupDecisionAction = 'reap' | 'archive-and-reap' | 'retain' | 'kept' | 'not-terminal';

export interface CleanupDecisionReport {
  action: CleanupDecisionAction;
  decision: TerminalInboxDecision;
}

export function actionForDecision(decision: TerminalInboxDecision): CleanupDecisionAction {
  switch (decision.status) {
    case 'would-reap':
    case 'would-abandon-loser':
    case 'would-abandon-aborted':
      return 'reap';
    case 'would-archive-and-reap':
      return 'archive-and-reap';
    case 'kept':
      return 'kept';
    case 'not-terminal':
      return 'not-terminal';
    case 'already-reaped':
      return 'reap';
    default:
      return 'retain';
  }
}

export async function runDecideTerminalCleanupCommand(args: CliArgs): Promise<CleanupDecisionReport> {
  const issue = typeof args.issue === 'string' ? args.issue : '';
  if (!issue) {
    throw new Error('decide-terminal-cleanup: --issue is required');
  }
  const repoDir = resolveRepoDir(args['repo-dir']);
  const stateFile = statePath(repoDir, args['state-file']);
  const baseBranch = typeof args['base-branch'] === 'string' && args['base-branch']
    ? args['base-branch']
    : 'auto/integration';
  const role = args.role === 'aborted-arm' ? 'aborted-arm' : 'primary';
  if (!existsSync(stateFile)) {
    throw new Error(`decide-terminal-cleanup: workflow state file not found: ${stateFile}`);
  }
  const state = readWorkflowState(stateFile);
  if (!state) {
    throw new Error(`decide-terminal-cleanup: workflow state at ${stateFile} is not readable`);
  }
  const decision = decideTerminalTask(state, issue, repoDir, baseBranch, {
    monitorConsumer: true,
    allowAbandon: role === 'aborted-arm',
  });
  const report: CleanupDecisionReport = { action: actionForDecision(decision), decision };
  const payload = JSON.stringify(report);
  const out = typeof args.out === 'string' ? args.out : '';
  if (out) {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname: pathDirname } = await import('node:path');
    mkdirSync(pathDirname(out), { recursive: true });
    writeFileSync(out, `${payload}\n`, 'utf-8');
  } else {
    console.log(payload);
  }
  return report;
}

export async function runDecideTerminalCleanupCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  await runTool({
    name: 'decide-terminal-cleanup',
    description: 'Compute the terminal-cleanup decision for one task; used by the monitor as a tracked job.',
    options,
    examples: [
      'wavemill tool decide-terminal-cleanup --issue HOK-3312 --repo-dir .',
      'wavemill tool decide-terminal-cleanup --issue HOK-3312_c --role aborted-arm',
    ],
    async run({ args }) {
      await runDecideTerminalCleanupCommand(args);
    },
  }, argv);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  await runDecideTerminalCleanupCli();
}
