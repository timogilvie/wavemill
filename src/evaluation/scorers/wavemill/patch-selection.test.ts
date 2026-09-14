import { test } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import {
  scorePatchSelection,
  type PatchSelectionScoreRecord,
  WAVEMILL_PATCH_SELECTION_SCORER_ID,
} from './patch-selection.ts';
import type { ReplayPatchSelectionInstance } from '../../../../shared/fixtures/harness-replay/patch-selection-v1/schema.ts';

const createTestInstance = (overrides: Partial<ReplayPatchSelectionInstance> = {}): ReplayPatchSelectionInstance => ({
  id: 'test-1',
  taskTitle: 'Test',
  taskDescription: 'Test description',
  candidates: [
    {
      id: 'good',
      patch: 'good patch',
      patchSizeBytes: 10,
    },
    {
      id: 'bad',
      patch: 'bad patch',
      patchSizeBytes: 9,
    },
  ],
  knownGoodCandidateId: 'good',
  knownBadCandidateIds: ['bad'],
  source: {
    curationRationale: 'merged_winner',
    sanitized: true,
  },
  heldOut: false,
  curatedAt: Date.now(),
  ...overrides,
});

test('scorePatchSelection: correct selection = 100% accuracy', () => {
  const instance = createTestInstance();
  const records: PatchSelectionScoreRecord[] = [
    {
      instanceId: instance.id,
      selectedPatchOrId: 'good',
      instance,
    },
  ];

  const result = scorePatchSelection(records, {
    measurementPolicy: 'test_policy',
  });

  strictEqual(result.patch_selection_accuracy, 1);
  strictEqual(result.wavemill_router_diagnostics.scoreable_records, 1);
  strictEqual(result.wavemill_router_diagnostics.correct_selection_count, 1);
  strictEqual(result.wavemill_router_scoring.scorer_id, WAVEMILL_PATCH_SELECTION_SCORER_ID);
});

test('scorePatchSelection: wrong selection = 0% accuracy', () => {
  const instance = createTestInstance();
  const records: PatchSelectionScoreRecord[] = [
    {
      instanceId: instance.id,
      selectedPatchOrId: 'bad',
      instance,
    },
  ];

  const result = scorePatchSelection(records, {
    measurementPolicy: 'test_policy',
  });

  strictEqual(result.patch_selection_accuracy, 0);
  strictEqual(result.wavemill_router_diagnostics.correct_selection_count, 0);
  strictEqual(result.wavemill_router_diagnostics.known_bad_selected_count, 1);
});

test('scorePatchSelection: unknown selection tracked separately', () => {
  const instance = createTestInstance();
  const records: PatchSelectionScoreRecord[] = [
    {
      instanceId: instance.id,
      selectedPatchOrId: 'unknown',
      instance,
    },
  ];

  const result = scorePatchSelection(records, {
    measurementPolicy: 'test_policy',
  });

  strictEqual(result.wavemill_router_diagnostics.unknown_selected_count, 1);
  strictEqual(result.wavemill_router_diagnostics.correct_selection_count, 0);
});

test('scorePatchSelection: missing selection tracked', () => {
  const instance = createTestInstance();
  const records: PatchSelectionScoreRecord[] = [
    {
      instanceId: instance.id,
      selectedPatchOrId: '',
      instance,
    },
  ];

  const result = scorePatchSelection(records, {
    measurementPolicy: 'test_policy',
  });

  strictEqual(result.wavemill_router_diagnostics.missing_selection_count, 1);
});

test('scorePatchSelection: accuracy calculated correctly', () => {
  const instance1 = createTestInstance({ id: 'test-1' });
  const instance2 = createTestInstance({ id: 'test-2' });
  const instance3 = createTestInstance({ id: 'test-3' });

  const records: PatchSelectionScoreRecord[] = [
    { instanceId: instance1.id, selectedPatchOrId: 'good', instance: instance1 },
    { instanceId: instance2.id, selectedPatchOrId: 'bad', instance: instance2 },
    { instanceId: instance3.id, selectedPatchOrId: 'good', instance: instance3 },
  ];

  const result = scorePatchSelection(records, {
    measurementPolicy: 'test_policy',
  });

  // 2 correct out of 3 = 0.666667
  strictEqual(
    result.patch_selection_accuracy,
    Number((2 / 3).toFixed(6)),
  );
});

test('scorePatchSelection: patch content matching works', () => {
  const instance = createTestInstance();
  const records: PatchSelectionScoreRecord[] = [
    {
      instanceId: instance.id,
      selectedPatchOrId: 'good patch', // Match by content
      instance,
    },
  ];

  const result = scorePatchSelection(records, {
    measurementPolicy: 'test_policy',
    allowPatchFallback: true,
  });

  strictEqual(result.patch_selection_accuracy, 1);
  strictEqual(result.wavemill_router_diagnostics.correct_selection_count, 1);
});

test('scorePatchSelection: empty corpus returns 0', () => {
  const result = scorePatchSelection([], {
    measurementPolicy: 'test_policy',
  });

  strictEqual(result.patch_selection_accuracy, 0);
  strictEqual(result.wavemill_router_diagnostics.total_records, 0);
  strictEqual(result.wavemill_router_diagnostics.scoreable_records, 0);
});

test('scorePatchSelection: coverage calculation', () => {
  const instance = createTestInstance();
  const validRecord: PatchSelectionScoreRecord = {
    instanceId: instance.id,
    selectedPatchOrId: 'good',
    instance,
  };

  // Create an invalid record (missing required fields)
  const invalidRecord = {
    instanceId: 'bad-id',
    selectedPatchOrId: 'good',
    instance: { ...instance, id: '', candidates: [] }, // Invalid
  };

  const records = [validRecord, invalidRecord];
  const result = scorePatchSelection(records as PatchSelectionScoreRecord[], {
    measurementPolicy: 'test_policy',
  });

  // Only 1 is scoreable out of 2
  strictEqual(result.wavemill_router_diagnostics.total_records, 2);
  strictEqual(result.wavemill_router_diagnostics.scoreable_records, 1);
  strictEqual(result.wavemill_router_diagnostics.invalid_route_records, 1);
  strictEqual(
    result.wavemill_router_diagnostics.scoreable_coverage,
    Number((1 / 2).toFixed(6)),
  );
});
