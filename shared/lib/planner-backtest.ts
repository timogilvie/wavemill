/**
 * Backtest the grounded wave planner (HOK-3131, HOK-3307).
 *
 * Ground truth comes from history: for every pair of merged PRs whose work
 * windows overlapped (they ran concurrently), did their diffs touch a common
 * file? A planner "predicts a conflict" for a pair when it would have kept the
 * two apart (any edge between them). The planner sees only the issue text,
 * never the PR diff.
 *
 * Planners reported:
 * - `grounded`      — explicit relations + non-`independent-order` grounded verdicts
 *                     + deterministic file conflicts (HOK-3304).
 * - `deterministic` — explicit relations + any grounded pair score > 0 (no LLM judge),
 *                     reported to show what the judge adds.
 *
 * Pure helpers (pairing, ground truth, metrics, report rendering) are separated
 * from the I/O in {@link runPlannerBacktest}, whose data sources are injected.
 */

import { compareTaskIds, DEFAULT_LOW_CONFLICT_FILES, type PairScore } from './conflict-scorer.ts';
import type { GroundedPlanResult, GroundedTask, GroundedVerdict } from './grounded-planner.ts';
import { execArgvCommand } from './shell-utils.ts';

export interface BacktestPr {
  number: number;
  title: string;
  body?: string;
  headRefName?: string;
  /** Earliest commit time on the branch (fallback: PR creation). ISO. */
  startedAt: string;
  mergedAt: string;
  files: string[];
}

export interface BacktestIssue {
  id: string;
  title: string;
  description: string;
  priority?: number | null;
  /** Issues this one blocks / is blocked by, regardless of completion state. */
  blocks: string[];
  dependsOn: string[];
}

export interface BacktestTask extends BacktestIssue {
  pr: number;
  startedAt: string;
  mergedAt: string;
  files: string[];
}

export interface PairOutcome {
  a: string;
  b: string;
  prA: number;
  prB: number;
  /** Conflict-relevant files both PRs modified. */
  truthFiles: string[];
  truth: boolean;
  explicit: boolean;
  grounded: boolean;
  groundedVerdict?: GroundedVerdict['verdict'];
  groundedEvidence?: string;
  /** Files the scorer used for a deterministic conflict (HOK-3304), when one fired. */
  deterministicFiles?: string[];
  deterministic: boolean;
  score: number;
}

export interface ConfusionMetrics {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  accuracy: number | null;
}

/**
 * Linear issue ID for a PR: the title first (`HOK-3130: …`), then the body.
 * Returns null when the PR is not tied to an issue (promotions, hotfixes).
 */
export function extractIssueId(pr: Pick<BacktestPr, 'title' | 'body'>, prefix = 'HOK'): string | null {
  const scoped = new RegExp(`\\b(${prefix}-\\d+)\\b`);
  return pr.title.match(scoped)?.[1] ?? (pr.body ?? '').slice(0, 4000).match(scoped)?.[1] ?? null;
}

function windowsOverlap(a: { startedAt: string; mergedAt: string }, b: { startedAt: string; mergedAt: string }): boolean {
  return Date.parse(a.startedAt) < Date.parse(b.mergedAt) && Date.parse(b.startedAt) < Date.parse(a.mergedAt);
}

/** Unordered pairs of tasks whose work windows overlapped. Pure. */
export function findConcurrentPairs(tasks: BacktestTask[]): Array<[BacktestTask, BacktestTask]> {
  const sorted = [...tasks].sort((x, y) => compareTaskIds(x.id, y.id));
  const pairs: Array<[BacktestTask, BacktestTask]> = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (windowsOverlap(sorted[i], sorted[j])) pairs.push([sorted[i], sorted[j]]);
    }
  }
  return pairs;
}

