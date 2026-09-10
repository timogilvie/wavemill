#!/usr/bin/env -S npx tsx
import { resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { auditShadowLedger, formatAuditReport } from '../shared/lib/shadow-cleanup-audit.ts';

runTool({
  name: 'audit-shadow-cleanup',
  description: 'Audit the shadow cleanup decision ledger (HOK-2957) and report any unsafe-delete disagreements before enabling branchDeletion.mode=enforce.',
  options: {
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (defaults to CWD).',
    },
    json: {
      type: 'boolean',
      description: 'Emit JSON instead of the formatted report.',
    },
    'fail-on-disagreement': {
      type: 'boolean',
      description: 'Exit non-zero when the ledger contains disagreements.',
    },
  },
  examples: [
    'npx tsx tools/audit-shadow-cleanup.ts',
    'npx tsx tools/audit-shadow-cleanup.ts --json',
    'npx tsx tools/audit-shadow-cleanup.ts --fail-on-disagreement',
  ],
  additionalHelp: `Reads .wavemill/shadow/cleanup-decisions.jsonl (or the configured
cleanup.branchDeletion.ledgerPath) and reports:
  - counts by classification and mode
  - the agreement rate (safe deletes / proposed deletes)
  - any disagreements the operator must review before flipping
    cleanup.branchDeletion.mode from shadow to enforce.

Exit codes:
  0  audit report produced
  1  audit failed to run
  2  --fail-on-disagreement was set and disagreements exist`,
  run({ args }) {
    const repoDir = resolve(String(args['repo-dir'] ?? '.'));
    const summary = auditShadowLedger(repoDir);
    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(formatAuditReport(summary));
    }
    if (args['fail-on-disagreement'] && summary.disagreements.length > 0) {
      process.exit(2);
    }
  },
});
