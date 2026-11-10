/**
 * Operator tools index (HOK-3462).
 *
 * Some tools in `tools/` are never called by the mill but are used by agents
 * during recoveries. `docs/operator-tools.md` lists them so they can be found,
 * and this module checks two things:
 *
 * 1. Every tool is discoverable: a tool that no tracked non-test file names
 *    (other than the index itself) must have an index entry, and every entry
 *    must point to a file that exists.
 * 2. Every indexed tool still loads: running it with `--help` from a temporary
 *    directory exits 0 and prints something.
 *
 * Tools that parse their own arguments use `exitOnHelp` from tool-runner.ts so
 * `--help` never does real work.
 *
 * @module operator-tools-index
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const OPERATOR_TOOLS_INDEX = 'docs/operator-tools.md';

/** Files that only exist to test or register tests; naming a tool there doesn't make it discoverable. */
const NON_REFERENCE_FILE = /(\.test\.|^tests\/|(^|\/)fixtures\/|ci-test-weights\.json$)/;

/** Skip very large tracked files (corpora, logs) when searching for references. */
const MAX_REFERENCE_FILE_BYTES = 3_000_000;

const INDEX_ROW = /^\|\s*`(tools\/[^`]+\.ts)`\s*\|/;

export interface OperatorToolsIndex {
  /** Tool paths in index order, without duplicates. */
  tools: string[];
  /** Tool paths listed more than once. */
  duplicates: string[];
}

/** Read the tool paths from the index's table rows (first column, `tools/<name>.ts`). */
export function parseOperatorToolsIndex(markdown: string): OperatorToolsIndex {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const tools: string[] = [];
  for (const line of markdown.split('\n')) {
    const match = line.match(INDEX_ROW);
    if (!match) continue;
    const tool = match[1];
    if (seen.has(tool)) {
      duplicates.add(tool);
      continue;
    }
    seen.add(tool);
    tools.push(tool);
  }
  return { tools, duplicates: [...duplicates] };
}

function listTrackedFiles(repoDir: string): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoDir, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
}

/** Non-test tools whose name appears in no tracked non-test file other than themselves and the index. */
export function findUnreferencedTools(repoDir: string, trackedFiles = listTrackedFiles(repoDir)): string[] {
  const tools = trackedFiles.filter((file) => /^tools\/[^/]+\.ts$/.test(file) && !file.includes('.test.'));
  const corpus: Array<{ file: string; text: string }> = [];
  for (const file of trackedFiles) {
    if (file === OPERATOR_TOOLS_INDEX || NON_REFERENCE_FILE.test(file)) continue;
    const path = join(repoDir, file);
    try {
      if (statSync(path).size > MAX_REFERENCE_FILE_BYTES) continue;
      corpus.push({ file, text: readFileSync(path, 'utf-8') });
    } catch {
      // Deleted in the working tree or unreadable: it can't reference anything.
    }
  }
  return tools.filter((tool) => {
    const name = basename(tool);
    const stem = `tools/${name.slice(0, -'.ts'.length)}`;
    return !corpus.some(({ file, text }) => file !== tool && (text.includes(name) || text.includes(stem)));
  });
}

export interface OperatorToolsIndexFindings {
  /** Unreferenced tools with no index entry. */
  unindexed: string[];
  /** Index entries whose file doesn't exist. */
  missingFiles: string[];
  duplicates: string[];
}

export function checkOperatorToolsIndex(repoDir: string, trackedFiles?: string[]): OperatorToolsIndexFindings {
  const indexPath = join(repoDir, OPERATOR_TOOLS_INDEX);
  const index = existsSync(indexPath)
    ? parseOperatorToolsIndex(readFileSync(indexPath, 'utf-8'))
    : { tools: [], duplicates: [] };
  const listed = new Set(index.tools);
  return {
    unindexed: findUnreferencedTools(repoDir, trackedFiles).filter((tool) => !listed.has(tool)),
    missingFiles: index.tools.filter((tool) => !existsSync(join(repoDir, tool))),
    duplicates: index.duplicates,
  };
}

export interface HelpCheckResult {
  tool: string;
  ok: boolean;
  /** Why it failed; empty when ok. */
  reason: string;
}

export interface HelpCheckOptions {
  repoDir: string;
  concurrency?: number;
  timeoutMs?: number;
}

/** The tsx ESM loader installed with wavemill, so tools run the same way `npx tsx` runs them. */
function tsxLoaderUrl(): string {
  return pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href;
}

function runOne(tool: string, loader: string, cwd: string, repoDir: string, timeoutMs: number): Promise<HelpCheckResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', loader, join(repoDir, tool), '--help'], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const tail = output.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
      if (timedOut) resolve({ tool, ok: false, reason: `timed out after ${timeoutMs}ms` });
      else if (code !== 0) resolve({ tool, ok: false, reason: `exited ${code}: ${tail}` });
      else if (output.trim() === '') resolve({ tool, ok: false, reason: 'exited 0 but printed nothing' });
      else resolve({ tool, ok: true, reason: '' });
    });
  });
}

/** Run each tool with `--help` from a temporary directory, a few at a time. */
export async function runHelpChecks(tools: string[], options: HelpCheckOptions): Promise<HelpCheckResult[]> {
  const concurrency = Math.max(1, options.concurrency ?? Math.min(8, availableParallelism()));
  const timeoutMs = options.timeoutMs ?? 60_000;
  const loader = tsxLoaderUrl();
  const cwd = mkdtempSync(join(tmpdir(), 'operator-tools-help-'));
  const results: HelpCheckResult[] = new Array(tools.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tools.length) {
      const index = next++;
      results[index] = await runOne(tools[index], loader, cwd, options.repoDir, timeoutMs);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, tools.length) }, worker));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  return results;
}
