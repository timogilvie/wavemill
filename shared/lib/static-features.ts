/**
 * Static feature collection for the Arbiter S1 candidate_features/v1 contract.
 *
 * Emits the four Static-group fields — `type_errors`, `lint_errors`,
 * `build_ok`, `complexity_delta` — plus provenance (`build_evidence`,
 * `complexity_metric`) that S1 expects from every candidate PR.
 *
 * ## Design invariants (HOK-2806)
 *
 * - **Stateless.** No dependency on wavemill workflow state. Reads only the
 *   checkout (committed files) plus git, and optionally `gh` for CI evidence.
 *   That is what lets S4 later extract this module to `@hokusai/scan` and
 *   what makes the "same values from bare checkout as wavemill worktree"
 *   contract testable.
 * - **Bare-checkout parity.** Committed config lives at
 *   `<checkoutDir>/.wavemill-config.json`; the collector reads it directly
 *   and never merges the gitignored `.wavemill-config.local.json` overlay.
 * - **Per-signal independence.** Each field is attempted and errors
 *   independently. A build failure never nulls `type_errors`; a missing
 *   type checker never nulls `lint_errors`.
 * - **Null discipline.** `null` means "the documented evidence was
 *   unavailable" — missing binary, missing config, spawn/timeout failure,
 *   unparseable output. `0` and `false` are observed values, only emitted
 *   from a tool that actually completed.
 *
 * @module static-features
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execArgvCommand } from './shell-utils.ts';
import type { StaticBuildEvidence } from './eval-schema.ts';

/** The metric id emitted for `complexity_delta`. */
export const COMPLEXITY_METRIC_ID = 'wavemill-cyclomatic/v1';

/** File extensions handled by `fileComplexity`. */
const COMPLEXITY_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.rb', '.php',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.swift', '.kt',
  '.sh', '.bash',
]);

/** Default per-signal timeouts (milliseconds). */
export const DEFAULT_TIMEOUTS_MS = {
  typecheck: 180_000,
  lint: 120_000,
  build: 300_000,
  complexity: 60_000,
} as const;

export interface StaticFeaturesTimeouts {
  typecheck?: number;
  lint?: number;
  build?: number;
  complexity?: number;
}

export interface StaticFeaturesOptions {
  /** Directory that contains the candidate checkout (its HEAD is the candidate). */
  checkoutDir: string;
  /** Optional base ref for the complexity diff (defaults to `origin/main`). */
  baseRef?: string;
  /** PR number for CI-evidence fallback on `build_ok`. */
  prNumber?: string;
  /** Repo directory for `gh pr checks` when different from `checkoutDir`. */
  repoDir?: string;
  /** Override per-signal timeouts (ms). */
  timeouts?: StaticFeaturesTimeouts;
  /** When true, skip network-touching operations (CI evidence, git fetch). */
  offline?: boolean;
}

export interface StaticFeaturesResult {
  type_errors: number | null;
  lint_errors: number | null;
  build_ok: boolean | null;
  complexity_delta: number | null;
  build_evidence: StaticBuildEvidence | null;
  complexity_metric: string | null;
}

interface CommittedStaticAnalysisConfig {
  typecheckCommand?: string;
  lintCommand?: string;
  buildCommand?: string;
  timeoutSeconds?: {
    typecheck?: number;
    lint?: number;
    build?: number;
    complexity?: number;
  };
}

// ────────────────────────────────────────────────────────────────
// Committed-config reader (never uses loadWavemillConfig)
// ────────────────────────────────────────────────────────────────

/**
 * Read `.wavemill-config.json` from the checkout as raw JSON.
 *
 * This deliberately does NOT go through `loadWavemillConfig()`, which merges
 * the gitignored `.wavemill-config.local.json` overlay. Bare-checkout parity
 * requires that only committed files influence the result.
 */
export function readCommittedStaticAnalysisConfig(
  checkoutDir: string,
): CommittedStaticAnalysisConfig {
  const configPath = join(checkoutDir, '.wavemill-config.json');
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      staticAnalysis?: CommittedStaticAnalysisConfig;
    };
    return parsed?.staticAnalysis ?? {};
  } catch {
    return {};
  }
}

// ────────────────────────────────────────────────────────────────
// Parser units (pure, testable without shelling out)
// ────────────────────────────────────────────────────────────────

