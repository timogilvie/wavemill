import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CURRENT_CONFIG_VERSION, loadWavemillBaseConfig, type WavemillConfig } from './config.ts';
import {
  classifyLocalOverrideFields,
  type LocalOverrideClassificationEntry,
} from './sync-config-classifier.ts';

export const CANONICAL_CONFIG_TEMPLATE: WavemillConfig = {
  configVersion: CURRENT_CONFIG_VERSION,
  linear: {
    project: '',
  },
  mill: {
    session: '',
    maxParallel: 7,
    pollSeconds: 10,
    baseBranch: 'main',
    worktreeRoot: '../worktrees',
    agentCmd: 'claude',
    requireConfirm: true,
    planningMode: 'interactive',
    maxRetries: 3,
    retryDelay: 2,
  },
  expand: {
    maxSelect: 3,
    maxDisplay: 9,
  },
  plan: {
    maxDisplay: 9,
    research: false,
    model: 'claude-opus-4-8',
    interactive: true,
  },
  eval: {
    aggregation: {
      repos: [],
      outputPath: '.wavemill/evals/aggregated-evals.jsonl',
    },
    evalsDir: '.wavemill/evals',
    judge: {
      model: 'claude-sonnet-5',
      provider: 'anthropic',
    },
    pricing: {
      'claude-fable-5': { inputCostPerMTok: 10, outputCostPerMTok: 50, cacheWriteCostPerMTok: 12.5, cacheReadCostPerMTok: 1 },
      'claude-opus-4-6': { inputCostPerMTok: 5, outputCostPerMTok: 25, cacheWriteCostPerMTok: 6.25, cacheReadCostPerMTok: 0.5 },
      'claude-opus-4-8': { inputCostPerMTok: 5, outputCostPerMTok: 25, cacheWriteCostPerMTok: 6.25, cacheReadCostPerMTok: 0.5 },
      'claude-opus-4-7': { inputCostPerMTok: 5, outputCostPerMTok: 25, cacheWriteCostPerMTok: 6.25, cacheReadCostPerMTok: 0.5 },
      'claude-sonnet-5': { inputCostPerMTok: 2, outputCostPerMTok: 10, cacheWriteCostPerMTok: 2.5, cacheReadCostPerMTok: 0.2 },
      'claude-sonnet-4-6': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
      'claude-sonnet-4-5-20250929': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
      'claude-haiku-4-5-20251001': { inputCostPerMTok: 0.8, outputCostPerMTok: 4, cacheWriteCostPerMTok: 1, cacheReadCostPerMTok: 0.08 },
      'gpt-5.3-codex': { inputCostPerMTok: 1.75, outputCostPerMTok: 14, cacheReadCostPerMTok: 0.44 },
      'gpt-5.6-terra': { inputCostPerMTok: 2.5, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.125, cacheReadCostPerMTok: 0.25 },
      'gpt-5.5': { inputCostPerMTok: 5, outputCostPerMTok: 30 },
      'gpt-4.1': { inputCostPerMTok: 2, outputCostPerMTok: 8 },
      'qwen-3-coder': { inputCostPerMTok: 0.35, outputCostPerMTok: 1.05 },
      'qwen-3-235b': { inputCostPerMTok: 0.09, outputCostPerMTok: 0.55 },
      'deepseek-v3': { inputCostPerMTok: 0.2145, outputCostPerMTok: 0.32175, cacheReadCostPerMTok: 0.02145 },
      'glm-5.2': { inputCostPerMTok: 0.9, outputCostPerMTok: 4.2 },
      'glm-5.3': { inputCostPerMTok: 1.4, outputCostPerMTok: 4.4 },
      'kimi-k2': { inputCostPerMTok: 1, outputCostPerMTok: 3 },
      'kimi-k3': { inputCostPerMTok: 3, outputCostPerMTok: 15 },
      'kimi-k2.7-code': { inputCostPerMTok: 1.2, outputCostPerMTok: 3.6 },
      'kimi-k2-thinking': { inputCostPerMTok: 1.5, outputCostPerMTok: 4.5 },
      'gemini-2.5-pro': { inputCostPerMTok: 1.25, outputCostPerMTok: 10 },
      'gemini-2.5-flash': { inputCostPerMTok: 0.3, outputCostPerMTok: 2.5 },
      'gemini-3.8-flash': { inputCostPerMTok: 0.75, outputCostPerMTok: 3.75 },
      'llama-4-maverick': { inputCostPerMTok: 0.4, outputCostPerMTok: 1.6 },
      'mistral-large-2': { inputCostPerMTok: 0.5, outputCostPerMTok: 1.5 },
      'mistral-medium-3': { inputCostPerMTok: 1.5, outputCostPerMTok: 7.5 },
      'devstral-medium': { inputCostPerMTok: 0.4, outputCostPerMTok: 2 },
    },
    interventionPenalties: {
      reviewComment: 0.05,
      postPrCommit: 0.08,
      manualEdit: 0.1,
      testFix: 0.06,
      sessionRedirect: 0.12,
      selfReviewWarning: 0.05,
      selfReviewBlocker: 0.2,
    },
  },
  autoEval: true,
  hokusai: {
    dataSubmission: {
      enabled: false,
      consentVersion: '1.1',
    },
  },
  providers: {
    openrouter: {
      enabled: true,
      apiKeyEnv: 'OPENROUTER_API_KEY',
      baseUrl: 'https://openrouter.ai/api',
    },
  },
  challenge: {
    enabled: true,
    rate: 0.75,
    recommendationRate: 1,
    stageWeights: {
      plan: 0.25,
      implementation: 0.5,
      review: 0.25,
    },
    autoMergeWinner: false,
  },
  review: {
    maxIterations: 3,
    enabled: true,
    metricsLog: '.wavemill/review-log.json',
    personas: ['general'],
  } as WavemillConfig['review'] & { metricsLog: string; personas: string[] },
  router: {
    enabled: true,
    minRecords: 20,
    minModels: 2,
    exploration: {
      enabled: true,
      mode: 'epsilon',
      rate: 0.35,
      topK: 6,
      ucbConstant: 0.25,
      priors: {
        enabled: true,
        blendSamples: 20,
      },
      newModelBoost: {
        windowDays: 45,
        multiplier: 3,
      },
    },
    coverage: {
      minRecordsPerModelStage: 15,
      maxStageShare: 0.7,
      window: 50,
    },
    defaultAgent: 'codex',
    mode: 'auto',
    llmModel: 'gpt-4o-mini',
    llmProvider: 'openai',
  },
  challengeScheduler: {
    enabled: true,
    newModelChallengeCount: 25,
  },
  validation: {
    enabled: true,
    layer1: {
      enabled: true,
    },
    layer2: {
      enabled: true,
      model: 'gpt-5.6-terra',
      provider: 'codex',
    },
    onFailure: 'conservative',
  },
  constraints: {
    enabled: true,
    cleanupAfterMerge: false,
  },
  ui: {
    visualVerification: true,
    designStandards: true,
    creativeDirection: false,
  },
  permissions: {
    autoApprovePatterns: [
      'find *',
      'ls *',
      'cat *',
      'head *',
      'tail *',
      'wc *',
      'git status*',
      'git log*',
      'git show*',
      'git diff*',
      'git branch --list*',
      'git branch -l*',
      'git worktree list*',
      'gh pr view*',
      'gh pr list*',
      'gh pr status*',
      'gh issue view*',
      'gh issue list*',
      'grep *',
      'rg *',
      'npm list*',
      'npm ls*',
    ],
    worktreeMode: {
      enabled: true,
      autoApproveReadOnly: true,
    },
  },
};

