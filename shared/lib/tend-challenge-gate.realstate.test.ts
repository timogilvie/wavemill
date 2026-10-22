/**
 * Tend challenge-gate stall predicate exercised against real-state fixtures
 * (HOK-3225). The invariant under test is HOK-3128: a tracked no-PR sibling is
 * live only while the shared task-progress primitive shows evidence; this test
 * drives the predicate with real `.updatedAt` values from the challenge-pair
 * and aborted fixtures.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  isNoPrSiblingStalled,
  type TaskEvalState,
} from './tend-challenge-gate.ts';
import type { WorkflowState, TaskRecord } from './workflow-state.ts';

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'tests',
  'fixtures',
  'real-state',
);

interface Fixture {
  workflowState: WorkflowState;
}

function loadFixture(file: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf-8')) as Fixture;
}

function pickChallengerRow(state: WorkflowState): { taskId: string; task: TaskRecord } {
  const entries = Object.entries(state.tasks ?? {});
  const challenger = entries.find(([id]) => id.endsWith('_c'));
  assert.ok(challenger, 'fixture must carry a challenger row');
  return { taskId: challenger[0], task: challenger[1] };
}

function siblingFromTask(taskId: string, task: TaskRecord): TaskEvalState {
  const updatedAt = typeof task.updated === 'string' ? Date.parse(task.updated) : null;
  return {
    issueId: taskId,
    prNumber: null,
    role: 'challenger',
    branch: typeof task.branch === 'string' ? task.branch : null,
    challengeStage: typeof task.challengeStage === 'string' ? task.challengeStage : null,
    model: null,
    updatedAt: Number.isFinite(updatedAt) ? (updatedAt as number) : null,
    evalFailed: task.evalFailed === true,
    evalCompleted: task.evalCompleted === true,
    evalHardFailureRetryCount:
      typeof task.evalHardFailureRetryCount === 'number' ? task.evalHardFailureRetryCount : 0,
    comparisonState: typeof task.comparisonState === 'string' ? task.comparisonState : null,
    challengeAborted: typeof task.challengeAborted === 'string' ? task.challengeAborted : null,
    challengeAbortedDetail: null,
    challengeAbortedNextAction: null,
    challengeAbortedStage: null,
  };
}

test('isNoPrSiblingStalled: a live hook within the grace is not stalled', () => {
  const { taskId, task } = pickChallengerRow(loadFixture('2026-10-22-challenge-pair.json').workflowState);
  const sibling = siblingFromTask(taskId, task);
  const nowMs = (sibling.updatedAt ?? 0) + 60_000;
  // Progress with a fresh `working` state must never be classed stalled.
  const stalled = isNoPrSiblingStalled({
    sibling,
    progress: {
      lastProgressAt: new Date(nowMs - 1_000).toISOString(),
      sources: [],
      agentState: 'working',
      agentIdle: false,
      terminal: false,
      terminalIdle: false,
      stalled: false,
      blockingPrompt: false,
    },
    nowMs,
  });
  assert.equal(stalled, false, 'live hook within grace must not stall the gate');
});

test('isNoPrSiblingStalled: terminal progress past orphan grace is stalled', () => {
  const { taskId, task } = pickChallengerRow(loadFixture('2026-10-22-aborted.json').workflowState);
  const sibling = siblingFromTask(taskId, task);
  // Force "aborted" into the sibling so terminal is unambiguous.
  const nowMs = (sibling.updatedAt ?? 0) + 24 * 3600_000;
  const stalled = isNoPrSiblingStalled({
    sibling,
    progress: {
      lastProgressAt: new Date((sibling.updatedAt ?? 0)).toISOString(),
      sources: [],
      agentState: 'idle',
      agentIdle: true,
      terminal: true,
      terminalIdle: true,
      stalled: true,
      blockingPrompt: false,
    },
    nowMs,
  });
  assert.equal(stalled, true, 'terminal + past orphan grace must stall');
});

test('isNoPrSiblingStalled: undefined progress keeps legacy "live" behaviour', () => {
  const { taskId, task } = pickChallengerRow(loadFixture('2026-10-22-challenge-pair.json').workflowState);
  const sibling = siblingFromTask(taskId, task);
  const stalled = isNoPrSiblingStalled({
    sibling,
    progress: undefined,
    nowMs: Date.now(),
  });
  assert.equal(stalled, false, 'undefined progress must not stall (preserves legacy semantics)');
});
