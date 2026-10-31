import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectFirstWave,
  selectLaunchSet,
  type QueuePlan,
  type ConflictEdge,
  type HeldTask,
} from './plan-queue-utils.ts';

const basePlan: QueuePlan = {
  availableNow: ['HOK-4', 'HOK-2', 'HOK-3', 'HOK-1'],
  queuedAfterDependencies: [],
  avoidRunningTogether: [['HOK-2', 'HOK-3']],
  sharedSurfaceConflicts: [{ a: 'HOK-2', b: 'HOK-3', files: [] }],
  needsTriage: [],
};

describe('selectFirstWave', () => {
  it('packs the first wave by score while enforcing shared-surface exclusions', () => {
    const result = selectFirstWave(
      basePlan,
      [
        { id: 'HOK-1', score: 40 },
        { id: 'HOK-2', score: 90 },
        { id: 'HOK-3', score: 85 },
        { id: 'HOK-4', score: 70 },
      ],
      { maxParallel: 3 },
    );

    assert.deepEqual(result, {
      wave: ['HOK-2', 'HOK-4', 'HOK-1'],
      deferred: ['HOK-3'],
    });
  });

  it('uses task id ordering to break equal-score ties deterministically', () => {
    const result = selectFirstWave(
      {
        ...basePlan,
        availableNow: ['HOK-10', 'HOK-2', 'HOK-1'],
        avoidRunningTogether: [],
        sharedSurfaceConflicts: [],
      },
      [
        { id: 'HOK-10', score: 50 },
        { id: 'HOK-2', score: 50 },
        { id: 'HOK-1', score: 50 },
      ],
      { maxParallel: 2 },
    );

    assert.deepEqual(result, {
      wave: ['HOK-1', 'HOK-2'],
      deferred: ['HOK-10'],
    });
  });

  it('defaults missing scores to zero without overriding dependency-safe availability', () => {
    const result = selectFirstWave(
      {
        ...basePlan,
        availableNow: ['HOK-5', 'HOK-6'],
        avoidRunningTogether: [],
        sharedSurfaceConflicts: [],
      },
      [{ id: 'HOK-6', score: 10 }],
      { maxParallel: 2 },
    );

    assert.deepEqual(result, {
      wave: ['HOK-6', 'HOK-5'],
      deferred: [],
    });
  });

  it('returns all available tasks as deferred when maxParallel is zero', () => {
    const result = selectFirstWave(basePlan, [], { maxParallel: 0 });
    assert.deepEqual(result, { wave: [], deferred: ['HOK-4', 'HOK-2', 'HOK-3', 'HOK-1'] });
  });

  it('rejects invalid queue plans and parallel limits', () => {
    assert.throws(
      () => selectFirstWave({ ...basePlan, availableNow: undefined as unknown as string[] }, [], { maxParallel: 1 }),
      /availableNow/,
    );
    assert.throws(() => selectFirstWave(basePlan, [], { maxParallel: -1 }), /maxParallel/);
  });

  it('is a thin wrapper over selectLaunchSet', () => {
    const plan: QueuePlan = {
      availableNow: ['HOK-10', 'HOK-11', 'HOK-12'],
      queuedAfterDependencies: [],
      avoidRunningTogether: [['HOK-10', 'HOK-11']],
      sharedSurfaceConflicts: [{ a: 'HOK-10', b: 'HOK-11', files: ['src/x.ts'] }],
      needsTriage: [],
    };
    const tasks = [
      { id: 'HOK-10', score: 90 },
      { id: 'HOK-11', score: 80 },
      { id: 'HOK-12', score: 70 },
    ];
    const wave = selectFirstWave(plan, tasks, { maxParallel: 1 });
    const set = selectLaunchSet(plan, tasks, { freeSlots: 1, inFlight: [] });
    assert.deepEqual(wave.wave, set.launchNext);
    assert.deepEqual(wave.deferred, [...set.held.map((h) => h.id), ...set.slotsFull]);
  });
});

