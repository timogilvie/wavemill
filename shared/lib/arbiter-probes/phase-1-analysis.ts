import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createCell } from './strata-cells.ts';
import type { FlipCell, SwapTestSummary } from '../swap-test/report.ts';
import type { ProportionInterval } from '../stats-utils.ts';

export type GateCall = 'decision_layer' | 'denoising_feature' | 'insufficient_data';
export type GateMode = 'auto' | 'decision-layer' | 'de-noising-feature';

export interface Phase1SourceFile {
  kind: 'swap-summary' | 'survival-summary' | 'eval-disagreement-summary';
  path: string;
  sha256: string;
}

export interface Phase1RateCell {
  n: number;
  events: number;
  rate: number | null;
  ci95: ProportionInterval;
  eventLabel: string;
  excludedFromStratifiedAnalysis?: boolean;
}

export interface Phase1ProbeMetric {
  title: string;
  denominator: string;
  eventLabel: string;
  overall: Phase1RateCell;
  byChallengeType: Record<string, Phase1RateCell>;
  byDifficultyBucket: Record<string, Phase1RateCell>;
  byDifficultyCollapsed: Record<string, Phase1RateCell>;
  notes: string[];
}

export interface Phase1GateDecision {
  call: GateCall;
  title: string;
  summary: string;
  reasons: string[];
  affectedIssues: string[];
}

export interface Phase1AnalysisSnapshot {
  schemaVersion: 'arbiter.phase1.analysis.v1';
  generatedAt: string;
  runId: string;
  gitRevision: string;
  horizonDays: number | null;
  provenance: {
    sources: Phase1SourceFile[];
    swapRunId: string;
    judgeModel: string;
    judgeTemplateHash: string;
    swapStartedAt?: string;
    swapFinishedAt?: string;
  };
  population: {
    swapPairs: number;
    swapUsablePairs: number;
    survivalPopulation: number;
    survivalAnalyzed: number;
    evalPopulation: number;
    evalAnalyzed: number;
    evalTies: number;
  };
  metrics: {
    flipRate: Phase1ProbeMetric;
    survivalAgreement: Phase1ProbeMetric;
    judgeEvalDisagreement: Phase1ProbeMetric;
  };
  gate: Phase1GateDecision;
  decisionLogEntry: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function numberField(value: JsonRecord, key: string, path: string): number {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isFinite(field)) {
    throw new Error(`${path}.${key} must be a finite number`);
  }
  return field;
}

function stringField(value: JsonRecord, key: string, path: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.trim().length === 0) {
    throw new Error(`${path}.${key} must be a non-empty string`);
  }
  return field;
}

function optionalStringField(value: JsonRecord, key: string, path: string): string | undefined {
  const field = value[key];
  if (field === undefined || field === null) return undefined;
  if (typeof field !== 'string') {
    throw new Error(`${path}.${key} must be a string when present`);
  }
  return field;
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) {
    throw new Error(`Required Phase 1 artifact is missing: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed JSON in ${path}: ${message}`);
  }
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function currentGitRevision(repoDir = process.cwd()): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function rateCell(events: number, n: number, eventLabel: string, excluded?: boolean): Phase1RateCell {
  const cell = createCell(events, n);
  return {
    n: cell.n,
    events: cell.successes,
    rate: cell.rate,
    ci95: cell.ci95,
    eventLabel,
    ...(excluded ? { excludedFromStratifiedAnalysis: true } : {}),
  };
}

function flipRateCell(value: unknown, path: string): Phase1RateCell {
  const cell = record(value, path);
  return rateCell(
    numberField(cell, 'flips', path),
    numberField(cell, 'n', path),
    'flips',
    cell.excludedFromStratifiedAnalysis === true,
  );
}

function successRateCell(value: unknown, path: string, eventLabel: string): Phase1RateCell {
  const cell = record(value, path);
  return rateCell(
    numberField(cell, 'successes', path),
    numberField(cell, 'n', path),
    eventLabel,
    cell.excludedFromStratifiedAnalysis === true,
  );
}

function disagreementFromAgreementCell(value: unknown, path: string): Phase1RateCell {
  const cell = record(value, path);
  const n = numberField(cell, 'n', path);
  const agreements = numberField(cell, 'successes', path);
  return rateCell(
    n - agreements,
    n,
    'disagreements',
    cell.excludedFromStratifiedAnalysis === true,
  );
}