export interface PreparedConfigSync {
  configPath: string;
  localConfigPath: string;
  backupPath: string;
  configExists: boolean;
  localConfigExists: boolean;
  localConfig: Record<string, unknown>;
  currentConfig: Record<string, unknown>;
  mergedConfig: WavemillConfig;
  additions: string[];
  localOverrideClassifications: LocalOverrideClassificationEntry[];
  alreadyCurrent: boolean;
}

function parseJsonConfig(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function pathIsEqualOrChild(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`);
}

export function deepMergeConfig(target: any, source: any): any {
  if (source === null || source === undefined) {
    return target;
  }

  if (Array.isArray(target)) {
    return Array.isArray(source) && source.length > 0 ? source : target;
  }

  if (typeof target === 'object' && target !== null) {
    const result = { ...target };

    for (const key in source) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) {
        continue;
      }

      if (typeof source[key] === 'object' && !Array.isArray(source[key]) && source[key] !== null) {
        result[key] = deepMergeConfig(target[key] || {}, source[key]);
      } else if (source[key] !== undefined) {
        result[key] = source[key];
      }
    }

    return result;
  }

  return source !== undefined ? source : target;
}

export function identifyConfigAdditions(before: any, after: any, currentPath = ''): string[] {
  const additions: string[] = [];

  for (const key in after) {
    const nextPath = currentPath ? `${currentPath}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(before, key)) {
      additions.push(nextPath);
    } else if (typeof after[key] === 'object' && !Array.isArray(after[key]) && after[key] !== null) {
      additions.push(...identifyConfigAdditions(before[key] || {}, after[key], nextPath));
    }
  }

  return additions;
}

