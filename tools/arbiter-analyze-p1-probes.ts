#!/usr/bin/env -S npx tsx

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  currentGitRevision,
  loadPhase1ProbeSummaries,
  renderPhase1AnalysisMarkdown,
  type GateMode,
} from '../shared/lib/arbiter-probes/phase-1-analysis.ts';

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required option --${name}`);
  }
  return value;
}

function parseGateMode(value: unknown): GateMode {
  const mode = typeof value === 'string' ? value : 'auto';
  if (mode === 'auto' || mode === 'decision-layer' || mode === 'de-noising-feature') {
    return mode;
  }
  throw new Error(`Invalid --gate-call "${mode}". Use auto, decision-layer, or de-noising-feature.`);
}

function parseHorizon(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error('--horizon must be a number');
  }
  const horizon = Number.parseInt(value, 10);
  if (!Number.isFinite(horizon) || ![14, 30, 60].includes(horizon)) {
    throw new Error(`Invalid --horizon "${value}". Use 14, 30, or 60.`);
  }
  return horizon;
}

function writeOutput(path: string | undefined, content: string): void {
  if (!path) {
    console.log(content);
    return;
  }
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, content, 'utf-8');
  console.log(`Wrote ${resolved}`);
}

runTool({
  name: 'arbiter-analyze-p1-probes',
  description: 'Combine frozen Arbiter Phase 1 probe summaries into a gate-ready analysis snapshot.',
  options: {
    'swap-summary': { type: 'string', description: 'Path to P1.1 swap-test summary.json' },
    'survival-summary': { type: 'string', description: 'Path to P1.2 survival agreement JSON' },
    'eval-disagreement-summary': { type: 'string', description: 'Path to P1.2 judge/eval disagreement JSON' },
    'out-json': { type: 'string', description: 'Write combined machine-readable analysis JSON here' },
    'out-md': { type: 'string', description: 'Write publishable Markdown report here' },
    'run-id': { type: 'string', description: 'Override analysis run identifier' },
    'generated-at': { type: 'string', description: 'Override generated timestamp for deterministic fixtures' },
    'git-revision': { type: 'string', description: 'Override git revision for deterministic fixtures' },
    'repo-dir': { type: 'string', description: 'Repository directory for git revision lookup (default: cwd)' },
    horizon: { type: 'string', description: 'Survival horizon in days: 14, 30, or 60' },
    'gate-call': {
      type: 'string',
      description: 'Gate mode: auto, decision-layer, or de-noising-feature (default: auto)',
    },
  },
  examples: [
    'npx tsx tools/arbiter-analyze-p1-probes.ts --swap-summary .wavemill/evals/swap-test/runs/swap-2026-09-09/summary.json --survival-summary .wavemill/evals/arbiter-probes/p1-2-survival-probe.json --eval-disagreement-summary .wavemill/evals/arbiter-probes/p1-2-eval-disagreement.json --out-md docs/arbiter/p1-3-phase-1-gate-write-up.md --out-json .wavemill/evals/arbiter-probes/p1-3-phase-1-analysis.json',
  ],
  additionalHelp: `The tool accepts already frozen probe outputs. It does not run the
judge, backfill survival labels, or impute missing labels. If any required
artifact is absent or malformed, the command fails before writing outputs.`,
  run({ args }) {
    const repoDir = resolve((args['repo-dir'] as string | undefined) ?? process.cwd());
    const snapshot = loadPhase1ProbeSummaries({
      swapSummaryPath: resolve(requiredString(args['swap-summary'], 'swap-summary')),
      survivalSummaryPath: resolve(requiredString(args['survival-summary'], 'survival-summary')),
      evalDisagreementSummaryPath: resolve(
        requiredString(args['eval-disagreement-summary'], 'eval-disagreement-summary'),
      ),
      runId: args['run-id'] as string | undefined,
      generatedAt: args['generated-at'] as string | undefined,
      gitRevision: (args['git-revision'] as string | undefined) ?? currentGitRevision(repoDir),
      horizonDays: parseHorizon(args.horizon),
      gateMode: parseGateMode(args['gate-call']),
    });

    if (args['out-json']) {
      writeOutput(args['out-json'] as string, `${JSON.stringify(snapshot, null, 2)}\n`);
    }

    const markdown = renderPhase1AnalysisMarkdown(snapshot);
    if (args['out-md']) {
      writeOutput(args['out-md'] as string, markdown);
    }

    if (!args['out-json'] && !args['out-md']) {
      console.log(JSON.stringify(snapshot, null, 2));
    }
  },
});
