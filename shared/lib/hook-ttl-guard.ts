// allow-hook-ttl: this file *is* the task-progress TTL guard; its pattern
// table names every forbidden shape. It is auto-excluded from its own scan
// (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the task progress/liveness invariant (HOK-3101,
 * enforced by HOK-3236): liveness is derived by the one primitive in
 * shared/lib/task-progress.{ts,sh} — `wavemill_hook_read --fresh` /
 * `task_progress_json` in shell, `deriveTaskProgress` / `readHookFile` in TS.
 * A private TTL check (read the hook's `.timestamp`, compare against 300s)
 * ignores the primitive's three invariants: pane existence is not progress,
 * monitor writes are not agent evidence, and the agent's own idle survives
 * later monitor writes.
 *
 * Shapes caught:
 * - the TTL constant (`HOOK_TTL_SECONDS` / `WAVEMILL_HOOK_TTL_SECONDS`) used
 *   outside the primitive — doing the freshness math yourself;
 * - a jq read of `.timestamp` straight out of a hook file;
 * - a hard-coded 300s comparison on a hook / staleness / timestamp line.
 *
 * Pre-existing sites are held by a count ratchet in
 * tools/hook-ttl-allowlist.txt, so a new private check in the same file still
 * fails.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const HOOK_TTL_GUARD: GuardSpec = {
  name: 'hook-ttl',
  findingNoun: 'private hook-TTL liveness check(s)',
  suppressionMarker: 'allow-hook-ttl',
  allowlistFile: 'tools/hook-ttl-allowlist.txt',
  invariantPaths: [
    'shared/lib/task-progress.ts',
    'shared/lib/task-progress.sh',
    'shared/lib/hook-ttl-guard.ts',
  ],
  patterns: [
    {
      name: 'hook-ttl-constant',
      description: 'hook TTL constant outside the primitive — use wavemill_hook_read --fresh / task_progress_json / deriveTaskProgress',
      lang: 'both',
      re: /\b(?:WAVEMILL_)?HOOK_TTL_SECONDS\b/,
    },
    {
      name: 'raw-hook-timestamp-read',
      description: 'jq read of `.timestamp` from a hook file — use wavemill_hook_read (add --agent-only for the agent record)',
      lang: 'sh',
      re: /['"]\.(?:agentRecord\.)?timestamp\b[^'"]*['"]\s+"?\$\{?hook/,
    },
    {
      name: 'hook-ttl-literal',
      description: 'hard-coded 300s freshness comparison on a hook/staleness line — the TTL belongs to the task-progress primitive',
      lang: 'both',
      re: /^(?=.*\b(?:hook\w*|staleness|timestamp)\b).*?(?:<=?|>=?|-lt|-le|-gt|-ge)\s*300(?:_?000)?\b/i,
    },
  ],
  remediation: [
    'Every liveness decision goes through the task-progress primitive (HOK-3101):',
    'wavemill_hook_read / task_progress_json in shell, deriveTaskProgress / readHookFile in',
    'TypeScript. Never re-derive liveness from a private hook-timestamp TTL check.',
  ],
};
