import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_IGNORE_PATTERNS,
  augmentPlanWithInFlight,
  filterIgnoredFiles,
  findFileOverlap,
  isIgnoredPath,
  parseInFlightFile,
  parseInFlightJson,
  type InFlightTouchSet,
} from './in-flight-touch-sets.ts';
import { selectLaunchSet, type QueuePlan } from './plan-queue-utils.ts';

const emptyPlan: QueuePlan = {
  availableNow: [],
  queuedAfterDependencies: [],
  avoidRunningTogether: [],
  sharedSurfaceConflicts: [],
  needsTriage: [],
};

describe('isIgnoredPath', () => {
  it('ignores paths inside the wavemill registry directory', () => {
    assert.equal(isIgnoredPath('.wavemill/registry/latest/foo.jsonl'), true);
    assert.equal(isIgnoredPath('.wavemill/evals/some.jsonl'), true);
    assert.equal(isIgnoredPath('.wavemill/manifests/x.json'), true);
  });

  it('ignores lock files by basename at any depth', () => {
    assert.equal(isIgnoredPath('package-lock.json'), true);
    assert.equal(isIgnoredPath('subdir/package-lock.json'), true);
    assert.equal(isIgnoredPath('pnpm-lock.yaml'), true);
    assert.equal(isIgnoredPath('yarn.lock'), true);
  });

  it('does not ignore normal source files', () => {
    assert.equal(isIgnoredPath('shared/lib/foo.ts'), false);
    assert.equal(isIgnoredPath('tools/plan-queue.ts'), false);
    assert.equal(isIgnoredPath('package.json'), false);
  });

  it('supports custom patterns', () => {
    assert.equal(isIgnoredPath('CHANGELOG.md', ['CHANGELOG.md']), true);
    assert.equal(isIgnoredPath('CHANGELOG.md', DEFAULT_IGNORE_PATTERNS), false);
  });
});

describe('filterIgnoredFiles', () => {
  it('drops ignored paths while preserving order of kept paths', () => {
    const input = [
      'shared/lib/a.ts',
      '.wavemill/registry/x.jsonl',
      'tools/b.ts',
      'package-lock.json',
      'shared/lib/c.ts',
    ];
    assert.deepEqual(filterIgnoredFiles(input), [
      'shared/lib/a.ts',
      'tools/b.ts',
      'shared/lib/c.ts',
    ]);
  });
});

describe('findFileOverlap', () => {
  it('returns the sorted intersection', () => {
    const result = findFileOverlap(
      ['tools/b.ts', 'shared/lib/a.ts', 'shared/lib/c.ts'],
      ['shared/lib/c.ts', 'shared/lib/a.ts', 'docs/d.md'],
    );
    assert.deepEqual(result, ['shared/lib/a.ts', 'shared/lib/c.ts']);
  });

  it('is empty when there is no overlap', () => {
    assert.deepEqual(findFileOverlap(['a.ts'], ['b.ts']), []);
  });

  it('is empty when the only overlap is ignored', () => {
    const result = findFileOverlap(
      ['shared/lib/a.ts', '.wavemill/registry/x.jsonl'],
      ['.wavemill/registry/x.jsonl', 'shared/lib/b.ts'],
    );
    assert.deepEqual(result, []);
  });

  it('deduplicates the output', () => {
    const result = findFileOverlap(
      ['shared/lib/a.ts', 'shared/lib/a.ts'],
      ['shared/lib/a.ts'],
    );
    assert.deepEqual(result, ['shared/lib/a.ts']);
  });
});

