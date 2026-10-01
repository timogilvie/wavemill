/**
 * Grounded wave planner (HOK-3131).
 *
 * Replaces "ask the LLM to classify the whole backlog" with three layers:
 *
 * 1. {@link predictTouchSets} — which files will each task modify? (deterministic
 *    first, one batched LLM call only for vague tasks)
 * 2. {@link scorePairConflicts} — which pairs can collide? (pure scoring)
 * 3. LLM ordering judge — for the scored pairs only, classify
 *    `must_precede | should_precede | conflict | independent`, with mandatory
 *    evidence for anything but `independent`.
 *
 * Verdicts become {@link DependencyEdge}s (`depends_on` for ordering,
 * `shared_surface` for conflicts) that feed the unchanged
 * `planTaskDependencies → buildQueuePlan` pipeline in `tools/plan-queue.ts`,
 * and {@link packGroundedWaves} packs them into conflict-free waves for
 * preview and backtesting.
 *
 * Failure policy: the grounded planner never fails the queue plan. A failed
 * touch-set prediction leaves an empty touch set; a failed or malformed
 * ordering response leaves every unjudged pair `independent` (and uncached,
 * so the next run retries).
 *
 * Gated behind `queuePlanner.mode = 'grounded'` (see `getQueuePlannerConfig`).
 */

import { fileURLToPath } from 'node:url';
import {
  buildTouchSetPredictionPrompt,
  createGitRepoProbe,
  predictTouchSets,
  type RepoProbe,
  type TouchSet,
  type TouchSetPredictionInput,
  type TouchSetTask,
} from './touch-set-predictor.ts';
import {
  buildCoChangeIndex,
  compareTaskIds,
  parseGitLogNameOnly,
  scorePairConflicts,
  type CoChangeIndex,
  type PairScore,
  type ScorableTask,
  type ScoreOptions,
} from './conflict-scorer.ts';
import {
  GROUNDED_VERDICT_KINDS,
  lookupGroundedVerdict,
  lookupTouchSet,
  type CachedGroundedVerdict,
  type CachedTouchSet,
  type GroundedVerdictKind,
} from './task-dependency-plan-cache.ts';
import type { DependencyEdge } from './task-dependency-planner.ts';
import { fillPromptTemplate } from './prompt-utils.ts';
import { execArgvCommand } from './shell-utils.ts';

export type { GroundedVerdictKind } from './task-dependency-plan-cache.ts';

export const GROUNDED_ORDERING_PROMPT_PATH = fileURLToPath(new URL('../../tools/prompts/grounded-queue-ordering.md', import.meta.url));
export const TOUCH_SET_PREDICTION_PROMPT_PATH = fileURLToPath(new URL('../../tools/prompts/touch-set-prediction.md', import.meta.url));

/** Pairs judged in one ordering call; lower-scored pairs beyond this default to `independent`. */
export const MAX_PAIRS_PER_LLM_CALL = 40;
/** Evidence shorter than this is not "specific" and the verdict is discarded. */
export const MIN_EVIDENCE_CHARS = 10;
const PROMPT_DESCRIPTION_MAX_CHARS = 500;
const PROMPT_TOUCH_ENTRIES_MAX = 10;

export interface GroundedTask extends TouchSetTask, ScorableTask {
  id: string;
  /** Linear priority: 1 urgent … 4 low, 0/null none. */
  priority?: number | null;
  /** Task fingerprint (`computeTaskFingerprint`) used as the cache key. */
  fingerprint: string;
}

export type VerdictSource = 'llm' | 'cache' | 'default';

export interface GroundedVerdict {
  /** For `must_precede` / `should_precede`, `a` goes first. */
  a: string;
  b: string;
  verdict: GroundedVerdictKind;
  evidence?: string;
  source: VerdictSource;
}

/** Text completion used by the planner. Returns the raw model text. */
export type GroundedLlm = (prompt: string, purpose: 'touch_set' | 'ordering') => Promise<{ text: string; model?: string | null }>;

