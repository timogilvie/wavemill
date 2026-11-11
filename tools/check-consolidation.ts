#!/usr/bin/env -S npx tsx
/**
 * Consolidation gate (HOK-3470): a PR labelled `consolidation` must reduce net
 * production lines (tracked `.ts`/`.sh` under `shared/lib`, `shared/hooks` and
 * `tools`, excluding tests, fixtures, allowlists and docs; one predicate
 * filters both sides). The declaration is read from one place: the GitHub PR
 * (label + body). A deliberate exception is recorded in the PR body as
 * `Consolidation Exception: <reason>`; `tools/weekly-scorecard.ts` lists them.
 * Exit codes: 0 pass (including a genuine no-PR event), 1 consolidation policy
 * failure, 2 the delta or PR read failed on a PR event (never a false green).
 */
import { fileURLToPath } from 'node:url';
import { escapeShellArg, execShellCommand } from '../shared/lib/shell-utils.ts';
import { resolveDefaultBaseRef, resolveOriginFirstRef } from '../shared/lib/git-base-resolver.ts';
import { getIntegrationConfig } from '../shared/lib/config.ts';

/** Test seam: git/gh invocation. */
export const consolidationDeps = { execShellCommand };

const CONSOLIDATION_LABEL = 'consolidation';
const PRODUCTION_PATH = /^(shared\/lib|shared\/hooks|tools)\//;
const PRODUCTION_EXT = /\.(ts|sh)$/;
const NON_PRODUCTION_PATH = /(\.test\.|fixtures|allowlist|docs)/;
export const EXCEPTION_RE = /Consolidation Exception:\s*(.+)/i;
const TOP_ADDED_SHOWN = 5;

interface FileDelta { file: string; added: number; removed: number }
export interface ProductionDelta { added: number; removed: number; perFile: FileDelta[] }
export interface PrMeta { number: number; labels: string[]; body: string }
export interface ConsolidationVerdict { exitCode: number; lines: string[] }

/** Is this path production code the consolidation gate counts? */
export function isProductionFile(file: string): boolean {
  return PRODUCTION_PATH.test(file) && PRODUCTION_EXT.test(file) && !NON_PRODUCTION_PATH.test(file);
}

function tryRun(command: string, repoDir: string, maxBuffer?: number): string | null {
  try {
    return String(consolidationDeps.execShellCommand(command, {
      cwd: repoDir, encoding: 'utf-8', stdio: 'pipe', ...(maxBuffer ? { maxBuffer } : {}),
    })).trim();
  } catch {
    return null;
  }
}

/** Base the delta is computed against: explicit override, PR target, then config. */
export function resolveBaseRef(repoDir: string): string {
  const primary = process.env.CONSOLIDATION_BASE_REF
    || process.env.BASE_REF
    || getIntegrationConfig(repoDir).integrationBranch;
  const resolved = resolveOriginFirstRef(repoDir, primary);
  if (resolved.kind !== 'local') return resolved.ref;
  // A bare name with no `origin/<name>`: keep it only if it is a real local branch.
  const local = tryRun(`git rev-parse --verify --quiet ${escapeShellArg(`${resolved.ref}^{commit}`)}`, repoDir);
  return local ? resolved.ref : resolveDefaultBaseRef(repoDir) ?? resolved.ref;
}

/** Sum the production-line delta from the merge base to HEAD. */
export function computeProductionDelta(repoDir: string, base: string): ProductionDelta {
  const mergeBase = tryRun(`git merge-base ${escapeShellArg(base)} HEAD`, repoDir);
  const numstat = mergeBase && tryRun(
    `git diff --numstat --no-renames ${escapeShellArg(mergeBase)} HEAD`, repoDir, 64 * 1024 * 1024,
  );
  // A failed git read must never read as "no lines changed" (false green).
  if (!mergeBase || numstat === null) throw new Error(`cannot diff production lines against ${base}`);
  const delta: ProductionDelta = { added: 0, removed: 0, perFile: [] };
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue;
    const [rawAdded, rawRemoved, ...pathParts] = line.split('\t');
    const file = pathParts.join('\t');
    // `-` marks a binary file; --no-renames means a rename cannot hide a deletion.
    if (!file || rawAdded === '-' || rawRemoved === '-' || !isProductionFile(file)) continue;
    const added = Number.parseInt(rawAdded, 10) || 0;
    const removed = Number.parseInt(rawRemoved, 10) || 0;
    delta.added += added;
    delta.removed += removed;
    delta.perFile.push({ file, added, removed });
  }
  return delta;
}

