/**
 * HOK-3303 property-based tests for `selectLaunchSet`.
 *
 * Pins the picker 1/9 invariants:
 *   - Every input id lands in exactly one of `launchNext`, `held`, `slotsFull`.
 *   - No two ids in `launchNext` share a `sharedSurfaceConflicts` edge.
 *   - No id in `launchNext` shares an edge with any `inFlight` id.
 *   - Same input ⇒ same output byte-for-byte (deterministic).
 *   - Every `held[i].reason` is one of the six documented values and matches
 *     the `detail.kind` discriminant.
 *
 * Follows the HOK-3230 pattern (`assertProperty` for seeded replay). Inputs
 * are capped (≤ 10 tasks, sublinear edges) and `numRuns` is halved to 150 so
 * the suite stays inside the ≤ 5 s unit-test budget.
 */
import test from 'node:test';
import fc from 'fast-check';
import assert from 'node:assert/strict';
import {
  selectLaunchSet,
  type ConflictEdge,
  type HoldReason,
  type InFlightTask,
  type QueuePlan,
  type TaskWithScore,
} from './plan-queue-utils.ts';
import { assertProperty } from './fast-check-utils.ts';

const HOLD_REASONS: HoldReason[] = [
  'depends_on',
  'conflicts_with_selected',
  'conflicts_with_in_flight',
  'slots_full',
  'touch_set_unknown',
  'operator_hold',
];

/** Up to 10 task ids drawn from HOK-1 .. HOK-30. */
function arbitraryTaskIds(): fc.Arbitrary<string[]> {
  return fc
    .uniqueArray(fc.integer({ min: 1, max: 30 }), { minLength: 2, maxLength: 10 })
    .map((nums) => nums.map((n) => `HOK-${n}`));
}

interface ScenarioInput {
  ids: string[];
  conflicts: ConflictEdge[];
  tasks: TaskWithScore[];
  freeSlots: number;
  inFlight: InFlightTask[];
}

function arbitraryScenario(): fc.Arbitrary<ScenarioInput> {
  return arbitraryTaskIds().chain((ids) => {
    const pairIndices: Array<[number, number]> = [];
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) pairIndices.push([i, j]);
    }
    const edgesArb = fc
      .subarray(pairIndices, { minLength: 0, maxLength: Math.min(pairIndices.length, ids.length) })
      .map((pairs) =>
        pairs.map(([i, j]): ConflictEdge => ({ a: ids[i]!, b: ids[j]!, files: [] })),
      );
    const tasksArb = fc.tuple(
      ...ids.map((id) =>
        fc.record({
          id: fc.constant(id),
          score: fc.integer({ min: 0, max: 100 }),
          priority: fc.integer({ min: -5, max: 5 }),
        }),
      ),
    );
    const freeSlotsArb = fc.integer({ min: 0, max: ids.length + 1 });
    const inFlightIdsArb = fc
      .uniqueArray(fc.integer({ min: 1, max: 30 }), { minLength: 0, maxLength: 3 })
      .map((nums) =>
        nums.map((n): InFlightTask => ({
          id: `HOK-${n}`,
          prNumber: n,
          files: [],
        })),
      );
    return fc.record({
      ids: fc.constant(ids),
      conflicts: edgesArb,
      tasks: tasksArb,
      freeSlots: freeSlotsArb,
      inFlight: inFlightIdsArb,
    });
  });
}

function makePlan(ids: string[], conflicts: ConflictEdge[]): QueuePlan {
  return {
    availableNow: [...ids],
    queuedAfterDependencies: [],
    avoidRunningTogether: [],
    sharedSurfaceConflicts: conflicts,
    needsTriage: [],
  };
}

function conflictKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

test('selectLaunchSet: no two launched tasks share a conflict edge and none conflicts with in-flight', () => {
  assertProperty(
    fc.property(arbitraryScenario(), (scenario) => {
      const plan = makePlan(scenario.ids, scenario.conflicts);
      const result = selectLaunchSet(plan, scenario.tasks, {
        freeSlots: scenario.freeSlots,
        inFlight: scenario.inFlight,
      });
      const edgeKeys = new Set(scenario.conflicts.map((e) => conflictKey(e.a, e.b)));
      const inFlightIds = new Set(scenario.inFlight.map((t) => t.id));
      for (let i = 0; i < result.launchNext.length; i += 1) {
        for (let j = i + 1; j < result.launchNext.length; j += 1) {
          const key = conflictKey(result.launchNext[i]!, result.launchNext[j]!);
          if (edgeKeys.has(key)) return false;
        }
      }
      for (const launched of result.launchNext) {
        for (const inFlight of inFlightIds) {
          if (edgeKeys.has(conflictKey(launched, inFlight))) return false;
        }
      }
      return true;
    }),
    { name: 'launchNext is pairwise-safe', numRuns: 150 },
  );
});

test('selectLaunchSet: every input id appears exactly once across the three output arrays', () => {
  assertProperty(
    fc.property(arbitraryScenario(), (scenario) => {
      const plan = makePlan(scenario.ids, scenario.conflicts);
      const result = selectLaunchSet(plan, scenario.tasks, {
        freeSlots: scenario.freeSlots,
        inFlight: scenario.inFlight,
      });
      const all = [
        ...result.launchNext,
        ...result.held.map((h) => h.id),
        ...result.slotsFull,
      ];
      if (all.length !== scenario.ids.length) return false;
      if (new Set(all).size !== scenario.ids.length) return false;
      const inputSet = new Set(scenario.ids);
      for (const id of all) {
        if (!inputSet.has(id)) return false;
      }
      return true;
    }),
    { name: 'launchNext/held/slotsFull partition the input', numRuns: 150 },
  );
});

test('selectLaunchSet: same input yields byte-identical output', () => {
  assertProperty(
    fc.property(arbitraryScenario(), (scenario) => {
      const plan = makePlan(scenario.ids, scenario.conflicts);
      const a = selectLaunchSet(plan, scenario.tasks, {
        freeSlots: scenario.freeSlots,
        inFlight: scenario.inFlight,
      });
      const b = selectLaunchSet(plan, scenario.tasks, {
        freeSlots: scenario.freeSlots,
        inFlight: scenario.inFlight,
      });
      return JSON.stringify(a) === JSON.stringify(b);
    }),
    { name: 'selectLaunchSet is deterministic', numRuns: 150 },
  );
});

test('selectLaunchSet: every held entry has one HoldReason and detail.kind matches', () => {
  assertProperty(
    fc.property(arbitraryScenario(), (scenario) => {
      const plan = makePlan(scenario.ids, scenario.conflicts);
      const result = selectLaunchSet(plan, scenario.tasks, {
        freeSlots: scenario.freeSlots,
        inFlight: scenario.inFlight,
      });
      for (const h of result.held) {
        if (!HOLD_REASONS.includes(h.reason)) return false;
        if (h.detail.kind !== h.reason) return false;
      }
      return true;
    }),
    { name: 'held reason matches detail.kind', numRuns: 150 },
  );
});

// Keep one non-property smoke so the file reports a positive assertion count
// if the fast-check pass runs with zero inputs (should never happen, but makes
// a flaky `assertProperty` wiring regression impossible to miss).
test('selectLaunchSet: empty plan yields empty result', () => {
  const result = selectLaunchSet(
    {
      availableNow: [],
      queuedAfterDependencies: [],
      avoidRunningTogether: [],
      sharedSurfaceConflicts: [],
      needsTriage: [],
    },
    [],
    { freeSlots: 3 },
  );
  assert.deepEqual(result, { launchNext: [], held: [], slotsFull: [] });
});
