#!/usr/bin/env -S npx tsx
import { TASK_ID_RE } from '../shared/lib/task-identity.ts';

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutateJsonState } from '../shared/lib/state-mutex.ts';
import { runTool, resolveRepoDir, type ParsedArgs } from '../shared/lib/tool-runner.ts';

type JsonRecord = Record<string, unknown>;

interface WorkflowState {
  tasks?: Record<string, JsonRecord>;
  [key: string]: unknown;
}

export interface AbortTaskResult {
  issue: string;
  reason: string;
  before: {
    phase: string;
    status: string;
    pr: string;
  };
  after: {
    phase: string;
    status: string;
    abortedReason: string;
    challengeAborted: string;
  };
}

const issuePattern = TASK_ID_RE;

// Deliberately NOT a `terminal_stage_failure:`/`terminal_launch_failure:` value.
// parseAbortFailureKind() returns null for this, so classifyArmFault() yields
// 'unknown-fault' and an operator abort is never counted as a model or provider
// quality signal in challenge eval attribution.
const OPERATOR_ABORT_MARKER = 'operator_abort';

const options = {
  reason: { type: 'string', description: 'Operator-facing reason for aborting the task' },
  'repo-dir': { type: 'string', description: 'Repository directory that owns the workflow state' },
  'state-file': { type: 'string', description: 'Workflow state file path' },
} as const;

type CliArgs = ParsedArgs<typeof options>;

function statePath(repoDir: string, explicit?: string): string {
  return explicit ? (isAbsolute(explicit) ? explicit : resolve(repoDir, explicit)) : join(repoDir, '.wavemill', 'workflow-state.json');
}

function taskString(task: JsonRecord | undefined, key: string): string {
  const value = task?.[key];
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' ? value : '';
}

function readState(path: string): WorkflowState {
  return JSON.parse(readFileSync(path, 'utf-8')) as WorkflowState;
}

function formatPr(pr: string): string {
  if (!pr) return '(none)';
  return pr.startsWith('#') ? pr : `#${pr}`;
}

export async function abortTaskInState(
  stateFile: string,
  issue: string,
  reason: string,
  now: string = new Date().toISOString(),
): Promise<AbortTaskResult> {
  if (!issuePattern.test(issue)) {
    throw new Error(`invalid issue id '${issue}'`);
  }
  if (!existsSync(stateFile)) {
    throw new Error(`no active workflow state found at ${stateFile}`);
  }

  const state = readState(stateFile);
  const beforeTask = state.tasks?.[issue];
  if (!beforeTask) {
    throw new Error(`task ${issue} is not present in workflow state`);
  }

  const result: AbortTaskResult = {
    issue,
    reason,
    before: {
      phase: taskString(beforeTask, 'phase') || '(empty)',
      status: taskString(beforeTask, 'status') || '(empty)',
      pr: taskString(beforeTask, 'pr'),
    },
    after: {
      phase: 'aborted',
      status: 'aborted',
      abortedReason: reason,
      challengeAborted: OPERATOR_ABORT_MARKER,
    },
  };

  await mutateJsonState<WorkflowState>(stateFile, (current) => {
    const task = current.tasks?.[issue];
    if (!task) {
      throw new Error(`task ${issue} disappeared from workflow state`);
    }
    task.phase = 'aborted';
    task.status = 'aborted';
    task.abortedReason = reason;
    // The mill's arm cleanup gate reads challengeAborted, not abortedReason.
    // Without a non-empty value here the window, worktree and branch are never
    // reaped, so an aborted arm lingers indefinitely.
    task.challengeAborted = OPERATOR_ABORT_MARKER;
    task.challengeAbortedDetail = reason;
    task.abortedAt = now;
    task.updated = now;
    return current;
  });

  return result;
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
