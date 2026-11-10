/**
 * Test discovery (HOK-3466): the one answer to "which suite runs this test?".
 *
 * A test joins a suite by existing. Nobody edits a list:
 *
 * - `*.test.ts` / `*.test.js` anywhere in the repo  -> `unit` (`node --test`)
 * - `tests/**` + `*.test.sh`                        -> `shell`
 *
 * A file overrides that with a marker comment in its first lines:
 *
 *     // wavemill-test-suite: custom
 *     # wavemill-test-suite: lifecycle
 *
 * `unit`, `custom` and `shell` are the suites the sharded runners execute
 * (tests/run-unit-tests.sh, tests/run-custom-tests.sh,
 * tests/run-shell-suite.sh). Any other declared suite (`lifecycle`,
 * `standalone`, `none`) keeps the file out of those runners. A `tests/*.sh`
 * file that is not named `*.test.sh` joins the shell suite only by declaring
 * `shell`.
 *
 * Files come from git (tracked plus untracked-but-not-ignored), so a new test
 * runs before it is committed and ignored trees (node_modules, worktrees) are
 * never scanned. Output is sorted by code point, so shard assignment never
 * depends on filesystem order.
 *
 * @module test-discovery
 */

import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Suites executed by the sharded runners. */
export const RUNNER_SUITES = ['shell', 'unit', 'custom'] as const;
export type RunnerSuite = (typeof RUNNER_SUITES)[number];

/** Suites a file may declare to stay out of the sharded runners. */
export const OTHER_SUITES = ['lifecycle', 'standalone', 'none'] as const;
export type OtherSuite = (typeof OTHER_SUITES)[number];

export type DeclaredSuite = RunnerSuite | OtherSuite;

export const SUITE_MARKER = 'wavemill-test-suite';

/** Bytes of a file's head searched for the marker. */
const MARKER_HEAD_BYTES = 2048;
const MARKER_PATTERN = new RegExp(`^\\s*(?://|#|\\*)\\s*${SUITE_MARKER}:\\s*(\\S+)`, 'm');
/** First line of an extensionless shell script: a shebang, or the shellcheck directive sourced snippets use. */
const SHELL_FIRST_LINE_PATTERN = /^(?:#!.*\b(?:ba)?sh\b|#\s*shellcheck\s+shell=(?:ba)?sh\b)/;

export interface DiscoveredSuites {
  /** Shell-suite ids, relative to `tests/` (the weights-manifest key form). */
  shell: string[];
  /** Repo-relative `node --test` files. */
  unit: string[];
  /** Repo-relative custom-harness files (`.ts` / `.js` / `.sh`). */
  custom: string[];
  /** Repo-relative files that declared a non-runner suite, by suite. */
  other: Record<OtherSuite, string[]>;
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function walk(repoDir: string, relative: string, out: string[]): void {
  for (const entry of readdirSync(join(repoDir, relative), { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(repoDir, child, out);
    else if (entry.isFile()) out.push(child);
  }
}

/**
 * Repo-relative files that exist on disk: tracked plus untracked-not-ignored.
 * Outside a git work tree (fixture directories) it falls back to a plain walk.
 */
export function listRepoFiles(repoDir: string): string[] {
  let files: string[];
  try {
    const stdout = execFileSync(
      'git',
      ['-C', repoDir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    files = stdout.split('\0').filter((file) => file.length > 0);
  } catch {
    files = [];
    walk(repoDir, '', files);
  }
  const present = files.filter((file) => {
    try {
      return statSync(join(repoDir, file)).isFile();
    } catch {
      return false;
    }
  });
  return [...new Set(present)].sort(byCodePoint);
}

function readHead(filePath: string): string {
  const buffer = Buffer.alloc(MARKER_HEAD_BYTES);
  const fd = openSync(filePath, 'r');
  try {
    const bytes = readSync(fd, buffer, 0, MARKER_HEAD_BYTES, 0);
    return buffer.toString('utf8', 0, bytes);
  } finally {
    closeSync(fd);
  }
}

/** The suite a file's head declares, or null. Throws on an unknown suite name. */
export function readSuiteMarker(repoDir: string, file: string): DeclaredSuite | null {
  const declared = readHead(join(repoDir, file)).match(MARKER_PATTERN)?.[1];
  if (declared === undefined) return null;
  const known: readonly string[] = [...RUNNER_SUITES, ...OTHER_SUITES];
  if (!known.includes(declared)) {
    throw new Error(
      `test discovery: ${file} declares unknown suite "${declared}" (expected one of: ${known.join(', ')})`,
    );
  }
  return declared as DeclaredSuite;
}

function assertSuiteFits(file: string, suite: DeclaredSuite): void {
  const isScript = /\.(?:ts|js)$/.test(file);
  const isShell = file.endsWith('.sh');
  if (suite === 'unit' && !isScript) {
    throw new Error(`test discovery: ${file} declares suite "unit" but is not a .ts/.js file`);
  }
  if (suite === 'shell' && !(isShell && file.startsWith('tests/'))) {
    throw new Error(`test discovery: ${file} declares suite "shell" but is not a .sh file under tests/`);
  }
  if (suite === 'custom' && !isScript && !isShell) {
    throw new Error(`test discovery: ${file} declares suite "custom" but is not a .ts/.js/.sh file`);
  }
}

/**
 * Assign every test file in the repo to exactly one suite. Throws when a file
 * cannot be placed, so a test is never silently left out.
 */
export function discoverTestSuites(repoDir: string): DiscoveredSuites {
  const result: DiscoveredSuites = {
    shell: [],
    unit: [],
    custom: [],
    other: { lifecycle: [], standalone: [], none: [] },
  };
  for (const file of listRepoFiles(repoDir)) {
    const isScriptTest = /\.test\.(?:ts|js)$/.test(file);
    const isShellTest = file.endsWith('.test.sh');
    const mayDeclareShell = file.startsWith('tests/') && file.endsWith('.sh');
    if (!isScriptTest && !isShellTest && !mayDeclareShell) continue;

    const declared = readSuiteMarker(repoDir, file);
    let suite: DeclaredSuite;
    if (declared !== null) {
      assertSuiteFits(file, declared);
      suite = declared;
    } else if (isScriptTest) {
      suite = 'unit';
    } else if (isShellTest) {
      if (!file.startsWith('tests/')) {
        throw new Error(
          `test discovery: ${file} is a shell test outside tests/; move it under tests/ or declare "# ${SUITE_MARKER}: <suite>"`,
        );
      }
      suite = 'shell';
    } else {
      continue; // a helper script under tests/ that declares nothing
    }

    if (suite === 'shell') result.shell.push(file.slice('tests/'.length));
    else if (suite === 'unit') result.unit.push(file);
    else if (suite === 'custom') result.custom.push(file);
    else result.other[suite].push(file);
  }
  result.shell.sort(byCodePoint);
  return result;
}

/**
 * Every shell script in the repo, for the `bash -n` syntax pass: `*.sh` files
 * plus extensionless files whose first line is a sh/bash shebang or a
 * `# shellcheck shell=bash` directive.
 */
export function listShellScripts(repoDir: string): string[] {
  return listRepoFiles(repoDir).filter((file) => {
    if (file.endsWith('.sh')) return true;
    const name = file.slice(file.lastIndexOf('/') + 1);
    if (name.includes('.')) return false;
    try {
      return SHELL_FIRST_LINE_PATTERN.test(readHead(join(repoDir, file)).split('\n', 1)[0]);
    } catch {
      return false;
    }
  });
}
