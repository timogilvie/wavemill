#!/usr/bin/env -S npx tsx
/**
 * Weekly consolidation scorecard (HOK-3470): reports the size of production
 * code and how many consolidation exceptions were used in the last 7 days.
 *
 * Production lines use the same predicate as the CI gate
 * (`isProductionFile` in `tools/check-consolidation.ts`), so the scorecard and
 * the gate can never disagree about what counts. The scorecard is on-demand;
 * nothing schedules it. Run it from the repository root:
 *
 *   npx tsx tools/weekly-scorecard.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import { escapeShellArg, execShellCommand } from '../shared/lib/shell-utils.ts';
import { EXCEPTION_RE, isProductionFile } from './check-consolidation.ts';

/** Test seam: git/gh invocation and file reads. */
export const scorecardDeps = { execShellCommand, readFile: readFileSync, warn: console.warn };

const MONITOR_FILE = 'shared/lib/wavemill-monitor.sh';
const EXCEPTIONS_WINDOW_DAYS = 7;
const LABEL_WIDTH = 33;

export interface ScorecardException { pr: number; reason: string }

export interface Scorecard {
  date: string;
  totalProductionLines: number;
  monitorLines: number;
  /** Null means the merged-PR read failed; never report it as zero. */
  exceptions: ScorecardException[] | null;
}

function listProductionFiles(repoDir: string): string[] {
  const output = String(scorecardDeps.execShellCommand('git ls-files -- shared/lib shared/hooks tools', {
    cwd: repoDir, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024,
  }));
  return output.split('\n').map((file) => file.trim()).filter((file) => file !== '' && isProductionFile(file));
}

function countLines(files: readonly string[], repoDir: string): number {
  let total = 0;
  for (const file of files) {
    try {
      total += (scorecardDeps.readFile(join(repoDir, file), 'utf-8').match(/\n/g) ?? []).length;
    } catch {
      scorecardDeps.warn(`warn: could not read ${file}`);
    }
  }
  return total;
}

/** Merged `consolidation` PRs in the window whose body records an exception. */
export function countExceptions(repoDir: string, since: string): ScorecardException[] | null {
  const search = `label:consolidation merged:>=${since}`;
  try {
    const json = String(scorecardDeps.execShellCommand(
      `gh pr list --state merged --search ${escapeShellArg(search)} --json number,body --limit 200`,
      { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe' },
    ));
    const prs = JSON.parse(json) as Array<{ number: number; body?: string | null }>;
    return prs.flatMap((entry) => {
      const reason = (entry.body ?? '').match(EXCEPTION_RE)?.[1]?.trim();
      return reason ? [{ pr: entry.number, reason }] : [];
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    scorecardDeps.warn(`warn: could not read merged consolidation PRs: ${message}`);
    return null;
  }
}

export function buildScorecard(repoDir: string, now = new Date()): Scorecard {
  const iso = (date: Date): string => date.toISOString().slice(0, 10);
  const since = iso(new Date(now.getTime() - EXCEPTIONS_WINDOW_DAYS * 24 * 60 * 60 * 1000));
  return {
    date: iso(now),
    totalProductionLines: countLines(listProductionFiles(repoDir), repoDir),
    monitorLines: countLines([MONITOR_FILE], repoDir),
    exceptions: countExceptions(repoDir, since),
  };
}

export function formatScorecard(scorecard: Scorecard): string {
  const used = scorecard.exceptions === null ? '[Unavailable]' : String(scorecard.exceptions.length);
  const row = (label: string, value: string): string => `${label.padEnd(LABEL_WIDTH)}${value}`;
  return [
    `=== Weekly Consolidation Scorecard (${scorecard.date}) ===`,
    row('Total production lines:', scorecard.totalProductionLines.toLocaleString('en-US')),
    row(`${MONITOR_FILE}:`, scorecard.monitorLines.toLocaleString('en-US')),
    row(`Exceptions used (last ${EXCEPTIONS_WINDOW_DAYS} days):`, used),
    ...(scorecard.exceptions ?? []).map((entry) => `  - #${entry.pr}: ${entry.reason}`),
  ].join('\n');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) runTool({
  name: 'weekly-scorecard',
  description: 'Report production line counts and consolidation exceptions used in the last 7 days',
  options: {
    'repo-dir': { type: 'string', description: 'Repository directory (default: current directory)' },
  },
  examples: ['npx tsx tools/weekly-scorecard.ts'],
  async run({ args }) {
    const repoDir = resolveRepoDir(args['repo-dir'] as string | undefined);
    console.log(formatScorecard(buildScorecard(repoDir)));
  },
});
