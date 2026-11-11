/**
 * Task size report (HOK-3469)
 *
 * Compares what expansion estimated for a task (packet §12, recorded in
 * `.wavemill/task-size-estimates.jsonl`) with what actually merged (merged PR
 * additions). The report answers "is the estimate good enough to hold tasks
 * on?" over a rolling window, and is read-only.
 *
 * Pure helpers (parsing, matching, aggregation, rendering) are separate from
 * the I/O in {@link readSizeEstimateRows} and {@link fetchMergedPrSizes}.
 *
 * @module task-size-report
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ISSUE_ID_GLOBAL_RE } from './task-identity.ts';
import { execArgvCommand } from './shell-utils.ts';
import { evaluateRecordedTaskSize, type TaskSizeLimits } from './task-size.ts';

/** Repo-relative path of the JSONL log `annotateTaskSize` appends to. */
export const SIZE_ESTIMATES_LOG = path.join('.wavemill', 'task-size-estimates.jsonl');

/** One row of `.wavemill/task-size-estimates.jsonl`. */
export interface SizeEstimateRow {
  issueId?: string;
  at: string;
  addedLines: number | null;
  files: number;
  coreFiles: string[];
  oversized: boolean;
  reasons: string[];
  slices: number;
}

/** One merged PR, reduced to what the report compares. */
export interface MergedPrSize {
  number: number;
  title: string;
  headRefName?: string;
  body?: string;
  additions: number;
  changedFiles: number;
  mergedAt: string;
}

/** One issue's estimate compared with its merged PRs. */
export interface SizeReportRow {
  issueId: string;
  estimatedAt: string;
  estimatedLines: number | null;
  estimatedFiles: number;
  oversized: boolean;
  reasons: string[];
  proposedSlices: number;
  actualLines: number | null;
  actualFiles: number | null;
  /** actual - estimated, or null when either side is unknown. */
  deltaLines: number | null;
  /** actual / estimated (1.0 means the estimate was exact), or null. */
  ratio: number | null;
  prNumbers: number[];
  mergedAt: string | null;
  /** Re-derived verdict under the report's current limits. */
  held: boolean;
}

/**
 * Confusion table over issues that merged in the window: did the hold track
 * what actually exceeded the limits? `actualFiles` sums the PRs' changed-file
 * counts, so a file changed by two PRs counts twice.
 */
export interface SizeConfusion {
  heldOverLimit: number;
  heldWithinLimit: number;
  launchedOverLimit: number;
  launchedWithinLimit: number;
}

export interface SizeReport {
  days: number;
  since: string;
  /** Limits the `held` verdict and the confusion table were computed with. */
  limits: { maxAddedLines: number; maxFiles: number } | null;
  rows: SizeReportRow[];
  confusion: SizeConfusion;
  totals: {
    issues: number;
    withActual: number;
    estimatedLines: number;
    actualLines: number;
    /** Mean actual/estimated ratio over issues with both sides known. */
    meanRatio: number | null;
    /** Median actual/estimated ratio; steadier than the mean against outliers. */
    medianRatio: number | null;
    /** Merged PRs in the window, including ones with no estimate. */
    mergedPullRequests: number;
    /** Merged PRs in the window whose issues have no estimate (counted, not dropped). */
    pullRequestsWithoutEstimate: number;
  };
}

/** Parse the JSONL estimate log, skipping malformed or unusable rows. */
export function parseSizeEstimateRows(text: string): SizeEstimateRow[] {
  const rows: SizeEstimateRow[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const row = parsed as Record<string, unknown>;
    if (typeof row.issueId !== 'string' || typeof row.at !== 'string') continue;
    if (Number.isNaN(Date.parse(row.at))) continue;
    rows.push({
      issueId: row.issueId,
      at: row.at,
      addedLines: typeof row.addedLines === 'number' ? row.addedLines : null,
      files: typeof row.files === 'number' ? row.files : 0,
      coreFiles: Array.isArray(row.coreFiles) ? row.coreFiles.filter((f): f is string => typeof f === 'string') : [],
      oversized: row.oversized === true,
      reasons: Array.isArray(row.reasons) ? row.reasons.filter((r): r is string => typeof r === 'string') : [],
      slices: typeof row.slices === 'number' ? row.slices : 0,
    });
  }
  return rows;
}

/** Keep the newest estimate per issue (re-expansion replaces the old verdict). */
export function latestEstimateByIssue(rows: SizeEstimateRow[]): Map<string, SizeEstimateRow> {
  const latest = new Map<string, SizeEstimateRow>();
  for (const row of rows) {
    if (!row.issueId) continue;
    const current = latest.get(row.issueId);
    if (!current || Date.parse(row.at) >= Date.parse(current.at)) {
      latest.set(row.issueId, row);
    }
  }
  return latest;
}

