#!/usr/bin/env -S npx tsx
/**
 * Thin wrapper around runConsistencyCheck for the monitor tick (HOK-3184).
 *
 * Usage:
 *   npx tsx tools/ledger-check-consistency.ts --state-dir <dir> --issue <key>
 *     [--repo-dir <dir>] [--hook-file <path>] [--session-id <s>]
 *     [--evidence-window-ms <n>] [--json]
 */
import { runTool } from '../shared/lib/tool-runner.ts';
import { Ledger } from '../shared/lib/ledger.ts';
import { appendConsistencyLog, runConsistencyCheck } from '../shared/lib/ledger-consistency.ts';
import { withShadowSuppressing } from '../shared/lib/ledger-shadow.ts';

const required = (value: string | undefined, name: string): string => {
  if (!value) throw new Error(`missing ${name}`);
  return value;
};

runTool({
  name: 'ledger-check-consistency',
  description: 'Scan a task state directory for sentinel ↔ ledger disagreements.',
  options: {
    'repo-dir': { type: 'string', description: 'Milled repository directory' },
    'state-dir': { type: 'string', description: 'Task state directory (required)' },
    issue: { type: 'string', description: 'Linear issue key (required)' },
    'hook-file': { type: 'string', description: 'Override hook file path' },
    'session-id': { type: 'string', description: 'Override session id' },
    'evidence-window-ms': { type: 'string', description: 'Evidence window in ms' },
    json: { type: 'boolean', description: 'Print JSON summary' },
    strict: { type: 'boolean', description: 'Fail with non-zero exit on error' },
  },
  examples: [
    'npx tsx tools/ledger-check-consistency.ts --issue HOK-1234 --state-dir /path',
  ],
  run({ args }) {
    const stateDir = required(args['state-dir'], '--state-dir');
    const issue = required(args.issue, '--issue');
    const evidenceWindowMs = args['evidence-window-ms']
      ? Number.parseInt(args['evidence-window-ms'], 10)
      : undefined;
    const strict = args.strict === true;
    const runImpl = () => {
      const ledger = Ledger.open({ repoDir: args['repo-dir'] });
      try {
        const result = runConsistencyCheck({
          stateDir,
          issue,
          ledger,
          hookFilePath: args['hook-file'],
          sessionId: args['session-id'],
          evidenceWindowMs: Number.isFinite(evidenceWindowMs) ? evidenceWindowMs : undefined,
        });
        appendConsistencyLog(stateDir, result);
        return result;
      } finally {
        ledger.close();
      }
    };
    const result = strict ? runImpl() : withShadowSuppressing(runImpl);
    if (!result) {
      if (args.json) console.log(JSON.stringify({ shadow: 'suppressed' }));
      return;
    }
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const summary = result.disagreements.length === 0 ? 'OK' : `${result.disagreements.length} disagreement(s)`;
      console.log(`${result.issue} ${summary} (${result.tookMs}ms, steps=${result.scanned.steps})`);
      for (const d of result.disagreements) {
        console.log(`  [${d.severity}] ${d.category}: ${d.detail}`);
      }
    }
  },
});