function rateCells(
  value: unknown,
  path: string,
  mapper: (value: unknown, path: string) => Phase1RateCell,
): Record<string, Phase1RateCell> {
  const entries = record(value, path);
  return Object.fromEntries(
    Object.entries(entries)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, mapper(item, `${path}.${key}`)]),
  );
}

function survivalOverall(value: unknown): Phase1RateCell {
  const overall = record(record(value, 'survival').overall, 'survival.overall');
  return successRateCell(overall.cell, 'survival.overall.cell', 'kept side survived');
}

function evalOverall(value: unknown): Phase1RateCell {
  const overall = record(record(value, 'eval').overall, 'eval.overall');
  return successRateCell(overall.disagreementCell, 'eval.overall.disagreementCell', 'disagreements');
}

function swapMetric(summary: SwapTestSummary): Phase1ProbeMetric {
  return {
    title: 'Flip rate',
    denominator: 'usable pairs with successful judge calls in both presentation orders',
    eventLabel: 'flips',
    overall: flipRateCell(summary.overall, 'swap.overall'),
    byChallengeType: rateCells(summary.byChallengeType, 'swap.byChallengeType', flipRateCell),
    byDifficultyBucket: rateCells(summary.byDifficultyBucket, 'swap.byDifficultyBucket', flipRateCell),
    byDifficultyCollapsed: rateCells(summary.byDifficultyCollapsed, 'swap.byDifficultyCollapsed', flipRateCell),
    notes: [
      `Run ${summary.runId} judged ${summary.totals.usablePairs}/${summary.totals.pairs} selected pairs successfully.`,
      `Judge errors or missing order results: ${summary.totals.judgeErrors}; hydration failures: ${summary.totals.hydrationFailed}.`,
      'A flip means the two-order blinded replay picked different winners for the same pair.',
    ],
  };
}

function survivalMetric(summary: JsonRecord, horizonDays: number | null): Phase1ProbeMetric {
  const excluded = record(summary.excluded, 'survival.excluded');
  const totalExcluded = numberField(excluded, 'noLabel', 'survival.excluded')
    + numberField(excluded, 'missingHorizon', 'survival.excluded')
    + numberField(excluded, 'keptPrUnmerged', 'survival.excluded');

  return {
    title: 'Survival agreement',
    denominator: `${horizonDays ?? 'configured'}-day kept-side survival labels with terminal outcomes`,
    eventLabel: 'kept side survived',
    overall: survivalOverall(summary),
    byChallengeType: rateCells(summary.byChallengeType, 'survival.byChallengeType', (value, path) =>
      successRateCell(value, path, 'kept side survived')),
    byDifficultyBucket: rateCells(summary.byDifficultyBucket, 'survival.byDifficultyBucket', (value, path) =>
      successRateCell(value, path, 'kept side survived')),
    byDifficultyCollapsed: rateCells(summary.byDifficultyCollapsed, 'survival.byDifficultyCollapsed', (value, path) =>
      successRateCell(value, path, 'kept side survived')),
    notes: [
      `${numberField(summary, 'analyzed', 'survival')} analyzed from ${numberField(summary, 'population', 'survival')} selected pairs; ${totalExcluded} excluded.`,
      `Exclusions: no label ${numberField(excluded, 'noLabel', 'survival.excluded')}, missing horizon ${numberField(excluded, 'missingHorizon', 'survival.excluded')}, kept PR unmerged ${numberField(excluded, 'keptPrUnmerged', 'survival.excluded')}.`,
      'No-label, missing-horizon, and unmerged kept-side rows are not counted as agreement.',
    ],
  };
}