function parsePrJson(json: string): PrMeta | null {
  try {
    const raw = JSON.parse(json) as { number?: number; labels?: Array<{ name?: string }>; body?: string | null };
    return { number: raw.number ?? 0, labels: (raw.labels ?? []).map((l) => l.name ?? ''), body: raw.body ?? '' };
  } catch {
    return null;
  }
}
/** Read the PR label + body once; null when there is no PR (push/schedule). */
export function readPrMeta(repoDir: string): PrMeta | null {
  const prNumber = process.env.PR_NUMBER;
  const prJson = tryRun(`gh pr view ${prNumber ? escapeShellArg(prNumber) : ''} --json number,labels,body`, repoDir);
  if (prJson) return parsePrJson(prJson);
  const branch = process.env.GITHUB_HEAD_REF ?? '';
  const issueJson = branch ? tryRun(`gh issue view ${escapeShellArg(branch)} --json number,labels,body`, repoDir) : null;
  return issueJson ? parsePrJson(issueJson) : null;
}
/** The gate's decision, as an exit code and printable lines. */
export function evaluateConsolidation(
  pr: PrMeta | null,
  delta: ProductionDelta | null,
  deltaError?: string,
  prReadFailed = false,
): ConsolidationVerdict {
  // A failed gh read on a PR event must never read as "no PR" (false green).
  if (!pr && prReadFailed) return { exitCode: 2, lines: ['error: PR_NUMBER is set but the PR could not be read (gh failure?)'] };
  if (!pr) return { exitCode: 0, lines: ['warn: no PR detected; skipping consolidation gate'] };
  if (!delta) return { exitCode: 2, lines: [`error: cannot compute production delta: ${deltaError ?? 'unknown error'}`] };
  const summary = `Production delta: +${delta.added} -${delta.removed}`;
  const net = delta.added - delta.removed;
  if (!pr.labels.includes(CONSOLIDATION_LABEL)) return { exitCode: 0, lines: [summary] };
  if (net <= 0) return { exitCode: 0, lines: [`Consolidation successful: net decrease (${net})`, summary] };
  const exception = pr.body.match(EXCEPTION_RE)?.[1]?.trim();
  if (exception) return { exitCode: 0, lines: [`Exception used: ${exception}`, summary] };
  const topAdded = [...delta.perFile].sort((a, b) => b.added - a.added).slice(0, TOP_ADDED_SHOWN);
  return {
    exitCode: 1,
    lines: [
      `Consolidation PRs must reduce net production lines. Delta: +${delta.added} -${delta.removed}`,
      'Largest added production files:',
      ...(topAdded.length > 0 ? topAdded.map((entry) => `  +${entry.added}  ${entry.file}`) : ['  (none)']),
      'Delete the old callers in this PR, or record "Consolidation Exception: <reason>" in the PR body.',
    ],
  };
}

function main(): void {
  const repoDir = process.cwd();
  const pr = readPrMeta(repoDir);
  let delta: ProductionDelta | null = null;
  let deltaError: string | undefined;
  if (pr) {
    try {
      delta = computeProductionDelta(repoDir, resolveBaseRef(repoDir));
    } catch (error) {
      deltaError = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    }
  }
  const verdict = evaluateConsolidation(pr, delta, deltaError, !pr && Boolean(process.env.PR_NUMBER));
  const write = verdict.exitCode === 0 ? console.log : console.error;
  for (const line of verdict.lines) write(line);
  process.exit(verdict.exitCode);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
