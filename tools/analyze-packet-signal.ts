#!/usr/bin/env tsx
import { analyzePacketSignal } from '../shared/lib/task-packet-signal-analysis.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

await runTool({
  name: 'analyze-packet-signal',
  description: 'Analyze task packet structure signal against historical eval outcomes',
  options: {
    'evals-dir': {
      type: 'string',
      description: 'Optional evals directory override',
    },
    'repo-dir': {
      type: 'string',
      description: 'Repository directory for eval path resolution',
    },
  },
  examples: [
    'npx tsx tools/analyze-packet-signal.ts',
    'npx tsx tools/analyze-packet-signal.ts --evals-dir .wavemill/evals',
  ],
  async run({ args }) {
    const result = await analyzePacketSignal({
      evalsDir: args['evals-dir'],
      repoDir: args['repo-dir'],
    });
    for (const warning of result.warnings) {
      process.stderr.write(`${warning}\n`);
    }
    process.stdout.write(`${result.report}\n`);
  },
});
