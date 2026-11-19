#!/usr/bin/env -S npx tsx
/**
 * Report how often each preflight guard fired, from the `preflight-guards`
 * records CI uploads (tools/run-preflight.ts --record). Use it before retiring
 * or merging a guard. Read-only apart from a temporary download directory.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  aggregateGuardFires,
  formatGuardFireReport,
  isPreflightRunRecord,
  type SourcedPreflightRun,
} from '../shared/lib/preflight-runner.ts';

const ARTIFACT = 'preflight-guards';

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

/** Every JSON record under `dir`; the first path segment below `dir` is the branch label. */
function readRecords(dir: string, branchOf: (label: string) => string): SourcedPreflightRun[] {
  const runs: SourcedPreflightRun[] = [];
  const walk = (current: string, label: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) {
        walk(path, label || name);
      } else if (name.endsWith('.json')) {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
        if (isPreflightRunRecord(parsed)) runs.push({ record: parsed, branch: branchOf(label || name) });
      }
    }
  };
  walk(dir, '');
  return runs;
}

function downloadFromCi(days: number, workflow: string, dir: string): Map<string, string> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const listed = JSON.parse(gh([
    'run', 'list', '--workflow', workflow, '--created', `>=${since}`, '--limit', '1000',
    '--json', 'databaseId,headBranch,status',
  ])) as Array<{ databaseId: number; headBranch: string; status: string }>;
  const branches = new Map<string, string>();
  for (const run of listed.filter((row) => row.status === 'completed')) {
    try {
      // Runs from before the recorder, or with an expired artifact, have nothing to download.
      execFileSync('gh', ['run', 'download', String(run.databaseId), '--name', ARTIFACT, '--dir', join(dir, String(run.databaseId))], { stdio: 'ignore' });
      branches.set(String(run.databaseId), run.headBranch);
    } catch { /* no artifact for this run */ }
  }
  return branches;
}

runTool({
  name: 'report-guard-fires',
  description: 'Count how often each preflight guard failed across recorded CI runs',
  options: {
    days: { type: 'string', description: 'Look back this many days of CI runs (default: 30)' },
    workflow: { type: 'string', description: 'Workflow file to read runs from (default: ci.yml)' },
    dir: { type: 'string', description: 'Read records from this directory instead of downloading from CI' },
    json: { type: 'boolean', description: 'Print the per-guard rows as JSON' },
  },
  examples: ['npx tsx tools/report-guard-fires.ts --days 21', 'npx tsx tools/report-guard-fires.ts --dir ./records --json'],
  run({ args }) {
    let runs: SourcedPreflightRun[];
    if (args.dir) {
      runs = readRecords(args.dir as string, (label) => label);
    } else {
      const dir = mkdtempSync(join(tmpdir(), 'guard-fires-'));
      try {
        const branches = downloadFromCi(Number.parseInt((args.days as string | undefined) ?? '30', 10), (args.workflow as string | undefined) ?? 'ci.yml', dir);
        runs = readRecords(dir, (label) => branches.get(label) ?? label);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const stats = aggregateGuardFires(runs);
    console.log(args.json ? JSON.stringify({ runs: runs.length, guards: stats }, null, 2) : formatGuardFireReport(stats, runs.length));
  },
});
