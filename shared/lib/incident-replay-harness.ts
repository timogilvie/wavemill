/**
 * HOK-3177 — incident replay harness.
 *
 * Turns recorded incidents into fault-injection fixtures. Each fixture
 * describes:
 *   - an initial task state (phase, status, hook record, worktree files),
 *   - a fault (one of six environmental classes),
 *   - a convergence contract (`mustMerge | mustEscalate`, tick budget).
 *
 * Every fixture is driven through `runWithRecoveryLoop`, which feeds the
 * stalled step to the real Ledger F `decideRecovery`. The fault model
 * (`faultModelFor`) is the only fixture-specific knowledge; the recovery
 * outcome itself (failure policy, bounded retry, one escalation) is the
 * production loop. The `--mode=legacy` simulator was retired in HOK-3235.
 *
 * The assertion is simply "converges within the budget" — one of:
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
import { DEFAULT_RETRY_ATTEMPTS, type FailureStage } from './failure-policy.ts';
import type { TaskRow } from './ledger.ts';
import { decideRecovery, type RecoveryActionKind, type RecoveryDecision, type RecoveryRetryBudget } from './ledger-recovery.ts';

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
  // allow-task-literal: synthetic sandbox state for a single-task fixture, not workflow-state read by production code
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

  return { dir, featureDir, stateFile, hookFile, clock };
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
  /** The recovery loop's action on each tick, in order. */
  actions?: RecoveryActionKind[];
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

// ── recovery-loop (HOK-3185) ────────────────────────────────────────────────

/** What the stage reports for a fault, and how many relaunches the fault survives. */
export interface FaultModel {
  failureKind?: string;
  detail?: string;
  /** Relaunches that still hit the fault; `Infinity` never recovers. */
  survivesRelaunches: number;
  /** The agent keeps making progress (no recovery needed). */
  progressing?: boolean;
}

/**
 * Translate a fixture's environmental fault into the failure evidence a real
 * stage would report. This is the only fixture-specific knowledge; the
 * outcome itself comes from `decideRecovery`.
 */
export function faultModelFor(fixture: IncidentReplayFixture): FaultModel {
  const params = fixture.faultParams ?? {};
  switch (fixture.fault) {
    case 'host_sleep':
      // The agent was suspended mid-stage; the step went silent past its deadline.
      return { detail: '', survivesRelaunches: 0 };
    case 'github_head_lag':
      return {
        detail: 'handoff rebind refused: head does not match pushed commit',
        survivesRelaunches: Math.max(0, Math.ceil(Number(params.lagSeconds ?? 180) / 120) - 1),
      };
    case 'dropped_connection_push_rebase':
      return { detail: 'git push failed: ECONNRESET (connection reset by peer)', survivesRelaunches: Math.max(0, Number(params.throwCount ?? 2) - 1) };
    case 'malformed_model_response':
      return { failureKind: 'review-malformed-response', detail: `reviewer returned ${String(params.responseKind ?? 'non-json')} output`, survivesRelaunches: Infinity };
    case 'provider_402_or_429':
      return params.exhausted
        ? { detail: '402 This request would exceed your available credits', survivesRelaunches: Infinity }
        : { detail: '429 Too Many Requests: rate limit exceeded, retry later', survivesRelaunches: 0 };
    case 'agent_sigkill_mid_stage': {
      const budget = Number(params.retryBudget ?? 1);
      return { detail: 'interrupted: coding agent exited without recording a result', survivesRelaunches: budget <= 0 ? Infinity : budget - 1 };
    }
    case 'control_no_fault':
    default:
      return { survivesRelaunches: 0, progressing: true };
  }
}

/** In-memory bounded-retry budget (no backoff — one harness tick is one backoff window). */
export function createMemoryRetryBudget(maxAttempts = DEFAULT_RETRY_ATTEMPTS): RecoveryRetryBudget {
  let attempts = 0;
  return {
    peek: () => ({ decision: attempts >= maxAttempts ? 'exhausted' : 'proceed', attempts, maxAttempts }),
    consume: () => { attempts += 1; },
  };
}

function syntheticStep(fixture: IncidentReplayFixture, nowMs: number, attempt: number): TaskRow {
  const iso = new Date(nowMs).toISOString();
  return {
    id: `${fixture.initialState.task.issue}-${fixture.initialState.task.phase}-${attempt}`,
    parent_id: fixture.initialState.task.issue,
    kind: 'step',
    slug: fixture.initialState.task.phase,
    inputs_hash: `replay-${attempt}`,
    state: 'running',
    owner: null,
    next_action: null,
    // Harness time is compressed: each attempt reaches its deadline on the next tick.
    deadline: iso,
    background: 0,
    replay: 'unsafe',
    attempt,
    max_attempts: null,
    created_at: new Date(nowMs - 60_000).toISOString(),
    settled_at: null,
    settled_as: null,
    settled_reason: null,
  };
}

