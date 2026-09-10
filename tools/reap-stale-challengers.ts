#!/usr/bin/env -S npx tsx

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  copyFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutateJsonState } from '../shared/lib/state-mutex.ts';
import { runTool, resolveRepoDir, type ParsedArgs } from '../shared/lib/tool-runner.ts';
import { hasPendingArms } from '../shared/lib/pending-arm-detection.ts';

type JsonRecord = Record<string, unknown>;

interface WorkflowState {
  tasks?: Record<string, JsonRecord>;
  [key: string]: unknown;
}

interface WorktreeRecord {
  path: string;
  branch?: string;
}

export interface ReapCandidate {
  id: string;
  issue?: string;
  slug?: string;
  branch?: string;
  worktree?: string;
  stateTask?: JsonRecord;
}

export interface ReapDecision {
  candidate: ReapCandidate;
  action: 'would-remove' | 'removed' | 'skipped';
  reasons: string[];
}

export interface ReaperDeps {
  git(args: string[], cwd: string): string;
  gh(args: string[], cwd: string): string;
  now(): string;
}

const defaultDeps: ReaperDeps = {
  git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' });
  },
  gh(args, cwd) {
    return execFileSync('gh', args, { cwd, encoding: 'utf-8' });
  },
  now() {
    return new Date().toISOString();
  },
};

const options = {
  'repo-dir': { type: 'string', description: 'Repository directory to reap' },
  'state-file': { type: 'string', description: 'Workflow state file path' },
  force: { type: 'boolean', description: 'Remove eligible stale challenger resources' },
  'dry-run': { type: 'boolean', description: 'Report actions without removing anything' },
  json: { type: 'boolean', description: 'Print decisions as JSON' },
} as const;

type CliArgs = ParsedArgs<typeof options>;

function statePath(repoDir: string, explicit?: string): string {
  return explicit ? (isAbsolute(explicit) ? explicit : resolve(repoDir, explicit)) : join(repoDir, '.wavemill', 'workflow-state.json');
}

function readState(path: string): WorkflowState {
  if (!existsSync(path)) return { tasks: {} };
  return JSON.parse(readFileSync(path, 'utf-8')) as WorkflowState;
}

function parseWorktrees(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { path: line.slice('worktree '.length) };
    } else if (current && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }
  if (current) records.push(current);
  return records;
}

function branchSlug(branch: string | undefined): string | undefined {
  if (!branch?.startsWith('task/')) return undefined;
  return branch.slice('task/'.length);
}

function isChallengerBranch(branch: string | undefined): boolean {
  return Boolean(branch?.startsWith('task/') && branch.endsWith('-challenger'));
}

function isChallengerWorktree(path: string | undefined): boolean {
  return Boolean(path && basename(path).endsWith('-challenger'));
}

function taskString(task: JsonRecord | undefined, key: string): string {
  const value = task?.[key];
  return typeof value === 'string' ? value : '';
}

function findMatchingTask(
  tasks: Record<string, JsonRecord>,
  branch: string | undefined,
  worktree: string | undefined,
  slug: string | undefined,
): [string | undefined, JsonRecord | undefined] {
  for (const [issue, task] of Object.entries(tasks)) {
    if (branch && taskString(task, 'branch') === branch) return [issue, task];
    if (worktree && taskString(task, 'worktree') === worktree) return [issue, task];
    if (slug && taskString(task, 'slug') === slug) return [issue, task];
  }
  return [undefined, undefined];
}

