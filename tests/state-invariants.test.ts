/**
 * HOK-3229 — unit tests for the live workflow-state invariant checker.
 *
 * Each case constructs an in-memory `EvaluateInvariantsInputs` (no filesystem)
 * and asserts the exact set of `violations[].invariantId` values.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskProgress } from '../shared/lib/task-progress.ts';
import type { CachedPullRequest } from '../shared/lib/session-gh-cache.ts';
import type {
  MergeLabelLiveState,
  MergeLabelTaskView,
} from '../shared/lib/merge-labels.ts';
import type { WorkflowState } from '../shared/lib/workflow-state.ts';
import { buildWorkflowState } from './lib/task-builder.ts';
import {
  checkInvariant1Progress,
  checkInvariant2Slots,
  checkInvariant3LabelMismatch,
  checkInvariant4ReadyStuck,
  checkInvariant5StaleMarker,
  checkInvariant6Schema,
  checkInvariant7MissingConditionCompanion,
  checkInvariant8BakeGate,
  createEmptyCache,
  evaluateInvariants,
  expiredTriggerForSidecar,
  isOrphanStub,
  parseConditionSidecar,
  DEFAULT_INVARIANT_CONFIG,
  type EvaluateInvariantsInputs,
  type InvariantViolation,
  type StateInvariantsCache,
  type ConditionSidecarInfo,
  type RetrySentinelInfo,
  type WaitingOnEvidence,
  type TendHeartbeat,
} from '../shared/lib/state-invariants.ts';

const NOW_MS = Date.parse('2026-10-19T14:00:00Z');
const NOW_ISO = new Date(NOW_MS).toISOString();

// ── Fixture builders ────────────────────────────────────────────────────────

interface InputsOverrides {
  state?: WorkflowState;
  taskProgress?: Map<string, TaskProgress>;
  prs?: CachedPullRequest[];
  taskViews?: Map<number, MergeLabelTaskView | null>;
  liveStates?: Map<number, MergeLabelLiveState | null>;
  conditionSidecars?: ConditionSidecarInfo[];
  retrySentinels?: RetrySentinelInfo[];
  waitingOnByTaskId?: Map<string, WaitingOnEvidence>;
  cache?: StateInvariantsCache;
  worktreeHeads?: Map<string, string>;
  operatorSeq?: Map<string, number>;
  prHeadByNumber?: Map<number, string>;
  prNumberByTaskId?: Map<string, number>;
  nowMs?: number;
  config?: Partial<typeof DEFAULT_INVARIANT_CONFIG>;
  recentMainCommits?: Array<{ sha: string; committedAtMs: number; files: string[] }>;
  tendHeartbeat?: TendHeartbeat | null;
}

function makeInputs(overrides: InputsOverrides = {}): EvaluateInvariantsInputs {
  return {
    state: overrides.state ?? {},
    taskProgress: overrides.taskProgress ?? new Map(),
    prs: overrides.prs ?? [],
    taskViews: overrides.taskViews ?? new Map(),
    liveStates: overrides.liveStates ?? new Map(),
    conditionSidecars: overrides.conditionSidecars ?? [],
    retrySentinels: overrides.retrySentinels ?? [],
    waitingOnByTaskId: overrides.waitingOnByTaskId ?? new Map(),
    cache: overrides.cache ?? createEmptyCache(),
    stateInspection: {
      worktreeHeadsByTaskId: overrides.worktreeHeads ?? new Map(),
      operatorEventSeqByTaskId: overrides.operatorSeq ?? new Map(),
      prHeadByNumber: overrides.prHeadByNumber ?? new Map(),
      prNumberByTaskId: overrides.prNumberByTaskId ?? new Map(),
      nowMs: overrides.nowMs ?? NOW_MS,
    },
    config: overrides.config,
    recentMainCommits: overrides.recentMainCommits,
    tendHeartbeat: overrides.tendHeartbeat ?? null,
  };
}

function makeProgress(partial: Partial<TaskProgress> & { issue: string }): TaskProgress {
  return {
    issue: partial.issue,
    computedAt: partial.computedAt ?? NOW_ISO,
    lastProgressAt: partial.lastProgressAt ?? null,
    progressAgeMinutes: partial.progressAgeMinutes ?? null,
    sources: partial.sources ?? [],
    agentState: partial.agentState ?? null,
    agentRecord: partial.agentRecord ?? null,
    controllerState: partial.controllerState ?? null,
    agentIdle: partial.agentIdle ?? false,
    terminal: partial.terminal ?? false,
    terminalIdle: partial.terminalIdle ?? false,
    agentProcessLive: partial.agentProcessLive ?? null,
    agentBackgroundLive: partial.agentBackgroundLive ?? null,
    backgroundProcesses: partial.backgroundProcesses ?? [],
    stalled: partial.stalled ?? false,
    stallMinutes: partial.stallMinutes ?? 30,
    blockingPrompt: partial.blockingPrompt ?? null,
  };
}

function makeTaskView(prNumber: number, overrides: Partial<MergeLabelTaskView> = {}): MergeLabelTaskView {
  return {
    prNumber,
    headSha: overrides.headSha ?? 'abc123',
    phase: overrides.phase ?? 'ready',
    featureDir: overrides.featureDir ?? '/tmp/feat',
    linearIssueId: overrides.linearIssueId,
    challengeRole: overrides.challengeRole,
  };
}

function makeLiveReady(sha = 'abc123'): MergeLabelLiveState {
  return {
    prHeadSha: sha,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS', status: 'COMPLETED' }],
    readyAtHead: { verdict: 'ready', sha },
    handoffAtHead: { state: 'ready-published', headSha: sha, prNumber: 100 },
  };
}

function makeLiveBlocked(sha = 'abc123'): MergeLabelLiveState {
  return {
    prHeadSha: sha,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ name: 'ci', conclusion: 'FAILURE', status: 'COMPLETED' }],
    readyAtHead: { verdict: 'ready', sha },
    handoffAtHead: { state: 'ready-published', headSha: sha, prNumber: 100 },
  };
}

// ── 1: clean-state → [] ─────────────────────────────────────────────────────

test('clean state produces no violations', () => {
  const inputs = makeInputs({
    state: buildWorkflowState({
      'HOK-1': {
        phase: 'ready',
        status: 'running',
        slug: 'foo',
      },
    }, { bare: true }),
    taskProgress: new Map([
      ['HOK-1', makeProgress({ issue: 'HOK-1', stalled: false })],
    ]),
    waitingOnByTaskId: new Map([['HOK-1', { hasWaitingOnMarker: false }]]),
  });
  const { violations } = evaluateInvariants(inputs);
  assert.equal(violations.length, 0);
});

// ── 2–4: I1 progress ────────────────────────────────────────────────────────

test('I1 fires for a stalled non-terminal task with no waiting-on marker', () => {
  const inputs = makeInputs({
    state: buildWorkflowState({
      'HOK-2': { phase: 'coding', status: 'running', slug: 'bar' },
    }, { bare: true }),
    taskProgress: new Map([
      ['HOK-2', makeProgress({ issue: 'HOK-2', stalled: true, stallMinutes: 30, progressAgeMinutes: 60 })],
    ]),
    waitingOnByTaskId: new Map([['HOK-2', { hasWaitingOnMarker: false }]]),
  });
  const out: InvariantViolation[] = [];
  checkInvariant1Progress(inputs, out);
  assert.equal(out.length, 1);
  assert.equal(out[0].invariantId, 'I1-progress');
  assert.equal(out[0].taskId, 'HOK-2');
});

test('I1 does not fire when a waiting-on marker is present', () => {
  const inputs = makeInputs({
    state: buildWorkflowState({
      'HOK-3': { phase: 'coding', status: 'running', slug: 'bar' },
    }, { bare: true }),
    taskProgress: new Map([
      ['HOK-3', makeProgress({ issue: 'HOK-3', stalled: true, stallMinutes: 30 })],
    ]),
    waitingOnByTaskId: new Map([['HOK-3', { hasWaitingOnMarker: true, detail: '.needs-attention' }]]),
  });
  const out: InvariantViolation[] = [];
  checkInvariant1Progress(inputs, out);
  assert.equal(out.length, 0);
});

test('I1 skips terminal (phase=aborted) tasks', () => {
  const inputs = makeInputs({
    state: buildWorkflowState({
      'HOK-4': { phase: 'aborted', status: 'aborted', slug: 'bar' },
    }, { bare: true }),
    taskProgress: new Map([
      ['HOK-4', makeProgress({ issue: 'HOK-4', stalled: true, stallMinutes: 30 })],
    ]),
  });
  const out: InvariantViolation[] = [];
  checkInvariant1Progress(inputs, out);
  assert.equal(out.length, 0);
});

test('I1 signature is stable across ticks for the same stall (notification only on first)', () => {
  // Same stall, two monitor ticks: stallMinutes rises (30 → 31) but
  // lastProgressAt is unchanged. The signature must stay the same so the
  // JSONL + observer appender treat the second emission as a repeat.
  const base = {
    state: buildWorkflowState({ 'HOK-9': { phase: 'coding', status: 'running', slug: 'bar' } }, { bare: true }),
    waitingOnByTaskId: new Map([['HOK-9', { hasWaitingOnMarker: false }]]),
  };
  const first = evaluateInvariants(
    makeInputs({
      ...base,
      taskProgress: new Map([
        [
          'HOK-9',
          makeProgress({
            issue: 'HOK-9',
            stalled: true,
            stallMinutes: 30,
            progressAgeMinutes: 60,
            lastProgressAt: '2026-10-18T00:00:00Z',
          }),
        ],
      ]),
    }),
  );
  const i1a = first.violations.find((v) => v.invariantId === 'I1-progress');
  assert.ok(i1a);
  const sigA = i1a!.signature;

  const second = evaluateInvariants(
    makeInputs({
      ...base,
      cache: first.nextCache,
      taskProgress: new Map([
        [
          'HOK-9',
          makeProgress({
            issue: 'HOK-9',
            stalled: true,
            stallMinutes: 31,
            progressAgeMinutes: 61,
            lastProgressAt: '2026-10-18T00:00:00Z',
          }),
        ],
      ]),
    }),
  );
  const i1b = second.violations.find((v) => v.invariantId === 'I1-progress');
  assert.ok(i1b);
  assert.equal(i1b!.signature, sigA, 'rising stallMinutes must not mint a fresh signature');
  // Confirm the GC pass preserves the signature while the stall persists.
  assert.ok(second.nextCache.signatures[sigA], 'signature must survive GC while violation persists');
});

// ── 5: I2 orphan stub ───────────────────────────────────────────────────────

test('I2 fires for an orphan stub row', () => {
  const inputs = makeInputs({
    state: buildWorkflowState({
      'HOK-9999': {}, // orphan stub (all fields missing)
      'HOK-5': { phase: 'ready', status: 'running', slug: 'ok' },
    }, { bare: true }),
  });
  const out: InvariantViolation[] = [];
  checkInvariant2Slots(inputs, out);
  assert.equal(out.length, 1);
  assert.equal(out[0].invariantId, 'I2-slots');
  assert.equal(out[0].taskId, 'HOK-9999');
});

test('isOrphanStub recognises empty row', () => {
  assert.equal(isOrphanStub({}), true);
  assert.equal(isOrphanStub({ phase: 'ready' }), false);
  assert.equal(isOrphanStub({ slug: 'x' }), false);
  assert.equal(isOrphanStub({ lifecycle: {} }), false);
});

// ── 6–7: I3 label mismatch streak ───────────────────────────────────────────

test('I3 fires only after 3 consecutive ticks of mismatch', () => {
  const sha = 'deadbeef';
  const basePr: CachedPullRequest = {
    number: 100,
    state: 'OPEN',
    headRefOid: sha,
    labels: [{ name: 'wm:blocked' }],
    updatedAt: NOW_ISO,
    statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS', status: 'COMPLETED' }],
  };
  const buildInputs = (cache: StateInvariantsCache) =>
    makeInputs({
      prs: [basePr],
      taskViews: new Map([[100, makeTaskView(100, { headSha: sha })]]),
      liveStates: new Map([[100, makeLiveReady(sha)]]),
      cache,
    });
  let cache = createEmptyCache();
  let out: InvariantViolation[] = [];
  // Tick 1
  const first = evaluateInvariants(buildInputs(cache));
  cache = first.nextCache;
  assert.equal(first.violations.filter((v) => v.invariantId === 'I3-label-mismatch').length, 0);
  // Tick 2
  const second = evaluateInvariants(buildInputs(cache));
  cache = second.nextCache;
  assert.equal(second.violations.filter((v) => v.invariantId === 'I3-label-mismatch').length, 0);
  // Tick 3 — fires
  const third = evaluateInvariants(buildInputs(cache));
  cache = third.nextCache;
  const mismatches = third.violations.filter((v) => v.invariantId === 'I3-label-mismatch');
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].prNumber, 100);

  // Tick 4 — mismatch cleared (new PR state, label flipped to wm:ready)
  const resolvedPr: CachedPullRequest = { ...basePr, labels: [{ name: 'wm:ready' }] };
  const resolvedInputs = makeInputs({
    prs: [resolvedPr],
    taskViews: new Map([[100, makeTaskView(100, { headSha: sha })]]),
    liveStates: new Map([[100, makeLiveReady(sha)]]),
    cache,
  });
  const fourth = evaluateInvariants(resolvedInputs);
  assert.equal(fourth.violations.filter((v) => v.invariantId === 'I3-label-mismatch').length, 0);
  assert.equal(fourth.nextCache.pr['100'].labelMismatchStreak, 0);
  out = fourth.violations;
  assert.ok(out.every((v) => v.invariantId !== 'I3-label-mismatch'));
});

test('I3 streak resets when headSha changes', () => {
  const basePr: CachedPullRequest = {
    number: 100,
    state: 'OPEN',
    headRefOid: 'old',
    labels: [{ name: 'wm:blocked' }],
    updatedAt: NOW_ISO,
    statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS', status: 'COMPLETED' }],
  };
  const cache0 = createEmptyCache();
  const first = evaluateInvariants(
    makeInputs({
      prs: [basePr],
      taskViews: new Map([[100, makeTaskView(100, { headSha: 'old' })]]),
      liveStates: new Map([[100, makeLiveReady('old')]]),
      cache: cache0,
    }),
  );
  const cache1 = first.nextCache;
  assert.equal(cache1.pr['100'].labelMismatchStreak, 1);
  // Second tick: mismatch persists but headSha moved.
  const newHeadPr: CachedPullRequest = { ...basePr, headRefOid: 'new' };
  const second = evaluateInvariants(
    makeInputs({
      prs: [newHeadPr],
      taskViews: new Map([[100, makeTaskView(100, { headSha: 'new' })]]),
      liveStates: new Map([[100, makeLiveReady('new')]]),
      cache: cache1,
    }),
  );
  assert.equal(second.nextCache.pr['100'].labelMismatchStreak, 1);
  assert.equal(second.violations.filter((v) => v.invariantId === 'I3-label-mismatch').length, 0);
});

test('I3 does not fire when derived label is wm:blocked and PR already has wm:blocked', () => {
  const sha = 'abc';
  const pr: CachedPullRequest = {
    number: 101,
    state: 'OPEN',
    headRefOid: sha,
    labels: [{ name: 'wm:blocked' }],
    updatedAt: NOW_ISO,
    statusCheckRollup: [{ name: 'ci', conclusion: 'FAILURE', status: 'COMPLETED' }],
  };
  const inputs = makeInputs({
    prs: [pr],
    taskViews: new Map([[101, makeTaskView(101, { headSha: sha })]]),
    liveStates: new Map([[101, makeLiveBlocked(sha)]]),
    cache: createEmptyCache(),
  });
  const out: InvariantViolation[] = [];
  checkInvariant3LabelMismatch(inputs, out, createEmptyCache(), { ...DEFAULT_INVARIANT_CONFIG });
  assert.equal(out.filter((v) => v.invariantId === 'I3-label-mismatch').length, 0);
});

// ── 8–10: I4 Ready-stuck (HOK-3212 replay) ──────────────────────────────────

test('I4 fires when Ready-pass PR has no wm:ready and is older than threshold', () => {
  const sha = 'xyz';
  const olderIso = new Date(NOW_MS - 20 * 60_000).toISOString();
  const pr: CachedPullRequest = {
    number: 1234,
    state: 'OPEN',
    headRefOid: sha,
    labels: [{ name: 'wm:task' }],
    updatedAt: olderIso,
    statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS', status: 'COMPLETED' }],
  };
  const inputs = makeInputs({
    prs: [pr],
    taskViews: new Map([[1234, makeTaskView(1234, { headSha: sha })]]),
    liveStates: new Map([[1234, makeLiveReady(sha)]]),
  });
  const out: InvariantViolation[] = [];
  checkInvariant4ReadyStuck(inputs, out, DEFAULT_INVARIANT_CONFIG);
  assert.equal(out.length, 1);
  assert.equal(out[0].invariantId, 'I4-ready-stuck');
  assert.equal(out[0].prNumber, 1234);
  const evidence = out[0].evidence as { labels: string[]; ageMinutes: number };
  assert.deepEqual(evidence.labels, ['wm:task']);
  assert.ok(evidence.ageMinutes >= 20);
});

test('I4 does not fire when PR has wm:ready', () => {
  const sha = 'xyz';
  const olderIso = new Date(NOW_MS - 20 * 60_000).toISOString();
  const pr: CachedPullRequest = {
    number: 1234,
    state: 'OPEN',
    headRefOid: sha,
    labels: [{ name: 'wm:ready' }],
    updatedAt: olderIso,
    statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS', status: 'COMPLETED' }],
  };
  const inputs = makeInputs({
    prs: [pr],
    taskViews: new Map([[1234, makeTaskView(1234, { headSha: sha })]]),
    liveStates: new Map([[1234, makeLiveReady(sha)]]),
  });
  const out: InvariantViolation[] = [];
  checkInvariant4ReadyStuck(inputs, out, DEFAULT_INVARIANT_CONFIG);
  assert.equal(out.length, 0);
});

test('I4 does not fire inside the grace window', () => {
  const sha = 'xyz';
  const recentIso = new Date(NOW_MS - 2 * 60_000).toISOString();
  const pr: CachedPullRequest = {
    number: 1234,
    state: 'OPEN',
    headRefOid: sha,
    labels: [{ name: 'wm:task' }],
    updatedAt: recentIso,
    statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS', status: 'COMPLETED' }],
  };
  const inputs = makeInputs({
    prs: [pr],
    taskViews: new Map([[1234, makeTaskView(1234, { headSha: sha })]]),
    liveStates: new Map([[1234, makeLiveReady(sha)]]),
  });
  const out: InvariantViolation[] = [];
  checkInvariant4ReadyStuck(inputs, out, DEFAULT_INVARIANT_CONFIG);
  assert.equal(out.length, 0);
});

// ── 11–12: I5 stale condition marker (with grace-tick) ─────────────────────

test('I5 fires only after the configured grace ticks', () => {
  const sidecar: ConditionSidecarInfo = {
    taskId: 'HOK-5',
    path: '/tmp/state/.needs-attention-condition.json',
    raw: {},
    expiresOn: ['head'],
    recordedHead: 'old',
  };
  const worktreeHeads = new Map([['HOK-5', 'new']]);
  const build = (cache: StateInvariantsCache) =>
    makeInputs({
      conditionSidecars: [sidecar],
      worktreeHeads,
      cache,
    });
  let cache = createEmptyCache();
  const first = evaluateInvariants(build(cache));
  cache = first.nextCache;
  assert.equal(first.violations.filter((v) => v.invariantId === 'I5-stale-marker').length, 0);
  const second = evaluateInvariants(build(cache));
  const stale = second.violations.filter((v) => v.invariantId === 'I5-stale-marker');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].taskId, 'HOK-5');
});

test('I5 does not fire for a sidecar whose head still matches', () => {
  const sidecar: ConditionSidecarInfo = {
    taskId: 'HOK-6',
    path: '/tmp/state/.needs-attention-condition.json',
    raw: {},
    expiresOn: ['head'],
    recordedHead: 'same',
  };
  const inputs = makeInputs({
    conditionSidecars: [sidecar],
    worktreeHeads: new Map([['HOK-6', 'same']]),
  });
  const out: InvariantViolation[] = [];
  checkInvariant5StaleMarker(inputs, out, createEmptyCache(), DEFAULT_INVARIANT_CONFIG);
  assert.equal(out.length, 0);
});

test('expiredTriggerForSidecar handles deadline, operator-event, remote', () => {
  const past = new Date(NOW_MS - 60_000).toISOString();
  assert.equal(
    expiredTriggerForSidecar(
      { taskId: 't', path: '/x', raw: null, expiresOn: ['deadline'], recordedDeadline: past },
      {
        worktreeHeadsByTaskId: new Map(),
        operatorEventSeqByTaskId: new Map(),
        prHeadByNumber: new Map(),
        prNumberByTaskId: new Map(),
        nowMs: NOW_MS,
      },
    ),
    `deadline:${past}`,
  );
  assert.equal(
    expiredTriggerForSidecar(
      { taskId: 't', path: '/x', raw: null, expiresOn: ['operator-event'], recordedOperatorEventSeq: 0 },
      {
        worktreeHeadsByTaskId: new Map(),
        operatorEventSeqByTaskId: new Map([['t', 5]]),
        prHeadByNumber: new Map(),
        prNumberByTaskId: new Map(),
        nowMs: NOW_MS,
      },
    ),
    'operator-event:0→5',
  );
  const remote = expiredTriggerForSidecar(
    { taskId: 't', path: '/x', raw: null, expiresOn: ['remote'], recordedPrHeadOid: 'aaaaaaaa' },
    {
      worktreeHeadsByTaskId: new Map(),
      operatorEventSeqByTaskId: new Map(),
      prHeadByNumber: new Map([[1, 'bbbbbbbb']]),
      prNumberByTaskId: new Map([['t', 1]]),
      nowMs: NOW_MS,
    },
  );
  assert.ok(remote?.startsWith('remote:'));
});

test('I5 remote expiry does not false-positive on unrelated PRs', () => {
  // Sidecar belongs to task A with PR 1 (head still matches recorded).
  // PR 2 (unrelated task B) has a different head — must NOT trigger.
  const remote = expiredTriggerForSidecar(
    { taskId: 'A', path: '/x', raw: null, expiresOn: ['remote'], recordedPrHeadOid: 'aaaaaaaa' },
    {
      worktreeHeadsByTaskId: new Map(),
      operatorEventSeqByTaskId: new Map(),
      prHeadByNumber: new Map([
        [1, 'aaaaaaaa'],
        [2, 'bbbbbbbb'],
      ]),
      prNumberByTaskId: new Map([['A', 1]]),
      nowMs: NOW_MS,
    },
  );
  assert.equal(remote, null);
});

// ── 13: I6 schema validation ────────────────────────────────────────────────

test('I6 fires when a task record violates the A1 schema', () => {
  // phase must be a string per the schema; a number is a clean violation.
  const inputs = makeInputs({
    state: {
      // allow-task-literal: deliberately schema-violating row (phase must be a string)
      tasks: {
        'HOK-7': { phase: 123, slug: 'ok' } as never,
      },
    },
  });
  const out: InvariantViolation[] = [];
  checkInvariant6Schema(inputs, out);
  const schemaViolations = out.filter((v) => v.invariantId === 'I6-schema');
  assert.ok(schemaViolations.length >= 1);
});

// ── 14–15: I7 missing condition companion ───────────────────────────────────

test('I7 fires for exhausted sentinel without companion', () => {
  const sentinel: RetrySentinelInfo = {
    taskId: 'HOK-8',
    bucket: 'coding-dirty-handoff',
    exhaustedPath: '/tmp/x/.retry-coding-dirty-handoff-exhausted',
    exhaustedExists: true,
    conditionPath: '/tmp/x/.retry-coding-dirty-handoff-exhausted-condition.json',
    conditionExists: false,
  };
  const inputs = makeInputs({ retrySentinels: [sentinel] });
  const out: InvariantViolation[] = [];
  checkInvariant7MissingConditionCompanion(inputs, out);
  assert.equal(out.length, 1);
  assert.equal(out[0].invariantId, 'I7-missing-condition-companion');
  assert.equal(out[0].taskId, 'HOK-8');
});

test('I7 does not fire when companion exists', () => {
  const sentinel: RetrySentinelInfo = {
    taskId: 'HOK-9',
    bucket: 'coding-dirty-handoff',
    exhaustedPath: '/tmp/x/.retry-coding-dirty-handoff-exhausted',
    exhaustedExists: true,
    conditionPath: '/tmp/x/.retry-coding-dirty-handoff-exhausted-condition.json',
    conditionExists: true,
  };
  const inputs = makeInputs({ retrySentinels: [sentinel] });
  const out: InvariantViolation[] = [];
  checkInvariant7MissingConditionCompanion(inputs, out);
  assert.equal(out.length, 0);
});

// ── Signature dedup ─────────────────────────────────────────────────────────

test('signatures persist across evaluate() calls and are garbage-collected on recovery', () => {
  const sentinel: RetrySentinelInfo = {
    taskId: 'HOK-10',
    bucket: 'x',
    exhaustedPath: '/tmp/x/.retry-x-exhausted',
    exhaustedExists: true,
    conditionPath: '/tmp/x/.retry-x-exhausted-condition.json',
    conditionExists: false,
  };
  const first = evaluateInvariants(makeInputs({ retrySentinels: [sentinel] }));
  assert.equal(first.violations.length, 1);
  const sig = first.violations[0].signature;
  assert.ok(sig in first.nextCache.signatures);
  // Second tick: still fires but the signature is now stale (seen 2 times).
  const second = evaluateInvariants(
    makeInputs({ retrySentinels: [sentinel], cache: first.nextCache }),
  );
  assert.equal(second.nextCache.signatures[sig].timesSeen, 2);
  // Third tick: companion appears, violation disappears, signature is GC'd.
  const recovered = evaluateInvariants(
    makeInputs({
      retrySentinels: [{ ...sentinel, conditionExists: true }],
      cache: second.nextCache,
    }),
  );
  assert.equal(recovered.violations.length, 0);
  assert.ok(!(sig in recovered.nextCache.signatures));
});

// ── Parse condition sidecar helper ──────────────────────────────────────────

test('parseConditionSidecar extracts head / observed / deadline / seq', () => {
  const raw = JSON.stringify({
    condition: {
      expiresOn: ['head', 'operator-event', 'deadline', 'remote'],
      head: 'abc1234:some-bucket:detail',
      operatorEventSeq: 7,
      recheckAfter: '2026-10-19T15:00:00Z',
      observed: { prHeadRefOid: 'ff00aa' },
    },
  });
  const info = parseConditionSidecar('HOK-11', '/tmp/x.json', raw);
  assert.deepEqual(info.expiresOn, ['head', 'operator-event', 'deadline', 'remote']);
  assert.equal(info.recordedHead, 'abc1234');
  assert.equal(info.recordedOperatorEventSeq, 7);
  assert.equal(info.recordedDeadline, '2026-10-19T15:00:00Z');
  assert.equal(info.recordedPrHeadOid, 'ff00aa');
});

test('parseConditionSidecar tolerates malformed input', () => {
  const info = parseConditionSidecar('HOK-12', '/tmp/x.json', 'not json');
  assert.equal(info.raw, null);
  assert.deepEqual(info.expiresOn, []);
  assert.equal(info.recordedHead, undefined);
});

test('parseConditionSidecar accepts top-level condition shape', () => {
  // Some writers put the condition fields at the top level, not under
  // `.condition`. parseConditionSidecar falls back to the top-level object.
  const raw = JSON.stringify({ expiresOn: ['head'], head: 'topsha' });
  const info = parseConditionSidecar('HOK-13', '/tmp/y.json', raw);
  assert.deepEqual(info.expiresOn, ['head']);
  assert.equal(info.recordedHead, 'topsha');
});

// ── I8: post-promotion bake gate (HOK-3238) ─────────────────────────────────

function hoursAgoMs(hours: number): number {
  return NOW_MS - hours * 60 * 60_000;
}

function minsAgoMs(mins: number): number {
  return NOW_MS - mins * 60_000;
}

test('I8 fires for a mill-core commit + idle-blocked-stall after promotion (HOK-3212 replay)', () => {
  const inputs = makeInputs({
    recentMainCommits: [
      {
        sha: 'abc1234',
        committedAtMs: hoursAgoMs(1), // committed 60 min ago
        files: ['shared/lib/merge-labels.ts'],
      },
    ],
    // Heartbeat 10 min ago is fresh (<15 min). Stall delta = 60-10 = 50 min
    // after commit → > 30-min threshold → fires.
    tendHeartbeat: {
      laneCondition: 'idle-blocked-stall',
      heartbeatAtMs: minsAgoMs(10),
    },
    prs: [{ number: 100, labels: [{ name: 'wm:ready' }] } as unknown as CachedPullRequest],
  });
  const out: InvariantViolation[] = [];
  checkInvariant8BakeGate(inputs, out, DEFAULT_INVARIANT_CONFIG);
  assert.equal(out.length, 1, `expected 1 I8 violation, got: ${JSON.stringify(out)}`);
  assert.equal(out[0].invariantId, 'I8-bake-gate-stall');
  assert.equal(out[0].signature, 'I8:abc1234');
  assert.equal((out[0].evidence as { revertCommand: string }).revertCommand, 'git revert abc1234');
  assert.deepEqual((out[0].evidence as { readyPrNumbers: number[] }).readyPrNumbers, [100]);
});

test('I8 does not fire when tend stall is only 10 min after promotion', () => {
  const inputs = makeInputs({
    recentMainCommits: [
      {
        sha: 'abc1234',
        committedAtMs: minsAgoMs(20),
        files: ['shared/lib/merge-labels.ts'],
      },
    ],
    // Stall delta = (now - 10) - (now - 20) = 10 min; threshold is 30.
    tendHeartbeat: {
      laneCondition: 'idle-blocked-stall',
      heartbeatAtMs: minsAgoMs(10),
    },
  });
  const out: InvariantViolation[] = [];
  checkInvariant8BakeGate(inputs, out, DEFAULT_INVARIANT_CONFIG);
  assert.equal(out.length, 0);
});

test('I8 ignores commits older than the bake window', () => {
  const inputs = makeInputs({
    recentMainCommits: [
      {
        sha: 'oldsha',
        committedAtMs: hoursAgoMs(3), // 3 h > 2 h window
        files: ['shared/lib/merge-labels.ts'],
      },
    ],
    tendHeartbeat: {
      laneCondition: 'idle-blocked-stall',
      heartbeatAtMs: minsAgoMs(25),
    },
  });
  const out: InvariantViolation[] = [];
  checkInvariant8BakeGate(inputs, out, DEFAULT_INVARIANT_CONFIG);
  assert.equal(out.length, 0);
});

test('I8 does not fire for normal-radius commits', () => {
  const inputs = makeInputs({
    recentMainCommits: [
      {
        sha: 'readmesha',
        committedAtMs: hoursAgoMs(1),
        files: ['README.md'],
      },
    ],
    tendHeartbeat: {
      laneCondition: 'idle-blocked-stall',
      heartbeatAtMs: minsAgoMs(25),
    },
  });
  const out: InvariantViolation[] = [];
  checkInvariant8BakeGate(inputs, out, DEFAULT_INVARIANT_CONFIG);
  assert.equal(out.length, 0);
});

test('I8 does not fire when tend is progressing', () => {
  const inputs = makeInputs({
    recentMainCommits: [
      {
        sha: 'abc1234',
        committedAtMs: hoursAgoMs(1),
        files: ['shared/lib/merge-labels.ts'],
      },
    ],
    tendHeartbeat: {
      laneCondition: 'progressing',
      heartbeatAtMs: minsAgoMs(1),
    },
  });
  const out: InvariantViolation[] = [];
  checkInvariant8BakeGate(inputs, out, DEFAULT_INVARIANT_CONFIG);
  assert.equal(out.length, 0);
});

test('I8 picks the most recent of multiple mill-core commits in the window', () => {
  const inputs = makeInputs({
    recentMainCommits: [
      {
        sha: 'olderMillCore',
        committedAtMs: hoursAgoMs(1.5),
        files: ['shared/lib/tend-loop.ts'],
      },
      {
        sha: 'newerMillCore',
        committedAtMs: hoursAgoMs(1),
        files: ['shared/lib/merge-labels.ts'],
      },
    ],
    tendHeartbeat: {
      laneCondition: 'idle-blocked-stall',
      heartbeatAtMs: minsAgoMs(10),
    },
  });
  const out: InvariantViolation[] = [];
  checkInvariant8BakeGate(inputs, out, DEFAULT_INVARIANT_CONFIG);
  assert.equal(out.length, 1);
  assert.equal(out[0].signature, 'I8:newerMillCore');
});

test('I8 does not fire when the heartbeat is stale (not reporting a lane right now)', () => {
  const inputs = makeInputs({
    recentMainCommits: [
      {
        sha: 'abc1234',
        committedAtMs: hoursAgoMs(1),
        files: ['shared/lib/merge-labels.ts'],
      },
    ],
    // 20 min of stale heartbeat (TEND_BLOCKED_LANE_FRESH_MS is 15 min)
    tendHeartbeat: {
      laneCondition: 'idle-blocked-stall',
      heartbeatAtMs: minsAgoMs(20),
    },
  });
  const out: InvariantViolation[] = [];
  // Note: setting a shorter tendIdleStallMinutes so the stall-threshold check
  // would otherwise pass. The stale heartbeat guard still blocks the fire.
  checkInvariant8BakeGate(inputs, out, { ...DEFAULT_INVARIANT_CONFIG, tendIdleStallMinutes: 5 });
  assert.equal(out.length, 0);
});

test('I8 bakeWindowMinutes=0 disables the gate (kill switch)', () => {
  const inputs = makeInputs({
    recentMainCommits: [
      {
        sha: 'abc1234',
        committedAtMs: hoursAgoMs(1),
        files: ['shared/lib/merge-labels.ts'],
      },
    ],
    tendHeartbeat: {
      laneCondition: 'idle-blocked-stall',
      heartbeatAtMs: minsAgoMs(25),
    },
  });
  const out: InvariantViolation[] = [];
  checkInvariant8BakeGate(inputs, out, { ...DEFAULT_INVARIANT_CONFIG, bakeWindowMinutes: 0 });
  assert.equal(out.length, 0);
});

test('I8 signature persists across ticks (notification only on first)', () => {
  const commit = {
    sha: 'persist123',
    committedAtMs: hoursAgoMs(1),
    files: ['shared/lib/merge-labels.ts'],
  };
  const first = evaluateInvariants(
    makeInputs({
      recentMainCommits: [commit],
      tendHeartbeat: {
        laneCondition: 'idle-blocked-stall',
        heartbeatAtMs: minsAgoMs(10),
      },
    }),
  );
  const i8 = first.violations.find((v) => v.invariantId === 'I8-bake-gate-stall');
  assert.ok(i8);
  const sig = i8!.signature;
  assert.equal(sig, 'I8:persist123');
  assert.ok(sig in first.nextCache.signatures);
  const second = evaluateInvariants(
    makeInputs({
      recentMainCommits: [commit],
      tendHeartbeat: {
        laneCondition: 'idle-blocked-stall',
        heartbeatAtMs: minsAgoMs(10),
      },
      cache: first.nextCache,
    }),
  );
  // Same stall, same signature; cache tracks `timesSeen` so the alert pipeline
  // can gate the OS notification on first occurrence only.
  assert.equal(second.nextCache.signatures[sig].timesSeen, 2);
});