/** Files both PRs changed, excluding append-mostly registries. Pure. */
export function groundTruthOverlap(filesA: string[], filesB: string[], lowConflict: Iterable<string> = DEFAULT_LOW_CONFLICT_FILES): string[] {
  const ignore = new Set(lowConflict);
  const setB = new Set(filesB);
  return [...new Set(filesA)].filter((file) => setB.has(file) && !ignore.has(file)).sort();
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Confusion matrix and derived metrics for one planner. Pure. */
export function computeMetrics(outcomes: PairOutcome[], key: 'grounded' | 'deterministic' | 'explicit'): ConfusionMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const outcome of outcomes) {
    const predicted = outcome[key];
    if (predicted && outcome.truth) tp++;
    else if (predicted) fp++;
    else if (outcome.truth) fn++;
    else tn++;
  }
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 = precision === null || recall === null || precision + recall === 0 ? null : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, tn, precision, recall, f1, accuracy: ratio(tp + tn, outcomes.length) };
}

function linked(a: BacktestIssue, b: BacktestIssue): boolean {
  return a.blocks.includes(b.id) || a.dependsOn.includes(b.id) || b.blocks.includes(a.id) || b.dependsOn.includes(a.id);
}

/**
 * Combine ground truth with the grounded planner's output into per-pair outcomes. Pure.
 *
 * @param grounded - Result of `runGroundedPlanning` over the same tasks.
 * @param opts.judged - False when no ordering judge ran (deterministic-only backtest).
 */
export function evaluatePairs(
  pairs: Array<[BacktestTask, BacktestTask]>,
  grounded: Pick<GroundedPlanResult, 'verdicts' | 'scores' | 'deterministicConflicts'>,
  opts: { judged?: boolean } = {},
): PairOutcome[] {
  // Without an ordering judge the grounded planner's prediction is its score.
  const judged = opts.judged ?? true;
  const key = (x: string, y: string) => (compareTaskIds(x, y) <= 0 ? `${x}\u0000${y}` : `${y}\u0000${x}`);
  const verdictByPair = new Map(grounded.verdicts.map((verdict) => [key(verdict.a, verdict.b), verdict]));
  const scoreByPair = new Map<string, PairScore>(grounded.scores.map((score) => [key(score.taskA, score.taskB), score]));
  // HOK-3304: deterministic conflicts carry their own files; the judge never saw those pairs.
  const deterministicByPair = new Map(
    (grounded.deterministicConflicts ?? []).map((conflict) => [key(conflict.a, conflict.b), conflict.files]),
  );

  return pairs.map(([a, b]) => {
    const truthFiles = groundTruthOverlap(a.files, b.files);
    const explicit = linked(a, b);
    const verdict = verdictByPair.get(key(a.id, b.id));
    const score = scoreByPair.get(key(a.id, b.id))?.score ?? 0;
    const deterministicFiles = deterministicByPair.get(key(a.id, b.id));
    const groundedConflict =
      (verdict !== undefined && verdict.verdict !== 'independent-order') || (deterministicFiles?.length ?? 0) > 0;
    return {
      a: a.id,
      b: b.id,
      prA: a.pr,
      prB: b.pr,
      truthFiles,
      truth: truthFiles.length > 0,
      explicit,
      grounded: explicit || (judged ? groundedConflict : score > 0),
      ...(verdict ? { groundedVerdict: verdict.verdict } : {}),
      ...(verdict?.evidence ? { groundedEvidence: verdict.evidence } : {}),
      ...(deterministicFiles && deterministicFiles.length > 0 ? { deterministicFiles } : {}),
      deterministic: explicit || score > 0,
      score,
    };
  });
}

export interface BacktestReportInput {
  generatedAt: string;
  repo: string;
  prsFetched: number;
  tasks: BacktestTask[];
  outcomes: PairOutcome[];
  groundedMode: 'llm' | 'deterministic-only';
  probeRef: string | null;
  notes?: string[];
  stats?: GroundedPlanResult['stats'];
}

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function mark(predicted: boolean, truth: boolean): string {
  return predicted === truth ? '✓' : '✗';
}

