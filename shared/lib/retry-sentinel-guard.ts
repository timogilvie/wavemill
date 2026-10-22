// allow-retry-sentinel: this file *is* the bounded-retry guard; its pattern
// table names every forbidden shape. It is auto-excluded from its own scan
// (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the bounded-retry invariant (HOK-2924, enforced by
 * HOK-3236): every relaunch path counts attempts through
 * shared/lib/bounded-retry.{sh,ts} — never a private retry counter.
 *
 * Two mechanical shapes give a private counter away:
 *
 * - reaching into the helper's storage (`.retry-<bucket>-count`,
 *   `-head`, `-exhausted`, …) instead of calling `bounded_retry_*` /
 *   `createStateDirRetry`, which bypasses the head-keyed reset, the backoff
 *   and the HOK-3172 condition companion;
 * - minting a new `.<name>-attempts` / `-retries` / `-retry-count` state file,
 *   which is a second counter with none of those properties.
 *
 * Readers that only *observe* bucket state for detection (observer, the
 * HOK-3229 invariant checker, ledger consistency) are allowlisted with a
 * reason in tools/retry-sentinel-allowlist.txt.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const RETRY_SENTINEL_GUARD: GuardSpec = {
  name: 'retry-sentinel',
  findingNoun: 'private retry-counter site(s)',
  suppressionMarker: 'allow-retry-sentinel',
  allowlistFile: 'tools/retry-sentinel-allowlist.txt',
  invariantPaths: [
    'shared/lib/bounded-retry.sh',
    'shared/lib/bounded-retry.ts',
    'shared/lib/retry-sentinel-guard.ts',
  ],
  patterns: [
    {
      name: 'retry-state-file',
      description: 'hand-built `.retry-<bucket>-*` path — bounded-retry storage is private to shared/lib/bounded-retry.{sh,ts}; call bounded_retry_* / createStateDirRetry',
      lang: 'both',
      // `.retry-<literal|var>-<suffix>` (or the bare prefix right before a quote)
      // and the legacy `.failed-ready-recheck-<suffix>` names.
      re: /\.(?:retry-(?:[a-z0-9][a-z0-9-]*?|\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*)|failed-ready-recheck)(?:-(?:count|head|last-at|exhausted|fingerprint|step-id)\b|-?(?=['"`]))/,
    },
    {
      name: 'private-attempt-counter-file',
      description: 'new `.<name>-attempts` / `-retries` / `-retry-count` state file — a private retry counter; use the bounded-retry helper with its own bucket',
      lang: 'both',
      re: /['"`/]\.[a-z0-9][a-z0-9_-]*-(?:attempts|retries|retry-count|attempt-count)(?:\.json)?\b/,
    },
  ],
  remediation: [
    'Every path that relaunches work after a failure must count attempts through',
    'shared/lib/bounded-retry.{sh,ts} (HOK-2924): a (state_dir, bucket, head SHA) key,',
    'backoff, a terminal ceiling with a recorded reason, and reset on a new head.',
    'Never implement a private retry counter or read/write the helper\'s files directly.',
  ],
};
