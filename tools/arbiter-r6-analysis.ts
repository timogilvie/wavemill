#!/usr/bin/env -S npx tsx
/**
 * Arbiter R6 Reconnaissance — measure net pair yield across the reviewer-stage
 * fork boundary, and describe the health of the native challenge launch funnel.
 *
 * The script processes eval records (`evals.jsonl`) and challenge comparison
 * records (`challenge-records.jsonl`) using a streaming reader, then emits a
 * markdown report on stdout. The report is intentionally self-contained so it
 * can be redirected into a file or into the Arbiter decision log.
 *
 * See HOK-2815 for the task description and success criteria.
 */

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import type {
  StoredChallengeComparison,
  ChallengeComparisonOutcome,
  NoComparisonReason,
} from '../shared/lib/challenge-comparison.ts';
import type { EvalRecord } from '../shared/lib/eval-schema.ts';

// ── Types ────────────────────────────────────────────────────────────────────

type ForkPeriod = 'pre-fork' | 'post-fork';

interface YieldStats {
  launched: number;
  compared: number;
  yieldPercent: number;
  noComparisonBreakdown: Map<string, number>;
  usableForfeits?: number;
}

interface FunnelStage {
  name: string;
  count: number;
  dropOffFromPrevPercent: number;
  cumulativeYieldPercent: number;
  avgCostUsd: number;
  avgTimeSeconds: number;
}

interface FunnelStrataRow {
  key: string;
  eligible: number;
  compared: number;
  yieldPercent: number;
  avgCostUsd: number;
  avgTimeSeconds: number;
}

interface AnalysisInputs {
  comparisons: StoredChallengeComparison[];
  evals: EvalRecord[];
}

// ── Streaming JSONL reader ───────────────────────────────────────────────────

async function readJsonlStream<T>(filePath: string): Promise<T[]> {
  if (!existsSync(filePath)) return [];

  const records: T[] = [];
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as T);
    } catch {
      // Skip malformed lines silently, matching readJsonlFile semantics.
    }
  }
  return records;
}

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadInputs(repoDir: string, evalsDirName: string): Promise<AnalysisInputs> {
  const evalsFile = join(repoDir, evalsDirName, 'evals.jsonl');
  const challengesFile = join(repoDir, evalsDirName, 'challenge-records.jsonl');
  const [evals, comparisons] = await Promise.all([
    readJsonlStream<EvalRecord>(evalsFile),
    readJsonlStream<StoredChallengeComparison>(challengesFile),
  ]);
  return { evals, comparisons };
}

// ── Fork-period segmentation ─────────────────────────────────────────────────

function partitionByForkDate<T extends { timestamp: string }>(
  records: T[],
  forkDate: Date,
): { pre: T[]; post: T[] } {
  const pre: T[] = [];
  const post: T[] = [];
  for (const record of records) {
    const ts = Date.parse(record.timestamp);
    if (!Number.isFinite(ts)) {
      // Records with unparseable timestamps are treated as pre-fork so they do
      // not inflate post-fork yield numbers.
      pre.push(record);
      continue;
    }
    if (ts < forkDate.getTime()) pre.push(record);
    else post.push(record);
  }
  return { pre, post };
}

// ── Yield analysis ───────────────────────────────────────────────────────────

/**
 * The "no comparison" bucket key. We prefer the explicit
 * `noComparisonReason`, fall back to `terminalReason` and
 * `invalidChallengeReason`, then to `comparisonOutcome`.
 */
function noComparisonBucket(record: StoredChallengeComparison): string {
  if (record.noComparisonReason) return record.noComparisonReason as string;
  if (record.terminalReason) return record.terminalReason as string;
  if (record.invalidChallengeReason) return record.invalidChallengeReason as string;
  if (record.skipReason) return record.skipReason as string;
  if (record.comparisonOutcome && record.comparisonOutcome !== 'compared') {
    return record.comparisonOutcome as string;
  }
  return 'unknown';
}

function computeYieldStats(comparisons: StoredChallengeComparison[]): YieldStats {
  const launched = comparisons.length;
  const compared = comparisons.filter((c) => c.comparisonOutcome === 'compared').length;
  const noComparisonBreakdown = new Map<string, number>();
  for (const record of comparisons) {
    if (record.comparisonOutcome === 'compared') continue;
    const key = noComparisonBucket(record);
    noComparisonBreakdown.set(key, (noComparisonBreakdown.get(key) ?? 0) + 1);
  }
  return {
    launched,
    compared,
    yieldPercent: launched === 0 ? 0 : (compared / launched) * 100,
    noComparisonBreakdown,
  };
}