/** Render the committed markdown report. Pure. */
export function renderBacktestReport(input: BacktestReportInput): string {
  const { outcomes } = input;
  const planners = [
    ['Grounded', computeMetrics(outcomes, 'grounded')],
    ['Grounded (deterministic only)', computeMetrics(outcomes, 'deterministic')],
    ['Explicit relations only', computeMetrics(outcomes, 'explicit')],
  ] as const;
  const shown = outcomes.filter((o) => o.truth || o.grounded);
  const hiddenTrueNegatives = outcomes.length - shown.length;
  const correctness = (o: PairOutcome) => (o.grounded === o.truth ? 'correct' : 'incorrect');

  const lines = [
    '# Backtest: Grounded Planner',
    '',
    `Generated by \`npx tsx tools/backtest-planner.ts\` (HOK-3131) on ${input.generatedAt}.`,
    '',
    `- Repository: \`${input.repo}\``,
    `- Merged PRs fetched: ${input.prsFetched}; PRs tied to a Linear issue: ${input.tasks.length}`,
    `- Concurrent task pairs (work windows overlapped): ${outcomes.length}`,
    `- Pairs whose diffs actually overlapped (ground truth): ${outcomes.filter((o) => o.truth).length}`,
    `- Grounded planner: ${input.groundedMode === 'llm' ? 'touch sets + conflict scoring + evidence-required ordering judge' : 'touch sets + conflict scoring (no LLM judge)'}`,
    `- Touch sets resolved against: ${input.probeRef ? `\`${input.probeRef}\` (repository state before the earliest task started)` : 'the current working tree'}`,
    ...(input.stats
      ? [`- Grounded run: ${input.stats.pairsScored} pairs scored, ${input.stats.pairsSentToLlm} judged by the LLM, ${input.stats.llmCallMs} ms in LLM calls`]
      : []),
    '',
    '## Method',
    '',
    'A pair of tasks is *concurrent* when their PR work windows (first branch commit → merge) overlapped.',
    'Ground truth is positive when both merged diffs modified at least one common file, ignoring append-only registries',
    `(${DEFAULT_LOW_CONFLICT_FILES.map((file) => `\`${file}\``).join(', ')}).`,
    'A planner predicts a conflict when it would have kept the pair apart (any dependency or shared-surface edge, or an explicit Linear relation).',
    'The planner only sees the Linear issue text, never the PR diff.',
    '',
    '## Results',
    '',
    '| Planner | TP | FP | FN | TN | Precision | Recall | F1 | Accuracy |',
    '|---------|----|----|----|----|-----------|--------|----|----------|',
    ...planners.map(([name, m]) => `| ${name} | ${m.tp} | ${m.fp} | ${m.fn} | ${m.tn} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} | ${pct(m.accuracy)} |`),
    '',
    ...(input.notes && input.notes.length > 0 ? ['## Notes', '', ...input.notes.map((note) => `- ${note}`), ''] : []),
    '## Detail',
    '',
    `Pairs where ground truth or the grounded planner is positive (${shown.length}); ${hiddenTrueNegatives} pairs that the planner and the ground truth call independent are omitted.`,
    '',
    '| Task Pair | PRs | Ground Truth Overlap | Grounded Prediction | Correct |',
    '|-----------|-----|----------------------|---------------------|---------|',
    ...shown
      .sort((x, y) => Number(y.truth) - Number(x.truth) || compareTaskIds(x.a, y.a) || compareTaskIds(x.b, y.b))
      .map((o) => {
        const truth = o.truth ? `yes: ${o.truthFiles.slice(0, 3).map((f) => `\`${f}\``).join(', ')}${o.truthFiles.length > 3 ? ` +${o.truthFiles.length - 3}` : ''}` : 'no';
        // HOK-3304: a deterministic conflict renders with its files; an ordering verdict may sit on top.
        const conflictPart = o.deterministicFiles?.length ? `shared_surface: ${o.deterministicFiles.map((file) => `\`${cell(file)}\``).join(', ')}` : '';
        const verdictPart = o.groundedVerdict ? `${o.groundedVerdict}${o.groundedEvidence ? `: ${cell(o.groundedEvidence)}` : ''}` : '';
        const prediction = o.explicit && !conflictPart && !verdictPart ? 'explicit' : [conflictPart, verdictPart].filter(Boolean).join(' + ') || 'independent-order';
        const grounded = `${mark(o.grounded, o.truth)} ${prediction}${o.score > 0 ? ` (score ${o.score})` : ''}`;
        return `| ${o.a} / ${o.b} | #${o.prA} / #${o.prB} | ${truth} | ${grounded} | ${correctness(o)} |`;
      }),
    '',
  ];
  return lines.join('\n');
}

