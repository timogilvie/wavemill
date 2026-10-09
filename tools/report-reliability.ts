#!/usr/bin/env -S npx tsx
/**
 * HOK-3177 — `wavemill report reliability` CLI.
 *
 * Prints the unattended-rate + time-stuck summary over a configurable window.
 * Pure wrapper over `shared/lib/reliability-metrics.ts`.
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  computeReliability,
  parseWindow,
  renderReliabilitySummary,
} from '../shared/lib/reliability-metrics.ts';

runTool({
  name: 'report-reliability',
  description: 'Report unattended-rate and time-stuck reliability metrics.',
  options: {
    since: {
      type: 'string',
      description: 'Window (e.g. 14d, 7d, 48h). Default: 14d.',
      default: '14d',
    },
    bucket: {
      type: 'string',
      description: 'Aggregation bucket: daily | rolling7d. Default: rolling7d.',
      default: 'rolling7d',
    },
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (default: cwd).',
    },
    json: {
      type: 'boolean',
      description: 'Emit JSON instead of human-readable text.',
      default: false,
    },
    'include-tasks': {
      type: 'boolean',
      description: 'Include per-task table in human output.',
      default: false,
    },
    branches: {
      type: 'string',
      description: 'Comma-separated branch list to scan for merges.',
    },
    'stall-minutes': {
      type: 'string',
      description: 'Override stall threshold (minutes). Default: 30.',
    },
  },
  examples: [
    'wavemill report reliability --since 14d',
    'wavemill report reliability --since 7d --bucket daily --include-tasks',
    'wavemill report reliability --json',
  ],
  async run({ args }) {
    const sinceSpec = (args.since as string) ?? '14d';
    const bucketRaw = (args.bucket as string) ?? 'rolling7d';
    const bucket: 'daily' | 'rolling7d' = bucketRaw === 'daily' ? 'daily' : 'rolling7d';
    const repoDir = (args['repo-dir'] as string) ?? process.cwd();
    const branchesRaw = args.branches as string | undefined;
    const branches = branchesRaw ? branchesRaw.split(',').map((b) => b.trim()).filter(Boolean) : undefined;
    const stallMinutesRaw = args['stall-minutes'] as string | undefined;
    const stallMinutes = stallMinutesRaw ? Number.parseInt(stallMinutesRaw, 10) : undefined;

    const { since, until } = parseWindow(sinceSpec);
    const summary = computeReliability({
      repoDir,
      sinceIso: since,
      untilIso: until,
      bucket,
      branches,
      stallMinutes: stallMinutes && Number.isFinite(stallMinutes) ? stallMinutes : undefined,
    });

    if (args.json) {
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      return;
    }

    const text = renderReliabilitySummary(summary, {
      color: process.stdout.isTTY,
      includeTaskTable: Boolean(args['include-tasks']),
    });
    process.stdout.write(text + '\n');
  },
});
