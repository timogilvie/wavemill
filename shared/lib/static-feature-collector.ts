import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execArgvCommand, type ExecArgvCommandResult } from './shell-utils.ts';

export const STATIC_FEATURE_COLLECTOR_VERSION = '1';
export const STATIC_COMPLEXITY_METRIC = 'hok-branch-count/1';

export type StaticFeatureReason =
  | 'no-tool-configured'
  | 'deps-not-installed'
  | 'tool-timeout'
  | 'tool-error-uncountable'
  | 'head-mismatch'
  | 'ci-not-terminal'
  | 'diff-unavailable'
  | 'no-supported-files';

export interface StaticFeatureInput {
  checkoutDir: string;
  baseRef: string;
  headRef?: string;
  expectedHeadSha?: string;
  ciEvidence?: { ran: boolean; allTerminal: boolean; passed: boolean } | null;
  timeouts?: Partial<Record<'build' | 'typecheck' | 'lint', number>>;
}

export interface StaticFeatureCollectionMeta {
  collectorVersion: string;
  typeChecker: 'tsc' | 'mypy' | null;
  linter: 'eslint' | 'ruff' | 'package-script' | null;
  buildEvidence: 'build-script' | 'ci-terminal' | null;
  complexityMetric: typeof STATIC_COMPLEXITY_METRIC | null;
  collectedAtSha: string | null;
  reasons: Partial<Record<'type_errors' | 'lint_errors' | 'build_ok' | 'complexity_delta', StaticFeatureReason>>;
}

export interface StaticFeatures {
  type_errors: number | null;
  lint_errors: number | null;
  build_ok: boolean | null;
  complexity_delta: number | null;
  collection: StaticFeatureCollectionMeta;
}

type ToolResult = { value: number | boolean | null; reason?: StaticFeatureReason; tool?: string; evidence?: string };

const DEFAULT_TIMEOUTS = {
  build: 240_000,
  typecheck: 180_000,
  lint: 120_000,
};

const SUPPORTED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rb', '.java',
  '.kt', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.sh', '.bash',
]);

function fileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function safeReadJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function safeReadText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function commandTimedOut(result: ExecArgvCommandResult): boolean {
  if (result.exitCode === -1 && !result.failed) return true;
  return /ETIMEDOUT|timed out|SIGTERM|SIGKILL/i.test(`${result.stderr}\n${result.stdout}`);
}

function run(file: string, args: readonly string[], cwd: string, timeout: number): ExecArgvCommandResult {
  return execArgvCommand(file, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 20 * 1024 * 1024,
    stdio: 'pipe',
  });
}

function nodeBin(checkoutDir: string, name: string): string | null {
  const path = join(checkoutDir, 'node_modules', '.bin', name);
  return fileExists(path) ? path : null;
}

function hasNodeModules(checkoutDir: string): boolean {
  return fileExists(join(checkoutDir, 'node_modules'));
}

function packageJson(checkoutDir: string): Record<string, unknown> | null {
  return safeReadJson(join(checkoutDir, 'package.json'));
}

function packageScripts(checkoutDir: string): Record<string, unknown> {
  const pkg = packageJson(checkoutDir);
  const scripts = pkg?.scripts;
  return scripts && typeof scripts === 'object' && !Array.isArray(scripts)
    ? scripts as Record<string, unknown>
    : {};
}

function packageRunner(checkoutDir: string): { file: string; argsForScript: (name: string) => string[] } {
  if (fileExists(join(checkoutDir, 'pnpm-lock.yaml'))) {
    return { file: 'pnpm', argsForScript: (name) => ['run', name] };
  }
  if (fileExists(join(checkoutDir, 'yarn.lock'))) {
    return { file: 'yarn', argsForScript: (name) => [name] };
  }
  return { file: 'npm', argsForScript: (name) => ['run', name, '--silent'] };
}

function hasTsConfig(checkoutDir: string): boolean {
  return fileExists(join(checkoutDir, 'tsconfig.json'));
}

function hasEslintConfig(checkoutDir: string): boolean {
  return [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.eslintrc.yaml',
  ].some((name) => fileExists(join(checkoutDir, name)));
}

function hasMypyConfig(checkoutDir: string): boolean {
  if (fileExists(join(checkoutDir, 'mypy.ini'))) return true;
  if (/\[mypy\]/.test(safeReadText(join(checkoutDir, 'setup.cfg')))) return true;
  return /\[tool\.mypy\]/.test(safeReadText(join(checkoutDir, 'pyproject.toml')));
}

