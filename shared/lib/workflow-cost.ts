/**
 * Workflow cost scanner — reads agent session files and computes
 * the total cost of building a feature across all sessions on a branch.
 *
 * Session parsing is delegated to agent-specific adapters in
 * session-adapters.ts. This module handles pricing lookup and
 * cost computation.
 *
 * @module workflow-cost
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  NativeSessionAdapter,
  getSessionAdapter,
  detectAgentType,
  type AgentType,
  type SessionUsageResult,
  type NativeSessionUsageRecord,
} from './session-adapters.ts';
import { loadWavemillConfig } from './config.ts';
import { getEffectiveRegistry, resolveModelRegistryKey } from './model-registry.ts';
import {
  fetchGenerationCostsBatched,
  type OpenRouterGenerationCost,
} from './openrouter-generation-api.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** Per-model token usage breakdown. */
export interface ModelTokenUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type WorkflowCostAttributionCoverage = 'complete' | 'partial' | 'unavailable' | 'known_zero';
export type WorkflowCostAttributionReason =
  | 'missing_token_usage'
  | 'invalid_token_usage'
  | 'unpriced_model'
  | 'mixed_coverage'
  | 'provider_reported_cost'
  | 'no_pricing_data'
  | 'no_priced_sessions';

export type WorkflowCostPricingSource = 'openrouter_api' | 'local_estimate' | 'mixed';

export interface WorkflowCostAttributionModel {
  provider: string;
  modelId: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  providerReportedCostUsd?: number;
  pricingSource?: WorkflowCostPricingSource;
  priced: boolean;
  reason?: WorkflowCostAttributionReason;
}

export interface WorkflowCostAttribution {
  source: 'native' | 'codex' | 'claude';
  coverage: WorkflowCostAttributionCoverage;
  reason?: WorkflowCostAttributionReason;
  sessions: number;
  turns: number;
  pricedSessions: number;
  unpricedSessions: number;
  models: WorkflowCostAttributionModel[];
}

/** Result from scanning workflow sessions. */
export interface WorkflowCostResult {
  /** Total estimated cost in USD across all models and sessions. */
  totalCostUsd: number;
  /** Per-model token usage breakdown. */
  models: Record<string, ModelTokenUsage>;
  /** Number of session files scanned. */
  sessionCount: number;
  /** Number of assistant turns counted. */
  turnCount: number;
  /** Status indicator for successful computation */
  status: 'success';
  /** Snapshot of pricing table used for cost calculation (HOK-858) */
  pricingUsed: Record<string, ModelPricing>;
  /** Optional additive attribution metadata for native workflow cost coverage. */
  attribution?: WorkflowCostAttribution;
}

/** Failure result with diagnostic information (HOK-883). */
export interface WorkflowCostFailure {
  /** Status code indicating why cost computation failed */
  status: 'no_sessions' | 'no_branch' | 'adapter_error' | 'missing_worktree' | 'skipped';
  /** Human-readable reason for failure */
  reason: string;
  /** Diagnostic details to help debug the issue */
  diagnostics: {
    worktreePath?: string;
    branchName?: string;
    agentType?: string;
    sessionFilesFound?: number;
    totalAssistantTurns?: number;
    branchMismatches?: number;
    matchingTurns?: number;
  };
}

/** Result of workflow cost computation - either success or failure with diagnostics */
export type WorkflowCostOutcome = WorkflowCostResult | WorkflowCostFailure;

/** Per-model pricing entry (from .wavemill-config.json). */
export interface ModelPricing {
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  cacheWriteCostPerMTok?: number;
  cacheReadCostPerMTok?: number;
}

export type PricingTable = Record<string, ModelPricing>;

export interface ExactPricingOptions {
  fetchGenerationCost?: (id: string) => Promise<OpenRouterGenerationCost | null>;
  concurrency?: number;
  enabled?: boolean;
  logger?: Pick<Console, 'warn'>;
}

// ────────────────────────────────────────────────────────────────
// Project directory resolution
// ────────────────────────────────────────────────────────────────

/**
 * Derive the Claude projects directory name from a worktree absolute path.
 *
 * Claude Code encodes the working directory path by replacing `/` with `-`.
 * For example:
 *   /Users/tim/worktrees/my-feature → -Users-tim-worktrees-my-feature
 *
 * @param worktreePath - Absolute path to the worktree
 * @returns The encoded project directory name
 */
