/**
 * HOK-3177 — incident replay harness.
 *
 * Turns recorded incidents into fault-injection fixtures. Each fixture
 * describes:
 *   - an initial task state (phase, status, hook record, worktree files),
 *   - a fault (one of six environmental classes),
 *   - a convergence contract (`mustMerge | mustEscalate`, tick budget).
 *
 * Every fixture is driven through `runWithRecoveryLoop`, whose per-tick
 * decision is the live task-recovery controller (`decideTaskRecovery`,
 * HOK-3277) — the one named/versioned policy composing `classifyFailure` and
 * the bounded-retry verdict. The fault model (fixture-declared fault data) is
 * the only fixture-specific knowledge; the recovery decision itself is the
 * production controller. The `decideRecovery` dispatcher and the
 * `--mode=legacy` simulator were retired in HOK-3235 / HOK-3274.
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
import { dirname, join } from 'node:path';
import { classifyFailure, DEFAULT_RETRY_ATTEMPTS, type FailureStage } from './failure-policy.ts';
import { createStateDirRetry, type StateDirRetry } from './bounded-retry.ts';
import { decideTaskRecovery } from './task-recovery-controller.ts';
import { createIncidentDraft, type IncidentLifecycle } from './wavemill-incident-model.ts';
import { IncidentStore } from './wavemill-incident-store.ts';
import { reconcileIncidentCycle } from './incident-reconcile-cycle.ts';
import { escalationMarkerPath, readEscalationMarker } from './operator-escalation.ts';
import {
  loadIncidentFixture,
  type IncidentFixture,
  type IncidentFixtureFailure,
  type IncidentFixtureExpected,
} from './incident-fixture-converter.ts';

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
    hook?: {
      state: 'working' | 'idle' | 'waiting' | 'blocked';
      event: string;
      writer: 'agent' | 'monitor';
      timestamp: number;
    };
  };
  /** Optional coverage label; the data-driven `failure` block drives execution. */
  fault?: IncidentReplayFault;
  faultParams?: Record<string, unknown>;
  /**
   * Declarative fault data (HOK-3231 D2). Required for
   * the stage recovery replay path. Synthetic fixtures migrated mechanically.
   */
  failure?: {
    stage: FailureStage;
    failureKind?: string | null;
    detail: string;
    survivesRelaunches: number | 'never';
    progressing?: boolean;
  };
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
  if (parsed.fault !== undefined && !INCIDENT_REPLAY_FAULTS.includes(parsed.fault)) {
    throw new Error(`Fixture ${path} fault '${parsed.fault}' is not one of: ${INCIDENT_REPLAY_FAULTS.join(', ')}`);
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
  if (parsed.failure !== undefined) {
    const f = parsed.failure as Record<string, unknown>;
    if (typeof f.detail !== 'string') throw new Error(`Fixture ${path} failure.detail must be a string`);
    if (typeof f.stage !== 'string') throw new Error(`Fixture ${path} failure.stage must be a string`);
    if (f.survivesRelaunches !== 'never' && typeof f.survivesRelaunches !== 'number') {
      throw new Error(`Fixture ${path} failure.survivesRelaunches must be a number or "never"`);
    }
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
  const hook = fixture.initialState.hook ?? {
    state: fixture.initialState.task.status,
    event: 'synthetic',
    writer: 'agent' as const,
    timestamp: Math.floor(clock.nowMs / 1000),
  };
  writeFileSync(hookFile, JSON.stringify({
    state: hook.state,
    event: hook.event,
    writer: hook.writer,
    agent: 'claude',
    timestamp: hook.timestamp,
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
  const needsEvidence = join(ctx.featureDir, '.needs-attention.evidence.json');
  if (readEscalationMarker(ctx.featureDir) !== null && existsSync(needsEvidence)) {
    return { outcome: 'escalated', evidencePath: needsEvidence };
  }
  return { outcome: 'pending' };
}

export interface RunResult {
  converged: boolean;
  outcome: 'merged' | 'escalated' | 'pending';
  ticks: number;
  /** The declared failure stage supplied to the recovery policy. */
  failureStage: FailureStage;
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

// ── recovery-loop (HOK-3176 failure policy) ─────────────────────────────────

/**
 * The recovery actions the replay loop can take on one tick. These mirror the
 * live stage-recovery ladder: progress short-circuits (`skip`), an allowlisted
 * terminal cause settles the arm, a recognised code failure starts remediation
 * from its recorded excerpt, and a retryable failure spends the retry budget
 * (`bounded-relaunch`) until it is exhausted
 * (`escalate-waiting-on`). These are the same two live primitives that
 * `maybe_retry_failed_stage` uses: `classifyFailure` and `bounded-retry.sh`.
 */
export type RecoveryActionKind =
  | 'skip'
  | 'settle-aborted'
  | 'spawn-remediation'
  | 'bounded-relaunch'
  | 'escalate-waiting-on';

/** The one recovery decision the replay loop records and acts on each tick. */
interface ReplayRecoveryDecision {
  action: RecoveryActionKind;
  rationale: string;
  failureKind?: string;
  nextAction?: string;
  retryBucket?: string;
}

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
 * Translate a fixture's declared `failure` block (HOK-3231 D2) into the
 * failure evidence a real stage would report. This is the only fixture-
 * specific knowledge; the outcome itself comes from `classifyFailure`.
 *
 * Fixtures with no `failure` block are the no-fault control; the agent is
 * reported as progressing and no retry is spent.
 */
export function faultModelFromFixture(fixture: IncidentReplayFixture): FaultModel {
  const f = fixture.failure;
  if (!f) return { survivesRelaunches: 0, progressing: true };
  const survives = f.survivesRelaunches === 'never' ? Infinity : f.survivesRelaunches;
  return {
    detail: f.detail,
    ...(f.failureKind ? { failureKind: f.failureKind } : {}),
    survivesRelaunches: survives,
    ...(f.progressing !== undefined ? { progressing: f.progressing } : {}),
  };
}

function writeEscalation(ctx: SandboxContext, fixture: IncidentReplayFixture, decision: ReplayRecoveryDecision): ConvergenceEvidence {
  const needsAttention = escalationMarkerPath(ctx.featureDir);
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
 * Apply the live task-recovery controller's decision to one replay tick, then
 * map it onto the harness's action vocabulary and perform the bounded-retry
 * side effect the chosen action implies.
 *
 * The decision itself is the controller's ({@link decideTaskRecovery}, HOK-3277)
 * — the single named/versioned policy that composes `classifyFailure` and the
 * bounded-retry verdict. This function owns only the fixture-specific side of
 * a replay: the `retry` bridge (the production `bounded-retry.sh`, scoped to the
 * fixture's temp state dir, zero backoff for determinism) and the translation
 * to the harness `RecoveryActionKind` the convergence oracle reads. It
 * reimplements no counter and no ranking of its own.
 */
function replayRecoveryTick(
  ctx: SandboxContext,
  stage: FailureStage,
  model: FaultModel,
  progressing: boolean,
  retry: StateDirRetry,
): ReplayRecoveryDecision {
  if (progressing) {
    return { action: 'skip', rationale: 'agent progressing; stage completes' };
  }
  const failure = classifyFailure({
    stage,
    failureKind: model.failureKind ?? null,
    detail: model.detail ?? '',
  });
  const base = { failureKind: failure.failureKind, nextAction: failure.nextAction };
  // The bounded-retry verdict is a pure read; only the chosen action mutates
  // the bucket below. The controller ranks terminal / code-failure / retryable
  // and, within retryable, proceed / backoff / exhausted.
  const replayHead = 'deadbeef';
  const verdict = retry.gate(ctx.featureDir, replayHead);
  const decision = decideTaskRecovery({
    issue: 'replay',
    stage,
    attempt: { currentRunId: null, controlRunId: null },
    disposition: null,
    stageResult: { kind: 'failed' },
    contractAvailable: stage === 'coding' ? true : null,
    outstandingEffect: null,
    wait: null,
    failure: { decision: failure, retry: verdict },
  });
  const bucket = decision.retryBucket ?? failure.retryBucket ?? `stage-failure-${stage}`;

  switch (decision.action) {
    case 'escalate':
      if (decision.escalationBasis?.kind === 'policy-terminal') {
        return { ...base, action: 'settle-aborted', rationale: decision.rationale };
      }
      if (verdict === 'exhausted') {
        retry.markExhausted(ctx.featureDir, `replay stage failure exhausted: ${stage}:${failure.failureKind}`);
      }
      return { ...base, action: 'escalate-waiting-on', retryBucket: bucket, rationale: decision.rationale };
    case 'remediate':
      // Code failures carry no retry bucket: the live policy hands their
      // excerpt to remediation, which produces a new head before any retry.
      return { ...base, action: 'spawn-remediation', rationale: decision.rationale };
    case 'retry-stage': {
      retry.increment(ctx.featureDir, replayHead);
      const attempt = retry.count(ctx.featureDir);
      const fresh = attempt >= DEFAULT_RETRY_ATTEMPTS;
      return {
        ...base,
        action: 'bounded-relaunch',
        retryBucket: bucket,
        rationale: `${decision.rationale}; ${fresh ? 'fresh relaunch from row inputs' : 'bounded retry'} ${attempt}/${DEFAULT_RETRY_ATTEMPTS}`,
      };
    }
    case 'wait':
      // The only wait a zero-backoff replay can produce is a backoff hold,
      // which must not happen with backoff disabled.
      throw new Error(`replay recovery unexpectedly waited (${decision.rationale})`);
    default:
      throw new Error(`replay recovery got a non-dispatchable controller action: ${decision.action}`);
  }
}

/**
 * Drive the fixture with the real recovery ladder. Each tick, if the fault has
 * cleared (or the agent is progressing) the task merges, otherwise
 * `replayRecoveryTick` runs the controller's `decideTaskRecovery` and maps its
 * action: a relaunch spends the live budget and starts a new attempt, an
 * escalation or a terminal settle converges as escalated.
 */
export function runWithRecoveryLoop(ctx: SandboxContext, fixture: IncidentReplayFixture): RunResult {
  const model = faultModelFromFixture(fixture);
  const actions: RecoveryActionKind[] = [];
  let relaunches = 0;
  const stage: FailureStage = fixture.failure?.stage ?? fixture.initialState.task.phase;
  const retry = createStateDirRetry(`stage-failure-${stage}`, {
    maxAttempts: DEFAULT_RETRY_ATTEMPTS,
    backoff: { baseSeconds: 0, capSeconds: 0 },
  });

  for (let i = 0; i < fixture.convergence.maxTickCount; i++) {
    ctx.clock.advance(fixture.convergence.tickIntervalSeconds * 1000);
    const recovered = relaunches > model.survivesRelaunches;
    const progressing = model.progressing === true || recovered;
    const decision = replayRecoveryTick(ctx, stage, model, progressing, retry);
    actions.push(decision.action);

    switch (decision.action) {
      case 'skip':
        if (progressing) {
          const merged = writeMerged(ctx);
          return { converged: true, outcome: 'merged', ticks: i + 1, failureStage: stage, evidencePath: merged.evidencePath, actions };
        }
        break;
      case 'bounded-relaunch':
      case 'spawn-remediation':
        relaunches += 1;
        break;
      case 'escalate-waiting-on':
      case 'settle-aborted': {
        const escalated = writeEscalation(ctx, fixture, decision);
        return { converged: true, outcome: 'escalated', ticks: i + 1, failureStage: stage, evidencePath: escalated.evidencePath, actions };
      }
    }
  }
  const last = detectConvergence(ctx);
  return { converged: last.outcome !== 'pending', outcome: last.outcome, ticks: fixture.convergence.maxTickCount, failureStage: stage, evidencePath: last.evidencePath, actions };
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

// ── real-fixture replay (HOK-3231) ──────────────────────────────────────────

export interface IncidentCycleCycleRecord {
  cycle: number;
  /** Whether this snapshot was taken after an observation, rather than an absence tick. */
  observed: boolean;
  observedAt: string;
  lifecycle: IncidentLifecycle | null;
  rootCauseClass: string | null;
  category: string | null;
  occurrenceCount: number;
  resolutionReason: string | null;
  recurrenceCount: number;
}

export interface IncidentCycleResult {
  cycles: IncidentCycleCycleRecord[];
  rootCauseClass: string | null;
  category: string | null;
  lifecycleWhilePresent: IncidentLifecycle | null;
  finalLifecycle: IncidentLifecycle | null;
  resolutionReasonPrefix: string | null;
  occurrenceCount: number;
  recurrences: number;
}

/**
 * Replay the real-fixture observation timeline through a sandboxed
 * `IncidentStore` + `reconcileIncidentCycle`. Pure under test: readers are
 * injected so no `gh` or network IO happens.
 */
export async function runIncidentCycleReplay(fixture: IncidentFixture): Promise<IncidentCycleResult> {
  const dir = mkdtempSync(join(tmpdir(), 'wm-incident-'));
  const incidentsDir = join(dir, '.wavemill', 'incidents');
  mkdirSync(incidentsDir, { recursive: true });

  // allow-task-literal: synthetic sandbox state for a single-task fixture, not workflow-state read by production code
  const metadata = fixture.incident.metadata;
  const replayJobStartedAt = fixture.observations
    .flatMap((observation) => observation.evidence)
    .find((evidence) => evidence.type === 'job_state')?.timestamp ?? '2026-10-10T10:00:00Z';
  const jobs = Object.fromEntries(fixture.initialState.jobs.map((job) => [job.id, {
    ...job,
    taskId: fixture.initialState.task.issue,
    pairId: job.pair ?? (typeof metadata.pairId === 'string' ? metadata.pairId : undefined),
    side: job.side ?? (typeof metadata.side === 'string' ? metadata.side : undefined),
    resultPath: job.resultPath ?? (typeof metadata.resultPath === 'string' ? metadata.resultPath : undefined),
    startedAt: replayJobStartedAt,
  }]));
  // Job-backed reconciliation treats a successful row as a claim, not proof:
  // it requires the job's persisted result artifact too. Materialise that
  // artifact in the sandbox exactly as the job tracker would.
  for (const job of Object.values(jobs) as Array<{ status?: string; resultPath?: string }>) {
    if (job.status !== 'succeeded' || !job.resultPath) continue;
    const path = job.resultPath.startsWith('/') ? job.resultPath : join(dir, job.resultPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ok: true, exitCode: 0, persisted: true }));
  }
  writeFileSync(join(dir, '.wavemill', 'workflow-state.json'), JSON.stringify({
    tasks: {
      [fixture.initialState.task.issue]: {
        slug: fixture.initialState.task.slug,
        phase: fixture.initialState.task.phase,
        status: fixture.initialState.task.status,
      },
    },
    jobs,
  }));

  try {
    // Fixed start to keep IncidentStore timestamps reproducible within a replay.
    let nowMs = Date.parse('2026-10-10T10:00:00Z');
    const store = new IncidentStore(incidentsDir, {
      escalationThreshold: 3,
      resolutionAfterCycles: 5,
      now: () => new Date(nowMs),
    });

    const cycles: IncidentCycleCycleRecord[] = [];
    let cycleIndex = 0;
    const advanceCycle = () => { nowMs += 120_000; cycleIndex += 1; };

    // Injectable readers prevent any `gh` reads from the recovery predicate.
    const noReaders = {
      readReview: () => null,
      readPr: () => null,
      comparisonSucceeded: () => false,
      currentHeadEval: () => false,
    };

    // The in-sandbox fingerprint is derived from the sanitised candidate, so
    // it differs from the recorded fingerprint; we discover it on first upsert.
    let sandboxFingerprint: string | null = null;
    const runCycle = async (candidates: ReturnType<typeof buildCandidate>[]): Promise<void> => {
      advanceCycle();
      const r = await reconcileIncidentCycle({
        store,
        candidates,
        cycleComplete: true,
        repoDir: dir,
        recoveryReaders: noReaders,
      });
      if (!sandboxFingerprint && r.incidents.length > 0) {
        sandboxFingerprint = r.incidents[0].fingerprint;
      }
      cycles.push(await snapshotCycle(cycleIndex, sandboxFingerprint ?? undefined, incidentsDir, candidates.length > 0));
    };

    const candidateTemplate = () => buildCandidate(fixture);

    for (const obs of fixture.observations) {
      for (let i = 0; i < obs.absentCyclesBefore; i += 1) {
        await runCycle([]);
      }
      const draft = candidateTemplate();
      // Attach this cycle's evidence identities (they drive the event-key dedup).
      draft.evidence = obs.evidence.map((ev) => ({
        type: ev.type as never,
        source: ev.source,
        timestamp: ev.timestamp,
        redactedData: ev.redactedData,
        ...(ev.key ? { key: ev.key } : {}),
      })) as never;
      await runCycle([draft]);
    }
    for (let i = 0; i < fixture.trailingAbsentCycles; i += 1) {
      await runCycle([]);
    }

    const finalCycle = cycles[cycles.length - 1];
    const lastObservedCycle = [...cycles].reverse().find((cycle) => cycle.observed);
    return {
      cycles,
      rootCauseClass: finalCycle?.rootCauseClass ?? null,
      category: finalCycle?.category ?? null,
      lifecycleWhilePresent: lastObservedCycle?.lifecycle ?? null,
      finalLifecycle: finalCycle?.lifecycle ?? null,
      resolutionReasonPrefix: finalCycle?.resolutionReason
        ? finalCycle.resolutionReason.startsWith('current_disposition:')
          ? 'current_disposition:'
          : finalCycle.resolutionReason.startsWith('not re-observed')
            ? 'not re-observed'
            : null
        : null,
      occurrenceCount: finalCycle?.occurrenceCount ?? 0,
      recurrences: finalCycle?.recurrenceCount ?? 0,
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function buildCandidate(fixture: IncidentFixture): ReturnType<typeof createIncidentDraft> {
  return createIncidentDraft({
    taskId: fixture.initialState.task.issue,
    category: fixture.incident.category,
    severity: fixture.incident.severity,
    confidence: fixture.incident.confidence,
    lifecycle: 'observed',
    rootCauseClass: fixture.incident.rootCauseClass,
    summary: fixture.incident.summary,
    operatorAction: fixture.incident.operatorAction,
    evidence: [],
    metadata: { ...fixture.incident.metadata },
  });
}

async function snapshotCycle(
  cycleIndex: number,
  fingerprint: string | undefined,
  incidentsDir: string,
  observed: boolean,
): Promise<IncidentCycleCycleRecord> {
  const observedAt = new Date().toISOString();
  const empty = (): IncidentCycleCycleRecord => ({ cycle: cycleIndex, observed, observedAt, lifecycle: null, rootCauseClass: null, category: null, occurrenceCount: 0, resolutionReason: null, recurrenceCount: 0 });
  if (!fingerprint) return empty();
  // `IncidentStore.getIncidents` filters resolved records out, which the
  // replay needs to assert on. Reading the index directly keeps the cycle
  // snapshot straightforward without adding a replay-only store method.
  const indexPath = join(incidentsDir, 'index.json');
  if (!existsSync(indexPath)) return empty();
  try {
    const raw = JSON.parse(readFileSync(indexPath, 'utf-8')) as Record<string, ReturnType<typeof createIncidentDraft>>;
    const record = raw[fingerprint];
    if (!record) return empty();
    const resolution = record.metadata?.resolution;
    const recurrence = record.metadata?.recurrence;
    return {
      cycle: cycleIndex,
      observed,
      observedAt: record.lastObservedAt,
      lifecycle: record.lifecycle,
      rootCauseClass: record.rootCauseClass,
      category: record.category,
      occurrenceCount: record.occurrenceCount,
      resolutionReason: typeof resolution?.reason === 'string' ? resolution.reason : null,
      recurrenceCount: typeof recurrence?.count === 'number' ? recurrence.count : 0,
    };
  } catch {
    return empty();
  }
}

export interface IncidentCycleAssertion extends AssertionResult {
  mismatches: string[];
}

/** Compare the replay result against the fixture's expected oracle. */
export function assertIncidentCycle(
  result: IncidentCycleResult,
  expected: IncidentFixtureExpected,
): IncidentCycleAssertion {
  const mismatches: string[] = [];
  if (result.rootCauseClass !== expected.rootCauseClass) {
    mismatches.push(`rootCauseClass: got=${result.rootCauseClass ?? 'null'} expected=${expected.rootCauseClass}`);
  }
  if (result.category !== expected.category) {
    mismatches.push(`category: got=${result.category ?? 'null'} expected=${expected.category}`);
  }
  if (result.occurrenceCount !== expected.occurrenceCount) {
    mismatches.push(`occurrenceCount: got=${result.occurrenceCount} expected=${expected.occurrenceCount}`);
  }
  if (result.lifecycleWhilePresent !== expected.lifecycleWhilePresent) {
    mismatches.push(`lifecycleWhilePresent: got=${result.lifecycleWhilePresent ?? 'null'} expected=${expected.lifecycleWhilePresent}`);
  }
  if (result.finalLifecycle !== expected.finalLifecycle) {
    mismatches.push(`finalLifecycle: got=${result.finalLifecycle ?? 'null'} expected=${expected.finalLifecycle}`);
  }
  if ((result.resolutionReasonPrefix ?? null) !== (expected.resolutionReasonPrefix ?? null)) {
    mismatches.push(`resolutionReasonPrefix: got=${result.resolutionReasonPrefix ?? 'null'} expected=${expected.resolutionReasonPrefix ?? 'null'}`);
  }
  if (result.recurrences !== expected.recurrences) {
    mismatches.push(`recurrences: got=${result.recurrences} expected=${expected.recurrences}`);
  }
  return {
    ok: mismatches.length === 0,
    ...(mismatches.length > 0 ? { reason: mismatches.join('; ') } : {}),
    mismatches,
  };
}

export interface RealFixtureRunResult {
  fixturePath: string;
  cycle: IncidentCycleResult;
  cycleAssertion: IncidentCycleAssertion;
  recovery?: RunResult;
  recoveryAssertion?: AssertionResult;
  ok: boolean;
  reason?: string;
}

/**
 * Load a converted fixture, run the incident cycle replay (always), run the
 * stage recovery loop (when a `failure` block is present), assert both, and
 * clean up. `IncidentCycleAssertion.mismatches` lists every mismatch.
 */
export async function runRealFixture(fixturePath: string): Promise<RealFixtureRunResult> {
  const fixture = loadIncidentFixture(fixturePath);
  const cycle = await runIncidentCycleReplay(fixture);
  const cycleAssertion = assertIncidentCycle(cycle, fixture.expected);

  let recovery: RunResult | undefined;
  let recoveryAssertion: AssertionResult | undefined;
  if (fixture.failure) {
    const replayFixture: IncidentReplayFixture = {
      chain: fixture.chain,
      incidents: fixture.incidents,
      initialState: {
        task: fixture.initialState.task,
      },
      failure: {
        stage: fixture.failure.stage as FailureStage,
        failureKind: fixture.failure.failureKind,
        detail: fixture.failure.detail,
        survivesRelaunches: fixture.failure.survivesRelaunches,
        ...(fixture.failure.progressing !== undefined ? { progressing: fixture.failure.progressing } : {}),
      },
      convergence: fixture.convergence,
    };
    const clock = createInjectableClock();
    const ctx = createSandbox(replayFixture, clock);
    try {
      recovery = runWithRecoveryLoop(ctx, replayFixture);
      recoveryAssertion = assertConverged(recovery, replayFixture);
    } finally {
      try { rmSync(ctx.dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  const ok = cycleAssertion.ok && (recoveryAssertion ? recoveryAssertion.ok : true);
  const reason = ok
    ? undefined
    : [cycleAssertion.ok ? null : `cycle: ${cycleAssertion.reason}`, recoveryAssertion && !recoveryAssertion.ok ? `recovery: ${recoveryAssertion.reason}` : null]
        .filter((x): x is string => !!x)
        .join('; ');
  return {
    fixturePath,
    cycle,
    cycleAssertion,
    ...(recovery ? { recovery } : {}),
    ...(recoveryAssertion ? { recoveryAssertion } : {}),
    ok,
    ...(reason ? { reason } : {}),
  };
}