function writeEscalation(ctx: SandboxContext, fixture: IncidentReplayFixture, decision: RecoveryDecision): ConvergenceEvidence {
  const needsAttention = join(ctx.featureDir, '.needs-attention');
  writeFileSync(needsAttention, `reason=${decision.failureKind ?? fixture.fault}\n`);
  const evidence = join(ctx.featureDir, '.needs-attention.evidence.json');
  writeFileSync(evidence, JSON.stringify({
    schemaVersion: '1.0',
    reason: decision.failureKind ?? fixture.fault,
    recordedAt: new Date(ctx.clock.nowMs).toISOString(),
    conditionJson: { action: decision.action, rationale: decision.rationale, nextAction: decision.nextAction },
  }));
  return { outcome: 'escalated', evidencePath: evidence };
}

function writeMerged(ctx: SandboxContext): ConvergenceEvidence {
  const mergedEvidence = join(ctx.featureDir, '.merged.evidence.json');
  writeFileSync(mergedEvidence, JSON.stringify({ prNumber: 999_999, mergedAt: new Date(ctx.clock.nowMs).toISOString() }));
  return { outcome: 'merged', evidencePath: mergedEvidence };
}

/**
 * Drive the fixture with the real recovery loop. Each tick the current
 * attempt's step reaches its deadline; if the fault has cleared (or the
 * agent is progressing) the task merges, otherwise `decideRecovery` chooses:
 * a relaunch spends the budget and starts a new attempt, an escalation or a
 * terminal settle converges as escalated.
 */
export function runWithRecoveryLoop(ctx: SandboxContext, fixture: IncidentReplayFixture): RunResult {
  const model = faultModelFor(fixture);
  const retry = createMemoryRetryBudget();
  const actions: RecoveryActionKind[] = [];
  let relaunches = 0;
  let step = syntheticStep(fixture, ctx.clock.nowMs, 0);
  const stage = fixture.initialState.task.phase as FailureStage;

  for (let i = 0; i < fixture.convergence.maxTickCount; i++) {
    ctx.clock.advance(fixture.convergence.tickIntervalSeconds * 1000);
    const nowIso = new Date(ctx.clock.nowMs).toISOString();
    const recovered = relaunches > model.survivesRelaunches;
    const progressing = model.progressing === true || recovered;
    const decision = decideRecovery({
      step,
      issueKey: fixture.initialState.task.issue,
      now: new Date(ctx.clock.nowMs),
      waitingOn: [],
      evidence: [],
      env: {
        stateDir: ctx.featureDir,
        head: 'feedface',
        progress: () => (progressing
          ? { agentIdle: false, stalled: false, lastProgressAt: nowIso }
          : { agentIdle: true, stalled: true, lastProgressAt: null }),
        failure: () => ({ stage, failureKind: model.failureKind ?? null, detail: model.detail ?? '' }),
      },
      retry,
    });
    actions.push(decision.action);

    switch (decision.action) {
      case 'skip':
        if (progressing) {
          const merged = writeMerged(ctx);
          return { converged: true, outcome: 'merged', ticks: i + 1, evidencePath: merged.evidencePath, actions };
        }
        break;
      case 'bounded-relaunch':
      case 'spawn-remediation':
        retry.consume(decision.retryBucket ?? 'remediation', ctx.featureDir);
        relaunches += 1;
        step = syntheticStep(fixture, ctx.clock.nowMs, relaunches);
        break;
      case 'escalate-waiting-on':
      case 'settle-aborted': {
        const escalated = writeEscalation(ctx, fixture, decision);
        return { converged: true, outcome: 'escalated', ticks: i + 1, evidencePath: escalated.evidencePath, actions };
      }
    }
  }
  const last = detectConvergence(ctx);
  return { converged: last.outcome !== 'pending', outcome: last.outcome, ticks: fixture.convergence.maxTickCount, evidencePath: last.evidencePath, actions };
}

/**
 * One-shot: load → sandbox → run → assert → cleanup. Returns the assertion
 * result and the discovered RunResult. Cleanup runs in a finally so
 * sandboxes are never leaked.
 */
export function runFixture(
  fixturePath: string,
): { fixture: IncidentReplayFixture; run: RunResult; assertion: AssertionResult } {
  const fixture = loadFixture(fixturePath);
  const clock = createInjectableClock();
  const ctx = createSandbox(fixture, clock);
  try {
    const run = runWithRecoveryLoop(ctx, fixture);
    const assertion = assertConverged(run, fixture);
    return { fixture, run, assertion };
  } finally {
    try { rmSync(ctx.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
