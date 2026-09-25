#!/usr/bin/env -S npx tsx
/**
 * HOK-2081: Bounded counterfactual tool-selection exploration.
 *
 * Orchestrates the gated pipeline:
 *   1. Consult the HOK-2080 gate (`isCounterfactualExplorationEnabled`).
 *   2. Load the checkpoint (`session-checkpoint.ts`).
 *   3. Replay the baseline (`deterministic-replay.ts`) and report fidelity.
 *   4. Run counterfactual branches (`counterfactual-runner.ts`).
 *   5. Persist N+1 eval rows to `.wavemill/evals/evals.jsonl`.
 *   6. Emit a Markdown "causal estimate" report.
 *
 * `--dry-run` bypasses the gate and never touches `evals.jsonl`; it is the
 * path unit tests and manual smoke exercises use before the upstream Go
 * artifact is committed.
 *
 * @module tools/run-counterfactual-exploration
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { appendEvalRecord } from '../shared/lib/eval-persistence.ts';
import type { EvalRecord } from '../shared/lib/eval-schema.ts';
import {
  isCounterfactualExplorationEnabled,
} from '../shared/lib/native-agent/hok2081-gate.ts';
import {
  loadCheckpoint,
  verifyCheckpointIntegrity,
  type CheckpointHandle,
} from '../shared/lib/native-agent/session-checkpoint.ts';
import {
  replayFromCheckpoint,
} from '../shared/lib/native-agent/deterministic-replay.ts';
import {
  runCounterfactuals,
  type ExplorationPolicy,
} from '../shared/lib/native-agent/counterfactual-runner.ts';

interface RunSummary {
  gate: 'go' | 'refused' | 'bypassed';
  gateReason?: string;
  checkpointRoot?: string;
  fidelity?: number;
  fidelityReasons?: string[];
  baselineId?: string;
  counterfactualIds?: string[];
  reportPath?: string;
  budgetExhausted?: boolean;
}

function wilson(p: number, n: number): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const z = 1.96;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function renderReport(input: {
  handle: CheckpointHandle;
  baseline: EvalRecord;
  counterfactuals: EvalRecord[];
  policyTag: string;
  fidelity: number;
  fidelityReasons: string[];
  budgetExhausted: boolean;
}): string {
  const {
    handle,
    baseline,
    counterfactuals,
    policyTag,
    fidelity,
    fidelityReasons,
    budgetExhausted,
  } = input;

  const branches = counterfactuals.filter((row) => !row.metadata || !('branchFailureReason' in (row.metadata ?? {})));
  const baselineScores = [baseline.score];
  const branchScores = branches.map((row) => row.score);
  const baseMean = mean(baselineScores);
  const branchMean = mean(branchScores);
  const contrast = branchMean - baseMean;
  const wilsonMean = wilson(branchMean, branchScores.length);
  const insufficient = branches.length <= 3;

  const lines: string[] = [];
  lines.push(`# Replay-Counterfactual Exploration Report`);
  lines.push('');
  lines.push(`- **Session:** ${handle.manifest.sessionId}`);
  lines.push(`- **Decision:** ${handle.manifest.decisionId}`);
  lines.push(`- **Model (held fixed):** ${handle.manifest.modelId}`);
  lines.push(`- **Chosen tool (live):** ${handle.manifest.chosenTool}`);
  lines.push(`- **Menu:** ${handle.manifest.toolMenu.join(', ')}`);
  lines.push(`- **Policy:** ${policyTag}`);
  lines.push(`- **Budget exhausted:** ${budgetExhausted ? 'yes' : 'no'}`);
  lines.push(`- **Fidelity:** ${fidelity.toFixed(3)}${fidelityReasons.length ? ` (reasons: ${fidelityReasons.join(', ')})` : ''}`);
  lines.push('');
  lines.push(`## Baseline`);
  lines.push(`- id: \`${baseline.id}\``);
  lines.push(`- score: ${baseline.score.toFixed(3)} (${baseline.scoreBand})`);
  lines.push(`- rationale: ${baseline.rationale}`);
  lines.push('');
  lines.push(`## Counterfactual branches (${counterfactuals.length})`);
  lines.push('');
  lines.push(`| id | policy_source | score | scoreBand | rationale |`);
  lines.push(`|----|---------------|-------|-----------|-----------|`);
  for (const row of counterfactuals) {
    lines.push(
      `| \`${row.id}\` | ${row.policy_source ?? ''} | ${row.score.toFixed(3)} | ${row.scoreBand} | ${row.rationale.replace(/\|/g, '\\|')} |`,
    );
  }
  lines.push('');
  lines.push(`## Causal estimate (observational, single-checkpoint, not for routing)`);
  lines.push('');
  if (insufficient) {
    lines.push(`> insufficient replicates for causal claim (branches=${branches.length}, ≤ 3)`);
  } else {
    lines.push(`- baseline mean score: ${baseMean.toFixed(3)}`);
    lines.push(`- counterfactual mean score: ${branchMean.toFixed(3)}`);
    lines.push(`- Δ (counterfactual − baseline): ${contrast.toFixed(3)}`);
    lines.push(`- 95% Wilson interval on counterfactual mean: [${wilsonMean.low.toFixed(3)}, ${wilsonMean.high.toFixed(3)}]`);
  }
  lines.push('');
  lines.push(`> This estimate is observational, single-checkpoint, and NOT for routing.`);
  return lines.join('\n') + '\n';
}

runTool({
  name: 'run-counterfactual-exploration',
  description:
    'HOK-2081: gated deterministic replay and bounded counterfactual tool-selection exploration.',
  options: {
    'checkpoint-root': {
      type: 'string',
      description: 'Path to an existing checkpoint directory (required).',
    },
    'verify-only': {
      type: 'boolean',
      description: 'Load and verify the checkpoint hash, then exit.',
    },
    'replay-only': {
      type: 'boolean',
      description: 'Replay the baseline and report fidelity, then exit.',
    },
    policy: {
      type: 'string',
      description: 'Policy: deterministic-baseline | enumerate-all | epsilon-greedy',
      default: 'deterministic-baseline',
    },
    epsilon: {
      type: 'string',
      description: 'Epsilon for epsilon-greedy policy (0..1).',
      default: '0.1',
    },
    'branches-max': {
      type: 'string',
      description: 'Hard cap on counterfactual branches.',
      default: '3',
    },
    'steps-per-branch-max': {
      type: 'string',
      description: 'Simulated steps per branch.',
      default: '32',
    },
    'wall-seconds-max': {
      type: 'string',
      description: 'Wall-clock budget in seconds.',
      default: '60',
    },
    'report-out': {
      type: 'string',
      description: 'Where to write the Markdown report.',
      default: 'docs/replay-counterfactual-exploration.md',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Bypass the HOK-2080 gate and skip eval persistence.',
    },
    'repo-dir': {
      type: 'string',
      description: 'Override repo dir for gate + eval persistence (tests).',
    },
    'summary-json': {
      type: 'string',
      description: 'Optional path to write a machine-readable run summary.',
    },
  },
  examples: [
    'npx tsx tools/run-counterfactual-exploration.ts --checkpoint-root .wavemill/replay-checkpoints/session--decision --verify-only',
    'npx tsx tools/run-counterfactual-exploration.ts --checkpoint-root <path> --dry-run --policy enumerate-all',
  ],
  async run({ args }) {
    const checkpointRoot = args['checkpoint-root'];
    if (!checkpointRoot) {
      console.error('error: --checkpoint-root is required');
      process.exit(2);
    }

    const repoDir = args['repo-dir'] ? resolve(args['repo-dir']) : process.cwd();
    const summary: RunSummary = { gate: 'refused' };

    if (args['verify-only']) {
      const ok = verifyCheckpointIntegrity(checkpointRoot);
      console.log(ok ? `verify: ok (${checkpointRoot})` : `verify: FAIL (${checkpointRoot})`);
      summary.gate = 'bypassed';
      summary.checkpointRoot = checkpointRoot;
      await maybeWriteSummary(args['summary-json'], summary);
      process.exit(ok ? 0 : 1);
    }

    const dryRun = !!args['dry-run'];
    if (!dryRun) {
      const gate = isCounterfactualExplorationEnabled(repoDir);
      if (!gate.enabled) {
        summary.gate = 'refused';
        summary.gateReason = gate.reason;
        console.error(JSON.stringify({ error: 'gate_refused', reason: gate.reason, message: gate.message }));
        await maybeWriteSummary(args['summary-json'], summary);
        process.exit(3);
      }
      summary.gate = 'go';
    } else {
      summary.gate = 'bypassed';
    }

    const handle = loadCheckpoint(checkpointRoot);
    summary.checkpointRoot = handle.root;

    const replay = replayFromCheckpoint(checkpointRoot);
    summary.fidelity = replay.fidelity;
    summary.fidelityReasons = replay.reasons;
    console.log(`Replay fidelity: ${replay.fidelity.toFixed(3)}`);
    if (replay.reasons.length > 0) {
      console.log(`Fidelity reasons: ${replay.reasons.join(', ')}`);
    }

    if (args['replay-only']) {
      await maybeWriteSummary(args['summary-json'], summary);
      process.exit(0);
    }

    const policy = buildPolicy(String(args.policy ?? 'deterministic-baseline'), String(args.epsilon ?? '0.1'));
    const budget = {
      branchesMax: parseIntArg(args['branches-max'], 3),
      stepsPerBranchMax: parseIntArg(args['steps-per-branch-max'], 32),
      wallSecondsMax: parseIntArg(args['wall-seconds-max'], 60),
    };

    const result = await runCounterfactuals({
      checkpointRoot,
      modelId: handle.manifest.modelId,
      policy,
      budget,
    });

    summary.baselineId = result.baseline.id;
    summary.counterfactualIds = result.counterfactuals.map((row) => row.id);
    summary.budgetExhausted = result.budgetExhausted;

    if (!dryRun) {
      appendEvalRecord(result.baseline, { repoDir });
      for (const row of result.counterfactuals) {
        appendEvalRecord(row, { repoDir });
      }
    }

    const reportOut = args['report-out'] ?? 'docs/replay-counterfactual-exploration.md';
    const reportAbs = isAbsolute(reportOut) ? reportOut : resolve(repoDir, reportOut);
    const report = renderReport({
      handle,
      baseline: result.baseline,
      counterfactuals: result.counterfactuals,
      policyTag: result.policyTag,
      fidelity: replay.fidelity,
      fidelityReasons: replay.reasons,
      budgetExhausted: result.budgetExhausted,
    });
    await mkdir(dirname(reportAbs), { recursive: true });
    await writeFile(reportAbs, report);
    summary.reportPath = reportAbs;
    console.log(`Report written: ${reportAbs}`);

    await maybeWriteSummary(args['summary-json'], summary);
  },
});

function buildPolicy(kind: string, epsilonRaw: string): ExplorationPolicy {
  if (kind === 'enumerate-all') return { kind: 'enumerate-all' };
  if (kind === 'epsilon-greedy') {
    const epsilon = Number(epsilonRaw);
    if (!Number.isFinite(epsilon) || epsilon < 0 || epsilon > 1) {
      throw new Error(`Invalid epsilon: ${epsilonRaw}`);
    }
    return { kind: 'epsilon-greedy', epsilon };
  }
  return { kind: 'deterministic-baseline' };
}

function parseIntArg(value: string | undefined, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function maybeWriteSummary(pathArg: string | undefined, summary: RunSummary): Promise<void> {
  if (!pathArg) return;
  const abs = isAbsolute(pathArg) ? pathArg : resolve(pathArg);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify(summary, null, 2));
}

