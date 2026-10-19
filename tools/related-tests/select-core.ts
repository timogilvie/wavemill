/**
 * Core selection logic for `tests/run-related.sh`: given a changed-file set,
 * return the plan of tests to run (grouped by runner) plus the reason tags
 * the shell layer prints for `--dry-run` output.
 *
 * Kept pure (no process spawn, no shell) so the shell harness has a stable
 * JSON contract and the logic is unit-testable from TS.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { loadOrBuildGraph, transitiveDependents } from './build-ts-graph.ts';

export type FileKind = 'ts' | 'shell' | 'test' | 'prompt' | 'other';

export interface ChangedFile {
  path: string;
  kind: FileKind;
}

export type RunnerKind = 'node-test' | 'tsx-single' | 'bash-test' | 'preflight' | 'journeys';

export interface SelectedTest {
  path: string;
  runner: RunnerKind;
  /** Short reason tag (e.g. "ts-dep", "shell-dep", "preflight", "mill-core"). */
  reason: string;
}

export interface SelectionPlan {
  changed: ChangedFile[];
  tests: SelectedTest[];
  /** True when a mill-core path triggered the journeys suite. */
  journeysInjected: boolean;
}

export interface SelectOptions {
  repoRoot: string;
  /** Repo-relative paths. Pre-normalized by the caller. */
  changedPaths: readonly string[];
  /** When true, suppress the journey-suite injection. */
  noJourneys?: boolean;
}

const MILL_CORE_FILES = new Set([
  'shared/lib/wavemill-monitor.sh',
  'shared/lib/wavemill-startup-runner.sh',
  'shared/lib/wavemill-common.sh',
  'shared/lib/tend-controller.ts',
  'shared/lib/tend-loop.ts',
  'shared/lib/ready-stage.ts',
  'shared/lib/ready-tend-handoff.ts',
  'shared/lib/promotion-controller.ts',
  'shared/lib/workflow-state.ts',
  'shared/lib/merge-labels.ts',
  'shared/lib/agent-adapters.sh',
  'shared/lib/native-agent/launch-coding.ts',
  'shared/lib/native-agent/launch-planning.ts',
  'shared/lib/native-agent/review.ts',
]);

const MILL_CORE_PREFIXES = ['tests/journeys/', 'tests/fakes/'];

const GENERIC_FN_NAMES = new Set([
  'log', 'warn', 'info', 'error', 'debug', 'fatal',
  'pass', 'fail', 'skip', 'done', 'die', 'retry',
  'main', 'init', 'setup', 'cleanup', 'teardown',
  'gh', 'jq', 'node', 'npm', 'npx', 'rg', 'cat', 'echo',
  'ls', 'rm', 'mv', 'cp', 'cd',
]);

export function classifyPath(p: string): FileKind {
  if (/\.(test)\.(ts|tsx|js|mjs|cjs|sh)$/.test(p)) return 'test';
  if (p.startsWith('tools/prompts/') || p.startsWith('commands/')) return 'prompt';
  if (/\.sh$/.test(p)) return 'shell';
  if (/\.(ts|tsx|js|mjs|cjs)$/.test(p)) return 'ts';
  return 'other';
}

export function isMillCorePath(p: string): boolean {
  if (MILL_CORE_FILES.has(p)) return true;
  return MILL_CORE_PREFIXES.some((prefix) => p.startsWith(prefix));
}

function isTestFile(p: string): boolean {
  return /\.(test)\.(ts|tsx|js|mjs|cjs|sh)$/.test(p);
}

function isShellTest(p: string): boolean {
  return /\.test\.sh$/.test(p);
}

/**
 * Extract the TESTS/CUSTOM_TS_TESTS/CUSTOM_SH_TESTS arrays from a shell file.
 * Returns the string entries verbatim; comments and empty lines are skipped.
 */
