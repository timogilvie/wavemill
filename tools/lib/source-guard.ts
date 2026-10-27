/**
 * Shared framework for preflight source guards (HOK-3236).
 *
 * Every "never do X" invariant in CLAUDE.md is enforced by a guard built on
 * this module: a {@link GuardSpec} names the forbidden shapes (line-oriented
 * regexes, plus optional structural checks for rules a single line cannot
 * express), the invariant source that is allowed to contain them, an inline
 * suppression marker, and a ratcheting allowlist. {@link runSourceGuard} scans
 * every tracked source file once and returns findings; {@link formatGuardResult}
 * renders them with the standard remediation footer.
 *
 * Shared semantics (identical for every guard):
 *
 * - Only git-tracked files are scanned; untracked scratch never fires.
 * - The invariant source (`invariantPaths`) is never scanned — it necessarily
 *   contains every forbidden shape. Test files (`*.test.*`) and generated /
 *   per-run trees (`excludedPrefixes`) are skipped too.
 * - Whole-line comments never fire (`//`, `/*`, `*` in TS/JS; `#` in shell):
 *   prose naming a forbidden shape is not an occurrence of it.
 * - `<suppressionMarker>: <reason>` on the finding line or the line directly
 *   above suppresses that one line.
 * - Allowlist lines are `<repo-relative path> [<max findings>]  # <reason>`.
 *   Without a count the file is exempt entirely; with a count the file is
 *   still scanned and fails once it exceeds that many findings, so a new
 *   occurrence in an already-listed file still fires. When `ratchet` is on, an
 *   entry that over-allows (fewer findings than its count, none at all, or a
 *   file that no longer exists) is itself a finding: the list only shrinks.
 * - When `requireAllowlistReason` is on, an entry without `# reason` on its
 *   own line is reported and not honoured.
 */
