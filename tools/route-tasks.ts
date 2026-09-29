#!/usr/bin/env -S npx tsx

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { stdin as input } from 'node:process';
import {
  routeBatch,
  getWavemillAdditionalEvalPaths,
  routeExpandedPackets,
  tasksFromPlan,
  type ExpandedRouteTask,
} from '../shared/lib/route-batch.ts';
import type { RouteInputKind, RouteSource } from '../shared/lib/route-artifact.ts';
import { routerLogVerboseEnabled } from '../shared/lib/router-log.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

interface RouteBatchTaskInput {
  issueId?: string;
  prompt?: string;
  file?: string;
  source?: RouteSource;
  inputKind?: RouteInputKind;
  featureDir?: string;
}

interface ExpandedRouteTaskInput {
  issueId?: string;
  slug?: string;
  featureDir?: string;
  packetFile?: string;
  headerFile?: string;
  detailsFile?: string;
  outputFile?: string;
}

function formatRouteSignature(decision: { coder?: string; codeDepth?: string; reviewer?: string; reviewMode?: string; reviewRecommended?: string }): string {
  return `coder=${decision.coder || ''},codeDepth=${decision.codeDepth || ''},reviewer=${decision.reviewer || ''},reviewMode=${decision.reviewMode || decision.reviewRecommended || ''}`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function readJsonlTasks(path: string): Promise<RouteBatchTaskInput[]> {
  const content = path === '-'
    ? await readStdin()
    : readFileSync(path, 'utf-8');

  const tasks: RouteBatchTaskInput[] = [];
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Invalid JSONL at line ${index + 1}: expected object`);
    }

    const item = parsed as { issueId?: unknown; prompt?: unknown; file?: unknown; source?: unknown; inputKind?: unknown; featureDir?: unknown };
    tasks.push({
      issueId: typeof item.issueId === 'string' ? item.issueId : undefined,
      prompt: typeof item.prompt === 'string' ? item.prompt : undefined,
      file: typeof item.file === 'string' ? item.file : undefined,
      source: typeof item.source === 'string' ? item.source as RouteSource : undefined,
      inputKind: typeof item.inputKind === 'string' ? item.inputKind as RouteInputKind : undefined,
      featureDir: typeof item.featureDir === 'string' && item.featureDir ? item.featureDir : undefined,
    });
  }

  return tasks;
}

async function readExpandedJsonlTasks(path: string): Promise<ExpandedRouteTask[]> {
  const content = path === '-'
    ? await readStdin()
    : readFileSync(path, 'utf-8');

  const tasks: ExpandedRouteTask[] = [];
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid expanded JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Invalid expanded JSONL at line ${index + 1}: expected object`);
    }

    const item = parsed as ExpandedRouteTaskInput;
    if (typeof item.issueId !== 'string' || item.issueId.trim() === '') {
      throw new Error(`Invalid expanded JSONL at line ${index + 1}: issueId is required`);
    }

    const packetFile = typeof item.packetFile === 'string' ? item.packetFile : undefined;
    const headerFile = typeof item.headerFile === 'string' ? item.headerFile : undefined;
    const detailsFile = typeof item.detailsFile === 'string' ? item.detailsFile : undefined;

    if (!packetFile && !(headerFile && detailsFile)) {
      throw new Error(
        `Invalid expanded JSONL at line ${index + 1}: provide packetFile or both headerFile and detailsFile`,
      );
    }

    tasks.push({
      issueId: item.issueId,
      slug: typeof item.slug === 'string' ? item.slug : undefined,
      featureDir: typeof item.featureDir === 'string' ? item.featureDir : undefined,
      packetFile,
      headerFile,
      detailsFile,
      outputFile: typeof item.outputFile === 'string' ? item.outputFile : undefined,
    });
  }

  return tasks;
}

