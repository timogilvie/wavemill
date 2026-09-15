/**
 * CLI tool: analyze whether task packet structure predicts intervention outcomes.
 *
 * Runs a logistic regression over historical eval data controlling for difficulty,
 * then prints a go/no-go recommendation for the task scorer.
 *
 * @example
 *   npx tsx tools/analyze-packet-signal.ts
 *   npx tsx tools/analyze-packet-signal.ts --evals-dir /path/to/.wavemill/evals
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import { analyzePacketSignal, formatReport } from '../shared/lib/packet-signal-analyzer.ts';

await runTool({
  name: 'analyze-packet-signal',
  description: 'Analyze packet-structure signal vs intervention outcomes',
  options: {
    'evals-dir': {
      type: 'string',
      description: 'Path to the evals directory (default: resolved from config)',
    },
  },
  async run({ args }) {
    const evalsDir = args['evals-dir'] as string | undefined;
    const report = await analyzePacketSignal(undefined, evalsDir);

    if (report.sampleSize === 0) {
      console.log('No evaluation data found.');
      return;
    }

    console.log(formatReport(report));
  },
});
