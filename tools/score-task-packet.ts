/**
 * CLI tool: score a task packet for autonomous-execution readiness.
 *
 * Prints exactly one JSON object to stdout; diagnostics go to stderr.
 *
 * @example
 *   npx tsx tools/score-task-packet.ts path/to/task-packet.md
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import { extractPacketFeatures, TaskPacketNotFoundError } from '../shared/lib/task-packet-feature-extractor.ts';
import { scoreTaskPacket } from '../shared/lib/task-packet-scorer.ts';

await runTool({
  name: 'score-task-packet',
  description: 'Score a task packet for autonomous-execution readiness',
  options: {},
  positional: {
    name: 'packet-path',
    description: 'Path to a task packet file or artifact directory',
    required: true,
  },
  async run({ positional }) {
    const target = positional[0];
    if (!target) {
      console.error('Error: packet path is required');
      process.exit(1);
    }

    try {
      const features = await extractPacketFeatures(target);
      const result = scoreTaskPacket(features);
      console.log(JSON.stringify(result));
    } catch (err) {
      if (err instanceof TaskPacketNotFoundError) {
        console.error(`Error: Task packet not found at ${target}`);
        process.exit(1);
      }
      throw err;
    }
  },
});
