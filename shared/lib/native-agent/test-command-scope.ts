/**
 * Classify an exec argv as a full-suite run (`npm test`, `pnpm test`,
 * `yarn test` with or without extra args, and `bash tests/run-*.sh` without a
 * shard) or a focused command, and expand a package.json `scripts` entry so
 * the tool result tells the agent what a composite `test` chain actually runs
 * (HOK-3145).
 *
 * The classifier is purely syntactic; no process spawn. Walks `cwd` → the
 * worktree root to find the nearest `package.json` for expansion. Missing or
 * invalid package.json yields a null body without throwing — the full-suite
 * refusal still fires by name.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type { ParsedCommand } from './command-argv.ts';

export type PackageManager = 'npm' | 'pnpm' | 'yarn';

export interface ScriptExpansion {
  manager: PackageManager;
  script: string;
  body: string | null;
  packageJsonPath: string | null;
  chainedScripts: string[];
  extraArgs: string[];
  extraArgsNote?: string;
}

export interface TestCommandScope {
  scope: 'full-suite' | 'focused';
  reason?: 'package-test-script' | 'repo-suite-runner';
  expansion?: ScriptExpansion;
}

export interface PackageScriptInvocation {
  manager: PackageManager;
  script: string;
  extraArgs: string[];
  /** Optional `--prefix <dir>` so the expansion can walk the right package.json. */
  prefix?: string;
}

const PNPM_BUILTINS = new Set([
  'install', 'add', 'remove', 'update', 'run', 'exec', 'test', 't', 'start',
  'build', 'publish', 'init', 'link', 'unlink', 'list', 'ls', 'why', 'prune',
  'outdated', 'audit', 'fetch', 'rebuild', 'root', 'bin', 'config', 'store',
  'import', 'patch', 'patch-commit', 'patch-remove', 'env', 'dlx', 'create',
]);

/**
 * Recognise `(npm|pnpm|yarn) [run[-script]] <script> [extra args]`. Returns
 * `null` when the parsed command is not a package-manager script invocation.
 *
 * Leading flags like `--silent`, `-s`, `--if-present`, `--prefix <dir>`,
 * `-w <ws>` are skipped. The `--prefix <dir>` value is captured so the
 * expansion reads the right package.json.
 *
 * The caller supplies the one `ParsedCommand` from `parseCommandArgv` so no
 * second re-tokenisation and no second `argv[0]` read happens here (HOK-3383).
 */
export function resolvePackageScriptInvocation(
  parsed: ParsedCommand,
): PackageScriptInvocation | null {
  const bin = parsed.program;
  const manager: PackageManager | null = bin === 'npm' ? 'npm' : bin === 'pnpm' ? 'pnpm' : bin === 'yarn' ? 'yarn' : null;
  if (manager === null) return null;

  const programArgs = parsed.programArgs;
  let i = 0;
  let prefix: string | undefined;

  while (i < programArgs.length) {
    const token = programArgs[i]!;
    if (token === '--silent' || token === '-s' || token === '--if-present' || token === '--quiet' || token === '-q'
      || token === '--loglevel' || token === '--no-progress' || token === '--progress') {
      i += 1;
      // --loglevel takes an argument
      if (token === '--loglevel' && i < programArgs.length) i += 1;
      continue;
    }
    if (token === '--prefix' || token === '-C' || token === '--cwd') {
      if (i + 1 >= programArgs.length) return null;
      prefix = programArgs[i + 1];
      i += 2;
      continue;
    }
    if (token === '-w' || token === '--workspace') {
      if (i + 1 >= programArgs.length) return null;
      i += 2;
      continue;
    }
    if (token.startsWith('--workspace=') || token.startsWith('--prefix=')) {
      if (token.startsWith('--prefix=')) prefix = token.slice('--prefix='.length);
      i += 1;
      continue;
    }
    if (token === '--') {
      i += 1;
      continue;
    }
    break;
  }

  if (i >= programArgs.length) return null;
  const first = programArgs[i]!;

  // npm/pnpm/yarn test shortcuts
  if (first === 'test' || first === 't' || first === 'tst') {
    return { manager, script: 'test', extraArgs: stripLeadingDoubleDash(programArgs.slice(i + 1)), ...(prefix ? { prefix } : {}) };
  }

  if (first === 'run' || first === 'run-script') {
    if (i + 1 >= programArgs.length) return null;
    const script = programArgs[i + 1]!;
    return { manager, script, extraArgs: stripLeadingDoubleDash(programArgs.slice(i + 2)), ...(prefix ? { prefix } : {}) };
  }

  // `pnpm <script>` and `yarn <script>` — only if <script> is not a builtin.
  if (manager === 'pnpm' || manager === 'yarn') {
    if (!PNPM_BUILTINS.has(first)) {
      return { manager, script: first, extraArgs: stripLeadingDoubleDash(programArgs.slice(i + 1)), ...(prefix ? { prefix } : {}) };
    }
  }

  return null;
}