function evalMetric(summary: JsonRecord): Phase1ProbeMetric {
  const excluded = record(summary.excluded, 'eval.excluded');
  const fallback = record(summary.fallback, 'eval.fallback');
  return {
    title: 'Judge/eval disagreement',
    denominator: 'pairs with eval-implied winners on both sides; exact eval ties excluded',
    eventLabel: 'disagreements',
    overall: evalOverall(summary),
    byChallengeType: rateCells(summary.byChallengeType, 'eval.byChallengeType', disagreementFromAgreementCell),
    byDifficultyBucket: rateCells(summary.byDifficultyBucket, 'eval.byDifficultyBucket', disagreementFromAgreementCell),
    byDifficultyCollapsed: rateCells(summary.byDifficultyCollapsed, 'eval.byDifficultyCollapsed', disagreementFromAgreementCell),
    notes: [
      `${numberField(summary, 'analyzed', 'eval')} analyzed from ${numberField(summary, 'population', 'eval')} selected pairs; eval ties excluded from the denominator: ${numberField(summary, 'ties', 'eval')}.`,
      `Missing eval exclusions: primary ${numberField(excluded, 'missingEvalPrimary', 'eval.excluded')}, challenger ${numberField(excluded, 'missingEvalChallenger', 'eval.excluded')}.`,
      `Score fallback rows remain analyzed and annotated: ${numberField(fallback, 'scoreFallback', 'eval.fallback')}; fallback disagreements: ${numberField(fallback, 'disagreements', 'eval.fallback')}.`,
    ],
  };
}

function nonEmptyCells(metric: Phase1ProbeMetric): Phase1RateCell[] {
  return [
    metric.overall,
    ...Object.values(metric.byChallengeType),
    ...Object.values(metric.byDifficultyBucket),
    ...Object.values(metric.byDifficultyCollapsed),
  ].filter((cell) => cell.n > 0);
}

function hasAllRequiredDenominators(metrics: Phase1AnalysisSnapshot['metrics']): boolean {
  return (
    metrics.flipRate.overall.n > 0
    && metrics.survivalAgreement.overall.n > 0
    && metrics.judgeEvalDisagreement.overall.n > 0
  );
}

function isFlatOver90(metrics: Phase1AnalysisSnapshot['metrics']): boolean {
  const flipStable = nonEmptyCells(metrics.flipRate).every((cell) => cell.rate !== null && 1 - cell.rate > 0.9);
  const survivalStable = nonEmptyCells(metrics.survivalAgreement).every((cell) => cell.rate !== null && cell.rate > 0.9);
  const evalStable = nonEmptyCells(metrics.judgeEvalDisagreement).every((cell) => cell.rate !== null && 1 - cell.rate > 0.9);
  return flipStable && survivalStable && evalStable;
}

function hardStrata(metric: Phase1ProbeMetric): Array<[string, Phase1RateCell]> {
  return Object.entries(metric.byDifficultyCollapsed)
    .filter(([name]) => name === '4 hard' || name === '5 very_hard');
}

function formatPercent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatCi(cell: Phase1RateCell): string {
  if (cell.ci95.lo === null || cell.ci95.hi === null) return 'n/a';
  return `${formatPercent(cell.ci95.lo)} - ${formatPercent(cell.ci95.hi)}`;
}

function decideGate(metrics: Phase1AnalysisSnapshot['metrics'], mode: GateMode): Phase1GateDecision {
  if (!hasAllRequiredDenominators(metrics)) {
    return {
      call: 'insufficient_data',
      title: 'Insufficient frozen evidence',
      summary: 'The gate is not called because at least one required Phase 1 probe has n=0 in the supplied frozen artifacts.',
      reasons: [
        `Flip-rate n=${metrics.flipRate.overall.n}.`,
        `Survival-agreement n=${metrics.survivalAgreement.overall.n}.`,
        `Judge/eval-disagreement n=${metrics.judgeEvalDisagreement.overall.n}.`,
      ],
      affectedIssues: ['HOK-2802'],
    };
  }

  const flat = isFlatOver90(metrics);
  if (mode === 'de-noising-feature' && !flat) {
    throw new Error('Refusing to call the de-noising branch: at least one non-empty flip/survival/eval cell is not >90% stable/agreement.');
  }

  const selected: GateCall = mode === 'de-noising-feature'
    ? 'denoising_feature'
    : mode === 'decision-layer'
      ? 'decision_layer'
      : flat
        ? 'denoising_feature'
        : 'decision_layer';

  if (selected === 'denoising_feature') {
    return {
      call: selected,
      title: 'arbitrate() is a de-noising feature',
      summary: 'The judge is order-stable and above 90% agreement in every non-empty supplied stratum; the pairwise Showdown story is not supported by this snapshot.',
      reasons: [
        `Overall order stability: ${formatPercent(1 - (metrics.flipRate.overall.rate ?? 0))}.`,
        `Overall kept-side survival agreement: ${formatPercent(metrics.survivalAgreement.overall.rate)}.`,
        `Overall eval agreement: ${formatPercent(1 - (metrics.judgeEvalDisagreement.overall.rate ?? 0))}.`,
      ],
      affectedIssues: ['HOK-2802', 'HOK-2810-HOK-2815', 'HOK-2823-HOK-2835'],
    };
  }

  const hard = hardStrata(metrics.judgeEvalDisagreement)
    .map(([name, cell]) => `${name}: ${cell.events}/${cell.n} (${formatPercent(cell.rate)})`);
  return {
    call: selected,
    title: 'arbitrate() remains a decision layer',
    summary: 'The supplied frozen artifacts do not show a uniformly flat >90% judge; the decision-layer path remains live and Phases 2-4 proceed under the existing validity gates.',
    reasons: [
      `Overall flip rate: ${metrics.flipRate.overall.events}/${metrics.flipRate.overall.n} (${formatPercent(metrics.flipRate.overall.rate)}, 95% CI ${formatCi(metrics.flipRate.overall)}).`,
      `Overall survival agreement: ${metrics.survivalAgreement.overall.events}/${metrics.survivalAgreement.overall.n} (${formatPercent(metrics.survivalAgreement.overall.rate)}, 95% CI ${formatCi(metrics.survivalAgreement.overall)}).`,
      `Overall judge/eval disagreement: ${metrics.judgeEvalDisagreement.overall.events}/${metrics.judgeEvalDisagreement.overall.n} (${formatPercent(metrics.judgeEvalDisagreement.overall.rate)}, 95% CI ${formatCi(metrics.judgeEvalDisagreement.overall)}).`,
      hard.length > 0 ? `Hard-stratum judge/eval disagreement: ${hard.join('; ')}.` : 'No hard/very-hard judge/eval stratum was populated in this snapshot.',
    ],
    affectedIssues: ['HOK-2802', 'HOK-2810-HOK-2815', 'HOK-2823-HOK-2835'],
  };
}

