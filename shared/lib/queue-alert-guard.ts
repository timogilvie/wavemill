// allow-queue-alert: this file *is* the queue-alert guard; its pattern table
// names every forbidden shape. It is auto-excluded from its own scan via
// invariantPaths; the marker above is defensive.
/**
 * Preflight guard for the single queue-alert projection (HOK-3314): the
 * answer to "is this queue condition active, how severe, and what episode?"
 * is decided only by `deriveQueueAlertProjection` in
 * `shared/lib/queue-inference-status.ts` and routed through
 * `tools/queue-alert-projection.ts`. Private severity ladders, episode-start
 * synthesis, or ad-hoc inference-status severity decisions elsewhere are
 * exactly what the invariant forbids.
 *
 * Shapes caught:
 * - `episodeStartedAt = \`inference:...\`` — the pre-HOK-3314 inline synthesis
 *   that observer.ts used to build a stable (but wrong) fingerprint from
 *   `inference.lastSuccessAt`. The projection owns episode identity now.
 * - Hard-coded ≥5 severity ladders over `failureCount` / `consecutiveFailures`.
 * - A `QUEUE_INFERENCE_STUCK_THRESHOLD`-style private constant.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const QUEUE_ALERT_GUARD: GuardSpec = {
  name: 'queue-alert',
  findingNoun: 'private queue-alert decision site(s)',
  suppressionMarker: 'allow-queue-alert',
  allowlistFile: 'tools/queue-alert-allowlist.txt',
  invariantPaths: [
    'shared/lib/queue-inference-status.ts',
    'shared/lib/queue-alert-guard.ts',
    'tools/queue-alert-projection.ts', // install-paths: allow invariantPaths list, not an argv target
    'tools/check-queue-alert.ts', // install-paths: allow invariantPaths list, not an argv target
  ],
  patterns: [
    {
      name: 'episode-synthesis-inline',
      description: '`episodeStartedAt = `inference:…`` — route through deriveQueueAlertProjection; episode identity is primitive-owned',
      lang: 'ts',
      re: /episodeStartedAt\s*=\s*[`'"]inference:/,
    },
    {
      name: 'stuck-threshold-constant',
      description: 'private QUEUE_INFERENCE_STUCK_THRESHOLD-style constant — use queueAlertSeverityForCount() from the projection module',
      lang: 'ts',
      re: /\b[A-Z_]*QUEUE_INFERENCE_STUCK[A-Z_]*\s*[:=]/,
    },
    {
      name: 'consecutive-failures-severity',
      description: '`consecutiveFailures ... >= 5` severity ladder — route through deriveQueueAlertProjection().episode.severity',
      lang: 'ts',
      re: /consecutiveFailures\b[^;{]*\?\s*['"](high|medium|low)['"]/,
    },
    {
      name: 'failurecount-ladder-ternary',
      description: '`failureCount >= 5 ? high : >= 3 ? medium : low` — the one ladder lives in queue-inference-status.ts',
      lang: 'ts',
      re: /\bfailureCount\b[^;{]*>=\s*5[^;{]*['"]high['"][^;{]*['"]medium['"]/,
    },
  ],
  remediation: [
    'HOK-3314: one queue-alert projection decides state / count / severity.',
    'Route the new site through `deriveQueueAlertProjection()` in',
    'shared/lib/queue-inference-status.ts; the shared helper owns episode',
    'identity, the ≥3/≥5 severity ladder, and the human-readable summary.',
  ],
};
