/**
 * Tests for attempt-identity.ts (HOK-3373 legacy run id; HOK-3476 SDK
 * task_attempt/v1 projection).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSameRunId,
  mintAttemptEntityId,
  mintRunId,
  projectRunAttempt,
  projectStageAttempt,
  runIdIssue,
  runIdStartedAt,
  taskAttemptRef,
} from './attempt-identity.ts';
import { MINTED_ID_PATTERN, validateTaskAttemptRef } from './sdk-task-cost/contract.ts';

// ────────────────────────────────────────────────────────────────
// Legacy run id (HOK-3373) — unchanged, kept alongside the SDK projection.
// ────────────────────────────────────────────────────────────────

describe('mintRunId / isSameRunId / runIdIssue / runIdStartedAt', () => {
  it('mints a deterministic, parseable run id', () => {
    const launchedAt = new Date('2026-04-09T10:00:00Z');
    const seconds = Math.floor(launchedAt.getTime() / 1000);
    const runId = mintRunId({ issue: 'HOK-9999', runEpoch: '42', launchedAt });
    assert.equal(runId, `HOK-9999:42:${seconds}`);
    assert.equal(runIdIssue(runId), 'HOK-9999');
    assert.equal(runIdStartedAt(runId), seconds * 1000);
  });

  it('never treats two missing ids as the same run', () => {
    assert.equal(isSameRunId(undefined, undefined), false);
    assert.equal(isSameRunId(null, null), false);
    assert.equal(isSameRunId('', ''), false);
  });
});

// ────────────────────────────────────────────────────────────────
// SDK task_attempt/v1 projection (HOK-3476)
// ────────────────────────────────────────────────────────────────

describe('mintAttemptEntityId', () => {
  it('mints a fresh id matching the SDK minted-id pattern', () => {
    const a = mintAttemptEntityId();
    const b = mintAttemptEntityId();
    assert.match(a, MINTED_ID_PATTERN);
    assert.notEqual(a, b);
  });
});

describe('projectRunAttempt', () => {
  it('mints a run whose parent is the task by default, carrying the legacy runId', () => {
    const legacyRunId = mintRunId({ issue: 'HOK-9999', runEpoch: '1', launchedAt: new Date() });
    const { record, ref } = projectRunAttempt({ taskId: 'HOK-9999', legacyRunId });

    assert.equal(record.kind, 'run');
    assert.equal(record.task_id, 'HOK-9999');
    assert.equal(record.parent_id, 'HOK-9999');
    assert.deepEqual(record.legacy_ids, [legacyRunId]);
    assert.equal(record.retry_of, undefined);
    assert.match(record.id, MINTED_ID_PATTERN);
    assert.deepEqual(ref, { task_id: 'HOK-9999', run_id: record.id });
  });

  it('mints a challenge-arm run against an already-minted arm parent', () => {
    const armId = mintAttemptEntityId();
    const { record } = projectRunAttempt({ taskId: 'HOK-9999_c', parentId: armId });
    assert.equal(record.parent_id, armId);
  });

  it('rejects an unminted parentId (never derived from a head/timestamp/session)', () => {
    assert.throws(() => projectRunAttempt({ taskId: 'HOK-9999_c', parentId: 'arm-1' }));
  });

  it('sets retry_of only when the caller names a known sibling run, never inferred', () => {
    const failedRun = projectRunAttempt({ taskId: 'HOK-9999' });
    const { record } = projectRunAttempt({ taskId: 'HOK-9999', retryOfRunId: failedRun.record.id });
    assert.equal(record.retry_of, failedRun.record.id);
  });

  it('two launches of the same task mint two distinct runs (no dedup by taskId)', () => {
    const a = projectRunAttempt({ taskId: 'HOK-9999' });
    const b = projectRunAttempt({ taskId: 'HOK-9999' });
    assert.notEqual(a.record.id, b.record.id);
  });

  it('requires a taskId', () => {
    assert.throws(() => projectRunAttempt({ taskId: '' }));
  });
});

describe('projectStageAttempt', () => {
  it('mints a stage attempt contained in its run, carrying the legacy attemptId', () => {
    const run = projectRunAttempt({ taskId: 'HOK-9999' });
    const legacyAttemptId = 'coding@abc1234#1700000000';
    const { record, ref } = projectStageAttempt({
      taskId: 'HOK-9999',
      runId: run.record.id,
      stage: 'coding',
      legacyAttemptId,
    });

    assert.equal(record.kind, 'stage_attempt');
    assert.equal(record.parent_id, run.record.id);
    assert.equal(record.stage, 'coding');
    assert.deepEqual(record.legacy_ids, [legacyAttemptId]);
    assert.deepEqual(ref, { task_id: 'HOK-9999', run_id: run.record.id, stage_attempt_id: record.id });
  });

  it('a child stage attempt is never automatically a retry', () => {
    const run = projectRunAttempt({ taskId: 'HOK-9999' });
    const { record } = projectStageAttempt({ taskId: 'HOK-9999', runId: run.record.id, stage: 'coding' });
    assert.equal(record.retry_of, undefined);
  });

  it('sets retry_of only for an explicitly named failed/abandoned sibling, distinct from the parent run', () => {
    const run = projectRunAttempt({ taskId: 'HOK-9999' });
    const failedAttempt = projectStageAttempt({ taskId: 'HOK-9999', runId: run.record.id, stage: 'coding' });
    const retry = projectStageAttempt({
      taskId: 'HOK-9999',
      runId: run.record.id,
      stage: 'coding',
      retryOfStageAttemptId: failedAttempt.record.id,
    });
    assert.equal(retry.record.retry_of, failedAttempt.record.id);
    assert.notEqual(retry.record.retry_of, retry.record.parent_id);
  });

  it('rejects retry_of pointed at its own parent run (a child is not a retry of its run)', () => {
    const run = projectRunAttempt({ taskId: 'HOK-9999' });
    assert.throws(() => projectStageAttempt({
      taskId: 'HOK-9999',
      runId: run.record.id,
      stage: 'coding',
      retryOfStageAttemptId: run.record.id,
    }));
  });

  it('rejects a runId that is not itself a minted SDK id', () => {
    assert.throws(() => projectStageAttempt({ taskId: 'HOK-9999', runId: 'not-a-uuid', stage: 'coding' }));
  });

  it('requires taskId, runId and stage', () => {
    const run = projectRunAttempt({ taskId: 'HOK-9999' });
    assert.throws(() => projectStageAttempt({ taskId: '', runId: run.record.id, stage: 'coding' }));
    assert.throws(() => projectStageAttempt({ taskId: 'HOK-9999', runId: '', stage: 'coding' }));
    assert.throws(() => projectStageAttempt({ taskId: 'HOK-9999', runId: run.record.id, stage: '' }));
  });

  it('two same-second launches of the same stage mint two distinct stage attempts', () => {
    const run = projectRunAttempt({ taskId: 'HOK-9999' });
    const a = projectStageAttempt({ taskId: 'HOK-9999', runId: run.record.id, stage: 'coding' });
    const b = projectStageAttempt({ taskId: 'HOK-9999', runId: run.record.id, stage: 'coding' });
    assert.notEqual(a.record.id, b.record.id);
    assert.equal(a.record.parent_id, b.record.parent_id);
  });
});

describe('taskAttemptRef', () => {
  it('builds and validates a ref from already-minted ids', () => {
    const run = projectRunAttempt({ taskId: 'HOK-9999' });
    const stage = projectStageAttempt({ taskId: 'HOK-9999', runId: run.record.id, stage: 'review' });
    const ref = taskAttemptRef({ taskId: 'HOK-9999', runId: run.record.id, stageAttemptId: stage.record.id });
    assert.doesNotThrow(() => validateTaskAttemptRef(ref));
  });

  it('a ref naming only the run (no stage attempt) is legal — run-level evidence/control', () => {
    const run = projectRunAttempt({ taskId: 'HOK-9999' });
    const ref = taskAttemptRef({ taskId: 'HOK-9999', runId: run.record.id });
    assert.doesNotThrow(() => validateTaskAttemptRef(ref));
    assert.equal(ref.stage_attempt_id, undefined);
  });

  it('rejects an unminted runId', () => {
    assert.throws(() => taskAttemptRef({ taskId: 'HOK-9999', runId: 'legacy-label-not-a-uuid' }));
  });
});
