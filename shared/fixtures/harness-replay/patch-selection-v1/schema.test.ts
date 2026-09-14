import { test } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import {
  validateInstance,
  validateManifest,
  type ReplayPatchSelectionInstance,
  type ReplayPatchSelectionManifest,
} from './schema.ts';

const validInstance: ReplayPatchSelectionInstance = {
  id: 'test-001',
  taskTitle: 'Test task',
  taskDescription: 'A test task description',
  candidates: [
    {
      id: 'good-1',
      patch: 'patch content 1',
      patchSizeBytes: 14,
      label: 'good',
    },
    {
      id: 'bad-1',
      patch: 'patch content 2',
      patchSizeBytes: 14,
      label: 'bad',
    },
  ],
  knownGoodCandidateId: 'good-1',
  knownBadCandidateIds: ['bad-1'],
  source: {
    curationRationale: 'merged_winner',
    sanitized: true,
  },
  heldOut: false,
  curatedAt: Date.now(),
};

const validManifest: ReplayPatchSelectionManifest = {
  schemaVersion: '1.0',
  instances: [validInstance],
  split: {
    heldOutIds: [],
    strategy: 'hash_deterministic_20pct',
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

test('validateInstance: valid instance passes', () => {
  const result = validateInstance(validInstance);
  strictEqual(result.valid, true);
  strictEqual(result.errors.length, 0);
});

test('validateInstance: missing id fails', () => {
  const instance = { ...validInstance, id: '' };
  const result = validateInstance(instance);
  strictEqual(result.valid, false);
  strictEqual(result.errors.some((e) => e.includes('id')), true);
});

test('validateInstance: missing taskTitle fails', () => {
  const instance = { ...validInstance, taskTitle: '' };
  const result = validateInstance(instance);
  strictEqual(result.valid, false);
  strictEqual(result.errors.some((e) => e.includes('taskTitle')), true);
});

test('validateInstance: fewer than 2 candidates fails', () => {
  const instance = { ...validInstance, candidates: [validInstance.candidates[0]] };
  const result = validateInstance(instance);
  strictEqual(result.valid, false);
  strictEqual(result.errors.some((e) => e.includes('at least 2 candidates')), true);
});

test('validateInstance: missing knownGoodCandidateId fails', () => {
  const instance = { ...validInstance, knownGoodCandidateId: '' };
  const result = validateInstance(instance);
  strictEqual(result.valid, false);
});

test('validateInstance: knownGoodCandidateId not in candidates fails', () => {
  const instance = { ...validInstance, knownGoodCandidateId: 'nonexistent' };
  const result = validateInstance(instance);
  strictEqual(result.valid, false);
  strictEqual(result.errors.some((e) => e.includes('not found in candidates')), true);
});

test('validateInstance: knownGoodCandidateId in knownBadCandidateIds fails', () => {
  const instance = {
    ...validInstance,
    knownGoodCandidateId: 'good-1',
    knownBadCandidateIds: ['good-1', 'bad-1'],
  };
  const result = validateInstance(instance);
  strictEqual(result.valid, false);
  strictEqual(result.errors.some((e) => e.includes('cannot be in knownBadCandidateIds')), true);
});

test('validateInstance: duplicate candidate ids fail', () => {
  const instance = {
    ...validInstance,
    candidates: [
      { ...validInstance.candidates[0], id: 'dup' },
      { ...validInstance.candidates[1], id: 'dup' },
    ],
  };
  const result = validateInstance(instance);
  strictEqual(result.valid, false);
  strictEqual(result.errors.some((e) => e.includes('duplicate')), true);
});

test('validateManifest: valid manifest passes', () => {
  const result = validateManifest(validManifest);
  strictEqual(result.valid, true);
  strictEqual(result.errors.length, 0);
});

test('validateManifest: duplicate instance ids fail', () => {
  const manifest: ReplayPatchSelectionManifest = {
    ...validManifest,
    instances: [validInstance, { ...validInstance, id: validInstance.id }],
  };
  const result = validateManifest(manifest);
  strictEqual(result.valid, false);
  strictEqual(result.errors.some((e) => e.includes('Duplicate instance id')), true);
});

test('validateManifest: held-out id not in instances fails', () => {
  const manifest: ReplayPatchSelectionManifest = {
    ...validManifest,
    split: {
      heldOutIds: ['nonexistent'],
      strategy: 'test',
    },
  };
  const result = validateManifest(manifest);
  strictEqual(result.valid, false);
  strictEqual(result.errors.some((e) => e.includes('not found in instances')), true);
});

test('validateManifest: heldOut flag must be listed in split', () => {
  const manifest: ReplayPatchSelectionManifest = {
    ...validManifest,
    instances: [{ ...validInstance, heldOut: true }],
    split: {
      heldOutIds: [],
      strategy: 'test',
    },
  };
  const result = validateManifest(manifest);
  strictEqual(result.valid, false);
  strictEqual(result.errors.some((e) => e.includes('heldOut flag must match')), true);
});

test('validateManifest: split held-out id must set heldOut flag', () => {
  const manifest: ReplayPatchSelectionManifest = {
    ...validManifest,
    instances: [{ ...validInstance, heldOut: false }],
    split: {
      heldOutIds: [validInstance.id],
      strategy: 'test',
    },
  };
  const result = validateManifest(manifest);
  strictEqual(result.valid, false);
  strictEqual(result.errors.some((e) => e.includes('heldOut flag must match')), true);
});

test('validateManifest: counts diagnostics correctly', () => {
  const instance1: ReplayPatchSelectionInstance = {
    ...validInstance,
    id: 'test-1',
  };
  const instance2: ReplayPatchSelectionInstance = {
    ...validInstance,
    id: 'test-2',
    heldOut: true,
  };
  const manifest: ReplayPatchSelectionManifest = {
    ...validManifest,
    instances: [instance1, instance2],
    split: {
      heldOutIds: ['test-2'],
      strategy: 'test',
    },
  };
  const result = validateManifest(manifest);
  strictEqual(result.valid, true);
  strictEqual(result.diagnostics.totalInstances, 2);
  strictEqual(result.diagnostics.validInstances, 2);
  strictEqual(result.diagnostics.heldOutCount, 1);
});
