import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJsonlFile } from '../jsonl-utils.ts';
import { wilsonInterval, type ProportionInterval } from '../stats-utils.ts';
import { readCorpusPair, type SwapTestCorpusContext } from './corpus.ts';
import { manifestPath, resultsPath, type SwapTestResultRow, type SwapTestRunManifest } from './runner.ts';

export interface FlipCell {
  n: number;
  flips: number;
  rate: number | null;
  ci95: ProportionInterval;
  excludedFromStratifiedAnalysis?: boolean;
}

export interface PairFlipResult {
  pairId: string;
  status: 'ok' | 'judge_error' | 'missing_result' | 'hydration_failed';
  flipped: boolean;
  positionPreference: 'first' | 'second' | 'none';
  primaryFirstWinner?: 'primary' | 'challenger';
  challengerFirstWinner?: 'primary' | 'challenger';
  agreesWithOriginalPrimaryFirst?: boolean;
  agreesWithOriginalChallengerFirst?: boolean;
  marginPrimaryFirst?: number;
  marginChallengerFirst?: number;
  degenerate: string[];
  challengeType: string;
  difficultyBucket: string;
  difficultyCollapsed: string;
}

export interface SwapTestSummary {
  runId: string;
  judge_model: string;
  judge_template_hash: string;
  totals: {
    pairs: number;
    usablePairs: number;
    judgeErrors: number;
    hydrationFailed: number;
    calls: number;
    costUsd: number;
    /** Dry runs whose change input was summarised to fit the judge instead of shown verbatim. */
    summarisedPrompts: number;
    tokens: number;
  };
  overall: FlipCell;
  withoutDegenerate: FlipCell;
  byChallengeType: Record<string, FlipCell>;
  byDifficultyBucket: Record<string, FlipCell>;
  byDifficultyCollapsed: Record<string, FlipCell>;
  typeDifficultyCrosstab: Record<string, Record<string, number>>;
  flipDirection: Record<'first' | 'second' | 'none', number>;
  agreementWithOriginal: {
    primaryFirst: FlipCell;
    challengerFirst: FlipCell;
  };
  pairs: PairFlipResult[];
}

function latestRowsByKey(rows: SwapTestResultRow[]): Map<string, SwapTestResultRow> {
  const latest = new Map<string, SwapTestResultRow>();
  for (const row of rows) {
    latest.set(`${row.pairId}\u0000${row.order}`, row);
  }
  return latest;
}

function margin(row: SwapTestResultRow | undefined): number | undefined {
  if (!row?.dimensions) return undefined;
  return Object.values(row.dimensions).reduce((sum, value) => sum + (value.primary - value.challenger), 0);
}

function cell(pairs: PairFlipResult[]): FlipCell {
  const usable = pairs.filter((pair) => pair.status === 'ok');
  const flips = usable.filter((pair) => pair.flipped).length;
  const interval = wilsonInterval(flips, usable.length);
  return {
    n: usable.length,
    flips,
    rate: interval.p,
    ci95: interval,
  };
}

function agreementCell(pairs: PairFlipResult[], order: 'primaryFirst' | 'challengerFirst'): FlipCell {
  const key = order === 'primaryFirst' ? 'agreesWithOriginalPrimaryFirst' : 'agreesWithOriginalChallengerFirst';
  const usable = pairs.filter((pair) => pair.status === 'ok' && pair[key] !== undefined);
  const agreements = usable.filter((pair) => pair[key] === true).length;
  const interval = wilsonInterval(agreements, usable.length);
  return {
    n: usable.length,
    flips: agreements,
    rate: interval.p,
    ci95: interval,
  };
}

function groupCells(pairs: PairFlipResult[], key: (pair: PairFlipResult) => string): Record<string, FlipCell> {
  const grouped = new Map<string, PairFlipResult[]>();
  for (const pair of pairs) {
    const value = key(pair);
    grouped.set(value, [...(grouped.get(value) ?? []), pair]);
  }
  return Object.fromEntries([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, group]) => [name, cell(group)]));
}