describe('parseInFlightJson', () => {
  it('parses rows with and without PR numbers and defaults source to actual', () => {
    const result = parseInFlightJson(
      JSON.stringify([
        { id: 'HOK-1', prNumber: 10, files: ['a.ts', 'b.ts'] },
        { id: 'HOK-2', files: [] },
        { id: 'HOK-3', files: ['c.ts'], source: 'predicted', phase: 'planning' },
      ]),
      'test',
    );
    assert.equal(result.length, 3);
    assert.equal(result[0]?.id, 'HOK-1');
    assert.equal(result[0]?.prNumber, 10);
    assert.deepEqual(result[0]?.files, ['a.ts', 'b.ts']);
    assert.equal(result[0]?.source, 'actual');
    assert.equal(result[1]?.prNumber, undefined);
    assert.equal(result[2]?.source, 'predicted');
    assert.equal(result[2]?.phase, 'planning');
  });

  it('deduplicates and sorts files per row', () => {
    const result = parseInFlightJson(
      JSON.stringify([{ id: 'HOK-1', files: ['b.ts', 'a.ts', 'b.ts'] }]),
      'test',
    );
    assert.deepEqual(result[0]?.files, ['a.ts', 'b.ts']);
  });

  it('throws on non-array JSON', () => {
    assert.throws(() => parseInFlightJson('{}', 'test'), /must be an array/);
  });

  it('throws on malformed JSON with the source path', () => {
    assert.throws(() => parseInFlightJson('{not json', 'in-flight.json'), /in-flight\.json/);
  });

  it('throws on rows without an id', () => {
    assert.throws(() => parseInFlightJson(JSON.stringify([{ files: ['a.ts'] }]), 'test'), /id/);
  });
});

