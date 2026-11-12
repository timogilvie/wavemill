import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHALLENGE_ARM_STATE_GUARD } from './challenge-arm-state-guard.ts';
import { checkGuardSource, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

function findingsOf(file: string, source: string) {
  return checkGuardSource(CHALLENGE_ARM_STATE_GUARD, file, source).map((f) => f.pattern);
}

describe('challenge-arm-state guard', () => {
  it('flags private TS equality checks against awaiting_* states', () => {
    assert.deepEqual(
      findingsOf('shared/lib/x.ts', 'const p = arm.challengeArmState === "awaiting_fork";'),
      ['ts-private-arm-state-equality'],
    );
    assert.deepEqual(
      findingsOf('shared/lib/x.ts', 'const p = arm.challengeArmState !== "awaiting_expanded_route";'),
      ['ts-private-arm-state-equality'],
    );
  });

  it('flags private shell/jq equality checks against awaiting_* states', () => {
    assert.deepEqual(
      findingsOf('shared/lib/x.sh', 'select(.challengeArmState == "awaiting_fork")'),
      ['sh-private-arm-state-equality'],
    );
  });

  it('ignores the authoritative predicate helpers and their tests', () => {
    const invariantFiles = CHALLENGE_ARM_STATE_GUARD.invariantPaths ?? [];
    assert.ok(invariantFiles.includes('shared/lib/challenge-execution-contract.ts'));
    assert.ok(invariantFiles.includes('shared/lib/challenge-arms.sh'));
    assert.ok(invariantFiles.includes('shared/lib/challenge-arm-state-guard.ts'));
  });

  it('honours inline suppression', () => {
    assert.deepEqual(
      findingsOf('shared/lib/x.ts', '// allow-challenge-arm-state: legacy\nconst p = arm.challengeArmState === "awaiting_fork";'),
      [],
    );
  });

  it('passes on a clean repo with an empty allowlist', () => {
    const result = runSourceGuard(CHALLENGE_ARM_STATE_GUARD, repoRoot);
    assert.equal(result.ok, true, `findings: ${JSON.stringify(result.findings)}`);
  });
});