export function prepareConfigSync(repoDir: string): PreparedConfigSync {
  const configPath = resolve(repoDir, '.wavemill-config.json');
  const localConfigPath = resolve(repoDir, '.wavemill-config.local.json');
  const backupPath = resolve(repoDir, '.wavemill-config.json.backup');
  const configExists = existsSync(configPath);
  const localConfigExists = existsSync(localConfigPath);

  let currentConfig: Record<string, unknown> = {};
  if (configExists) {
    currentConfig = parseJsonConfig(configPath);
  }

  let localConfig: Record<string, unknown> = {};
  if (localConfigExists) {
    localConfig = parseJsonConfig(localConfigPath);
  }

  const currentBaseConfig = loadWavemillBaseConfig(repoDir);

  const mergedConfig = deepMergeConfig(CANONICAL_CONFIG_TEMPLATE, currentConfig) as WavemillConfig;
  mergedConfig.configVersion = CURRENT_CONFIG_VERSION;
  if (mergedConfig.mill?.planningMode !== 'interactive') {
    mergedConfig.mill = {
      ...(mergedConfig.mill || {}),
      planningMode: 'interactive',
    };
  }

  const additions = configExists ? identifyConfigAdditions(currentConfig, mergedConfig) : [];
  const localOverrideClassifications = classifyLocalOverrideFields({
    baseConfig: currentConfig,
    localConfig,
    canonicalConfig: CANONICAL_CONFIG_TEMPLATE as unknown as Record<string, unknown>,
  });
  const alreadyCurrent =
    configExists &&
    currentBaseConfig.configVersion === CURRENT_CONFIG_VERSION &&
    additions.length === 0 &&
    JSON.stringify(currentBaseConfig) === JSON.stringify(mergedConfig);

  return {
    configPath,
    localConfigPath,
    backupPath,
    configExists,
    localConfigExists,
    localConfig,
    currentConfig,
    mergedConfig,
    additions,
    localOverrideClassifications,
    alreadyCurrent,
  };
}

export function findLocalPromotionConflicts(prepared: PreparedConfigSync): LocalOverrideClassificationEntry[] {
  const requiresDecision = prepared.localOverrideClassifications.filter(
    entry => entry.label === 'requires decision',
  );
  if (requiresDecision.length === 0 || prepared.additions.length === 0) {
    return [];
  }

  return requiresDecision.filter(entry =>
    prepared.additions.some(addition => pathIsEqualOrChild(addition, entry.path)),
  );
}
