#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { compact, drain, enqueue } from '../shared/lib/linear-retry-queue.ts';
import { partitionLinearWriteTargets, setTaskIssuesState } from '../shared/lib/linear-write-gate.ts';

runTool({
  name: 'linear-retry-drain',
  description: 'Manage the background queue for retrying Linear state updates',
  options: {
    state: { type: 'string', description: 'Target Linear state' },
    issues: { type: 'string', description: 'Comma-separated issue identifiers' },
    category: { type: 'string', description: 'Last failure category' },
    http: { type: 'string', description: 'Last failure HTTP status or "none"' },
    message: { type: 'string', description: 'Last failure message' },
    'max-entries': { type: 'string', description: 'Maximum queued entries to process', default: '10' },
  },
  positional: {
    name: 'command',
    description: 'One of: enqueue, drain, compact',
    required: true,
  },
  examples: [
    'npx tsx tools/linear-retry-drain.ts enqueue --state "In Progress" --issues HOK-1,HOK-2 --category rate_limit --http 429',
    'npx tsx tools/linear-retry-drain.ts drain --max-entries 10',
    'npx tsx tools/linear-retry-drain.ts compact',
  ],
  async run({ positional, args }) {
    const command = positional[0];

    if (command === 'enqueue') {
      if (!args.state || !args.issues) {
        throw new Error('enqueue requires --state and --issues');
      }
      const httpStatus = !args.http || args.http === 'none' ? null : Number(args.http);
      const requested = args.issues.split(',').map((value) => value.trim()).filter(Boolean);
      // Only Linear writers are queued; challengers are skipped and invalid
      // IDs are dropped (HOK-3115).
      const { linearIds: issueIds, skipped, rejected } = partitionLinearWriteTargets(requested);
      for (const decision of [...skipped, ...rejected]) {
        console.error(`↷ not queued: ${decision.message}`);
      }
      if (issueIds.length === 0) {
        console.log(JSON.stringify({ queued: false, issues: [] }, null, 2));
        return;
      }
      const record = enqueue({
        issueIds,
        targetState: args.state,
        lastError: {
          category: (args.category as 'network' | 'rate_limit' | 'auth' | 'graphql' | 'server' | 'client' | 'unknown') || 'unknown',
          httpStatus: Number.isFinite(httpStatus) ? httpStatus : null,
          graphqlErrors: [],
          isRetryable: true,
          message: args.message || 'Queued from startup batch retry path',
          error: args.message || 'Queued from startup batch retry path',
        },
      });
      console.log(JSON.stringify({ queued: true, id: record.id, issues: record.issueIds }, null, 2));
      return;
    }

    if (command === 'drain') {
      const summary = await drain({
        maxEntries: Number.parseInt(args['max-entries'] || '10', 10),
        // Entries queued before HOK-3115 may hold challenger or invalid IDs;
        // re-gate every drain attempt.
        setIssuesStateImpl: (issueIds, stateName) => setTaskIssuesState(issueIds, stateName),
      });
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    if (command === 'compact') {
      await compact();
      console.log(JSON.stringify({ compacted: true }, null, 2));
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  },
});
