#!/usr/bin/env -S npx tsx

import { resolveRepoDir, runTool } from '../shared/lib/tool-runner.ts';
import {
  buildToolDecisionReport,
  renderToolDecisionReport,
} from '../shared/lib/tool-decision-report.ts';

runTool({
  name: 'tool-decision-report',
  description: 'Corpus-quality report for the native tool-decision corpus (HOK-2076).',
  options: {
    json: { type: 'boolean', description: 'Emit machine-readable JSON.' },
    'repo-dir': { type: 'string', description: 'Repository directory to inspect.' },
  },
  examples: [
    'npx tsx tools/tool-decision-report.ts',
    'npx tsx tools/tool-decision-report.ts --json',
  ],
  async run({ args }) {
    const repoDir = resolveRepoDir(args['repo-dir'] as string | undefined);
    const report = buildToolDecisionReport({ repoDir });

    console.log(args.json === true
      ? JSON.stringify(report, null, 2)
      : renderToolDecisionReport(report));

    if (report.status === 'no_records') {
      process.exit(2);
    }
  },
});