// ---------------------------------------------------------------------------
// Ordering prompt
// ---------------------------------------------------------------------------

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max).trimEnd()}…[truncated]`;
}

/**
 * Render the ordering prompt for the given pairs. Pure.
 * Template placeholders: `{{TASKS}}`, `{{PAIRS}}`.
 */
export function buildOrderingPrompt(
  template: string,
  pairs: PairScore[],
  tasks: GroundedTask[],
  touchSets: TouchSet[],
): string {
  const involved = new Set(pairs.flatMap((pair) => [pair.taskA, pair.taskB]));
  const touchById = new Map(touchSets.map((set) => [set.taskId, set]));
  const taskBlock = tasks
    .filter((task) => involved.has(task.id))
    .sort((a, b) => compareTaskIds(a.id, b.id))
    .map((task) => {
      const entries = touchById.get(task.id)?.entries ?? [];
      const touch = entries.slice(0, PROMPT_TOUCH_ENTRIES_MAX).map((entry) =>
        `    - ${entry.path} (${entry.source}${entry.symbols?.length ? `; symbols: ${entry.symbols.join(', ')}` : ''})`);
      if (entries.length > PROMPT_TOUCH_ENTRIES_MAX) touch.push(`    - …and ${entries.length - PROMPT_TOUCH_ENTRIES_MAX} more`);
      return [
        `- id: ${task.id}`,
        `  title: ${JSON.stringify(text(task.title))}`,
        `  description: ${JSON.stringify(truncate(text(task.description).trim(), PROMPT_DESCRIPTION_MAX_CHARS))}`,
        `  touchSet:${touch.length === 0 ? ' []' : ''}`,
        ...touch,
      ].join('\n');
    })
    .join('\n');
  const pairBlock = pairs
    .map((pair) => [
      `- a: ${pair.taskA}`,
      `  b: ${pair.taskB}`,
      `  score: ${pair.score}`,
      `  signals: ${JSON.stringify(pair.signals)}`,
      `  overlappingFiles: ${JSON.stringify(pair.overlappingFiles)}`,
      ...(pair.coChangedFiles ? [`  coChangedFiles: ${JSON.stringify(pair.coChangedFiles)}`] : []),
      ...(pair.hint ? [`  orderingHint: ${pair.hint.before} before ${pair.hint.after} (${pair.hint.reason})`] : []),
    ].join('\n'))
    .join('\n');
  return fillPromptTemplate(template, { TASKS: taskBlock, PAIRS: pairBlock });
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/i);
  if (fenced) return fenced[1].trim();
  return trimmed.endsWith('```') && !trimmed.startsWith('```') ? trimmed.slice(0, -3).trim() : trimmed;
}

function pairKey(x: string, y: string): string {
  return compareTaskIds(x, y) <= 0 ? `${x}\u0000${y}` : `${y}\u0000${x}`;
}

/**
 * Validate the ordering judge's answer against the pairs that were asked.
 *
 * - Throws when the payload is not `{ "verdicts": [...] }` JSON (caller treats
 *   every pair as `independent` and does not cache).
 * - Unknown pairs and duplicates are ignored.
 * - Unknown verdict kinds, and non-`independent` verdicts without specific
 *   evidence, are downgraded to `independent` with a warning.
 * - Asked pairs the model omitted come back `independent`.
 *
 * Returns exactly one verdict per asked pair, sorted by pair.
 */
export function parseOrderingVerdicts(
  raw: string,
  pairs: PairScore[],
  warn: (message: string) => void = (message) => console.warn(message),
): GroundedVerdict[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch (error) {
    throw new Error(`ordering output is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { verdicts?: unknown }).verdicts)) {
    throw new Error('ordering output must be an object with a verdicts array');
  }

  const asked = new Map(pairs.map((pair) => [pairKey(pair.taskA, pair.taskB), pair]));
  const answered = new Map<string, GroundedVerdict>();
  for (const item of (parsed as { verdicts: unknown[] }).verdicts) {
    if (typeof item !== 'object' || item === null) continue;
    const { a, b, verdict, evidence } = item as Record<string, unknown>;
    if (typeof a !== 'string' || typeof b !== 'string') continue;
    const key = pairKey(a, b);
    if (!asked.has(key)) {
      warn(`[grounded-planner] ignoring verdict for unasked pair ${a}/${b}`);
      continue;
    }
    if (answered.has(key)) continue;
    const evidenceText = typeof evidence === 'string' ? evidence.trim() : '';
    if (!(GROUNDED_VERDICT_KINDS as readonly unknown[]).includes(verdict)) {
      warn(`[grounded-planner] unknown verdict ${JSON.stringify(verdict)} for ${a}/${b}; treating as independent`);
      answered.set(key, { a, b, verdict: 'independent', source: 'llm' });
      continue;
    }
    const kind = verdict as GroundedVerdictKind;
    if (kind !== 'independent' && evidenceText.length < MIN_EVIDENCE_CHARS) {
      warn(`[grounded-planner] ${kind} for ${a}/${b} has no specific evidence; treating as independent`);
      answered.set(key, { a, b, verdict: 'independent', source: 'llm' });
      continue;
    }
    answered.set(key, {
      a,
      b,
      verdict: kind,
      ...(kind !== 'independent' && evidenceText ? { evidence: evidenceText } : {}),
      source: 'llm',
    });
  }

  return [...asked.entries()]
    .map(([key, pair]) => answered.get(key) ?? { a: pair.taskA, b: pair.taskB, verdict: 'independent' as const, source: 'llm' as const })
    .sort((x, y) => compareTaskIds(pairKey(x.a, x.b), pairKey(y.a, y.b)));
}

