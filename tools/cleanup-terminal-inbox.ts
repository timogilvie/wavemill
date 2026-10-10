#!/usr/bin/env -S npx tsx

import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupTerminalInbox,
  formatTerminalInboxDecisions,
  setTerminalTaskKeepHold,
} from '../shared/lib/terminal-inbox-cleanup.ts';
import { TASK_ID_RE } from '../shared/lib/task-identity.ts';
import { runTool, resolveRepoDir, type ParsedArgs } from '../shared/lib/tool-runner.ts';

const options = {
  execute: { type: 'boolean', description: 'Perform eligible cleanup mutations. Defaults to dry-run.' },
  'dry-run': { type: 'boolean', description: 'Inspect and print decisions without mutating state or resources.' },
  abandon: { type: 'boolean', description: 'Explicitly abandon one aborted or closed-losing challenge arm locally; an unpublished PR-less head is archived to refs/archive/wavemill/<issue> first. Not accepted for bulk inbox mode.' },
  'archive-and-reap': { type: 'boolean', description: 'HOK-3160: archive a delivered arm\'s residue (uncommitted edits, untracked files, PR-less unpublished commits) under .wavemill/evals/artifacts/<id>/retired-arm-residue/ and then reap. Only accepted for a single issue in explicit single-task mode. In bulk `inbox --execute` mode the executor auto-promotes safe refusals.' },
  keep: { type: 'boolean', description: 'HOK-3201: mark one terminal task as explicitly kept — the unattended inbox never auto-reaps a task with lifecycle.retention.hold === "keep". Pair with --reason "<why>" to record context.' },
  unkeep: { type: 'boolean', description: 'HOK-3201: clear a prior keep hold on one terminal task.' },
  reason: { type: 'string', description: 'HOK-3201: optional note stored alongside a --keep hold (ignored for other operations).' },
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
  if (args.keep && args.unkeep) {
    throw new Error('--keep and --unkeep cannot be combined');
  }
  const inbox = target === 'inbox';
  if (inbox && args.abandon) {
    throw new Error('--abandon is only allowed for a single issue id, not bulk inbox cleanup');
  }
  if (inbox && args['archive-and-reap']) {
    throw new Error('--archive-and-reap is only allowed for a single issue id, not bulk inbox cleanup');
  }
  if (inbox && (args.keep || args.unkeep)) {
    throw new Error('--keep/--unkeep require a single issue id, not bulk inbox cleanup');
  }

  const repoDir = resolveRepoDir(args['repo-dir']);

  // HOK-3201: --keep / --unkeep mutate lifecycle.retention.hold and emit an
  // operator event so the monitor cadence throttle clears. They never run a
  // cleanup decision — the next monitor tick (or an explicit cleanup call)
  // picks the task back up with the hold applied.
  if (args.keep || args.unkeep) {
    if (!TASK_ID_RE.test(target)) {
      throw new Error('--keep/--unkeep require a valid issue id (e.g. HOK-3156 or HOK-3156_c)');
    }
    const result = await setTerminalTaskKeepHold({
      issue: target,
      repoDir,
      stateFile: args['state-file'],
      hold: args.keep ? 'keep' : null,
      reason: typeof args.reason === 'string' ? args.reason : '',
    });
    // Clear the monitor's cadence file so the next tick runs immediately and
    // picks up the new hold without waiting on the slow interval.
    clearMonitorCleanupCadence(repoDir);
    if (args.json) {
      console.log(JSON.stringify({ operation: args.keep ? 'keep' : 'unkeep', ...result }, null, 2));
    } else {
      console.log(`${args.keep ? 'keep' : 'unkeep'}\t${target}\t${result.reason || '-'}`);
    }
    return [];
  }

  const decisions = await cleanupTerminalInbox({
    repoDir,
    stateFile: args['state-file'],
    baseBranch: args['base-branch'],
    inbox,
    issue: inbox ? undefined : target,
    execute: args.execute === true,
    abandon: args.abandon === true,
    archiveAndReap: args['archive-and-reap'] === true,
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

/**
 * HOK-3201: delete the monitor's cadence timestamp so the next monitor tick
 * runs cleanup immediately. Keep/unkeep writes to lifecycle.retention.hold
 * only matter once the inbox re-evaluates the task, so this is how we clear
 * the slow-cadence throttle. Best-effort; the state file is the source of
 * truth.
 */
function clearMonitorCleanupCadence(repoDir: string): void {
  const stateDir = join(repoDir, '.wavemill');
  for (const name of ['.terminal-cleanup-last-at', '.terminal-cleanup-next-at']) {
    const path = join(stateDir, name);
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
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
      'wavemill cleanup HOK-2815_c --abandon --execute',
      'wavemill cleanup HOK-3160_c --archive-and-reap --execute',
      'wavemill cleanup HOK-3156 --keep --reason "retained for analysis"',
      'wavemill cleanup HOK-3156 --unkeep',
    ],
    async run({ args, positional }) {
      await runCleanupTerminalInboxCommand(args, positional);
    },
  }, argv);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  await runCleanupTerminalInboxCli();
}
