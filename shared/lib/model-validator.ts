/**
 * Model validation module - validates model IDs against known models in config.
 *
 * Provides:
 * - Model existence checking (against pricing and agentMap)
 * - Helpful error messages with suggestions
 * - String similarity matching for typo detection
 * - CLI mode for bash integration
 *
 * @module model-validator
 */

import { loadWavemillConfig } from './config.ts';
import { resolveAgent } from './model-router.ts';

// ────────────────────────────────────────────────────────────────
// Known Models Discovery
// ────────────────────────────────────────────────────────────────

export interface KnownModelsResult {
  all: string[];
  byAgent: Map<string, string[]>;
}

/**
 * Get all known models from config (pricing + agentMap).
 * Returns models grouped by agent for helpful error messages.
 */
export function getKnownModels(repoDir?: string): KnownModelsResult {
  const config = loadWavemillConfig(repoDir);

  const modelSet = new Set<string>();

  // Add models from pricing config
  if (config.eval?.pricing) {
    for (const modelId of Object.keys(config.eval.pricing)) {
      modelSet.add(modelId);
    }
  }

  // Add models from agentMap
  if (config.router?.agentMap) {
    for (const modelId of Object.keys(config.router.agentMap)) {
      modelSet.add(modelId);
    }
  }

  const all = Array.from(modelSet).sort();

  // Group by agent for display
  const byAgent = new Map<string, string[]>();
  const agentMap = config.router?.agentMap || {};
  const defaultAgent = config.router?.defaultAgent || 'claude';

  for (const modelId of all) {
    const agent = resolveAgent(modelId, agentMap, defaultAgent);
    const existing = byAgent.get(agent) || [];
    existing.push(modelId);
    byAgent.set(agent, existing);
  }

  return { all, byAgent };
}

/**
 * Check if a model ID is known (exists in config).
 */
export function isValidModel(modelId: string, repoDir?: string): boolean {
  const { all } = getKnownModels(repoDir);
  return all.includes(modelId);
}

// ────────────────────────────────────────────────────────────────
// String Similarity (Levenshtein Distance)
// ────────────────────────────────────────────────────────────────

/**
 * Calculate Levenshtein distance between two strings.
 * Used for finding close matches when a model name is misspelled.
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Find the closest matching model IDs using Levenshtein distance.
 * Returns up to 3 suggestions with distance ≤ 5.
 */
export function suggestModel(invalidModel: string, repoDir?: string): string[] {
  const { all } = getKnownModels(repoDir);

  const distances = all.map((modelId) => ({
    modelId,
    distance: levenshteinDistance(invalidModel.toLowerCase(), modelId.toLowerCase()),
  }));

  return distances
    .filter((d) => d.distance <= 5)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map((d) => d.modelId);
}

// ────────────────────────────────────────────────────────────────
// Validation with Helpful Errors
// ────────────────────────────────────────────────────────────────

/**
 * Validate a model ID and throw with a helpful error if invalid.
 *
 * Error message includes:
 * - List of all known models (grouped by agent)
 * - Suggestions for similar model names
 */
export function validateModelOrThrow(modelId: string, repoDir?: string): void {
  if (isValidModel(modelId, repoDir)) {
    return;
  }

  const { all, byAgent } = getKnownModels(repoDir);

  // Build error message
  let message = `Error: Unknown model "${modelId}"\n\n`;

  if (all.length === 0) {
    message += 'No models found in .wavemill-config.json\n';
    message += 'Add models to "eval.pricing" or "router.agentMap" sections.\n';
  } else {
    message += 'Known models:\n';

    // Group by agent for clarity
    const agents = Array.from(byAgent.keys()).sort();
    for (const agent of agents) {
      const models = byAgent.get(agent) || [];
      const agentName = agent.charAt(0).toUpperCase() + agent.slice(1);
      message += `  ${agentName} models:\n`;
      for (const model of models) {
        message += `    • ${model}\n`;
      }
    }
  }

  // Add suggestions if we found close matches
  const suggestions = suggestModel(modelId, repoDir);
  if (suggestions.length > 0) {
    message += '\nDid you mean:\n';
    for (const suggestion of suggestions) {
      message += `  • ${suggestion}\n`;
    }
  }

  throw new Error(message);
}

// ────────────────────────────────────────────────────────────────
// CLI Mode (for bash integration)
// ────────────────────────────────────────────────────────────────

/**
 * CLI mode: validate a model and exit with status code.
 * Usage: npx tsx model-validator.ts <model-id> [repo-dir]
 * Exits 0 if valid, 1 if invalid (with error message on stderr)
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const modelId = process.argv[2];
  const repoDir = process.argv[3] || process.cwd();

  if (!modelId) {
    console.error('Usage: npx tsx model-validator.ts <model-id> [repo-dir]');
    process.exit(1);
  }

  try {
    validateModelOrThrow(modelId, repoDir);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  }
}
