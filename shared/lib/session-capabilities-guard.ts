// allow-session-capabilities: this file *is* the session-capabilities guard;
// its pattern table names every forbidden shape. It is auto-excluded from its
// own scan (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the session-capability invariant (HOK-3102, enforced by
 * HOK-3236): producers of consumer-bound work ask
 * `resolveSessionCapabilities()` (shared/lib/config.ts) or
 * `wavemill_session_has` (shared/lib/wavemill-common.sh) whether the consumer
 * exists. Re-deriving it from the raw inputs — `integration.enabled`,
 * `useMillSession`, `mergeQueue.enabled`, `observer.enabled`, or the
 * `MERGE_QUEUE_ENABLED` env override — reintroduces the drift HOK-3102 fixed
 * (a producer that thinks tend is on while the resolver says it is not).
 *
 * The resolver modules are the invariant source and are never scanned.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const SESSION_CAPABILITIES_GUARD: GuardSpec = {
  name: 'session-capabilities',
  findingNoun: 'session-capability re-derivation(s)',
  suppressionMarker: 'allow-session-capabilities',
  allowlistFile: 'tools/session-capabilities-allowlist.txt',
  invariantPaths: [
    'shared/lib/config.ts',
    'shared/lib/wavemill-common.sh',
    'shared/lib/session-capabilities-guard.ts',
  ],
  patterns: [
    {
      name: 'capability-config-read',
      description: 'raw capability input (`integration|observer|mergeQueue .enabled`, `.useMillSession`) — use resolveSessionCapabilities() / wavemill_session_has',
      lang: 'both',
      // Member access (TS) or jq path (shell); prose without the leading `.` never fires.
      re: /\.(?:integration|observer|mergeQueue)\??\.enabled\b|\.useMillSession\b/,
    },
    {
      name: 'merge-queue-env',
      description: '`MERGE_QUEUE_ENABLED` env read — the resolver already honours the override; use resolveSessionCapabilities() / wavemill_session_has',
      lang: 'both',
      re: /\bMERGE_QUEUE_ENABLED\b/,
    },
  ],
  remediation: [
    'Every producer of consumer-bound work (tend handoffs, wm:ready labels, merge-queue',
    'releases, observer findings, merge-lane updates) checks its consumer through the',
    'single resolver (HOK-3102): resolveSessionCapabilities() in shared/lib/config.ts or',
    'wavemill_session_has in shared/lib/wavemill-common.sh. Never re-derive it from',
    'integration.enabled / useMillSession / MERGE_QUEUE_ENABLED / observer.enabled.',
  ],
};