export interface PlannerBacktestDeps {
  /** Most recent merged PRs (newest first). */
  fetchMergedPrs: (limit: number) => Promise<BacktestPr[]>;
  /** Linear issue text; reject or return null when unavailable. */
  fetchIssue: (id: string) => Promise<BacktestIssue | null>;
  /** Grounded planner over all tasks (caller wires probe/LLM/caching). */
  groundedPlan: (
    tasks: GroundedTask[],
    ctx: { earliestStart: string; isConcurrent: (taskA: string, taskB: string) => boolean },
  ) => Promise<GroundedPlanResult>;
  /** False when the grounded planner runs without its LLM judge. */
  judged?: boolean;
  /** Task fingerprint (`computeTaskFingerprint`). */
  fingerprint: (task: BacktestTask) => string;
  log?: (message: string) => void;
}

export interface PlannerBacktestResult {
  prsFetched: number;
  tasks: BacktestTask[];
  outcomes: PairOutcome[];
  grounded: GroundedPlanResult;
  notes: string[];
}

/**
 * Fetch history, run both planners, and score them. Planner failures are
 * recorded as notes (and count as "no edges") rather than aborting the run.
 */
export async function runPlannerBacktest(limit: number, deps: PlannerBacktestDeps): Promise<PlannerBacktestResult> {
  const log = deps.log ?? (() => {});
  const notes: string[] = [];
  const prs = await deps.fetchMergedPrs(limit);
  log(`fetched ${prs.length} merged PRs`);

  // One task per issue: challenge arms and follow-ups share an issue ID; keep the earliest merge.
  const byIssue = new Map<string, BacktestPr>();
  for (const pr of [...prs].sort((x, y) => Date.parse(x.mergedAt) - Date.parse(y.mergedAt))) {
    const id = extractIssueId(pr);
    if (id && !byIssue.has(id)) byIssue.set(id, pr);
  }

  const tasks: BacktestTask[] = [];
  let missingIssues = 0;
  for (const [id, pr] of byIssue) {
    let issue: BacktestIssue | null = null;
    try {
      issue = await deps.fetchIssue(id);
    } catch (error) {
      log(`skipping ${id}: ${(error as Error).message}`);
    }
    if (!issue) {
      missingIssues++;
      continue;
    }
    tasks.push({ ...issue, pr: pr.number, startedAt: pr.startedAt, mergedAt: pr.mergedAt, files: pr.files });
  }
  if (missingIssues > 0) notes.push(`${missingIssues} PR(s) skipped because their Linear issue could not be fetched.`);
  tasks.sort((x, y) => compareTaskIds(x.id, y.id));
  log(`${tasks.length} tasks with issue text`);

  const pairs = findConcurrentPairs(tasks);
  const concurrent = new Set(pairs.map(([x, y]) => (x.id < y.id ? `${x.id}\u0000${y.id}` : `${y.id}\u0000${x.id}`)));
  log(`${pairs.length} concurrent pairs`);

  const earliestStart = tasks.reduce((min, task) => (task.startedAt < min ? task.startedAt : min), tasks[0]?.startedAt ?? new Date().toISOString());
  const grounded = await deps.groundedPlan(
    tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      priority: task.priority ?? null,
      blocks: task.blocks,
      dependsOn: task.dependsOn,
      fingerprint: deps.fingerprint(task),
    })),
    { earliestStart, isConcurrent: (x, y) => concurrent.has(x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`) },
  );
  if (!grounded.llm.orderingOk) {
    notes.push(`Grounded ordering judge failed for some pairs (${(grounded.llm.error ?? 'unknown error').split('\n')[0]}); those pairs count as independent.`);
  }

  return { prsFetched: prs.length, tasks, outcomes: evaluatePairs(pairs, grounded, { judged: deps.judged ?? true }), grounded, notes };
}

// ---------------------------------------------------------------------------
// Production data sources (impure)
// ---------------------------------------------------------------------------

/**
 * Parse `gh pr list --json number,title,body,headRefName,createdAt,mergedAt,files,commits`.
 * The work window starts at the earliest commit on the branch. Pure.
 */
export function parseGhPrList(raw: string): BacktestPr[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('gh pr list output must be a JSON array');
  const prs: BacktestPr[] = [];
  for (const item of parsed as Array<Record<string, unknown>>) {
    if (typeof item?.number !== 'number' || typeof item.title !== 'string' || typeof item.mergedAt !== 'string') continue;
    const commitTimes = (Array.isArray(item.commits) ? item.commits : [])
      .map((commit: { authoredDate?: unknown; committedDate?: unknown }) => commit?.authoredDate ?? commit?.committedDate)
      .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
      .sort();
    const createdAt = typeof item.createdAt === 'string' ? item.createdAt : item.mergedAt;
    prs.push({
      number: item.number,
      title: item.title,
      ...(typeof item.body === 'string' ? { body: item.body } : {}),
      ...(typeof item.headRefName === 'string' ? { headRefName: item.headRefName } : {}),
      startedAt: commitTimes[0] && commitTimes[0] < createdAt ? commitTimes[0] : createdAt,
      mergedAt: item.mergedAt,
      files: (Array.isArray(item.files) ? item.files : [])
        .map((file: { path?: unknown }) => file?.path)
        .filter((path): path is string => typeof path === 'string'),
    });
  }
  return prs;
}

function gh(repoDir: string, args: string[]): string {
  const result = execArgvCommand('gh', args, { cwd: repoDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.exitCode !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  return result.stdout;
}

/**
 * Fetch merged PRs into `base` with `gh`. The list call stays light (asking
 * for `commits` across many PRs exceeds GitHub's GraphQL node budget); files
 * and commits are fetched per PR, only for PRs tied to an issue.
 */
export function fetchMergedPrsWithGh(repoDir: string, base: string, limit: number): BacktestPr[] {
  const listed = parseGhPrList(gh(repoDir, [
    'pr', 'list', '--state', 'merged', '--base', base, '--limit', String(limit),
    '--json', 'number,title,body,headRefName,createdAt,mergedAt',
  ]));
  return listed.map((pr) => {
    if (!extractIssueId(pr)) return pr;
    const [detail] = parseGhPrList(`[${gh(repoDir, ['pr', 'view', String(pr.number), '--json', 'number,title,createdAt,mergedAt,files,commits'])}]`);
    return detail ? { ...pr, startedAt: detail.startedAt, files: detail.files } : pr;
  });
}

/** Latest commit on `branch` at or before `iso` (the repo state when the backtest window opened). */
export function commitBefore(repoDir: string, branch: string, iso: string): string | null {
  const result = execArgvCommand('git', ['rev-list', '-1', `--before=${iso}`, branch], {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sha = result.stdout.trim();
  return result.exitCode === 0 && /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

/** Linear issue text and relations (completed relations included: they were open at launch). */
export async function fetchIssueFromLinear(id: string): Promise<BacktestIssue | null> {
  const { getIssue } = await import('./linear.ts');
  const issue = await getIssue(id);
  if (!issue) return null;
  return {
    id: issue.identifier,
    title: issue.title,
    description: issue.description ?? '',
    priority: issue.priority ?? null,
    blocks: (issue.relations?.nodes ?? [])
      .filter((relation) => relation.type === 'blocks' && relation.relatedIssue?.identifier)
      .map((relation) => relation.relatedIssue!.identifier),
    dependsOn: (issue.inverseRelations?.nodes ?? [])
      .filter((relation) => relation.type === 'blocks' && relation.issue?.identifier)
      .map((relation) => relation.issue!.identifier),
  };
}