import { existsSync, readFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export type GuardLang = 'ts' | 'sh' | 'both';

export interface GuardPattern {
  /** Stable name surfaced in findings. */
  name: string;
  /** Short human description of the forbidden shape and what to use instead. */
  description: string;
  /** Which source languages the pattern applies to. */
  lang: GuardLang;
  /** Line-oriented matcher. Never use the `g` flag: it is tested per line. */
  re: RegExp;
  /** Repo-relative paths this pattern does not apply to (other patterns still do). */
  excludePaths?: readonly string[];
}

export interface StructuralMatch {
  /** 1-indexed line the finding anchors to (suppression is checked here). */
  line: number;
  /** 1-indexed column; defaults to the first non-blank character. */
  column?: number;
  /** Appended to the check's description, e.g. the offending function name. */
  detail?: string;
}

/**
 * A whole-file check for rules a single-line regex cannot express (e.g. "every
 * exported router entry point reaches finalizeDecision"). Runs only on the
 * listed paths; findings go through the same suppression and allowlist logic.
 */
export interface StructuralCheck {
  name: string;
  description: string;
  /** Repo-relative paths the check runs on. */
  paths: readonly string[];
  find(sourceText: string): StructuralMatch[];
}

export interface GuardSpec {
  /** Short slug used as the output prefix, e.g. `task-identity`. */
  name: string;
  /** Plural noun phrase for the failure headline, e.g. `ad-hoc task-identity derivation(s)`. */
  findingNoun: string;
  /** Inline suppression marker, e.g. `allow-task-identity`. */
  suppressionMarker: string;
  /** Repo-relative allowlist path. A missing file means an empty allowlist. */
  allowlistFile: string;
  /** The invariant source and the guard's own spec file; never scanned. */
  invariantPaths: readonly string[];
  patterns: readonly GuardPattern[];
  structuralChecks?: readonly StructuralCheck[];
  /** Explanation lines printed before the standard allowlist/suppression footer. */
  remediation: readonly string[];
  /** Extensions scanned with `ts`/`both` patterns. Default {@link DEFAULT_TS_EXTENSIONS}. */
  tsExtensions?: readonly string[];
  /** Extensions scanned with `sh`/`both` patterns. Default {@link DEFAULT_SHELL_EXTENSIONS}. */
  shellExtensions?: readonly string[];
  /** Path prefixes never scanned. Default {@link DEFAULT_EXCLUDED_PREFIXES}. */
  excludedPrefixes?: readonly string[];
  /** Report allowlist entries without a same-line `# reason` (and do not honour them). Default true. */
  requireAllowlistReason?: boolean;
  /** Report over-allowing allowlist entries so the list only shrinks. Default true. */
  ratchet?: boolean;
  /**
   * Scan test files (`*.test.*`) too. Default false — a guard that protects a
   * production invariant has no reason to look at tests. Set alongside
   * `testsOnly` for a test-code-only guard (HOK-3237).
   */
  includeTests?: boolean;
  /**
   * When true, only test files (`*.test.*`) are scanned; every production
   * source is skipped regardless of path prefixes. Use for a guard whose
   * target is strictly test code (HOK-3237).
   */
  testsOnly?: boolean;
}

export interface GuardFinding {
  file: string;
  line: number;
  column: number;
  pattern: string;
  description: string;
  text: string;
}

export interface GuardResult {
  ok: boolean;
  scannedFiles: number;
  findings: GuardFinding[];
}

export interface GuardAllowlistEntry {
  path: string;
  reason: string;
  /** Present for a count ratchet; absent for a whole-file exemption. */
  maxFindings?: number;
  /** 1-indexed line in the allowlist file. */
  line: number;
}

export interface ParsedGuardAllowlist {
  entries: GuardAllowlistEntry[];
  /** Entries without a same-line reason (only populated when reasons are required). */
  missingReason: GuardAllowlistEntry[];
}

export const DEFAULT_TS_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
export const DEFAULT_SHELL_EXTENSIONS: readonly string[] = ['.sh', '.bash'];
export const DEFAULT_EXCLUDED_PREFIXES: readonly string[] = [
  'tests/',
  'features/',
  '.wavemill/',
  'node_modules/',
  'worktrees/',
  'spike/',
  '.git/',
  // Generated by tools/generate-schema-validators.ts from the JSON schemas.
  'shared/validators/',
];

const TEST_FILE_PATTERN = /\.test\.[A-Za-z]+$/;
const ALLOWLIST_LINE = /^(\S+)(?:\s+(\d+))?\s*$/;

interface ResolvedSpec {
  spec: GuardSpec;
  ts: ReadonlySet<string>;
  sh: ReadonlySet<string>;
  excludedPrefixes: readonly string[];
  invariantPaths: ReadonlySet<string>;
  requireReason: boolean;
  ratchet: boolean;
  includeTests: boolean;
  testsOnly: boolean;
}

function resolveSpec(spec: GuardSpec): ResolvedSpec {
  return {
    spec,
    ts: new Set(spec.tsExtensions ?? DEFAULT_TS_EXTENSIONS),
    sh: new Set(spec.shellExtensions ?? DEFAULT_SHELL_EXTENSIONS),
    excludedPrefixes: spec.excludedPrefixes ?? DEFAULT_EXCLUDED_PREFIXES,
    invariantPaths: new Set(spec.invariantPaths.map(normalizePath)),
    requireReason: spec.requireAllowlistReason ?? true,
    ratchet: spec.ratchet ?? true,
    includeTests: spec.includeTests ?? spec.testsOnly ?? false,
    testsOnly: spec.testsOnly ?? false,
  };
}

export function normalizePath(fileName: string): string {
  return fileName.split(path.sep).join(path.posix.sep);
}

export function truncate(text: string, max = 160): string {
  const normalized = text.replace(/\s+/g, ' ');
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

/** Whole-line comment: prose, never code. Lines with trailing comments still count as code. */
export function isCommentLine(line: string, isShell: boolean): boolean {
  const trimmed = line.trimStart();
  if (trimmed === '') return false;
  if (isShell) return trimmed.startsWith('#');
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

export function isTestFile(file: string): boolean {
  return TEST_FILE_PATTERN.test(file);
}

/** `git ls-files` restricted to the given extensions (repo-relative, POSIX separators). */
export function listTrackedSourceFiles(repoDir: string, extensions: Iterable<string>): string[] {
  const exts = [...new Set(extensions)];
  if (exts.length === 0) return [];
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--', ...exts.map((ext) => `*${ext}`)],
    { cwd: repoDir, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  );
  const wanted = new Set(exts);
  return output
    .split('\0')
    .filter(Boolean)
    .map(normalizePath)
    .filter((file) => wanted.has(path.extname(file)));
}

/**
 * Parse an allowlist. Blank lines and whole-line `#` comments are ignored;
 * every other line is `<path> [<count>]  # <reason>`.
 */
export function parseGuardAllowlist(contents: string, requireReason = true): ParsedGuardAllowlist {
  const entries: GuardAllowlistEntry[] = [];
  const missingReason: GuardAllowlistEntry[] = [];
  contents.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const hash = trimmed.indexOf('#');
    const body = (hash === -1 ? trimmed : trimmed.slice(0, hash)).trim();
    const reason = hash === -1 ? '' : trimmed.slice(hash + 1).trim();
    const match = ALLOWLIST_LINE.exec(body);
    const entry: GuardAllowlistEntry = {
      path: normalizePath(match ? match[1] : body),
      reason,
      line: index + 1,
      ...(match?.[2] !== undefined ? { maxFindings: Number(match[2]) } : {}),
    };
    if (requireReason && !reason) missingReason.push(entry);
    else entries.push(entry);
  });
  return { entries, missingReason };
}

function languageOf(resolved: ResolvedSpec, file: string): 'ts' | 'sh' | null {
  const ext = path.extname(file);
  if (resolved.ts.has(ext)) return 'ts';
  if (resolved.sh.has(ext)) return 'sh';
  return null;
}

function isSuppressed(lines: readonly string[], index: number, marker: string): boolean {
  return lines[index]?.includes(marker) || (index > 0 && lines[index - 1].includes(marker));
}

/**
 * Scan one file's text against a spec's patterns and structural checks.
 * Applies comment skipping and inline suppression; ignores the allowlist and
 * path exclusions (see {@link runSourceGuard}).
 */
export function checkGuardSource(spec: GuardSpec, fileName: string, sourceText: string): GuardFinding[] {
  return scanSource(resolveSpec(spec), normalizePath(fileName), sourceText);
}

function scanSource(resolved: ResolvedSpec, file: string, sourceText: string): GuardFinding[] {
  const lang = languageOf(resolved, file);
  if (!lang) return [];
  const { spec } = resolved;
  const patterns = spec.patterns.filter((pattern) => (
    (pattern.lang === 'both' || pattern.lang === lang)
    && !(pattern.excludePaths ?? []).includes(file)
  ));
  const checks = (spec.structuralChecks ?? []).filter((check) => check.paths.includes(file));
  if (patterns.length === 0 && checks.length === 0) return [];

  const lines = sourceText.split(/\r?\n/);
  const isShell = lang === 'sh';
  const findings: GuardFinding[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (patterns.length === 0) break;
    const line = lines[i];
    if (isSuppressed(lines, i, spec.suppressionMarker) || isCommentLine(line, isShell)) continue;
    for (const pattern of patterns) {
      const match = pattern.re.exec(line);
      if (!match) continue;
      findings.push({
        file,
        line: i + 1,
        column: match.index + 1,
        pattern: pattern.name,
        description: pattern.description,
        text: truncate(line.trim()),
      });
    }
  }

  for (const check of checks) {
    for (const match of check.find(sourceText)) {
      const index = match.line - 1;
      if (isSuppressed(lines, index, spec.suppressionMarker)) continue;
      const line = lines[index] ?? '';
      findings.push({
        file,
        line: match.line,
        column: match.column ?? (line.length - line.trimStart().length + 1),
        pattern: check.name,
        description: match.detail ? `${check.description} (${match.detail})` : check.description,
        text: truncate(line.trim()),
      });
    }
  }

  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

function isExcluded(resolved: ResolvedSpec, file: string): boolean {
  if (resolved.invariantPaths.has(file)) return true;
  const testFile = isTestFile(file);
  if (resolved.testsOnly && !testFile) return true;
  if (!resolved.includeTests && testFile) return true;
  return resolved.excludedPrefixes.some((prefix) => file.startsWith(prefix));
}

function readText(fullPath: string): string | null {
  try {
    return readFileSync(fullPath, 'utf-8');
  } catch {
    return null;
  }
}

function allowlistFinding(spec: GuardSpec, entry: GuardAllowlistEntry, pattern: string, description: string): GuardFinding {
  return {
    file: spec.allowlistFile,
    line: entry.line,
    column: 1,
    pattern,
    description,
    text: entry.path,
  };
}

/** Scan every tracked source file in `repoDir` and apply the allowlist. */
export function runSourceGuard(spec: GuardSpec, repoDir: string): GuardResult {
  const resolved = resolveSpec(spec);
  const allowlistText = readText(join(repoDir, spec.allowlistFile));
  const { entries, missingReason } = allowlistText === null
    ? { entries: [], missingReason: [] }
    : parseGuardAllowlist(allowlistText, resolved.requireReason);
  const allowed = new Map(entries.map((entry) => [entry.path, entry]));

  const findings: GuardFinding[] = missingReason.map((entry) => (
    allowlistFinding(spec, entry, 'allowlist-missing-reason', `allowlist entry ${entry.path} has no "# reason"`)
  ));
  const findingsByAllowedFile = new Map<string, number>();
  let scannedFiles = 0;

  const files = listTrackedSourceFiles(repoDir, [...resolved.ts, ...resolved.sh]);
  for (const file of files) {
    if (isExcluded(resolved, file)) continue;
    const sourceText = readText(join(repoDir, file));
    if (sourceText === null) continue;
    const entry = allowed.get(file);
    // A whole-file exemption only needs scanning when the ratchet has to prove it is still used.
    if (entry && entry.maxFindings === undefined && !resolved.ratchet) continue;
    scannedFiles += 1;
    const fileFindings = scanSource(resolved, file, sourceText);
    if (!entry) {
      findings.push(...fileFindings);
      continue;
    }
    findingsByAllowedFile.set(file, fileFindings.length);
    if (entry.maxFindings !== undefined && fileFindings.length > entry.maxFindings) {
      findings.push(
        allowlistFinding(
          spec,
          entry,
          'allowlist-count-exceeded',
          `${file} has ${fileFindings.length} finding(s) but the allowlist permits ${entry.maxFindings}; route the new site through the invariant helper`,
        ),
        ...fileFindings,
      );
    }
  }

  if (resolved.ratchet) {
    for (const entry of entries) {
      const actual = findingsByAllowedFile.get(entry.path);
      if (actual === undefined) {
        const reason = existsSync(join(repoDir, entry.path))
          ? 'is not a scanned source file (auto-excluded, untracked, or wrong extension)'
          : 'does not exist';
        findings.push(allowlistFinding(spec, entry, 'allowlist-stale', `allowlist entry ${entry.path} ${reason}; remove it`));
      } else if (actual === 0) {
        findings.push(allowlistFinding(spec, entry, 'allowlist-stale', `${entry.path} no longer has any findings; remove its allowlist entry`));
      } else if (entry.maxFindings !== undefined && actual < entry.maxFindings) {
        findings.push(allowlistFinding(spec, entry, 'allowlist-stale', `${entry.path} has ${actual} finding(s); lower its allowlist count from ${entry.maxFindings} to ${actual}`));
      }
    }
  }

  return { ok: findings.length === 0, scannedFiles, findings };
}

/** Render a result: one ok line, or the numbered findings plus the remediation footer. */
export function formatGuardResult(spec: GuardSpec, result: GuardResult): string {
  if (result.ok) return `${spec.name}: ok (${result.scannedFiles} files scanned)`;
  return [
    `${spec.name}: found ${result.findings.length} ${spec.findingNoun}:`,
    ...result.findings.map((f, i) => (
      `${i + 1}. ${f.file}:${f.line}:${f.column} [${f.pattern}] ${f.description}\n   ${f.text}`
    )),
    '',
    ...spec.remediation,
    `For a justified exception, add the path to ${spec.allowlistFile} with a "# reason",`,
    `or suppress one line with: // ${spec.suppressionMarker}: <reason>  (use # in shell).`,
  ].join('\n');
}

/**
 * Entry point shared by every `tools/check-*.ts` wrapper: run the guard, print
 * the result, and exit non-zero on findings.
 */
export function runGuardCli(spec: GuardSpec, repoDir: string): void {
  const result = runSourceGuard(spec, repoDir);
  const message = formatGuardResult(spec, result);
  if (!result.ok) {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
}
