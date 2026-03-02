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

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { getSessionAdapter, detectAgentType, type AgentType } from './session-adapters.ts';
import { loadWavemillConfig } from './config.ts';

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
}): WorkflowCostOutcome {
  const { worktreePath, branchName, repoDir, pricingTable: externalPricing, agentType } = opts;
  const debug = process.env.DEBUG_COST === '1' || process.env.DEBUG_COST === 'true';

  if (debug) {
    console.log('[DEBUG_COST] computeWorkflowCost() called with:');
    console.log(`[DEBUG_COST]   worktreePath: ${worktreePath}`);
    console.log(`[DEBUG_COST]   branchName: ${branchName}`);
    console.log(`[DEBUG_COST]   repoDir: ${repoDir || '(undefined)'}`);
    console.log(`[DEBUG_COST]   agentType: ${agentType || '(undefined, will default to claude)'}`);
  }

  // Delegate session scanning to the appropriate adapter
  let adapter = getSessionAdapter(agentType);

  if (debug) {
    console.log(`[DEBUG_COST]   Selected adapter: ${adapter.constructor.name}`);
  }

  let scanResult = adapter.scan({ worktreePath, branchName });

  // If no sessions found, try auto-detection as a fallback
  if (!scanResult || scanResult.turnCount === 0) {
    if (debug) {
      console.log(`[DEBUG_COST]   No sessions found for agentType '${agentType || 'claude'}', attempting auto-detection`);
    }

    const detectedAgent = detectAgentType({ worktreePath, branchName });

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
      scanResult = adapter.scan({ worktreePath, branchName });
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
  let totalCostUsd = 0;
  const modelsWithCost: Record<string, ModelTokenUsage> = {};

  for (const [modelId, usage] of Object.entries(scanResult.models)) {
    const pricing = pricingTable[modelId];
    let costUsd = 0;

    if (pricing) {
      costUsd = computeModelCost(usage, pricing);
    }
    // If model not in pricing table, cost stays 0 (best-effort)

    modelsWithCost[modelId] = { ...usage, costUsd };
    totalCostUsd += costUsd;
  }

  return {
    totalCostUsd,
    models: modelsWithCost,
    sessionCount: scanResult.sessionCount,
    turnCount: scanResult.turnCount,
    status: 'success',
  };
}
