import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkGuardSource } from './lib/source-guard.ts';
import { ARM_TERMINATION_GUARD } from '../shared/lib/arm-termination-guard.ts';

describe('arm termination guard', () => {
  it('rejects a direct termination stamp outside the recorder', () => {
    assert.deepEqual(
      checkGuardSource(ARM_TERMINATION_GUARD, 'shared/lib/x.ts', 'task.challengeAborted = reason;\n').map((finding) => finding.pattern),
      ['challenge-aborted-write'],
    );
  });
});
