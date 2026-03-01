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

import { readFileSync } from 'fs';
import {
  recommendModel,
  loadRouterConfig,
  isRouterEnabled,
} from '../shared/lib/model-router.ts';
import type { ModelRecommendation } from '../shared/lib/model-router.ts';
import { CYAN, GREEN, YELLOW, RED, BOLD, DIM, NC } from '../shared/lib/colors.ts';

// ── Argument Parsing ─────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file' && argv[i + 1]) {
      args.file = argv[++i];
    } else if (argv[i] === '--json') {
      args.json = true;
    } else if (argv[i] === '--repo-dir' && argv[i + 1]) {
      args.repoDir = argv[++i];
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      args.help = true;
    } else if (!argv[i].startsWith('--')) {
      positional.push(argv[i]);
    }
  }

  if (positional.length > 0) {
    args.prompt = positional.join(' ');
  }

  return args;
}

function showHelp(): void {
  console.log(`
Suggest Model Tool — Recommend the best LLM based on historical eval data

Usage:
  npx tsx tools/suggest-model.ts "prompt text here"
  npx tsx tools/suggest-model.ts --file task-packet.md
  npx tsx tools/suggest-model.ts --json "prompt text"

Options:
  --file PATH      Read prompt from a file instead of CLI argument
  --json           Output recommendation as JSON
  --repo-dir DIR   Repository directory (default: current directory)
  --help, -h       Show this help message

Examples:
  # Suggest model for a prompt
  npx tsx tools/suggest-model.ts "Add OAuth2 authentication to the API"

  # Suggest model from a task packet file
  npx tsx tools/suggest-model.ts --file features/my-feature/selected-task.json

  # Get JSON output for scripting
  npx tsx tools/suggest-model.ts --json "Fix the login page crash"
`);
}

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

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  // Resolve prompt from file or CLI argument
  let prompt = '';
  if (args.file) {
    try {
      const content = readFileSync(String(args.file), 'utf-8');
      // If it's JSON (e.g. selected-task.json), extract title + description
      if (String(args.file).endsWith('.json')) {
        const data = JSON.parse(content);
        prompt = `${data.title || ''}\n\n${data.description || ''}`.trim();
      } else {
        prompt = content;
      }
    } catch (err) {
      console.error(`Error reading file: ${(err as Error).message}`);
      process.exit(1);
    }
  } else if (args.prompt) {
    prompt = String(args.prompt);
  } else {
    console.error('Error: Provide a prompt as argument or via --file');
    console.error('Run with --help for usage information.');
    process.exit(1);
  }

  const repoDir = args.repoDir ? String(args.repoDir) : process.cwd();

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
}

main();
