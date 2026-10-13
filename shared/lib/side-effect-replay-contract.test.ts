/**
 * HOK-3183 replay-contract test (Ledger D Phase 1 acceptance).
 *
 * Drives the shadow-instrumented call sites through the two HOK-3177 replay
 * fixtures and asserts the `side_effect` rows they leave are the shape the
 * Phase 2 flip relies on ("insert row → read applied_at → skip or apply"):
 *
 *   dropped-connection-push → a push whose connection dropped after the remote
 *       accepted it is re-sent for the same (remote, ref, oid): the retry
 *       finds an applied row (a flipped site skips it) and the detector
 *       reports exactly one duplicate.
 *   github-head-lag         → the label reconciler re-applies `wm:ready` while
 *       GitHub still reports the pre-push head: same (pr, label, action, head)
 *       key, applied row, one duplicate; the label at the converged head is a
 *       new key, never confused with the stale one.
 */
import { afterEach, beforeEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, type SideEffectRow } from './ledger.ts';
import * as github from './github.ts';
import { publishReviewedBranch } from './branch-publication.ts';
import { detectDuplicates } from './side-effect-duplicate-detector.ts';
import { gitPushKey, prLabelKey, setSideEffectLedgerForTesting, shadowRecordSideEffect } from './side-effect-ledger.ts';

const FIXTURE_DIR = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'incident-replay');

let dir: string;
let ledger: Ledger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wavemill-side-effect-replay-'));
  ledger = Ledger.open({ dbPath: join(dir, 'ledger.sqlite') });
  setSideEffectLedgerForTesting(ledger);
});

afterEach(() => {
  mock.restoreAll();
  setSideEffectLedgerForTesting(null);
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf-8')) as T;
}

/** The Phase 2 flipped-site decision, evaluated against the shadow row. */
function flippedSiteDecision(row: SideEffectRow | null): 'apply' | 'skip' {
  return row?.applied_at ? 'skip' : 'apply';
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('dropped-connection-push: a re-sent push of the same oid is one row, one duplicate, skipped once flipped', () => {
  const fixture = readFixture<{ fault: string; faultParams: { throwCount: number } }>('dropped-connection-push');
  assert.equal(fixture.fault, 'dropped_connection_push_rebase');

  // Real publication against a bare origin: the first call pushes.
  const remoteDir = join(dir, 'origin.git');
  const repoDir = join(dir, 'work');
  execFileSync('git', ['init', '--bare', remoteDir]);
  execFileSync('git', ['init', repoDir]);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Replay Test']);
  git(repoDir, ['remote', 'add', 'origin', remoteDir]);
  git(repoDir, ['switch', '-c', 'task/replay']);
  writeFileSync(join(repoDir, 'f.txt'), 'x\n');
  git(repoDir, ['add', 'f.txt']);
  git(repoDir, ['commit', '-m', 'replay']);
  const oid = git(repoDir, ['rev-parse', 'HEAD']);

  const published = publishReviewedBranch({ worktreeDir: repoDir, branch: 'task/replay', reviewedSha: oid });
  assert.equal(published.ok && published.outcome, 'pushed');
  const key = gitPushKey('origin', 'task/replay', oid);
  assert.equal(flippedSiteDecision(ledger.findSideEffect('git-push', key)), 'skip', 'the landed push is applied');

  // The client saw the connection drop `throwCount` times and re-sent the same oid.
  for (let retry = 0; retry < fixture.faultParams.throwCount; retry += 1) {
    shadowRecordSideEffect({ kind: 'git-push', idempotencyKey: key, result: { outcome: 'pushed', source: 'tend-rebase' } });
  }
  const row = ledger.findSideEffect('git-push', key)!;
  assert.equal(row.attempt, fixture.faultParams.throwCount);
  assert.equal(ledger.listSideEffectsByKind('git-push').length, 1, 'no second row for the same (remote, ref, oid)');

  // Re-publishing an already-published branch is an observation, not a push.
  const reused = publishReviewedBranch({ worktreeDir: repoDir, branch: 'task/replay', reviewedSha: oid });
  assert.equal(reused.ok && reused.outcome, 'reused');
  assert.equal(ledger.findSideEffect('git-push', key)!.attempt, fixture.faultParams.throwCount);

  const detected = detectDuplicates(ledger, { labelWrites: [] });
  assert.equal(detected.duplicates, 1);
  assert.equal(detected.findings[0].category === 'duplicate' && detected.findings[0].idempotencyKey, key);
});

test('github-head-lag: a re-applied label at the lagging head is one duplicate; the converged head is a new key', () => {
  const fixture = readFixture<{ fault: string }>('github-head-lag');
  assert.equal(fixture.fault, 'github_head_lag');

  const view = { head: 'pre-push-head' };
  mock.method(github.githubDeps, 'execShellCommand', () => '');
  mock.method(github.githubDeps, 'resolveOwnerRepo', () => 'acme/widgets');
  mock.method(github.githubDeps, 'recordLabelWrite', () => {});
  mock.method(github.githubDeps, 'getPullRequest', () => ({ number: 42, headRefOid: view.head, labels: [] }));

  // GitHub still serves the pre-push head: the reconciler labels twice.
  github.addLabelsToPullRequest(42, ['wm:ready']);
  const staleKey = prLabelKey(42, 'wm:ready', 'labeled', 'pre-push-head');
  assert.equal(flippedSiteDecision(ledger.findSideEffect('pr-label', staleKey)), 'skip', 'a flipped site would not re-label');
  github.addLabelsToPullRequest(42, ['wm:ready']);
  assert.equal(ledger.findSideEffect('pr-label', staleKey)!.attempt, 1);

  // Head converges: the label at the new head is a distinct, first-time key.
  view.head = 'pushed-head';
  github.addLabelsToPullRequest(42, ['wm:ready']);
  const freshKey = prLabelKey(42, 'wm:ready', 'labeled', 'pushed-head');
  assert.equal(ledger.findSideEffect('pr-label', freshKey)!.attempt, 0);

  // A removal is keyed separately from the add.
  github.removeLabelFromPullRequest(42, 'wm:ready');
  assert.ok(ledger.findSideEffect('pr-label', prLabelKey(42, 'wm:ready', 'unlabeled', 'pushed-head')));

  const detected = detectDuplicates(ledger, { labelWrites: [] });
  assert.equal(detected.duplicates, 1);
  assert.equal(detected.findings[0].category === 'duplicate' && detected.findings[0].idempotencyKey, staleKey);
});

test('a label removal that GitHub reports as already absent records no row', () => {
  mock.method(github.githubDeps, 'execShellCommand', () => { throw new Error('HTTP 404: Label does not exist'); });
  mock.method(github.githubDeps, 'resolveOwnerRepo', () => 'acme/widgets');
  mock.method(github.githubDeps, 'getPullRequest', () => ({ number: 42, headRefOid: 'h', labels: [] }));
  github.removeLabelFromPullRequest(42, 'wm:ready');
  assert.equal(ledger.listSideEffectsByKind('pr-label').length, 0);
});
