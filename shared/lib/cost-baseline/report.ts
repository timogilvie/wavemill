/**
 * Markdown / JSON rendering for the MQ-0.1 baseline (HOK-3336).
 *
 * The markdown doubles as the Linear comment body; the tool prints it with
 * `--print-comment` and never posts it.
 *
 * @module cost-baseline/report
 */

import { ATTRIBUTED_TASK_MAX_UNATTRIBUTED, DECISION_THRESHOLDS, MIN_ATTRIBUTED_TASKS, type BaselineSummary, type ComponentShare, type Stats } from './aggregator.ts';
import type { DepthDistribution } from './queue-depth.ts';
import type { BaselineTaskRow } from './types.ts';

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function usd(value: number | null | undefined): string {
  return value === null || value === undefined ? 'n/a' : `$${value.toFixed(2)}`;
}

/** Seconds as a compact duration (`45s`, `12.5m`, `3.2h`). */
export function duration(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'n/a';
  if (value < 120) return `${Math.round(value)}s`;
  if (value < 7200) return `${(value / 60).toFixed(1)}m`;
  return `${(value / 3600).toFixed(1)}h`;
}

function count(value: number | null | undefined): string {
  return value === null || value === undefined ? 'n/a' : Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function componentTable(components: ComponentShare[], fmt: (v: number | null) => string, shareOf: string): string[] {
  const lines = [
    `| Component | n | Mean | Median | p90 | Share of ${shareOf} (n) | Boundary |`,
    '|---|---|---|---|---|---|---|',
  ];
  for (const c of components) {
    lines.push(`| ${c.label} | ${c.stats.n} | ${fmt(c.stats.mean)} | ${fmt(c.stats.median)} | ${fmt(c.stats.p90)} | ${pct(c.share)} (${c.shareN}) | ${c.boundary} |`);
  }
  return lines;
}

function statsRow(label: string, stats: Stats, fmt: (v: number | null) => string, extra = ''): string {
  return `| ${label} | ${stats.n} | ${fmt(stats.mean)} | ${fmt(stats.median)} | ${fmt(stats.p90)} | ${fmt(stats.max)} |${extra}`;
}

function depthLines(label: string, d: DepthDistribution | null): string[] {
  if (!d) return [`- ${label}: no data`];
  const levels = d.secondsByDepth.map((secs, depth) => `${depth}: ${pct(secs / d.totalSeconds)}`).join(', ');
  return [
    `- **${label}** (${d.from} → ${d.to}): >0 deep ${pct(d.shareDepthGt0)}, **>1 deep ${pct(d.shareDepthGt1)}**, **>2 deep ${pct(d.shareDepthGt2)}**, max depth ${d.maxDepth}, mean depth when non-empty ${d.meanDepthWhenNonEmpty.toFixed(2)}`,
    `  - time share by depth — ${levels}`,
  ];
}

/** The known gaps, with counts from this run. */
export function knownGaps(summary: BaselineSummary): string[] {
  const c = summary.coverage;
  const gaps = [
    `**Dollar source.** Agent cost is Σ per-session cost recorded on each eval row (\`executionEconomics[].sessions[]\`: provider charge, else the cost engine's local estimate at list price). The row's \`workflowCost\` is not used — from Aug 2026 it charged a shared native-session pool to every task (HOK-3256). Costs are list-price equivalents, not cash.`,
    `**Excluded sessions.** ${summary.excludedSessions.shared} session(s) appearing on more than one task (${usd(summary.excludedSessions.sharedUsd)}) and ${summary.excludedSessions.operator} operator-owned session(s) (${usd(summary.excludedSessions.operatorUsd)}) are not task cost; ${summary.excludedSessions.unpriced} session(s) carried no price.`,
    `**Agent cost coverage.** full ${c.agentCost.full}, partial ${c.agentCost.partial}, missing ${c.agentCost.missing} (missing = no measured sessions on the eval row).`,
    `**Stage attribution.** Before launch-record ownership (HOK-3328, late Oct 2026) most sessions carry no stage label; they are reported as "unattributed" rather than guessed, so the review/repair shares are lower bounds for older tasks.`,
    `**CI minutes.** From \`outcomes.ci.checks[].durationSeconds\` on the evaluated (final) PR head only: CI on earlier heads (reruns after pushes) is not recorded locally, and aggregate status checks are counted as reported. Billable minutes would need \`gh api .../actions/runs/<id>/timing\` and were not fetched. Priced at ${summary.ciUsdPerMinute} USD/min (GitHub Linux list price) for comparison only. Coverage: full ${c.ciComputeMinutes.full}, partial ${c.ciComputeMinutes.partial}, missing ${c.ciComputeMinutes.missing}.`,
    `**Queue depth.** "Queued" counts every PR holding wm:ready, including PRs tend holds back (e.g. an unresolved challenge pair), so it is an upper bound on PRs the executor could merge. Lane occupancy (progress.json) is the lower bound: time the executor actively held a PR.`,
    `**Queue wait.** Needs the label ledger (\`label-writes.jsonl\`), which starts 2026-10-13; earlier tasks report it as missing (coverage: full ${c.queueWait.full}, missing ${c.queueWait.missing}). Lane progress files carry no ready timestamp.`,
    `**Wall-clock shares are not disjoint.** CI, repair sessions and the review stage overlap in time, and end-to-end also contains operator/approval waits and monitor latency, so component shares need not sum to 100%. End-to-end coverage: full ${c.endToEnd.full}, missing ${c.endToEnd.missing}.`,
    `**Review rounds.** Archived \`reviewIterations[]\` (HOK-2969) is rare; rounds fall back to review-helper sessions, then the final run's \`artifacts.iterations\`, then review launches (sources: ${Object.entries(summary.review.roundsSource).map(([k, v]) => `${k} ${v}`).join(', ')}). The in-stage fix sub-loop of review-flow.ts is one round. Review results are read through the shared stage-artifact lookup, which reads the dotted \`.review-result.json\`; archives written before HOK-2891 need \`npx tsx tools/migrate-archived-stage-artifacts.ts\` to be visible.`,
    `**Findings on pre-existing vs new code.** File-level only, and only where \`reviewIterations[].reviewerDelta.filesChanged\` survived (${summary.review.findings.tasks} task(s)). Line-level blame needs the reaped branch history and was not attempted.`,
    `**Retry sentinels / tend attempt facts.** \`.retry-*-exhausted\` and \`.tend-attempt-result.json\` live in the task state dir and do not survive the reap; integration failures use lane counters, the label ledger and repair launches instead. \`rebaseCount\`/\`ciRestartCount\` exist only on newer lane files (null, not zero, elsewhere).`,
    `**Challenger arms.** A challenge pair's challenger (\`_c\`) is its own merged row only when it won; ${summary.generatedFrom.challengers} challenger row(s) are in the cohort. Losing arms' spend is not in this per-completed-task view.`,
  ];
  return gaps;
}

/** Render the markdown report (also the Linear comment body). */
export function formatBaselineMarkdown(summary: BaselineSummary): string {
  const lines: string[] = [];
  const { window, counts } = summary;
  lines.push(`# MQ-0.1 Baseline cost-per-task — ${window.since} → ${window.until}`, '');

  lines.push('## Decision rule outcome', '');
  const fired = summary.decisionRules.filter((r) => r.fired);
  lines.push(`**Fired: ${fired.length > 0 ? fired.map((r) => r.id).join(', ') : 'none'}.**`, '');
  for (const rule of summary.decisionRules) {
    lines.push(`- **${rule.id} — ${rule.title}: ${rule.fired ? 'FIRED' : 'not fired'}.** ${rule.fired ? rule.recommendation : ''}`.trimEnd());
    for (const e of rule.evidence) lines.push(`  - ${e}`);
  }
  lines.push(
    '',
    'Context: HOK-2939 targets a required-CI critical path under 5 minutes; speculation upside is bounded by how long a PR waits on CI in the lane, which shrinks as that lands.',
    '',
  );

  lines.push('## Cohort', '');
  lines.push(
    `- Merged tasks (latest eval row per issue): **${summary.generatedFrom.tasks}** (${summary.generatedFrom.challengers} challenger arm(s))`,
    `- Eval rows in window: ${counts.evalRowsInWindow}; merged rows: ${counts.mergedRows}; duplicate rows collapsed: ${counts.duplicateRowsCollapsed}; malformed lines skipped: ${counts.malformedLines}`,
    `- Tombstones in window (not aggregated): ${Object.entries(counts.tombstonesByOutcome).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
    '',
  );

  lines.push('## Shares of cost-per-task ($)', '');
  lines.push(`Total per task (agent + CI): mean ${usd(summary.cost.total.mean)}, median ${usd(summary.cost.total.median)}, p90 ${usd(summary.cost.total.p90)} (n=${summary.cost.total.n}).`, '');
  lines.push(...componentTable(summary.cost.components, usd, 'total $'), '');
  const attributed = summary.attributedCost;
  lines.push(
    `### Stage-attributed tasks only (unattributed spend ≤ ${pct(ATTRIBUTED_TASK_MAX_UNATTRIBUTED)} of agent spend)`,
    '',
    `Total per task: mean ${usd(attributed.total.mean)}, median ${usd(attributed.total.median)}, p90 ${usd(attributed.total.p90)} (n=${attributed.total.n}). Decision rules read **${summary.ruleCostBasis === 'attributed' ? 'this subset' : 'the whole cohort'}** for cost shares (subset used when n ≥ ${MIN_ATTRIBUTED_TASKS}).`,
    '',
  );
  lines.push(...componentTable(attributed.components, usd, 'total $'), '');
  lines.push('Queue wait is **not a dollar cost**: agent sessions end before the PR is queued, so no agent holds context while it waits. It is reported as latency below.', '');

  lines.push('## Shares of wall-clock-per-task', '');
  lines.push(`End-to-end (first agent turn → merge [merged lane lastProgressAt, else wm:merged write, else GitHub mergedAt]): mean ${duration(summary.wallClock.endToEnd.mean)}, median ${duration(summary.wallClock.endToEnd.median)}, p90 ${duration(summary.wallClock.endToEnd.p90)} (n=${summary.wallClock.endToEnd.n}).`, '');
  lines.push(...componentTable(summary.wallClock.components, duration, 'end-to-end'), '');
  lines.push('Wall-clock shares are the mean of per-task shares (component ÷ that task\'s end-to-end), so each task weighs the same.', '');

  lines.push('## Queue depth (strict merge lane)', '');
  const ledger = summary.queueDepth.ledger;
  lines.push(
    `Label-ledger coverage: ${ledger.coverageFrom ?? 'none'} → ${ledger.coverageTo}. "Queued" = holding wm:ready or wm:merging; "waiting" = holding wm:ready only. Labels persist on merged/closed PRs, so each PR's intervals are clipped at its merge/close time (lane merge, wm:merged write${ledger.prStatesFetched ? ', GitHub merge/close time' : ''}).`,
    ledger.unterminatedPrs.length > 0
      ? `${ledger.unterminatedPrs.length} PR(s) whose label never came off and whose close time is unknown were excluded: ${ledger.unterminatedPrs.map((n) => `#${n}`).join(', ')}${ledger.prStatesFetched ? '' : ' (re-run with --fetch-pr-state to resolve them)'}.`
      : 'No PR was excluded for an unknown close time.',
    '',
  );
  lines.push(...depthLines('Queued', ledger.queued), ...depthLines('Waiting', ledger.waiting));
  lines.push(...depthLines('Lane occupancy (progress.json, whole window)', summary.queueDepth.lane));
  const a = ledger.arrivals;
  lines.push(
    a
      ? `- **Arrivals** (a PR's first enqueue): ${a.arrivals}; found ≥1 ahead ${pct(a.shareFoundAhead1)}, ≥2 ahead ${pct(a.shareFoundAhead2)}; median inter-arrival ${duration(a.medianInterArrivalSeconds)}; inter-arrival CV ${a.interArrivalCv?.toFixed(2) ?? 'n/a'}; hourly Fano factor ${a.hourlyFano?.toFixed(2) ?? 'n/a'} (1 = Poisson, >1 = bursty); peak ${a.peakArrivalsPerHour}/hour`
      : '- Arrivals: no data',
    '',
  );

  lines.push('## Integration failures (raw counts per task)', '');
  lines.push('| Metric | n | Mean | Median | p90 | Max | Tasks with ≥1 |', '|---|---|---|---|---|---|---|');
  const failureLabels: Record<string, string> = {
    failedMergeAttempts: 'Failed merge attempts (lane mergeAttemptCount − 1)',
    ejections: 'Lane ejections (wm:merging not ending in merge)',
    rebases: 'Post-ready rebases (lane rebaseCount)',
    ciRestarts: 'CI restarts (lane ciRestartCount)',
    blockedAfterReady: 'wm:blocked after first wm:ready',
    conflictResolutionLaunches: 'Conflict-resolution launches',
    readyRemediationLaunches: 'Ready-remediation launches',
    ciFixLaunches: 'CI-fix launches',
  };
  for (const [key, stats] of Object.entries(summary.integrationFailures)) {
    lines.push(statsRow(failureLabels[key] ?? key, stats, count, ` ${stats.tasksWithAny} |`));
  }
  lines.push('', 'Classification of causes is MQ-0.2.', '');

  lines.push('## Review loop', '');
  lines.push('| Metric | n | Mean | Median | p90 | Max |', '|---|---|---|---|---|---|');
  lines.push(statsRow('Review rounds', summary.review.rounds, count));
  lines.push(statsRow('Review stage launches', summary.review.reviewLaunches, count));
  lines.push(statsRow('Recode rounds (coding launches − 1)', summary.review.recodeRounds, count));
  const f = summary.review.findings;
  const resolvable = f.onChangedFiles + f.onUnchangedFiles;
  lines.push(
    '',
    f.total > 0
      ? `Findings (${f.tasks} task(s) with reviewIterations): ${f.total}; on changed files ${pct(resolvable > 0 ? f.onChangedFiles / resolvable : null)}, on unchanged files (pre-existing) ${pct(resolvable > 0 ? f.onUnchangedFiles / resolvable : null)}, unresolvable ${f.unresolvable}. File-level attribution only.`
      : 'Findings on pre-existing vs new code: **not recoverable** for this window (no archived reviewIterations with findings) — see Known gaps.',
    '',
  );

  lines.push('## CI', '');
  lines.push(`Pass rate on merged PRs' evaluated head: ${pct(summary.ci.passRate)} (n=${summary.ci.passRateN}). Compute minutes per task: mean ${count(summary.ci.computeMinutes.mean)}, median ${count(summary.ci.computeMinutes.median)}, p90 ${count(summary.ci.computeMinutes.p90)}.`, '');

  lines.push('## Decision thresholds', '');
  lines.push('```json', JSON.stringify(DECISION_THRESHOLDS, null, 2), '```', '');

  lines.push('## Known gaps', '');
  for (const gap of knownGaps(summary)) lines.push(`- ${gap}`);
  lines.push('');
  return lines.join('\n');
}

/** Machine-readable summary (stable key order for re-run determinism). */
export function formatBaselineSummaryJson(summary: BaselineSummary): string {
  return `${JSON.stringify(summary, null, 2)}\n`;
}

/** One JSON line per task. */
export function formatPerTaskJsonl(rows: BaselineTaskRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}
