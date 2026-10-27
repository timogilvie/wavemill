import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeTendAttemptPhase,
  readTendAttemptFact,
  readValidTendAttemptFact,
  resolveIntegrationBaseSha,
  tendAttemptBlockReason,
  tendAttemptFactHandle,
  tendAttemptFactHolds,
  TEND_ATTEMPT_FACT_FILE,
  writeTendAttemptFact,
} from './tend-attempt-fact.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wavemill-tend-attempt-fact-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fact = {
  phase: 'rebase' as const,
  prNumber: 1697,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  excerpt: 'CONFLICT (content): Merge conflict in shared/validators/wavemill-config.validator.cjs',
  failureClass: 'code-failure' as const,
};

test('writes one condition-keyed marker the reconciler can expire', () => {
  writeTendAttemptFact(dir, fact);
  const raw = JSON.parse(readFileSync(join(dir, TEND_ATTEMPT_FACT_FILE), 'utf8'));
  assert.equal(raw.kind, 'tend-attempt');
  assert.equal(raw.headSha, fact.headSha);
  assert.equal(raw.reason, 'tend-rebase-failed');
  assert.deepEqual(raw.condition.expiresOn, ['remote', 'operator-event']);
  assert.deepEqual(raw.condition.observed, { prHeadRefOid: fact.headSha, integrationBaseSha: fact.baseSha });
  assert.equal(raw.condition.operatorEventSeq, 0);
  assert.equal(raw.detail.failureClass, 'code-failure');
});

test('records the current operator-event seq so only a later event expires the fact', () => {
  writeFileSync(join(dir, '.operator-events.jsonl'), '{"seq":1}\n{"seq":2}\n');
  writeTendAttemptFact(dir, fact);
  const raw = JSON.parse(readFileSync(tendAttemptFactHandle(dir).path, 'utf8'));
  assert.equal(raw.condition.operatorEventSeq, 2);
});

test('round-trips and holds only for the recorded head and base', () => {
  writeTendAttemptFact(dir, fact);
  const read = readTendAttemptFact(dir);
  assert.equal(read?.phase, 'rebase');
  assert.equal(read?.excerpt, fact.excerpt);
  assert.ok(readValidTendAttemptFact(dir, { prHeadSha: fact.headSha, integrationBaseSha: fact.baseSha }));
  assert.equal(readValidTendAttemptFact(dir, { prHeadSha: 'c'.repeat(40), integrationBaseSha: fact.baseSha }), null, 'new head');
  assert.equal(readValidTendAttemptFact(dir, { prHeadSha: fact.headSha, integrationBaseSha: 'd'.repeat(40) }), null, 'moved base');
  assert.equal(readValidTendAttemptFact(dir, { prHeadSha: fact.headSha }), null, 'unknown live base never validates');
});

test('a fact recorded without a base holds on the head alone', () => {
  assert.equal(tendAttemptFactHolds({ headSha: 'h', baseSha: '' }, { prHeadSha: 'h' }), true);
  assert.equal(tendAttemptFactHolds({ headSha: 'h', baseSha: '' }, { prHeadSha: 'x' }), false);
  assert.equal(tendAttemptFactHolds({ headSha: '', baseSha: '' }, { prHeadSha: '' }), false);
});

test('absent, legacy and foreign-kind files read as no fact', () => {
  assert.equal(readTendAttemptFact(dir), null);
  writeFileSync(join(dir, TEND_ATTEMPT_FACT_FILE), 'not json');
  assert.equal(readTendAttemptFact(dir), null);
  writeFileSync(join(dir, TEND_ATTEMPT_FACT_FILE), JSON.stringify({ schemaVersion: 1, kind: 'pr-label', headSha: 'h', writtenAt: 'x', detail: { phase: 'rebase' } }));
  assert.equal(readTendAttemptFact(dir), null);
});

test('normalizes tend block phases onto the closed set', () => {
  assert.equal(normalizeTendAttemptPhase('rebase'), 'rebase');
  assert.equal(normalizeTendAttemptPhase('worktree-timeout'), 'worktree');
  assert.equal(normalizeTendAttemptPhase('handoff-rebind-deferred'), 'handoff');
  assert.equal(normalizeTendAttemptPhase('something-new'), 'merge');
  assert.equal(tendAttemptBlockReason('checks'), 'tend-checks-failed');
});

test('resolves the integration tip from the remote-tracking ref only', () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
  const sha = git('rev-parse', 'HEAD');
  assert.equal(resolveIntegrationBaseSha(dir, 'auto/integration'), undefined);
  git('update-ref', 'refs/remotes/origin/auto/integration', sha);
  assert.equal(resolveIntegrationBaseSha(dir, 'auto/integration'), sha);
});