// ---------------------------------------------------------------------------
// Wave packing
// ---------------------------------------------------------------------------

export interface GroundedWave {
  index: number;
  taskIds: string[];
}

export interface DeferralReason {
  kind: 'after' | 'conflict';
  /** The task that caused the deferral. */
  taskId: string;
  verdict?: GroundedVerdictKind | 'explicit';
  evidence?: string;
}

export interface WaveDeferral {
  taskId: string;
  wave: number;
  reasons: DeferralReason[];
}

export interface DroppedVerdict {
  verdict: GroundedVerdict;
  reason: 'cycle' | 'unknown_task';
}

export interface GroundedWavePlan {
  waves: GroundedWave[];
  /** Tasks not in wave 0, with what pushed them there. */
  deferrals: WaveDeferral[];
  /** Ordering verdicts dropped because they would create a cycle. */
  dropped: DroppedVerdict[];
  /** Ordering verdicts kept as `depends_on` edges. */
  keptOrdering: GroundedVerdict[];
}

export interface PackOptions {
  /** Explicit `depends_on` edges (Linear) — always honored, checked first. */
  fixedEdges?: DependencyEdge[];
  /** Cap on tasks per wave (unbounded by default). */
  maxWaveSize?: number;
}

interface OrderingEdge {
  from: string;
  to: string;
  verdict: GroundedVerdictKind | 'explicit';
  evidence?: string;
}

function reaches(adjacency: Map<string, Set<string>>, start: string, target: string): boolean {
  const stack = [start];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === target) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of adjacency.get(node) ?? []) stack.push(next);
  }
  return false;
}

/**
 * Pack tasks into waves that respect ordering verdicts and never place two
 * `conflict` tasks in the same wave. Pure and deterministic.
 *
 * - `taskIds` are given in priority order; that order breaks ties.
 * - Explicit edges are added first, then `must_precede`, then `should_precede`;
 *   an edge that would close a cycle is dropped (soft edges lose first).
 * - Tasks are placed in priority-aware topological order at the earliest wave
 *   after all predecessors that holds no conflicting task (greedy colouring).
 */