function hasRuffConfig(checkoutDir: string): boolean {
  if (fileExists(join(checkoutDir, 'ruff.toml')) || fileExists(join(checkoutDir, '.ruff.toml'))) return true;
  return /\[tool\.ruff(?:\.lint)?\]/.test(safeReadText(join(checkoutDir, 'pyproject.toml')));
}

export function parseTscErrorCount(output: string, exitCode: number): number | null {
  if (exitCode === 0) return 0;
  const summary = output.match(/Found\s+(\d+)\s+errors?/i);
  if (summary) return Number(summary[1]);
  const matches = output.match(/\berror TS\d+:/g);
  return matches ? matches.length : null;
}

export function parseMypyErrorCount(output: string, exitCode: number): number | null {
  if (/Success:\s+no issues found/i.test(output)) return 0;
  const summary = output.match(/Found\s+(\d+)\s+errors?/i);
  if (summary) return Number(summary[1]);
  return exitCode === 0 ? 0 : null;
}

export function parseEslintErrorCount(output: string): number | null {
  try {
    const parsed = JSON.parse(output || '[]');
    if (!Array.isArray(parsed)) return null;
    return parsed.reduce((sum, item) => {
      const count = item && typeof item === 'object' ? (item as Record<string, unknown>).errorCount : 0;
      return sum + (typeof count === 'number' && Number.isFinite(count) ? count : 0);
    }, 0);
  } catch {
    return null;
  }
}

