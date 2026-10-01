/**
 * Deterministic pairwise conflict scoring for grounded wave planning (HOK-3131).
 *
 * Given each task's predicted touch set ({@link TouchSet}), score every
 * unordered pair of tasks from 0 (independent) to 1 (certain conflict) and
 * record *why* as {@link ConflictSignal}s. Only pairs with a non-zero score are
 * shown to the LLM ordering judge, so this module is what keeps the LLM call
 * small and grounded.
 *
 * Signals:
 * - `file_overlap`      — both touch sets contain the same file.
 * - `hot_file`          — an overlapping file is a known merge-conflict hotspot.
 * - `region_overlap`    — both tasks name the same symbol inside an overlapping hot file.
 * - `disjoint_regions`  — both tasks name symbols in an overlapping hot file, but different ones
 *                         (the file contributes half weight).
 * - `co_change`         — no shared file, but their files are historically co-modified.
 * - `series`            — titles mark the same "n/m" series (`3/5`, `5/5`).
 * - `cross_reference`   — one task's text names the other's ID ("builds on HOK-3120").
 * - `sweep`             — a repo-wide sweep task ("migrate all …") overlaps the other task.
 * - `explicit_dependency` — Linear already links the pair (`blocks` / `dependsOn`).
 *
 * Everything here is pure: repository history arrives as a prebuilt
 * {@link CoChangeIndex} (see {@link buildCoChangeIndex}).
 */

import type { TouchSet } from './touch-set-predictor.ts';

export type ConflictSignal =
  | 'file_overlap'
  | 'hot_file'
  | 'region_overlap'
  | 'disjoint_regions'
  | 'co_change'
  | 'series'
  | 'cross_reference'
  | 'sweep'
  | 'explicit_dependency';

export interface ScorableTask {
  id: string;
  title?: unknown;
  description?: unknown;
  dependsOn?: string[];
  blocks?: string[];
}

/** Deterministic ordering hint attached to a pair (series index, "builds on" phrasing). */
export interface OrderingHint {
  before: string;
  after: string;
  reason: string;
}

export interface PairScore {
  /** Lower task ID of the pair (numeric-aware). */
  taskA: string;
  taskB: string;
  /** 0.0 (independent) to 1.0 (certain conflict), rounded to 3 decimals. */
  score: number;
  signals: ConflictSignal[];
  /** Conflict-relevant files present in both touch sets (low-conflict files excluded). */
  overlappingFiles: string[];
  /** Strongest historically co-changed file pair, when `co_change` fired. */
  coChangedFiles?: [string, string];
  hint?: OrderingHint;
}

/** File co-modification statistics mined from git history. */
export interface CoChangeIndex {
  /** Key: `${fileA}\0${fileB}` with fileA < fileB. Value: strength 0..1. */
  strength: Map<string, number>;
  /** Files most frequently modified in the history window. */
  hotFiles: Set<string>;
}

export interface ScoreOptions {
  coChange?: CoChangeIndex | null;
  /** Hot files in addition to `coChange.hotFiles` and {@link DEFAULT_HOT_FILES}. */
  hotFiles?: Iterable<string>;
  /**
   * Append-mostly registries that nearly every task touches. They stay in the
   * touch set but never count as overlap. Defaults to {@link DEFAULT_LOW_CONFLICT_FILES}.
   */
  lowConflictFiles?: Iterable<string>;
  /** A touch set larger than this marks the task as a sweep. */
  sweepFileThreshold?: number;
}

/** Files known to be merge-conflict hotspots regardless of recent history. */
export const DEFAULT_HOT_FILES: readonly string[] = [
  'shared/lib/wavemill-monitor.sh',
  'shared/lib/wavemill-common.sh',
  'shared/lib/agent-adapters.sh',
  'shared/lib/config.ts',
  'wavemill-config.schema.json',
];

/**
 * Registries where concurrent edits are one-line appends that rebase cleanly
 * (test registration arrays, prompt registry, auto-updated context).
 */
export const DEFAULT_LOW_CONFLICT_FILES: readonly string[] = [
  'tests/run-unit-tests.sh',
  'tests/run-shell-suite.sh',
  'tests/run-custom-tests.sh',
  'tests/check-shell.sh',
  'tests/ci-test-weights.json',
  'docs/prompt-locations.md',
  '.wavemill/project-context.md',
  'CLAUDE.md',
];

export const DEFAULT_SWEEP_FILE_THRESHOLD = 10;
/** Minimum co-change strength for the `co_change` signal. */
export const CO_CHANGE_MIN_STRENGTH = 0.5;

