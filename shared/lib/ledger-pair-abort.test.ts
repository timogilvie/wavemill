/**
 * Replay fixtures for ledger pair abort walk (HOK-3186 — Ledger G Phase 3).
 */

import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { Ledger, TaskSettledError, type TaskRow } from './ledger.ts';
import { attemptPairAbortWalk } from './ledger-pair-abort.ts';
import { settleArmAbort, settleStep } from './ledger-shadow.ts';

interface FixtureTask {
  id: string;
  parent_id: string | null;
  kind: string;
  slug: string;
  inputs_hash: string | null;
  state: string;
  owner: string | null;
  next_action: string | null;
  deadline: string | null;
  background: number;
  replay: string;
  attempt: number;
  max_attempts: number | null;
  created_at: string;
  settled_at: string | null;
  settled_as: string | null;
  settled_reason: string | null;
}

interface SettleArmAction {
  settleArm: {
    armSlug: string;
    reason: string;
  };
}

interface AttemptSettleStepAction {
  attemptSettleStep: {
    stepId: string;
    as: string;
    expectError?: string;
  };
}

type FixtureAction = SettleArmAction | AttemptSettleStepAction;

interface Fixture {
  description: string;
  tasks: FixtureTask[];
  actions?: FixtureAction[];
  expected: Record<string, unknown>;
}

function loadFixture(name: string): Fixture {
  const fixturesDir = join(__dirname, '../../tests/fixtures/ledger-pair-abort');
  const path = join(fixturesDir, `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function seedLedger(ledger: Ledger, tasks: FixtureTask[]): void {
  for (const task of tasks) {
    ledger.transaction((tx) => {
      // Direct SQL insert to bypass schema validation for settled rows
      const db = (tx as any).db;
      db.prepare(`
        INSERT INTO task (
          id, parent_id, kind, slug, inputs_hash, state, owner, next_action,
          deadline, background, replay, attempt, max_attempts, created_at,
          settled_at, settled_as, settled_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.parent_id,
        task.kind,
        task.slug,
        task.inputs_hash,
        task.state,
        task.owner,
        task.next_action,
        task.deadline,
        task.background,
        task.replay,
        task.attempt,
        task.max_attempts,
        task.created_at,
        task.settled_at,
        task.settled_as,
        task.settled_reason,
      );
    });
  }
}

function findArmBySlug(ledger: Ledger, pairId: string, armSlug: string): string {
  const roots = ledger.listTasks({ kind: 'pair' });
  const pairRow = roots.find((row) => row.slug === pairId && row.parent_id === null);
  assert.ok(pairRow, `pair row not found: ${pairId}`);
  const arms = ledger.listChildren(pairRow.id).filter((row) => row.kind === 'arm');
  const armRow = arms.find((row) => row.slug === armSlug);
  assert.ok(armRow, `arm row not found: ${armSlug}`);
  return armRow.id;
}

await test('primary-aborted-challenger-green', () => {
  const fixture = loadFixture('primary-aborted-challenger-green');
  const tmpDir = mkdtempSync(join(tmpdir(), 'ledger-pair-abort-test-'));
  const dbPath = join(tmpDir, 'ledger.sqlite');

  const ledger = Ledger.open({ dbPath });
  try {
    seedLedger(ledger, fixture.tasks);

    const result = attemptPairAbortWalk(ledger, 'HOK-3172');

    assert.strictEqual(result.settled, fixture.expected.settled, 'pair should be settled');
    assert.strictEqual(result.survivorRole, fixture.expected.survivorRole, 'survivor role should be challenger');

    // Verify pair row is settled
    const pairRow = ledger.listTasks({ kind: 'pair' }).find((row) => row.slug === 'HOK-3172');
    assert.ok(pairRow, 'pair row should exist');
    assert.strictEqual(pairRow.settled_as, fixture.expected.pairSettledAs, 'pair should be settled as aborted');
    assert.strictEqual(
      pairRow.settled_reason,
      fixture.expected.pairSettledReason,
      'pair settled reason should be pair-settled:aborted-done',
    );
  } finally {
    ledger.close();
  }
});