const findHeld = (held: HeldTask[], id: string): HeldTask => {
  const row = held.find((h) => h.id === id);
  if (!row) throw new Error(`held entry missing for ${id}`);
  return row;
};

describe('selectLaunchSet', () => {
  it('breaks the transitive A~B~C chain so A and C both launch while B is held', () => {
    const plan: QueuePlan = {
      availableNow: ['HOK-A', 'HOK-B', 'HOK-C'],
      queuedAfterDependencies: [],
      avoidRunningTogether: [['HOK-A', 'HOK-B', 'HOK-C']], // preview-only cluster
      sharedSurfaceConflicts: [
        { a: 'HOK-A', b: 'HOK-B', files: ['src/shared.ts'] },
        { a: 'HOK-B', b: 'HOK-C', files: ['src/other.ts'] },
      ],
      needsTriage: [],
    };
    const result = selectLaunchSet(
      plan,
      [
        { id: 'HOK-A', score: 95 },
        { id: 'HOK-B', score: 50 },
        { id: 'HOK-C', score: 90 },
      ],
      { freeSlots: 5 },
    );

    assert.deepEqual(result.launchNext, ['HOK-A', 'HOK-C']);
    assert.deepEqual(result.slotsFull, []);
    assert.equal(result.held.length, 1);
    const bHold = findHeld(result.held, 'HOK-B');
    assert.equal(bHold.reason, 'conflicts_with_selected');
    assert.deepEqual(bHold.detail, {
      kind: 'conflicts_with_selected',
      taskId: 'HOK-A',
      files: ['src/shared.ts'],
    });
  });

  it('places every input id in exactly one of launchNext, held, or slotsFull', () => {
    const availableNow: string[] = [];
    for (let i = 1; i <= 20; i += 1) availableNow.push(`HOK-${i}`);
    const conflicts: ConflictEdge[] = [
      { a: 'HOK-1', b: 'HOK-2', files: [] },
      { a: 'HOK-3', b: 'HOK-4', files: [] },
      { a: 'HOK-15', b: 'HOK-16', files: [] },
    ];
    const plan: QueuePlan = {
      availableNow,
      queuedAfterDependencies: [{ taskId: 'HOK-20', ancestors: ['HOK-99'] }],
      avoidRunningTogether: [],
      sharedSurfaceConflicts: conflicts,
      needsTriage: [],
    };
    const tasks = availableNow.map((id, idx) => ({ id, score: 100 - idx }));
    const result = selectLaunchSet(plan, tasks, { freeSlots: 5 });

    const allIds = [
      ...result.launchNext,
      ...result.held.map((h) => h.id),
      ...result.slotsFull,
    ];
    assert.equal(allIds.length, availableNow.length);
    assert.equal(new Set(allIds).size, availableNow.length);
    for (const id of availableNow) assert.ok(allIds.includes(id), `missing ${id}`);

    const h20 = findHeld(result.held, 'HOK-20');
    assert.equal(h20.reason, 'depends_on');
  });

  it('holds a queued task that shares an edge with an in-flight task', () => {
    const plan: QueuePlan = {
      availableNow: ['HOK-100', 'HOK-101'],
      queuedAfterDependencies: [],
      avoidRunningTogether: [],
      sharedSurfaceConflicts: [{ a: 'HOK-100', b: 'HOK-900', files: ['src/handler.ts'] }],
      needsTriage: [],
    };
    const result = selectLaunchSet(
      plan,
      [
        { id: 'HOK-100', score: 90 },
        { id: 'HOK-101', score: 80 },
      ],
      {
        freeSlots: 3,
        inFlight: [{ id: 'HOK-900', prNumber: 1234, files: ['src/handler.ts', 'src/extra.ts'] }],
      },
    );

    assert.deepEqual(result.launchNext, ['HOK-101']);
    const h = findHeld(result.held, 'HOK-100');
    assert.equal(h.reason, 'conflicts_with_in_flight');
    assert.deepEqual(h.detail, {
      kind: 'conflicts_with_in_flight',
      taskId: 'HOK-900',
      prNumber: 1234,
      files: ['src/extra.ts', 'src/handler.ts'],
    });
  });

  it('is deterministic across repeat calls', () => {
    const plan: QueuePlan = {
      availableNow: ['HOK-1', 'HOK-2', 'HOK-3', 'HOK-4', 'HOK-5'],
      queuedAfterDependencies: [{ taskId: 'HOK-5', ancestors: ['HOK-99'] }],
      avoidRunningTogether: [],
      sharedSurfaceConflicts: [
        { a: 'HOK-1', b: 'HOK-2', files: [] },
        { a: 'HOK-3', b: 'HOK-4', files: [] },
      ],
      needsTriage: [],
    };
    const tasks = [
      { id: 'HOK-1', score: 50 },
      { id: 'HOK-2', score: 50 },
      { id: 'HOK-3', score: 40 },
      { id: 'HOK-4', score: 40 },
      { id: 'HOK-5', score: 100 },
    ];
    const a = selectLaunchSet(plan, tasks, { freeSlots: 2 });
    const b = selectLaunchSet(plan, tasks, { freeSlots: 2 });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  it('holds a task when its touch set is unknown (legacy meta.touchSetKnown)', () => {
    // protects: backward-compat path: no plan.touchSetStatus but meta.touchSetKnown: false
    const plan: QueuePlan = {
      availableNow: ['HOK-1', 'HOK-2'],
      queuedAfterDependencies: [],
      avoidRunningTogether: [],
      sharedSurfaceConflicts: [],
      needsTriage: [],
    };
    const result = selectLaunchSet(
      plan,
      [
        { id: 'HOK-1', score: 100, touchSetKnown: false },
        { id: 'HOK-2', score: 10 },
      ],
      { freeSlots: 3 },
    );

    assert.deepEqual(result.launchNext, ['HOK-2']);
    const h = findHeld(result.held, 'HOK-1');
    assert.equal(h.reason, 'touch_set_unknown');
    assert.deepEqual(h.detail, { kind: 'touch_set_unknown' });
  });

  it('holds a task when plan.touchSetStatus marks it unknown (HOK-3307)', () => {
    // protects: grounded planner path — plan carries the status, not meta
    const plan: QueuePlan = {
      availableNow: ['HOK-1', 'HOK-2'],
      queuedAfterDependencies: [],
      avoidRunningTogether: [],
      sharedSurfaceConflicts: [],
      needsTriage: [],
      touchSetStatus: { 'HOK-1': 'unknown', 'HOK-2': 'predicted' },
    };
    const result = selectLaunchSet(plan, [{ id: 'HOK-1', score: 100 }, { id: 'HOK-2', score: 10 }], { freeSlots: 3 });

    assert.deepEqual(result.launchNext, ['HOK-2']);
    const h = findHeld(result.held, 'HOK-1');
    assert.equal(h.reason, 'touch_set_unknown');
  });

  it('launches a task when plan.touchSetStatus marks it empty-confirmed (HOK-3307)', () => {
    // protects: empty-confirmed is safe — no files to conflict
    const plan: QueuePlan = {
      availableNow: ['HOK-1'],
      queuedAfterDependencies: [],
      avoidRunningTogether: [],
      sharedSurfaceConflicts: [],
      needsTriage: [],
      touchSetStatus: { 'HOK-1': 'empty-confirmed' },
    };
    const result = selectLaunchSet(plan, [{ id: 'HOK-1', score: 100 }], { freeSlots: 1 });
    assert.deepEqual(result.launchNext, ['HOK-1']);
    assert.deepEqual(result.held, []);
  });

  it('conservatively holds a task absent from plan.touchSetStatus when the map is present (HOK-3307)', () => {
    // protects: plan has a touchSetStatus map but this task is missing — conservative unknown
    const plan: QueuePlan = {
      availableNow: ['HOK-1', 'HOK-2'],
      queuedAfterDependencies: [],
      avoidRunningTogether: [],
      sharedSurfaceConflicts: [],
      needsTriage: [],
      touchSetStatus: { 'HOK-2': 'predicted' }, // HOK-1 absent from the map
    };
    const result = selectLaunchSet(plan, [{ id: 'HOK-1', score: 100 }, { id: 'HOK-2', score: 10 }], { freeSlots: 3 });

    assert.deepEqual(result.launchNext, ['HOK-2']);
    const h = findHeld(result.held, 'HOK-1');
    assert.equal(h.reason, 'touch_set_unknown');
  });

  it('respects an operator hold with an optional note', () => {
    const plan: QueuePlan = {
      availableNow: ['HOK-1', 'HOK-2'],
      queuedAfterDependencies: [],
      avoidRunningTogether: [],
      sharedSurfaceConflicts: [],
      needsTriage: [],
    };
    const result = selectLaunchSet(
      plan,
      [
        { id: 'HOK-1', score: 100, operatorHoldReason: 'paused-by-tim' },
        { id: 'HOK-2', score: 10 },
      ],
      { freeSlots: 3 },
    );

    const h = findHeld(result.held, 'HOK-1');
    assert.equal(h.reason, 'operator_hold');
    assert.deepEqual(h.detail, { kind: 'operator_hold', note: 'paused-by-tim' });
    assert.deepEqual(result.launchNext, ['HOK-2']);
  });

  it('emits slots_full once the free slots are exhausted', () => {
    const plan: QueuePlan = {
      availableNow: ['HOK-1', 'HOK-2', 'HOK-3', 'HOK-4'],
      queuedAfterDependencies: [],
      avoidRunningTogether: [],
      sharedSurfaceConflicts: [],
      needsTriage: [],
    };
    const result = selectLaunchSet(
      plan,
      [
        { id: 'HOK-1', score: 10 },
        { id: 'HOK-2', score: 20 },
        { id: 'HOK-3', score: 30 },
        { id: 'HOK-4', score: 40 },
      ],
      { freeSlots: 2 },
    );

    assert.deepEqual(result.launchNext, ['HOK-4', 'HOK-3']);
    assert.deepEqual(result.slotsFull, ['HOK-2', 'HOK-1']);
    assert.deepEqual(result.held, []);
  });

  it('rejects invalid inputs', () => {
    const plan: QueuePlan = {
      availableNow: ['HOK-1'],
      queuedAfterDependencies: [],
      avoidRunningTogether: [],
      sharedSurfaceConflicts: [],
      needsTriage: [],
    };
    assert.throws(
      () => selectLaunchSet(
        { ...plan, availableNow: undefined as unknown as string[] },
        [],
        { freeSlots: 1 },
      ),
      /availableNow/,
    );
    assert.throws(() => selectLaunchSet(plan, [], { freeSlots: -1 }), /freeSlots/);
  });

  it('breaks ties by priority after score', () => {
    const plan: QueuePlan = {
      availableNow: ['HOK-1', 'HOK-2', 'HOK-3'],
      queuedAfterDependencies: [],
      avoidRunningTogether: [],
      sharedSurfaceConflicts: [],
      needsTriage: [],
    };
    const result = selectLaunchSet(
      plan,
      [
        { id: 'HOK-1', score: 50, priority: 1 },
        { id: 'HOK-2', score: 50, priority: 3 },
        { id: 'HOK-3', score: 50, priority: 2 },
      ],
      { freeSlots: 2 },
    );
    assert.deepEqual(result.launchNext, ['HOK-2', 'HOK-3']);
    assert.deepEqual(result.slotsFull, ['HOK-1']);
  });
});