export function discoverStaleChallengerCandidates(repoDir: string, state: WorkflowState, deps: ReaperDeps = defaultDeps): ReapCandidate[] {
  const tasks = state.tasks ?? {};
  const byId = new Map<string, ReapCandidate>();
  const put = (candidate: ReapCandidate) => {
    const id = candidate.branch ?? candidate.worktree ?? candidate.issue;
    if (!id) return;
    const existing = byId.get(id);
    byId.set(id, { ...existing, ...candidate, id });
  };

  let worktrees: WorktreeRecord[] = [];
  try {
    worktrees = parseWorktrees(deps.git(['worktree', 'list', '--porcelain'], repoDir));
  } catch {
    worktrees = [];
  }

  for (const worktree of worktrees) {
    if (!isChallengerBranch(worktree.branch) && !isChallengerWorktree(worktree.path)) continue;
    const slug = branchSlug(worktree.branch) ?? basename(worktree.path);
    const [issue, task] = findMatchingTask(tasks, worktree.branch, worktree.path, slug);
    put({ id: worktree.branch ?? worktree.path, issue, slug, branch: worktree.branch, worktree: worktree.path, stateTask: task });
  }

  let branches: string[] = [];
  try {
    branches = deps.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/task'], repoDir)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    branches = [];
  }

  for (const branch of branches.filter(isChallengerBranch)) {
    const slug = branchSlug(branch);
    const [issue, task] = findMatchingTask(tasks, branch, undefined, slug);
    put({ id: branch, issue, slug, branch, worktree: taskString(task, 'worktree') || undefined, stateTask: task });
  }

  for (const [issue, task] of Object.entries(tasks)) {
    const role = taskString(task, 'challengeRole');
    const branch = taskString(task, 'branch') || undefined;
    const worktree = taskString(task, 'worktree') || undefined;
    const slug = taskString(task, 'slug') || branchSlug(branch);
    const challengeAborted = taskString(task, 'challengeAborted');
    const pr = taskString(task, 'pr');
    if (role !== 'challenger' && !challengeAborted && !isChallengerBranch(branch) && !isChallengerWorktree(worktree)) continue;
    if (pr) continue;
    if (!isChallengerBranch(branch) && !isChallengerWorktree(worktree) && !slug?.endsWith('-challenger')) continue;

    // HOK-2813_c: If the primary has pending arms (awaiting_fork), do not
    // mark the challenger as stale. It hasn't materialized yet.
    if (role === 'challenger' && issue.endsWith('_c')) {
      const primaryIssue = issue.slice(0, -2);
      const primaryTask = tasks[primaryIssue];
      if (primaryTask && hasPendingArms(primaryTask)) continue;
    }

    put({ id: branch ?? worktree ?? issue, issue, slug, branch, worktree, stateTask: task });
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function worktreeDirty(candidate: ReapCandidate, repoDir: string, deps: ReaperDeps): boolean {
  if (!candidate.worktree || !existsSync(candidate.worktree)) return false;
  const status = deps.git(['-C', candidate.worktree, 'status', '--porcelain'], repoDir);
  return status.trim().length > 0;
}

function hasOpenPr(candidate: ReapCandidate, repoDir: string, deps: ReaperDeps): boolean | 'unknown' {
  if (!candidate.branch) return false;
  try {
    const output = deps.gh(['pr', 'list', '--head', candidate.branch, '--state', 'open', '--json', 'number'], repoDir);
    const parsed = JSON.parse(output) as unknown;
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return 'unknown';
  }
}

function listFilesRecursive(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...listFilesRecursive(path));
    else if (stat.isFile()) out.push(path);
  }
  return out;
}

function copyIfPresent(source: string, dest: string): void {
  if (!existsSync(source)) return;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(source, dest);
}

function archiveArtifacts(repoDir: string, candidate: ReapCandidate): void {
  if (!candidate.issue || !candidate.slug || !candidate.worktree || !existsSync(candidate.worktree)) return;
  const archiveDir = join(repoDir, '.wavemill', 'evals', 'artifacts', candidate.issue);
  const featureRoots = ['features', 'bugs']
    .map((prefix) => join(candidate.worktree!, prefix, candidate.slug!))
    .filter(existsSync);
  const featureDir = featureRoots[0];
  if (!featureDir) return;

  mkdirSync(archiveDir, { recursive: true });
  for (const name of [
    'plan.md',
    'task-packet.md',
    'task-packet-header.md',
    'task-packet-details.md',
    '.challenge-aborted.json',
    '.coding-failure-handoff.json',
    'trace.jsonl',
    'routing.jsonl',
  ]) {
    copyIfPresent(join(featureDir, name), join(archiveDir, name));
  }

  for (const file of listFilesRecursive(featureDir)) {
    if (!file.includes(`${featureDir}/.stale-artifacts/`)) continue;
    if (!file.endsWith('.jsonl') && basename(file) !== '.challenge-aborted.json' && basename(file) !== '.coding-failure-handoff.json') continue;
    copyIfPresent(file, join(archiveDir, 'stale-artifacts', relative(join(featureDir, '.stale-artifacts'), file)));
  }
}

