// allow-recovery-failure-paths: this file *is* the recovery-failure guard;
// its pattern table names every forbidden shape and is auto-excluded from its
// own scan.
/**
 * Preflight guard for the one "stage agent exited" path (HOK-3313): identity
 * comes from the launch record (.<stage>-result.json), every exit goes through
 * the single failure policy (shared/lib/failure-policy.ts; HOK-3176) via
 * maybe_retry_failed_stage, and pane-text identity sniffing is deleted.
 *
 * Shapes caught:
 * - A direct `wavemill_reconcile_terminal ... recovery_failure` call outside
 *   the two allowed sites (maybe_retry_failed_stage, phase_launch_gate). Any
 *   other site has to route the exit through the failure policy instead.
 * - A grep over `tmux capture-pane` output for native-identity substrings
 *   (OpenRouter, native-openrouter, launch-native-*, wavemill native-agent),
 *   the exact pane-text identity sniffing path that misidentified a claude
 *   coder as native in HOK-3313.
 *
 * The invariant source and the two legitimate call sites (shared/lib/
 * wavemill-monitor.sh phase_launch_gate uses recovery_failure once on
 * budget exhaustion) live in the ratcheting allowlist. The list only shrinks.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const RECOVERY_FAILURE_PATHS_GUARD: GuardSpec = {
  name: 'recovery-failure-paths',
  findingNoun: 'ad-hoc recovery_failure terminalization / pane-text identity sniff(es)',
  suppressionMarker: 'allow-recovery-failure-paths',
  allowlistFile: 'tools/recovery-failure-paths-allowlist.txt',
  invariantPaths: [
    'shared/lib/recovery-failure-paths-guard.ts',
  ],
  patterns: [
    {
      name: 'recovery-failure-reconcile',
      description:
        'wavemill_reconcile_terminal ... "recovery_failure" outside maybe_retry_failed_stage / phase_launch_gate — route the exit through failure_policy_decide and maybe_retry_failed_stage instead',
      lang: 'sh',
      re: /wavemill_reconcile_terminal\b[^\n]*recovery_failure/,
    },
    {
      name: 'pane-text-native-identity-grep',
      description:
        'grep pattern with native-identity substrings (OpenRouter / native-openrouter / launch-native-* / wavemill native-agent) — read identity from .<stage>-result.json (the launch record), never from the pane',
      lang: 'sh',
      re: /\bgrep\b[^\n]*(?:OpenRouter|native-openrouter|native-openai|launch-native-|wavemill native-agent)/i,
    },
    {
      name: 'tmux-capture-pane-for-recovery',
      description:
        'tmux capture-pane feeding recovery/identity logic — identity comes from the launch record, not from pane text',
      lang: 'sh',
      re: /tmux\s+capture-pane\b[^\n]*(?:--?for-recovery|identity|native)/i,
    },
  ],
  remediation: [
    'Stage agent exits must route through the single failure policy:',
    '  failure_policy_decide -> maybe_retry_failed_stage.',
    'Identity comes from the launch record (.<stage>-result.json), not from',
    'tmux capture-pane output. Only maybe_retry_failed_stage (bounded-retry',
    'exhaustion) and phase_launch_gate (launch-budget exhaustion) may call',
    'wavemill_reconcile_terminal with "recovery_failure".',
  ],
};