runTool({
  name: 'route-tasks',
  description: 'Batch route multiple task prompts or packet files as JSONL',
  options: {
    jsonl: {
      type: 'string',
      description: 'Route one JSON object per line from a file or stdin (-)',
    },
    'expanded-jsonl': {
      type: 'string',
      description: 'Expanded packet reroute JSONL input from a file or stdin (-)',
    },
    plan: {
      type: 'string',
      description: 'Route tasks from a launch-plan style JSON file',
    },
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (default: current directory)',
    },
    mode: {
      type: 'string',
      description: 'Routing mode: auto, stage-aware, heuristic, or hokusai',
    },
    'max-cost': {
      type: 'string',
      description: 'Maximum cost budget in USD for routing',
    },
  },
  examples: [
    '# Route a JSONL file of task packets',
    'npx tsx tools/route-tasks.ts --jsonl /tmp/route-input.jsonl',
    '',
    '# Route launch-plan tasks',
    'npx tsx tools/route-tasks.ts --plan /tmp/session-launch-plan.json',
    '',
    '# Reroute expanded packets and write .post-expansion-route.json artifacts',
    'npx tsx tools/route-tasks.ts --expanded-jsonl /tmp/expanded-route-input.jsonl',
    '',
    '# Route JSONL from stdin',
    'cat /tmp/route-input.jsonl | npx tsx tools/route-tasks.ts --jsonl -',
  ],
  async run({ args }) {
    if ((args.jsonl ? 1 : 0) + (args.plan ? 1 : 0) + (args['expanded-jsonl'] ? 1 : 0) !== 1) {
      throw new Error('Provide exactly one of --jsonl, --expanded-jsonl, or --plan.');
    }

    const repoDir = args['repo-dir'] || process.cwd();
    const mode = (args.mode || 'auto') as 'auto' | 'stage-aware' | 'heuristic' | 'hokusai';
    let maxCostUsd: number | undefined;
    if (args['max-cost']) {
      maxCostUsd = Number(args['max-cost']);
      if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
        throw new Error(`--max-cost must be a non-negative number, got ${args['max-cost']}`);
      }
    }

    if (args['expanded-jsonl']) {
      const tasks = await readExpandedJsonlTasks(args['expanded-jsonl']);
      if (tasks.length === 0) {
        return;
      }

      const results = await routeExpandedPackets(tasks, {
        repoDir,
        mode,
        maxCostUsd,
        additionalEvalsPaths: getWavemillAdditionalEvalPaths(repoDir),
      });

      let hadErrors = false;
      for (const result of results) {
        if (result.error || !result.decision) {
          hadErrors = true;
          console.error(`[router] expanded reroute failed issue=${result.input.issueId} error=${result.error || 'missing decision'}`);
          console.error(`[router] route.lifecycle: event=expansion_failed issue=${result.input.issueId} reason=routing_error`);
          continue;
        }

        mkdirSync(dirname(resolve(result.outputFile)), { recursive: true });
        writeFileSync(result.outputFile, `${JSON.stringify(result.decision, null, 2)}\n`, 'utf-8');
        if (routerLogVerboseEnabled()) {
          const routeSignature = formatRouteSignature(result.decision);
          if (result.cache_hit) {
            console.error(
              `[router] route.lifecycle: event=expansion_cache_hit issue=${result.input.issueId} route="${routeSignature}" packet_hash=${(result.packet_hash || '').slice(0, 12)}`,
            );
          } else {
            console.error(
              `[router] route.lifecycle: event=expanded_assigned issue=${result.input.issueId} route="${routeSignature}" source=${result.route_source || 'single'} packet_hash=${(result.packet_hash || '').slice(0, 12)}`,
            );
          }
          console.error(
            `[router] route_source=${result.route_source} packet_hash=${(result.packet_hash || '').slice(0, 12)} issue=${result.input.issueId}`,
          );
        }
        console.log(JSON.stringify({
          issueId: result.input.issueId,
          outputFile: result.outputFile,
          cache_hit: result.cache_hit,
          route_source: result.route_source,
          packet_hash: result.packet_hash,
          ...result.decision,
        }));
      }

      if (hadErrors) {
        process.exitCode = 1;
      }
      return;
    }

    const tasks = args.jsonl
      ? await readJsonlTasks(args.jsonl)
      : tasksFromPlan(JSON.parse(readFileSync(args.plan!, 'utf-8')));

    if (tasks.length === 0) {
      return;
    }

    const results = await routeBatch(tasks, {
      repoDir,
      mode,
      maxCostUsd,
      additionalEvalsPaths: getWavemillAdditionalEvalPaths(repoDir),
    });

    if (results.length !== tasks.length) {
      throw new Error(`Batch routing returned ${results.length} results for ${tasks.length} tasks`);
    }

    for (const { task, decision } of results) {
      if (!decision.planner || !decision.coder || !decision.reviewer) {
        throw new Error(`Batch routing returned an incomplete decision${task.issueId ? ` for ${task.issueId}` : ''}`);
      }

      const output = task.issueId
        ? { issueId: task.issueId, ...decision }
        : decision;
      console.log(JSON.stringify(output));
    }
  },
});
