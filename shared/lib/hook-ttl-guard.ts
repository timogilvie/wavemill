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
 * - a hard-coded 300s comparison on a hook / staleness / timestamp line;
 * - a private stagnation/progress tracker in `shared/lib/native-agent/`
 *   (HOK-3381): the one tool-call progress rule is
 *   `ToolCallProgressTracker` in shared/lib/task-progress.ts — never a
 *   second signature/output-hash tracker or a rerun-after-timeout
 *   command-string key.
 *
 * Pre-existing sites are held by a count ratchet in
 * tools/hook-ttl-allowlist.txt, so a new private check in the same file still
 * fails.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const HOOK_TTL_GUARD: GuardSpec = {
  name: 'hook-ttl',
  invariantDocs: ['docs/invariants/task-progress.md'],
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
      name: 'private-stagnation-tracker',
      description: 'private stagnation/progress tracker — the one tool-call progress rule is ToolCallProgressTracker in shared/lib/task-progress.ts (HOK-3381)',
      lang: 'ts',
      re: /\bclass\s+\w*(?:Stagnation|Progress)Tracker\b|\bToolStagnationTracker\b|\bCommandRunHistory\b|\blastOutputHash\b|\bnoNovelProgressCalls\b|\btoolOutputFingerprint\b/,
    },
    {
      name: 'hook-ttl-literal',
      description: 'hard-coded 300s freshness comparison on a hook/staleness line — the TTL belongs to the task-progress primitive',
      lang: 'both',
      re: /^(?=.*\b(?:hook\w*|staleness|timestamp)\b).*?(?:<=?|>=?|-lt|-le|-gt|-ge)\s*300(?:_?000)?\b/i,
    },
    {
      // HOK-3422: a controller-authored timestamp pushed as a progress source
      // is the exact bug family (c) fixed by splitting lastTransitionAt out
      // of lastProgressAt. Forbid any new site that builds a
      // ProgressSource with `kind: 'transition'`.
      //
      // reliability-metrics.ts carries its own local `ProgressEvidence.kind`
      // namespace that is distinct from `ProgressSourceKind`; its
      // `kind: 'transition'` literals compose the replay timeline (not the
      // primitive's sources list) and are exempted here.
      name: 'transition-progress-source-outside-primitive',
      description: "ProgressSource `kind: 'transition'` is retired — controller timestamps feed TaskProgress.lastTransitionAt (TransitionInput), never lastProgressAt / stalled (HOK-3422)",
      lang: 'ts',
      re: /\bkind\s*:\s*['"]transition['"]/,
      excludePaths: ['shared/lib/reliability-metrics.ts'],
    },
    {
      // HOK-3422: the `extraTransitionSources` / `transitionSources` option
      // and inputs field both treat a controller write as a progress source.
      // The replacement is `extraTransitionInputs` / `transitionInputs`.
      name: 'extra-transition-sources',
      description: 'extraTransitionSources / transitionSources are retired — pass extraTransitionInputs / transitionInputs instead (HOK-3422)',
      lang: 'ts',
      re: /\b(?:extraTransitionSources|transitionSources)\b/,
    },
  ],
  remediation: [
    'Every liveness decision goes through the task-progress primitive (HOK-3101):',
    'wavemill_hook_read / task_progress_json in shell, deriveTaskProgress / readHookFile in',
    'TypeScript. Never re-derive liveness from a private hook-timestamp TTL check.',
  ],
};