const WEIGHT = {
  disjointRegionFile: 0.5,
  coChange: 0.25,
  series: 0.5,
  crossReference: 0.4,
  sweep: 0.3,
};

const SWEEP_PATTERN =
  /\b(?:migrate|update|rename|replace|convert|remove|delete|refactor|rewrite|move)\s+(?:all|every|each)\b|\bacross\s+(?:the\s+)?(?:codebase|repo(?:sitory)?|all\b)|\bcodemod\b|\b(?:repo|codebase)-wide\b|\bsweep\b/i;

const SERIES_PATTERN = /(?:\(|\[|\b)(\d{1,2})\s*\/\s*(\d{1,2})(?:\)|\]|\b)|\bpart\s+(\d{1,2})\s+of\s+(\d{1,2})\b/i;

const BEFORE_PHRASES = /(?:builds?\s+on|built\s+on|on\s+top\s+of|after|follow(?:s|-up\s+(?:to|of)|\s*up\s+(?:to|of)|ing)?|depends?\s+on|requires?|extends?|once|continu(?:es|ation\s+of)|blocked\s+by|needs?)\b[^.\n]{0,40}$/i;
const AFTER_PHRASES = /(?:before|blocks?|prerequisite\s+(?:for|of)|unblocks?|precedes?)\b[^.\n]{0,40}$/i;

export const compareTaskIds = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function coChangeKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

export interface SeriesInfo {
  /** Normalized title with the n/m marker removed; tasks with the same total and similar keys are one series. */
  key: string;
  index: number;
  total: number;
}

/** Detect an "n/m" or "part n of m" series marker in a title. Pure. */
export function detectSeries(title: string): SeriesInfo | null {
  const match = title.match(SERIES_PATTERN);
  if (!match) return null;
  const index = Number(match[1] ?? match[3]);
  const total = Number(match[2] ?? match[4]);
  if (!Number.isInteger(index) || !Number.isInteger(total) || total < 2 || index < 1 || index > total) return null;
  const prefix = title.slice(0, match.index ?? 0);
  const key = prefix.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return { key, index, total };
}

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(SERIES_PATTERN, ' ')
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2),
  );
}

/**
 * Two titles are in the same series when both carry a marker with the same
 * total and either share the text before the marker or share enough words.
 */
