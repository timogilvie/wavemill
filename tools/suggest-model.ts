#!/usr/bin/env -S npx tsx

/**
 * Suggest Model Tool
 *
 * Recommends the best LLM model for a task based on historical eval data
 * and prompt characteristics.
 *
 * Usage:
 *   npx tsx tools/suggest-model.ts "prompt text here"
 *   npx tsx tools/suggest-model.ts --file task-packet.md
 *   npx tsx tools/suggest-model.ts --json "prompt text"
 */

import { readFileSync } from "node:fs";
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  recommendModel,
  loadRouterConfig,
  isRouterEnabled,
} from '../shared/lib/model-router.ts';
import type { ModelRecommendation } from '../shared/lib/model-router.ts';
import { CYAN, GREEN, YELLOW, RED, BOLD, DIM, NC } from '../shared/lib/colors.ts';

// ── Output Formatting ────────────────────────────────────────────────────────

function formatRecommendation(rec: ModelRecommendation): string {
  const SEP = '\u2550'.repeat(50);
  const lines: string[] = [];

  lines.push('');
  lines.push(`${BOLD}${CYAN}${SEP}${NC}`);
  lines.push(`${BOLD}${CYAN}  MODEL RECOMMENDATION${NC}`);
  lines.push(`${BOLD}${CYAN}${SEP}${NC}`);
  lines.push('');

  lines.push(`  ${DIM}Task Type:${NC}  ${rec.taskType}`);

  const confColor =
    rec.confidence === 'high' ? GREEN :
    rec.confidence === 'medium' ? YELLOW : RED;
  lines.push(`  ${DIM}Confidence:${NC} ${confColor}${rec.confidence}${NC}`);
  lines.push('');

  if (rec.insufficientData) {
    lines.push(`  ${YELLOW}Insufficient eval data for routing.${NC}`);
    lines.push(`  ${DIM}Fallback:${NC} ${rec.recommendedModel} (agent: ${rec.recommendedAgent})`);
    lines.push('');
    lines.push(`  ${DIM}${rec.reasoning}${NC}`);
  } else {
    // Recommended model
    const best = rec.candidates[0];
    if (best) {
      lines.push(
        `  ${BOLD}${GREEN}Recommended:${NC} ${BOLD}${best.modelId}${NC} (agent: ${rec.recommendedAgent})`,
      );
      lines.push(
        `    Avg Score: ${GREEN}${best.avgScore.toFixed(2)}${NC}` +
        `  ${DIM}(n=${best.taskTypeRecordCount > 0 ? best.taskTypeRecordCount : best.recordCount})${NC}`,
      );
    }

    // Alternatives
    const alternatives = rec.candidates.slice(1);
    if (alternatives.length > 0) {
      lines.push('');
      lines.push(`  ${DIM}Alternatives:${NC}`);
      for (const alt of alternatives) {
        const scoreColor = alt.avgScore >= 0.8 ? GREEN : alt.avgScore >= 0.5 ? YELLOW : RED;
        const n = alt.taskTypeRecordCount > 0 ? alt.taskTypeRecordCount : alt.recordCount;
        lines.push(
          `    ${alt.modelId.padEnd(30)} ${scoreColor}${alt.avgScore.toFixed(2)}${NC} ${DIM}(n=${n})${NC}`,
        );
      }
    }

    lines.push('');
    lines.push(`  ${DIM}${rec.reasoning}${NC}`);
  }

  lines.push('');
  lines.push(`${BOLD}${CYAN}${SEP}${NC}`);
  lines.push('');

  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

runTool({
  name: 'suggest-model',
  description: 'Recommend the best LLM based on historical eval data',
  options: {
    file: {
      type: 'string',
      description: 'Read prompt from a file instead of CLI argument'
    },
    json: {
      type: 'boolean',
      description: 'Output recommendation as JSON'
    },
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (default: current directory)'
    },
    help: {
      type: 'boolean',
      short: 'h',
      description: 'Show help message'
    },
  },
  positional: {
    name: 'prompt',
    description: 'Prompt text to analyze',
    multiple: true,
  },
  examples: [
    '# Suggest model for a prompt',
    'npx tsx tools/suggest-model.ts "Add OAuth2 authentication to the API"',
    '',
    '# Suggest model from a task packet file',
    'npx tsx tools/suggest-model.ts --file features/my-feature/selected-task.json',
    '',
    '# Get JSON output for scripting',
    'npx tsx tools/suggest-model.ts --json "Fix the login page crash"',
  ],
  async run({ args, positional }) {
    // Resolve prompt from file or CLI argument
    let prompt = '';
    if (args.file) {
      try {
        const content = readFileSync(args.file, 'utf-8');
        // If it's JSON (e.g. selected-task.json), extract title + description
        if (args.file.endsWith('.json')) {
          const data = JSON.parse(content);
          prompt = `${data.title || ''}\n\n${data.description || ''}`.trim();
        } else {
          prompt = content;
        }
      } catch (err) {
        console.error(`Error reading file: ${(err as Error).message}`);
        process.exit(1);
      }
    } else if (positional.length > 0) {
      prompt = positional.join(' ');
    } else {
      console.error('Error: Provide a prompt as argument or via --file');
      console.error('Run with --help for usage information.');
      process.exit(1);
    }

    const repoDir = args['repo-dir'] || process.cwd();

    // Check if router is enabled
    if (!isRouterEnabled(repoDir)) {
      if (args.json) {
        console.log(JSON.stringify({ disabled: true, message: 'Router is disabled in config' }));
      } else {
        console.log('Model router is disabled in config (router.enabled: false)');
      }
      process.exit(0);
    }

    // Load config and get recommendation
    const routerConfig = loadRouterConfig(repoDir);
    const recommendation = recommendModel(prompt, { ...routerConfig, repoDir });

    if (args.json) {
      console.log(JSON.stringify(recommendation, null, 2));
    } else {
      console.log(formatRecommendation(recommendation));
    }
  },
});