export function packGroundedWaves(taskIds: string[], verdicts: GroundedVerdict[], opts: PackOptions = {}): GroundedWavePlan {
  const known = new Set(taskIds);
  const rank = new Map(taskIds.map((id, index) => [id, index]));
  const adjacency = new Map<string, Set<string>>(taskIds.map((id) => [id, new Set<string>()]));
  const incoming = new Map<string, OrderingEdge[]>(taskIds.map((id) => [id, []]));
  const conflicts = new Map<string, Map<string, GroundedVerdict>>(taskIds.map((id) => [id, new Map()]));
  const dropped: DroppedVerdict[] = [];
  const keptOrdering: GroundedVerdict[] = [];

  const addOrdering = (edge: OrderingEdge): boolean => {
    if (edge.from === edge.to || adjacency.get(edge.from)!.has(edge.to)) return true;
    if (reaches(adjacency, edge.to, edge.from)) return false;
    adjacency.get(edge.from)!.add(edge.to);
    incoming.get(edge.to)!.push(edge);
    return true;
  };

  for (const edge of opts.fixedEdges ?? []) {
    if (edge.type !== 'depends_on' || !known.has(edge.from) || !known.has(edge.to)) continue;
    addOrdering({ from: edge.from, to: edge.to, verdict: 'explicit', ...(edge.reason ? { evidence: edge.reason } : {}) });
  }

  const sortedVerdicts = [...verdicts].sort((x, y) => compareTaskIds(pairKey(x.a, x.b), pairKey(y.a, y.b)));
  for (const kind of ['must_precede', 'should_precede'] as const) {
    for (const verdict of sortedVerdicts) {
      if (verdict.verdict !== kind) continue;
      if (!known.has(verdict.a) || !known.has(verdict.b)) {
        dropped.push({ verdict, reason: 'unknown_task' });
        continue;
      }
      if (addOrdering({ from: verdict.a, to: verdict.b, verdict: kind, ...(verdict.evidence ? { evidence: verdict.evidence } : {}) })) {
        keptOrdering.push(verdict);
      } else {
        dropped.push({ verdict, reason: 'cycle' });
      }
    }
  }

  for (const verdict of sortedVerdicts) {
    if (verdict.verdict !== 'conflict') continue;
    if (!known.has(verdict.a) || !known.has(verdict.b)) {
      dropped.push({ verdict, reason: 'unknown_task' });
      continue;
    }
    conflicts.get(verdict.a)!.set(verdict.b, verdict);
    conflicts.get(verdict.b)!.set(verdict.a, verdict);
  }

  // Priority-aware Kahn: always place the highest-priority ready task next.
  const inDegree = new Map(taskIds.map((id) => [id, incoming.get(id)!.length]));
  const ready = taskIds.filter((id) => inDegree.get(id) === 0);
  const waveOf = new Map<string, number>();
  const members: string[][] = [];
  const deferrals: WaveDeferral[] = [];
  const maxWaveSize = opts.maxWaveSize && opts.maxWaveSize > 0 ? opts.maxWaveSize : Number.POSITIVE_INFINITY;

  while (ready.length > 0) {
    ready.sort((x, y) => rank.get(x)! - rank.get(y)!);
    const taskId = ready.shift()!;
    const preds = incoming.get(taskId)!;
    const lowerBound = preds.reduce((max, edge) => Math.max(max, waveOf.get(edge.from)! + 1), 0);
    let wave = lowerBound;
    const conflictReasons: DeferralReason[] = [];
    for (;;) {
      const occupants = members[wave] ?? [];
      const clashing = occupants.filter((other) => conflicts.get(taskId)!.has(other));
      if (clashing.length === 0 && occupants.length < maxWaveSize) break;
      for (const other of clashing) {
        const verdict = conflicts.get(taskId)!.get(other)!;
        conflictReasons.push({ kind: 'conflict', taskId: other, verdict: 'conflict', ...(verdict.evidence ? { evidence: verdict.evidence } : {}) });
      }
      wave++;
    }
    (members[wave] ??= []).push(taskId);
    waveOf.set(taskId, wave);
    if (wave > 0) {
      deferrals.push({
        taskId,
        wave,
        reasons: [
          ...preds.map((edge) => ({ kind: 'after' as const, taskId: edge.from, verdict: edge.verdict, ...(edge.evidence ? { evidence: edge.evidence } : {}) })),
          ...conflictReasons,
        ],
      });
    }
    for (const next of adjacency.get(taskId)!) {
      const degree = inDegree.get(next)! - 1;
      inDegree.set(next, degree);
      if (degree === 0) ready.push(next);
    }
  }

  const waves = members.map((ids, index) => ({ index, taskIds: [...(ids ?? [])] })).filter((wave) => wave.taskIds.length > 0);
  return {
    waves: waves.map((wave, index) => ({ ...wave, index })),
    deferrals: deferrals.sort((x, y) => x.wave - y.wave || rank.get(x.taskId)! - rank.get(y.taskId)!),
    dropped,
    keptOrdering,
  };
}

