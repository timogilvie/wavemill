#!/usr/bin/env -S npx tsx

import { resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { monitorCanaryCohortRefresh } from '../shared/lib/native-agent/certification/monitor-canary-cohort-refresh.ts';

runTool({
  name: 'monitor-canary-cohort-refresh',
  description: 'Run one interval-gated, attempt-guarded native canary cohort refresh.',
  options: {
    'repo-dir': {
      type: 'string',
      description: 'Repository directory containing .wavemill-config.json',
    },
  },
  async run({ args }) {
    const result = await monitorCanaryCohortRefresh({
      repoDir: resolve(args['repo-dir'] ?? process.cwd()),
    });
    console.log(JSON.stringify(result));
  },
});
