/**
 * Merge label reconciler exercised against sanitised real-state fixtures
 * (HOK-3225). Guards HOK-3181 / HOK-3212: an invented `TaskRecord` shape would
 * compile cleanly against the builder-based tests; here the row came from an
 * actual `save_task_state` write.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  deriveMergeLabel,
  type MergeLabelLiveState,
  type MergeLabelTaskView,
} from './merge-labels.ts';
import type { WorkflowState, TaskRecord } from './workflow-state.ts';

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'tests',
  'fixtures',
  'real-state',
);

type RawStageArtifacts = { verdict?: string; readyHeadSha?: string; queueState?: string };
type RawStageResult = { status?: string; artifacts?: RawStageArtifacts } | null;

interface Fixture {
  workflowState: WorkflowState;
  stageResults?: Record<string, { ready?: RawStageResult }>;
}

function loadFixture(file: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf-8')) as Fixture;
}

function pickPrimary(state: WorkflowState): { taskId: string; task: TaskRecord } {
  const entries = Object.entries(state.tasks ?? {});
  assert.ok(entries.length > 0, 'fixture has no tasks');
  const primary = entries.find(([id]) => !id.endsWith('_c')) ?? entries[0];
  return { taskId: primary[0], task: primary[1] };
}

function viewFromFixture(file: string): {
  taskView: MergeLabelTaskView;
  readyArtifacts: RawStageArtifacts;
  readyStatus: string;
  prNumber: number;
} {
  const fixture = loadFixture(file);
  const { taskId, task } = pickPrimary(fixture.workflowState);
  const prValue = task.pr;
  const prNumber = typeof prValue === 'number'
    ? prValue
    : typeof prValue === 'string' && prValue.length > 0
      ? Number.parseInt(prValue, 10)
      : 0;
  const ready = fixture.stageResults?.[taskId]?.ready ?? null;
  const artifacts = ready?.artifacts ?? {};
  const headSha = artifacts.readyHeadSha ?? '';
  return {
    taskView: {
      prNumber,
      headSha,
      phase: typeof task.phase === 'string' ? task.phase : 'unknown',
      challengeRole: taskId.endsWith('_c') ? 'challenger' : 'primary',
      ...(typeof task.linearIssueId === 'string' ? { linearIssueId: task.linearIssueId } : {}),
      featureDir: `features/${task.slug ?? 'unknown'}`,
    },
    readyArtifacts: artifacts,
    readyStatus: ready?.status ?? '',
    prNumber,
  };
}

test('deriveMergeLabel resolves to wm:ready on the real ready fixture', () => {
  const { taskView, readyArtifacts, prNumber } = viewFromFixture('2026-10-22-ready.json');
  assert.equal(readyArtifacts.verdict, 'pass', 'fixture should carry a passing Ready verdict');
  assert.ok(taskView.headSha.length > 0, 'fixture carries a readyHeadSha');

  const liveState: MergeLabelLiveState = {
    prHeadSha: taskView.headSha,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [
      { name: 'Shell and Unit Tests', conclusion: 'SUCCESS', status: 'COMPLETED' },
    ],
    readyAtHead: { verdict: 'ready', sha: taskView.headSha },
    handoffAtHead: {
      state: 'ready-published',
      headSha: taskView.headSha,
      prNumber,
    },
  };

  const decision = deriveMergeLabel(taskView, { number: prNumber, labels: [], headSha: taskView.headSha }, liveState);
  assert.equal(decision.label, 'wm:ready', `expected wm:ready, got ${JSON.stringify(decision)}`);
});

test('deriveMergeLabel still resolves wm:ready when handoff is tend-claimed', () => {
  const { taskView, prNumber } = viewFromFixture('2026-10-22-merge-queued.json');
  const liveState: MergeLabelLiveState = {
    prHeadSha: taskView.headSha,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [
      { name: 'Shell and Unit Tests', conclusion: 'SUCCESS', status: 'COMPLETED' },
    ],
    readyAtHead: { verdict: 'ready', sha: taskView.headSha },
    handoffAtHead: { state: 'tend-claimed', headSha: taskView.headSha, prNumber },
  };
  const decision = deriveMergeLabel(taskView, { number: prNumber, labels: ['wm:ready'], headSha: taskView.headSha }, liveState);
  assert.equal(decision.label, 'wm:ready', `expected wm:ready during tend claim, got ${JSON.stringify(decision)}`);
});

test('deriveMergeLabel blocks on head mismatch using the fixture-shaped record', () => {
  const { taskView, prNumber } = viewFromFixture('2026-10-22-ready.json');
  const liveState: MergeLabelLiveState = {
    prHeadSha: 'f'.repeat(40),
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [],
    readyAtHead: { verdict: 'ready', sha: taskView.headSha },
    handoffAtHead: { state: 'ready-published', headSha: taskView.headSha, prNumber },
  };
  const decision = deriveMergeLabel(
    taskView,
    { number: prNumber, labels: [], headSha: taskView.headSha },
    liveState,
  );
  assert.equal(decision.label, null);
  assert.equal(decision.reason, 'head-mismatch');
});
