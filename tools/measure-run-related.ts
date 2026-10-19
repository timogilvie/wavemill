#!/usr/bin/env tsx
/**
 * Measure the selection latency of `tests/run-related.sh` across recent
 * merged PRs. Not a product feature — a one-shot measurement helper so the
 * PR description for HOK-3232 can quote real numbers.
 *
 * Usage:
 *   npx tsx tools/measure-run-related.ts [--limit 20] [--base main]
 *
 * For each merged PR:
 *   1. Fetch `mergeCommit`, `headRefOid`, `number` via `gh pr list ... --json`.
 *   2. Rather than checkout (which would mutate the operator's worktree),
 *      compute the PR's own name set via `git diff --name-only <parent>
 *      <mergeCommit>` and pass those paths positionally to the selector.
 *      That reproduces the diff size the agent would have seen on the
 *      merged change without disturbing HEAD.
 *
 * The reported numbers (median / p90 / max in seconds) are the figures to
 * paste into the PR description.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

interface PrEntry {
  number: number;
  mergeCommit?: { oid?: string } | null;
  headRefOid?: string | null;
}

function parseArgs(argv: readonly string[]): { limit: number; base: string } {
  let limit = 20;
  let base = 'main';
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]!;
    if (t === '--limit') { limit = Number(argv[++i] ?? limit); continue; }
    if (t === '--base') { base = argv[++i] ?? base; continue; }
    if (t === '--help' || t === '-h') {
      process.stderr.write('Usage: npx tsx tools/measure-run-related.ts [--limit 20] [--base main]\n');
      process.exit(0);
    }
    process.stderr.write(`unknown argument: ${t}\n`);
    process.exit(2);
  }
  return { limit, base };
}

function listPrs(limit: number, base: string): PrEntry[] {
  const out = execFileSync('gh', [
    'pr', 'list', '--state', 'merged', '--base', base,
    '--limit', String(limit),
    '--json', 'number,mergeCommit,headRefOid',
  ], { encoding: 'utf8' });
  return JSON.parse(out) as PrEntry[];
}

function parentSha(mergeCommit: string): string | null {
  const res = spawnSync('git', ['rev-parse', `${mergeCommit}^1`], { encoding: 'utf8' });
  if (res.status !== 0) return null;
  return res.stdout.trim();
}

function changedPaths(parent: string, merge: string): string[] {
  const res = spawnSync('git', ['diff', '--name-only', parent, merge], { encoding: 'utf8' });
  if (res.status !== 0) return [];
  return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

function timeSelection(changed: readonly string[]): { ms: number; selected: number } | null {
  if (changed.length === 0) return { ms: 0, selected: 0 };
  const started = process.hrtime.bigint();
  const env = { ...process.env, WAVEMILL_RUN_RELATED_FAKE_RUNNER: '1' };
  const script = path.resolve('tests/run-related.sh');
  const res = spawnSync('bash', [script, '--list', ...changed], { env, encoding: 'utf8' });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  if (res.status !== 0 && !res.stdout) {
    process.stderr.write(`[WARN] select on ${changed.length} files failed: ${res.stderr}\n`);
    return null;
  }
  const selected = res.stdout.split('\n').filter((l) => l.trim()).length;
  return { ms: elapsedMs, selected };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[idx]!;
}

function main(): void {
  const { limit, base } = parseArgs(process.argv.slice(2));
  const prs = listPrs(limit, base);
  const samples: number[] = [];
  for (const pr of prs) {
    const merge = pr.mergeCommit?.oid;
    if (!merge) continue;
    const parent = parentSha(merge);
    if (!parent) {
      process.stderr.write(`[SKIP] PR #${pr.number}: parent of ${merge.slice(0, 8)} unavailable\n`);
      continue;
    }
    const changed = changedPaths(parent, merge);
    const result = timeSelection(changed);
    if (result === null) continue;
    samples.push(result.ms);
    process.stdout.write(
      `PR #${pr.number}: ${result.ms.toFixed(0)}ms (changed ${changed.length}, selected ${result.selected})\n`,
    );
  }
  if (samples.length === 0) {
    process.stderr.write('no samples collected\n');
    process.exit(1);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const p90 = quantile(sorted, 0.9);
  const max = sorted[sorted.length - 1]!;
  process.stdout.write('\n');
  process.stdout.write(`samples: ${sorted.length}\n`);
  process.stdout.write(`median:  ${(median / 1000).toFixed(2)}s\n`);
  process.stdout.write(`p90:     ${(p90 / 1000).toFixed(2)}s\n`);
  process.stdout.write(`max:     ${(max / 1000).toFixed(2)}s\n`);
}

main();
