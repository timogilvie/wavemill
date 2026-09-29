import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  captureTransitionDiagnostic,
  claimReadyHandoff,
  describeClaimRejection,
  handoffToken,
  isMatchingTendClaim,
  publishReadyHandoff,
  readyTendHandoffPath,
  rebindTendHandoff,
  recordReadyChecked,
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

test('HOK-3108: claim on a missing handoff never creates a file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-tend-handoff-missing-'));
  try {
    const path = readyTendHandoffPath(dir);
    assert.equal(existsSync(path), false);
    const result = await claimReadyHandoff(dir, 42, 'head-x');
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.rejectionReason, 'missing');
    assert.equal(result.record, null);
    // The critical invariant: claiming a missing handoff MUST NOT create the file.
    assert.equal(existsSync(path), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HOK-3108: claim on a checked-only record rejects with not-published and does not rewrite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-tend-handoff-checked-'));
  try {
    await recordReadyChecked(dir, 42, 'head-x');
    const path = readyTendHandoffPath(dir);
    const before = readFileSync(path, 'utf-8');
    const mtimeBefore = statSync(path).mtimeMs;
    // A tiny sleep so any mtime bump would be visible.
    await new Promise((resolve) => setTimeout(resolve, 15));
    const result = await claimReadyHandoff(dir, 42, 'head-x');
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.rejectionReason, 'not-published');
    assert.equal(readFileSync(path, 'utf-8'), before);
    assert.equal(statSync(path).mtimeMs, mtimeBefore);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HOK-3108: claim on a record bound to another head rejects with head-mismatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-tend-handoff-mismatch-'));
  try {
    await publishReadyHandoff(dir, 42, 'head-a');
    const result = await claimReadyHandoff(dir, 42, 'head-b');
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.rejectionReason, 'head-mismatch');
    assert.equal(result.record?.headSha, 'head-a');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HOK-3108: claim on a terminal record rejects with terminal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-tend-handoff-terminal-'));
  try {
    await publishReadyHandoff(dir, 42, 'head-x');
    // Poke the record into terminal state directly, mirroring how the ready
    // engine marks records terminal after a failed transition.
    const path = readyTendHandoffPath(dir);
    const record = JSON.parse(readFileSync(path, 'utf-8'));
    record.state = 'terminal';
    record.terminalAt = new Date().toISOString();
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    const result = await claimReadyHandoff(dir, 42, 'head-x');
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.rejectionReason, 'terminal');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HOK-3108: claim on an unreadable handoff rejects with unreadable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-tend-handoff-unreadable-'));
  try {
    const path = readyTendHandoffPath(dir);
    writeFileSync(path, '{ not-json');
    const result = await claimReadyHandoff(dir, 42, 'head-x');
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.rejectionReason, 'unreadable');
    assert.equal(result.record, null);
    // The file is not rewritten (still corrupt).
    assert.equal(readFileSync(path, 'utf-8'), '{ not-json');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HOK-3108: claim on a foreign tend-claimed record rejects with foreign-claim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-tend-handoff-foreign-'));
  try {
    await publishReadyHandoff(dir, 42, 'head-x');
    const path = readyTendHandoffPath(dir);
    const record = JSON.parse(readFileSync(path, 'utf-8'));
    record.state = 'tend-claimed';
    // No tendOwner field or a different owner — either counts as foreign.
    delete record.tendOwner;
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    const result = await claimReadyHandoff(dir, 42, 'head-x');
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.rejectionReason, 'foreign-claim');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HOK-3108: rebindTendHandoff on a missing file rejects and does not create anything', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-tend-rebind-missing-'));
  try {
    const path = readyTendHandoffPath(dir);
    const result = await rebindTendHandoff(dir, 42, 'old', 'new');
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.rejectionReason, 'missing');
    assert.equal(result.record, null);
    assert.equal(existsSync(path), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HOK-3108: describeClaimRejection text names the head and PR', () => {
  const shortA = 'abc1234';
  assert.match(
    describeClaimRejection({ outcome: 'rejected', record: null, rejectionReason: 'missing' }, 42, `${shortA}56789`),
    /no Ready handoff file/,
  );
  assert.match(
    describeClaimRejection({ outcome: 'rejected', record: null, rejectionReason: 'unreadable' }, 42, `${shortA}56789`),
    /exists but is unreadable JSON/,
  );
  assert.match(
    describeClaimRejection({
      outcome: 'rejected',
      record: { version: 1, prNumber: 42, headSha: 'aaabbbcccdddeee', token: 't', state: 'ready-published' },
      rejectionReason: 'head-mismatch',
    }, 42, `${shortA}56789`),
    /bound to head aaabbbc, live head is abc1234/,
  );
  assert.match(
    describeClaimRejection({ outcome: 'rejected', record: null, rejectionReason: 'not-published' }, 42, `${shortA}56789`),
    /state 'checked'/,
  );
  assert.match(
    describeClaimRejection({ outcome: 'rejected', record: null, rejectionReason: 'terminal' }, 42, `${shortA}56789`),
    /is terminal/,
  );
  assert.match(
    describeClaimRejection({ outcome: 'rejected', record: null, rejectionReason: 'foreign-claim' }, 42, `${shortA}56789`),
    /tend-claimed by another owner/,
  );
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