function decisionLogEntry(snapshot: Omit<Phase1AnalysisSnapshot, 'decisionLogEntry'>): string {
  const date = snapshot.generatedAt.split('T')[0];
  const issueRepo = `**${date} · HOK-2802 · wavemill**`;
  if (snapshot.gate.call === 'insufficient_data') {
    return `${issueRepo} — Phase 1 gate not called from this source snapshot because required frozen probe artifacts are missing or empty. Why: a public gate call must be backed by P1.1 flip rate, P1.2 survival agreement and P1.2 judge/eval disagreement with denominators and confidence intervals; this snapshot has n=${snapshot.metrics.flipRate.overall.n}/${snapshot.metrics.survivalAgreement.overall.n}/${snapshot.metrics.judgeEvalDisagreement.overall.n}. Affects: HOK-2802 remains open; the P2.4 generator freeze remains in place until a complete frozen snapshot is analyzed.`;
  }

  const consequence = snapshot.gate.call === 'decision_layer'
    ? 'Phases 2-4 proceed as planned; closing HOK-2802 lifts the generator freeze, while P2.4 reviewer-stage validity gates remain required before live stage-attributed reviewer comparisons.'
    : 'arbitrate() is scoped as a de-noising feature; Showdown v0 is dropped, and the scan, report and Survival Check continue as a verification product without the pairwise story. P3 and P4 must be re-scoped before work starts.';
  return `${issueRepo} — ${snapshot.gate.title}. Why: ${snapshot.gate.reasons.join(' ')} ${consequence} Affects: ${snapshot.gate.affectedIssues.join(', ')}.`;
}