/**
 * Convert verdicts into planner edges. Pure.
 * `must_precede`/`should_precede` → `depends_on` (a → b); `conflict` → `shared_surface`.
 * Pass {@link GroundedWavePlan.keptOrdering} plus conflicts so cycle-dropped
 * ordering never reaches `planTaskDependencies`.
 */
export function verdictsToEdges(verdicts: GroundedVerdict[]): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  for (const verdict of verdicts) {
    if (verdict.verdict === 'independent') continue;
    const reason = `grounded:${verdict.verdict}${verdict.evidence ? `: ${verdict.evidence}` : ''}`;
    if (verdict.verdict === 'conflict') {
      const [from, to] = compareTaskIds(verdict.a, verdict.b) <= 0 ? [verdict.a, verdict.b] : [verdict.b, verdict.a];
      edges.push({ type: 'shared_surface', from, to, source: 'inferred', reason });
    } else {
      edges.push({ type: 'depends_on', from: verdict.a, to: verdict.b, source: 'inferred', reason });
    }
  }
  return edges;
}

/** Order tasks by Linear priority (urgent first, "no priority" last), then ID. Pure. */
export function sortByPriority<T extends { id: string; priority?: number | null }>(tasks: T[]): T[] {
  const priorityRank = (priority: number | null | undefined) =>
    typeof priority === 'number' && priority >= 1 && priority <= 4 ? priority : 5;
  return [...tasks].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || compareTaskIds(a.id, b.id));
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface GroundedCacheState {
  touchSets?: Record<string, CachedTouchSet>;
  groundedVerdicts?: CachedGroundedVerdict[];
}

export interface GroundedPlannerOptions {
  repoDir: string;
  /** Cached touch sets / verdicts (already pruned to the current backlog). */
  cache?: GroundedCacheState;
  /** Explicit Linear edges; `depends_on` ones are honored when packing waves. */
  explicitEdges?: DependencyEdge[];
  /** Repository probe (defaults to {@link createGitRepoProbe}). */
  probe?: RepoProbe;
  /** Co-change history (defaults to {@link loadCoChangeIndex}; `null` disables it). */
  coChange?: CoChangeIndex | null;
  /** Extra scoring options (hot files, low-conflict files, sweep threshold). */
  scoreOptions?: Omit<ScoreOptions, 'coChange'>;
  /** LLM transport. Omit to run fully deterministic (no prediction, all unjudged pairs independent). */
  llm?: GroundedLlm;
  /**
   * Ordering calls allowed this run, each judging up to {@link MAX_PAIRS_PER_LLM_CALL}
   * pairs (default 1: the monitor's planner deadline fits one call). The backtest raises it.
   */
  maxLlmCalls?: number;
  /** Restrict which scored pairs get verdicts (the backtest judges only concurrent pairs). */
  pairFilter?: (taskA: string, taskB: string) => boolean;
  /** Prompt templates; omit to load them with `loadPromptTemplate` (registry-attributed). */
  orderingTemplate?: string;
  touchSetTemplate?: string;
  /** Directory tree for touch-set prediction (defaults to `getDirectoryTree`). */
  directoryTree?: () => Promise<string>;
  /** Keyword hits per vague task (defaults to `findRelevantFiles`). */
  keywordHits?: (task: TouchSetTask) => Promise<string>;
  nowMs?: number;
  warn?: (message: string) => void;
}

export interface GroundedLlmOutcome {
  touchSetAttempted: boolean;
  orderingAttempted: boolean;
  /** False when an attempted ordering call failed or returned malformed output. */
  orderingOk: boolean;
  model: string | null;
  error: string | null;
}

