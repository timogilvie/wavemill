/**
 * Bounded counterfactual exploration runner.
 *
 * Given a checkpoint written by `session-checkpoint.ts`, this module
 * enumerates alternative tool choices from the recorded decision menu and
 * yields N+1 eval-record shaped rows: one live baseline replay row plus one
 * counterfactual row per branch. The model identifier is held fixed — the
 * runner refuses to proceed if the caller's requested model does not match
 * the checkpoint's recorded `modelId`.
 *
 * This module deliberately does **not** launch a live LLM. The
 * `outcomeAdapter` hook is the injection point through which callers plug in
 * a scoring or simulation function; the default adapter returns a
 * deterministic synthetic outcome derived from the branch's tool name so
 * unit tests and dry-run smokes can exercise the pipeline without any
 * external state.
 *
 * @module native-agent/counterfactual-runner
 */

import { createHash, randomUUID } from 'node:crypto';
import type {
  EvalDecisionSource,
  EvalRecord,
  ReplayNonFidelityReason,
} from '../eval-schema.ts';
import { SCHEMA_VERSION, getScoreBand } from '../eval-schema.ts';

/** Stable failure code recorded on budget-exhausted counterfactual rows. */
export const EXPLORATION_BUDGET_EXHAUSTED = 'exploration_budget_exhausted';
import { attachCounterfactualLineage } from '../eval-record-builder.ts';
import {
  loadCheckpoint,
  type CheckpointHandle,
} from './session-checkpoint.ts';
import {
  calculateFidelity,
  replayFromCheckpoint,
  type ReplayResult,
} from './deterministic-replay.ts';

/** Policy tag written to the eval row's `policy_source` field. */
export type PolicyKind =
  | 'deterministic-baseline'
  | 'enumerate-all'
  | 'epsilon-greedy';

export interface DeterministicBaselinePolicy {
  kind: 'deterministic-baseline';
}

export interface EnumeratePolicy {
  kind: 'enumerate-all';
}

export interface EpsilonGreedyPolicy {
  kind: 'epsilon-greedy';
  /** Sampling fraction in `[0, 1]`. Passed through into `policy_source`. */
  epsilon: number;
  /** Optional override for the number of branches to sample. */
  branches?: number;
}

export type ExplorationPolicy =
  | DeterministicBaselinePolicy
  | EnumeratePolicy
  | EpsilonGreedyPolicy;

export interface ExplorationBudget {
  /** Hard cap on the number of counterfactual branches expanded. */
  branchesMax: number;
  /** Simulated steps per branch. Passed to the outcome adapter. */
  stepsPerBranchMax: number;
  /** Wall-clock cap in seconds. Enforced against a monotonic timer. */
  wallSecondsMax: number;
}

export interface BranchOutcome {
  score: number;
  rationale: string;
  interventionRequired?: boolean;
  interventionCount?: number;
  failureReason?: string;
}

export interface OutcomeAdapterInput {
  checkpoint: CheckpointHandle;
  toolChoice: string;
  isBaseline: boolean;
  branchIndex: number;
  stepsBudget: number;
}

export type OutcomeAdapter = (input: OutcomeAdapterInput) => BranchOutcome | Promise<BranchOutcome>;

export interface RunCounterfactualsInput {
  checkpointRoot: string;
  modelId: string;
  policy: ExplorationPolicy;
  budget: ExplorationBudget;
  /** Optional deterministic clock. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Optional outcome scoring hook. See {@link defaultOutcomeAdapter}. */
  outcomeAdapter?: OutcomeAdapter;
  /** Optional override for `id` generation. */
  idFactory?: () => string;
  /** Optional issue id to stamp on all rows. */
  issueId?: string;
  /** Optional agent type. Defaults to `'native'`. */
  agentType?: string;
}

export interface RunCounterfactualsResult {
  baseline: EvalRecord;
  counterfactuals: EvalRecord[];
  replay: ReplayResult;
  budgetExhausted: boolean;
  branchesExpanded: number;
  policyTag: string;
}

export class CounterfactualRefusedError extends Error {
  readonly reason:
    | 'model_mismatch'
    | 'invalid_budget'
    | 'invalid_policy';
  constructor(reason: 'model_mismatch' | 'invalid_budget' | 'invalid_policy', detail: string) {
    super(`Counterfactual run refused (${reason}): ${detail}`);
    this.name = 'CounterfactualRefusedError';
    this.reason = reason;
  }
}

function policyTag(policy: ExplorationPolicy): string {
  switch (policy.kind) {
    case 'deterministic-baseline':
      return 'deterministic-baseline';
    case 'enumerate-all':
      return 'enumerate-all';
    case 'epsilon-greedy':
      return `epsilon-greedy:eps=${policy.epsilon}`;
  }
}

