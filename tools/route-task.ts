#!/usr/bin/env -S npx tsx
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { getWavemillAdditionalEvalPaths, routeBatch } from '../shared/lib/route-batch.ts';
import { inferFeatureDirFromTaskFile } from '../shared/lib/route-decision.ts';
import { readTaskPromptFromFile, summarizeWorkflowRoute } from '../shared/lib/workflow-router.ts';

runTool({
  name: 'route-task',
  description: 'Recommend planner/coder/reviewer models and expected workflow cost',
  options: {
    file: {
      type: 'string',
      description: 'Read task prompt from a file instead of CLI argument',
    },
    json: {
      type: 'boolean',
      description: 'Output machine-readable JSON',
    },
    output: {
      type: 'string',
      description: 'Write machine-readable JSON to a file instead of stdout',
    },
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (default: current directory)',
    },
    mode: {
      type: 'string',
      description: 'Routing mode: auto, stage-aware, heuristic, or hokusai',
    },
    source: {
      type: 'string',
      description: 'Route provenance source (bootstrap, expanded, startup-cache, batch-cache, live, heuristic-fallback)',
    },
    'input-kind': {
      type: 'string',
      description: 'Route input kind (issue, task-packet, cache, heuristic)',
    },
    'max-cost': {
      type: 'string',
      description: 'Maximum cost budget in USD for routing',
    },
    'feature-dir': {
      type: 'string',
      description: 'Feature directory whose routing.jsonl records the route decision (default: inferred when --file lives under features/<slug>/)',
    },
    'exclude-model': {
      type: 'string',
      multiple: true,
      description: 'Model id to exclude from every stage (repeatable), e.g. a coder the launch gate refused',
    },
  },
  positional: {
    name: 'prompt',
    description: 'Task text to route',
    multiple: true,
  },
  examples: [
    '# Route a task from inline text',
    'npx tsx tools/route-task.ts "Create a route CLI command with JSON output"',
    '',
    '# Route a selected-task file',
    'npx tsx tools/route-task.ts --file features/my-feature/selected-task.json',
    '',
    '# Return JSON for scripting',
    'npx tsx tools/route-task.ts --json --file features/my-feature/selected-task.json',
    '',
    '# Record the route decision in a specific feature directory',
    'npx tsx tools/route-task.ts --json --file /tmp/packet.md --feature-dir features/my-feature',
    '',
    '# Re-route without a model the launch gate refused',
    'npx tsx tools/route-task.ts --json --file features/my-feature/task-packet.md --exclude-model gemini-2.5-pro',
  ],
  async run({ args, positional }) {
    let prompt = '';
    let file: string | undefined;
    if (args.file) {
      try {
        file = args.file;
        prompt = readTaskPromptFromFile(args.file);
      } catch (err) {
        throw new Error(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (positional.length > 0) {
      prompt = positional.join(' ');
    }

    if (!args.file && positional.length === 0) {
      throw new Error('Provide a task prompt as argument or via --file. Run with --help for usage information.');
    }

    const repoDir = args['repo-dir'] || process.cwd();
    const mode = args.mode || 'auto';
    let maxCostUsd: number | undefined;
    if (args['max-cost']) {
      maxCostUsd = Number(args['max-cost']);
      if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
        throw new Error(`--max-cost must be a non-negative number, got ${args['max-cost']}`);
      }
    }
    const featureDir = args['feature-dir'] || inferFeatureDirFromTaskFile(file);
    const excludeModels = (args['exclude-model'] ?? []).map((model) => model.trim()).filter(Boolean);
    const [result] = await routeBatch([
      { prompt, file, source: args.source, inputKind: args['input-kind'], ...(featureDir ? { featureDir } : {}) },
    ], {
      repoDir,
      mode: mode as 'auto' | 'stage-aware' | 'heuristic' | 'hokusai',
      maxCostUsd,
      additionalEvalsPaths: getWavemillAdditionalEvalPaths(repoDir),
      ...(excludeModels.length > 0 ? { excludeModels } : {}),
    });
    const decision = result?.decision;
    if (!decision) {
      throw new Error('Routing returned no decision');
    }

    // Surface budget violations
    if (decision.budgetViolation) {
      const v = decision.budgetViolation;
      console.error('\n⚠️  BUDGET VIOLATION DETECTED\n');
      console.error(`Operating Mode: ${v.operatingMode}`);
      console.error(`Budget Limit: $${v.maxCostUsd.toFixed(2)}`);
      console.error(`Estimated Cost: $${v.requestedCost.toFixed(2)}`);
      console.error(`Overage: $${(v.requestedCost - v.maxCostUsd).toFixed(2)}\n`);

      if (v.cheapestViableOption) {
        console.error(`Cheapest available option would cost: $${v.cheapestViableOption.totalCost.toFixed(2)}\n`);
      } else {
        console.error('No viable model combination found within any budget.\n');
      }

      console.error('Consider:');
      console.error('  - Increasing budget limits in .wavemill-config.json');
      console.error('  - Simplifying task scope');
      console.error('  - Waiting for quota recovery\n');
    }

    const jsonOutput = JSON.stringify(decision, null, 2);
    if (args.output) {
      const outputPath = resolve(args.output);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${jsonOutput}\n`, 'utf-8');
      return;
    }

    if (args.json) {
      console.log(jsonOutput);
      return;
    }

    console.log(summarizeWorkflowRoute(decision, repoDir));
  },
});
