import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  CACHE_SCHEMA_VERSION,
  cachedEdgesToDependencyEdges,
  computeBacklogDiff,
  computeTaskFingerprint,
  getTaskDependencyCachePath,
  loadCache,
  lookupEdge,
  lookupGroundedVerdict,
  lookupTouchSet,
  TOUCH_SET_TTL_MS,
  mergeEdges,
  pruneCache,
  recordEdge,
  retainPreviousFingerprints,
  saveCache,
  type CacheFile,
  type CachedGroundedVerdict,
  type CachedTouchSet,
} from './task-dependency-plan-cache.ts';

let repoDir: string;

function readCache(path: string): CacheFile {
  return JSON.parse(readFileSync(path, 'utf8')) as CacheFile;
}

function createCache(overrides: Partial<CacheFile> = {}): CacheFile {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    projectSlug: 'sample-project',
    updatedAt: new Date(0).toISOString(),
    fingerprints: {},
    edges: [],
    ...overrides,
  };
}

describe('task-dependency-plan-cache', () => {
  beforeEach(() => {
    repoDir = join(tmpdir(), `task-dependency-cache-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(repoDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    mock.restoreAll();
  });

  it('computes deterministic fingerprints regardless of key order', () => {
    const first = computeTaskFingerprint({
      id: 'HOK-1',
      title: 'Title',
      description: 'Description',
      labels: ['backend', 'cache'],
      priority: 1,
      estimate: 3,
      state: { name: 'In Progress' },
      blocks: ['HOK-2'],
    });

    const second = computeTaskFingerprint({
      blocks: ['HOK-2'],
      state: { name: 'In Progress' },
      estimate: 3,
      priority: 1,
      labels: ['cache', 'backend'],
      description: 'Description',
      title: 'Title',
      id: 'HOK-1',
    });

    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(first, second);
    assert.notEqual(
      first,
      computeTaskFingerprint({
        id: 'HOK-1',
        title: 'Retitled',
        description: 'Description',
        labels: ['backend', 'cache'],
        priority: 1,
        estimate: 3,
        state: { name: 'In Progress' },
        blocks: ['HOK-2'],
      }),
    );
  });

  it('normalizes undefined and null fingerprint fields equally', () => {
    assert.equal(
      computeTaskFingerprint({ id: 'HOK-1', priority: undefined, state: undefined }),
      computeTaskFingerprint({ id: 'HOK-1', priority: null, state: null }),
    );
  });

  it('returns an empty cache for a missing file without warning', () => {
    const warn = mock.method(console, 'warn', () => undefined);

    const cache = loadCache(repoDir, 'sample-project');

    assert.deepEqual(cache, createCache());
    assert.equal(warn.mock.callCount(), 0);
  });

  it('drops corrupt JSON cache files with a warning', () => {
    const cachePath = getTaskDependencyCachePath(repoDir, 'sample-project');
    mkdirSync(join(repoDir, '.wavemill', 'cache', 'task-dependency-plans'), { recursive: true });
    writeFileSync(cachePath, '{"schemaVersion":', 'utf8');
    const warn = mock.method(console, 'warn', () => undefined);

    const cache = loadCache(repoDir, 'sample-project');

    assert.deepEqual(cache, createCache());
    assert.equal(warn.mock.callCount(), 1);
  });

  it('keeps edges but drops a malformed inference block with a warning', () => {
    const cachePath = getTaskDependencyCachePath(repoDir, 'sample-project');
    mkdirSync(join(repoDir, '.wavemill', 'cache', 'task-dependency-plans'), { recursive: true });
    const fingerprints = { 'HOK-1': 'fp-1' };
    writeFileSync(cachePath, `${JSON.stringify({ ...createCache({ fingerprints }), inference: 'broken' })}\n`, 'utf8');
    const warn = mock.method(console, 'warn', () => undefined);

    const cache = loadCache(repoDir, 'sample-project');

    assert.deepEqual(cache, createCache({ fingerprints }));
    assert.equal(warn.mock.callCount(), 1);
  });

  describe('grounded planner blocks (HOK-3131)', () => {
    const touchSet = (fingerprint: string, computedAt = '2026-10-01T00:00:00.000Z'): CachedTouchSet => ({
      fingerprint,
      computedAt,
      entries: [{ path: 'shared/lib/wavemill-monitor.sh', source: 'explicit', symbols: ['poll_loop'] }],
    });
    const verdict = (a: string, b: string, aFingerprint: string, bFingerprint: string): CachedGroundedVerdict => ({
      a,
      b,
      aFingerprint,
      bFingerprint,
      verdict: 'conflict',
      evidence: 'Both modify shared/lib/wavemill-monitor.sh',
      classifiedAt: '2026-10-01T00:00:00.000Z',
    });

    it('round-trips touchSets and groundedVerdicts through save and load', async () => {
      const cache = createCache({
        touchSets: { 'HOK-1': touchSet('fp-1') },
        groundedVerdicts: [verdict('HOK-1', 'HOK-2', 'fp-1', 'fp-2')],
      });
      await saveCache(repoDir, 'sample-project', cache);
      const loaded = loadCache(repoDir, 'sample-project');
      assert.deepEqual(loaded.touchSets, cache.touchSets);
      assert.deepEqual(loaded.groundedVerdicts, cache.groundedVerdicts);
    });

    it('loads legacy caches without the grounded blocks unchanged', async () => {
      await saveCache(repoDir, 'sample-project', createCache({ fingerprints: { 'HOK-1': 'fp-1' } }));
      const loaded = loadCache(repoDir, 'sample-project');
      assert.equal(loaded.touchSets, undefined);
      assert.equal(loaded.groundedVerdicts, undefined);
    });

    it('drops malformed grounded entries individually and keeps edges', () => {
      const cachePath = getTaskDependencyCachePath(repoDir, 'sample-project');
      mkdirSync(join(repoDir, '.wavemill', 'cache', 'task-dependency-plans'), { recursive: true });
      const fingerprints = { 'HOK-1': 'fp-1' };
      writeFileSync(cachePath, `${JSON.stringify({
        ...createCache({ fingerprints }),
        touchSets: { 'HOK-1': touchSet('fp-1'), 'HOK-2': { fingerprint: 'fp-2', entries: [{ path: 'x', source: 'guess' }] } },
        groundedVerdicts: [verdict('HOK-1', 'HOK-2', 'fp-1', 'fp-2'), { a: 'HOK-1', b: 'HOK-2', verdict: 'maybe' }],
      })}\n`, 'utf8');
      const warn = mock.method(console, 'warn', () => undefined);

      const cache = loadCache(repoDir, 'sample-project');

      assert.deepEqual(Object.keys(cache.touchSets ?? {}), ['HOK-1']);
      assert.equal(cache.groundedVerdicts?.length, 1);
      assert.deepEqual(cache.fingerprints, fingerprints);
      assert.equal(warn.mock.callCount(), 2);
    });

    it('drops a malformed grounded container without discarding the cache', () => {
      const cachePath = getTaskDependencyCachePath(repoDir, 'sample-project');
      mkdirSync(join(repoDir, '.wavemill', 'cache', 'task-dependency-plans'), { recursive: true });
      writeFileSync(cachePath, `${JSON.stringify({ ...createCache(), touchSets: [], groundedVerdicts: {} })}\n`, 'utf8');
      mock.method(console, 'warn', () => undefined);

      const cache = loadCache(repoDir, 'sample-project');

      assert.deepEqual(cache, createCache());
    });

    it('pruneCache keeps only grounded entries whose fingerprints still match', () => {
      const tasks = [{ id: 'HOK-1', title: 'One' }, { id: 'HOK-2', title: 'Two' }];
      const fp1 = computeTaskFingerprint(tasks[0]);
      const fp2 = computeTaskFingerprint(tasks[1]);
      const pruned = pruneCache(createCache({
        touchSets: { 'HOK-1': touchSet(fp1), 'HOK-2': touchSet('stale'), 'HOK-9': touchSet('gone') },
        groundedVerdicts: [verdict('HOK-1', 'HOK-2', fp1, fp2), verdict('HOK-1', 'HOK-2', fp1, 'stale'), verdict('HOK-1', 'HOK-9', fp1, 'gone')],
      }), tasks);
      assert.deepEqual(Object.keys(pruned.touchSets ?? {}), ['HOK-1']);
      assert.deepEqual(pruned.groundedVerdicts, [verdict('HOK-1', 'HOK-2', fp1, fp2)]);
      assert.equal(pruneCache(createCache(), tasks).touchSets, undefined);
    });

    it('lookupTouchSet honors fingerprint and TTL', () => {
      const nowMs = Date.parse('2026-10-01T00:00:00.000Z');
      const cache = { touchSets: { 'HOK-1': touchSet('fp-1') } };
      assert.ok(lookupTouchSet(cache, 'HOK-1', 'fp-1', nowMs));
      assert.equal(lookupTouchSet(cache, 'HOK-1', 'fp-other', nowMs), undefined);
      assert.equal(lookupTouchSet(cache, 'HOK-1', 'fp-1', nowMs + TOUCH_SET_TTL_MS + 1), undefined);
      assert.equal(lookupTouchSet({ touchSets: { 'HOK-1': touchSet('fp-1', 'not-a-date') } }, 'HOK-1', 'fp-1', nowMs), undefined);
      assert.equal(lookupTouchSet({}, 'HOK-1', 'fp-1', nowMs), undefined);
    });

    it('lookupGroundedVerdict matches either orientation with matching fingerprints', () => {
      const cache = { groundedVerdicts: [verdict('HOK-1', 'HOK-2', 'fp-1', 'fp-2')] };
      assert.ok(lookupGroundedVerdict(cache, 'HOK-1', 'HOK-2', 'fp-1', 'fp-2'));
      assert.ok(lookupGroundedVerdict(cache, 'HOK-2', 'HOK-1', 'fp-2', 'fp-1'));
      assert.equal(lookupGroundedVerdict(cache, 'HOK-1', 'HOK-2', 'fp-1', 'fp-changed'), undefined);
    });
  });

  it('preserves the inference block through pruneCache', () => {
    const inference = {
      lastAttemptAt: '2026-09-30T00:00:00.000Z',
      lastSuccessAt: '2026-09-30T00:00:00.000Z',
      lastOutcome: 'ok' as const,
      lastModel: 'claude-haiku-4-5-20251001',
      lastError: null,
      consecutiveFailures: 0,
    };
    const pruned = pruneCache(createCache({ inference }), [{ id: 'HOK-1', title: 'One' }]);

    assert.deepEqual(pruned.inference, inference);
    assert.equal(pruneCache(createCache(), [{ id: 'HOK-1' }]).inference, undefined);
  });

  it('retains previous fingerprints only for tasks still in the backlog', () => {
    assert.deepEqual(
      retainPreviousFingerprints({ 'HOK-1': 'a', 'HOK-2': 'b', 'HOK-9': 'z' }, ['HOK-1', 'HOK-2', 'HOK-3']),
      { 'HOK-1': 'a', 'HOK-2': 'b' },
    );
  });

  it('drops schema mismatches with a warning', () => {
    const cachePath = getTaskDependencyCachePath(repoDir, 'sample-project');
    mkdirSync(join(repoDir, '.wavemill', 'cache', 'task-dependency-plans'), { recursive: true });
    writeFileSync(
      cachePath,
      `${JSON.stringify({ ...createCache(), schemaVersion: 99 }, null, 2)}\n`,
      'utf8',
    );
    const warn = mock.method(console, 'warn', () => undefined);

    const cache = loadCache(repoDir, 'sample-project');

    assert.deepEqual(cache, createCache());
    assert.equal(warn.mock.callCount(), 1);
  });

  it('drops invalid cache shapes with a warning', () => {
    const cachePath = getTaskDependencyCachePath(repoDir, 'sample-project');
    mkdirSync(join(repoDir, '.wavemill', 'cache', 'task-dependency-plans'), { recursive: true });
    writeFileSync(
      cachePath,
      `${JSON.stringify({ ...createCache(), edges: [{}] }, null, 2)}\n`,
      'utf8',
    );
    const warn = mock.method(console, 'warn', () => undefined);

    const cache = loadCache(repoDir, 'sample-project');

    assert.deepEqual(cache, createCache());
    assert.equal(warn.mock.callCount(), 1);
  });

  it('prunes removed and changed tasks while retaining matching inferred edges', () => {
    const unchanged = { id: 'HOK-1', title: 'Task 1', state: 'Todo' };
    const changedBefore = { id: 'HOK-2', title: 'Task 2', state: 'Todo' };
    const changedAfter = { id: 'HOK-2', title: 'Task 2 updated', state: 'Todo' };
    const removed = { id: 'HOK-3', title: 'Task 3', state: 'Todo' };
    const stable = { id: 'HOK-4', title: 'Task 4', state: 'Todo' };
    const cache = createCache({
      fingerprints: {
        'HOK-1': computeTaskFingerprint(unchanged),
        'HOK-2': computeTaskFingerprint(changedBefore),
        'HOK-3': computeTaskFingerprint(removed),
        'HOK-4': computeTaskFingerprint(stable),
      },
      edges: [
        {
          from: 'HOK-1',
          to: 'HOK-4',
          fromFingerprint: computeTaskFingerprint(unchanged),
          toFingerprint: computeTaskFingerprint(stable),
          kind: 'inferred',
          classifiedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          from: 'HOK-2',
          to: 'HOK-4',
          fromFingerprint: computeTaskFingerprint(changedBefore),
          toFingerprint: computeTaskFingerprint(stable),
          kind: 'inferred',
          classifiedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          from: 'HOK-3',
          to: 'HOK-4',
          fromFingerprint: computeTaskFingerprint(removed),
          toFingerprint: computeTaskFingerprint(stable),
          kind: 'inferred',
          classifiedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const pruned = pruneCache(cache, [unchanged, changedAfter, stable]);

    assert.deepEqual(pruned.fingerprints, {
      'HOK-1': computeTaskFingerprint(unchanged),
      'HOK-2': computeTaskFingerprint(changedAfter),
      'HOK-4': computeTaskFingerprint(stable),
    });
    assert.deepEqual(pruned.edges, [cache.edges[0]]);
  });

  it('returns an empty edge list when pruning against an empty backlog', () => {
    const pruned = pruneCache(
      createCache({
        edges: [
          {
            from: 'HOK-1',
            to: 'HOK-2',
            fromFingerprint: 'a',
            toFingerprint: 'b',
            kind: 'inferred',
            classifiedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
      [],
    );

    assert.deepEqual(pruned.fingerprints, {});
    assert.deepEqual(pruned.edges, []);
  });

  describe('computeBacklogDiff', () => {
    it('detects added, changed, completed, and removed tasks', () => {
      const unchanged = { id: 'HOK-1', title: 'Keep', state: 'Todo' };
      const changedBefore = { id: 'HOK-2', title: 'Before', state: 'Todo' };
      const changedAfter = { id: 'HOK-2', title: 'After', state: 'Todo' };
      const removed = { id: 'HOK-3', title: 'Removed', state: 'Todo' };
      const completed = { id: 'HOK-4', title: 'Completed', state: 'Done' };
      const added = { id: 'HOK-5', title: 'Added', state: 'Todo' };

      const diff = computeBacklogDiff(
        {
          'HOK-1': computeTaskFingerprint(unchanged),
          'HOK-2': computeTaskFingerprint(changedBefore),
          'HOK-3': computeTaskFingerprint(removed),
          'HOK-4': computeTaskFingerprint(completed),
        },
        [unchanged, changedAfter, added],
        (taskId) => taskId === 'HOK-4',
      );

      assert.deepEqual(diff, {
        added: ['HOK-5'],
        changed: ['HOK-2'],
        completed: ['HOK-4'],
        removed: ['HOK-3'],
      });
    });
  });

  describe('mergeEdges', () => {
    function inferredEdge(
      from: string,
      to: string,
      classifiedAt: string,
      type: 'depends_on' | 'shared_surface' = 'depends_on',
    ) {
      return {
        from,
        to,
        fromFingerprint: `fp-${from}`,
        toFingerprint: `fp-${to}`,
        kind: 'inferred' as const,
        type,
        classifiedAt,
      };
    }

    it('keeps unchanged edges and appends new edges for added tasks', () => {
      const merged = mergeEdges(
        [inferredEdge('HOK-1', 'HOK-2', '2026-01-01T00:00:00.000Z')],
        [inferredEdge('HOK-3', 'HOK-2', '2026-01-02T00:00:00.000Z')],
        { changedTaskIds: new Set(['HOK-3']), removedTaskIds: new Set() },
      );

      assert.deepEqual(merged, [
        inferredEdge('HOK-1', 'HOK-2', '2026-01-01T00:00:00.000Z'),
        inferredEdge('HOK-3', 'HOK-2', '2026-01-02T00:00:00.000Z'),
      ]);
    });

    it('replaces cached edges touching changed tasks', () => {
      const merged = mergeEdges(
        [
          inferredEdge('HOK-1', 'HOK-2', '2026-01-01T00:00:00.000Z'),
          inferredEdge('HOK-2', 'HOK-4', '2026-01-01T00:00:00.000Z'),
          inferredEdge('HOK-4', 'HOK-5', '2026-01-01T00:00:00.000Z'),
        ],
        [inferredEdge('HOK-2', 'HOK-6', '2026-01-03T00:00:00.000Z')],
        { changedTaskIds: new Set(['HOK-2']), removedTaskIds: new Set() },
      );

      assert.deepEqual(merged, [
        inferredEdge('HOK-2', 'HOK-6', '2026-01-03T00:00:00.000Z'),
        inferredEdge('HOK-4', 'HOK-5', '2026-01-01T00:00:00.000Z'),
      ]);
    });

    it('drops edges touching completed or removed tasks', () => {
      const merged = mergeEdges(
        [
          inferredEdge('HOK-1', 'HOK-2', '2026-01-01T00:00:00.000Z'),
          inferredEdge('HOK-3', 'HOK-4', '2026-01-01T00:00:00.000Z'),
        ],
        [],
        { changedTaskIds: new Set(), removedTaskIds: new Set(['HOK-2', 'HOK-3']) },
      );

      assert.deepEqual(merged, []);
    });

    it('warns and excludes fresh edges outside changed scope', () => {
      const warn = mock.method(console, 'warn', () => undefined);

      const merged = mergeEdges([], [inferredEdge('HOK-1', 'HOK-2', '2026-01-02T00:00:00.000Z')], {
        changedTaskIds: new Set(['HOK-9']),
        removedTaskIds: new Set(),
      });

      assert.deepEqual(merged, []);
      assert.equal(warn.mock.callCount(), 1);
    });

    it('handles mixed partial refresh scenarios deterministically', () => {
      const merged = mergeEdges(
        [
          inferredEdge('HOK-1', 'HOK-2', '2026-01-01T00:00:00.000Z'),
          inferredEdge('HOK-4', 'HOK-5', '2026-01-01T00:00:00.000Z'),
          inferredEdge('HOK-6', 'HOK-7', '2026-01-01T00:00:00.000Z', 'shared_surface'),
        ],
        [
          inferredEdge('HOK-2', 'HOK-8', '2026-01-04T00:00:00.000Z'),
          inferredEdge('HOK-6', 'HOK-7', '2026-01-05T00:00:00.000Z', 'shared_surface'),
        ],
        {
          changedTaskIds: new Set(['HOK-2', 'HOK-6']),
          removedTaskIds: new Set(['HOK-5']),
        },
      );

      assert.deepEqual(merged, [
        inferredEdge('HOK-2', 'HOK-8', '2026-01-04T00:00:00.000Z'),
        inferredEdge('HOK-6', 'HOK-7', '2026-01-05T00:00:00.000Z', 'shared_surface'),
      ]);
    });
  });

  it('looks up cached edges in either direction and respects fingerprints', () => {
    const cache = recordEdge(
      createCache(),
      {
        from: 'HOK-1',
        to: 'HOK-2',
        fromFingerprint: 'fp-1',
        toFingerprint: 'fp-2',
        kind: 'inferred',
        label: 'blocks',
        confidence: 0.91,
        classifiedAt: '2026-01-01T00:00:00.000Z',
      },
    );

    assert.equal(lookupEdge(cache, 'HOK-1', 'HOK-2', 'fp-1', 'fp-2'), cache.edges[0]);
    assert.equal(lookupEdge(cache, 'HOK-2', 'HOK-1', 'fp-2', 'fp-1'), cache.edges[0]);
    assert.equal(lookupEdge(cache, 'HOK-1', 'HOK-2', 'fp-x', 'fp-2'), undefined);
  });

  it('converts cached edges into inferred planner edges', () => {
    assert.deepEqual(
      cachedEdgesToDependencyEdges([
        {
          from: 'HOK-1',
          to: 'HOK-2',
          fromFingerprint: 'fp-1',
          toFingerprint: 'fp-2',
          kind: 'inferred',
          type: 'shared_surface',
          label: 'same settings panel',
          classifiedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          from: 'HOK-3',
          to: 'HOK-4',
          fromFingerprint: 'fp-3',
          toFingerprint: 'fp-4',
          kind: 'inferred',
          classifiedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
      [
        {
          from: 'HOK-1',
          to: 'HOK-2',
          type: 'shared_surface',
          source: 'inferred',
          reason: 'same settings panel',
        },
        {
          from: 'HOK-3',
          to: 'HOK-4',
          type: 'depends_on',
          source: 'inferred',
        },
      ],
    );
  });

  it('creates the cache directory and writes the cache file', async () => {
    const cache = createCache({
      fingerprints: { 'HOK-1': 'fp-1' },
      edges: [
        {
          from: 'HOK-1',
          to: 'HOK-2',
          fromFingerprint: 'fp-1',
          toFingerprint: 'fp-2',
          kind: 'inferred',
          classifiedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    await saveCache(repoDir, 'sample-project', cache);

    const saved = readCache(getTaskDependencyCachePath(repoDir, 'sample-project'));
    assert.equal(saved.projectSlug, 'sample-project');
    assert.equal(saved.schemaVersion, CACHE_SCHEMA_VERSION);
    assert.match(saved.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(saved.fingerprints, cache.fingerprints);
    assert.deepEqual(saved.edges, cache.edges);
  });

  it('falls back gracefully when the cache lock times out', async () => {
    const cachePath = getTaskDependencyCachePath(repoDir, 'sample-project');
    mkdirSync(join(repoDir, '.wavemill', 'cache', 'task-dependency-plans'), { recursive: true });
    writeFileSync(`${cachePath}.lock`, '', { flag: 'wx' });
    const warn = mock.method(console, 'warn', () => undefined);

    await assert.doesNotReject(saveCache(repoDir, 'sample-project', createCache()));

    assert.equal(warn.mock.callCount(), 1);
  });
});
