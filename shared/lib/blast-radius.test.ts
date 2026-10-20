import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getBlastRadius,
  evaluateBlastRadius,
  MILL_CORE_PATTERNS,
} from './blast-radius.ts';

test('empty file list is normal radius', () => {
  assert.equal(getBlastRadius([]), 'normal');
  const evaluation = evaluateBlastRadius([]);
  assert.equal(evaluation.radius, 'normal');
  assert.deepEqual(evaluation.matchedFiles, []);
  assert.deepEqual(evaluation.matchedPatterns, []);
});

test('every documented mill-core path matches a pattern', () => {
  // Mirrors MILL_CORE_PATTERNS declared surface, one representative file each.
  const paths = [
    'shared/lib/wavemill-monitor.sh',
    'tools/wavemill-monitor.ts',
    'shared/lib/tend-loop.ts',
    'shared/lib/tend-controller.ts',
    'tools/tend.ts',
    'shared/lib/merge-labels.ts',
    'shared/lib/pr-state-labels.ts',
    'shared/lib/condition-reconciler.sh',
    'shared/lib/condition-marker.ts',
    'shared/lib/workflow-state.ts',
    'shared/schemas/workflow-task.schema.json',
    'shared/schemas/task-lifecycle-state.schema.json',
    'shared/lib/ready-stage.ts',
    'shared/lib/ready-watchdog.ts',
    'shared/lib/state-invariants.ts',
    'tools/state-invariants.ts',
  ];
  for (const path of paths) {
    assert.equal(getBlastRadius([path]), 'high', `${path} should be mill-core`);
    const evaluation = evaluateBlastRadius([path]);
    assert.equal(evaluation.radius, 'high');
    assert.ok(evaluation.matchedFiles.includes(path), `${path} should appear in matchedFiles`);
    assert.ok(evaluation.matchedPatterns.length >= 1);
  }
});

test('docs and generic UI changes are normal radius', () => {
  assert.equal(getBlastRadius(['docs/foo.md']), 'normal');
  assert.equal(getBlastRadius(['src/components/Button.tsx']), 'normal');
  assert.equal(getBlastRadius(['README.md', 'CHANGELOG.md']), 'normal');
  // Not quite mill-core: adjacent helper files, docs sidecars, test fixtures.
  assert.equal(getBlastRadius(['shared/lib/merge-queue-planner.ts']), 'normal');
});

test('mixed set with any mill-core file is high', () => {
  assert.equal(
    getBlastRadius(['README.md', 'shared/lib/tend-loop.ts', 'docs/foo.md']),
    'high',
  );
  const evaluation = evaluateBlastRadius(['README.md', 'shared/lib/tend-loop.ts', 'docs/foo.md']);
  assert.equal(evaluation.radius, 'high');
  assert.deepEqual(evaluation.matchedFiles, ['shared/lib/tend-loop.ts']);
});

test('matching is case-sensitive — upper-case variants do not match', () => {
  assert.equal(getBlastRadius(['SHARED/lib/tend-loop.ts']), 'normal');
  assert.equal(getBlastRadius(['Shared/Lib/Tend-Loop.ts']), 'normal');
});

test('evaluateBlastRadius deduplicates matchedFiles and matchedPatterns', () => {
  const evaluation = evaluateBlastRadius([
    'shared/lib/tend-loop.ts',
    'shared/lib/tend-loop.ts', // dup
    'shared/lib/merge-labels.ts',
  ]);
  assert.equal(evaluation.radius, 'high');
  assert.deepEqual(
    evaluation.matchedFiles,
    ['shared/lib/merge-labels.ts', 'shared/lib/tend-loop.ts'],
  );
  // Two distinct patterns matched (tend-loop and merge-labels).
  assert.equal(evaluation.matchedPatterns.length, 2);
});

test('MILL_CORE_PATTERNS is non-empty (guard against accidental deletion)', () => {
  assert.ok(MILL_CORE_PATTERNS.length >= 10);
});
