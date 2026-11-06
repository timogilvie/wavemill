#!/usr/bin/env -S npx tsx
/**
 * HOK-3423 — the attention-projection tracked job. Reads every attention
 * source, derives the one projection (`deriveAttentionItems`) and atomically
 * writes `.wavemill/attention.json`, stamped with the monitor pass it was
 * computed against. Launched by `monitor_attention_projection_tick`
 * (monitor-async-jobs.sh); a non-zero exit charges the job's bucket.
 *
 * Usage:
 *   npx tsx tools/attention-projection.ts --repo-dir <dir> [--state-dir <dir>]
 *     [--output <path>] [--pass-stamp-ms <ms>] [--stale-after-seconds <s>] [--json]
 */
import { join } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  ATTENTION_PROJECTION_FILE,
  deriveAttentionItems,
  gatherAttentionInputs,
  writeAttentionProjection,
} from '../shared/lib/attention.ts';

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

runTool({
  name: 'attention-projection',
  description: 'Derive the one attention projection (HOK-3423) and write .wavemill/attention.json.',
  options: {
    'repo-dir': { type: 'string', description: 'Milled repository directory (default: cwd)' },
    'state-dir': { type: 'string', description: 'State dir (default: <repo-dir>/.wavemill)' },
    'state-file': { type: 'string', description: 'workflow-state.json (default: <state-dir>/workflow-state.json)' },
    output: { type: 'string', description: 'Projection path (default: <state-dir>/attention.json)' },
    session: { type: 'string', description: 'Wavemill session (default $WAVEMILL_SESSION / $SESSION)' },
    'pass-stamp-ms': { type: 'string', description: 'Monitor pass start (epoch ms) this projection is computed against' },
    'stale-after-seconds': { type: 'string', description: 'Readers treat the projection as stale this long after the pass (default 70)' },
    json: { type: 'boolean', description: 'Print the projection on stdout' },
  },
  examples: ['npx tsx tools/attention-projection.ts --repo-dir . --json'],
  async run({ args }) {
    const repoDir = args['repo-dir'] ?? process.cwd();
    const stateDir = args['state-dir'] ?? join(repoDir, '.wavemill');
    const nowMs = Date.now();
    const passStampMs = positiveInt(args['pass-stamp-ms'], nowMs);
    const staleAfterMs = passStampMs + positiveInt(args['stale-after-seconds'], 70) * 1000;
    const inputs = await gatherAttentionInputs({
      repoDir,
      stateDir,
      ...(args['state-file'] ? { stateFile: args['state-file'] } : {}),
      session: args.session || process.env.WAVEMILL_SESSION || process.env.SESSION || 'wavemill',
      passStampMs,
      staleAfterMs,
      nowMs,
    });
    const projection = deriveAttentionItems(inputs);
    writeAttentionProjection(args.output ?? join(stateDir, ATTENTION_PROJECTION_FILE), projection);
    if (args.json) console.log(JSON.stringify(projection, null, 2));
  },
});
