#!/usr/bin/env -S npx tsx

import { resolveRepoDir, runTool } from '../shared/lib/tool-runner.ts';
import {
  buildExecutionEconomicsReport,
  renderExecutionEconomicsReport,
} from '../shared/lib/execution-economics-report.ts';

runTool({
  name: 'execution-economics-report',
  description: 'Corpus-quality report for normalized external-harness execution economics (HOK-2958).',
  options: {
    json: { type: 'boolean', description: 'Emit machine-readable JSON.' },
    'repo-dir': { type: 'string', description: 'Repository directory to inspect.' },
    'evals-path': { type: 'string', description: 'Explicit evals.jsonl path (overrides repo resolution).' },
  },
  examples: [
    'npx tsx tools/execution-economics-report.ts',
    'npx tsx tools/execution-economics-report.ts --json',
    'npx tsx tools/execution-economics-report.ts --repo-dir ~/src/wavemill --evals-path /tmp/evals.jsonl',
  ],
  async run({ args }) {
    const repoDir = resolveRepoDir(args['repo-dir'] as string | undefined);
    const report = buildExecutionEconomicsReport({
      repoDir,
      evalsPath: args['evals-path'] as string | undefined,
    });

    console.log(args.json === true
      ? JSON.stringify(report, null, 2)
      : renderExecutionEconomicsReport(report));

    if (report.status === 'no_records') {
      // Informational, not a gate: distinct non-zero exit only for "nothing to report".
      process.exit(2);
    }
  },
});