export function analyzePhase1ProbeSummaries(options: {
  swapSummary: SwapTestSummary;
  survivalSummary: JsonRecord;
  evalDisagreementSummary: JsonRecord;
  sources: Phase1SourceFile[];
  runId?: string;
  generatedAt?: string;
  gitRevision?: string;
  horizonDays?: number;
  gateMode?: GateMode;
}): Phase1AnalysisSnapshot {
  const swap = record(options.swapSummary, 'swap');
  const survival = record(options.survivalSummary, 'survival');
  const evalSummary = record(options.evalDisagreementSummary, 'eval');
  const metrics = {
    flipRate: swapMetric(options.swapSummary),
    survivalAgreement: survivalMetric(survival, options.horizonDays ?? null),
    judgeEvalDisagreement: evalMetric(evalSummary),
  };
  const partialSnapshot = {
    schemaVersion: 'arbiter.phase1.analysis.v1' as const,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    runId: options.runId ?? options.swapSummary.runId,
    gitRevision: options.gitRevision ?? currentGitRevision(),
    horizonDays: options.horizonDays ?? null,
    provenance: {
      sources: options.sources,
      swapRunId: stringField(swap, 'runId', 'swap'),
      judgeModel: stringField(swap, 'judge_model', 'swap'),
      judgeTemplateHash: stringField(swap, 'judge_template_hash', 'swap'),
      swapStartedAt: optionalStringField(record(swap.totals, 'swap.totals'), 'startedAt', 'swap.totals'),
    },
    population: {
      swapPairs: numberField(record(swap.totals, 'swap.totals'), 'pairs', 'swap.totals'),
      swapUsablePairs: numberField(record(swap.totals, 'swap.totals'), 'usablePairs', 'swap.totals'),
      survivalPopulation: numberField(survival, 'population', 'survival'),
      survivalAnalyzed: numberField(survival, 'analyzed', 'survival'),
      evalPopulation: numberField(evalSummary, 'population', 'eval'),
      evalAnalyzed: numberField(evalSummary, 'analyzed', 'eval'),
      evalTies: numberField(evalSummary, 'ties', 'eval'),
    },
    metrics,
  };

  const gate = decideGate(metrics, options.gateMode ?? 'auto');
  const snapshotWithoutLog = {
    ...partialSnapshot,
    gate,
  };
  return {
    ...snapshotWithoutLog,
    decisionLogEntry: decisionLogEntry(snapshotWithoutLog),
  };
}

export function loadPhase1ProbeSummaries(options: {
  swapSummaryPath: string;
  survivalSummaryPath: string;
  evalDisagreementSummaryPath: string;
  runId?: string;
  generatedAt?: string;
  gitRevision?: string;
  horizonDays?: number;
  gateMode?: GateMode;
}): Phase1AnalysisSnapshot {
  const swapSummary = readJsonFile(options.swapSummaryPath) as SwapTestSummary;
  const survivalSummary = readJsonFile(options.survivalSummaryPath);
  const evalDisagreementSummary = readJsonFile(options.evalDisagreementSummaryPath);
  return analyzePhase1ProbeSummaries({
    swapSummary,
    survivalSummary: record(survivalSummary, options.survivalSummaryPath),
    evalDisagreementSummary: record(evalDisagreementSummary, options.evalDisagreementSummaryPath),
    sources: [
      { kind: 'swap-summary', path: options.swapSummaryPath, sha256: sha256File(options.swapSummaryPath) },
      { kind: 'survival-summary', path: options.survivalSummaryPath, sha256: sha256File(options.survivalSummaryPath) },
      { kind: 'eval-disagreement-summary', path: options.evalDisagreementSummaryPath, sha256: sha256File(options.evalDisagreementSummaryPath) },
    ],
    runId: options.runId,
    generatedAt: options.generatedAt,
    gitRevision: options.gitRevision,
    horizonDays: options.horizonDays,
    gateMode: options.gateMode,
  });
}

function tableForCells(cells: Record<string, Phase1RateCell>): string[] {
  const lines = [
    '| Stratum | n | events | rate | 95% CI | Notes |',
    '|---|---:|---:|---:|---:|---|',
  ];
  for (const [name, cell] of Object.entries(cells)) {
    lines.push(`| ${name} | ${cell.n} | ${cell.events} | ${formatPercent(cell.rate)} | ${formatCi(cell)} | ${cell.excludedFromStratifiedAnalysis ? 'included overall; excluded from per-type interpretation' : ''} |`);
  }
  return lines;
}

function renderMetric(metric: Phase1ProbeMetric): string[] {
  const lines: string[] = [];
  lines.push(`## ${metric.title}`);
  lines.push('');
  lines.push(`Denominator: ${metric.denominator}. Event: ${metric.eventLabel}.`);
  lines.push('');
  lines.push('| Cell | n | events | rate | 95% CI |');
  lines.push('|---|---:|---:|---:|---:|');
  lines.push(`| Overall | ${metric.overall.n} | ${metric.overall.events} | ${formatPercent(metric.overall.rate)} | ${formatCi(metric.overall)} |`);
  lines.push('');
  lines.push('Notes:');
  for (const note of metric.notes) {
    lines.push(`- ${note}`);
  }
  lines.push('');
  lines.push('### By challenge type');
  lines.push('');
  lines.push(...tableForCells(metric.byChallengeType));
  lines.push('');
  lines.push('### By difficulty bucket');
  lines.push('');
  lines.push(...tableForCells(metric.byDifficultyBucket));
  lines.push('');
  lines.push('### By collapsed difficulty');
  lines.push('');
  lines.push(...tableForCells(metric.byDifficultyCollapsed));
  lines.push('');
  return lines;
}