await test('challenger-stalled-no-pr', () => {
  const fixture = loadFixture('challenger-stalled-no-pr');
  const tmpDir = mkdtempSync(join(tmpdir(), 'ledger-pair-abort-test-'));
  const dbPath = join(tmpDir, 'ledger.sqlite');

  const ledger = Ledger.open({ dbPath });
  try {
    seedLedger(ledger, fixture.tasks);

    // Execute actions
    if (fixture.actions) {
      for (const action of fixture.actions) {
        if ('settleArm' in action) {
          const armId = findArmBySlug(ledger, 'HOK-3128', action.settleArm.armSlug);
          settleArmAbort(ledger, armId, action.settleArm.reason);
        }
      }
    }

    const result = attemptPairAbortWalk(ledger, 'HOK-3128');

    assert.strictEqual(result.settled, fixture.expected.settled, 'pair should be settled');
    assert.strictEqual(result.survivorRole, fixture.expected.survivorRole, 'survivor role should be primary');

    // Verify pair row is settled
    const pairRow = ledger.listTasks({ kind: 'pair' }).find((row) => row.slug === 'HOK-3128');
    assert.ok(pairRow, 'pair row should exist');
    assert.strictEqual(pairRow.settled_as, fixture.expected.pairSettledAs, 'pair should be settled as aborted');
    assert.strictEqual(
      pairRow.settled_reason,
      fixture.expected.pairSettledReason,
      'pair settled reason should be pair-settled:done-aborted',
    );
  } finally {
    ledger.close();
  }
});

await test('eval-hard-failed-one-side', () => {
  const fixture = loadFixture('eval-hard-failed-one-side');
  const tmpDir = mkdtempSync(join(tmpdir(), 'ledger-pair-abort-test-'));
  const dbPath = join(tmpDir, 'ledger.sqlite');

  const ledger = Ledger.open({ dbPath });
  try {
    seedLedger(ledger, fixture.tasks);

    // Execute actions
    if (fixture.actions) {
      for (const action of fixture.actions) {
        if ('settleArm' in action) {
          const armId = findArmBySlug(ledger, 'HOK-3147', action.settleArm.armSlug);
          settleArmAbort(ledger, armId, action.settleArm.reason);
        }
      }
    }

    const result = attemptPairAbortWalk(ledger, 'HOK-3147');

    assert.strictEqual(result.settled, fixture.expected.settled, 'pair should be settled');
    assert.strictEqual(result.survivorRole, fixture.expected.survivorRole, 'survivor role should be challenger');

    // Verify pair row is settled
    const pairRow = ledger.listTasks({ kind: 'pair' }).find((row) => row.slug === 'HOK-3147');
    assert.ok(pairRow, 'pair row should exist');
    assert.strictEqual(pairRow.settled_as, fixture.expected.pairSettledAs, 'pair should be settled as aborted');
    assert.strictEqual(
      pairRow.settled_reason,
      fixture.expected.pairSettledReason,
      'pair settled reason should be pair-settled:aborted-done',
    );
  } finally {
    ledger.close();
  }
});

await test('post-reap-eval-write', () => {
  const fixture = loadFixture('post-reap-eval-write');
  const tmpDir = mkdtempSync(join(tmpdir(), 'ledger-pair-abort-test-'));
  const dbPath = join(tmpDir, 'ledger.sqlite');

  const ledger = Ledger.open({ dbPath });
  try {
    seedLedger(ledger, fixture.tasks);

    // Execute actions - attempt to settle an already-settled step
    if (fixture.actions) {
      for (const action of fixture.actions) {
        if ('attemptSettleStep' in action) {
          const { stepId, as, expectError } = action.attemptSettleStep;
          let threwExpectedError = false;
          try {
            settleStep(ledger, stepId, as as any);
          } catch (error) {
            if (error instanceof TaskSettledError && expectError === 'task_already_settled') {
              threwExpectedError = true;
            } else {
              throw error;
            }
          }
          assert.ok(threwExpectedError, `should have thrown ${expectError}`);
        }
      }
    }

    // Verify step is still settled and no new rows created
    const step = ledger.getTask('step-hok3125-eval');
    assert.ok(step, 'step should still exist');
    assert.strictEqual(step.settled_as, 'done', 'step should still be settled as done');

    // Count total rows - should match original fixture
    const allTasks = ledger.listTasks();
    assert.strictEqual(allTasks.length, fixture.tasks.length, 'no new rows should be created');
  } finally {
    ledger.close();
  }
});
