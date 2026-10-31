import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  CACHE_SCHEMA_VERSION,
  computeTaskFingerprint,
  getTaskDependencyCachePath,
  loadCache,
  lookupGroundedVerdict,
  lookupTouchSet,
  TOUCH_SET_TTL_MS,
  pruneCache,
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
      status: 'predicted',
    });
    const verdict = (a: string, b: string, aFingerprint: string, bFingerprint: string): CachedGroundedVerdict => ({
      a,
      b,
      aFingerprint,
      bFingerprint,
      verdict: 'should_precede',
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

    it('drops stale grounded entries with retired verdict kinds (HOK-3304)', () => {
      // protects: a pre-HOK-3304 cache cannot resurrect judge-decided conflicts after the upgrade
      const cachePath = getTaskDependencyCachePath(repoDir, 'sample-project');
      mkdirSync(join(repoDir, '.wavemill', 'cache', 'task-dependency-plans'), { recursive: true });
      writeFileSync(cachePath, `${JSON.stringify({
        ...createCache(),
        groundedVerdicts: [
          { a: 'HOK-1', b: 'HOK-2', aFingerprint: 'fp-1', bFingerprint: 'fp-2', verdict: 'conflict', evidence: 'Both modify shared/lib/wavemill-monitor.sh', classifiedAt: '2026-10-01T00:00:00.000Z' },
          { a: 'HOK-1', b: 'HOK-3', aFingerprint: 'fp-1', bFingerprint: 'fp-3', verdict: 'independent', classifiedAt: '2026-10-01T00:00:00.000Z' },
        ],
      })}\n`, 'utf8');
      const warn = mock.method(console, 'warn', () => undefined);

      const cache = loadCache(repoDir, 'sample-project');

      assert.deepEqual(cache.groundedVerdicts, []);
      assert.equal(warn.mock.callCount(), 1);
      assert.match(String(warn.mock.calls[0]?.arguments[0]), /dropping malformed groundedVerdicts entries/);
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

    it('back-fills missing status on pre-HOK-3307 cache entries (migration)', () => {
      // protects: loading an old cache without `status` must assign predicted/unknown, never leave it absent
      const cachePath = getTaskDependencyCachePath(repoDir, 'sample-project');
      mkdirSync(join(repoDir, '.wavemill', 'cache', 'task-dependency-plans'), { recursive: true });
      const legacy = {
        ...createCache(),
        touchSets: {
          'HOK-1': { fingerprint: 'fp-1', computedAt: '2026-10-01T00:00:00.000Z', entries: [{ path: 'shared/lib/wavemill-monitor.sh', source: 'explicit' }] },
          'HOK-2': { fingerprint: 'fp-2', computedAt: '2026-10-01T00:00:00.000Z', entries: [] },
        },
      };
      writeFileSync(cachePath, `${JSON.stringify(legacy)}\n`, 'utf8');

      const cache = loadCache(repoDir, 'sample-project');

      assert.equal(cache.touchSets?.['HOK-1']?.status, 'predicted');
      assert.equal(cache.touchSets?.['HOK-2']?.status, 'unknown');
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
    // protects: non-array edges field must fail isCacheFile
    const cachePath = getTaskDependencyCachePath(repoDir, 'sample-project');
    mkdirSync(join(repoDir, '.wavemill', 'cache', 'task-dependency-plans'), { recursive: true });
    writeFileSync(
      cachePath,
      `${JSON.stringify({ ...createCache(), edges: 'not-an-array' }, null, 2)}\n`,
      'utf8',
    );
    const warn = mock.method(console, 'warn', () => undefined);

    const cache = loadCache(repoDir, 'sample-project');

    assert.deepEqual(cache, createCache());
    assert.equal(warn.mock.callCount(), 1);
  });

  it('creates the cache directory and writes the cache file', async () => {
    // protects: saveCache writes projectSlug, schemaVersion, and updatedAt
    const cache = createCache({
      touchSets: { 'HOK-1': { fingerprint: 'fp-1', computedAt: '2026-10-01T00:00:00.000Z', entries: [] } },
    });

    await saveCache(repoDir, 'sample-project', cache);

    const saved = readCache(getTaskDependencyCachePath(repoDir, 'sample-project'));
    assert.equal(saved.projectSlug, 'sample-project');
    assert.equal(saved.schemaVersion, CACHE_SCHEMA_VERSION);
    assert.match(saved.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(saved.touchSets, cache.touchSets);
    assert.equal(saved.fingerprints, undefined);
    assert.equal(saved.edges, undefined);
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