/**
 * Simulate "usable forfeits" for the pre-fork period. Before the reviewer
 * fork, when the primary arm failed hard the challenger arm could still deliver
 * usable code on its own branch; those pairs count as usable forfeits. Under
 * shared-prefix forking, the challenger inherits the failed prefix, so those
 * pairs would no longer yield.
 */
function estimateUsableForfeits(comparisons: StoredChallengeComparison[]): number {
  return comparisons.filter((c) => {
    if (c.comparisonOutcome === 'compared') return false;
    const reason = (c.terminalReason ?? c.noComparisonReason ?? '') as string;
    return reason === 'primary_eval_hard_failed' || reason === 'primary_challenge_aborted';
  }).length;
}

// ── Native challenge funnel analysis ─────────────────────────────────────────

/**
 * Compact per-pair aggregate used to project a pair onto its funnel stage.
 * We build one entry per unique challengePairId so a pair with two eval rows
 * (primary + challenger) is not double-counted.
 */
interface PairAggregate {
  pairId: string;
  timestamp: number;
  eligible: boolean;
  selected: boolean;
  intentPersisted: boolean;
  armMaterialized: boolean;
  stageLaunched: boolean;
  terminalReached: boolean;
  validComparison: boolean;
  provider: string;
  canonicalModel: string;
  sharedPrefix: boolean;
  costUsd: number;
  elapsedSeconds: number;
}

function isNativeEval(record: EvalRecord): boolean {
  const agent = record.agentType;
  return typeof agent === 'string' && agent.startsWith('native');
}

function pickPairId(record: EvalRecord): string | undefined {
  if (record.challengePairId) return record.challengePairId;
  return record.challengeIntent?.pairId;
}

function aggregatePairs(
  evals: EvalRecord[],
  comparisonsByPair: Map<string, StoredChallengeComparison>,
): Map<string, PairAggregate> {
  const pairs = new Map<string, PairAggregate>();

  for (const record of evals) {
    const pairId = pickPairId(record);
    if (!pairId) continue;
    if (!isNativeEval(record)) continue;

    const existing = pairs.get(pairId);
    const comparison = comparisonsByPair.get(pairId);
    const ts = Date.parse(record.timestamp);

    const eligible = Boolean(record.challengeRouteContext || record.challengeIntent);
    const selected = Boolean(record.challengePairId || record.challengeIntent?.pairId);
    const intentPersisted = Boolean(record.challengeIntent);
    const armMaterialized = Boolean(record.challengeExecutionEvidence || record.prUrl);
    const stageLaunched = Boolean(record.challengeExecutionEvidence?.evidence?.length);
    const terminalReached = Boolean(
      comparison?.comparisonOutcome || comparison?.terminalReason || record.failureReason,
    );
    const validComparison = comparison?.comparisonOutcome === 'compared';

    const provider = record.provider ?? 'unknown';
    const canonicalModel = record.model_alias ?? record.modelId ?? 'unknown';
    const cost = record.workflowCost ?? record.estimatedCost ?? 0;
    const elapsed = record.timeSeconds ?? 0;
    const sharedPrefix = Boolean(record.forkIdentity?.sharedPrefix ?? comparison?.sharedPrefix);

    if (!existing) {
      pairs.set(pairId, {
        pairId,
        timestamp: Number.isFinite(ts) ? ts : 0,
        eligible,
        selected,
        intentPersisted,
        armMaterialized,
        stageLaunched,
        terminalReached,
        validComparison,
        provider,
        canonicalModel,
        sharedPrefix,
        costUsd: cost,
        elapsedSeconds: elapsed,
      });
    } else {
      existing.eligible ||= eligible;
      existing.selected ||= selected;
      existing.intentPersisted ||= intentPersisted;
      existing.armMaterialized ||= armMaterialized;
      existing.stageLaunched ||= stageLaunched;
      existing.terminalReached ||= terminalReached;
      existing.validComparison ||= validComparison;
      existing.sharedPrefix ||= sharedPrefix;
      existing.costUsd += cost;
      existing.elapsedSeconds = Math.max(existing.elapsedSeconds, elapsed);
    }
  }

  return pairs;
}