export function renderPhase1AnalysisMarkdown(snapshot: Phase1AnalysisSnapshot): string {
  const lines: string[] = [];
  lines.push('# Arbiter Phase 1 Gate Write-up');
  lines.push('');
  lines.push(`Generated: ${snapshot.generatedAt}`);
  lines.push(`Run ID: ${snapshot.runId}`);
  lines.push(`Git revision: ${snapshot.gitRevision}`);
  lines.push('');
  lines.push('## Gate call');
  lines.push('');
  lines.push(`**${snapshot.gate.title}.** ${snapshot.gate.summary}`);
  lines.push('');
  for (const reason of snapshot.gate.reasons) {
    lines.push(`- ${reason}`);
  }
  lines.push('');
  lines.push('The scanner proceeds in either branch. Phase 1 gates the model and pairwise story, not the scan/report/Survival Check product. Closing HOK-2802 lifts the generator freeze for developing and landing the new pair generator, but it does not authorize live stage-attributed reviewer comparisons until P2.4 validity, evidence, identity, lifecycle, adjudication and integration-test gates pass.');
  lines.push('');
  lines.push(...renderMetric(snapshot.metrics.flipRate));
  lines.push(...renderMetric(snapshot.metrics.survivalAgreement));
  lines.push(...renderMetric(snapshot.metrics.judgeEvalDisagreement));
  lines.push('## Methodology');
  lines.push('');
  lines.push('Population: adjudicated challenge pairs with an LLM comparison verdict, excluding manual resolutions, non-verdict outcomes, voided records and older duplicate rows for the same challengePairId. The swap test replays each usable pair through the same blind judge twice, once in each presentation order. The survival probe evaluates only the kept side and counts a success only when the kept PR has a terminal survival label with report_outcome=survived. The eval-disagreement probe compares the head-to-head comparison winner with the strict higher per-side eval score; exact eval ties are reported separately and excluded from the rate denominator.');
  lines.push('');
  lines.push('Strata: challenge type, difficulty bucket and collapsed difficulty use the same derivation helpers as the swap test. Unrecoverable challenge type is included in overall counts and marked in stratified tables rather than silently dropped. Confidence intervals are Wilson 95% intervals. Ties, missing labels, missing eval rows and non-terminal horizons are never treated as agreements.');
  lines.push('');
  lines.push('Privacy: the report commits only aggregate findings, source paths, hashes and reproducibility commands. Raw prompts, diffs, task text, per-pair source evidence and judge rationales remain local.');
  lines.push('');
  lines.push('## Provenance');
  lines.push('');
  lines.push(`Judge model: ${snapshot.provenance.judgeModel}`);
  lines.push(`Judge template hash: ${snapshot.provenance.judgeTemplateHash}`);
  lines.push('');
  lines.push('| Source | Path | SHA-256 |');
  lines.push('|---|---|---|');
  for (const source of snapshot.provenance.sources) {
    lines.push(`| ${source.kind} | ${source.path} | ${source.sha256} |`);
  }
  lines.push('');
  lines.push('Repeat command:');
  lines.push('');
  lines.push('```bash');
  lines.push('npx tsx tools/arbiter-analyze-p1-probes.ts \\');
  lines.push('  --swap-summary <evals-dir>/swap-test/runs/<run-id>/summary.json \\');
  lines.push('  --survival-summary <evals-dir>/arbiter-probes/p1-2-survival-probe.json \\');
  lines.push('  --eval-disagreement-summary <evals-dir>/arbiter-probes/p1-2-eval-disagreement.json \\');
  lines.push('  --out-json .wavemill/evals/arbiter-probes/p1-3-phase-1-analysis.json \\');
  lines.push('  --out-md docs/arbiter/p1-3-phase-1-gate-write-up.md');
  lines.push('```');
  lines.push('');
  lines.push('## Decision Log entry');
  lines.push('');
  lines.push(snapshot.decisionLogEntry);
  lines.push('');
  return lines.join('\n');
}