/** Every Linear issue ID mentioned in a PR's title, branch or body. */
export function issueIdsInPullRequest(
  pr: Pick<MergedPrSize, 'title' | 'body' | 'headRefName'>,
): string[] {
  const text = `${pr.headRefName ?? ''}\n${pr.title}\n${(pr.body ?? '').slice(0, 4000)}`;
  const matches = text.match(new RegExp(ISSUE_ID_GLOBAL_RE.source, 'g')) ?? [];
  return [...new Set(matches)];
}

/**
 * Build the estimate-vs-actual report over the last `days` days.
 *
 * Only issues with an estimate inside the window are reported; a merged PR
 * with no matching estimate is not a data point (it never had an estimate to
 * judge). PR additions are attributed to every issue ID the PR names, which
 * matches how the mill stamps task PRs with their issue.
 */
export function buildSizeReport(options: {
  estimates: SizeEstimateRow[];
  pullRequests: MergedPrSize[];
  days: number;
  now?: Date;
  /** Current limits, used for the re-derived hold and the confusion table. */
  limits?: TaskSizeLimits;
}): SizeReport {
  const days = Number.isFinite(options.days) && options.days > 0 ? Math.floor(options.days) : 30;
  const now = options.now ?? new Date();
  const sinceMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  const since = new Date(sinceMs).toISOString();
  const limits = options.limits ?? null;

  const latest = latestEstimateByIssue(
    options.estimates.filter((row) => Date.parse(row.at) >= sinceMs),
  );

  const perIssuePrs = new Map<string, MergedPrSize[]>();
  let mergedPullRequests = 0;
  let pullRequestsWithoutEstimate = 0;
  for (const pr of options.pullRequests) {
    if (Date.parse(pr.mergedAt) < sinceMs) continue;
    mergedPullRequests += 1;
    const issueIds = issueIdsInPullRequest(pr);
    if (!issueIds.some((issueId) => latest.has(issueId))) {
      pullRequestsWithoutEstimate += 1;
    }
    for (const issueId of issueIds) {
      if (!latest.has(issueId)) continue;
      const list = perIssuePrs.get(issueId) ?? [];
      list.push(pr);
      perIssuePrs.set(issueId, list);
    }
  }

  const rows: SizeReportRow[] = [];
  for (const [issueId, estimate] of latest) {
    const prs = (perIssuePrs.get(issueId) ?? []).sort((a, b) => a.number - b.number);
    const actualLines = prs.length > 0 ? prs.reduce((sum, pr) => sum + pr.additions, 0) : null;
    const actualFiles = prs.length > 0 ? prs.reduce((sum, pr) => sum + pr.changedFiles, 0) : null;
    const deltaLines =
      actualLines !== null && estimate.addedLines !== null ? actualLines - estimate.addedLines : null;
    const ratio =
      actualLines !== null && estimate.addedLines !== null && estimate.addedLines > 0
        ? actualLines / estimate.addedLines
        : null;
    // "Held" is re-derived under the current limits so the table answers "would
    // today's thresholds have held this task?", not "what did it record then?".
    const held = limits
      ? evaluateRecordedTaskSize(
          { addedLines: estimate.addedLines, fileCount: estimate.files, coreFiles: estimate.coreFiles },
          limits,
        ).reasons.length > 0
      : estimate.oversized;
    rows.push({
      issueId,
      estimatedAt: estimate.at,
      estimatedLines: estimate.addedLines,
      estimatedFiles: estimate.files,
      oversized: estimate.oversized,
      reasons: estimate.reasons,
      proposedSlices: estimate.slices,
      actualLines,
      actualFiles,
      deltaLines,
      ratio,
      prNumbers: prs.map((pr) => pr.number),
      mergedAt: prs.length > 0 ? prs[prs.length - 1].mergedAt : null,
      held,
    });
  }
  rows.sort((a, b) => (a.issueId < b.issueId ? -1 : a.issueId > b.issueId ? 1 : 0));

  const withActual = rows.filter((row) => row.actualLines !== null);
  const ratios = withActual.map((row) => row.ratio).filter((r): r is number => r !== null);

  const confusion: SizeConfusion = {
    heldOverLimit: 0,
    heldWithinLimit: 0,
    launchedOverLimit: 0,
    launchedWithinLimit: 0,
  };
  if (limits) {
    for (const row of withActual) {
      if (row.actualLines === null) continue;
      const over =
        row.actualLines > limits.maxAddedLines ||
        (row.actualFiles !== null && row.actualFiles > limits.maxFiles);
      if (row.held) {
        if (over) confusion.heldOverLimit += 1;
        else confusion.heldWithinLimit += 1;
      } else if (over) {
        confusion.launchedOverLimit += 1;
      } else {
        confusion.launchedWithinLimit += 1;
      }
    }
  }

  return {
    days,
    since,
    limits: limits ? { maxAddedLines: limits.maxAddedLines, maxFiles: limits.maxFiles } : null,
    rows,
    confusion,
    totals: {
      issues: rows.length,
      withActual: withActual.length,
      estimatedLines: rows.reduce((sum, row) => sum + (row.estimatedLines ?? 0), 0),
      actualLines: withActual.reduce((sum, row) => sum + (row.actualLines ?? 0), 0),
      meanRatio: ratios.length > 0 ? ratios.reduce((sum, r) => sum + r, 0) / ratios.length : null,
      medianRatio: median(ratios),
      mergedPullRequests,
      pullRequestsWithoutEstimate,
    },
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Human-readable table for the operator. */
export function renderSizeReport(report: SizeReport): string {
  const lines: string[] = [];
  lines.push(`Task size report (last ${report.days} days, since ${report.since.slice(0, 10)})`);
  lines.push('');
  if (report.rows.length === 0) {
    lines.push('No size estimates recorded in this window.');
    return lines.join('\n');
  }
  lines.push('  issue         est lines  actual  ratio   est files  actual files  verdict');
  for (const row of report.rows) {
    const est = row.estimatedLines === null ? 'unknown' : String(row.estimatedLines);
    const actual = row.actualLines === null ? '-' : String(row.actualLines);
    const ratio = row.ratio === null ? '-' : `${row.ratio.toFixed(2)}x`;
    const actualFiles = row.actualFiles === null ? '-' : String(row.actualFiles);
    const verdict = row.oversized ? `oversized (${row.reasons.join(', ')})` : 'within limits';
    lines.push(
      `  ${row.issueId.padEnd(13)} ${est.padStart(9)}  ${actual.padStart(6)}  ${ratio.padStart(5)}  ` +
        `${String(row.estimatedFiles).padStart(9)}  ${actualFiles.padStart(12)}  ${verdict}`,
    );
  }
  lines.push('');
  const fmt = (value: number | null) => (value === null ? 'n/a' : `${value.toFixed(2)}x`);
  lines.push(
    `${report.totals.issues} estimate(s), ${report.totals.withActual} merged, ` +
      `${report.totals.mergedPullRequests} merged PR(s) in window ` +
      `(${report.totals.pullRequestsWithoutEstimate} without an estimate); ` +
      `mean actual/estimated ${fmt(report.totals.meanRatio)}, median ${fmt(report.totals.medianRatio)}`,
  );
  if (report.limits) {
    lines.push('');
    lines.push(
      `Confusion under current limits (${report.limits.maxAddedLines} lines, ${report.limits.maxFiles} files):`,
    );
    lines.push(`  held, actually over:     ${report.confusion.heldOverLimit}`);
    lines.push(`  held, actually within:   ${report.confusion.heldWithinLimit}`);
    lines.push(`  launched, actually over: ${report.confusion.launchedOverLimit}`);
    lines.push(`  launched, within:        ${report.confusion.launchedWithinLimit}`);
  }
  return lines.join('\n');
}

/** Read the estimate log; a missing log is an empty report input, not an error. */
export function readSizeEstimateRows(repoDir: string): SizeEstimateRow[] {
  try {
    return parseSizeEstimateRows(readFileSync(path.join(repoDir, SIZE_ESTIMATES_LOG), 'utf8'));
  } catch {
    return [];
  }
}

export interface FetchMergedPrSizesOptions {
  limit?: number;
  /** Only PRs merged into this base (the mill's integration branch). */
  base?: string;
  /** Only PRs merged on/after this date. */
  since?: Date;
}

/** Fetch merged PR sizes with `gh`. Returns [] when `gh` is unavailable. */
export function fetchMergedPrSizes(
  repoDir: string,
  options: FetchMergedPrSizesOptions = {},
): MergedPrSize[] {
  const args = [
    'pr', 'list',
    '--state', 'merged',
    '--limit', String(options.limit ?? 200),
  ];
  if (options.base) args.push('--base', options.base);
  if (options.since) args.push('--search', `merged:>=${options.since.toISOString().slice(0, 10)}`);
  args.push('--json', 'number,title,body,headRefName,additions,changedFiles,mergedAt');
  const result = execArgvCommand('gh', args, {
    cwd: repoDir,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const prs: MergedPrSize[] = [];
  for (const item of parsed as Array<Record<string, unknown>>) {
    if (typeof item?.number !== 'number' || typeof item.mergedAt !== 'string') continue;
    prs.push({
      number: item.number,
      title: typeof item.title === 'string' ? item.title : '',
      ...(typeof item.headRefName === 'string' ? { headRefName: item.headRefName } : {}),
      ...(typeof item.body === 'string' ? { body: item.body } : {}),
      additions: typeof item.additions === 'number' ? item.additions : 0,
      changedFiles: typeof item.changedFiles === 'number' ? item.changedFiles : 0,
      mergedAt: item.mergedAt,
    });
  }
  return prs;
}