function computeFunnel(pairs: PairAggregate[]): FunnelStage[] {
  const eligible = pairs.filter((p) => p.eligible).length;
  const selected = pairs.filter((p) => p.selected).length;
  const intentPersisted = pairs.filter((p) => p.intentPersisted).length;
  const armMaterialized = pairs.filter((p) => p.armMaterialized).length;
  const stageLaunched = pairs.filter((p) => p.stageLaunched).length;
  const terminalReached = pairs.filter((p) => p.terminalReached).length;
  const validComparison = pairs.filter((p) => p.validComparison).length;

  const validPairs = pairs.filter((p) => p.validComparison);
  const totalCost = validPairs.reduce((sum, p) => sum + p.costUsd, 0);
  const totalTime = validPairs.reduce((sum, p) => sum + p.elapsedSeconds, 0);
  const avgCost = validPairs.length === 0 ? 0 : totalCost / validPairs.length;
  const avgTime = validPairs.length === 0 ? 0 : totalTime / validPairs.length;

  const raw = [
    { name: 'Eligible opportunity', count: eligible },
    { name: 'Challenge selected', count: selected },
    { name: 'Intent persisted', count: intentPersisted },
    { name: 'Arm materialized', count: armMaterialized },
    { name: 'Stage launched', count: stageLaunched },
    { name: 'Terminal state', count: terminalReached },
    { name: 'Valid comparison', count: validComparison },
  ];

  const denominator = eligible === 0 ? 1 : eligible;
  return raw.map((stage, idx) => {
    const prev = idx === 0 ? stage.count : raw[idx - 1]!.count;
    const dropOff = prev === 0 ? 0 : ((prev - stage.count) / prev) * 100;
    return {
      name: stage.name,
      count: stage.count,
      dropOffFromPrevPercent: idx === 0 ? 0 : dropOff,
      cumulativeYieldPercent: (stage.count / denominator) * 100,
      avgCostUsd: stage.name === 'Valid comparison' ? avgCost : 0,
      avgTimeSeconds: stage.name === 'Valid comparison' ? avgTime : 0,
    };
  });
}

function stratifyFunnel(
  pairs: PairAggregate[],
  key: (p: PairAggregate) => string,
): FunnelStrataRow[] {
  const groups = new Map<string, PairAggregate[]>();
  for (const pair of pairs) {
    const k = key(pair) || 'unknown';
    const bucket = groups.get(k) ?? [];
    bucket.push(pair);
    groups.set(k, bucket);
  }
  const rows: FunnelStrataRow[] = [];
  for (const [name, group] of groups) {
    const eligible = group.filter((p) => p.eligible).length;
    const compared = group.filter((p) => p.validComparison).length;
    const validPairs = group.filter((p) => p.validComparison);
    const avgCost = validPairs.length === 0
      ? 0
      : validPairs.reduce((s, p) => s + p.costUsd, 0) / validPairs.length;
    const avgTime = validPairs.length === 0
      ? 0
      : validPairs.reduce((s, p) => s + p.elapsedSeconds, 0) / validPairs.length;
    rows.push({
      key: name,
      eligible,
      compared,
      yieldPercent: eligible === 0 ? 0 : (compared / eligible) * 100,
      avgCostUsd: avgCost,
      avgTimeSeconds: avgTime,
    });
  }
  return rows.sort((a, b) => b.eligible - a.eligible);
}

// ── Report formatting ────────────────────────────────────────────────────────

function fmtPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function fmtNumber(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function renderYieldSection(
  label: string,
  stats: YieldStats,
  extraLines: string[] = [],
): string {
  const lines: string[] = [];
  lines.push(`### ${label}`);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Pairs Launched | ${stats.launched} |`);
  lines.push(`| Pairs Reaching Comparison | ${stats.compared} |`);
  lines.push(`| Delivery Yield | ${fmtPct(stats.yieldPercent)} |`);
  if (stats.usableForfeits !== undefined) {
    const failureCount = stats.launched - stats.compared;
    const forfeitPct = failureCount === 0 ? 0 : (stats.usableForfeits / failureCount) * 100;
    lines.push(`| Estimated Usable Forfeits | ${stats.usableForfeits} (${fmtPct(forfeitPct)} of non-compared) |`);
  }
  for (const extra of extraLines) lines.push(extra);
  lines.push('');

  if (stats.noComparisonBreakdown.size > 0) {
    lines.push('#### Non-comparison causes');
    lines.push('');
    lines.push('| Cause | Count | Rate |');
    lines.push('|---|---|---|');
    const sorted = [...stats.noComparisonBreakdown.entries()].sort((a, b) => b[1] - a[1]);
    const denom = stats.launched || 1;
    for (const [cause, count] of sorted) {
      lines.push(`| ${cause} | ${count} | ${fmtPct((count / denom) * 100)} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderFunnelTable(stages: FunnelStage[]): string {
  const lines: string[] = [];
  lines.push('| Stage | Count | Drop-off | Cumulative Yield | Avg. Cost ($) | Avg. Time (s) |');
  lines.push('|---|---|---|---|---|---|');
  for (const stage of stages) {
    lines.push(
      `| ${stage.name} | ${stage.count} | ${fmtPct(stage.dropOffFromPrevPercent)} | ${fmtPct(stage.cumulativeYieldPercent)} | ${fmtNumber(stage.avgCostUsd, 4)} | ${fmtNumber(stage.avgTimeSeconds, 1)} |`,
    );
  }
  return lines.join('\n');
}

function renderStrataTable(title: string, rows: FunnelStrataRow[]): string {
  if (rows.length === 0) return `#### ${title}\n\n_No data._\n`;
  const lines: string[] = [];
  lines.push(`#### ${title}`);
  lines.push('');
  lines.push('| Key | Eligible | Compared | Yield | Avg. Cost ($) | Avg. Time (s) |');
  lines.push('|---|---|---|---|---|---|');
  for (const row of rows) {
    lines.push(
      `| ${row.key} | ${row.eligible} | ${row.compared} | ${fmtPct(row.yieldPercent)} | ${fmtNumber(row.avgCostUsd, 4)} | ${fmtNumber(row.avgTimeSeconds, 1)} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

// ── Recommendation ───────────────────────────────────────────────────────────

interface Recommendation {
  decision: 'Go' | 'No-Go' | 'Insufficient Data';
  justification: string;
}

function recommend(
  preFork: YieldStats,
  postFork: YieldStats,
  postForkForked: YieldStats,
  postForkIndependent: YieldStats,
): Recommendation {
  const MIN_SAMPLE = 20;
  if (postFork.launched < MIN_SAMPLE) {
    return {
      decision: 'Insufficient Data',
      justification: `Only ${postFork.launched} post-fork pairs observed (min ${MIN_SAMPLE}). Delay coder-stage extension until more data accrues.`,
    };
  }

  const netDelta = postFork.yieldPercent - preFork.yieldPercent;
  const forkedYield = postForkForked.yieldPercent;
  const independentYield = postForkIndependent.yieldPercent;
  const forkedAdvantage = forkedYield - independentYield;

  const parts: string[] = [];
  parts.push(
    `Post-fork delivery yield is ${fmtPct(postFork.yieldPercent)} vs pre-fork ${fmtPct(preFork.yieldPercent)} (net ${netDelta >= 0 ? '+' : ''}${fmtPct(netDelta)}).`,
  );
  if (postForkForked.launched > 0 && postForkIndependent.launched > 0) {
    parts.push(
      `Forked pairs (n=${postForkForked.launched}) yield ${fmtPct(forkedYield)}; independent pairs (n=${postForkIndependent.launched}) yield ${fmtPct(independentYield)}.`,
    );
  }
  const usableForfeitLossPct = preFork.launched === 0
    ? 0
    : ((preFork.usableForfeits ?? 0) / preFork.launched) * 100;
  parts.push(
    `Pre-fork usable forfeits accounted for ${fmtPct(usableForfeitLossPct)} of launches — that ceiling is what shared-prefix forking gives up.`,
  );

  if (netDelta >= 5 && forkedAdvantage >= 0) {
    return {
      decision: 'Go',
      justification: `${parts.join(' ')} Net yield improved meaningfully after the fork and forked pairs match or exceed independent pairs, so extending the shared-prefix mechanism to coder-stage arms is warranted.`,
    };
  }
  if (netDelta <= -5 || forkedAdvantage < -5) {
    return {
      decision: 'No-Go',
      justification: `${parts.join(' ')} Yield regressed after the fork or forked pairs trail independent pairs, so extending to coder-stage arms is not justified.`,
    };
  }
  return {
    decision: 'No-Go',
    justification: `${parts.join(' ')} Signal is inconclusive; the coder-stage fork gives up more fault tolerance than the reviewer-stage fork, so a No-Go recommendation is the safer default.`,
  };
}

// ── Report assembly ──────────────────────────────────────────────────────────

function classifyOutcome(outcome: ChallengeComparisonOutcome | undefined): string {
  return outcome ?? 'unknown';
}

interface ReportOptions {
  forkDate: Date;
  from?: Date;
  to?: Date;
  stratifyByPrefix: boolean;
}

function applyDateWindow(
  comparisons: StoredChallengeComparison[],
  from?: Date,
  to?: Date,
): StoredChallengeComparison[] {
  if (!from && !to) return comparisons;
  return comparisons.filter((c) => {
    const ts = Date.parse(c.timestamp);
    if (!Number.isFinite(ts)) return false;
    if (from && ts < from.getTime()) return false;
    if (to && ts > to.getTime()) return false;
    return true;
  });
}

function buildReport(inputs: AnalysisInputs, opts: ReportOptions): string {
  const windowed = applyDateWindow(inputs.comparisons, opts.from, opts.to);
  const { pre, post } = partitionByForkDate(windowed, opts.forkDate);

  const preStats = computeYieldStats(pre);
  preStats.usableForfeits = estimateUsableForfeits(pre);
  const postStats = computeYieldStats(post);

  const forkedPost = post.filter((c) => c.sharedPrefix === true || c.forkIdentity?.sharedPrefix === true);
  const independentPost = post.filter(
    (c) => !(c.sharedPrefix === true || c.forkIdentity?.sharedPrefix === true),
  );
  const forkedStats = computeYieldStats(forkedPost);
  const independentStats = computeYieldStats(independentPost);

  const comparisonsByPair = new Map<string, StoredChallengeComparison>();
  for (const c of windowed) comparisonsByPair.set(c.challengePairId, c);

  const nativeEvals = inputs.evals.filter(isNativeEval);
  const allPairs = [...aggregatePairs(nativeEvals, comparisonsByPair).values()];

  const postPairs = allPairs.filter((p) => p.timestamp >= opts.forkDate.getTime());
  const funnel = computeFunnel(postPairs);
  const stageStrata = stratifyFunnel(postPairs, (p) => p.provider);
  const providerStrata = stratifyFunnel(postPairs, (p) => p.provider);
  const modelStrata = stratifyFunnel(postPairs, (p) => p.canonicalModel);

  const forkedPairs = postPairs.filter((p) => p.sharedPrefix);
  const independentPairs = postPairs.filter((p) => !p.sharedPrefix);

  const recommendation = recommend(preStats, postStats, forkedStats, independentStats);

  const lines: string[] = [];
  lines.push('# Arbiter R6 Reconnaissance — Net Pair Yield');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Fork cutoff: ${opts.forkDate.toISOString()}`);
  if (opts.from) lines.push(`Window from: ${opts.from.toISOString()}`);
  if (opts.to) lines.push(`Window to: ${opts.to.toISOString()}`);
  lines.push(`Challenge comparisons analyzed: ${windowed.length}`);
  lines.push(`Eval records loaded: ${inputs.evals.length}`);
  lines.push('');

  lines.push('## Executive Summary');
  lines.push('');
  lines.push(`**Recommendation: ${recommendation.decision}**`);
  lines.push('');
  lines.push(recommendation.justification);
  lines.push('');

  lines.push('## Fork Yield Analysis');
  lines.push('');
  if (windowed.length === 0) {
    lines.push('_No challenge comparison records found in window. Ensure `.wavemill/evals/challenge-records.jsonl` is populated._');
    lines.push('');
  } else {
    lines.push(renderYieldSection('Pre-Fork', preStats));
    lines.push(renderYieldSection('Post-Fork', postStats));
    if (post.length === 0) {
      lines.push('_No post-fork data available for analysis._');
      lines.push('');
    }

    if (opts.stratifyByPrefix) {
      lines.push('### Post-Fork Stratified by `sharedPrefix`');
      lines.push('');
      lines.push(renderYieldSection('Forked pairs (sharedPrefix=true)', forkedStats));
      lines.push(renderYieldSection('Independent pairs (sharedPrefix=false)', independentStats));
    }
  }

  lines.push('## Native Challenge Funnel Analysis');
  lines.push('');
  if (postPairs.length === 0) {
    lines.push('_No native challenge data found for the analysis period._');
    lines.push('');
  } else {
    lines.push('Native challenge pairs traced through the seven launch stages.');
    lines.push('');
    lines.push(renderFunnelTable(funnel));
    lines.push('');
    lines.push(renderStrataTable('By provider', providerStrata));
    lines.push(renderStrataTable('By canonical model', modelStrata));
    // `stageStrata` currently mirrors the provider grouping; retained for
    // future expansion when workflow stage becomes an evidence field.
    void stageStrata;

    if (opts.stratifyByPrefix) {
      const forkedStrata = stratifyFunnel(forkedPairs, () => 'forked');
      const independentStrata = stratifyFunnel(independentPairs, () => 'independent');
      lines.push(renderStrataTable('Forked native pairs', forkedStrata));
      lines.push(renderStrataTable('Independent native pairs', independentStrata));
    }
  }

  lines.push('## Comparison Outcome Distribution');
  lines.push('');
  const outcomeCounts = new Map<string, number>();
  for (const c of windowed) {
    const key = classifyOutcome(c.comparisonOutcome);
    outcomeCounts.set(key, (outcomeCounts.get(key) ?? 0) + 1);
  }
  if (outcomeCounts.size === 0) {
    lines.push('_No outcomes recorded._');
    lines.push('');
  } else {
    lines.push('| Outcome | Count |');
    lines.push('|---|---|');
    for (const [key, count] of [...outcomeCounts.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${key} | ${count} |`);
    }
    lines.push('');
  }

  lines.push('## Recommendation');
  lines.push('');
  lines.push(`**Recommendation: ${recommendation.decision}**`);
  lines.push('');
  lines.push(recommendation.justification);
  lines.push('');

  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseIsoDate(input: string | undefined, flag: string): Date {
  if (!input) throw new Error(`Missing required flag ${flag}`);
  const trimmed = input.trim();
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ISO 8601 date for ${flag}: "${input}"`);
  }
  return new Date(parsed);
}

const isDirectRun = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  runToolCli();
}

function runToolCli(): void {
  runTool({
  name: 'arbiter-r6-analysis',
  description:
    'Compare AI pair-programming yields before and after the reviewer-stage fork and diagnose the native challenge launch funnel.',
  options: {
    'fork-date': {
      type: 'string',
      description: 'ISO 8601 timestamp for the reviewer-stage fork cutoff (default: 2026-08-01T00:00:00Z)',
    },
    from: { type: 'string', description: 'Filter records at or after this ISO 8601 date' },
    to: { type: 'string', description: 'Filter records at or before this ISO 8601 date' },
    'stratify-by-prefix': {
      type: 'boolean',
      description: 'Emit additional tables stratified by `sharedPrefix`',
    },
    'evals-dir': {
      type: 'string',
      description: 'Override the evals directory relative to the repo (default: .wavemill/evals)',
    },
  },
  positional: {
    name: 'repo-dir',
    description: 'Repository directory containing .wavemill/evals (defaults to cwd)',
  },
  examples: [
    'npx tsx tools/arbiter-r6-analysis.ts',
    'npx tsx tools/arbiter-r6-analysis.ts --fork-date 2026-08-15T00:00:00Z',
    'npx tsx tools/arbiter-r6-analysis.ts --from 2026-06-01T00:00:00Z --to 2026-09-24T00:00:00Z',
    'npx tsx tools/arbiter-r6-analysis.ts --stratify-by-prefix > report.md',
  ],
  async run({ args, positional }) {
    const repoDir = resolveRepoDir(positional[0]);
    const evalsDir = (args['evals-dir'] as string | undefined) ?? '.wavemill/evals';

    const forkDate = parseIsoDate(
      (args['fork-date'] as string | undefined) ?? '2026-08-01T00:00:00Z',
      '--fork-date',
    );
    const from = args.from ? parseIsoDate(args.from as string, '--from') : undefined;
    const to = args.to ? parseIsoDate(args.to as string, '--to') : undefined;

    const inputs = await loadInputs(repoDir, evalsDir);
    if (inputs.evals.length === 0 && inputs.comparisons.length === 0) {
      console.error(
        `Error: evals.jsonl and challenge-records.jsonl are both empty or not found in ${join(repoDir, evalsDir)}.`,
      );
      process.exit(1);
    }

    const report = buildReport(inputs, {
      forkDate,
      from,
      to,
      stratifyByPrefix: Boolean(args['stratify-by-prefix']),
    });

    process.stdout.write(report);
  },
  });
}

// ── Exports for tests ────────────────────────────────────────────────────────

// Only re-exported for the companion unit-test file; not part of the CLI API.
export {
  aggregatePairs,
  buildReport,
  computeFunnel,
  computeYieldStats,
  estimateUsableForfeits,
  partitionByForkDate,
  recommend,
  stratifyFunnel,
};
export type { NoComparisonReason };
