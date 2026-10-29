// allow-stage-exit-identity: this file *is* the stage-exit-identity guard;
// its pattern table names every forbidden shape. It is auto-excluded from
// its own scan (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the single stage-exit observation invariant (HOK-3313,
 * enforced by HOK-3236).
 *
 * Two anti-patterns are forbidden:
 *
 * 1. A direct `wavemill_reconcile_terminal … recovery_failure` outside the
 *    bounded-retry exhaustion sites: `phase_launch_gate` (exhausted
 *    disposition writes the recovery_failure) and `emit_native_terminal_failure_attention`
 *    (an explicit TERMINAL_ALLOWLIST cause). Every other failure must take
 *    the failure-policy → maybe_retry_failed_stage path. Historical HOK-3313:
 *    `emit_native_launch_failure_attention` reconciled recovery_failure
 *    directly from a scraped pane classification, bypassing the policy.
 *
 * 2. A pane-capture pipeline that scrapes identity-signalling text
 *    (OpenRouter / native-openai / native-openrouter / launch-native-* /
 *    `wavemill native-agent`) to decide agent identity. Identity for a
 *    running stage comes from the launch record only (`stage_launch_identity`
 *    reads the `.<stage>-result.json` agent/model). Historical HOK-3313: the
 *    deleted `agent_or_model_is_native_for_recovery` grep misclassified a
 *    Claude coder whose scrollback contained the words "OpenRouter" or
 *    "wavemill native-agent".
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const STAGE_EXIT_IDENTITY_GUARD: GuardSpec = {
  name: 'stage-exit-identity',
  findingNoun: 'stage-exit identity-sniffing or direct recovery_failure reconciliation(s)',
  suppressionMarker: 'allow-stage-exit-identity',
  allowlistFile: 'tools/stage-exit-identity-allowlist.txt',
  invariantPaths: [
    'shared/lib/stage-exit-identity-guard.ts',
  ],
  patterns: [
    {
      name: 'private-stage-timestamp',
      description: 'stage age must use wavemill_iso8601_to_epoch, including native millisecond timestamps',
      lang: 'sh',
      re: /started_epoch=.*date.*started_at/,
    },
    {
      name: 'quadratic-patch-statistics',
      description: 'patch statistics must use the Git numstat authority instead of a private LCS table',
      lang: 'ts',
      re: /\bbuildLcsTable\s*\(/,
    },
    {
      name: 'direct-recovery-failure-reconcile',
      description:
        '`wavemill_reconcile_terminal … recovery_failure` outside bounded-retry exhaustion — route the failure through failure_policy_decide / maybe_retry_failed_stage',
      lang: 'both',
      // The literal arg form; the recovery_failure cause must appear on the
      // same line as the reconcile call. Readers that only check / match the
      // existing string are not affected.
      re: /wavemill_reconcile_terminal\s+[^;\n]*recovery_failure/,
    },
    {
      name: 'pane-text-identity-sniff',
      description:
        'pane-capture pipeline grepping for identity-signalling text (OpenRouter / native-openrouter / native-openai / launch-native-* / wavemill native-agent) — identity comes from the launch record, not pane scrollback',
      lang: 'both',
      // A grep call whose pattern alternation names the identity signals the
      // deleted agent_or_model_is_native_for_recovery used to classify by.
      re: /grep[^|\n]*(?:native-openrouter|native-openai|launch-native-(?:planning|coding|review)|wavemill[\s_-]native[\s_-]agent)/i,
    },
  ],
  structuralChecks: [{
    name: 'unbounded-native-coding',
    description: 'native coding must supply the shared loop budget',
    paths: ['shared/lib/native-agent/launch-coding.ts'],
    find(source) {
      return [...source.matchAll(/runWavemillLoop\(\{([\s\S]*?)convertToLlm:/g)]
        .filter((match) => !/\bbudget\s*:/.test(match[1]))
        .map((match) => ({ line: source.slice(0, match.index).split('\n').length }));
    },
  }],
  remediation: [
    'HOK-3313: there is one exit observation. Identity for a running stage comes',
    'from the launch record only (`stage_launch_identity` reads the `.<stage>-result.json`',
    'agent/model). Every exit routes through `failure_policy_decide` → `maybe_retry_failed_stage`',
    '(HOK-3176). `wavemill_reconcile_terminal … recovery_failure` is reachable only from',
    'bounded-retry exhaustion (`phase_launch_gate`) and the terminal-class allowlist branch of',
    '`emit_native_terminal_failure_attention`.',
  ],
};
