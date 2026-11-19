/**
 * Provider and native-execution enablement as a launchability input.
 *
 * The launcher refuses a model whose provider the repo config turns off
 * (`agent_validate_deepseek_launch` in `agent-adapters.sh`,
 * `tools/check-native-agent-launch.ts`). Routing, the challenge candidate pool
 * and the launchability doctor all ask `resolveModelAgent`, so the same
 * enablement must be part of that answer — otherwise the router keeps picking
 * models that are then refused at every launch (HOK-3461 routed DeepSeek
 * planners and coders with `providers.deepseek.enabled=false`).
 *
 * Config is read through `loadWavemillConfig`, which overlays
 * `.wavemill-config.local.json` on `.wavemill-config.json`.
 *
 * @module provider-enablement
 */

import { loadWavemillConfig } from './config.ts';
import { isDeepSeekModel, resolveDeepSeekProviderConfig } from './deepseek-provider.ts';
import type { AgentType } from './model-registry.ts';

export type ProviderEnablementReason = 'provider-disabled' | 'native-disabled';

export interface ProviderEnablementRefusal {
  reason: ProviderEnablementReason;
  /** Provider whose enablement refused the model (`deepseek`, `openrouter`, `openai`). */
  provider: string;
  /** Config path that refused it, e.g. `providers.deepseek.enabled`. */
  surface: string;
  detail: string;
}

const NATIVE_PROVIDER_BY_AGENT: Partial<Record<AgentType, 'openai' | 'openrouter'>> = {
  'native-openai': 'openai',
  'native-openrouter': 'openrouter',
  'claude-openrouter': 'openrouter',
};

/**
 * Why the repo's config forbids running `modelId` through `agent`, or `null`
 * when the provider and execution surface it needs are enabled.
 *
 * - A DeepSeek model on the Claude CLI needs `providers.deepseek.enabled=true`.
 * - A native agent needs `nativeAgent.enabled=true` and must not have its
 *   provider turned off (`nativeAgent.providers.<p>.enabled=false`).
 * - A native OpenRouter agent also needs `providers.openrouter.enabled=true`
 *   when that block is configured (the same rule as
 *   `validateNativeOpenRouterConfig`).
 */
export function explainProviderEnablementRefusal(input: {
  modelId: string;
  agent: AgentType;
  vendor?: string;
  repoDir: string;
}): ProviderEnablementRefusal | null {
  const { modelId, agent, repoDir } = input;

  if (agent === 'claude' && (input.vendor === 'deepseek' || isDeepSeekModel(modelId))) {
    if (!resolveDeepSeekProviderConfig(repoDir).enabled) {
      return {
        reason: 'provider-disabled',
        provider: 'deepseek',
        surface: 'providers.deepseek.enabled',
        detail: `DeepSeek model ${modelId} requires providers.deepseek.enabled=true`,
      };
    }
    return null;
  }

  const nativeProvider = NATIVE_PROVIDER_BY_AGENT[agent];
  if (!nativeProvider) return null;

  const config = loadWavemillConfig(repoDir);
  if (config.nativeAgent?.enabled !== true) {
    return {
      reason: 'native-disabled',
      provider: nativeProvider,
      surface: 'nativeAgent.enabled',
      detail: `${modelId} needs native execution, which requires nativeAgent.enabled=true`,
    };
  }
  if (config.nativeAgent?.providers?.[nativeProvider]?.enabled === false) {
    return {
      reason: 'provider-disabled',
      provider: nativeProvider,
      surface: `nativeAgent.providers.${nativeProvider}.enabled`,
      detail: `${modelId} requires nativeAgent.providers.${nativeProvider}.enabled to be true`,
    };
  }
  const openrouterConfig = config.providers?.openrouter;
  if (nativeProvider === 'openrouter' && openrouterConfig && openrouterConfig.enabled !== true) {
    return {
      reason: 'provider-disabled',
      provider: 'openrouter',
      surface: 'providers.openrouter.enabled',
      detail: `${modelId} runs through OpenRouter, which requires providers.openrouter.enabled=true`,
    };
  }
  return null;
}