async function markStateAborted(stateFile: string, candidate: ReapCandidate, reason: string, now: string): Promise<void> {
  if (!candidate.issue || !existsSync(stateFile)) return;
  await mutateJsonState<WorkflowState>(stateFile, (state) => {
    const task = state.tasks?.[candidate.issue!];
    if (!task) return state;
    task.status = 'aborted';
    task.phase = 'aborted';
    task.abortedCleanupReason = reason;
    task.abortedCleanupAt = now;
    task.updated = now;
    return state;
  });
}

async function removeStateTask(stateFile: string, candidate: ReapCandidate): Promise<void> {
  if (!candidate.issue || !existsSync(stateFile)) return;
  await mutateJsonState<WorkflowState>(stateFile, (state) => {
    if (state.tasks) {
      delete state.tasks[candidate.issue!];
    }
    return state;
  });
}

export async function reapStaleChallengers(
  repoDir: string,
  stateFile: string,
  force: boolean,
  deps: ReaperDeps = defaultDeps,
): Promise<ReapDecision[]> {
  const state = readState(stateFile);
  const candidates = discoverStaleChallengerCandidates(repoDir, state, deps);
  const decisions: ReapDecision[] = [];

  for (const candidate of candidates) {
    const reasons: string[] = [];
    if (candidate.branch && !isChallengerBranch(candidate.branch)) reasons.push(`non-challenger branch ${candidate.branch}`);
    if (candidate.stateTask && taskString(candidate.stateTask, 'pr')) reasons.push('state has PR');

    if (reasons.length === 0 && worktreeDirty(candidate, repoDir, deps)) reasons.push('dirty worktree');
    const openPr = reasons.length === 0 ? hasOpenPr(candidate, repoDir, deps) : false;
    if (openPr === true) reasons.push('open PR');
    if (openPr === 'unknown') reasons.push('open PR check unavailable');

    if (reasons.length > 0) {
      decisions.push({ candidate, action: 'skipped', reasons });
      continue;
    }

    if (!force) {
      decisions.push({ candidate, action: 'would-remove', reasons: ['dry-run'] });
      continue;
    }

    archiveArtifacts(repoDir, candidate);
    await markStateAborted(stateFile, candidate, 'stale challenger reaper', deps.now());
    if (candidate.worktree && existsSync(candidate.worktree)) {
      deps.git(['worktree', 'remove', '--force', candidate.worktree], repoDir);
    }
    if (candidate.branch) {
      deps.git(['branch', '-D', candidate.branch], repoDir);
    }
    await removeStateTask(stateFile, candidate);
    decisions.push({ candidate, action: 'removed', reasons: [] });
  }

  return decisions;
}

export async function runReapStaleChallengersCommand(args: CliArgs, deps: ReaperDeps = defaultDeps): Promise<ReapDecision[]> {
  const repoDir = resolveRepoDir(args['repo-dir']);
  const force = args.force === true;
  const decisions = await reapStaleChallengers(repoDir, statePath(repoDir, args['state-file']), force, deps);

  if (args.json === true) {
    console.log(JSON.stringify({ force, decisions }, null, 2));
    return decisions;
  }

  console.log('action\tissue\tbranch\tworktree\treason');
  for (const decision of decisions) {
    console.log([
      decision.action,
      decision.candidate.issue ?? '-',
      decision.candidate.branch ?? '-',
      decision.candidate.worktree ?? '-',
      decision.reasons.join('; ') || '-',
    ].join('\t'));
  }
  return decisions;
}

export async function runReapStaleChallengersCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  await runTool({
    name: 'reap-stale-challengers',
    description: 'Dry-run or remove stale quarantined challenger worktrees and local branches',
    options,
    examples: [
      'npx tsx tools/reap-stale-challengers.ts --dry-run',
      'npx tsx tools/reap-stale-challengers.ts --force',
    ],
    run: ({ args }) => runReapStaleChallengersCommand(args),
  }, argv);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  await runReapStaleChallengersCli();
}