/**
 * Count TypeScript compiler errors in tsc's stdout/stderr.
 *
 * tsc reports each error on its own line matching `error TS<code>`.
 * Multiline error contexts (source snippet + caret) do not carry the
 * `error TS…` marker, so counting the marker is stable across tsc versions.
 */
export function countTscErrors(output: string): number {
  if (!output) return 0;
  const matches = output.match(/\berror TS\d+/g);
  return matches ? matches.length : 0;
}

/**
 * Sum error counts from eslint `--format json` output.
 *
 * Counts `errorCount` only — warnings are not S1 lint errors. Fatal parse
 * errors are already counted by eslint as errors. Returns null if the input
 * is not a valid eslint JSON array.
 */
export function sumEslintErrors(jsonText: string): number | null {
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  let total = 0;
  for (const entry of parsed) {
    if (entry && typeof entry === 'object' && 'errorCount' in entry) {
      const value = (entry as { errorCount?: unknown }).errorCount;
      if (typeof value === 'number' && Number.isFinite(value)) total += value;
    }
  }
  return total;
}

/**
 * Approximate cyclomatic complexity of a source file (`wavemill-cyclomatic/v1`).
 *
 * Definition: `1 + count(branch-tokens)` after best-effort stripping of line
 * comments, block comments, and string/template literals. The token set is
 * language-family aware but deliberately simple; documented in
 * `docs/arbiter/static-features.md`.
 *
 * Returns null for unsupported extensions.
 */
export function fileComplexity(source: string, extension: string): number | null {
  if (!COMPLEXITY_EXTENSIONS.has(extension)) return null;
  const stripped = stripCommentsAndStrings(source, extension);

  // Language-family branch tokens. Kept simple; ties are avoided by using
  // word boundaries so `iferror` does not count as `if`.
  const patterns: RegExp[] = [
    /\bif\b/g,
    /\belse\s+if\b/g,
    /\belif\b/g,
    /\bfor\b/g,
    /\bwhile\b/g,
    /\bcase\b/g,
    /\bwhen\b/g,
    /\bcatch\b/g,
    /\bexcept\b/g,
    /\brescue\b/g,
    /\?[^:]/g, // ternary "?" heuristically (not preceded by string context due to stripping)
    /&&/g,
    /\|\|/g,
  ];

  let branches = 0;
  for (const pattern of patterns) {
    const matches = stripped.match(pattern);
    if (matches) branches += matches.length;
  }
  return 1 + branches;
}

