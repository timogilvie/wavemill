/**
 * Tool-choice analyzer orchestrator (HOK-2080).
 *
 * Wraps the four staged modules — outcome-join, quality-gate, signal-stats,
 * decision-gate — behind a single function so the CLI stays thin and tests
 * can exercise the pipeline end-to-end on fixtures. All I/O is optional and
 * injectable: callers pass rows and eval records directly, or use the
 * convenience path that reads from the on-disk corpus and evals.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { EvalRecord } from '../eval-schema.ts';
import {
  buildOutcomeJoin,
  type OutcomeJoinOutput,
} from './tool-choice-outcome-join.ts';
import {
  computeQualityGate,
  formatQualityGateReport,
  type QualityGateReport,
} from './tool-choice-quality-gate.ts';
import {
  analyzeSignal,
  type AnalysisInput,
  type AnalysisResult,
  type BootstrapOpts,
} from './tool-choice-signal-stats.ts';
import {
  decideToolChoice,
  formatDecision,
  type Decision,
  type DecisionValue,
} from './tool-choice-decision-gate.ts';
import {
  parseToolDecisionJsonl,
  type ToolDecisionRow,
} from './tool-decision-schema.ts';

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface AnalyzeToolChoiceInput {
  rows: ToolDecisionRow[];
  evalRecords: EvalRecord[];
  targetTool?: string;
  bootstrap?: BootstrapOpts;
  operatorOverride?: { decision: DecisionValue; reason: string };
  thresholds?: Parameters<typeof computeQualityGate>[0]['thresholds'];
}

export interface AnalyzeToolChoiceOutput {
  join: OutcomeJoinOutput;
  quality: QualityGateReport;
  analysis: AnalysisResult;
  decision: Decision;
}

export function analyzeToolChoice(input: AnalyzeToolChoiceInput): AnalyzeToolChoiceOutput {
  const join = buildOutcomeJoin({ rows: input.rows, evalRecords: input.evalRecords });
  const quality = computeQualityGate({
    rows: join.rows,
    covariates: join.covariates,
    ...(input.thresholds ? { thresholds: input.thresholds } : {}),
  });
  const analysisInput: AnalysisInput = {
    rows: join.rows,
    covariates: join.covariates,
    ...(input.bootstrap ? { bootstrap: input.bootstrap } : {}),
    ...(input.targetTool ? { targetTool: input.targetTool } : {}),
  };
  const analysis = analyzeSignal(analysisInput);
  const decision = decideToolChoice({
    quality,
    analysis,
    ...(input.operatorOverride ? { operatorOverride: input.operatorOverride } : {}),
  });
  return { join, quality, analysis, decision };
}

// ---------------------------------------------------------------------------
// On-disk convenience loader
// ---------------------------------------------------------------------------

export interface LoadOptions {
  corpusPath?: string;
  evalsPath?: string;
  repoDir?: string;
}

export interface LoadedInputs {
  rows: ToolDecisionRow[];
  evalRecords: EvalRecord[];
  corpusPathUsed?: string;
  evalsPathUsed?: string;
}

function readEvalRecords(path: string): EvalRecord[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  const records: EvalRecord[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as EvalRecord;
      if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') {
        records.push(parsed);
      }
    } catch {
      // Skip malformed eval-record lines; they are not this task's concern.
    }
  }
  return records;
}

export function loadInputsForAnalysis(opts: LoadOptions): LoadedInputs {
  const cwd = opts.repoDir ?? resolve('.');
  const corpusPath = opts.corpusPath ?? resolve(cwd, '.wavemill/tool-decisions/corpus.jsonl');
  const evalsPath = opts.evalsPath ?? resolve(cwd, '.wavemill/evals/evals.jsonl');
  const rows = existsSync(corpusPath)
    ? parseToolDecisionJsonl(readFileSync(corpusPath, 'utf-8'))
    : [];
  const evalRecords = readEvalRecords(evalsPath);
  return {
    rows,
    evalRecords,
    corpusPathUsed: corpusPath,
    evalsPathUsed: evalsPath,
  };
}

// ---------------------------------------------------------------------------
// Report rendering (markdown)
// ---------------------------------------------------------------------------

export interface RenderReportOptions {
  title?: string;
  timestamp?: string;
  corpusPath?: string;
  evalsPath?: string;
  streamsDir?: string;
  streamCount?: number;
  evalCount?: number;
  cliCommand?: string;
}

export function renderMarkdownReport(
  result: AnalyzeToolChoiceOutput,
  options: RenderReportOptions = {},
): string {
  const lines: string[] = [];
  const title = options.title ?? 'Tool-choice signal analysis and decision gate (HOK-2080)';
  const ts = options.timestamp ?? new Date().toISOString();
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`_Generated: ${ts}_`);
  lines.push('');
  lines.push('## Method');
  lines.push('');
  lines.push('- **Estimand (Tier-0, local):** `P(result.status = success | chosenTool, controls)` per decision.');
  lines.push('- **Estimand (trace):** terminal success / merged conditional on trace-level tool-mix features and controls.');
  lines.push('- **Controls:** model, phase, prior-error state, menu digest (or "no_menu" when absent), issue difficulty band, challenge side.');
  lines.push('- **Uncertainty:** cluster bootstrap over traces; leave-one-model-out and leave-one-issue-out sensitivity.');
  lines.push('- **Off-policy:** self-normalized IPS and a DR wrapper — both refuse to run without `exact` propensity provenance.');
  lines.push('- **Tier-0 definition:** universal per-decision signals available at every stage without extra capture: result status, error flag, prior-error state, tool-menu digest identity, latency and cost when known.');
  lines.push('');
  lines.push('## Data-quality appendix');
  lines.push('');
  if (options.streamsDir) {
    lines.push(`- Session-events directory: \`${options.streamsDir}\` (${options.streamCount ?? '?'} streams)`);
  }
  if (options.corpusPath) {
    lines.push(`- Corpus: \`${options.corpusPath}\` (${result.quality.coverage.totalDecisions} rows)`);
  }
  if (options.evalsPath) {
    lines.push(`- Evals: \`${options.evalsPath}\` (${options.evalCount ?? '?'} records)`);
  }
  lines.push('');
  lines.push('```');
  lines.push(formatQualityGateReport(result.quality));
  lines.push('```');
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push(`- Traces joined to eval outcomes: **${result.analysis.covariateNotes.tracesJoined}**`);
  lines.push(`- Distinct models observed: **${result.analysis.covariateNotes.modelCount}**`);
  lines.push(`- Distinct tools observed: **${result.analysis.covariateNotes.toolCount}**`);
  lines.push('');
  lines.push('### Stratified contrasts');
  lines.push('');
  const kept = result.analysis.stratified.contrasts.filter((c) => !c.gated);
  if (kept.length === 0) {
    lines.push('_No non-gated cells at the configured floor. All stratified contrasts are reported as `insufficient_cell_size` — the estimator refuses to emit point estimates._');
  } else {
    lines.push('| Cell | Treatment | Control | Δ | 95% CI (Δ) | Significant |');
    lines.push('|---|---|---|---:|---:|---|');
    for (const c of kept) {
      lines.push(
        `| \`${c.label}\` | ${c.treatmentKey} (n=${c.treatment.n}) | ${c.controlKey} (n=${c.control.n}) | ${c.diff.toFixed(3)} | [${c.diffCi95[0].toFixed(3)}, ${c.diffCi95[1].toFixed(3)}] | ${c.significant ? 'yes' : 'no'} |`,
      );
    }
  }
  lines.push('');
  lines.push('### Sensitivity sweeps');
  lines.push('');
  if (result.analysis.sensitivity) {
    const sens = result.analysis.sensitivity;
    lines.push(`- Leave-one-model-out sweeps: ${sens.perModel.length}`);
    lines.push(`- Leave-one-issue-out sweeps: ${sens.perIssue.length}`);
    const anySigLostModel = sens.perModel.some((r) => r.sig === 0);
    const anySigLostIssue = sens.perIssue.some((r) => r.sig === 0);
    lines.push(
      `- Any LOO run eliminates all significant contrasts (model): ${anySigLostModel ? 'yes' : 'no'}`,
    );
    lines.push(
      `- Any LOO run eliminates all significant contrasts (issue): ${anySigLostIssue ? 'yes' : 'no'}`,
    );
  } else {
    lines.push('_No sensitivity sweep run (empty corpus)._');
  }
  lines.push('');
  lines.push('### Off-policy / propensity separation');
  lines.push('');
  const ips = result.analysis.offPolicy.ips;
  if ('refused' in ips && ips.refused) {
    lines.push(`- **IPS:** refused. Reason: \`${ips.reason}\`, basis: \`${ips.basis}\`. No causal off-policy estimate.`);
  } else if (!('refused' in ips && ips.refused)) {
    lines.push(
      `- **IPS** (basis=\`exact\`): estimate ${ips.estimate.toFixed(4)} ± ${ips.seEstimate.toFixed(4)} on ${ips.eligibleRows} rows.`,
    );
  }
  lines.push('- **DR:** not attempted separately; the module is available and gated identically. Only exact-provenance rows count.');
  lines.push('');
  lines.push('## Decision');
  lines.push('');
  lines.push('```');
  lines.push(formatDecision(result.decision));
  lines.push('```');
  lines.push('');
  if (options.cliCommand) {
    lines.push('## Re-run command');
    lines.push('');
    lines.push('```bash');
    lines.push(options.cliCommand);
    lines.push('```');
    lines.push('');
  }
  lines.push('## Notes');
  lines.push('');
  lines.push('- Rows are the P1 (HOK-2076) tool-decision corpus. This task never mutates capture code.');
  lines.push('- The `exact` and `provider_reported` results are reported separately from surrogate/unavailable and are never merged.');
  lines.push('- The estimator is deterministic with a seeded RNG; re-running with the same inputs reproduces the same numbers.');
  return lines.join('\n');
}
