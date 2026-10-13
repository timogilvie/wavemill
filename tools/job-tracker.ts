#!/usr/bin/env -S npx tsx

import {
  buildJobId,
  formatJobSummary,
  isCheckJobKind,
  launchJob,
  markJobSettled,
  pollJobs,
  type MillJob,
} from '../shared/lib/job-tracker.ts';

const USAGE = `job-tracker — manage monitored background jobs (challenge eval/comparison, HOK-3206 ready checks)

Subcommands:
  launch         Persist a newly launched background job
  poll           Refresh running jobs and print terminal unsettled jobs
  mark-settled   Mark a terminal job as processed by the monitor
`;

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return flags;
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value) {
    throw new Error(`Missing required flag --${name}`);
  }
  return value;
}

function parsePrNumbers(value: string): number[] {
  return value
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((part) => Number.isFinite(part));
}

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(USAGE);
    return;
  }

  const flags = parseFlags(rest);

  if (subcommand === 'launch') {
    const kind = requireFlag(flags, 'kind');
    if (kind !== 'eval' && kind !== 'comparison' && !isCheckJobKind(kind)) {
      throw new Error(`Unknown job kind: ${kind}`);
    }
    // Check kinds may have no PR (e.g. the global ready-watchdog job).
    const prNumbers = parsePrNumbers(isCheckJobKind(kind) ? (flags['pr-numbers'] ?? '') : requireFlag(flags, 'pr-numbers'));
    const job: MillJob = {
      id: flags['job-id'] || buildJobId({
        kind,
        issueId: flags['issue-id'],
        side: flags.side,
        pairId: flags['pair-id'],
        prNumbers,
      }),
      kind,
      session: flags.session,
      issueId: flags['issue-id'],
      side: flags.side,
      pairId: flags['pair-id'],
      prNumbers,
      pid: Number.parseInt(requireFlag(flags, 'pid'), 10),
      startedAt: flags['started-at'] || new Date().toISOString(),
      timeoutSeconds: Number.parseInt(requireFlag(flags, 'timeout-seconds'), 10),
      logPath: requireFlag(flags, 'log-path'),
      resultPath: requireFlag(flags, 'result-path'),
      status: 'running',
      exitCode: null,
      finishedAt: null,
      reason: null,
      excerpt: null,
      settled: false,
    };

    const stored = await launchJob({
      statePath: requireFlag(flags, 'state-file'),
      job,
    });
    console.log(JSON.stringify(stored, null, 2));
    return;
  }

  if (subcommand === 'poll') {
    const result = await pollJobs({
      statePath: requireFlag(flags, 'state-file'),
    });
    console.log(JSON.stringify({
      changed: result.changed,
      unsettled: result.unsettled,
      summaries: result.changed.map((job) => formatJobSummary(job)),
    }, null, 2));
    return;
  }

  if (subcommand === 'mark-settled') {
    const job = await markJobSettled({
      statePath: requireFlag(flags, 'state-file'),
      jobId: requireFlag(flags, 'job-id'),
    });
    console.log(JSON.stringify(job, null, 2));
    return;
  }

  throw new Error(`Unknown subcommand: ${subcommand}`);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