function stripLeadingDoubleDash(args: readonly string[]): string[] {
  if (args.length > 0 && args[0] === '--') {
    return args.slice(1);
  }
  return [...args];
}

/**
 * Resolve the shell-script path a `[bash|sh] tests/run-*.sh …` /
 * `./tests/run-*.sh …` / absolute-path invocation points at, or `null` when
 * the parsed command is not a shell-script runner. Reads only resolved parsed
 * fields — no second `argv[0]` inspection (HOK-3383).
 */
function resolveSuiteScript(parsed: ParsedCommand): string | null {
  if (parsed.program === 'bash' || parsed.program === 'sh') {
    return parsed.programArgs[0] ?? null;
  }
  // Program itself is the script (./tests/run-*.sh, tests/run-*.sh, or absolute).
  return parsed.programPath;
}

/**
 * True when the parsed command matches `[bash|sh] tests/run-*.sh …` or
 * `./tests/run-*.sh …` or an absolute path under `<worktree>/tests/`.
 */
function isRepoSuiteRunner(parsed: ParsedCommand, opts: { cwd: string; worktreePath: string }): boolean {
  const script = resolveSuiteScript(parsed);
  if (script === null) return false;
  const normalized = normalizeToRepoRelative(script, opts.cwd, opts.worktreePath);
  if (normalized === null) return false;
  // Must be tests/run-*.sh at the worktree root
  return /^tests\/run-[^/]+\.sh$/.test(normalized);
}

/**
 * `tests/run-related.sh` is itself a focused selector — it only runs tests
 * related to the current diff — so it is always allowed, with or without
 * `--shard` / `--list`. Keeps the generic repo-suite refusal in place for
 * every other `run-*.sh` runner.
 */
function isRunRelated(parsed: ParsedCommand, opts: { cwd: string; worktreePath: string }): boolean {
  const script = resolveSuiteScript(parsed);
  if (script === null) return false;
  const normalized = normalizeToRepoRelative(script, opts.cwd, opts.worktreePath);
  return normalized === 'tests/run-related.sh';
}

function normalizeToRepoRelative(scriptPath: string, cwd: string, worktreePath: string): string | null {
  let resolved: string;
  if (path.isAbsolute(scriptPath)) {
    resolved = scriptPath;
  } else {
    resolved = path.resolve(cwd, scriptPath);
  }
  const rel = path.relative(worktreePath, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return rel.split(path.sep).join('/');
}

function hasShardOrListFlag(parsed: ParsedCommand): boolean {
  for (const token of parsed.programArgs) {
    if (token === '--shard' || token === '--list' || token.startsWith('--shard=')) {
      return true;
    }
  }
  return false;
}

/**
 * Walk `cwd` up to and including `worktreePath` for the nearest `package.json`.
 * When `--prefix <dir>` was given, resolve it against `cwd` first.
 */
export function readScriptExpansion(input: {
  manager: PackageManager;
  script: string;
  extraArgs: string[];
  cwd: string;
  worktreePath: string;
  prefix?: string;
}): ScriptExpansion {
  const start = input.prefix
    ? (path.isAbsolute(input.prefix) ? input.prefix : path.resolve(input.cwd, input.prefix))
    : input.cwd;
  const packageJsonPath = findNearestPackageJson(start, input.worktreePath);
  let body: string | null = null;
  if (packageJsonPath) {
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { scripts?: Record<string, unknown> };
      const value = parsed.scripts?.[input.script];
      if (typeof value === 'string') {
        body = value;
      }
    } catch {
      body = null;
    }
  }

  const chainedScripts = body ? extractChainedScripts(body) : [];
  const extraArgsNote = buildExtraArgsNote(input.extraArgs, body, chainedScripts);

  return {
    manager: input.manager,
    script: input.script,
    body,
    packageJsonPath,
    chainedScripts,
    extraArgs: [...input.extraArgs],
    ...(extraArgsNote !== undefined ? { extraArgsNote } : {}),
  };
}