export interface GroundedPlanResult {
  /** Edges to merge with explicit edges before `planTaskDependencies`. */
  edges: DependencyEdge[];
  touchSets: TouchSet[];
  scores: PairScore[];
  /** One verdict per scored, non-explicit pair (that passes `pairFilter`). */
  verdicts: GroundedVerdict[];
  waves: GroundedWavePlan;
  /** Cache blocks to persist (pruned + fresh entries). */
  cache: Required<GroundedCacheState>;
  llm: GroundedLlmOutcome;
  stats: {
    tasks: number;
    touchSetCacheHits: number;
    pairsScored: number;
    pairsSentToLlm: number;
    verdictCacheHits: number;
    llmCallMs: number;
    totalMs: number;
  };
}

async function loadTemplate(path: string): Promise<string> {
  const { loadPromptTemplate } = await import('./prompt-utils.ts');
  return loadPromptTemplate(path);
}

/**
 * Run the grounded planning pipeline over a backlog. Never throws for LLM or
 * repository failures; see the module doc for the failure policy.
 */
export async function runGroundedPlanning(tasks: GroundedTask[], opts: GroundedPlannerOptions): Promise<GroundedPlanResult> {
  const startedMs = Date.now();
  const nowMs = opts.nowMs ?? startedMs;
  const nowIso = new Date(nowMs).toISOString();
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  const llmOutcome: GroundedLlmOutcome = { touchSetAttempted: false, orderingAttempted: false, orderingOk: true, model: null, error: null };
  let llmCallMs = 0;
  const timed = async <T>(fn: () => Promise<T>): Promise<T> => {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      llmCallMs += Date.now() - start;
    }
  };

  const fingerprintById = new Map(tasks.map((task) => [task.id, task.fingerprint]));
  const cacheState = opts.cache ?? {};

  // 1. Touch sets: cache first, predict the rest.
  const cachedTouch = new Map<string, TouchSet>();
  for (const task of tasks) {
    const hit = lookupTouchSet(cacheState, task.id, task.fingerprint, nowMs);
    if (hit) cachedTouch.set(task.id, { taskId: task.id, entries: hit.entries.map((entry) => ({ ...entry })) });
  }
  const missing = tasks.filter((task) => !cachedTouch.has(task.id));
  let fresh: TouchSet[] = [];
  if (missing.length > 0) {
    let probe: RepoProbe | undefined = opts.probe;
    try {
      probe ??= createGitRepoProbe(opts.repoDir);
      const llm = opts.llm;
      const llmPredict = llm
        ? async (inputs: TouchSetPredictionInput[]) => {
          llmOutcome.touchSetAttempted = true;
          const [template, tree] = await Promise.all([
            opts.touchSetTemplate ?? loadTemplate(TOUCH_SET_PREDICTION_PROMPT_PATH),
            opts.directoryTree ? opts.directoryTree() : defaultDirectoryTree(opts.repoDir),
          ]);
          const result = await timed(() => llm(buildTouchSetPredictionPrompt(template, inputs, tree), 'touch_set'));
          return result.text;
        }
        : undefined;
      fresh = await predictTouchSets(missing, {
        probe,
        ...(llmPredict ? { llmPredict } : {}),
        keywordHits: opts.keywordHits ?? ((task) => defaultKeywordHits(opts.repoDir, task)),
        warn,
      });
    } catch (error) {
      warn(`[grounded-planner] touch-set prediction failed; using empty touch sets: ${(error as Error).message}`);
      fresh = missing.map((task) => ({ taskId: task.id, entries: [] }));
    }
  }
  const freshById = new Map(fresh.map((set) => [set.taskId, set]));
  const touchSets = tasks.map((task) => cachedTouch.get(task.id) ?? freshById.get(task.id) ?? { taskId: task.id, entries: [] });

  const touchSetCache: Record<string, CachedTouchSet> = {};
  for (const task of tasks) {
    const hit = lookupTouchSet(cacheState, task.id, task.fingerprint, nowMs);
    if (hit) {
      touchSetCache[task.id] = hit;
      continue;
    }
    const set = freshById.get(task.id);
    if (set) touchSetCache[task.id] = { fingerprint: task.fingerprint, computedAt: nowIso, entries: set.entries };
  }

  // 2. Deterministic scoring.
  let coChange: CoChangeIndex | null = null;
  if (opts.coChange !== undefined) {
    coChange = opts.coChange;
  } else {
    try {
      coChange = loadCoChangeIndex(opts.repoDir);
    } catch (error) {
      warn(`[grounded-planner] co-change history unavailable: ${(error as Error).message}`);
    }
  }
  const scores = scorePairConflicts(tasks, touchSets, { ...opts.scoreOptions, coChange });
  // Pairs Linear already links are explicit edges; the judge has nothing to add.
  const judgeable = scores.filter(
    (pair) => !pair.signals.includes('explicit_dependency') && (opts.pairFilter?.(pair.taskA, pair.taskB) ?? true),
  );

  // 3. Verdicts: cache first, one batched LLM call for the rest.
  const verdictByPair = new Map<string, GroundedVerdict>();
  const freshCachedVerdicts: CachedGroundedVerdict[] = [];
  const keptCachedVerdicts: CachedGroundedVerdict[] = [];
  let verdictCacheHits = 0;
  const toJudge: PairScore[] = [];
  for (const pair of judgeable) {
    const hit = lookupGroundedVerdict(cacheState, pair.taskA, pair.taskB, fingerprintById.get(pair.taskA)!, fingerprintById.get(pair.taskB)!);
    if (hit) {
      verdictCacheHits++;
      keptCachedVerdicts.push(hit);
      verdictByPair.set(pairKey(pair.taskA, pair.taskB), {
        a: hit.a,
        b: hit.b,
        verdict: hit.verdict,
        ...(hit.evidence ? { evidence: hit.evidence } : {}),
        source: 'cache',
      });
    } else {
      toJudge.push(pair);
    }
  }

  const maxLlmCalls = Math.max(1, opts.maxLlmCalls ?? 1);
  const sent = toJudge.slice(0, MAX_PAIRS_PER_LLM_CALL * maxLlmCalls);
  if (toJudge.length > sent.length) {
    warn(`[grounded-planner] ${toJudge.length - sent.length} low-score pair(s) over the ${sent.length}-pair cap default to independent this run`);
  }
  if (sent.length > 0 && opts.llm) {
    llmOutcome.orderingAttempted = true;
    const llm = opts.llm;
    let template: string | undefined = opts.orderingTemplate;
    for (let offset = 0; offset < sent.length; offset += MAX_PAIRS_PER_LLM_CALL) {
      const chunk = sent.slice(offset, offset + MAX_PAIRS_PER_LLM_CALL);
      try {
        template ??= await loadTemplate(GROUNDED_ORDERING_PROMPT_PATH);
        const prompt = buildOrderingPrompt(template, chunk, tasks, touchSets);
        const result = await timed(() => llm(prompt, 'ordering'));
        llmOutcome.model = result.model ?? llmOutcome.model;
        for (const verdict of parseOrderingVerdicts(result.text, chunk, warn)) {
          verdictByPair.set(pairKey(verdict.a, verdict.b), verdict);
          freshCachedVerdicts.push({
            a: verdict.a,
            b: verdict.b,
            aFingerprint: fingerprintById.get(verdict.a)!,
            bFingerprint: fingerprintById.get(verdict.b)!,
            verdict: verdict.verdict,
            ...(verdict.evidence ? { evidence: verdict.evidence } : {}),
            classifiedAt: nowIso,
          });
        }
      } catch (error) {
        llmOutcome.orderingOk = false;
        llmOutcome.error = (error as Error).message;
        warn(`[grounded-planner] ordering judge failed; ${chunk.length} pair(s) default to independent: ${(error as Error).message}`);
      }
    }
  }

  const verdicts = judgeable.map((pair) =>
    verdictByPair.get(pairKey(pair.taskA, pair.taskB)) ?? { a: pair.taskA, b: pair.taskB, verdict: 'independent' as const, source: 'default' as const });

  // 4. Pack waves and derive edges (cycle-dropped ordering never becomes an edge).
  const ordered = sortByPriority(tasks).map((task) => task.id);
  const waves = packGroundedWaves(ordered, verdicts, { fixedEdges: opts.explicitEdges ?? [] });
  for (const { verdict, reason } of waves.dropped) {
    warn(`[grounded-planner] dropping ${verdict.verdict} ${verdict.a}->${verdict.b} (${reason})`);
  }
  const edges = verdictsToEdges([...waves.keptOrdering, ...verdicts.filter((verdict) => verdict.verdict === 'conflict')]);

  return {
    edges,
    touchSets,
    scores,
    verdicts,
    waves,
    cache: {
      touchSets: touchSetCache,
      groundedVerdicts: [...keptCachedVerdicts, ...freshCachedVerdicts].sort((x, y) => compareTaskIds(pairKey(x.a, x.b), pairKey(y.a, y.b))),
    },
    llm: llmOutcome,
    stats: {
      tasks: tasks.length,
      touchSetCacheHits: cachedTouch.size,
      pairsScored: scores.length,
      pairsSentToLlm: opts.llm ? sent.length : 0,
      verdictCacheHits,
      llmCallMs,
      totalMs: Date.now() - startedMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Production defaults (impure)
// ---------------------------------------------------------------------------

/** Commits mined for co-change statistics. */
export const CO_CHANGE_HISTORY_COMMITS = 400;

/**
 * Build a {@link CoChangeIndex} from recent non-merge history of `repoDir`,
 * ending at `ref` (default `HEAD`; the backtest passes a historical commit).
 */
export function loadCoChangeIndex(repoDir: string, opts: { commits?: number; ref?: string } = {}): CoChangeIndex {
  const result = execArgvCommand(
    'git',
    ['log', '--no-merges', '--name-only', '--format=%x00', '-n', String(opts.commits ?? CO_CHANGE_HISTORY_COMMITS), opts.ref ?? 'HEAD', '--'],
    { cwd: repoDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (result.exitCode !== 0) throw new Error(`git log exited ${result.exitCode}`);
  return buildCoChangeIndex(parseGitLogNameOnly(result.stdout));
}

async function defaultDirectoryTree(repoDir: string): Promise<string> {
  const { getDirectoryTree } = await import('./codebase-context-gatherer.ts');
  return getDirectoryTree(repoDir, 3);
}

async function defaultKeywordHits(repoDir: string, task: TouchSetTask): Promise<string> {
  const { findRelevantFiles } = await import('./codebase-context-gatherer.ts');
  return findRelevantFiles(repoDir, text(task.title));
}

/**
 * The judge must answer from the prompt alone. Without this the Claude CLI
 * loads its tool set and, seeing file paths, reasons about reading them:
 * a 3 KB ordering prompt measured 68 s with tools vs 26 s without. Every
 * `classify` ladder candidate runs through the Claude CLI transport.
 * Requires `mode: 'stream'`: the sync path joins args into a shell string and
 * drops the empty `''` value (same convention as issue-expander / plan-decomposer).
 */
export const GROUNDED_LLM_CLI_FLAGS: readonly string[] = ['--tools', ''];

export interface GroundedLlmOptions {
  repoDir: string;
  /** Per-call timeout when no deadline is set (llm-cli default otherwise). */
  timeoutMs?: number;
  /** Absolute epoch-ms deadline shared by every call in this run. */
  deadlineMs?: number;
  perAttemptTimeoutMs?: number;
  deadlineGraceMs?: number;
}

/**
 * Default {@link GroundedLlm} backed by `callLLM` with the lightweight
 * `classify` ladder, honoring the monitor's absolute planner deadline.
 */
export function createGroundedLlm(opts: GroundedLlmOptions): GroundedLlm {
  return async (prompt) => {
    const { callLLM } = await import('./llm-cli.ts');
    const result = await callLLM(prompt, {
      taskType: 'classify',
      repoDir: opts.repoDir,
      mode: 'stream',
      cliFlags: [...GROUNDED_LLM_CLI_FLAGS],
      ...(opts.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs }),
      ...(opts.deadlineMs === undefined
        ? {}
        : {
          fallbackDeadlineMs: opts.deadlineMs,
          ...(opts.perAttemptTimeoutMs === undefined ? {} : { fallbackPerAttemptTimeoutMs: opts.perAttemptTimeoutMs }),
          ...(opts.deadlineGraceMs === undefined ? {} : { fallbackDeadlineGraceMs: opts.deadlineGraceMs }),
        }),
    });
    return { text: result.text, model: result.model ?? null };
  };
}
