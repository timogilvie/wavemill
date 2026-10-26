#!/usr/bin/env -S npx tsx
/**
 * HOK-3314: stamp the current {@link QueueAlertProjection} into
 * `.wavemill/queue-health.json` as `.currentAlertProjection` so shell renderers
 * (`queue_health_dashboard_warning`, `queue_health_dashboard_status`,
 * `queue_health_status_summary`, `queue_inference_degraded_banner`) can read
 * one jq field instead of each re-deriving status / severity / wording from
 * raw queue-health fields.
 *
 * Called once per planner cycle by the shell writers in queue-health.sh.
 * Shell renderers never spawn this directly; they read the stamped block.
 *
 * Usage:
 *   npx tsx tools/queue-alert-projection.ts --state-dir <path>
 *   # or pipe queue-health.json on stdin and read projection from stdout:
 *   cat queue-health.json | npx tsx tools/queue-alert-projection.ts --stdin
 */
import { existsSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { mutateJsonState } from '../shared/lib/state-mutex.ts';
import { deriveQueueAlertProjection, type QueueAlertProjection, type QueueHealthStateLike } from '../shared/lib/queue-inference-status.ts';

interface QueueHealthFile extends QueueHealthStateLike {
  currentAlertProjection?: unknown;
  [key: string]: unknown;
}

function readStdinSync(): string {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(65_536);
  while (true) {
    let bytesRead = 0;
    try {
      bytesRead = readSync(0, buffer, 0, buffer.length, null);
    } catch {
      break;
    }
    if (bytesRead <= 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function extractPreviousEpisode(block: unknown): QueueAlertProjection['episode'] | null {
  if (!block || typeof block !== 'object') return null;
  const episode = (block as Record<string, unknown>).episode;
  if (!episode || typeof episode !== 'object') return null;
  const rec = episode as Record<string, unknown>;
  if (typeof rec.id !== 'string' || typeof rec.startedAt !== 'string') return null;
  const kind = rec.kind === 'planner' ? 'planner' : 'inference';
  const consecutive = typeof rec.consecutiveFailedAttempts === 'number' ? rec.consecutiveFailedAttempts : 0;
  const severity = rec.severity === 'high' || rec.severity === 'medium' ? rec.severity : 'low';
  return {
    id: rec.id,
    kind,
    startedAt: rec.startedAt as string,
    consecutiveFailedAttempts: consecutive,
    latestFailureAt: typeof rec.latestFailureAt === 'string' ? rec.latestFailureAt : null,
    latestSuccessAt: typeof rec.latestSuccessAt === 'string' ? rec.latestSuccessAt : null,
    severity,
  };
}

runTool({
  name: 'queue-alert-projection',
  description: 'Stamp the current queue-alert projection into .wavemill/queue-health.json',
  options: {
    'state-dir': { type: 'string', description: 'Path to the .wavemill state directory' },
    stdin: { type: 'boolean', description: 'Read queue-health.json from stdin and print projection to stdout (no write)' },
  },
  async run({ args }) {
    if (args.stdin) {
      const raw = readStdinSync();
      let health: QueueHealthFile | undefined;
      try {
        health = raw.trim() ? (JSON.parse(raw) as QueueHealthFile) : undefined;
      } catch {
        health = undefined;
      }
      const projection = deriveQueueAlertProjection({
        queueHealth: health,
        previousEpisode: extractPreviousEpisode(health?.currentAlertProjection),
        nowMs: Date.now(),
      });
      process.stdout.write(`${JSON.stringify(projection, null, 2)}\n`);
      return;
    }

    const stateDir = args['state-dir'];
    if (!stateDir) throw new Error('Usage: --state-dir <path> (or --stdin to pipe queue-health.json)');
    const healthFile = join(stateDir, 'queue-health.json');
    if (!existsSync(healthFile)) {
      process.stderr.write(`queue-alert-projection: ${healthFile} not found; nothing to stamp\n`);
      return;
    }

    await mutateJsonState<QueueHealthFile>(healthFile, (health) => {
      const projection = deriveQueueAlertProjection({
        queueHealth: health,
        previousEpisode: extractPreviousEpisode(health?.currentAlertProjection),
        nowMs: Date.now(),
      });
      return { ...(health ?? {}), currentAlertProjection: projection };
    }, { createIfMissing: false });
  },
});