describe('parseInFlightFile', () => {
  it('round-trips through disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-inflight-'));
    try {
      const path = join(dir, 'in-flight.json');
      writeFileSync(
        path,
        JSON.stringify([{ id: 'HOK-1', prNumber: 7, files: ['a.ts'] }]),
      );
      const result = parseInFlightFile(path);
      assert.deepEqual(result, [
        { id: 'HOK-1', prNumber: 7, files: ['a.ts'], source: 'actual' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes the file path on a read error', () => {
    assert.throws(
      () => parseInFlightFile('/nonexistent/path/does/not/exist.json'),
      /does\/not\/exist\.json/,
    );
  });
});

describe('augmentPlanWithInFlight', () => {
  it('synthesizes a conflict edge for a candidate overlapping an in-flight task', () => {
    const plan: QueuePlan = { ...emptyPlan, availableNow: ['HOK-A'] };
    const inFlight: InFlightTouchSet[] = [
      { id: 'HOK-X', prNumber: 42, files: ['shared/lib/foo.ts'], source: 'actual' },
    ];
    const candidateTouchSets = new Map<string, readonly string[]>([
      ['HOK-A', ['shared/lib/foo.ts', 'shared/lib/bar.ts']],
    ]);
    const augmented = augmentPlanWithInFlight(plan, inFlight, candidateTouchSets);
    assert.equal(augmented.sharedSurfaceConflicts?.length, 1);
    assert.deepEqual(augmented.sharedSurfaceConflicts?.[0]?.files, ['shared/lib/foo.ts']);
    assert.equal(augmented.sharedSurfaceConflicts?.[0]?.source, 'inferred');
  });

  it('emits no edge when the overlap is entirely ignored', () => {
    const plan: QueuePlan = { ...emptyPlan, availableNow: ['HOK-A'] };
    const inFlight: InFlightTouchSet[] = [
      { id: 'HOK-X', files: ['.wavemill/registry/x.jsonl'], source: 'actual' },
    ];
    const candidateTouchSets = new Map<string, readonly string[]>([
      ['HOK-A', ['.wavemill/registry/x.jsonl']],
    ]);
    const augmented = augmentPlanWithInFlight(plan, inFlight, candidateTouchSets);
    assert.deepEqual(augmented.sharedSurfaceConflicts, []);
  });

  it('unions files for a duplicate pair without duplicating edges', () => {
    const plan: QueuePlan = {
      ...emptyPlan,
      availableNow: ['HOK-A'],
      sharedSurfaceConflicts: [
        { a: 'HOK-A', b: 'HOK-X', files: ['shared/lib/bar.ts'], source: 'explicit' },
      ],
    };
    const inFlight: InFlightTouchSet[] = [
      { id: 'HOK-X', files: ['shared/lib/foo.ts', 'shared/lib/bar.ts'], source: 'actual' },
    ];
    const candidateTouchSets = new Map<string, readonly string[]>([
      ['HOK-A', ['shared/lib/foo.ts', 'shared/lib/bar.ts']],
    ]);
    const augmented = augmentPlanWithInFlight(plan, inFlight, candidateTouchSets);
    assert.equal(augmented.sharedSurfaceConflicts?.length, 1);
    assert.deepEqual(
      augmented.sharedSurfaceConflicts?.[0]?.files,
      ['shared/lib/bar.ts', 'shared/lib/foo.ts'],
    );
  });

  it('emits no edges when candidateTouchSets is empty', () => {
    const plan: QueuePlan = { ...emptyPlan, availableNow: ['HOK-A'] };
    const inFlight: InFlightTouchSet[] = [
      { id: 'HOK-X', files: ['shared/lib/foo.ts'], source: 'actual' },
    ];
    const augmented = augmentPlanWithInFlight(plan, inFlight, new Map());
    assert.deepEqual(augmented.sharedSurfaceConflicts, []);
  });

  it('is pure — input plan not mutated', () => {
    const plan: QueuePlan = {
      ...emptyPlan,
      availableNow: ['HOK-A'],
      sharedSurfaceConflicts: [{ a: 'HOK-A', b: 'HOK-B', files: [] }],
    };
    const originalLength = plan.sharedSurfaceConflicts?.length ?? 0;
    const inFlight: InFlightTouchSet[] = [
      { id: 'HOK-X', files: ['shared/lib/foo.ts'], source: 'actual' },
    ];
    const candidateTouchSets = new Map<string, readonly string[]>([
      ['HOK-A', ['shared/lib/foo.ts']],
    ]);
    augmentPlanWithInFlight(plan, inFlight, candidateTouchSets);
    assert.equal(plan.sharedSurfaceConflicts?.length, originalLength);
  });

  it('round-trips through selectLaunchSet: candidate is held with conflicts_with_in_flight', () => {
    const plan: QueuePlan = {
      ...emptyPlan,
      availableNow: ['HOK-A'],
    };
    const inFlight: InFlightTouchSet[] = [
      { id: 'HOK-X', prNumber: 1234, files: ['shared/lib/foo.ts'], source: 'actual' },
    ];
    const candidateTouchSets = new Map<string, readonly string[]>([
      ['HOK-A', ['shared/lib/foo.ts']],
    ]);
    const augmented = augmentPlanWithInFlight(plan, inFlight, candidateTouchSets);
    const result = selectLaunchSet(
      augmented,
      [{ id: 'HOK-A', score: 1, touchSetKnown: true }],
      { freeSlots: 1, inFlight },
    );
    assert.deepEqual(result.launchNext, []);
    assert.equal(result.held.length, 1);
    const held = result.held[0]!;
    assert.equal(held.id, 'HOK-A');
    assert.equal(held.reason, 'conflicts_with_in_flight');
    if (held.detail.kind !== 'conflicts_with_in_flight') {
      assert.fail(`expected conflicts_with_in_flight, got ${held.detail.kind}`);
    }
    assert.equal(held.detail.taskId, 'HOK-X');
    assert.equal(held.detail.prNumber, 1234);
    assert.deepEqual(held.detail.files, ['shared/lib/foo.ts']);
  });

  it('releases a held candidate once the in-flight task is gone', () => {
    const plan: QueuePlan = { ...emptyPlan, availableNow: ['HOK-A'] };
    const candidateTouchSets = new Map<string, readonly string[]>([
      ['HOK-A', ['shared/lib/foo.ts']],
    ]);
    // With no in-flight, no edge is synthesized.
    const augmented = augmentPlanWithInFlight(plan, [], candidateTouchSets);
    assert.deepEqual(augmented.sharedSurfaceConflicts, []);
    const result = selectLaunchSet(
      augmented,
      [{ id: 'HOK-A', score: 1, touchSetKnown: true }],
      { freeSlots: 1, inFlight: [] },
    );
    assert.deepEqual(result.launchNext, ['HOK-A']);
    assert.deepEqual(result.held, []);
  });
});