export function sameSeries(titleA: string, titleB: string): { a: SeriesInfo; b: SeriesInfo } | null {
  const a = detectSeries(titleA);
  const b = detectSeries(titleB);
  if (!a || !b || a.total !== b.total || a.index === b.index) return null;
  if (a.key.length > 0 && a.key === b.key) return { a, b };
  const tokensA = titleTokens(titleA);
  const tokensB = titleTokens(titleB);
  const shared = [...tokensA].filter((token) => tokensB.has(token)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return union > 0 && shared / union >= 0.2 ? { a, b } : null;
}

/** A sweep task edits many files mechanically ("migrate all …", huge touch set). */
export function isSweepTask(task: ScorableTask, touchSet: TouchSet | undefined, threshold = DEFAULT_SWEEP_FILE_THRESHOLD): boolean {
  if (SWEEP_PATTERN.test(text(task.title)) || SWEEP_PATTERN.test(text(task.description).slice(0, 600))) return true;
  return (touchSet?.entries.length ?? 0) > threshold;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detect `other`'s ID in `task`'s text and infer a direction from the phrase
 * just before it ("builds on HOK-1" → HOK-1 first; "before HOK-1" → task first).
 * Returns `{ mentioned: false }` when the ID does not appear.
 */
export function findCrossReference(task: ScorableTask, otherId: string): { mentioned: boolean; hint?: OrderingHint } {
  const body = `${text(task.title)}\n${text(task.description)}`;
  const idPattern = new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(otherId)}(?![0-9])`, 'g');
  let mentioned = false;
  for (const match of body.matchAll(idPattern)) {
    mentioned = true;
    const lead = body.slice(Math.max(0, (match.index ?? 0) - 60), match.index ?? 0);
    if (BEFORE_PHRASES.test(lead)) {
      return { mentioned, hint: { before: otherId, after: task.id, reason: `${task.id} text: "${lead.trim().slice(-40)} ${otherId}"` } };
    }
    if (AFTER_PHRASES.test(lead)) {
      return { mentioned, hint: { before: task.id, after: otherId, reason: `${task.id} text: "${lead.trim().slice(-40)} ${otherId}"` } };
    }
  }
  return { mentioned };
}

interface ResolvedOptions {
  coChange: CoChangeIndex | null;
  hotFiles: Set<string>;
  lowConflict: Set<string>;
  sweepFileThreshold: number;
}

function resolveOptions(opts: ScoreOptions = {}): ResolvedOptions {
  return {
    coChange: opts.coChange ?? null,
    hotFiles: new Set([...DEFAULT_HOT_FILES, ...(opts.coChange?.hotFiles ?? []), ...(opts.hotFiles ?? [])]),
    lowConflict: new Set(opts.lowConflictFiles ?? DEFAULT_LOW_CONFLICT_FILES),
    sweepFileThreshold: opts.sweepFileThreshold ?? DEFAULT_SWEEP_FILE_THRESHOLD,
  };
}

function explicitlyLinked(a: ScorableTask, b: ScorableTask): boolean {
  return Boolean(
    a.dependsOn?.includes(b.id) || b.dependsOn?.includes(a.id) || a.blocks?.includes(b.id) || b.blocks?.includes(a.id),
  );
}

function scoreOne(
  taskA: ScorableTask,
  taskB: ScorableTask,
  touchA: TouchSet | undefined,
  touchB: TouchSet | undefined,
  opts: ResolvedOptions,
): PairScore {
  const signals = new Set<ConflictSignal>();
  let score = 0;
  let hint: OrderingHint | undefined;

  const entriesA = (touchA?.entries ?? []).filter((entry) => !opts.lowConflict.has(entry.path));
  const entriesB = (touchB?.entries ?? []).filter((entry) => !opts.lowConflict.has(entry.path));
  const byPathB = new Map(entriesB.map((entry) => [entry.path, entry]));
  const overlappingFiles: string[] = [];
  let overlapWeight = 0;

  for (const entryA of entriesA) {
    const entryB = byPathB.get(entryA.path);
    if (!entryB) continue;
    overlappingFiles.push(entryA.path);
    signals.add('file_overlap');
    let weight = 1;
    if (opts.hotFiles.has(entryA.path)) {
      signals.add('hot_file');
      const symbolsA = entryA.symbols ?? [];
      const symbolsB = new Set(entryB.symbols ?? []);
      if (symbolsA.length > 0 && symbolsB.size > 0) {
        if (symbolsA.some((symbol) => symbolsB.has(symbol))) {
          signals.add('region_overlap');
        } else {
          signals.add('disjoint_regions');
          weight = WEIGHT.disjointRegionFile;
        }
      }
    }
    overlapWeight += weight;
  }
  overlappingFiles.sort();

  if (overlappingFiles.length > 0) {
    score += overlapWeight / Math.min(entriesA.length, entriesB.length);
  }

  let coChangedFiles: [string, string] | undefined;
  if (overlappingFiles.length === 0 && opts.coChange && entriesA.length > 0 && entriesB.length > 0) {
    let best = 0;
    for (const entryA of entriesA) {
      for (const entryB of entriesB) {
        const strength = opts.coChange.strength.get(coChangeKey(entryA.path, entryB.path)) ?? 0;
        if (strength > best) {
          best = strength;
          coChangedFiles = [entryA.path, entryB.path];
        }
      }
    }
    if (best >= CO_CHANGE_MIN_STRENGTH) {
      signals.add('co_change');
      score += WEIGHT.coChange * best;
    } else {
      coChangedFiles = undefined;
    }
  }

  const series = sameSeries(text(taskA.title), text(taskB.title));
  if (series) {
    signals.add('series');
    score += WEIGHT.series;
    const [first, second] = series.a.index < series.b.index ? [taskA, taskB] : [taskB, taskA];
    const [firstInfo, secondInfo] = series.a.index < series.b.index ? [series.a, series.b] : [series.b, series.a];
    hint = {
      before: first.id,
      after: second.id,
      reason: `series ${firstInfo.index}/${firstInfo.total} before ${secondInfo.index}/${secondInfo.total}`,
    };
  }

  const refBA = findCrossReference(taskB, taskA.id);
  const refAB = findCrossReference(taskA, taskB.id);
  if (refAB.mentioned || refBA.mentioned) {
    signals.add('cross_reference');
    score += WEIGHT.crossReference;
    hint = refBA.hint ?? refAB.hint ?? hint;
  }

  const touchesOther = overlappingFiles.length > 0 || signals.has('co_change');
  if (touchesOther && (isSweepTask(taskA, touchA, opts.sweepFileThreshold) || isSweepTask(taskB, touchB, opts.sweepFileThreshold))) {
    signals.add('sweep');
    score += WEIGHT.sweep;
  }

  if (explicitlyLinked(taskA, taskB)) {
    signals.add('explicit_dependency');
    score = 1;
  }

  return {
    taskA: taskA.id,
    taskB: taskB.id,
    score: round(Math.min(1, score)),
    signals: [...signals],
    overlappingFiles,
    ...(coChangedFiles ? { coChangedFiles } : {}),
    ...(hint ? { hint } : {}),
  };
}

/**
 * Score a single pair. Pure. The pair is normalized so `taskA` has the lower ID.
 */
export function scorePair(
  a: ScorableTask,
  b: ScorableTask,
  touchA: TouchSet | undefined,
  touchB: TouchSet | undefined,
  opts?: ScoreOptions,
): PairScore {
  const [first, second, firstTouch, secondTouch] = compareTaskIds(a.id, b.id) <= 0 ? [a, b, touchA, touchB] : [b, a, touchB, touchA];
  return scoreOne(first, second, firstTouch, secondTouch, resolveOptions(opts));
}

/**
 * Score every unordered pair and return those with a non-zero score, sorted
 * by score (desc) then task IDs. Pure; O(n² · |touch set|).
 */
export function scorePairConflicts(tasks: ScorableTask[], touchSets: TouchSet[], opts?: ScoreOptions): PairScore[] {
  const resolved = resolveOptions(opts);
  const touchById = new Map(touchSets.map((set) => [set.taskId, set]));
  const sorted = [...tasks].sort((a, b) => compareTaskIds(a.id, b.id));
  const scores: PairScore[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const pair = scoreOne(sorted[i], sorted[j], touchById.get(sorted[i].id), touchById.get(sorted[j].id), resolved);
      if (pair.score > 0) scores.push(pair);
    }
  }
  return scores.sort((a, b) => b.score - a.score || compareTaskIds(a.taskA, b.taskA) || compareTaskIds(a.taskB, b.taskB));
}

export interface CoChangeIndexOptions {
  /** Ignore commits touching more files than this (merges, sweeps, renames). */
  maxFilesPerCommit?: number;
  /** Minimum number of shared commits before a pair counts. */
  minSupport?: number;
  /** Number of most-modified files to mark hot. */
  hotFileCount?: number;
  /** Minimum commit count for a hot file. */
  minHotCommits?: number;
  /** Files never counted (e.g. {@link DEFAULT_LOW_CONFLICT_FILES}). */
  ignore?: Iterable<string>;
}

/**
 * Build a {@link CoChangeIndex} from per-commit file lists (newest first or
 * any order). Strength of (f, g) = shared commits / min(commits(f), commits(g)).
 * Pure.
 */
export function buildCoChangeIndex(commits: string[][], opts: CoChangeIndexOptions = {}): CoChangeIndex {
  const maxFiles = opts.maxFilesPerCommit ?? 25;
  const minSupport = opts.minSupport ?? 3;
  const hotFileCount = opts.hotFileCount ?? 10;
  const minHotCommits = opts.minHotCommits ?? 8;
  const ignore = new Set(opts.ignore ?? DEFAULT_LOW_CONFLICT_FILES);

  const fileCounts = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  for (const commit of commits) {
    const files = [...new Set(commit)].filter((file) => file.length > 0 && !ignore.has(file)).sort();
    if (files.length === 0) continue;
    for (const file of files) fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
    if (files.length > maxFiles) continue;
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = coChangeKey(files[i], files[j]);
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const strength = new Map<string, number>();
  for (const [key, count] of pairCounts) {
    if (count < minSupport) continue;
    const [a, b] = key.split('\u0000');
    const denominator = Math.min(fileCounts.get(a) ?? count, fileCounts.get(b) ?? count);
    strength.set(key, round(count / denominator));
  }

  const hotFiles = new Set(
    [...fileCounts.entries()]
      .filter(([, count]) => count >= minHotCommits)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, hotFileCount)
      .map(([file]) => file),
  );

  return { strength, hotFiles };
}

/** Parse `git log --name-only --format=%x00` output into per-commit file lists. Pure. */
export function parseGitLogNameOnly(output: string): string[][] {
  return output
    .split('\u0000')
    .map((chunk) => chunk.split('\n').map((line) => line.trim()).filter(Boolean))
    .filter((files) => files.length > 0);
}