function stripCommentsAndStrings(source: string, extension: string): string {
  // Handle shell/python/ruby line-comments starting with # in appropriate langs
  const hashComment = new Set(['.py', '.rb', '.sh', '.bash']);
  const isHash = hashComment.has(extension);

  const chars = source.split('');
  const out: string[] = [];
  let i = 0;
  const N = chars.length;

  while (i < N) {
    const c = chars[i];
    const next = i + 1 < N ? chars[i + 1] : '';

    // Line comments
    if (!isHash && c === '/' && next === '/') {
      while (i < N && chars[i] !== '\n') i++;
      continue;
    }
    if (isHash && c === '#') {
      while (i < N && chars[i] !== '\n') i++;
      continue;
    }
    // Block comments (C-family)
    if (c === '/' && next === '*') {
      i += 2;
      while (i < N && !(chars[i] === '*' && chars[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // Strings (single, double, backtick, python triple)
    if (c === '"' || c === "'" || c === '`') {
      // Python triple-quoted (approximate: same-char x3)
      if ((extension === '.py') && chars[i + 1] === c && chars[i + 2] === c) {
        i += 3;
        while (
          i < N &&
          !(chars[i] === c && chars[i + 1] === c && chars[i + 2] === c)
        ) {
          i++;
        }
        i += 3;
        continue;
      }
      const quote = c;
      i++;
      while (i < N && chars[i] !== quote) {
        if (chars[i] === '\\') i += 2;
        else i++;
      }
      i++;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

// ────────────────────────────────────────────────────────────────
// Type-check ladder
// ────────────────────────────────────────────────────────────────

function collectTypeErrors(
  checkoutDir: string,
  config: CommittedStaticAnalysisConfig,
  timeoutMs: number,
): number | null {
  // Rung 1: committed config override.
  if (config.typecheckCommand) {
    const result = runShellCommand(config.typecheckCommand, checkoutDir, timeoutMs);
    if (result === null) return null;
    // tsc exit 0 with no errors is 0. tsc exit 2 with errors also completed;
    // count from stdout/stderr regardless.
    const combined = `${result.stdout}\n${result.stderr}`;
    // Distinguish "command failed to spawn / crashed" from "typecheck ran".
    if (result.failed || result.exitCode < 0) return null;
    return countTscErrors(combined);
  }

  // Rung 2: auto-detect.
  const staticConfig = join(checkoutDir, 'tsconfig.static.json');
  const rootConfig = join(checkoutDir, 'tsconfig.json');
  const project = existsSync(staticConfig)
    ? 'tsconfig.static.json'
    : existsSync(rootConfig)
      ? 'tsconfig.json'
      : null;
  if (!project) return null;

  const result = execArgvCommand(
    'npx',
    ['--no-install', 'tsc', '--noEmit', '-p', project],
    { cwd: checkoutDir, timeout: timeoutMs, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.failed || result.exitCode < 0) return null;
  return countTscErrors(`${result.stdout}\n${result.stderr}`);
}

// ────────────────────────────────────────────────────────────────
// Lint ladder
// ────────────────────────────────────────────────────────────────

function collectLintErrors(
  checkoutDir: string,
  config: CommittedStaticAnalysisConfig,
  timeoutMs: number,
): number | null {
  // Rung 1: committed override (must emit eslint-format JSON on stdout).
  if (config.lintCommand) {
    const result = runShellCommand(config.lintCommand, checkoutDir, timeoutMs);
    if (result === null) return null;
    if (result.failed || result.exitCode < 0) return null;
    // eslint exits 1 when errors are found; we still parse.
    return sumEslintErrors(result.stdout);
  }

  // Rung 2: auto-detect eslint flat/legacy config.
  const eslintConfigs = [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.eslintrc.yaml',
    '.eslintrc',
  ];
  const hasConfig = eslintConfigs.some((name) => existsSync(join(checkoutDir, name)));
  if (!hasConfig) return null;

  const result = execArgvCommand(
    'npx',
    ['--no-install', 'eslint', '.', '--format', 'json'],
    { cwd: checkoutDir, timeout: timeoutMs, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.failed || result.exitCode < 0) return null;
  return sumEslintErrors(result.stdout);
}

// ────────────────────────────────────────────────────────────────
// Build ladder
// ────────────────────────────────────────────────────────────────

function collectBuildOk(
  checkoutDir: string,
  config: CommittedStaticAnalysisConfig,
  timeoutMs: number,
  ciEvidence: (() => CiBuildEvidence | null) | null,
): { value: boolean | null; evidence: StaticBuildEvidence | null } {
  // Rung 1: committed config override.
  if (config.buildCommand) {
    const result = runShellCommand(config.buildCommand, checkoutDir, timeoutMs);
    if (result === null) return { value: null, evidence: null };
    if (result.failed || result.exitCode < 0) return { value: null, evidence: null };
    return { value: result.exitCode === 0, evidence: 'local-build' };
  }

  // Rung 2: auto-detect package.json scripts.build.
  const pkgPath = join(checkoutDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        scripts?: Record<string, string>;
      };
      if (pkg.scripts?.build) {
        const result = execArgvCommand(
          'npm',
          ['run', 'build', '--silent'],
          { cwd: checkoutDir, timeout: timeoutMs, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
        );
        if (result.failed || result.exitCode < 0) return { value: null, evidence: null };
        return { value: result.exitCode === 0, evidence: 'local-build' };
      }
    } catch {
      // Fall through to CI evidence.
    }
  }

  // Rung 3: CI evidence.
  if (ciEvidence) {
    const evidence = ciEvidence();
    if (evidence) return { value: evidence.value, evidence: evidence.provenance };
  }

  return { value: null, evidence: null };
}

interface CiBuildEvidence {
  value: boolean | null;
  provenance: StaticBuildEvidence;
}

/**
 * Read CI evidence for `build_ok` via `gh pr checks --json`.
 *
 * Returns null when gh isn't available, the PR has no terminal checks, or
 * evidence is otherwise inconclusive (pending checks). Returns a boolean when
 * a build-named check is terminal, or when every check is terminal and can
 * be conjoined.
 */
export function collectCiBuildEvidence(
  prNumber: string,
  repoDir: string,
): CiBuildEvidence | null {
  const result = execArgvCommand(
    'gh',
    ['pr', 'checks', prNumber, '--json', 'name,state,bucket'],
    { cwd: repoDir, timeout: 30_000, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.failed || result.exitCode < 0 || !result.stdout.trim()) return null;

  let checks: Array<{ name: string; state: string; bucket: string }>;
  try {
    checks = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(checks) || checks.length === 0) return null;

  const buildCheck = checks.find((c) => /build|compile/i.test(c.name));
  if (buildCheck) {
    const conclusion = bucketToBool(buildCheck.bucket);
    if (conclusion === null) return null;
    return { value: conclusion, provenance: 'ci-build-check' };
  }

  // Conjunction over all terminal checks.
  const conclusions = checks.map((c) => bucketToBool(c.bucket));
  if (conclusions.some((c) => c === null)) return null; // pending
  if (conclusions.length === 0) return null;
  return {
    value: conclusions.every((c) => c === true),
    provenance: 'ci-pipeline',
  };
}

function bucketToBool(bucket: string | null | undefined): boolean | null {
  switch (bucket) {
    case 'pass': return true;
    case 'fail': return false;
    case 'skipping': return null;
    case 'cancel': return false;
    case 'pending': return null;
    default: return null;
  }
}

// ────────────────────────────────────────────────────────────────
// Complexity delta
// ────────────────────────────────────────────────────────────────

function collectComplexityDelta(
  checkoutDir: string,
  baseRef: string,
  timeoutMs: number,
): number | null {
  // Resolve merge-base between baseRef and HEAD.
  const mergeBase = runGit(
    checkoutDir,
    ['merge-base', baseRef, 'HEAD'],
    timeoutMs,
  );
  if (!mergeBase) return null;

  // List changed files with rename detection.
  const nameStatus = runGit(
    checkoutDir,
    ['diff', '--name-status', '--find-renames', `${mergeBase}...HEAD`],
    timeoutMs,
  );
  if (nameStatus === null) return null;
  if (!nameStatus.trim()) return 0; // No changes ⇒ observed 0

  const changes = parseNameStatus(nameStatus);
  let baseTotal = 0;
  let headTotal = 0;
  let anyMeasured = false;

  for (const change of changes) {
    const ext = getExtension(change.headPath || change.basePath || '');
    if (!COMPLEXITY_EXTENSIONS.has(ext)) continue;

    // Base content
    if (change.basePath && change.status !== 'A') {
      const baseSource = runGit(
        checkoutDir,
        ['show', `${mergeBase}:${change.basePath}`],
        timeoutMs,
        { allowFailure: true },
      );
      if (baseSource !== null) {
        const c = fileComplexity(baseSource, ext);
        if (c !== null) {
          baseTotal += c;
          anyMeasured = true;
        }
      }
    }
    // Head content
    if (change.headPath && change.status !== 'D') {
      const absPath = join(checkoutDir, change.headPath);
      try {
        const stat = statSync(absPath);
        if (stat.isFile()) {
          const headSource = readFileSync(absPath, 'utf-8');
          const c = fileComplexity(headSource, ext);
          if (c !== null) {
            headTotal += c;
            anyMeasured = true;
          }
        }
      } catch {
        // File missing; skip
      }
    }
  }

  if (!anyMeasured) return 0; // measured no supported files ⇒ observed 0 delta
  return headTotal - baseTotal;
}

interface NameStatusChange {
  status: string;
  basePath: string | null;
  headPath: string | null;
}

function parseNameStatus(output: string): NameStatusChange[] {
  const results: NameStatusChange[] = [];
  const lines = output.split('\n').filter((line) => line.length > 0);
  for (const line of lines) {
    // Format: <STATUS>\t<path1>[\t<path2>]
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const rawStatus = parts[0];
    // Rename/copy status has a similarity score: R100, C085. First char is status.
    const status = rawStatus.charAt(0);
    if (status === 'R' || status === 'C') {
      results.push({
        status: 'R',
        basePath: parts[1] ?? null,
        headPath: parts[2] ?? null,
      });
    } else if (status === 'A') {
      results.push({ status: 'A', basePath: null, headPath: parts[1] ?? null });
    } else if (status === 'D') {
      results.push({ status: 'D', basePath: parts[1] ?? null, headPath: null });
    } else if (status === 'M' || status === 'T') {
      results.push({ status: 'M', basePath: parts[1] ?? null, headPath: parts[1] ?? null });
    }
  }
  return results;
}

function getExtension(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  const base = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const lastDot = base.lastIndexOf('.');
  if (lastDot <= 0) return '';
  return base.slice(lastDot).toLowerCase();
}

// ────────────────────────────────────────────────────────────────
// Command runners
// ────────────────────────────────────────────────────────────────

interface CommandOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
  failed: boolean;
}

/**
 * Run a shell command string (from committed config) with a timeout.
 *
 * We use a real shell here because config strings can contain pipes,
 * redirections, and `--` argument separators that argv-only exec cannot
 * reproduce. Config comes from a committed file inside the checkout — so it
 * is trusted at the same level as any other source file the tools compile.
 */
function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): CommandOutcome | null {
  // Prefer argv form via `/bin/sh -c` so exit code and stderr are captured
  // without throwing on non-zero exits.
  const result = execArgvCommand(
    '/bin/sh',
    ['-c', command],
    { cwd, timeout: timeoutMs, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  );
  return result;
}

function runGit(
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
  options: { allowFailure?: boolean } = {},
): string | null {
  const result = execArgvCommand(
    'git',
    args,
    { cwd, timeout: timeoutMs, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.failed) return null;
  if (result.exitCode !== 0 && !options.allowFailure) return null;
  if (result.exitCode !== 0 && options.allowFailure) return null;
  return result.stdout.trimEnd();
}

// ────────────────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────────────────

/**
 * Collect the four S1 Static-group fields from a checkout.
 *
 * Never throws; every unrecoverable per-signal failure is a `null`.
 */
export function collectStaticFeatures(
  options: StaticFeaturesOptions,
): StaticFeaturesResult {
  const checkoutDir = resolve(options.checkoutDir);
  const timeouts = {
    ...DEFAULT_TIMEOUTS_MS,
    ...(options.timeouts ?? {}),
  };
  const config = readCommittedStaticAnalysisConfig(checkoutDir);
  // Committed timeoutSeconds overrides defaults but is superseded by explicit options.timeouts.
  const committedTypecheck = config.timeoutSeconds?.typecheck;
  const committedLint = config.timeoutSeconds?.lint;
  const committedBuild = config.timeoutSeconds?.build;
  const committedComplexity = config.timeoutSeconds?.complexity;
  const typecheckMs = options.timeouts?.typecheck
    ?? (committedTypecheck ? committedTypecheck * 1000 : timeouts.typecheck);
  const lintMs = options.timeouts?.lint
    ?? (committedLint ? committedLint * 1000 : timeouts.lint);
  const buildMs = options.timeouts?.build
    ?? (committedBuild ? committedBuild * 1000 : timeouts.build);
  const complexityMs = options.timeouts?.complexity
    ?? (committedComplexity ? committedComplexity * 1000 : timeouts.complexity);

  const type_errors = safelyCollect(() =>
    collectTypeErrors(checkoutDir, config, typecheckMs),
  );
  const lint_errors = safelyCollect(() =>
    collectLintErrors(checkoutDir, config, lintMs),
  );

  const ciEvidence: (() => CiBuildEvidence | null) | null =
    !options.offline && options.prNumber
      ? () => collectCiBuildEvidence(options.prNumber!, options.repoDir ?? checkoutDir)
      : null;

  const build = safelyCollectObject(
    () => collectBuildOk(checkoutDir, config, buildMs, ciEvidence),
    { value: null, evidence: null },
  );

  const baseRef = options.baseRef
    ?? tryFallbackBaseRef(checkoutDir, complexityMs)
    ?? 'HEAD^';
  const complexity_delta = safelyCollect(() =>
    collectComplexityDelta(checkoutDir, baseRef, complexityMs),
  );

  return {
    type_errors,
    lint_errors,
    build_ok: build.value,
    complexity_delta,
    build_evidence: build.evidence,
    complexity_metric:
      complexity_delta === null ? null : COMPLEXITY_METRIC_ID,
  };
}

function tryFallbackBaseRef(checkoutDir: string, timeoutMs: number): string | null {
  for (const candidate of ['origin/main', 'main', 'origin/HEAD']) {
    const output = runGit(
      checkoutDir,
      ['rev-parse', '--verify', candidate],
      timeoutMs,
      { allowFailure: true },
    );
    if (output) return candidate;
  }
  return null;
}

function safelyCollect<T>(fn: () => T | null): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

function safelyCollectObject<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
