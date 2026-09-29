import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  captureTransitionDiagnostic,
  claimReadyHandoff,
  clearTendPushedHead,
  handoffToken,
  isMatchingTendClaim,
  publishReadyHandoff,
  readTendPushedHead,
  rebindTendHandoff,
  recordReadyChecked,
  recordTendPushedHead,
  tendPushedHeadPath,
} from './ready-tend-handoff.ts';

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

test('Tend pushed-head marker round-trips and clears (HOK-3112)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-tend-pushed-head-'));
  try {
    assert.equal(readTendPushedHead(dir), null);
    const recorded = await recordTendPushedHead(dir, 1520, 'pre-rebase', 'rebased');
    assert.equal(recorded.by, 'tend');
    assert.equal(recorded.previousHeadSha, 'pre-rebase');
    assert.equal(recorded.pushedHeadSha, 'rebased');
    assert.deepEqual(readTendPushedHead(dir), recorded);
    clearTendPushedHead(dir);
    assert.ok(!existsSync(tendPushedHeadPath(dir)));
    assert.equal(readTendPushedHead(dir), null);
    clearTendPushedHead(dir); // idempotent
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('consecutive Tend pushes keep the head the task worktree still has (HOK-3112)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-tend-pushed-chain-'));
  try {
    await recordTendPushedHead(dir, 1520, 'worktree-head', 'push-1');
    // A second push before the monitor synced: the checkout is still at
    // worktree-head, so that stays the recorded previous head.
    const chained = await recordTendPushedHead(dir, 1520, 'push-1', 'push-2');
    assert.equal(chained.previousHeadSha, 'worktree-head');
    assert.equal(chained.pushedHeadSha, 'push-2');
    // An unrelated previous head (e.g. marker from another PR head lineage)
    // replaces the record instead of chaining.
    const replaced = await recordTendPushedHead(dir, 1520, 'other', 'push-3');
    assert.equal(replaced.previousHeadSha, 'other');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('malformed Tend pushed-head markers read as absent (HOK-3112)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-tend-pushed-bad-'));
  try {
    writeFileSync(tendPushedHeadPath(dir), '{not json');
    assert.equal(readTendPushedHead(dir), null);
    writeFileSync(tendPushedHeadPath(dir), JSON.stringify({ version: 1, prNumber: 1520 }));
    assert.equal(readTendPushedHead(dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
