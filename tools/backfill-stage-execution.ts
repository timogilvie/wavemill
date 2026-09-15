#!/usr/bin/env -S npx tsx
/** CLI wrapper for retained-session stage execution evidence recovery. */

import { resolve } from 'node:path';
import { backfillStageExecutionEvidence } from '../shared/lib/stage-execution-backfill.ts';
import type { StageName } from '../shared/lib/stage-result.ts';

function flags(argv: string[]): Record<string, string | boolean> {
  const output: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) output[key.slice(2)] = true;
    else { output[key.slice(2)] = value; index++; }
  }
  return output;
}

async function main(): Promise<void> {
  const args = flags(process.argv.slice(2));
  const directory = typeof args['feature-dir'] === 'string' ? args['feature-dir'] : typeof args['artifacts-dir'] === 'string' ? args['artifacts-dir'] : '';
  const worktreePath = typeof args.worktree === 'string' ? args.worktree : '';
  const branchName = typeof args.branch === 'string' ? args.branch : '';
  if (!directory || !worktreePath || !branchName) {
    throw new Error('usage: --feature-dir <dir> | --artifacts-dir <dir> --worktree <path> --branch <name> [--stage planning|coding|review|all] [--dry-run]');
  }
  const selected = typeof args.stage === 'string' ? args.stage : 'all';
  if (!['planning', 'coding', 'review', 'all'].includes(selected)) throw new Error(`invalid --stage '${selected}'`);
  const reports = await backfillStageExecutionEvidence({
    directory: resolve(directory), archived: typeof args['artifacts-dir'] === 'string', worktreePath, branchName,
    repoDir: process.cwd(), stages: selected === 'all' ? undefined : [selected as StageName], dryRun: args['dry-run'] === true,
  });
  for (const report of reports) {
    console.log(`${report.stage}: ${report.outcome} ${report.previousExecutedModel ?? 'null'} -> ${report.executedModel ?? 'null'} evidence=${report.evidenceStatus} eligible=${report.modelAttributionEligible} ${report.detail}`);
  }
}

main().catch((error) => { console.error(`Error: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
