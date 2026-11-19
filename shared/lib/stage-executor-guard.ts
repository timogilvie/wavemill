// allow-stage-executor: this file *is* the stage-executor guard; its pattern
// table names every forbidden shape. It is auto-excluded from its own scan
// (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the stage-executor invariant (HOK-3511, enforced by
 * HOK-3236): "which agent and provider run this model?" is answered by one
 * resolver, `resolveStageExecutor` in `shared/lib/model-agent-resolution.ts`,
 * and every `.phase-config.json` stage block is written by one writer,
 * `writePersistedContract` in `shared/lib/execution-contract.ts` (shell:
 * `phase_config_write_stages`).
 *
 * A second agent→provider map, a carried agent, or a private stage-block
 * write is how HOK-3500's coding retry came to be refused with
 * `agent_unsupported_for_model` two hours after a silent stall.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const STAGE_EXECUTOR_GUARD: GuardSpec = {
  name: 'stage-executor',
  invariantDocs: ['docs/invariants/stage-executor.md'],
  findingNoun: 'private stage-executor derivation(s) or stage-block write(s)',
  suppressionMarker: 'allow-stage-executor',
  allowlistFile: 'tools/stage-executor-allowlist.txt',
  invariantPaths: [
    'shared/lib/model-agent-resolution.ts',
    'shared/lib/execution-contract.ts',
    'shared/lib/stage-executor-guard.ts',
  ],
  patterns: [
    {
      name: 'ts-agent-provider-map',
      description: 'agent→provider literal mapping outside the resolver — use resolveStageExecutor / providerForAgent',
      lang: 'ts',
      re: /['"]claude['"]\s*:\s*['"]anthropic['"]|['"]codex['"]\s*:\s*['"]openai['"]|return\s+['"]anthropic['"]/,
    },
    {
      name: 'ts-native-provider-construction',
      description: 'provider label built as `native-${...}` outside the resolver — the provider is a function of the resolved agent',
      lang: 'ts',
      re: /provider\s*[:=]\s*`native-\$\{/,
    },
    {
      name: 'ts-provider-for-model',
      description: 'providerForModel was deleted (HOK-3511) — use resolveStageExecutor, whose provider follows the resolved agent',
      lang: 'ts',
      re: /\bproviderForModel\b/,
    },
    {
      name: 'ts-private-phase-config-write',
      description: 'private .phase-config.json mutation — route the stage block through writePersistedContract',
      lang: 'ts',
      re: /mutateJsonState[^;]*[Pp]hase[-_]?[Cc]onfig|writeFile[^;]*\.phase-config\.json/,
    },
    {
      name: 'sh-stage-block-executor-assignment',
      description: 'shell/jq assignment of a stage agent or provider — phase_config_write_stages derives both from the model',
      lang: 'sh',
      re: /\.(planning|coding|review)\.(agent|provider)\s*=|\{\s*model:\s*\$[A-Za-z_]+,\s*agent:/,
    },
    {
      name: 'sh-private-phase-config-mutate',
      description: 'private .phase-config.json write — route the stage block through phase_config_write_stages',
      lang: 'sh',
      re: /state_mutate\s+"[^"]*\.phase-config\.json"|(>|\bmv\b|\btee\b)\s+"[^"]*\.phase-config\.json"/,
    },
    {
      name: 'sh-deleted-provider-helpers',
      description: 'phase_config_provider_for_agent / _provider_for_model were deleted (HOK-3511) — the writer derives the provider',
      lang: 'sh',
      re: /\bphase_config_provider_for_agent\b|\b_provider_for_model\b/,
    },
    {
      name: 'sh-agent-provider-case-map',
      description: 'case arm mapping an agent to a provider label — the resolver owns this mapping',
      lang: 'sh',
      re: /claude\)\s*(printf|echo)\s*(['"]|%s.*)anthropic|codex\)\s*(printf|echo)\s*(['"]|%s.*)openai/,
    },
  ],
  remediation: [
    'The one resolver is resolveStageExecutor (shared/lib/model-agent-resolution.ts): (model, stage, effective registry) → {agent, provider}.',
    'The one writer is writePersistedContract (shared/lib/execution-contract.ts); shell callers use phase_config_write_stages and pass models only.',
    'Never persist an agent or provider carried from an intent, a sealed route, an arm record, or another file.',
    'Recovery re-derives the executor from the persisted model (readValidatedContract); do not compare a stored agent against the resolver.',
  ],
};
