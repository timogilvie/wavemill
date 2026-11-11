import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectFirstWave,
  selectLaunchSet,
  extractSizeHolds,
  extractPlanWarnings,
  type BacklogRecord,
  type QueuePlan,
  type ConflictEdge,
  type HeldTask,
} from './plan-queue-utils.ts';
import {
  evaluateTaskSize,
  renderSizeSection,
  type TaskSizeEstimate,
  type TaskSizeLimits,
  type TaskSizeSlice,
} from './task-size.ts';

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

// ────────────────────────────────────────────────────────────────
// HOK-3469: oversized-task size holds
// ────────────────────────────────────────────────────────────────

const sizeLimits: TaskSizeLimits = {
  enabled: true,
  maxAddedLines: 800,
  maxFiles: 12,
  coreFiles: ['shared/lib/wavemill-monitor.sh'],
  anchorCoreFile: 'shared/lib/wavemill-monitor.sh',
  maxCoreCompanions: 2,
};

function packetDescription(
  estimate: TaskSizeEstimate,
  slices: TaskSizeSlice[] = [],
  accepted: string[] = [],
): string {
  return renderSizeSection(estimate, evaluateTaskSize(estimate, sizeLimits), slices, {
    ...(accepted.length > 0 ? { accepted } : {}),
  });
}

const oversizedEstimate: TaskSizeEstimate = {
  addedLines: 1500,
  files: ['shared/lib/a.ts', 'shared/lib/b.ts'],
  coreFiles: [],
  linesSource: 'llm',
};
const smallEstimate: TaskSizeEstimate = {
  addedLines: 200,
  files: ['shared/lib/a.ts'],
  coreFiles: [],
  linesSource: 'llm',
};
const proposedSlices: TaskSizeSlice[] = [
  { title: 'Slice A', scope: 'First half.', files: ['shared/lib/a.ts'], estimatedAddedLines: 700 },
  { title: 'Slice B', scope: 'Second half.', files: ['shared/lib/b.ts'], estimatedAddedLines: 800 },
];

describe('extractSizeHolds', () => {
  // protects: an oversized recorded estimate is the one source of a size hold
  it('holds an oversized task and carries its reasons, slices and override state', () => {
    const holds = extractSizeHolds(
      [{ id: 'HOK-1', description: packetDescription(oversizedEstimate, proposedSlices) }],
      sizeLimits,
    );
    assert.deepEqual(holds['HOK-1'], {
      reasons: ['lines'],
      addedLines: 1500,
      fileCount: 2,
      coreFiles: [],
      slices: ['Slice A', 'Slice B'],
    });
  });

  // protects: a task under the limits, or with no estimate, launches exactly as today
  it('does not hold a within-limits task or a task with no estimate', () => {
    const holds = extractSizeHolds(
      [
        { id: 'HOK-SMALL', description: packetDescription(smallEstimate) },
        { id: 'HOK-PLAIN', description: 'No estimate here.' },
      ],
      sizeLimits,
    );
    assert.deepEqual(holds, {});
  });

  // protects: the operator override releases exactly one task
  it('skips a task carrying the size-override label', () => {
    const holds = extractSizeHolds(
      [
        {
          id: 'HOK-1',
          description: packetDescription(oversizedEstimate, proposedSlices),
          labels: ['wm:size-override'],
        },
      ],
      sizeLimits,
    );
    assert.deepEqual(holds, {});
  });

  // protects: a split parent never launches, even if the recorded numbers read small
  it('always holds a wm:split parent and keeps the accepted slice IDs', () => {
    const holds = extractSizeHolds(
      [
        {
          id: 'HOK-2',
          description: packetDescription(smallEstimate, proposedSlices, ['HOK-21', 'HOK-22']),
          labels: ['wm:split'],
        },
      ],
      sizeLimits,
    );
    assert.deepEqual(holds['HOK-2'].accepted, ['HOK-21', 'HOK-22']);
    assert.deepEqual(holds['HOK-2'].reasons, []);
  });

  // protects: an override on an already-split parent relaunches work that
  // became sub-issues, duplicating every slice.
  it('keeps a split parent held even when it carries the override label', () => {
    const holds = extractSizeHolds(
      [
        {
          id: 'HOK-2',
          description: packetDescription(smallEstimate, proposedSlices, ['HOK-21', 'HOK-22']),
          labels: ['wm:split', 'wm:size-override'],
        },
      ],
      sizeLimits,
    );
    assert.deepEqual(holds['HOK-2'].accepted, ['HOK-21', 'HOK-22']);
  });

  // protects: disabling the feature restores launch-as-today
  it('holds nothing when the feature is disabled', () => {
    const holds = extractSizeHolds(
      [{ id: 'HOK-1', description: packetDescription(oversizedEstimate, proposedSlices) }],
      { ...sizeLimits, enabled: false },
    );
    assert.deepEqual(holds, {});
  });

  // protects: a size-held task is not also reported as an unmet-precondition warning
  it('suppresses plan warnings for size-held tasks', () => {
    const warnings = extractPlanWarnings(
      [{ id: 'HOK-1', description: 'Decide the removal criterion after 7 days.' }],
      new Set(),
      {},
      { 'HOK-1': { reasons: ['lines'], addedLines: 1500, fileCount: 2, coreFiles: [], slices: [] } },
    );
    assert.deepEqual(warnings, []);
  });
});