export function parseRuffErrorCount(output: string): number | null {
  try {
    const parsed = JSON.parse(output || '[]');
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}

function collectTypeErrors(checkoutDir: string, timeout: number): ToolResult {
  if (hasTsConfig(checkoutDir)) {
    if (!hasNodeModules(checkoutDir)) return { value: null, reason: 'deps-not-installed', tool: 'tsc' };
    const tsc = nodeBin(checkoutDir, 'tsc');
    if (!tsc) return { value: null, reason: 'deps-not-installed', tool: 'tsc' };
    const result = run(tsc, ['--noEmit', '-p', 'tsconfig.json'], checkoutDir, timeout);
    if (commandTimedOut(result)) return { value: null, reason: 'tool-timeout', tool: 'tsc' };
    const count = parseTscErrorCount(`${result.stdout}\n${result.stderr}`, result.exitCode);
    return count === null
      ? { value: null, reason: 'tool-error-uncountable', tool: 'tsc' }
      : { value: count, tool: 'tsc' };
  }
  if (hasMypyConfig(checkoutDir)) {
    const result = run('mypy', ['.'], checkoutDir, timeout);
    if (result.failed) return { value: null, reason: 'deps-not-installed', tool: 'mypy' };
    if (commandTimedOut(result)) return { value: null, reason: 'tool-timeout', tool: 'mypy' };
    const count = parseMypyErrorCount(`${result.stdout}\n${result.stderr}`, result.exitCode);
    return count === null
      ? { value: null, reason: 'tool-error-uncountable', tool: 'mypy' }
      : { value: count, tool: 'mypy' };
  }
  return { value: null, reason: 'no-tool-configured' };
}

function collectLintErrors(checkoutDir: string, timeout: number): ToolResult {
  if (hasEslintConfig(checkoutDir)) {
    if (!hasNodeModules(checkoutDir)) return { value: null, reason: 'deps-not-installed', tool: 'eslint' };
    const eslint = nodeBin(checkoutDir, 'eslint');
    if (!eslint) return { value: null, reason: 'deps-not-installed', tool: 'eslint' };
    const result = run(eslint, ['.', '-f', 'json'], checkoutDir, timeout);
    if (commandTimedOut(result)) return { value: null, reason: 'tool-timeout', tool: 'eslint' };
    const count = parseEslintErrorCount(result.stdout || result.stderr);
    return count === null
      ? { value: null, reason: 'tool-error-uncountable', tool: 'eslint' }
      : { value: count, tool: 'eslint' };
  }
  if (hasRuffConfig(checkoutDir)) {
    const result = run('ruff', ['check', '--output-format', 'json'], checkoutDir, timeout);
    if (result.failed) return { value: null, reason: 'deps-not-installed', tool: 'ruff' };
    if (commandTimedOut(result)) return { value: null, reason: 'tool-timeout', tool: 'ruff' };
    const count = parseRuffErrorCount(result.stdout || result.stderr);
    return count === null
      ? { value: null, reason: 'tool-error-uncountable', tool: 'ruff' }
      : { value: count, tool: 'ruff' };
  }
  const scripts = packageScripts(checkoutDir);
  if (typeof scripts.lint === 'string') {
    const runner = packageRunner(checkoutDir);
    const result = run(runner.file, runner.argsForScript('lint'), checkoutDir, timeout);
    if (result.failed) return { value: null, reason: 'deps-not-installed', tool: 'package-script' };
    if (commandTimedOut(result)) return { value: null, reason: 'tool-timeout', tool: 'package-script' };
    return result.exitCode === 0
      ? { value: 0, tool: 'package-script' }
      : { value: null, reason: 'tool-error-uncountable', tool: 'package-script' };
  }
  return { value: null, reason: 'no-tool-configured' };
}

function collectBuildOk(
  checkoutDir: string,
  timeout: number,
  ciEvidence: StaticFeatureInput['ciEvidence'],
): ToolResult {
  const scripts = packageScripts(checkoutDir);
  if (typeof scripts.build === 'string') {
    const runner = packageRunner(checkoutDir);
    const result = run(runner.file, runner.argsForScript('build'), checkoutDir, timeout);
    if (result.failed) return { value: null, reason: 'deps-not-installed', evidence: 'build-script' };
    if (commandTimedOut(result)) return { value: null, reason: 'tool-timeout', evidence: 'build-script' };
    return { value: result.exitCode === 0, evidence: 'build-script' };
  }
  if (ciEvidence) {
    if (!ciEvidence.ran) return { value: null };
    if (!ciEvidence.allTerminal) return { value: null, reason: 'ci-not-terminal', evidence: 'ci-terminal' };
    return { value: ciEvidence.passed, evidence: 'ci-terminal' };
  }
  return { value: null, reason: 'no-tool-configured' };
}

function git(checkoutDir: string, args: readonly string[], timeout = 30_000): ExecArgvCommandResult {
  return run('git', args, checkoutDir, timeout);
}

function resolveHeadSha(checkoutDir: string): string | null {
  const result = git(checkoutDir, ['rev-parse', 'HEAD']);
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

function resolveRefSha(checkoutDir: string, ref: string): string | null {
  const result = git(checkoutDir, ['rev-parse', ref]);
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

function fileExtension(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.bash')) return '.bash';
  const index = lower.lastIndexOf('.');
  return index >= 0 ? lower.slice(index) : '';
}

function isSupportedPath(path: string): boolean {
  return SUPPORTED_EXTENSIONS.has(fileExtension(path));
}

interface ChangedFile {
  status: string;
  basePath: string | null;
  headPath: string | null;
}

function parseNameStatus(output: string): ChangedFile[] {
  return output.split('\n').filter(Boolean).map((line) => {
    const parts = line.split('\t');
    const status = parts[0] || '';
    if (status.startsWith('R') || status.startsWith('C')) {
      return { status, basePath: parts[1] || null, headPath: parts[2] || parts[1] || null };
    }
    const path = parts[1] || null;
    if (status === 'A') return { status, basePath: null, headPath: path };
    if (status === 'D') return { status, basePath: path, headPath: null };
    return { status, basePath: path, headPath: path };
  });
}

function blobText(checkoutDir: string, ref: string, path: string | null): string | null {
  if (!path) return '';
  const result = git(checkoutDir, ['show', `${ref}:${path}`]);
  if (result.exitCode !== 0) return null;
  const text = result.stdout;
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) return '';
  if (text.includes('\0')) return '';
  return text;
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function blobComplexity(path: string, text: string): number {
  const ext = fileExtension(path);
  if (ext === '.py') {
    return countMatches(text, /\b(if|elif|for|while|except|and|or)\b/g);
  }
  if (ext === '.sh' || ext === '.bash') {
    return countMatches(text, /\b(if|elif|for|while|case)\b/g)
      + countMatches(text, /&&|\|\|/g);
  }
  return countMatches(text, /\b(if|for|while|case|catch)\b/g)
    + countMatches(text, /&&|\|\|/g)
    + countMatches(text, /(?<![?\w])\?(?![?.?])/g);
}

function collectComplexityDelta(checkoutDir: string, baseRef: string, headRef: string): ToolResult {
  const mergeBase = git(checkoutDir, ['merge-base', baseRef, headRef]);
  if (mergeBase.exitCode !== 0 || !mergeBase.stdout.trim()) {
    return { value: null, reason: 'diff-unavailable' };
  }
  const baseSha = mergeBase.stdout.trim();
  const headSha = resolveRefSha(checkoutDir, headRef);
  if (!headSha) return { value: null, reason: 'diff-unavailable' };

  const diff = git(checkoutDir, ['diff', '--name-status', '-M', `${baseSha}..${headSha}`]);
  if (diff.exitCode !== 0) return { value: null, reason: 'diff-unavailable' };

  const files = parseNameStatus(diff.stdout).filter((file) =>
    (file.basePath && isSupportedPath(file.basePath)) || (file.headPath && isSupportedPath(file.headPath))
  );
  if (files.length === 0) return { value: 0 };

  let delta = 0;
  for (const file of files) {
    const baseText = blobText(checkoutDir, baseSha, file.basePath);
    const headText = blobText(checkoutDir, headSha, file.headPath);
    if (baseText === null || headText === null) return { value: null, reason: 'diff-unavailable' };
    const basePath = file.basePath || file.headPath || '';
    const headPath = file.headPath || file.basePath || '';
    delta += blobComplexity(headPath, headText) - blobComplexity(basePath, baseText);
  }
  return { value: delta };
}

function checkoutUsableForTools(checkoutDir: string): boolean {
  try {
    return statSync(checkoutDir).isDirectory();
  } catch {
    return false;
  }
}

export function collectStaticFeatures(input: StaticFeatureInput): StaticFeatures {
  const checkoutDir = input.checkoutDir;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...input.timeouts };
  const collectedAtSha = checkoutUsableForTools(checkoutDir) ? resolveHeadSha(checkoutDir) : null;
  const headRef = input.headRef || 'HEAD';
  const expectedHeadSha = input.expectedHeadSha ? resolveRefSha(checkoutDir, input.expectedHeadSha) || input.expectedHeadSha : null;
  const headMatches = !expectedHeadSha || collectedAtSha === expectedHeadSha;

  const collection: StaticFeatureCollectionMeta = {
    collectorVersion: STATIC_FEATURE_COLLECTOR_VERSION,
    typeChecker: null,
    linter: null,
    buildEvidence: null,
    complexityMetric: null,
    collectedAtSha,
    reasons: {},
  };

  let typeResult: ToolResult = { value: null, reason: 'head-mismatch' };
  let lintResult: ToolResult = { value: null, reason: 'head-mismatch' };
  let buildResult: ToolResult = { value: null, reason: 'head-mismatch' };

  if (checkoutUsableForTools(checkoutDir) && headMatches) {
    typeResult = collectTypeErrors(checkoutDir, timeouts.typecheck);
    lintResult = collectLintErrors(checkoutDir, timeouts.lint);
    buildResult = collectBuildOk(checkoutDir, timeouts.build, input.ciEvidence);
  } else if (input.ciEvidence) {
    buildResult = collectBuildOk(checkoutDir, timeouts.build, input.ciEvidence);
  }

  const complexityResult = checkoutUsableForTools(checkoutDir)
    ? collectComplexityDelta(checkoutDir, input.baseRef, headRef)
    : { value: null, reason: 'diff-unavailable' };

  collection.typeChecker = typeResult.tool === 'tsc' || typeResult.tool === 'mypy' ? typeResult.tool : null;
  collection.linter = lintResult.tool === 'eslint' || lintResult.tool === 'ruff' || lintResult.tool === 'package-script'
    ? lintResult.tool
    : null;
  collection.buildEvidence = buildResult.evidence === 'build-script' || buildResult.evidence === 'ci-terminal'
    ? buildResult.evidence
    : null;
  collection.complexityMetric = complexityResult.value === null ? null : STATIC_COMPLEXITY_METRIC;

  if (typeResult.reason) collection.reasons.type_errors = typeResult.reason;
  if (lintResult.reason) collection.reasons.lint_errors = lintResult.reason;
  if (buildResult.reason) collection.reasons.build_ok = buildResult.reason;
  if (complexityResult.reason) collection.reasons.complexity_delta = complexityResult.reason;

  return {
    type_errors: typeof typeResult.value === 'number' ? typeResult.value : null,
    lint_errors: typeof lintResult.value === 'number' ? lintResult.value : null,
    build_ok: typeof buildResult.value === 'boolean' ? buildResult.value : null,
    complexity_delta: typeof complexityResult.value === 'number' ? complexityResult.value : null,
    collection,
  };
}
