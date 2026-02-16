/**
 * Workflow cost scanner — reads Claude Code session files and computes
 * the total cost of building a feature across all sessions on a branch.
 *
 * Session files live under `~/.claude/projects/<project-dir>/` as JSONL.
 * Each assistant turn contains `message.usage` with token counts and
 * `gitBranch` at the top level.
 *
 * @module workflow-cost
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

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
}

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
  const configPath = resolve(repoDir || process.cwd(), '.wavemill-config.json');
  if (!existsSync(configPath)) return {};
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (config.eval?.pricing && typeof config.eval.pricing === 'object') {
      return config.eval.pricing;
    }
  } catch {
    // Malformed config — return empty
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
 * Scan Claude Code session files for a given branch and compute
 * the total workflow cost.
 *
 * @param opts.worktreePath - Absolute path to the worktree
 * @param opts.branchName - Git branch name to filter by (e.g. "task/add-cost-data")
 * @param opts.repoDir - Repository root for loading pricing config
 * @returns Aggregated cost result, or null if no sessions found
 */
export function computeWorkflowCost(opts: {
  worktreePath: string;
  branchName: string;
  repoDir?: string;
}): WorkflowCostResult | null {
  const { worktreePath, branchName, repoDir } = opts;
  const projectsDir = resolveProjectsDir(worktreePath);

  if (!existsSync(projectsDir)) {
    return null;
  }

  // Find all JSONL session files
  let sessionFiles: string[];
  try {
    sessionFiles = readdirSync(projectsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(projectsDir, f));
  } catch {
    return null;
  }

  if (sessionFiles.length === 0) {
    return null;
  }

  // Aggregate token usage per model
  const models: Record<string, Omit<ModelTokenUsage, 'costUsd'>> = {};
  let turnCount = 0;
  let sessionCount = 0;

  for (const filePath of sessionFiles) {
    let sessionHadTurns = false;

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;

        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line);
        } catch {
          continue; // Skip malformed lines
        }

        // Only count assistant turns with matching branch
        if (entry.type !== 'assistant') continue;
        if (entry.gitBranch !== branchName) continue;

        const message = entry.message as Record<string, unknown> | undefined;
        if (!message) continue;

        const usage = message.usage as Record<string, unknown> | undefined;
        if (!usage) continue;

        const modelId = (message.model as string) || 'unknown';
        const inputTokens = (usage.input_tokens as number) || 0;
        const cacheCreationTokens = (usage.cache_creation_input_tokens as number) || 0;
        const cacheReadTokens = (usage.cache_read_input_tokens as number) || 0;
        const outputTokens = (usage.output_tokens as number) || 0;

        if (!models[modelId]) {
          models[modelId] = {
            inputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 0,
          };
        }

        models[modelId].inputTokens += inputTokens;
        models[modelId].cacheCreationTokens += cacheCreationTokens;
        models[modelId].cacheReadTokens += cacheReadTokens;
        models[modelId].outputTokens += outputTokens;

        turnCount++;
        sessionHadTurns = true;
      }
    } catch {
      // Skip unreadable files
      continue;
    }

    if (sessionHadTurns) {
      sessionCount++;
    }
  }

  if (turnCount === 0) {
    return null;
  }

  // Load pricing and compute costs
  const pricingTable = loadPricingTable(repoDir);
  let totalCostUsd = 0;
  const modelsWithCost: Record<string, ModelTokenUsage> = {};

  for (const [modelId, usage] of Object.entries(models)) {
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
    sessionCount,
    turnCount,
  };
}