describe('selectLaunchSet size holds', () => {
  // protects: an oversized task is never offered for launch and outranks touch-set uncertainty
  it('holds an oversized task ahead of touch-set uncertainty', () => {
    const plan: QueuePlan = {
      availableNow: ['HOK-1', 'HOK-2'],
      queuedAfterDependencies: [],
      avoidRunningTogether: [],
      sharedSurfaceConflicts: [],
      needsTriage: [],
      sizeHolds: {
        'HOK-1': {
          reasons: ['lines'],
          addedLines: 1500,
          fileCount: 2,
          coreFiles: [],
          slices: ['Slice A', 'Slice B'],
        },
      },
    };
    const result = selectLaunchSet(
      plan,
      [
        { id: 'HOK-1', score: 90, touchSetKnown: false },
        { id: 'HOK-2', score: 80, touchSetKnown: true },
      ],
      { freeSlots: 2 },
    );
    assert.deepEqual(result.launchNext, ['HOK-2']);
    const hold = findHeld(result.held, 'HOK-1');
    assert.equal(hold.reason, 'oversized_task');
    assert.deepEqual(hold.detail, {
      kind: 'oversized_task',
      reasons: ['lines'],
      addedLines: 1500,
      fileCount: 2,
      slices: ['Slice A', 'Slice B'],
    });
  });

  // protects: an oversized task outranks a dependency hold it may also carry
  it('holds an oversized task ahead of a dependency hold', () => {
    const plan: QueuePlan = {
      availableNow: ['HOK-1', 'HOK-2'],
      queuedAfterDependencies: [{ taskId: 'HOK-1', ancestors: ['HOK-9'] }],
      avoidRunningTogether: [],
      sharedSurfaceConflicts: [],
      needsTriage: [],
      sizeHolds: {
        'HOK-1': { reasons: ['files'], addedLines: null, fileCount: 20, coreFiles: [], slices: [], accepted: ['HOK-3'] },
      },
    };
    const result = selectLaunchSet(plan, [{ id: 'HOK-1', score: 90 }, { id: 'HOK-2', score: 80 }], {
      freeSlots: 2,
    });
    const hold = findHeld(result.held, 'HOK-1');
    assert.equal(hold.reason, 'oversized_task');
    assert.deepEqual(hold.detail, {
      kind: 'oversized_task',
      reasons: ['files'],
      fileCount: 20,
      slices: [],
      accepted: ['HOK-3'],
    });
  });

  // protects: a plan without size holds keeps today's launch selection exactly
  it('leaves selection unchanged when no size holds are recorded', () => {
    const plan: QueuePlan = {
      availableNow: ['HOK-1', 'HOK-2', 'HOK-3'],
      queuedAfterDependencies: [],
      avoidRunningTogether: [],
      sharedSurfaceConflicts: [],
      needsTriage: [],
    };
    const tasks = [
      { id: 'HOK-1', score: 90 },
      { id: 'HOK-2', score: 80 },
      { id: 'HOK-3', score: 70 },
    ];
    const withHolds = selectLaunchSet({ ...plan, sizeHolds: {} }, tasks, { freeSlots: 2 });
    const withoutHolds = selectLaunchSet(plan, tasks, { freeSlots: 2 });
    assert.deepEqual(withHolds, withoutHolds);
    assert.equal(withHolds.held.some((held) => held.reason === 'oversized_task'), false);
  });

  // protects: the recommended (first-wave) launch path respects size holds too
  it('holds an oversized task from the recommended first wave', () => {
    const plan: QueuePlan = {
      availableNow: ['HOK-1', 'HOK-2'],
      queuedAfterDependencies: [],
      avoidRunningTogether: [],
      sharedSurfaceConflicts: [],
      needsTriage: [],
      sizeHolds: {
        'HOK-1': { reasons: ['lines'], addedLines: 1500, fileCount: 2, coreFiles: [], slices: [] },
      },
    };
    const result = selectFirstWave(plan, [{ id: 'HOK-1', score: 90 }, { id: 'HOK-2', score: 80 }], {
      maxParallel: 2,
    });
    assert.deepEqual(result.wave, ['HOK-2']);
  });
});
