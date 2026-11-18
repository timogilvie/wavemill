import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mintRunId, mintStageAttemptId, projectTaskAttemptRef } from '../../shared/lib/attempt-identity.ts';

const SHELL_TWIN = join(dirname(fileURLToPath(import.meta.url)), 'attempt-identity.sh');

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

  it('mintStageAttemptId creates unique UUID identifiers', () => {
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

  // protects: `uuidgen --random` exits nonzero on macOS (only -r/-h are
  // valid there), which used to fall through to an openssl fallback whose
  // `sed 's/\(..\)/\1/g'` was a no-op — every shell-launched stage attempt
  // id was 32 undashed hex characters, not UUID-shaped.
  it('mint_stage_attempt_id (shell twin) mints distinct, UUID-shaped ids', () => {
    const script = `
      source ${JSON.stringify(SHELL_TWIN)}
      mint_stage_attempt_id
      mint_stage_attempt_id
    `;
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim().split('\n');
    assert.equal(out.length, 2);
    for (const id of out) {
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
    assert.notEqual(out[0], out[1]);
  });

  // protects: the openssl fallback path specifically (forcing uuidgen
  // unavailable), independent of whichever generator the host actually has.
  it('mint_stage_attempt_id openssl fallback produces a dash-formatted UUID', () => {
    const script = `
      uuidgen() { return 127; }
      command() { if [ "$1" = -v ] && [ "$2" = uuidgen ]; then return 1; fi; builtin command "$@"; }
      source ${JSON.stringify(SHELL_TWIN)}
      mint_stage_attempt_id
    `;
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
    assert.match(out, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});