export function parseShellArray(repoRoot: string, relPath: string, arrayName: string): string[] {
  const abs = path.join(repoRoot, relPath);
  if (!existsSync(abs)) return [];
  const source = readFileSync(abs, 'utf8');
  const re = new RegExp(`${arrayName}=\\(([^)]*)\\)`, 'm');
  const match = re.exec(source);
  if (!match) return [];
  const inner = match[1]!;
  const out: string[] = [];
  for (const rawLine of inner.split('\n')) {
    let line = rawLine.trim();
    if (!line) continue;
    const commentIdx = line.indexOf('#');
    if (commentIdx === 0) continue;
    if (commentIdx > 0) line = line.slice(0, commentIdx).trim();
    if (!line) continue;
    // Strip trailing continuation backslash
    line = line.replace(/\\$/, '').trim();
    // Strip quotes
    line = line.replace(/^['"]|['"]$/g, '');
    if (!line) continue;
    out.push(line);
  }
  return out;
}

interface RegisteredTests {
  unit: Set<string>;
  customTs: Set<string>;
  customSh: Set<string>;
  shell: Set<string>;
}

function loadRegisteredTests(repoRoot: string): RegisteredTests {
  return {
    unit: new Set(parseShellArray(repoRoot, 'tests/run-unit-tests.sh', 'TESTS')),
    customTs: new Set(parseShellArray(repoRoot, 'tests/run-custom-tests.sh', 'CUSTOM_TS_TESTS')),
    customSh: new Set(parseShellArray(repoRoot, 'tests/run-custom-tests.sh', 'CUSTOM_SH_TESTS')),
    shell: new Set(
      parseShellArray(repoRoot, 'tests/run-shell-suite.sh', 'TESTS')
        .map((name) => (name.startsWith('tests/') ? name : `tests/${name}`)),
    ),
  };
}

function runnerFor(testPath: string, reg: RegisteredTests): RunnerKind | null {
  if (reg.unit.has(testPath)) return 'node-test';
  if (reg.customTs.has(testPath)) return 'tsx-single';
  if (reg.customSh.has(testPath)) return 'bash-test';
  if (reg.shell.has(testPath)) return 'bash-test';
  return null;
}

function triggersPreflight(p: string): boolean {
  if (/^tools\/check-[^/]+\.ts$/.test(p)) return true;
  if (/^tests\/check-[^/]+\.test\.(sh|ts)$/.test(p)) return true;
  if (/^shared\/lib\/[^/]+\.sh$/.test(p)) return true;
  return false;
}

/**
 * Shell dep scan: for each changed `.sh`, find tests that reference its
 * basename (coarse but inclusive) and tests that call any function it defines
 * (extracted via `name()` / `function name` regex).
 */
export function scanShellReferences(
  repoRoot: string,
  changedShell: readonly string[],
): { testPath: string; reason: string }[] {
  const results = new Map<string, string>();
  const testFiles: string[] = [];
  const testsDir = path.join(repoRoot, 'tests');
  try {
    // Shallow scan — the suite layout keeps shell tests at tests/*.test.sh
    const entries = readdirSync(testsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.test.sh')) continue;
      testFiles.push(path.join('tests', entry.name));
    }
  } catch {
    return [];
  }
  if (testFiles.length === 0) return [];

  // Pre-read test sources once
  const sources = new Map<string, string>();
  for (const tf of testFiles) {
    try {
      sources.set(tf, readFileSync(path.join(repoRoot, tf), 'utf8'));
    } catch { /* skip */ }
  }

  for (const changed of changedShell) {
    const basename = path.basename(changed);
    for (const [tf, source] of sources) {
      if (results.has(tf)) continue;
      if (source.includes(basename)) {
        results.set(tf, `shell-dep:${basename}`);
      }
    }
    // Function name extraction
    let changedSource = '';
    try {
      changedSource = readFileSync(path.join(repoRoot, changed), 'utf8');
    } catch { /* skip */ }
    if (!changedSource) continue;
    const fnNames = new Set<string>();
    const nameRe = /^(?:function\s+)?([a-zA-Z_][a-zA-Z0-9_-]*)\s*\(\)/gm;
    let m: RegExpExecArray | null;
    while ((m = nameRe.exec(changedSource)) !== null) {
      const name = m[1];
      if (!name) continue;
      // Skip generic command-wrapper names and very short names without an
      // underscore. Project-specific functions almost always use snake_case
      // with a namespace prefix (e.g. `wavemill_hook_write`); dropping bare
      // names like `log`, `jq`, `node`, `gh` keeps the whole-word scan from
      // dragging in every test that incidentally uses the command.
      if (GENERIC_FN_NAMES.has(name)) continue;
      if (name.length < 6 && !name.includes('_')) continue;
      fnNames.add(name);
    }
    for (const fn of fnNames) {
      // Match whole-word occurrences only (coarse but good enough)
      const wordRe = new RegExp(`\\b${escapeRe(fn)}\\b`);
      for (const [tf, source] of sources) {
        if (results.has(tf)) continue;
        if (wordRe.test(source)) {
          results.set(tf, `shell-fn:${fn}`);
        }
      }
    }
  }

  return Array.from(results.entries())
    .map(([testPath, reason]) => ({ testPath, reason }))
    .sort((a, b) => a.testPath.localeCompare(b.testPath));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function selectRelatedTests(options: SelectOptions): SelectionPlan {
  const { repoRoot, changedPaths } = options;
  const changedExistingPaths = changedPaths.filter((p) => existsSync(path.join(repoRoot, p)));
  const changed: ChangedFile[] = changedPaths.map((p) => ({ path: p, kind: classifyPath(p) }));
  const reg = loadRegisteredTests(repoRoot);

  const selected = new Map<string, SelectedTest>();

  // 1. Changed test files are themselves selected (if registered).
  for (const file of changed) {
    if (file.kind !== 'test') continue;
    const runner = runnerFor(file.path, reg);
    if (runner) {
      selected.set(file.path, { path: file.path, runner, reason: 'changed-test' });
    }
  }

  // 2. TS transitive dependents.
  const changedTsPaths = changed
    .filter((f) => f.kind === 'ts' || (f.kind === 'test' && /\.(ts|tsx|js|mjs|cjs)$/.test(f.path)))
    .map((f) => f.path);

  if (changedTsPaths.length > 0) {
    const graph = loadOrBuildGraph(repoRoot);
    const transitive = transitiveDependents(graph, changedTsPaths);
    for (const dep of transitive) {
      if (!isTestFile(dep)) continue;
      if (isShellTest(dep)) continue;
      if (selected.has(dep)) continue;
      const runner = runnerFor(dep, reg);
      if (runner) {
        selected.set(dep, { path: dep, runner, reason: 'ts-dep' });
      }
    }
  }

  // 3. Shell references.
  const changedShellPaths = changedExistingPaths.filter((p) => /\.sh$/.test(p) && !/\.test\.sh$/.test(p));
  if (changedShellPaths.length > 0) {
    for (const hit of scanShellReferences(repoRoot, changedShellPaths)) {
      if (!isShellTest(hit.testPath)) continue;
      if (selected.has(hit.testPath)) continue;
      const runner = runnerFor(hit.testPath, reg);
      if (runner === 'bash-test') {
        selected.set(hit.testPath, { path: hit.testPath, runner, reason: hit.reason });
      }
    }
  }

  // 4. Preflight injection.
  if (changed.some((f) => triggersPreflight(f.path))) {
    selected.set('__preflight__', { path: '__preflight__', runner: 'preflight', reason: 'preflight' });
  }

  // 5. Mill-core journey injection.
  let journeysInjected = false;
  if (!options.noJourneys && changed.some((f) => isMillCorePath(f.path))) {
    selected.set('__journeys__', { path: '__journeys__', runner: 'journeys', reason: 'mill-core' });
    journeysInjected = true;
  }

  const tests = Array.from(selected.values()).sort((a, b) => a.path.localeCompare(b.path));

  return { changed, tests, journeysInjected };
}
