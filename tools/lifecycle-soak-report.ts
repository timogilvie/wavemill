#!/usr/bin/env -S npx tsx
import { resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { generateSoakReport, formatSoakReport } from '../shared/lib/lifecycle-soak.ts';

runTool({
  name: 'lifecycle-soak-report',
  description: 'Generate a soak-gate report from monitor timing + cleanup episodes + shadow ledger + preserved-branch markers (HOK-2957 Phase 6).',
  options: {
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (defaults to CWD).',
    },
    'state-dir': {
      type: 'string',
      description: 'Override for $repoDir/.wavemill.',
    },
    'max-attempts': {
      type: 'string',
      description: 'Cleanup episodes with attemptCount greater than this are counted as leaks (default 3).',
    },
    json: {
      type: 'boolean',
      description: 'Emit JSON verdict instead of the plain-text report.',
    },
  },
  examples: [
    'npx tsx tools/lifecycle-soak-report.ts',
    'npx tsx tools/lifecycle-soak-report.ts --repo-dir /path/to/repo --json',
  ],
  run({ args }) {
    const repoDir = resolve(String(args['repo-dir'] ?? '.'));
    const stateDir = args['state-dir'] ? resolve(String(args['state-dir'])) : undefined;
    const maxAttempts = args['max-attempts'] ? Number(args['max-attempts']) : undefined;
    const report = generateSoakReport({ repoDir, stateDir, maxRepeatedAttempts: maxAttempts });
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatSoakReport(report));
    }
    process.exit(report.pass ? 0 : 2);
  },
});
