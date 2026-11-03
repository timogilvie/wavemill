/**
 * HOK-3114 — unit tests for the task identity invariant.
 *
 * Every row in tests/fixtures/task-identity-cases.json is asserted here and in
 * tests/task-identity.test.sh against shared/lib/task-identity.sh, so the two
 * implementations agree on every row.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHALLENGER_SUFFIX,
  ISSUE_ID_RE,
  ISSUE_ID_WORD_RE,
  TASK_ID_RE,
  TASK_ID_SUFFIX_RE,
  WINDOW_TASK_PREFIX_RE,
  challengerTaskId,
  challengerTaskKey,
  extractProseDependencies,
  isChallengerTaskId,
  isLinearWriter,
  parseTaskId,
  resolveLinearIssueId,
  type TaskIdentityMeta,
  type ProseDepReference,
} from './task-identity.ts';

interface FixtureCase {
  name: string;
  taskId: string;
  task: TaskIdentityMeta | null;
  expected: {
    parse: { taskId: string; linearId: string; role: string } | null;
    linearId: string | null;
    error: string | null;
    isChallenger: boolean;
    isLinearWriter: boolean;
    challengerId: string | null;
    challengerKey: string;
  };
}

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures/task-identity-cases.json');
const { cases } = JSON.parse(readFileSync(fixturePath, 'utf8')) as { cases: FixtureCase[] };

for (const c of cases) {
  test(`fixture: ${c.name}`, () => {
    assert.deepEqual(parseTaskId(c.taskId), c.expected.parse);

    const resolved = resolveLinearIssueId(c.taskId, c.task);
    if (c.expected.error) {
      assert.equal(resolved.ok, false);
      assert.equal(!resolved.ok && resolved.error, c.expected.error);
    } else {
      assert.deepEqual(resolved, { ok: true, linearId: c.expected.linearId });
    }

    assert.equal(isChallengerTaskId(c.taskId), c.expected.isChallenger);
    assert.equal(isLinearWriter(c.taskId, c.task), c.expected.isLinearWriter);

    if (c.expected.challengerId === null) {
      assert.throws(() => challengerTaskId(c.taskId), /Invalid task ID/);
    } else {
      assert.equal(challengerTaskId(c.taskId), c.expected.challengerId);
    }
    assert.equal(challengerTaskKey(c.taskId), c.expected.challengerKey);
  });
}

test('fixtures cover the required shapes', () => {
  const names = cases.map((c) => c.name).join('\n');
  for (const needle of ['primary', 'challenger', 'URL', 'garbage', 'lowercase', 'digits', 'agrees', 'disagrees', 'missing']) {
    assert.match(names, new RegExp(needle), `no fixture row mentions ${needle}`);
  }
});

test('constants', () => {
  assert.equal(CHALLENGER_SUFFIX, '_c');
  assert.ok(ISSUE_ID_RE.test('H2O-1'));
  assert.ok(!ISSUE_ID_RE.test('2HO-1'));
});

test('derived consumer patterns accept digit-bearing team keys', () => {
  assert.ok(TASK_ID_RE.test('AB2-1'));
  assert.ok(TASK_ID_RE.test('AB2-1_c'));
  assert.ok(!TASK_ID_RE.test('AB2-1_c-extra'));
  assert.deepEqual(WINDOW_TASK_PREFIX_RE.exec('AB2-1_c-coding')?.slice(1), ['AB2-1_c', 'coding']);
  assert.ok(TASK_ID_SUFFIX_RE.test('coding-AB2-1_c'));
  assert.equal('failed AB2-1_c task'.match(ISSUE_ID_WORD_RE)?.[0], 'AB2-1_c');
});

test('challengerTaskId builds the _c ID and is idempotent', () => {
  assert.equal(challengerTaskId('HOK-1'), 'HOK-1_c');
  assert.equal(challengerTaskId('HOK-1_c'), 'HOK-1_c');
  assert.equal(challengerTaskId('https://linear.app/hokusai/issue/HOK-1/slug'), 'HOK-1_c');
  assert.throws(() => challengerTaskId('hok-1'), /Invalid task ID/);
});

test('challengerTaskKey matches challengerTaskId for valid pair IDs and never throws', () => {
  assert.equal(challengerTaskKey('HOK-1'), challengerTaskId('HOK-1'));
  // Opaque pair IDs (legacy state, fixtures) keep the verbatim suffix.
  assert.equal(challengerTaskKey('pair-1'), 'pair-1_c');
  // A drifted challenger-shaped pair ID must not collapse onto the arm itself.
  assert.equal(challengerTaskKey('HOK-1_c'), 'HOK-1_c_c');
});

test('non-string inputs fail closed', () => {
  assert.equal(parseTaskId(undefined), null);
  assert.equal(parseTaskId(42), null);
  assert.equal(resolveLinearIssueId(null).ok, false);
  assert.equal(isLinearWriter(undefined), false);
});

test('extractProseDependencies: issue ID references', () => {
  const refs = extractProseDependencies('This is blocked. Blocked by HOK-123.');
  assert.equal(refs.length, 1);
  const ref = refs[0] as ProseDepReference;
  assert.equal(ref.kind, 'issue');
  assert.equal(ref.target, 'HOK-123');
  assert.equal(ref.verb, 'Blocked by');
  assert.match(ref.evidence, /Blocked by HOK-123/);
});

test('extractProseDependencies: series code references', () => {
  const refs = extractProseDependencies('This depends on B2. We need B2 to land first.');
  assert.equal(refs.length, 1);
  const ref = refs[0] as ProseDepReference;
  assert.equal(ref.kind, 'series');
  assert.equal(ref.target, 'B2');
  assert.equal(ref.verb, 'Depends on');
  assert.match(ref.evidence, /depends on B2/i);
});

test('extractProseDependencies: case-insensitive matching', () => {
  const refs1 = extractProseDependencies('blocked by HOK-123.');
  assert.equal(refs1.length, 1);
  assert.equal(refs1[0]?.kind, 'issue');

  const refs2 = extractProseDependencies('DEPENDS ON B2.');
  assert.equal(refs2.length, 1);
  assert.equal(refs2[0]?.kind, 'series');
});

test('extractProseDependencies: "After" verb', () => {
  const refs = extractProseDependencies('This should be done after HOK-100.');
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.verb, 'After');
  assert.equal(refs[0]?.kind, 'issue');
});

test('extractProseDependencies: "Once ... lands" verb', () => {
  const refs = extractProseDependencies('This is blocked. Once B3 lands we can proceed.');
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.verb, 'Once B3 lands');
  assert.equal(refs[0]?.kind, 'series');
});

test('extractProseDependencies: multiple references', () => {
  const refs = extractProseDependencies('Blocked by HOK-100. Also depends on B2.');
  assert.equal(refs.length, 2);
  assert.equal(refs[0]?.kind, 'issue');
  assert.equal(refs[1]?.kind, 'series');
});

test('extractProseDependencies: no matches returns empty array', () => {
  const refs1 = extractProseDependencies('This is just normal text');
  assert.equal(refs1.length, 0);

  const refs2 = extractProseDependencies(null);
  assert.equal(refs2.length, 0);

  const refs3 = extractProseDependencies(undefined);
  assert.equal(refs3.length, 0);
});

test('extractProseDependencies: sentence boundary extraction', () => {
  const text = 'First sentence. Blocked by HOK-123. Another sentence.';
  const refs = extractProseDependencies(text);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.evidence, 'Blocked by HOK-123.');
});

test('extractProseDependencies: evidence is capped at 300 chars', () => {
  const longText = 'Blocked by HOK-123. ' + 'x'.repeat(400);
  const refs = extractProseDependencies(longText);
  assert.equal(refs.length, 1);
  assert(refs[0]!.evidence.length <= 302); // 300 + potential ellipsis indicator
});

test('extractProseDependencies: series code pattern is narrow (no hyphens)', () => {
  const refs = extractProseDependencies('Blocked by HOK-123 and depends on B2.');
  // Should get both: HOK-123 (issue) and B2 (series)
  assert.equal(refs.length, 2);
  assert.equal(refs[0]?.kind, 'issue');
  assert.equal(refs[0]?.target, 'HOK-123');
  assert.equal(refs[1]?.kind, 'series');
  assert.equal(refs[1]?.target, 'B2');
});