function positionPreference(primaryFirst?: SwapTestResultRow, challengerFirst?: SwapTestResultRow): PairFlipResult['positionPreference'] {
  if (!primaryFirst?.winner || !challengerFirst?.winner || primaryFirst.winner === challengerFirst.winner) {
    return 'none';
  }
  if (primaryFirst.winner === 'primary' && challengerFirst.winner === 'challenger') return 'first';
  if (primaryFirst.winner === 'challenger' && challengerFirst.winner === 'primary') return 'second';
  return 'none';
}

function pairResult(
  context: SwapTestCorpusContext,
  primaryFirst?: SwapTestResultRow,
  challengerFirst?: SwapTestResultRow,
): PairFlipResult {
  const errored = primaryFirst?.status === 'error' || challengerFirst?.status === 'error';
  const missing = !primaryFirst || !challengerFirst || primaryFirst.status === 'dry_run' || challengerFirst.status === 'dry_run';
  const ok = primaryFirst?.status === 'ok' && challengerFirst?.status === 'ok';
  return {
    pairId: context.pairId,
    status: context.hydrationStatus === 'failed' ? 'hydration_failed' : errored ? 'judge_error' : ok ? 'ok' : missing ? 'missing_result' : 'judge_error',
    flipped: Boolean(ok && primaryFirst.winner !== challengerFirst.winner),
    positionPreference: positionPreference(primaryFirst, challengerFirst),
    primaryFirstWinner: primaryFirst?.winner,
    challengerFirstWinner: challengerFirst?.winner,
    agreesWithOriginalPrimaryFirst: ok && context.originalVerdict.winner ? primaryFirst.winner === context.originalVerdict.winner : undefined,
    agreesWithOriginalChallengerFirst: ok && context.originalVerdict.winner ? challengerFirst.winner === context.originalVerdict.winner : undefined,
    marginPrimaryFirst: margin(primaryFirst),
    marginChallengerFirst: margin(challengerFirst),
    degenerate: context.degenerate,
    challengeType: context.challengeType.type,
    difficultyBucket: String(context.difficulty.bucket),
    difficultyCollapsed: context.difficulty.collapsed,
  };
}

function formatPct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatCellRow(name: string, item: FlipCell): string {
  return `| ${name} | ${item.n} | ${item.flips} | ${formatPct(item.rate)} | ${formatPct(item.ci95.lo)} - ${formatPct(item.ci95.hi)} |`;
}

function markdownTable(title: string, cells: Record<string, FlipCell>): string {
  return [
    `## ${title}`,
    '',
    '| Stratum | n | flips | rate | 95% CI |',
    '|---|---:|---:|---:|---:|',
    ...Object.entries(cells).map(([name, item]) => formatCellRow(name, item)),
    '',
  ].join('\n');
}

