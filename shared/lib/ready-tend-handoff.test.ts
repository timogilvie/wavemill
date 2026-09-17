import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach } from 'node:test';
import {
  publishReadyHandoff,
  claimTendHandoff,
  readHandoffRecord,
  isTendClaimedForHead,
  recordHandoffFailure,
} from './ready-tend-handoff.ts';

let tmpDir: string;

function setup(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'handoff-test-'));
  return tmpDir;
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('ready-tend-handoff', () => {
  it('publishes and reads a handoff record', async () => {
    const dir = setup();
    const result = await publishReadyHandoff(dir, 1426, 'abc123');
    assert.equal(result.outcome, 'published');
    assert.equal(result.record.state, 'ready-published');
    assert.equal(result.record.owner, 'ready');
    assert.equal(result.record.prNumber, 1426);
    assert.equal(result.record.headSha, 'abc123');

    const record = readHandoffRecord(dir);
    assert.ok(record);
    assert.equal(record.state, 'ready-published');
  });

  it('claims a published handoff', async () => {
    const dir = setup();
    await publishReadyHandoff(dir, 1426, 'abc123');
    const claim = await claimTendHandoff(dir, 1426, 'abc123');
    assert.equal(claim.outcome, 'claimed');
    assert.equal(claim.record.state, 'tend-claimed');
    assert.equal(claim.record.owner, 'tend');
    assert.ok(claim.record.claimedAt);

    assert.ok(isTendClaimedForHead(dir, 1426, 'abc123'));
    assert.ok(!isTendClaimedForHead(dir, 1426, 'different-sha'));
    assert.ok(!isTendClaimedForHead(dir, 9999, 'abc123'));
  });

  it('returns stale-head when head SHA does not match', async () => {
    const dir = setup();
    await publishReadyHandoff(dir, 1426, 'abc123');
    const claim = await claimTendHandoff(dir, 1426, 'def456');
    assert.equal(claim.outcome, 'stale-head');
  });

  it('returns already-claimed on duplicate Tend claim', async () => {
    const dir = setup();
    await publishReadyHandoff(dir, 1426, 'abc123');
    await claimTendHandoff(dir, 1426, 'abc123');
    const second = await claimTendHandoff(dir, 1426, 'abc123');
    assert.equal(second.outcome, 'already-claimed');
  });

  it('refuses Tend claim without a prior Ready publish (REQ-F1)', async () => {
    const dir = setup();
    const claim = await claimTendHandoff(dir, 1426, 'abc123');
    assert.equal(claim.outcome, 'no-ready-artifact');
    assert.equal(claim.record, null);
    assert.equal(readHandoffRecord(dir), null);
  });

  it('records typed failure stage', async () => {
    const dir = setup();
    await publishReadyHandoff(dir, 1426, 'abc123');
    await recordHandoffFailure(dir, 'route-stamp', 'stamp-pr-route.ts failed on PR #1426');

    const record = readHandoffRecord(dir);
    assert.ok(record);
    assert.equal(record.failureStage, 'route-stamp');
    assert.match(record.diagnosticExcerpt!, /stamp-pr-route/);
  });

  it('redacts sensitive content in diagnostics', async () => {
    const dir = setup();
    await publishReadyHandoff(dir, 1426, 'abc123');
    await recordHandoffFailure(dir, 'github-api', 'token=ghp_secret123abc and /Users/john/repo failed');

    const record = readHandoffRecord(dir);
    assert.ok(record);
    assert.ok(!record.diagnosticExcerpt!.includes('ghp_secret123abc'));
    assert.ok(!record.diagnosticExcerpt!.includes('/Users/john'));
  });

  it('overwrites stale-head publish with new head', async () => {
    const dir = setup();
    await publishReadyHandoff(dir, 1426, 'old-sha');
    const result = await publishReadyHandoff(dir, 1426, 'new-sha');
    assert.equal(result.outcome, 'published');
    assert.equal(result.record.headSha, 'new-sha');
  });

  describe('HOK-3030 regression: Tend claims between Ready checks and label finalization', () => {
    it('Ready publish then Tend claim then Ready re-read sees the claim', async () => {
      const dir = setup();

      // Step 1: Ready publishes handoff
      const publish = await publishReadyHandoff(dir, 1426, 'abc123');
      assert.equal(publish.outcome, 'published');

      // Step 2: Tend claims the handoff
      const claim = await claimTendHandoff(dir, 1426, 'abc123');
      assert.equal(claim.outcome, 'claimed');

      // Step 3: Ready checks if Tend has claimed (this is what set-pr-ready-label uses)
      assert.ok(isTendClaimedForHead(dir, 1426, 'abc123'));
    });
  });
});
