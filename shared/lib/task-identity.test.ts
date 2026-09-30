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
  isChallengerTaskId,
  isLinearWriter,
  parseTaskId,
  resolveLinearIssueId,
  type TaskIdentityMeta,
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

test('non-string inputs fail closed', () => {
  assert.equal(parseTaskId(undefined), null);
  assert.equal(parseTaskId(42), null);
  assert.equal(resolveLinearIssueId(null).ok, false);
  assert.equal(isLinearWriter(undefined), false);
});
