#!/usr/bin/env -S npx tsx
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  abortTaskInState,
  OPERATOR_ABORT_MARKER,
  type AbortTaskResult,
} from '../shared/lib/task-abort.ts';
import { runTool, resolveRepoDir, type ParsedArgs } from '../shared/lib/tool-runner.ts';

export { abortTaskInState, OPERATOR_ABORT_MARKER, type AbortTaskResult };

const options = {
  reason: { type: 'string', description: 'Operator-facing reason for aborting the task' },
  'repo-dir': { type: 'string', description: 'Repository directory that owns the workflow state' },
  'state-file': { type: 'string', description: 'Workflow state file path' },
} as const;

type CliArgs = ParsedArgs<typeof options>;

function statePath(repoDir: string, explicit?: string): string {
  return explicit ? (isAbsolute(explicit) ? explicit : resolve(repoDir, explicit)) : join(repoDir, '.wavemill', 'workflow-state.json');
}

function formatPr(pr: string): string {
  if (!pr) return '(none)';
  return pr.startsWith('#') ? pr : `#${pr}`;
}

function printResult(result: AbortTaskResult): void {
  console.log(`Aborting ${result.issue} (reason: ${result.reason})`);
  console.log(`Task state before:  phase=${result.before.phase}, status=${result.before.status}, pr=${formatPr(result.before.pr)}`);
  console.log(`Task state after:   phase=${result.after.phase}, status=${result.after.status}, abortedReason="${result.after.abortedReason}"`);
  console.log(`Cleanup marker:     challengeAborted=${result.after.challengeAborted}`);
  if (result.before.pr) {
    console.log(`${formatPr(result.before.pr)} detected - worktree and local branch will be preserved. Only the pane and state entry will be cleaned up.`);
  } else {
    console.log('No PR recorded - worktree, local branch, and state entry will be removed on next mill poll.');
  }
}

export async function runAbortTaskCommand(args: CliArgs, positional: string[]): Promise<AbortTaskResult> {
  const issue = positional[0];
  if (!issue) {
    throw new Error('issue id is required');
  }
  if (positional.length > 1) {
    throw new Error(`unexpected positional arguments: ${positional.slice(1).join(' ')}`);
  }

  const repoDir = resolveRepoDir(args['repo-dir']);
  const reason = args.reason?.trim() || 'operator-abort';
  const result = await abortTaskInState(statePath(repoDir, args['state-file']), issue, reason);
  printResult(result);
  return result;
}

export async function runAbortTaskCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  await runTool({
    name: 'abort-task',
    description: 'Mark an active Wavemill task aborted so the mill can clean it up',
    options,
    positional: {
      name: 'issue-id',
      description: 'Task issue id to abort, for example HOK-2878 or HOK-2878_c',
      required: true,
    },
    examples: [
      'wavemill abort HOK-2878 --reason "wrong repo"',
      'wavemill abort HOK-2878_c --reason "operator requested stop" --repo-dir ~/src/app',
    ],
    run: ({ args, positional }) => runAbortTaskCommand(args, positional),
  }, argv);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  await runAbortTaskCli();
}
