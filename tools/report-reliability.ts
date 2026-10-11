#!/usr/bin/env -S npx tsx
/**
 * HOK-3177 / HOK-3182 — `wavemill report reliability` CLI.
 *
 * Prints the unattended-rate, time-stuck p50/p90 and per-class (O/L/S/R)
 * operator touch summary over a configurable window. Pure wrapper over
 * `shared/lib/reliability-metrics.ts`.
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
      description: 'Window (e.g. 14d, 7d, 48h) or start date (e.g. 2026-09-25). Default: 14d.',
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
    'include-classes': {
      type: 'boolean',
      description: 'Add per-class (O/L/S/R) touch counts to the per-task table.',
      default: false,
    },
    pr: {
      type: 'string',
      description: 'Comma-separated PR numbers to spot-check (merged or closed, in or out of the window).',
    },
    'no-github': {
      type: 'boolean',
      description: 'Skip GitHub PR timelines (label edits, manual pushes); report local evidence only.',
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
    'wavemill report reliability --since 2026-09-25 --pr 1594,1598,1601,1603',
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
    const prRaw = args.pr as string | undefined;
    const spotCheckPrs = prRaw ? prRaw.split(',').map((p) => p.trim().replace(/^#/, '')).filter(Boolean) : undefined;

    const { since, until } = parseWindow(sinceSpec);
    const summary = computeReliability({
      repoDir,
      sinceIso: since,
      untilIso: until,
      bucket,
      branches,
      stallMinutes: stallMinutes && Number.isFinite(stallMinutes) ? stallMinutes : undefined,
      github: args['no-github'] ? false : undefined,
      spotCheckPrs,
    });

    if (args.json) {
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      return;
    }

    const text = renderReliabilitySummary(summary, {
      color: process.stdout.isTTY,
      includeTaskTable: Boolean(args['include-tasks']),
      includeClasses: Boolean(args['include-classes']),
    });
    process.stdout.write(text + '\n');
  },
});
