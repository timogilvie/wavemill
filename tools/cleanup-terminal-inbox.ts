#!/usr/bin/env -S npx tsx

import { fileURLToPath } from 'node:url';
import {
  cleanupTerminalInbox,
  formatTerminalInboxDecisions,
} from '../shared/lib/terminal-inbox-cleanup.ts';
import { runTool, resolveRepoDir, type ParsedArgs } from '../shared/lib/tool-runner.ts';

const options = {
  execute: { type: 'boolean', description: 'Perform eligible cleanup mutations. Defaults to dry-run.' },
  'dry-run': { type: 'boolean', description: 'Inspect and print decisions without mutating state or resources.' },
  abandon: { type: 'boolean', description: 'Explicitly abandon one closed losing challenge arm locally; not accepted for bulk inbox mode.' },
  'repo-dir': { type: 'string', description: 'Repository directory that owns the workflow state' },
  'state-file': { type: 'string', description: 'Workflow state file path' },
  'base-branch': { type: 'string', description: 'Fallback base branch when task lifecycle lacks one' },
  json: { type: 'boolean', description: 'Print structured JSON decisions' },
  out: { type: 'string', description: 'Write the single-task audit decision to this path' },
} as const;

type CliArgs = ParsedArgs<typeof options>;

export async function runCleanupTerminalInboxCommand(args: CliArgs, positional: string[]) {
  const target = positional[0] ?? 'inbox';
  if (positional.length > 1) {
    throw new Error(`unexpected positional arguments: ${positional.slice(1).join(' ')}`);
  }
  if (args.execute && args['dry-run']) {
    throw new Error('--execute and --dry-run cannot be combined');
  }
  const inbox = target === 'inbox';
  if (inbox && args.abandon) {
    throw new Error('--abandon is only allowed for a single issue id, not bulk inbox cleanup');
  }

  const repoDir = resolveRepoDir(args['repo-dir']);
  const decisions = await cleanupTerminalInbox({
    repoDir,
    stateFile: args['state-file'],
    baseBranch: args['base-branch'],
    inbox,
    issue: inbox ? undefined : target,
    execute: args.execute === true,
    abandon: args.abandon === true,
    json: args.json === true,
    out: args.out,
  });

  if (args.json) {
    console.log(JSON.stringify({ execute: args.execute === true, target, decisions }, null, 2));
  } else {
    console.log(formatTerminalInboxDecisions(decisions, args.execute === true));
  }
  return decisions;
}

export async function runCleanupTerminalInboxCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  await runTool({
    name: 'cleanup-terminal-inbox',
    description: 'Inspect and finalize terminal Wavemill Inbox tasks',
    options,
    positional: {
      name: 'target',
      description: 'Either "inbox" for bulk inspection or one issue id such as HOK-3002_c',
    },
    examples: [
      'wavemill cleanup inbox --dry-run',
      'wavemill cleanup inbox --execute',
      'wavemill cleanup HOK-3002_c --abandon --execute',
    ],
    run: ({ args, positional }) => runCleanupTerminalInboxCommand(args, positional),
  }, argv);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  await runCleanupTerminalInboxCli();
}
