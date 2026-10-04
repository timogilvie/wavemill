#!/usr/bin/env tsx
import { extractPacketFeatures } from '../shared/lib/task-packet-feature-extractor.ts';
import { scoreTaskPacket } from '../shared/lib/task-packet-scorer.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

await runTool({
  name: 'score-task-packet',
  description: 'Score a task packet for autonomous execution readiness',
  options: {},
  positional: {
    name: 'packet-path',
    description: 'Task packet file or artifact directory to score',
    required: true,
  },
  examples: [
    'npx tsx tools/score-task-packet.ts features/example/task-packet.md',
  ],
  async run({ positional }) {
    const features = await extractPacketFeatures(positional[0]);
    const result = scoreTaskPacket(features);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  },
});
