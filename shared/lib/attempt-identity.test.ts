import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mintRunId, mintStageAttemptId, projectTaskAttemptRef } from '../../shared/lib/attempt-identity.ts';

describe('attempt-identity (HOK-3476)', () => {
  it('mintRunId creates deterministic run ids', () => {
    const args = {
      issue: 'HOK-123',
      runEpoch: 'test-epoch',
      launchedAt: new Date('2026-10-27T13:25:39.000Z'),
    };
    const id1 = mintRunId(args);
    const id2 = mintRunId(args);
    assert.equal(id1, id2);
    assert.equal(id1, 'HOK-123:test-epoch:1793107539');
  });

  it('mintStageAttemptId creates UUIDv7 identifiers', () => {
    const id1 = mintStageAttemptId();
    const id2 = mintStageAttemptId();
    assert.notEqual(id1, id2);
    // Should look like a UUID
    assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('projectTaskAttemptRef maps ownership rows to SDK contract', () => {
    const ownershipRow = {
      issue: 'HOK-123',
      runId: 'HOK-123:test-epoch:1793107539',
      stageAttemptId: '123e4567-e89b-12d3-a456-426614174000',
    };
    
    const ref = projectTaskAttemptRef(ownershipRow);
    assert.equal(ref.task_id, 'HOK-123');
    assert.equal(ref.run_id, 'HOK-123:test-epoch:1793107539');
    assert.equal(ref.stage_attempt_id, '123e4567-e89b-12d3-a456-426614174000');
  });

  it('projectTaskAttemptRef handles legacy rows without runId', () => {
    const ownershipRow = {
      issue: 'HOK-123',
      // No runId field
      stageAttemptId: '123e4567-e89b-12d3-a456-426614174000',
    };
    
    const ref = projectTaskAttemptRef(ownershipRow);
    assert.equal(ref.task_id, 'HOK-123');
    assert.equal(ref.run_id, undefined);
    assert.equal(ref.stage_attempt_id, '123e4567-e89b-12d3-a456-426614174000');
  });
});