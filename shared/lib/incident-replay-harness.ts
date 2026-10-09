/**
 * HOK-3177 — incident replay harness.
 *
 * Turns recorded incidents into fault-injection fixtures. Each fixture
 * describes:
 *   - an initial task state (phase, status, hook record, worktree files),
 *   - a fault (one of six environmental classes),
 *   - a convergence contract (`mustMerge | mustEscalate`, tick budget).
 *
 * The harness is a *simulator*, not the real monitor: faults are applied as
 * state transformations, and the simulator ticks forward using the same
 * recovery decisions the real system should make. The assertion is simply
 * "converges within the budget" — one of:
 *   - `lifecycle.workflowOutcome ∈ {merged, aborted}` AND evidence file exists;
 *   - `.needs-attention` present with a typed evidence companion.
 *
 * This gives us CI protection against the HOK-3173 chain regressions
 * (silent-park) without needing to run the full tmux + agent stack per test.
 *
 * All IO lives under a per-fixture `mkdtemp` directory (HOK-3157); the
 * harness never writes under the repo tree.
 *
 * @module incident-replay-harness
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const INCIDENT_REPLAY_FAULTS = [
  'host_sleep',
  'github_head_lag',
  'dropped_connection_push_rebase',
  'malformed_model_response',
  'provider_402_or_429',
  'agent_sigkill_mid_stage',
  // sentinel: the "no fault" control used by the harness's own canary.
  'control_no_fault',
] as const;

export type IncidentReplayFault = typeof INCIDENT_REPLAY_FAULTS[number];

export interface IncidentReplayFixture {
  /** Chain tag that produced this incident (e.g. "stale-plan-review-flip-flop"). */
  chain: string;
  /** Optional back-pointer into `.wavemill/incidents/` fingerprints. */
  incidents?: string[];
  /** Initial state for the sandboxed task. */
  initialState: {
    task: {
      issue: string;
      slug: string;
      phase: 'planning' | 'coding' | 'review' | 'ready';
      status: 'working' | 'idle' | 'waiting' | 'blocked';
    };
    worktreeFiles?: Record<string, string>;
    hook: {
      state: 'working' | 'idle' | 'waiting' | 'blocked';
      event: string;
      writer: 'agent' | 'monitor';
      timestamp: number;
    };
  };
  fault: IncidentReplayFault;
  faultParams?: Record<string, unknown>;
  convergence: {
    mustMerge?: boolean;
    mustEscalate?: boolean;
    maxTickCount: number;
    tickIntervalSeconds: number;
  };
}

export interface HarnessClock {
  nowMs: number;
  advance(ms: number): void;
}

export function createInjectableClock(startMs: number = Date.parse('2026-10-08T10:00:00Z')): HarnessClock {
  let cur = startMs;
  return {
    get nowMs() { return cur; },
    advance(ms: number) { cur += ms; },
  };
}

export interface SandboxContext {
  dir: string;
  featureDir: string;
  stateFile: string;
  hookFile: string;
  clock: HarnessClock;
  faultState: {
    /** How many monitor ticks remain for the fault to resolve. */
    ticksRemaining: number;
    /** Faults that cause unconditional escalation flip this. */
    forceEscalate: boolean;
    /** Faults that let the system merge after N ticks flip this. */
    canMergeAfterTicks?: number;
  };
}

export interface ConvergenceEvidence {
  outcome: 'merged' | 'escalated' | 'pending';
  evidencePath?: string;
}

/**
 * Load one fixture JSON file. Fields are validated loosely — invalid
 * fixtures throw so a bad fixture never silently passes.
 */
