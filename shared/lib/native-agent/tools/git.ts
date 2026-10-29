import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildTrustMetadata } from '../provenance.ts';
import type { IntendedFileTracker } from './intended-files.ts';
import type { ToolPolicyConfig } from './policies.ts';
import type { ToolDescriptor, WavemillToolResult } from './types.ts';

const DEFAULT_DIFF_MAX_BYTES = 64 * 1024;
const MIN_DIFF_MAX_BYTES = 1;
const DEFAULT_LOG_MAX_COUNT = 20;
const MAX_LOG_MAX_COUNT = 100;

type GitToolName = 'git_status' | 'git_diff' | 'git_diff_stat' | 'git_log' | 'git_add' | 'git_commit';

export interface GitStatusParams {}

export interface GitDiffParams {
  base?: string;
  path?: string;
  maxBytes?: number;
}

export interface GitDiffStatParams {
  base?: string;
  path?: string;
}

export interface GitLogParams {
  maxCount?: number;
  path?: string;
}

export interface GitAddParams {
  paths: string[];
}

export interface GitCommitParams {
  message: string;
}

export interface GitFileStatus {
  path: string;
  indexStatus?: string;
  worktreeStatus?: string;
  originalPath?: string;
}

export interface GitBranchStatus {
  oid: string | null;
  head: string | null;
  upstream: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
}

export interface GitStatusSuccessDetails {
  ok: true;
  tool: 'git_status';
  repoRoot: string;
  branch: GitBranchStatus;
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  untracked: GitFileStatus[];
  unmerged: GitFileStatus[];
  ignored: GitFileStatus[];
  isClean: boolean;
}

export interface GitDiffSuccessDetails {
  ok: true;
  tool: 'git_diff';
  repoRoot: string;
  base: string | null;
  path: string | null;
  maxBytes: number;
  diff: string;
  originalBytes: number;
  retainedBytes: number;
  truncated: boolean;
}

export interface GitDiffStatFile {
  path: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface GitDiffStatSuccessDetails {
  ok: true;
  tool: 'git_diff_stat';
  repoRoot: string;
  base: string;
  path: string | null;
  files: GitDiffStatFile[];
  totals: {
    filesChanged: number;
    additions: number;
    deletions: number;
  };
}

export interface GitLogCommit {
  oid: string;
  author: string;
  email: string;
  date: string;
  subject: string;
}

export interface GitLogSuccessDetails {
  ok: true;
  tool: 'git_log';
  repoRoot: string;
  maxCount: number;
  path: string | null;
  commits: GitLogCommit[];
  truncated: boolean;
}

export interface GitAddSuccessDetails {
  ok: true;
  tool: 'git_add';
  repoRoot: string;
  paths: string[];
}

export interface GitCommitSuccessDetails {
  ok: true;
  tool: 'git_commit';
  repoRoot: string;
  oid: string;
  subject: string;
  files: string[];
  commitCount: number;
}

export interface GitToolErrorDetails {
  ok: false;
  tool: GitToolName;
  error: {
    code: 'invalid_input' | 'not_git_repository' | 'git_failed' | 'aborted' | 'out_of_scope' | 'not_intended' | 'empty_commit';
    message: string;
    stderr: string;
    exitCode: number | null;
    args: string[];
  };
}

export type GitStatusDetails = GitStatusSuccessDetails | GitToolErrorDetails;
export type GitDiffDetails = GitDiffSuccessDetails | GitToolErrorDetails;
export type GitDiffStatDetails = GitDiffStatSuccessDetails | GitToolErrorDetails;
export type GitLogDetails = GitLogSuccessDetails | GitToolErrorDetails;
export type GitAddDetails = GitAddSuccessDetails | GitToolErrorDetails;
export type GitCommitDetails = GitCommitSuccessDetails | GitToolErrorDetails;
type GitToolDetails = GitStatusDetails | GitDiffDetails | GitDiffStatDetails | GitLogDetails | GitAddDetails | GitCommitDetails;

interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface GitAfterToolCallContext {
  toolCall: { name: string };
  result: { details: unknown };
}

interface GitAfterToolCallResult {
  isError?: boolean;
}

interface ParsedBranchState {
  oid: string | null;
  head: string | null;
  upstream: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
}

const gitStatusParameters = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const gitDiffParameters = {
  type: 'object',
  properties: {
    base: { type: 'string' },
    path: { type: 'string' },
    maxBytes: { type: 'integer', minimum: MIN_DIFF_MAX_BYTES },
  },
  additionalProperties: false,
};

const gitDiffStatParameters = {
  type: 'object',
  properties: {
    base: { type: 'string' },
    path: { type: 'string' },
  },
  additionalProperties: false,
};

const gitLogParameters = {
  type: 'object',
  properties: {
    maxCount: { type: 'integer', minimum: 1, maximum: MAX_LOG_MAX_COUNT },
    path: { type: 'string' },
  },
  additionalProperties: false,
};

const gitAddParameters = {
  type: 'object',
  properties: {
    paths: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
    },
  },
  required: ['paths'],
  additionalProperties: false,
};

