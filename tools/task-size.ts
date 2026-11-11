#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { acceptSplitProposal, overrideSizeHold } from '../shared/lib/task-split.ts';
import { getTaskSizeConfig } from '../shared/lib/config.ts';
import {
  buildSizeReport,
  fetchMergedPrSizes,
  readSizeEstimateRows,
  renderSizeReport,
} from '../shared/lib/task-size-report.ts';

const COMMANDS = ['accept', 'override', 'report'] as const;

runTool({
  name: 'task-size',
  description: 'Split an oversized task, release one size hold, or report estimates vs actuals',
  options: {
    reason: { type: 'string', description: 'Why the size hold is being overridden (override)' },
    days: { type: 'string', description: 'Report window in days (default: 30)' },
    base: { type: 'string', description: 'Report merged PRs into this base branch (default: auto/integration)' },
    json: { type: 'boolean', description: 'Emit the report as JSON' },
    'repo-dir': { type: 'string', description: 'Repository root (default: current directory)' },
  },
  positional: {
    name: 'command',
    description: 'accept <ID> | override <ID> [reason] | report',
    required: true,
    multiple: true,
  },
  examples: [
    'npx tsx tools/task-size.ts accept HOK-123',
    'npx tsx tools/task-size.ts override HOK-123 --reason "single-file change, estimates are stale"',
    'npx tsx tools/task-size.ts report --days 30',
    'npx tsx tools/task-size.ts report --json',
  ],
  additionalHelp: `Commands:
  accept <ID>          Create the task's proposed slices as ordered sub-issues
  override <ID>        Release the size hold for this one task (needs a reason)
  report               Compare recorded estimates with merged PR sizes`,
  async run({ args, positional }) {
    const command = positional[0];
    if (!COMMANDS.includes(command as (typeof COMMANDS)[number])) {
      throw new Error(`Unknown command "${command}". Expected one of: ${COMMANDS.join(', ')}`);
    }
    const repoDir = (args['repo-dir'] as string) || process.cwd();

    if (command === 'accept') {
      const issueId = positional[1];
      if (!issueId) throw new Error('Usage: task-size accept <ID>');
      const result = await acceptSplitProposal(issueId, { repoDir, log: (message) => console.log(message) });
      console.log(
        `\n${result.parent.identifier} split into ${result.created.length} slice(s): ` +
          result.created.map((issue) => issue.identifier).join(', '),
      );
      return;
    }

    if (command === 'override') {
      const issueId = positional[1];
      if (!issueId) throw new Error('Usage: task-size override <ID> [reason]');
      const reason = (args.reason as string | undefined) || positional.slice(2).join(' ');
      if (!reason) throw new Error('override needs a reason (--reason or a trailing argument)');
      const result = await overrideSizeHold(issueId, reason, {
        repoDir,
        log: (message) => console.log(message),
      });
      const estimate = result.estimate?.addedLines;
      console.log(
        `${result.issueId}: ${result.labelAdded ? 'size hold overridden' : 'already overridden'}` +
          (estimate === null || estimate === undefined ? '' : ` (estimated ~${estimate} added lines)`),
      );
      console.log(`Reason: ${result.reason}`);
      return;
    }

    // report
    const daysArg = args.days as string | undefined;
    const days = daysArg === undefined ? 30 : Number.parseInt(daysArg, 10);
    if (!Number.isFinite(days) || days <= 0) throw new Error(`--days must be a positive integer, got "${daysArg}"`);
    const report = buildSizeReport({
      estimates: readSizeEstimateRows(repoDir),
      pullRequests: fetchMergedPrSizes(repoDir, {
        base: (args.base as string | undefined) || 'auto/integration',
        since: new Date(Date.now() - days * 24 * 60 * 60 * 1000),
      }),
      days,
      limits: getTaskSizeConfig(repoDir),
    });
    console.log(args.json ? JSON.stringify(report, null, 2) : renderSizeReport(report));
  },
});