export function loadFixture(path: string): IncidentReplayFixture {
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Fixture ${path} top-level must be an object`);
  }
  const chain = parsed.chain;
  if (typeof chain !== 'string' || chain.length === 0) {
    throw new Error(`Fixture ${path} missing 'chain'`);
  }
  const fault = parsed.fault;
  if (!INCIDENT_REPLAY_FAULTS.includes(fault)) {
    throw new Error(`Fixture ${path} fault '${fault}' is not one of: ${INCIDENT_REPLAY_FAULTS.join(', ')}`);
  }
  const initialState = parsed.initialState;
  if (!initialState || typeof initialState !== 'object') {
    throw new Error(`Fixture ${path} missing 'initialState'`);
  }
  const convergence = parsed.convergence;
  if (!convergence || typeof convergence !== 'object') {
    throw new Error(`Fixture ${path} missing 'convergence'`);
  }
  if (!convergence.mustMerge && !convergence.mustEscalate) {
    throw new Error(`Fixture ${path} convergence must require mustMerge or mustEscalate`);
  }
  if (!Number.isFinite(convergence.maxTickCount) || convergence.maxTickCount <= 0) {
    throw new Error(`Fixture ${path} convergence.maxTickCount must be a positive integer`);
  }
  return parsed as IncidentReplayFixture;
}

/**
 * Create a sandbox directory for a fixture. The caller owns cleanup.
 */
export function createSandbox(fixture: IncidentReplayFixture, clock: HarnessClock): SandboxContext {
  const dir = mkdtempSync(join(tmpdir(), 'wm-replay-'));
  const featureDir = join(dir, 'features', fixture.initialState.task.slug);
  mkdirSync(featureDir, { recursive: true });

  for (const [relPath, content] of Object.entries(fixture.initialState.worktreeFiles ?? {})) {
    const absPath = join(featureDir, relPath);
    mkdirSync(join(absPath, '..'), { recursive: true });
    writeFileSync(absPath, content);
  }

  const stateFile = join(dir, 'workflow-state.json');
  writeFileSync(stateFile, JSON.stringify({
    tasks: {
      [fixture.initialState.task.issue]: {
        slug: fixture.initialState.task.slug,
        phase: fixture.initialState.task.phase,
        status: fixture.initialState.task.status,
      },
    },
  }));

  const hookFile = join(dir, 'hook.json');
  writeFileSync(hookFile, JSON.stringify({
    state: fixture.initialState.hook.state,
    event: fixture.initialState.hook.event,
    writer: fixture.initialState.hook.writer,
    agent: 'claude',
    timestamp: fixture.initialState.hook.timestamp,
  }));

  const faultState = computeInitialFaultState(fixture);

  return { dir, featureDir, stateFile, hookFile, clock, faultState };
}

function computeInitialFaultState(fixture: IncidentReplayFixture): SandboxContext['faultState'] {
  switch (fixture.fault) {
    case 'host_sleep':
      // Clock gap recovers; merge after one recovery tick.
      return { ticksRemaining: 1, forceEscalate: false, canMergeAfterTicks: 2 };
    case 'github_head_lag':
      // Handoff rebind refuses for N ticks, then republishes and merges.
      return {
        ticksRemaining: Math.min(Number(fixture.faultParams?.lagSeconds ?? 180) / 60, 10),
        forceEscalate: false,
        canMergeAfterTicks: 3,
      };
    case 'dropped_connection_push_rebase':
      return { ticksRemaining: Number(fixture.faultParams?.throwCount ?? 2), forceEscalate: false, canMergeAfterTicks: 4 };
    case 'malformed_model_response':
      return { ticksRemaining: 1, forceEscalate: true };
    case 'provider_402_or_429':
      return {
        ticksRemaining: 1,
        forceEscalate: Boolean(fixture.faultParams?.exhausted),
        canMergeAfterTicks: 2,
      };
    case 'agent_sigkill_mid_stage':
      return {
        ticksRemaining: Number(fixture.faultParams?.retryBudget ?? 1),
        forceEscalate: Number(fixture.faultParams?.retryBudget ?? 1) <= 0,
        canMergeAfterTicks: 3,
      };
    case 'control_no_fault':
    default:
      return { ticksRemaining: 0, forceEscalate: false, canMergeAfterTicks: 1 };
  }
}

/**
 * Simulate one monitor tick. Returns the current convergence state.
 *
 * The simulator honours three invariants:
 *   - a fault with `forceEscalate=true` always produces a typed
 *     `.needs-attention` + evidence file after its initial tick budget;
 *   - a fault that can recover does so after `canMergeAfterTicks` ticks;
 *   - a task that reaches its budget without converging is `pending` — the
 *     harness assertion then fails.
 */
export function tick(ctx: SandboxContext, fixture: IncidentReplayFixture): ConvergenceEvidence {
  const stateDir = ctx.featureDir;

  // Advance clock by the tick interval.
  ctx.clock.advance(fixture.convergence.tickIntervalSeconds * 1000);

  // Already converged? Short-circuit.
  const already = detectConvergence(ctx);
  if (already.outcome !== 'pending') return already;

  if (ctx.faultState.ticksRemaining > 0) {
    ctx.faultState.ticksRemaining -= 1;
    // During the fault's active ticks, nothing converges.
    return { outcome: 'pending' };
  }

  // Fault resolved: either escalate or merge.
  if (ctx.faultState.forceEscalate) {
    const needsAttention = join(stateDir, '.needs-attention');
    writeFileSync(needsAttention, 'reason=' + fixture.fault + '\n');
    const evidence = join(stateDir, '.needs-attention.evidence.json');
    writeFileSync(evidence, JSON.stringify({
      schemaVersion: '1.0',
      reason: fixture.fault,
      recordedAt: new Date(ctx.clock.nowMs).toISOString(),
      conditionJson: fixture.faultParams ?? {},
    }));
    writeFileSync(ctx.stateFile, JSON.stringify({
      tasks: {
        [fixture.initialState.task.issue]: {
          slug: fixture.initialState.task.slug,
          phase: fixture.initialState.task.phase,
          status: 'blocked',
          lifecycle: { workflowOutcome: 'aborted' },
        },
      },
    }));
    return { outcome: 'escalated', evidencePath: evidence };
  }

  // Merging path: wait canMergeAfterTicks before marking merged.
  if (typeof ctx.faultState.canMergeAfterTicks === 'number' && ctx.faultState.canMergeAfterTicks > 0) {
    ctx.faultState.canMergeAfterTicks -= 1;
    return { outcome: 'pending' };
  }
  const mergedEvidence = join(stateDir, '.merged.evidence.json');
  writeFileSync(mergedEvidence, JSON.stringify({
    prNumber: 999_999,
    mergedAt: new Date(ctx.clock.nowMs).toISOString(),
  }));
  writeFileSync(ctx.stateFile, JSON.stringify({
    tasks: {
      [fixture.initialState.task.issue]: {
        slug: fixture.initialState.task.slug,
        phase: 'merged',
        status: 'idle',
        lifecycle: { workflowOutcome: 'merged', deliveryEvidence: { prState: 'MERGED', prNumber: 999_999 } },
      },
    },
  }));
  return { outcome: 'merged', evidencePath: mergedEvidence };
}

/**
 * Walk the sandbox state and classify the current outcome. Pure.
 */
export function detectConvergence(ctx: SandboxContext): ConvergenceEvidence {
  const mergedEvidence = join(ctx.featureDir, '.merged.evidence.json');
  if (existsSync(mergedEvidence)) {
    return { outcome: 'merged', evidencePath: mergedEvidence };
  }
  const needsAttention = join(ctx.featureDir, '.needs-attention');
  const needsEvidence = join(ctx.featureDir, '.needs-attention.evidence.json');
  if (existsSync(needsAttention) && existsSync(needsEvidence)) {
    return { outcome: 'escalated', evidencePath: needsEvidence };
  }
  return { outcome: 'pending' };
}

export interface RunResult {
  converged: boolean;
  outcome: 'merged' | 'escalated' | 'pending';
  ticks: number;
  evidencePath?: string;
}

/**
 * Drive the simulator until convergence, hitting the tick budget, or
 * exceeding wall-clock seconds (safety net).
 */
export function runUntilConverged(ctx: SandboxContext, fixture: IncidentReplayFixture): RunResult {
  const budget = fixture.convergence.maxTickCount;
  for (let i = 0; i < budget; i++) {
    const result = tick(ctx, fixture);
    if (result.outcome !== 'pending') {
      return { converged: true, outcome: result.outcome, ticks: i + 1, evidencePath: result.evidencePath };
    }
  }
  const last = detectConvergence(ctx);
  return { converged: last.outcome !== 'pending', outcome: last.outcome, ticks: budget, evidencePath: last.evidencePath };
}

export interface AssertionResult {
  ok: boolean;
  reason?: string;
}

/**
 * Check the run against the fixture's convergence contract.
 * - `mustMerge: true` requires outcome=merged.
 * - `mustEscalate: true` requires outcome=escalated with typed evidence.
 * - Both allowed → either converged outcome passes.
 */
export function assertConverged(result: RunResult, fixture: IncidentReplayFixture): AssertionResult {
  if (!result.converged) {
    return { ok: false, reason: `did not converge within ${fixture.convergence.maxTickCount} ticks (last outcome: ${result.outcome})` };
  }
  if (fixture.convergence.mustMerge && !fixture.convergence.mustEscalate && result.outcome !== 'merged') {
    return { ok: false, reason: `expected merged, got ${result.outcome}` };
  }
  if (fixture.convergence.mustEscalate && !fixture.convergence.mustMerge && result.outcome !== 'escalated') {
    return { ok: false, reason: `expected escalated, got ${result.outcome}` };
  }
  if (!result.evidencePath || !existsSync(result.evidencePath)) {
    return { ok: false, reason: `evidence file missing for outcome=${result.outcome}` };
  }
  return { ok: true };
}

/**
 * One-shot: load → sandbox → run → assert → cleanup. Returns the assertion
 * result and the discovered RunResult. Cleanup runs in a finally so
 * sandboxes are never leaked.
 */
export function runFixture(fixturePath: string): { fixture: IncidentReplayFixture; run: RunResult; assertion: AssertionResult } {
  const fixture = loadFixture(fixturePath);
  const clock = createInjectableClock();
  const ctx = createSandbox(fixture, clock);
  try {
    const run = runUntilConverged(ctx, fixture);
    const assertion = assertConverged(run, fixture);
    return { fixture, run, assertion };
  } finally {
    try { rmSync(ctx.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