const gitCommitParameters = {
  type: 'object',
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
  additionalProperties: false,
};

export const gitToolPolicyConfig: ToolPolicyConfig = {
  pathFieldsByTool: { git_diff: ['path'], git_diff_stat: ['path'], git_log: ['path'] },
};

export const gitMutationToolPolicyConfig: ToolPolicyConfig = {
  pathFieldsByTool: { git_add: ['paths'] },
};

interface GitCommitToolOptions {
  tracker: IntendedFileTracker;
}

export function createGitTools(worktreePath: string): readonly ToolDescriptor[] {
  return [
    createGitStatusTool(worktreePath),
    createGitDiffTool(worktreePath),
    createGitDiffStatTool(worktreePath),
    createGitLogTool(worktreePath),
  ];
}

export function createGitCommitTools(
  worktreePath: string,
  options: GitCommitToolOptions,
): readonly ToolDescriptor[] {
  return [
    createGitAddTool(worktreePath, options),
    createGitCommitTool(worktreePath, options),
  ];
}

export function createGitStatusTool(worktreePath: string): ToolDescriptor<GitStatusParams, GitStatusDetails> {
  return {
    metadata: {
      name: 'git_status',
      description: 'Inspect the current git worktree status without modifying repository state.',
      class: 'read-only',
      allowedPhases: ['planning', 'coding', 'review'],
      executionMode: 'parallel',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: gitStatusParameters,
    async execute(_toolCallId, _params, signal) {
      return runGitStatus(worktreePath, signal);
    },
  };
}

export function createGitDiffTool(worktreePath: string): ToolDescriptor<GitDiffParams, GitDiffDetails> {
  return {
    metadata: {
      name: 'git_diff',
      description: 'Inspect the current git diff, optionally against a base ref or limited to a path.',
      class: 'read-only',
      allowedPhases: ['planning', 'coding', 'review'],
      executionMode: 'parallel',
      outputCapPolicy: { strategy: 'truncate', maxBytes: DEFAULT_DIFF_MAX_BYTES },
    },
    parameters: gitDiffParameters,
    async execute(_toolCallId, params, signal) {
      return runGitDiff(worktreePath, params, signal);
    },
  };
}

export function createGitDiffStatTool(
  worktreePath: string,
): ToolDescriptor<GitDiffStatParams, GitDiffStatDetails> {
  return {
    metadata: {
      name: 'git_diff_stat',
      description: 'Inspect structured diff statistics, optionally against a base ref or limited to a path.',
      class: 'read-only',
      allowedPhases: ['planning', 'coding', 'review'],
      executionMode: 'parallel',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: gitDiffStatParameters,
    async execute(_toolCallId, params, signal) {
      return runGitDiffStat(worktreePath, params, signal);
    },
  };
}

export function createGitLogTool(worktreePath: string): ToolDescriptor<GitLogParams, GitLogDetails> {
  return {
    metadata: {
      name: 'git_log',
      description: 'Inspect recent commit history for the current worktree, optionally limited to a path.',
      class: 'read-only',
      allowedPhases: ['planning', 'coding', 'review'],
      executionMode: 'parallel',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: gitLogParameters,
    async execute(_toolCallId, params, signal) {
      return runGitLog(worktreePath, params, signal);
    },
  };
}

export function createGitAddTool(
  worktreePath: string,
  options: GitCommitToolOptions,
): ToolDescriptor<GitAddParams, GitAddDetails> {
  return {
    metadata: {
      name: 'git_add',
      description: 'Stage intended files changed during native coding while enforcing worktree scope.',
      class: 'mutation',
      allowedPhases: ['coding'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: gitAddParameters,
    async execute(_toolCallId, params, signal) {
      return runGitAdd(worktreePath, params, options.tracker, signal);
    },
  };
}

export function createGitCommitTool(
  worktreePath: string,
  options: GitCommitToolOptions,
): ToolDescriptor<GitCommitParams, GitCommitDetails> {
  return {
    metadata: {
      name: 'git_commit',
      description: 'Commit staged intended files and return structured commit metadata.',
      class: 'mutation',
      allowedPhases: ['coding'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: gitCommitParameters,
    async execute(_toolCallId, params, signal) {
      return runGitCommit(worktreePath, params, options.tracker, signal);
    },
  };
}

export async function gitAfterToolCall(
  context: GitAfterToolCallContext,
): Promise<GitAfterToolCallResult | undefined> {
  if (
    context.toolCall.name !== 'git_status' &&
    context.toolCall.name !== 'git_diff' &&
    context.toolCall.name !== 'git_diff_stat' &&
    context.toolCall.name !== 'git_log'
  ) {
    return undefined;
  }
  const details = context.result.details as GitToolDetails | undefined;
  if (!details || typeof details !== 'object' || !('ok' in details)) {
    return undefined;
  }
  if (details.ok) {
    return undefined;
  }
  return { isError: true };
}

export async function gitMutationAfterToolCall(
  context: GitAfterToolCallContext,
): Promise<GitAfterToolCallResult | undefined> {
  if (context.toolCall.name !== 'git_add' && context.toolCall.name !== 'git_commit') {
    return undefined;
  }
  const details = context.result.details as GitToolDetails | undefined;
  if (!details || typeof details !== 'object' || !('ok' in details)) {
    return undefined;
  }
  return details.ok ? undefined : { isError: true };
}

async function runGitStatus(
  worktreePath: string,
  signal?: AbortSignal,
): Promise<WavemillToolResult<GitStatusDetails>> {
  const repoRoot = await resolveRepoRoot(worktreePath, 'git_status', signal);
  if (!repoRoot.ok) {
    return repoRoot.result;
  }

  const status = await runGit(repoRoot.repoRoot, ['status', '--porcelain=v2', '--branch', '-z'], signal);
  if (!status.ok) {
    return errorResult('git_status', ['status', '--porcelain=v2', '--branch', '-z'], status);
  }

  const details = parseGitStatusOutput(repoRoot.repoRoot, status.stdout);
  return {
    content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
    details,
    metadata: { trust: buildTrustMetadata({ sourceKind: 'diff', details }) },
  };
}

async function runGitDiff(
  worktreePath: string,
  params: GitDiffParams,
  signal?: AbortSignal,
): Promise<WavemillToolResult<GitDiffDetails>> {
  const base = sanitizeRevision('git_diff', params.base);
  if (!base.ok) {
    return base.result;
  }
  if (params.maxBytes !== undefined && (!Number.isInteger(params.maxBytes) || params.maxBytes < MIN_DIFF_MAX_BYTES)) {
    return invalidInputResult('git_diff', `maxBytes must be an integer >= ${MIN_DIFF_MAX_BYTES}`);
  }
  const sanitizedPath = sanitizePath('git_diff', params.path);
  if (!sanitizedPath.ok) {
    return sanitizedPath.result;
  }

  const repoRoot = await resolveRepoRoot(worktreePath, 'git_diff', signal);
  if (!repoRoot.ok) {
    return repoRoot.result;
  }

  const maxBytes = params.maxBytes ?? DEFAULT_DIFF_MAX_BYTES;
  const gitArgs = ['diff', '--no-ext-diff', '--no-color'];
  const compareBase = base.value ?? 'HEAD';
  gitArgs.push(compareBase);

  const scopedPath = normalizeGitPath(repoRoot.repoRoot, sanitizedPath.value);
  if (scopedPath !== undefined) {
    gitArgs.push('--', scopedPath);
  }

  const diff = await runGit(repoRoot.repoRoot, gitArgs, signal);
  if (!diff.ok) {
    return errorResult('git_diff', gitArgs, diff);
  }

  const originalBytes = Buffer.byteLength(diff.stdout, 'utf8');
  const retainedDiff = truncateUtf8(diff.stdout, maxBytes);
  const retainedBytes = Buffer.byteLength(retainedDiff, 'utf8');
  const details: GitDiffSuccessDetails = {
    ok: true,
    tool: 'git_diff',
    repoRoot: repoRoot.repoRoot,
    base: compareBase,
    path: scopedPath ?? null,
    maxBytes,
    diff: retainedDiff,
    originalBytes,
    retainedBytes,
    truncated: originalBytes > retainedBytes,
  };

  return {
    content: [{ type: 'text', text: retainedDiff }],
    details,
    metadata: {
      trust: buildTrustMetadata({
        sourceKind: 'diff',
        content: [{ type: 'text', text: retainedDiff }],
        details,
      }),
    },
  };
}

/** Count a patch's pre/post images through the same Git numstat authority as git_diff_stat. */
export async function countGitTextChanges(
  originalText: string,
  updatedText: string,
): Promise<{ linesAdded: number; linesRemoved: number }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'wavemill-patch-stat-'));
  try {
    const before = path.join(dir, 'before');
    const after = path.join(dir, 'after');
    await Promise.all([writeFile(before, originalText), writeFile(after, updatedText)]);
    const result = await runGit(dir, [
      'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color',
      '--no-renames', '--text', '--numstat', '--', before, after,
    ]);
    // Git diff --no-index exits 1 when differences exist, rather than on an error.
    if (!result.ok && result.exitCode !== 1) {
      throw new Error(`Cannot count patch changes: ${result.stderr}`);
    }
    const files = parseGitDiffStatOutput(result.stdout ?? '');
    return {
      linesAdded: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      linesRemoved: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runGitDiffStat(
  worktreePath: string,
  params: GitDiffStatParams,
  signal?: AbortSignal,
): Promise<WavemillToolResult<GitDiffStatDetails>> {
  const base = sanitizeRevision('git_diff_stat', params.base);
  if (!base.ok) {
    return base.result;
  }
  const sanitizedPath = sanitizePath('git_diff_stat', params.path);
  if (!sanitizedPath.ok) {
    return sanitizedPath.result;
  }

  const repoRoot = await resolveRepoRoot(worktreePath, 'git_diff_stat', signal);
  if (!repoRoot.ok) {
    return repoRoot.result;
  }

  const compareBase = base.value ?? 'HEAD';
  const gitArgs = ['diff', '--no-ext-diff', '--no-color', '--numstat', compareBase];
  const scopedPath = normalizeGitPath(repoRoot.repoRoot, sanitizedPath.value);
  if (scopedPath !== undefined) {
    gitArgs.push('--', scopedPath);
  }

  const diffStat = await runGit(repoRoot.repoRoot, gitArgs, signal);
  if (!diffStat.ok) {
    return errorResult('git_diff_stat', gitArgs, diffStat);
  }

  const files = parseGitDiffStatOutput(diffStat.stdout);
  const totals = files.reduce(
    (acc, file) => ({
      filesChanged: acc.filesChanged + 1,
      additions: acc.additions + (file.additions ?? 0),
      deletions: acc.deletions + (file.deletions ?? 0),
    }),
    { filesChanged: 0, additions: 0, deletions: 0 },
  );
  const details: GitDiffStatSuccessDetails = {
    ok: true,
    tool: 'git_diff_stat',
    repoRoot: repoRoot.repoRoot,
    base: compareBase,
    path: scopedPath ?? null,
    files,
    totals,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
    details,
    metadata: { trust: buildTrustMetadata({ sourceKind: 'diff', details }) },
  };
}

async function runGitLog(
  worktreePath: string,
  params: GitLogParams,
  signal?: AbortSignal,
): Promise<WavemillToolResult<GitLogDetails>> {
  if (params.maxCount !== undefined && (!Number.isInteger(params.maxCount) || params.maxCount < 1)) {
    return invalidInputResult('git_log', 'maxCount must be an integer >= 1');
  }
  if (params.maxCount !== undefined && params.maxCount > MAX_LOG_MAX_COUNT) {
    return invalidInputResult('git_log', `maxCount must be <= ${MAX_LOG_MAX_COUNT}`);
  }
  const sanitizedPath = sanitizePath('git_log', params.path);
  if (!sanitizedPath.ok) {
    return sanitizedPath.result;
  }

  const repoRoot = await resolveRepoRoot(worktreePath, 'git_log', signal);
  if (!repoRoot.ok) {
    return repoRoot.result;
  }

  const maxCount = params.maxCount ?? DEFAULT_LOG_MAX_COUNT;
  const scopedPath = normalizeGitPath(repoRoot.repoRoot, sanitizedPath.value);
  const gitArgs = [
    'log',
    '--no-color',
    `--max-count=${maxCount + 1}`,
    '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e',
  ];
  if (scopedPath !== undefined) {
    gitArgs.push('--', scopedPath);
  }

  const logResult = await runGit(repoRoot.repoRoot, gitArgs, signal);
  if (!logResult.ok) {
    return errorResult('git_log', gitArgs, logResult);
  }

  const commits = parseGitLogOutput(logResult.stdout);
  const details: GitLogSuccessDetails = {
    ok: true,
    tool: 'git_log',
    repoRoot: repoRoot.repoRoot,
    maxCount,
    path: scopedPath ?? null,
    commits: commits.slice(0, maxCount),
    truncated: commits.length > maxCount,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
    details,
    metadata: { trust: buildTrustMetadata({ sourceKind: 'diff', details }) },
  };
}

async function runGitAdd(
  worktreePath: string,
  params: GitAddParams,
  tracker: IntendedFileTracker,
  signal?: AbortSignal,
): Promise<WavemillToolResult<GitAddDetails>> {
  if (!Array.isArray(params.paths) || params.paths.length === 0) {
    return invalidInputResult('git_add', 'paths must be a non-empty array of strings');
  }

  const repoRoot = await resolveRepoRoot(worktreePath, 'git_add', signal);
  if (!repoRoot.ok) {
    return repoRoot.result;
  }

  const normalizedPaths: string[] = [];
  for (const candidate of params.paths) {
    const resolved = resolveMutationPath(repoRoot.repoRoot, 'git_add', candidate);
    if (!resolved.ok) {
      return resolved.result;
    }
    if (!tracker.isIntended(resolved.path)) {
      return scopedErrorResult('git_add', 'not_intended', `git_add can only stage intended files; '${resolved.path}' was not recorded as intended.`);
    }
    if (!normalizedPaths.includes(resolved.path)) {
      normalizedPaths.push(resolved.path);
    }
  }

  const gitArgs = ['add', '--', ...normalizedPaths];
  const addResult = await runGit(repoRoot.repoRoot, gitArgs, signal);
  if (!addResult.ok) {
    return errorResult('git_add', gitArgs, addResult);
  }

  const details: GitAddSuccessDetails = {
    ok: true,
    tool: 'git_add',
    repoRoot: repoRoot.repoRoot,
    paths: normalizedPaths,
  };

  return {
    content: [{ type: 'text', text: `Staged ${normalizedPaths.join(', ')}` }],
    details,
  };
}

async function runGitCommit(
  worktreePath: string,
  params: GitCommitParams,
  tracker: IntendedFileTracker,
  signal?: AbortSignal,
): Promise<WavemillToolResult<GitCommitDetails>> {
  if (typeof params.message !== 'string' || params.message.trim() === '') {
    return invalidInputResult('git_commit', 'message must be a non-empty string');
  }

  const repoRoot = await resolveRepoRoot(worktreePath, 'git_commit', signal);
  if (!repoRoot.ok) {
    return repoRoot.result;
  }

  const stagedResult = await runGit(repoRoot.repoRoot, ['diff', '--cached', '--name-only', '-z'], signal);
  if (!stagedResult.ok) {
    return errorResult('git_commit', ['diff', '--cached', '--name-only', '-z'], stagedResult);
  }

  const stagedFiles = parseNullDelimitedLines(stagedResult.stdout);
  if (stagedFiles.length === 0) {
    return scopedErrorResult('git_commit', 'empty_commit', 'git_commit requires staged changes.');
  }

  const unintendedFile = stagedFiles.find((candidate) => !tracker.isIntended(candidate));
  if (unintendedFile) {
    return scopedErrorResult(
      'git_commit',
      'out_of_scope',
      `git_commit can only commit intended files; '${unintendedFile}' is staged but not intended.`,
    );
  }

  const commitArgs = ['commit', '-m', params.message.trim()];
  const commitResult = await runGit(repoRoot.repoRoot, commitArgs, signal);
  if (!commitResult.ok) {
    return errorResult('git_commit', commitArgs, commitResult);
  }

  const oidResult = await runGit(repoRoot.repoRoot, ['rev-parse', 'HEAD'], signal);
  if (!oidResult.ok) {
    return errorResult('git_commit', ['rev-parse', 'HEAD'], oidResult);
  }

  const details: GitCommitSuccessDetails = {
    ok: true,
    tool: 'git_commit',
    repoRoot: repoRoot.repoRoot,
    oid: oidResult.stdout.trim(),
    subject: params.message.trim().split(/\r?\n/u, 1)[0] ?? '',
    files: stagedFiles,
    commitCount: tracker.recordCommit(),
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
    details,
  };
}

async function resolveRepoRoot(
  worktreePath: string,
  tool: GitToolName,
  signal?: AbortSignal,
): Promise<
  | { ok: true; repoRoot: string }
  | { ok: false; result: WavemillToolResult<GitToolErrorDetails> }
> {
  const args = ['rev-parse', '--show-toplevel'];
  const probe = await runGit(worktreePath, args, signal);
  if (!probe.ok) {
    return { ok: false, result: errorResult(tool, args, probe) };
  }
  return { ok: true, repoRoot: probe.stdout.trim() };
}

async function runGit(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<
  | ({ ok: true } & GitCommandResult)
  | ({ ok: false; code: GitToolErrorDetails['error']['code'] } & Partial<GitCommandResult>)
> {
  const subcommand = args[0];
  if (
    subcommand !== 'rev-parse' &&
    subcommand !== 'status' &&
    subcommand !== 'diff' &&
    subcommand !== 'log' &&
    subcommand !== 'add' &&
    subcommand !== 'commit'
  ) {
    return {
      ok: false,
      code: 'invalid_input',
      stderr: `git subcommand "${subcommand}" is not allowed`,
      exitCode: null,
    };
  }

  try {
    const result = await spawnGit(cwd, args, signal);
    return { ok: true, ...result };
  } catch (error) {
    if (isAbortError(error)) {
      return { ok: false, code: 'aborted', stderr: 'git command aborted', exitCode: null };
    }
    const err = error as NodeJS.ErrnoException & Partial<GitCommandResult>;
    const stderr = typeof err.stderr === 'string' ? err.stderr : err.message;
    const exitCode = typeof err.exitCode === 'number' ? err.exitCode : 1;
    return {
      ok: false,
      code: /not a git repository/i.test(stderr) ? 'not_git_repository' : 'git_failed',
      stderr,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      exitCode,
    };
  }
}

async function spawnGit(cwd: string, args: string[], signal?: AbortSignal): Promise<GitCommandResult> {
  return await new Promise<GitCommandResult>((resolve, reject) => {
    const child = spawn('git', ['--no-pager', ...args], {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (code === 0) {
        resolve({ stdout, stderr, exitCode: 0 });
        return;
      }
      const error = new Error(stderr || `git ${args[0]} failed with exit code ${code}`) as Error &
        NodeJS.ErrnoException &
        Partial<GitCommandResult>;
      error.stdout = stdout;
      error.stderr = stderr;
      error.exitCode = code ?? 1;
      reject(error);
    });
  });
}

function parseGitStatusOutput(repoRoot: string, output: string): GitStatusSuccessDetails {
  const tokens = output.split('\0').filter((token) => token.length > 0);
  const branch: ParsedBranchState = {
    oid: null,
    head: null,
    upstream: null,
    detached: false,
    ahead: 0,
    behind: 0,
  };
  const staged: GitFileStatus[] = [];
  const unstaged: GitFileStatus[] = [];
  const untracked: GitFileStatus[] = [];
  const unmerged: GitFileStatus[] = [];
  const ignored: GitFileStatus[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.startsWith('# ')) {
      parseBranchToken(branch, token.slice(2));
      continue;
    }
    if (token.startsWith('? ')) {
      untracked.push({ path: token.slice(2) });
      continue;
    }
    if (token.startsWith('! ')) {
      ignored.push({ path: token.slice(2) });
      continue;
    }
    if (token.startsWith('1 ')) {
      const entry = parseTrackedEntry(token);
      if (entry.indexStatus && entry.indexStatus !== '.') staged.push(entry);
      if (entry.worktreeStatus && entry.worktreeStatus !== '.') unstaged.push(entry);
      continue;
    }
    if (token.startsWith('2 ')) {
      const entry = parseRenamedEntry(token, tokens[index + 1] ?? '');
      index += 1;
      if (entry.indexStatus && entry.indexStatus !== '.') staged.push(entry);
      if (entry.worktreeStatus && entry.worktreeStatus !== '.') unstaged.push(entry);
      continue;
    }
    if (token.startsWith('u ')) {
      unmerged.push(parseUnmergedEntry(token));
    }
  }

  return {
    ok: true,
    tool: 'git_status',
    repoRoot,
    branch,
    staged,
    unstaged,
    untracked,
    unmerged,
    ignored,
    isClean:
      staged.length === 0 &&
      unstaged.length === 0 &&
      untracked.length === 0 &&
      unmerged.length === 0,
  };
}

function parseGitDiffStatOutput(output: string): GitDiffStatFile[] {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .map((line) => {
      const [additionsField = '', deletionsField = '', ...pathParts] = line.split('\t');
      const binary = additionsField === '-' && deletionsField === '-';
      return {
        path: pathParts.join('\t'),
        additions: binary ? null : Number.parseInt(additionsField, 10),
        deletions: binary ? null : Number.parseInt(deletionsField, 10),
        binary,
      };
    });
}

function parseGitLogOutput(output: string): GitLogCommit[] {
  return output
    .split('\x1e')
    .map((record) => record.trim())
    .filter((record) => record !== '')
    .map((record) => {
      const [oid = '', author = '', email = '', date = '', subject = ''] = record.split('\x1f');
      return { oid, author, email, date, subject };
    });
}

function parseNullDelimitedLines(output: string): string[] {
  return output.split('\0').map((item) => item.trim()).filter((item) => item !== '');
}

function parseBranchToken(branch: ParsedBranchState, token: string): void {
  if (token.startsWith('branch.oid ')) {
    const oid = token.slice('branch.oid '.length);
    branch.oid = oid === '(initial)' ? null : oid;
    return;
  }
  if (token.startsWith('branch.head ')) {
    const head = token.slice('branch.head '.length);
    branch.detached = head === '(detached)';
    branch.head = branch.detached ? null : head;
    return;
  }
  if (token.startsWith('branch.upstream ')) {
    branch.upstream = token.slice('branch.upstream '.length);
    return;
  }
  if (token.startsWith('branch.ab ')) {
    const match = /^branch\.ab \+(\d+) -(\d+)$/.exec(token);
    if (match) {
      branch.ahead = Number.parseInt(match[1]!, 10);
      branch.behind = Number.parseInt(match[2]!, 10);
    }
  }
}

function parseTrackedEntry(token: string): GitFileStatus {
  const parts = token.split(' ');
  return {
    path: parts.slice(8).join(' '),
    indexStatus: parts[1]?.[0],
    worktreeStatus: parts[1]?.[1],
  };
}

function parseRenamedEntry(token: string, originalPath: string): GitFileStatus {
  const parts = token.split(' ');
  return {
    path: parts.slice(9).join(' '),
    originalPath,
    indexStatus: parts[1]?.[0],
    worktreeStatus: parts[1]?.[1],
  };
}

function parseUnmergedEntry(token: string): GitFileStatus {
  const parts = token.split(' ');
  return {
    path: parts.slice(10).join(' '),
    indexStatus: parts[1]?.[0],
    worktreeStatus: parts[1]?.[1],
  };
}

function errorResult(
  tool: GitToolName,
  args: string[],
  result: { code: GitToolErrorDetails['error']['code']; stderr?: string; exitCode?: number | null },
): WavemillToolResult<GitToolErrorDetails> {
  const message = formatErrorMessage(tool, result.code, result.stderr ?? '');
  return {
    content: [{ type: 'text', text: message }],
    details: {
      ok: false,
      tool,
      error: {
        code: result.code,
        message,
        stderr: result.stderr ?? '',
        exitCode: result.exitCode ?? null,
        args,
      },
    },
  };
}

function invalidInputResult(
  tool: GitToolName,
  message: string,
): WavemillToolResult<GitToolErrorDetails> {
  return {
    content: [{ type: 'text', text: message }],
    details: {
      ok: false,
      tool,
      error: {
        code: 'invalid_input',
        message,
        stderr: '',
        exitCode: null,
        args: [],
      },
    },
  };
}

function scopedErrorResult(
  tool: GitToolName,
  code: Extract<GitToolErrorDetails['error']['code'], 'out_of_scope' | 'not_intended' | 'empty_commit'>,
  message: string,
): WavemillToolResult<GitToolErrorDetails> {
  return {
    content: [{ type: 'text', text: message }],
    details: {
      ok: false,
      tool,
      error: {
        code,
        message,
        stderr: '',
        exitCode: null,
        args: [],
      },
    },
  };
}

function formatErrorMessage(
  tool: GitToolName,
  code: GitToolErrorDetails['error']['code'],
  stderr: string,
): string {
  if (code === 'not_git_repository') {
    return stderr || `${tool} requires a git repository`;
  }
  if (code === 'aborted') {
    return `${tool} aborted`;
  }
  if (stderr !== '') {
    return stderr;
  }
  return `${tool} failed`;
}

function normalizeGitPath(repoRoot: string, toolPath: string | undefined): string | undefined {
  if (toolPath === undefined) {
    return undefined;
  }
  const comparable = toolPath.replace(/\\/g, '/');
  const absolute = path.resolve(repoRoot, comparable);
  const relative = path.relative(repoRoot, absolute).replace(/\\/g, '/');
  return relative === '' ? '.' : relative;
}

function resolveMutationPath(
  repoRoot: string,
  tool: 'git_add',
  toolPath: unknown,
):
  | { ok: true; path: string }
  | { ok: false; result: WavemillToolResult<GitToolErrorDetails> } {
  if (typeof toolPath !== 'string' || toolPath.trim() === '') {
    return { ok: false, result: invalidInputResult(tool, 'paths must contain only non-empty strings') };
  }
  if (toolPath.includes('\0')) {
    return { ok: false, result: invalidInputResult(tool, 'paths must not contain NUL bytes') };
  }
  if (toolPath.startsWith('-')) {
    return { ok: false, result: invalidInputResult(tool, 'paths must not start with "-"') };
  }

  const normalized = normalizeGitPath(repoRoot, toolPath);
  if (normalized === undefined || normalized === '.') {
    return { ok: false, result: invalidInputResult(tool, 'paths must reference files inside the repository') };
  }
  if (normalized.startsWith('../') || normalized === '..') {
    return {
      ok: false,
      result: scopedErrorResult(tool, 'out_of_scope', `'${toolPath}' resolves outside the active worktree.`),
    };
  }

  return { ok: true, path: normalized };
}

const FORBIDDEN_REVISION_CHARS = /[;&|<>\\$(){}*?"'\[\]!#`]/;
const REVISION_RANGE_SYNTAX = /\.\.\.?/;

function sanitizeRevision(
  tool: 'git_diff' | 'git_diff_stat',
  revision: string | undefined,
):
  | { ok: true; value: string | undefined }
  | { ok: false; result: WavemillToolResult<GitToolErrorDetails> } {
  if (revision === undefined) {
    return { ok: true, value: undefined };
  }
  const trimmed = revision.trim();
  if (trimmed === '') {
    return { ok: false, result: invalidInputResult(tool, 'base must be a non-empty string') };
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { ok: false, result: invalidInputResult(tool, 'base contains control characters') };
  }
  if (trimmed.startsWith('-')) {
    return { ok: false, result: invalidInputResult(tool, 'base must not start with "-"') };
  }
  if (/\s/.test(trimmed)) {
    return { ok: false, result: invalidInputResult(tool, 'base must not contain whitespace') };
  }
  if (REVISION_RANGE_SYNTAX.test(trimmed)) {
    return { ok: false, result: invalidInputResult(tool, 'base must not contain ".." or "..." range syntax') };
  }
  if (FORBIDDEN_REVISION_CHARS.test(trimmed)) {
    return { ok: false, result: invalidInputResult(tool, 'base contains forbidden shell metacharacters') };
  }
  return { ok: true, value: trimmed };
}

function sanitizePath(
  tool: 'git_diff' | 'git_diff_stat' | 'git_log',
  toolPath: string | undefined,
):
  | { ok: true; value: string | undefined }
  | { ok: false; result: WavemillToolResult<GitToolErrorDetails> } {
  if (toolPath === undefined) {
    return { ok: true, value: undefined };
  }
  if (toolPath.includes('\0')) {
    return { ok: false, result: invalidInputResult(tool, 'path contains NUL bytes') };
  }
  if (toolPath.startsWith('-')) {
    return { ok: false, result: invalidInputResult(tool, 'path must not start with "-"') };
  }
  return { ok: true, value: toolPath };
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return text.slice(0, low);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message));
}