export function encodeProjectDir(worktreePath: string): string {
  const absolute = resolve(worktreePath);
  return absolute.replace(/\//g, '-');
}

/**
 * Resolve the full path to the Claude projects directory for a worktree.
 *
 * @param worktreePath - Absolute path to the worktree
 * @returns Full path to `~/.claude/projects/<encoded-path>/`
 */
export function resolveProjectsDir(worktreePath: string): string {
  const encoded = encodeProjectDir(worktreePath);
  return join(homedir(), '.claude', 'projects', encoded);
}

export function resolveProjectsDirs(worktreePath: string): string[] {
  const encoded = encodeProjectDir(worktreePath);
  const dirs = [resolveProjectsDir(worktreePath)];
  const runsDir = join(resolve(worktreePath), '.wavemill', 'runs');

  if (!existsSync(runsDir)) {
    return dirs;
  }

  try {
    for (const runEntry of readdirSync(runsDir, { withFileTypes: true })) {
      if (!runEntry.isDirectory()) {
        continue;
      }

      const providerProjectsDir = join(
        runsDir,
        runEntry.name,
        'providers',
        'deepseek',
        'home',
        '.claude',
        'projects',
        encoded,
      );
      if (existsSync(providerProjectsDir)) {
        dirs.push(providerProjectsDir);
      }
    }
  } catch {
    return dirs;
  }

  return [...new Set(dirs)];
}

// ────────────────────────────────────────────────────────────────
// Pricing
// ────────────────────────────────────────────────────────────────

/** Default cache pricing multipliers (relative to input cost). */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/**
 * Load the pricing table from .wavemill-config.json.
 *
 * @param repoDir - Repository root directory
 * @returns Pricing table, or empty object if unavailable
 */
export function loadPricingTable(repoDir?: string): PricingTable {
  const registryPricing: PricingTable = Object.fromEntries(
    Object.entries(getEffectiveRegistry(repoDir).models)
      .filter(([, capabilities]) => capabilities.pricing)
      .map(([modelId, capabilities]) => [modelId, { ...capabilities.pricing! }]),
  );
  const config = loadWavemillConfig(repoDir);
  if (config.eval?.pricing && typeof config.eval.pricing === 'object') {
    return {
      ...registryPricing,
      ...config.eval.pricing,
    };
  }
  return registryPricing;
}

export function loadConfiguredPricingTable(repoDir?: string): PricingTable {
  const config = loadWavemillConfig(repoDir);
  if (config.eval?.pricing && typeof config.eval.pricing === 'object') {
    return config.eval.pricing;
  }
  return {};
}

/**
 * Compute cost for a set of tokens using cache-aware pricing.
 *
 * If cache-specific rates aren't configured, derives them from
 * the base input rate using standard multipliers (1.25x write, 0.1x read).
 */
export function computeModelCost(
  usage: Omit<ModelTokenUsage, 'costUsd'>,
  pricing: ModelPricing,
): number {
  const inputRate = pricing.inputCostPerMTok;
  const outputRate = pricing.outputCostPerMTok;
  const cacheWriteRate = pricing.cacheWriteCostPerMTok ?? inputRate * CACHE_WRITE_MULTIPLIER;
  const cacheReadRate = pricing.cacheReadCostPerMTok ?? inputRate * CACHE_READ_MULTIPLIER;

  const inputCost = (usage.inputTokens * inputRate) / 1_000_000;
  const cacheWriteCost = (usage.cacheCreationTokens * cacheWriteRate) / 1_000_000;
  const cacheReadCost = (usage.cacheReadTokens * cacheReadRate) / 1_000_000;
  const outputCost = (usage.outputTokens * outputRate) / 1_000_000;

  return inputCost + cacheWriteCost + cacheReadCost + outputCost;
}

export interface NormalizedEvaluationCost {
  costUsd: number | null;
  basis: 'explicit_pricing' | 'incomplete';
  coverage: 'complete' | 'missing_token_usage' | 'missing_cache_usage' | 'missing_cache_pricing';
  pricingRevision?: string;
}

export function computeNormalizedEvaluationCost(
  usage: Partial<Omit<ModelTokenUsage, 'costUsd'>>,
  pricing: ModelPricing,
  options: { requireExplicitCache?: boolean; pricingRevision?: string } = {},
): NormalizedEvaluationCost {
  const hasBaseUsage = typeof usage.inputTokens === 'number'
    && typeof usage.outputTokens === 'number';
  if (!hasBaseUsage) {
    return {
      costUsd: null,
      basis: 'incomplete',
      coverage: 'missing_token_usage',
      pricingRevision: options.pricingRevision,
    };
  }
  const hasCacheUsage = typeof usage.cacheCreationTokens === 'number'
    && typeof usage.cacheReadTokens === 'number';
  if (!hasCacheUsage) {
    return {
      costUsd: null,
      basis: 'incomplete',
      coverage: 'missing_cache_usage',
      pricingRevision: options.pricingRevision,
    };
  }
  if (
    options.requireExplicitCache === true
    && (pricing.cacheWriteCostPerMTok === undefined || pricing.cacheReadCostPerMTok === undefined)
  ) {
    return {
      costUsd: null,
      basis: 'incomplete',
      coverage: 'missing_cache_pricing',
      pricingRevision: options.pricingRevision,
    };
  }
  if (
    !isFiniteNonNegative(usage.inputTokens)
    || !isFiniteNonNegative(usage.outputTokens)
    || !isFiniteNonNegative(usage.cacheCreationTokens)
    || !isFiniteNonNegative(usage.cacheReadTokens)
  ) {
    return {
      costUsd: null,
      basis: 'incomplete',
      coverage: 'missing_cache_usage',
      pricingRevision: options.pricingRevision,
    };
  }
  return {
    costUsd: computeModelCost({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      cacheReadTokens: usage.cacheReadTokens,
    }, pricing),
    basis: 'explicit_pricing',
    coverage: 'complete',
    pricingRevision: options.pricingRevision,
  };
}

function isExplicitZeroPricing(pricing: ModelPricing): boolean {
  return pricing.inputCostPerMTok === 0
    && pricing.outputCostPerMTok === 0
    && (pricing.cacheWriteCostPerMTok ?? 0) === 0
    && (pricing.cacheReadCostPerMTok ?? 0) === 0;
}

function isFiniteNonNegative(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function setOptionalNumber(target: WorkflowCostAttributionModel, key: keyof WorkflowCostAttributionModel, value: number | undefined): void {
  if (value !== undefined) {
    (target as Record<string, unknown>)[key] = value;
  }
}

function mergePricingSource(
  current: WorkflowCostPricingSource | undefined,
  next: WorkflowCostPricingSource,
): WorkflowCostPricingSource {
  return current === undefined || current === next ? next : 'mixed';
}

function usageFromNativeTurn(
  turn: NativeSessionUsageRecord['turns'][number],
): Omit<ModelTokenUsage, 'costUsd'> {
  return {
    inputTokens: turn.inputTokens ?? 0,
    cacheCreationTokens: turn.cacheCreationTokens ?? 0,
    cacheReadTokens: turn.cacheReadTokens ?? 0,
    outputTokens: turn.outputTokens ?? 0,
  };
}

function usageFromNativeSession(session: NativeSessionUsageRecord): Omit<ModelTokenUsage, 'costUsd'> {
  return {
    inputTokens: session.inputTokens ?? 0,
    cacheCreationTokens: session.cacheCreationTokens ?? 0,
    cacheReadTokens: session.cacheReadTokens ?? 0,
    outputTokens: session.outputTokens ?? 0,
  };
}

function computeNativeWorkflowCost(
  scanResult: SessionUsageResult,
  pricingTable: PricingTable,
  repoDir: string | undefined,
  exactCosts?: ReadonlyMap<string, OpenRouterGenerationCost | null>,
): WorkflowCostResult {
  const registry = getEffectiveRegistry(repoDir);
  const pricingUsed: Record<string, ModelPricing> = {};
  const modelsWithCost: Record<string, ModelTokenUsage> = Object.fromEntries(
    Object.entries(scanResult.models).map(([modelId, usage]) => [modelId, { ...usage, costUsd: 0 }]),
  );
  const attributionModels = new Map<string, WorkflowCostAttributionModel>();
  let totalCostUsd = 0;
  let pricedSessions = 0;
  let unpricedSessions = 0;
  let hasUnavailable = false;
  let hasNonZeroCost = false;
  let allPricedSessionsAreKnownZero = true;
  let usedProviderReportedCost = false;
  let usedLocalEstimateFallback = false;
  let exactPricingAttempted = false;
  const reasons = new Set<WorkflowCostAttributionReason>();

  for (const session of scanResult.nativeSessions ?? []) {
    const canonicalModelId = resolveModelRegistryKey(registry, session.modelId);
    const pricing = pricingTable[canonicalModelId] ?? pricingTable[session.modelId];
    const providerCost = isFiniteNonNegative(session.providerReportedCostUsd)
      ? session.providerReportedCostUsd
      : undefined;
    const aggregateKey = `${session.provider}\0${canonicalModelId}`;
    let model = attributionModels.get(aggregateKey);
    if (!model) {
      model = {
        provider: session.provider,
        modelId: canonicalModelId,
        priced: false,
      };
      attributionModels.set(aggregateKey, model);
    }

    model.inputTokens = (model.inputTokens ?? 0) + (session.inputTokens ?? 0);
    model.outputTokens = (model.outputTokens ?? 0) + (session.outputTokens ?? 0);
    model.cacheReadTokens = (model.cacheReadTokens ?? 0) + (session.cacheReadTokens ?? 0);
    model.cacheCreationTokens = (model.cacheCreationTokens ?? 0) + (session.cacheCreationTokens ?? 0);
    model.totalTokens = (model.totalTokens ?? 0) + (session.totalTokens ?? 0);

    let sessionCost: number | undefined;
    let reason: WorkflowCostAttributionReason | undefined;
    let sessionPricingSource: WorkflowCostPricingSource | undefined;

    if (exactCosts && session.turns.length > 0) {
      for (const turn of session.turns) {
        const exactCost = turn.responseId ? exactCosts.get(turn.responseId) : undefined;
        if (turn.responseId && exactCosts.has(turn.responseId)) {
          exactPricingAttempted = true;
        }
        if (exactCost) {
          const cost = exactCost.totalCostUsd;
          sessionCost = (sessionCost ?? 0) + cost;
          model.providerReportedCostUsd = (model.providerReportedCostUsd ?? 0) + cost;
          sessionPricingSource = mergePricingSource(sessionPricingSource, 'openrouter_api');
          usedProviderReportedCost = true;
          continue;
        }

        if (turn.invalidUsage) {
          reason ??= 'invalid_token_usage';
          continue;
        }
        if (!turn.usageAvailable) {
          reason ??= 'missing_token_usage';
          continue;
        }
        if (!pricing) {
          reason ??= 'unpriced_model';
          continue;
        }

        const cost = computeModelCost(usageFromNativeTurn(turn), pricing);
        sessionCost = (sessionCost ?? 0) + cost;
        pricingUsed[canonicalModelId] = pricing;
        sessionPricingSource = mergePricingSource(sessionPricingSource, 'local_estimate');
        if (turn.responseId) {
          usedLocalEstimateFallback = true;
        }
      }
    } else {
    // A provider that simply omits cost reports 0, which is indistinguishable
    // from a genuinely free call. Trusting it zeroed the cost of every
    // OpenRouter-backed run that had real token usage. Only accept a reported
    // zero when the model is priced at zero, or when there is no usage to
    // price from; otherwise fall through and compute from the pricing table.
    // A reported zero is still authoritative when there is nothing better to
    // fall back to: no usage to price, no pricing entry for the model, or a
    // model priced at zero. Without the `pricing === undefined` case, genuinely
    // free models absent from the pricing table (OpenRouter `:free` variants,
    // local providers) would flip from a correct $0 to `unpriced_model` and
    // report no cost at all.
    const providerCostIsTrustworthy = providerCost !== undefined
      && (providerCost > 0
        || !session.usageAvailable
        || pricing === undefined
        || isExplicitZeroPricing(pricing));
    if (providerCostIsTrustworthy) {
      sessionCost = providerCost;
      usedProviderReportedCost = true;
      sessionPricingSource = 'openrouter_api';
      if (providerCost !== undefined) {
        model.providerReportedCostUsd = (model.providerReportedCostUsd ?? 0) + providerCost;
      }
    } else if (session.invalidUsage) {
      reason = 'invalid_token_usage';
    } else if (!session.usageAvailable) {
      reason = 'missing_token_usage';
    } else if (!pricing) {
      reason = 'unpriced_model';
    } else {
      sessionCost = computeModelCost(
        usageFromNativeSession(session),
        pricing,
      );
      pricingUsed[canonicalModelId] = pricing;
      sessionPricingSource = 'local_estimate';
    }
    }

    if (sessionCost !== undefined) {
      pricedSessions++;
      totalCostUsd += sessionCost;
      model.costUsd = (model.costUsd ?? 0) + sessionCost;
      model.priced = true;
      if (sessionPricingSource) {
        model.pricingSource = mergePricingSource(model.pricingSource, sessionPricingSource);
      }
      if (sessionCost > 0) {
        hasNonZeroCost = true;
      }
      if (sessionCost > 0 || (pricing && !isExplicitZeroPricing(pricing) && providerCost === undefined)) {
        allPricedSessionsAreKnownZero = false;
      }
      if (!modelsWithCost[canonicalModelId]) {
        modelsWithCost[canonicalModelId] = {
          inputTokens: session.inputTokens ?? 0,
          cacheCreationTokens: session.cacheCreationTokens ?? 0,
          cacheReadTokens: session.cacheReadTokens ?? 0,
          outputTokens: session.outputTokens ?? 0,
          costUsd: 0,
        };
      }
      modelsWithCost[canonicalModelId].costUsd += sessionCost;
      continue;
    }

    unpricedSessions++;
    hasUnavailable = true;
    if (reason) {
      reasons.add(reason);
      model.reason ??= reason;
    }
  }

  const coverage: WorkflowCostAttributionCoverage = pricedSessions === 0
    ? 'unavailable'
    : hasUnavailable || (exactPricingAttempted && usedLocalEstimateFallback)
      ? 'partial'
      : !hasNonZeroCost && allPricedSessionsAreKnownZero
        ? 'known_zero'
        : 'complete';
  const reason = coverage === 'partial'
    ? 'mixed_coverage'
    : coverage === 'known_zero'
      ? undefined
      : usedProviderReportedCost && reasons.size === 0
        ? 'provider_reported_cost'
        : reasons.values().next().value ?? (coverage === 'unavailable' ? 'no_priced_sessions' : undefined);

  return {
    totalCostUsd,
    models: modelsWithCost,
    sessionCount: scanResult.sessionCount,
    turnCount: scanResult.turnCount,
    status: 'success',
    pricingUsed,
    attribution: {
      source: 'native',
      coverage,
      ...(reason ? { reason } : {}),
      sessions: scanResult.sessionCount,
      turns: scanResult.turnCount,
      pricedSessions,
      unpricedSessions,
      models: [...attributionModels.values()].map((model) => {
        const sanitized: WorkflowCostAttributionModel = {
          provider: model.provider,
          modelId: model.modelId,
          priced: model.priced,
        };
        setOptionalNumber(sanitized, 'inputTokens', model.inputTokens);
        setOptionalNumber(sanitized, 'outputTokens', model.outputTokens);
        setOptionalNumber(sanitized, 'cacheReadTokens', model.cacheReadTokens);
        setOptionalNumber(sanitized, 'cacheCreationTokens', model.cacheCreationTokens);
        setOptionalNumber(sanitized, 'totalTokens', model.totalTokens);
        setOptionalNumber(sanitized, 'costUsd', model.costUsd);
        setOptionalNumber(sanitized, 'providerReportedCostUsd', model.providerReportedCostUsd);
        if (model.reason) {
          sanitized.reason = model.reason;
        }
        if (model.pricingSource) {
          sanitized.pricingSource = model.pricingSource;
        }
        return sanitized;
      }),
    },
  };
}

// ────────────────────────────────────────────────────────────────
// Session scanning
// ────────────────────────────────────────────────────────────────

/**
 * Scan agent session files for a given branch and compute
 * the total workflow cost.
 *
 * @param opts.worktreePath - Absolute path to the worktree
 * @param opts.branchName - Git branch name to filter by (e.g. "task/add-cost-data")
 * @param opts.repoDir - Repository root for loading pricing config
 * @param opts.agentType - Agent type for session adapter selection (default: 'claude')
 * @returns Aggregated cost result with diagnostics (success or failure)
 */
export function computeWorkflowCost(opts: {
  worktreePath: string;
  branchName: string;
  repoDir?: string;
  pricingTable?: PricingTable;
  agentType?: AgentType | string;
  /** Issue being costed; scopes native transcripts to this task. */
  issueId?: string;
}): WorkflowCostOutcome {
  const { worktreePath, branchName, repoDir, pricingTable: externalPricing, agentType, issueId } = opts;
  const debug = process.env.DEBUG_COST === '1' || process.env.DEBUG_COST === 'true';

  if (debug) {
    console.log('[DEBUG_COST] computeWorkflowCost() called with:');
    console.log(`[DEBUG_COST]   worktreePath: ${worktreePath}`);
    console.log(`[DEBUG_COST]   branchName: ${branchName}`);
    console.log(`[DEBUG_COST]   repoDir: ${repoDir || '(undefined)'}`);
    console.log(`[DEBUG_COST]   agentType: ${agentType || '(undefined, will default to claude)'}`);
  }

  const nativeScanResult = new NativeSessionAdapter().scan({ worktreePath, branchName, repoDir, issueId });
  const nativeHasUsableCostData = !!nativeScanResult?.nativeSessions?.some(
    (session) => session.usageAvailable || isFiniteNonNegative(session.providerReportedCostUsd),
  );
  let scanResult = nativeScanResult
    && nativeScanResult.turnCount > 0
    && (agentType === 'native' || nativeHasUsableCostData)
    ? nativeScanResult
    : null;
  let adapter = getSessionAdapter(agentType);

  if (debug) {
    console.log(`[DEBUG_COST]   Selected adapter: ${adapter.constructor.name}`);
    if (scanResult) {
      console.log('[DEBUG_COST]   Native sessions found; skipping adapter fallback');
    }
  }

  if (!scanResult) {
    scanResult = adapter.scan({ worktreePath, branchName, repoDir, issueId });
  }

  // If no sessions found, try auto-detection as a fallback
  if (!scanResult || scanResult.turnCount === 0) {
    if (debug) {
      console.log(`[DEBUG_COST]   No sessions found for agentType '${agentType || 'claude'}', attempting auto-detection`);
    }

    const detectedAgent = detectAgentType({ worktreePath, branchName, repoDir, issueId });

    if (detectedAgent && detectedAgent !== agentType) {
      // WARNING: Auto-detection was needed - this indicates a bug in agent assignment
      console.warn(
        `[COST] WARNING: Agent type mismatch detected! ` +
        `Expected '${agentType || 'claude'}' but found '${detectedAgent}' sessions. ` +
        `This indicates a bug in agent assignment logic. ` +
        `Using auto-detected agent for cost computation.`
      );

      if (debug) {
        console.log(`[DEBUG_COST]   Retrying with detected agent: ${detectedAgent}`);
      }

      adapter = getSessionAdapter(detectedAgent);
      scanResult = adapter.scan({ worktreePath, branchName, repoDir, issueId });
    }
  }

  if (!scanResult || scanResult.turnCount === 0) {
    if (debug) {
      console.log('[DEBUG_COST]   Adapter scan returned null or zero turns');
    }

    // Return failure with diagnostics (HOK-883)
    const reason = !scanResult
      ? 'No session files found in expected location'
      : 'No assistant turns matched the specified branch';

    return {
      status: scanResult ? 'no_branch' : 'no_sessions',
      reason,
      diagnostics: {
        worktreePath,
        branchName,
        agentType: agentType || 'claude',
        sessionFilesFound: scanResult?.sessionCount ?? 0,
        matchingTurns: scanResult?.turnCount ?? 0,
      },
    };
  }

  // Load pricing and compute costs (prefer caller-supplied table)
  const pricingTable = externalPricing && Object.keys(externalPricing).length > 0
    ? externalPricing
    : loadPricingTable(repoDir);

  if (scanResult.source === 'native') {
    return computeNativeWorkflowCost(scanResult, pricingTable, repoDir);
  }

  let totalCostUsd = 0;
  const modelsWithCost: Record<string, ModelTokenUsage> = {};
  const pricingUsed: Record<string, ModelPricing> = {};
  const attributionModels: WorkflowCostAttributionModel[] = [];
  const attributionModelsById = new Map<string, WorkflowCostAttributionModel>();
  let pricedSessions = 0;
  let unpricedSessions = 0;
  let allPricedAreExplicitZero = true;

  for (const [modelId, usage] of Object.entries(scanResult.models)) {
    const pricing = pricingTable[modelId];
    let costUsd = 0;

    if (pricing) {
      costUsd = computeModelCost(usage, pricing);
      // Capture pricing snapshot for models that were actually used
      pricingUsed[modelId] = pricing;
      pricedSessions++;
      if (!isExplicitZeroPricing(pricing)) {
        allPricedAreExplicitZero = false;
      }
    } else {
      unpricedSessions++;
    }
    // Legacy numeric view: an unpriced model still contributes costUsd 0 to
    // modelsWithCost/totalCostUsd for old readers. The attribution below is
    // the truthful view — an unpriced model row carries no costUsd at all.

    modelsWithCost[modelId] = { ...usage, costUsd };
    totalCostUsd += costUsd;
    const attributionModel: WorkflowCostAttributionModel = {
      provider: scanResult.source ?? 'claude',
      modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      totalTokens: usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens + usage.outputTokens,
      priced: !!pricing,
      ...(pricing
        ? { costUsd, pricingSource: 'local_estimate' as const }
        : { reason: 'unpriced_model' as const }),
    };
    attributionModels.push(attributionModel);
    attributionModelsById.set(modelId, attributionModel);
  }

  // Provider-reported actual cost (HOK-2958): retained alongside the local
  // estimate when a session carries it, so the two stay distinguishable.
  // Today's Claude Code / Codex telemetry reports no cost, so this yields
  // nothing for current sources.
  const externalSessions = scanResult.externalSessions ?? [];
  let usedProviderReportedCost = false;
  for (const session of externalSessions) {
    if (!isFiniteNonNegative(session.actualCostUsd ?? undefined)) continue;
    const sessionModels = new Set(
      session.turns.map((turn) => turn.model).filter((model): model is string => !!model),
    );
    const target = sessionModels.size === 1
      ? attributionModelsById.get([...sessionModels][0])
      : attributionModelsById.size === 1
        ? [...attributionModelsById.values()][0]
        : undefined;
    if (target) {
      target.providerReportedCostUsd = (target.providerReportedCostUsd ?? 0) + session.actualCostUsd!;
      usedProviderReportedCost = true;
    }
  }

  // Real session/turn counts when per-session detail exists. A session whose
  // turn structure the source did not expose still executed at least once.
  const attributionSessions = externalSessions.length > 0
    ? externalSessions.length
    : scanResult.sessionCount;
  const attributionTurns = externalSessions.length > 0
    ? externalSessions.reduce((sum, session) => sum + Math.max(session.turnCount, 1), 0)
    : scanResult.turnCount;

  const coverage: WorkflowCostAttributionCoverage = pricedSessions === 0
    ? 'unavailable'
    : unpricedSessions > 0
      ? 'partial'
      : totalCostUsd === 0 && allPricedAreExplicitZero
        ? 'known_zero'
        : 'complete';
  const reason: WorkflowCostAttributionReason | undefined =
    coverage === 'unavailable' || coverage === 'partial'
      ? 'unpriced_model'
      : coverage === 'complete' && usedProviderReportedCost
        ? 'provider_reported_cost'
        : undefined;

  return {
    totalCostUsd,
    models: modelsWithCost,
    sessionCount: scanResult.sessionCount,
    turnCount: scanResult.turnCount,
    status: 'success',
    pricingUsed,
    attribution: {
      source: (scanResult.source === 'codex' ? 'codex' : 'claude') as 'codex' | 'claude',
      coverage,
      ...(reason ? { reason } : {}),
      sessions: attributionSessions,
      turns: attributionTurns,
      pricedSessions,
      unpricedSessions,
      models: attributionModels,
    },
  };
}

export async function computeWorkflowCostWithExactPricing(
  opts: Parameters<typeof computeWorkflowCost>[0] & { exact?: ExactPricingOptions },
): Promise<WorkflowCostOutcome> {
  const baseline = computeWorkflowCost(opts);
  if (baseline.status !== 'success') {
    return baseline;
  }
  if (process.env.WAVEMILL_DISABLE_OPENROUTER_COST === '1') {
    return baseline;
  }

  const enabled = opts.exact?.enabled ?? !!process.env.OPENROUTER_API_KEY;
  if (!enabled) {
    return baseline;
  }

  const scanResult = new NativeSessionAdapter().scan({
    worktreePath: opts.worktreePath,
    branchName: opts.branchName,
    repoDir: opts.repoDir,
    issueId: opts.issueId,
  });
  if (!scanResult || scanResult.source !== 'native' || !scanResult.nativeSessions?.length) {
    return baseline;
  }

  const responseIds = scanResult.nativeSessions.flatMap((session) => session.responseIds);
  if (responseIds.length === 0) {
    return computeNativeWorkflowCost(
      scanResult,
      opts.pricingTable && Object.keys(opts.pricingTable).length > 0 ? opts.pricingTable : loadPricingTable(opts.repoDir),
      opts.repoDir,
    );
  }

  const exactCosts = opts.exact?.fetchGenerationCost
    ? await fetchWithInjectedCost(responseIds, opts.exact.fetchGenerationCost, opts.exact.concurrency)
    : await fetchGenerationCostsBatched(responseIds, { concurrency: opts.exact?.concurrency });
  const failedCount = [...exactCosts.values()].filter((cost) => cost === null).length;
  if (failedCount > 0) {
    opts.exact?.logger?.warn?.(`[COST] OpenRouter exact cost unavailable for ${failedCount} generation(s); using local pricing fallback`);
  }

  return computeNativeWorkflowCost(
    scanResult,
    opts.pricingTable && Object.keys(opts.pricingTable).length > 0 ? opts.pricingTable : loadPricingTable(opts.repoDir),
    opts.repoDir,
    exactCosts,
  );
}

async function fetchWithInjectedCost(
  generationIds: readonly string[],
  fetchGenerationCost: (id: string) => Promise<OpenRouterGenerationCost | null>,
  concurrency = 6,
): Promise<Map<string, OpenRouterGenerationCost | null>> {
  const uniqueIds = [...new Set(generationIds)];
  const results = new Map<string, OpenRouterGenerationCost | null>();
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < uniqueIds.length) {
      const id = uniqueIds[nextIndex++];
      try {
        results.set(id, await fetchGenerationCost(id));
      } catch {
        results.set(id, null);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), uniqueIds.length) }, () => worker()));
  return results;
}