function findNearestPackageJson(startDir: string, worktreePath: string): string | null {
  let current = path.resolve(startDir);
  const stop = path.resolve(worktreePath);
  // If startDir is outside worktree, just check startDir once.
  if (!current.startsWith(stop)) {
    const candidate = path.join(current, 'package.json');
    return safeExistsFile(candidate) ? candidate : null;
  }
  while (true) {
    const candidate = path.join(current, 'package.json');
    if (safeExistsFile(candidate)) {
      return candidate;
    }
    if (current === stop) {
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function safeExistsFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

function extractChainedScripts(body: string): string[] {
  const segments = body.split(/(?:&&|\|\||;)/);
  const found: string[] = [];
  const re = /(?:npm|pnpm|yarn)\s+(?:run(?:-script)?\s+)?([\w:.\-/]+)/g;
  for (const segment of segments) {
    re.lastIndex = 0;
    const match = re.exec(segment);
    if (match && match[1]) {
      // Skip bare "test" when it is the only script and matches
      // builtin shortcuts; keep the first script-name token per segment.
      found.push(match[1]);
    }
  }
  return found;
}

function buildExtraArgsNote(extraArgs: string[], body: string | null, chainedScripts: string[]): string | undefined {
  if (extraArgs.length === 0) return undefined;
  if (!body) {
    return `Extra arguments (${extraArgs.join(' ')}) have no effect: the script body is unknown.`;
  }
  if (body.includes('&&') || body.includes('||') || body.includes(';')) {
    const last = chainedScripts.length > 0 ? chainedScripts[chainedScripts.length - 1] : null;
    const tail = last
      ? ` the last command of the chain (${last})`
      : ' the last command of the chain';
    return `Extra arguments (${extraArgs.join(' ')}) are appended to${tail}; they do not narrow the selection across the full chain.`;
  }
  return `Extra arguments (${extraArgs.join(' ')}) are appended to: ${body}.`;
}

/** Format one compact block for a tool result's text content. */
export function formatScriptExpansion(expansion: ScriptExpansion): string {
  const lines: string[] = [];
  const header = `${expansion.manager} ${expansion.script}`;
  if (expansion.body) {
    lines.push(`${header} runs: ${expansion.body}`);
    if (expansion.chainedScripts.length > 1) {
      lines.push(`Chain: ${expansion.chainedScripts.join(' → ')}`);
    }
  } else {
    lines.push(`${header} script not found in nearest package.json${expansion.packageJsonPath ? ` (${expansion.packageJsonPath})` : ''}.`);
  }
  if (expansion.extraArgsNote) {
    lines.push(expansion.extraArgsNote);
  }
  return lines.join('\n');
}

export function classifyTestCommandScope(
  parsed: ParsedCommand,
  opts: { cwd: string; worktreePath: string },
): TestCommandScope {
  const invocation = resolvePackageScriptInvocation(parsed);
  if (invocation) {
    const expansion = readScriptExpansion({
      manager: invocation.manager,
      script: invocation.script,
      extraArgs: invocation.extraArgs,
      cwd: opts.cwd,
      worktreePath: opts.worktreePath,
      ...(invocation.prefix ? { prefix: invocation.prefix } : {}),
    });
    if (invocation.script === 'test') {
      return { scope: 'full-suite', reason: 'package-test-script', expansion };
    }
    return { scope: 'focused', expansion };
  }

  if (isRunRelated(parsed, opts)) {
    // tests/run-related.sh is a diff-scoped selector; always focused.
    return { scope: 'focused' };
  }

  if (isRepoSuiteRunner(parsed, opts) && !hasShardOrListFlag(parsed)) {
    return { scope: 'full-suite', reason: 'repo-suite-runner' };
  }

  return { scope: 'focused' };
}

export const FOCUSED_TEST_GUIDANCE = [
  'Use focused test commands that complete inside the run_tests time limit:',
  '  - bash tests/run-related.sh (runs only the tests related to your diff; <60s typical)',
  '  - node --test <files>',
  '  - npx tsx --test <files>',
  '  - bash tests/<one>.test.sh',
  '  - bash tests/run-unit-tests.sh --shard i/n',
  'CI runs the full suite; a coding agent should verify its own change with a focused subset.',
].join('\n');