export function writeSwapTestReport(evalsDir: string, runId: string, pairIds: readonly string[]): SwapTestSummary {
  const manifest = JSON.parse(readFileSync(manifestPath(evalsDir, runId), 'utf-8')) as SwapTestRunManifest;
  const rows = existsSync(resultsPath(evalsDir, runId)) ? readJsonlFile<SwapTestResultRow>(resultsPath(evalsDir, runId)) : [];
  const latest = latestRowsByKey(rows);
  const pairs = pairIds.map((pairId) => {
    const context = readCorpusPair(evalsDir, pairId).context;
    return pairResult(
      context,
      latest.get(`${pairId}\u0000primary-first`),
      latest.get(`${pairId}\u0000challenger-first`),
    );
  });
  const usable = pairs.filter((pair) => pair.status === 'ok');
  const byChallengeType = groupCells(usable, (pair) => pair.challengeType);
  if (byChallengeType.unrecoverable) {
    byChallengeType.unrecoverable.excludedFromStratifiedAnalysis = true;
  }

  const typeDifficultyCrosstab: Record<string, Record<string, number>> = {};
  for (const pair of usable) {
    typeDifficultyCrosstab[pair.challengeType] ??= {};
    typeDifficultyCrosstab[pair.challengeType][pair.difficultyCollapsed] = (typeDifficultyCrosstab[pair.challengeType][pair.difficultyCollapsed] ?? 0) + 1;
  }

  const summary: SwapTestSummary = {
    runId,
    judge_model: manifest.judge_model,
    judge_template_hash: manifest.judge_template_hash,
    totals: {
      pairs: pairs.length,
      usablePairs: usable.length,
      judgeErrors: pairs.filter((pair) => pair.status === 'judge_error' || pair.status === 'missing_result').length,
      hydrationFailed: pairs.filter((pair) => pair.status === 'hydration_failed').length,
      calls: rows.filter((row) => row.status !== 'dry_run').length,
      costUsd: rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
      summarisedPrompts: rows.filter((row) => (row.summarisedFiles ?? 0) > 0).length,
      tokens: rows.reduce((sum, row) => sum + (row.usage?.totalTokens ?? 0), 0),
    },
    overall: cell(usable),
    withoutDegenerate: cell(usable.filter((pair) => pair.degenerate.length === 0)),
    byChallengeType,
    byDifficultyBucket: groupCells(usable, (pair) => pair.difficultyBucket),
    byDifficultyCollapsed: groupCells(usable, (pair) => pair.difficultyCollapsed),
    typeDifficultyCrosstab,
    flipDirection: {
      first: usable.filter((pair) => pair.flipped && pair.positionPreference === 'first').length,
      second: usable.filter((pair) => pair.flipped && pair.positionPreference === 'second').length,
      none: usable.filter((pair) => pair.flipped && pair.positionPreference === 'none').length,
    },
    agreementWithOriginal: {
      primaryFirst: agreementCell(usable, 'primaryFirst'),
      challengerFirst: agreementCell(usable, 'challengerFirst'),
    },
    pairs,
  };

  const dir = dirname(resultsPath(evalsDir, runId));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf-8');
  writeFileSync(join(dir, 'summary.md'), renderSwapTestSummaryMarkdown(summary), 'utf-8');
  return summary;
}

export function renderSwapTestSummaryMarkdown(summary: SwapTestSummary): string {
  return [
    `# Arbiter swap test ${summary.runId}`,
    '',
    `Judge model: \`${summary.judge_model}\``,
    `Judge template hash: \`${summary.judge_template_hash}\``,
    `Pairs: ${summary.totals.usablePairs}/${summary.totals.pairs} usable`,
    `Cost: $${summary.totals.costUsd.toFixed(4)}`,
    '',
    '## Overall',
    '',
    '| Cell | n | flips | rate | 95% CI |',
    '|---|---:|---:|---:|---:|',
    formatCellRow('All usable pairs', summary.overall),
    formatCellRow('Excluding degenerate pairs', summary.withoutDegenerate),
    '',
    markdownTable('By Challenge Type', summary.byChallengeType),
    markdownTable('By Difficulty Bucket', summary.byDifficultyBucket),
    markdownTable('By Difficulty Collapsed', summary.byDifficultyCollapsed),
    '## Flip Direction',
    '',
    `First-position: ${summary.flipDirection.first}`,
    `Second-position: ${summary.flipDirection.second}`,
    `Other/none: ${summary.flipDirection.none}`,
    '',
    '## Agreement With Original',
    '',
    '| Order | n | agreements | rate | 95% CI |',
    '|---|---:|---:|---:|---:|',
    formatCellRow('Primary first', summary.agreementWithOriginal.primaryFirst).replace('| flips |', '| agreements |'),
    formatCellRow('Challenger first', summary.agreementWithOriginal.challengerFirst).replace('| flips |', '| agreements |'),
    '',
  ].join('\n');
}