// ────────────────────────────────────────────────────────────────
// Cost Recalculation (HOK-858)
// ────────────────────────────────────────────────────────────────

/**
 * Recalculate workflow cost using a different pricing table.
 *
 * Takes an existing WorkflowCostResult and recalculates the costs
 * using the provided pricing table, preserving the original token usage.
 * This enables cost normalization when pricing changes over time.
 *
 * @param originalResult - Original cost computation result
 * @param newPricing - New pricing table to use for recalculation
 * @returns New result with recalculated costs and updated pricing snapshot
 *
 * @example
 * ```typescript
 * // Recalculate an old eval with current pricing
 * const currentPricing = loadPricingTable();
 * const recalculated = recalculateWorkflowCost(oldResult, currentPricing);
 * console.log(`Original: $${oldResult.totalCostUsd}`);
 * console.log(`Current pricing: $${recalculated.totalCostUsd}`);
 * ```
 */
export function recalculateWorkflowCost(
  originalResult: WorkflowCostResult,
  newPricing: PricingTable
): WorkflowCostResult {
  // Recalculate costs for each model using new pricing
  let totalCostUsd = 0;
  const modelsWithCost: Record<string, ModelTokenUsage> = {};
  const pricingUsed: Record<string, ModelPricing> = {};

  for (const [modelId, usage] of Object.entries(originalResult.models)) {
    const pricing = newPricing[modelId];
    let costUsd = 0;

    if (pricing) {
      // Extract usage without costUsd for recalculation
      const usageOnly: Omit<ModelTokenUsage, 'costUsd'> = {
        inputTokens: usage.inputTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        cacheReadTokens: usage.cacheReadTokens,
        outputTokens: usage.outputTokens,
      };
      costUsd = computeModelCost(usageOnly, pricing);
      // Capture the pricing that was used
      pricingUsed[modelId] = pricing;
    }
    // If model not in new pricing table, cost stays 0 (best-effort)

    modelsWithCost[modelId] = { ...usage, costUsd };
    totalCostUsd += costUsd;
  }

  return {
    totalCostUsd,
    models: modelsWithCost,
    sessionCount: originalResult.sessionCount,
    turnCount: originalResult.turnCount,
    status: 'success',
    pricingUsed,
  };
}
