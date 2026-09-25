import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureTransitionDiagnostic, claimReadyHandoff, handoffToken, isMatchingTendClaim, publishReadyHandoff, rebindTendHandoff, recordReadyChecked } from './ready-tend-handoff.ts';

test('Ready publication and Tend claim are idempotent and head-bound', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-tend-handoff-'));
  try {
    assert.equal((await recordReadyChecked(dir, 1426, 'head-a')).state, 'checked');
    const published = await publishReadyHandoff(dir, 1426, 'head-a');
    assert.equal(published.outcome, 'published');
    assert.equal(published.record.token, handoffToken(1426, 'head-a'));
    assert.equal((await publishReadyHandoff(dir, 1426, 'head-a')).outcome, 'already-published');
    const claimed = await claimReadyHandoff(dir, 1426, 'head-a');
    assert.equal(claimed.outcome, 'claimed');
    assert.ok(isMatchingTendClaim(claimed.record, 1426, 'head-a'));
    assert.equal((await claimReadyHandoff(dir, 1426, 'head-a')).outcome, 'already-claimed');
    const rekeyed = await publishReadyHandoff(dir, 1426, 'head-b');
    assert.equal(rekeyed.outcome, 'published');
    assert.equal(rekeyed.record.headSha, 'head-b');
    assert.equal((await claimReadyHandoff(dir, 1426, 'head-a')).outcome, 'rejected');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Tend can rebind only its claimed handoff after a rebase', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-tend-rebase-'));
  try {
    await publishReadyHandoff(dir, 1495, 'old-head');
    assert.equal((await rebindTendHandoff(dir, 1495, 'old-head', 'new-head')).outcome, 'rejected');
    await claimReadyHandoff(dir, 1495, 'old-head');
    const rebound = await rebindTendHandoff(dir, 1495, 'old-head', 'new-head');
    assert.equal(rebound.outcome, 'claimed');
    assert.ok(isMatchingTendClaim(rebound.record, 1495, 'new-head'));
    assert.equal((await rebindTendHandoff(dir, 1495, 'old-head', 'new-head')).outcome, 'already-claimed');
    assert.equal((await claimReadyHandoff(dir, 1495, 'old-head')).outcome, 'rejected');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('transition diagnostics redact and bound command output', () => {
  const diagnostic = captureTransitionDiagnostic({
    stage: 'route-stamp',
    stdout: `ghp_${'a'.repeat(36)}\n${'x'.repeat(3000)}`,
    stderr: 'api_key=abcdefghijklmnopqrstuvwxyz',
  });
  assert.equal(diagnostic.stage, 'route-stamp');
  assert.equal(diagnostic.redacted, true);
  assert.equal(diagnostic.truncated, true);
  assert.ok(!JSON.stringify(diagnostic).includes('ghp_'));
});
