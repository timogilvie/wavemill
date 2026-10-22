/**
 * Ready-watchdog classifier run against sanitised real-state fixtures
 * (HOK-3225). Confirms the classifier does not crash on the exact shapes
 * `save_task_state` writes for a ready-phase row.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  classifyReadyTask,
  type ReadyTaskSnapshot,
  type GitHubPRTruth,
} from './ready-watchdog.ts';
import type { WorkflowState, TaskRecord } from './workflow-state.ts';
import type { StageResult, ReadyArtifacts } from './stage-result.ts';

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
  stageResults?: Record<string, { ready?: StageResult | null }>;
}

function loadFixture(file: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf-8')) as Fixture;
}

function pickReadyTask(state: WorkflowState): { taskId: string; task: TaskRecord } {
  const entries = Object.entries(state.tasks ?? {});
  assert.ok(entries.length > 0, 'fixture has no tasks');
  return { taskId: entries[0][0], task: entries[0][1] };
}

function buildSnapshot(file: string, now: Date): ReadyTaskSnapshot {
  const fixture = loadFixture(file);
  const { taskId, task } = pickReadyTask(fixture.workflowState);
  const ready = fixture.stageResults?.[taskId]?.ready ?? null;
  const prValue = task.pr;
  const prNumber = typeof prValue === 'number'
    ? prValue
    : typeof prValue === 'string' && prValue.length > 0
      ? Number.parseInt(prValue, 10)
      : 0;
  const readyArtifacts: ReadyArtifacts | null =
    ready?.artifacts && (ready.artifacts as { type?: string }).type === 'ready'
      ? (ready.artifacts as ReadyArtifacts)
      : null;
  return {
    issueId: taskId,
    slug: typeof task.slug === 'string' ? task.slug : taskId,
    branch: typeof task.branch === 'string' ? task.branch : `task/${taskId}`,
    worktree: typeof task.worktree === 'string' ? task.worktree : '/workspace/wavemill-fixture',
    prNumber,
    controllerPhase: typeof task.phase === 'string' ? task.phase : 'ready',
    controllerUpdatedAt: typeof task.updated === 'string' ? task.updated : null,
    currentAgent: typeof task.agent === 'string' ? task.agent : '',
    currentModel: typeof task.model === 'string' ? task.model : '',
    challengePairId: typeof task.challengePairId === 'string' ? task.challengePairId : null,
    readyStateDir: 'features/fixture',
    readyResult: ready ?? null,
    readyArtifacts,
    readyResultStatus: ready?.status ?? null,
    readyVerdict: readyArtifacts?.verdict ?? null,
    readyAttentionDetail: null,
    hasNeedsAttention: false,
    hasConflictMarker: false,
    remediationLaunchHead: null,
    currentHead: readyArtifacts?.readyHeadSha ?? null,
    remediationPaneActive: null,
    worktreeMergeState: {
      mergeHead: null,
      unmergedPaths: [],
      stagedPaths: [],
      unstagedPaths: [],
      untrackedPaths: [],
      rawStatus: [],
    },
    relevantJobs: [],
    // Pretend the Ready result was just produced so the classifier reports fresh.
    lastProgressAt: now.toISOString(),
    idleMinutes: 0,
    backstageHealth: null,
  };
}

const CONFIG = {
  enabled: true,
  thresholdMinutes: 10,
  autoRecover: true,
  timeoutSeconds: 30,
  stableFailureConsecutivePolls: 2,
  stableFailureEscalateAfterPolls: 4,
  safeRemediationCategories: ['lint', 'type', 'test', 'build', 'migration-chain', 'alembic'],
};

test('classifyReadyTask reports fresh on a just-captured real ready fixture', () => {
  const now = new Date('2026-10-22T13:30:00Z');
  const snapshot = buildSnapshot('2026-10-22-ready.json', now);
  const githubTruth: GitHubPRTruth = {
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    checks: [
      { name: 'Shell and Unit Tests', status: 'success', rawStatus: 'SUCCESS' },
    ],
  };
  const classification = classifyReadyTask(snapshot, githubTruth, now, CONFIG);
  assert.equal(
    classification.kind,
    'fresh',
    `expected 'fresh' on a 0-minute idle snapshot; got ${JSON.stringify(classification)}`,
  );
});

test('classifyReadyTask handles a null lastProgressAt without throwing', () => {
  const now = new Date('2026-10-22T13:30:00Z');
  const snapshot = buildSnapshot('2026-10-22-ready.json', now);
  snapshot.lastProgressAt = null;
  snapshot.idleMinutes = null;
  const classification = classifyReadyTask(snapshot, null, now, CONFIG);
  assert.equal(classification.kind, 'needs-user');
  assert.match(classification.detail, /last local progress timestamp/);
});
