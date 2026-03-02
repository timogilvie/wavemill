#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import '../shared/lib/env.js';
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listInitiatives } from '../shared/lib/initiative-lister.ts';
import { decomposeInitiative } from '../shared/lib/initiative-decomposer.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PLAN_MODEL = process.env.PLAN_MODEL || 'claude-opus-4-6';

if (!process.env.LINEAR_API_KEY) {
  console.error('Error: LINEAR_API_KEY not found in environment');
  process.exit(1);
}

// ============================================================================
// SUB-COMMANDS
// ============================================================================

async function handleList(args: any): Promise<void> {
  const projectName = args.project as string | undefined;
  const maxDisplay = args['max-display'] ? parseInt(args['max-display'] as string) : 9;

  const initiatives = await listInitiatives({ projectName, maxDisplay });

  // Output JSON to stdout
  console.log(JSON.stringify(initiatives, null, 2));
}

async function handleDecompose(args: any): Promise<void> {
  const initiativeId = args.initiative as string;
  if (!initiativeId) {
    console.error('Error: --initiative <id> is required');
    process.exit(1);
  }

  const projectName = args.project as string | undefined;
  const dryRun = !!args['dry-run'];
  const runResearch = !!args.research;

  // Load system prompt
  const promptPath = path.join(__dirname, 'prompts/initiative-planner.md');
  const systemPrompt = await fs.readFile(promptPath, 'utf-8');

  // Load research prompt if needed
  let researchPrompt: string | undefined;
  if (runResearch) {
    const researchPath = path.join(__dirname, 'prompts/research-phase.md');
    researchPrompt = await fs.readFile(researchPath, 'utf-8');
  }

  if (dryRun) {
    // For dry-run, we need to handle decomposition differently
    // because decomposeInitiative always creates issues
    // TODO: Could refactor decomposeInitiative to support dry-run mode
    console.log('Dry-run mode not yet supported with new architecture.');
    console.log('Use decompose without --dry-run to create issues in Linear.');
    process.exit(1);
  }

  const repoRoot = path.resolve(__dirname, '..');

  await decomposeInitiative({
    initiativeId,
    projectName,
    systemPrompt,
    researchPrompt,
    model: PLAN_MODEL,
    repoRoot,
  });
}

// ============================================================================
// MAIN
// ============================================================================

runTool({
  name: 'plan-initiative',
  description: 'Decompose Linear initiatives into well-scoped issues',
  options: {
    project: { type: 'string', description: 'Linear project name' },
    'max-display': { type: 'string', description: 'Maximum initiatives to return (default: 9)' },
    initiative: { type: 'string', description: 'Linear initiative ID (for decompose)' },
    'dry-run': { type: 'boolean', description: 'Show plan without creating issues' },
    research: { type: 'boolean', description: 'Run research phase before decomposition' },
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  positional: {
    name: 'subcommand',
    description: 'Subcommand: list or decompose',
  },
  examples: [
    'npx tsx tools/plan-initiative.ts list',
    'npx tsx tools/plan-initiative.ts list --project "My Project"',
    'npx tsx tools/plan-initiative.ts decompose --initiative abc-123',
    'npx tsx tools/plan-initiative.ts decompose --initiative abc-123 --research',
  ],
  additionalHelp: `Sub-commands:
  list       Fetch and rank initiatives, output JSON to stdout
  decompose  Decompose an initiative into issues using Claude

Environment Variables:
  LINEAR_API_KEY   Required: Linear API key
  CLAUDE_CMD       Optional: Claude CLI command (default: 'claude')
  PLAN_MODEL       Optional: LLM model for planning (default: claude-opus-4-6)`,
  async run({ args, positional }) {
    const subCommand = positional[0];

    if (!subCommand) {
      console.error('Error: Subcommand required (list or decompose)');
      process.exit(1);
    }

    try {
      switch (subCommand) {
        case 'list':
          await handleList(args);
          break;
        case 'decompose':
          await handleDecompose(args);
          break;
        default:
          console.error(`Unknown sub-command: ${subCommand}`);
          process.exit(1);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('Error:', errorMsg);
      process.exit(1);
    }
  },
});