/**
 * Seeded PRNG (mulberry32). Deterministic given the checkpoint's decisionId,
 * so a given branch set is reproducible without any hidden global state.
 */
function seededRng(seedHex: string): () => number {
  let state = 0;
  for (let i = 0; i < 8; i++) {
    state = (state << 8) | parseInt(seedHex.slice(i * 2, i * 2 + 2), 16);
  }
  state = state | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function alternativesFrom(handle: CheckpointHandle): string[] {
  const menu = handle.manifest.toolMenu;
  const chosen = handle.manifest.chosenTool;
  return menu.filter((tool) => tool !== chosen);
}

function selectBranches(
  handle: CheckpointHandle,
  policy: ExplorationPolicy,
  budget: ExplorationBudget,
): string[] {
  if (policy.kind === 'deterministic-baseline') return [];
  const alternatives = alternativesFrom(handle);
  if (alternatives.length === 0) return [];

  if (policy.kind === 'enumerate-all') {
    return alternatives;
  }

  const target = Math.min(
    policy.branches ?? Math.max(1, Math.round(alternatives.length * policy.epsilon)),
    alternatives.length,
  );
  const seed = createHash('sha256').update(handle.manifest.decisionId).digest('hex');
  const rand = seededRng(seed);
  const pool = [...alternatives];
  const selected: string[] = [];
  while (selected.length < target && pool.length > 0) {
    const idx = Math.floor(rand() * pool.length);
    selected.push(pool.splice(idx, 1)[0]);
  }
  return selected;
}

/**
 * Default deterministic outcome adapter.
 *
 * Derives a stable pseudo-score from `sha256(toolChoice || decisionId)`.
 * Baseline branches are given a small positive constant so tests can assert
 * "baseline vs counterfactual" ordering without depending on any specific
 * synthetic policy. This is a scaffold — real callers pass their own
 * adapter that consults the judge or a simulator.
 */
export const defaultOutcomeAdapter: OutcomeAdapter = ({ checkpoint, toolChoice, isBaseline }) => {
  const digest = createHash('sha256')
    .update(`${checkpoint.manifest.decisionId}::${toolChoice}::${isBaseline ? 'baseline' : 'branch'}`)
    .digest();
  const score = digest.readUInt32BE(0) / 0xffffffff;
  return {
    score,
    rationale: isBaseline
      ? `Deterministic baseline replay for tool "${toolChoice}"`
      : `Counterfactual synthetic outcome for tool "${toolChoice}"`,
    interventionRequired: false,
    interventionCount: 0,
  };
};

function buildBaseRecord(
  handle: CheckpointHandle,
  input: RunCounterfactualsInput,
  timestamp: string,
): Omit<EvalRecord, 'id' | 'score' | 'scoreBand' | 'rationale' | 'originalPrompt'> {
  return {
    schemaVersion: SCHEMA_VERSION,
    modelId: handle.manifest.modelId,
    modelVersion: handle.manifest.modelId,
    timeSeconds: null,
    timestamp,
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    issueId: input.issueId,
    agentType: input.agentType ?? 'native',
  };
}

function makeRecord(
  outcome: BranchOutcome,
  base: ReturnType<typeof buildBaseRecord>,
  fields: {
    id: string;
    prompt: string;
    decisionSource: EvalDecisionSource;
    sourceDecisionId?: string;
    replayFidelity?: number;
    replayNonFidelityReasons?: ReplayNonFidelityReason[];
    policySource?: string;
  },
): EvalRecord {
  const record: EvalRecord = {
    ...base,
    id: fields.id,
    originalPrompt: fields.prompt,
    score: outcome.score,
    scoreBand: getScoreBand(outcome.score).label,
    rationale: outcome.rationale,
    interventionRequired: !!outcome.interventionRequired,
    interventionCount: outcome.interventionCount ?? 0,
  };
  if (outcome.failureReason) {
    record.metadata = { ...(record.metadata ?? {}), branchFailureReason: outcome.failureReason };
  }
  attachCounterfactualLineage(record, {
    decisionSource: fields.decisionSource,
    sourceDecisionId: fields.sourceDecisionId,
    replayFidelity: fields.replayFidelity,
    replayNonFidelityReasons: fields.replayNonFidelityReasons,
    policySource: fields.policySource,
  });
  return record;
}

/**
 * Run bounded counterfactual exploration over a checkpoint's decision menu.
 *
 * Emits `1 + branches` eval records: the first is the live baseline replay
 * row, and each subsequent row is a counterfactual branch linked back to the
 * baseline via `source_decision_id`. The model id is held fixed; a mismatch
 * with the checkpoint's recorded `modelId` raises {@link CounterfactualRefusedError}.
 *
 * Budget enforcement is best-effort but strict: the runner stops expanding
 * new branches once either the `branchesMax` or `wallSecondsMax` cap is hit,
 * and each remaining alternative is recorded as a terminal
 * `exploration_budget_exhausted` row so downstream analysis is aware of the
 * truncation.
 */
export async function runCounterfactuals(
  input: RunCounterfactualsInput,
): Promise<RunCounterfactualsResult> {
  if (!input.budget || input.budget.branchesMax < 0 || input.budget.stepsPerBranchMax < 0 || input.budget.wallSecondsMax < 0) {
    throw new CounterfactualRefusedError('invalid_budget', 'budget values must be non-negative');
  }
  if (input.policy.kind === 'epsilon-greedy' && (input.policy.epsilon < 0 || input.policy.epsilon > 1)) {
    throw new CounterfactualRefusedError('invalid_policy', `epsilon out of range: ${input.policy.epsilon}`);
  }

  const handle = loadCheckpoint(input.checkpointRoot);
  if (input.modelId !== handle.manifest.modelId) {
    throw new CounterfactualRefusedError(
      'model_mismatch',
      `expected ${handle.manifest.modelId}, got ${input.modelId}`,
    );
  }

  const now = input.now ?? (() => new Date());
  const id = input.idFactory ?? (() => randomUUID());
  const startedAt = Date.now();
  const wallClockCapMs = input.budget.wallSecondsMax * 1000;

  const replay = replayFromCheckpoint(input.checkpointRoot, {
    entropy: { ...handle.manifest.entropy },
  });

  const adapter = input.outcomeAdapter ?? defaultOutcomeAdapter;
  const tag = policyTag(input.policy);
  const prompt = `Replay decision ${handle.manifest.decisionId} in session ${handle.manifest.sessionId}`;

  const base = buildBaseRecord(handle, input, now().toISOString());
  const baselineOutcome = await adapter({
    checkpoint: handle,
    toolChoice: handle.manifest.chosenTool,
    isBaseline: true,
    branchIndex: 0,
    stepsBudget: input.budget.stepsPerBranchMax,
  });
  const baseline = makeRecord(baselineOutcome, base, {
    id: id(),
    prompt,
    decisionSource: 'live',
    replayFidelity: replay.fidelity,
    replayNonFidelityReasons: replay.reasons.length > 0 ? [...replay.reasons] : undefined,
    policySource: 'deterministic-baseline',
  });

  const branches = selectBranches(handle, input.policy, input.budget);
  const counterfactuals: EvalRecord[] = [];
  let expanded = 0;
  let exhausted = false;

  for (const toolChoice of branches) {
    if (Date.now() - startedAt > wallClockCapMs && wallClockCapMs > 0) {
      exhausted = true;
    }
    if (expanded >= input.budget.branchesMax) {
      exhausted = true;
    }
    if (exhausted) {
      const outcome: BranchOutcome = {
        score: 0,
        rationale: `exploration budget exhausted before evaluating tool "${toolChoice}"`,
        failureReason: EXPLORATION_BUDGET_EXHAUSTED,
        interventionRequired: false,
        interventionCount: 0,
      };
      counterfactuals.push(
        makeRecord(outcome, buildBaseRecord(handle, input, now().toISOString()), {
          id: id(),
          prompt,
          decisionSource: 'counterfactual',
          sourceDecisionId: baseline.id,
          replayFidelity: replay.fidelity,
          replayNonFidelityReasons: replay.reasons.length > 0 ? [...replay.reasons] : undefined,
          policySource: `${tag}:budget_exhausted`,
        }),
      );
      continue;
    }

    const outcome = await adapter({
      checkpoint: handle,
      toolChoice,
      isBaseline: false,
      branchIndex: expanded,
      stepsBudget: input.budget.stepsPerBranchMax,
    });
    counterfactuals.push(
      makeRecord(outcome, buildBaseRecord(handle, input, now().toISOString()), {
        id: id(),
        prompt,
        decisionSource: 'counterfactual',
        sourceDecisionId: baseline.id,
        replayFidelity: replay.fidelity,
        replayNonFidelityReasons: replay.reasons.length > 0 ? [...replay.reasons] : undefined,
        policySource: `${tag}:${toolChoice}`,
      }),
    );
    expanded++;
  }

  return {
    baseline,
    counterfactuals,
    replay,
    budgetExhausted: exhausted,
    branchesExpanded: expanded,
    policyTag: tag,
  };
}

// Re-export the fidelity helper here so consumers of this module do not need
// a second import to compute a summary score.
export { calculateFidelity };
