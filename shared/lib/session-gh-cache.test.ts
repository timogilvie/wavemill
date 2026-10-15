import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PR_CACHE_FIELDS,
  buildBatchPrListArgs,
  cachedNameWithOwner,
  cachedRequiredChecks,
  fetchBatchedPullRequests,
  findCachedPullRequest,
  findCachedPullRequestsForBranch,
  readSessionPrCache,
} from './session-gh-cache.ts';
import { fetchPrCiStatus, resolveRequiredContexts } from './pr-ci-status.ts';
import { probePrLiveState } from './pr-live-state.ts';
import { discoverGitHubRequiredChecks } from './github-ci-discovery.ts';

const HEAD = 'a'.repeat(40);

function fixture(): { dir: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'session-gh-cache-'));
  const prCache = join(dir, 'pr-cache.json');
  const repoCache = join(dir, 'repo.json');
  writeFileSync(prCache, JSON.stringify([
    {
      number: 11,
      headRefName: 'task/a',
      headRefOid: HEAD,
      baseRefName: 'main',
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    },
    { number: 9, headRefName: 'task/a', headRefOid: 'b'.repeat(40), state: 'CLOSED' },
    { number: 'bad' },
  ]));
  writeFileSync(repoCache, JSON.stringify({
    repoDir: '/repos/widgets',
    nameWithOwner: 'acme/widgets',
    requiredChecks: { main: ['CI'], dev: [] },
  }));
  return {
    dir,
    env: {
      WAVEMILL_SESSION_PR_CACHE: prCache,
      WAVEMILL_SESSION_REPO_CACHE: repoCache,
      WAVEMILL_SESSION_REPO_DIR: '/repos/widgets',
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('readSessionPrCache drops malformed rows and honours disable / unset / age', () => {
  const { env, cleanup } = fixture();
  try {
    assert.equal(readSessionPrCache({ env })?.length, 2);
    assert.equal(readSessionPrCache({ env: { ...env, WAVEMILL_DISABLE_GH_BATCH_CACHE: '1' } }), null);
    assert.equal(readSessionPrCache({ env: {} }), null);
    const old = new Date(Date.now() - 600_000);
    utimesSync(env.WAVEMILL_SESSION_PR_CACHE as string, old, old);
    assert.equal(readSessionPrCache({ env }), null, 'a cache older than maxAge is a miss');
  } finally {
    cleanup();
  }
});

test('readSessionPrCache treats a non-array payload as a miss', () => {
  const { env, cleanup } = fixture();
  try {
    writeFileSync(env.WAVEMILL_SESSION_PR_CACHE as string, '{"not":"an array"}');
    assert.equal(readSessionPrCache({ env }), null);
    writeFileSync(env.WAVEMILL_SESSION_PR_CACHE as string, 'garbage');
    assert.equal(readSessionPrCache({ env }), null);
  } finally {
    cleanup();
  }
});

test('findCachedPullRequest never serves a row for another head', () => {
  const { env, cleanup } = fixture();
  try {
    assert.equal(findCachedPullRequest(11, { env })?.state, 'OPEN');
    assert.equal(findCachedPullRequest(11, { env, expectedHeadSha: HEAD })?.number, 11);
    assert.equal(findCachedPullRequest(11, { env, expectedHeadSha: 'c'.repeat(40) }), null);
    assert.equal(findCachedPullRequest(404, { env }), null);
    assert.deepEqual(findCachedPullRequestsForBranch('task/a', { env })?.map((row) => row.number), [11, 9]);
  } finally {
    cleanup();
  }
});

test('session repo cache serves nameWithOwner and per-base required checks', () => {
  const { env, cleanup } = fixture();
  try {
    assert.equal(cachedNameWithOwner({ env }), 'acme/widgets');
    assert.deepEqual(cachedRequiredChecks('main', { env }), ['CI']);
    assert.deepEqual(cachedRequiredChecks('dev', { env }), [], 'a recorded unprotected base is an empty list');
    assert.equal(cachedRequiredChecks('other', { env }), undefined, 'an unrecorded base is a miss');
    assert.equal(cachedNameWithOwner({ env: { ...env, WAVEMILL_DISABLE_GH_BATCH_CACHE: '1' } }), undefined);
  } finally {
    cleanup();
  }
});

test('session repo cache written for another repo (or unstamped) is a miss', () => {
  const { dir, env, cleanup } = fixture();
  try {
    // Same tmux session name, different milled repo: never serve its values.
    const otherRepo = { ...env, WAVEMILL_SESSION_REPO_DIR: '/repos/site' };
    assert.equal(cachedNameWithOwner({ env: otherRepo }), undefined);
    assert.equal(cachedRequiredChecks('main', { env: otherRepo }), undefined);
    const { WAVEMILL_SESSION_REPO_DIR: _unset, ...noSessionRepo } = env;
    assert.equal(cachedNameWithOwner({ env: noSessionRepo }), undefined);
    const legacy = join(dir, 'legacy-repo.json');
    writeFileSync(legacy, JSON.stringify({ nameWithOwner: 'acme/widgets', requiredChecks: { main: ['CI'] } }));
    assert.equal(cachedRequiredChecks('main', { env: { ...env, WAVEMILL_SESSION_REPO_CACHE: legacy } }), undefined);
  } finally {
    cleanup();
  }
});

test('buildBatchPrListArgs ORs head qualifiers into one search, deduplicated', () => {
  const args = buildBatchPrListArgs(['task/b', 'task/a', 'task/b', ' ']);
  assert.deepEqual(args, [
    'pr', 'list', '--json', PR_CACHE_FIELDS.join(','),
    '--state', 'all', '--limit', '100', '--search', 'head:task/a head:task/b',
  ]);
  assert.deepEqual(buildBatchPrListArgs([]), ['pr', 'list', '--json', PR_CACHE_FIELDS.join(','), '--limit', '50']);
});

test('fetchBatchedPullRequests makes one gh call and keeps only requested heads', async () => {
  const calls: string[][] = [];
  const rows = await fetchBatchedPullRequests(['task/a', 'task/b'], async (args) => {
    calls.push(args);
    return JSON.stringify([
      { number: 1, headRefName: 'task/a' },
      { number: 2, headRefName: 'task/b' },
      { number: 2, headRefName: 'task/b' },
      { number: 3, headRefName: 'task/a-prefix-match' },
    ]);
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(rows.map((row) => row.number), [2, 1]);
  await assert.rejects(fetchBatchedPullRequests(['task/a'], async () => '{}'), /non-array/);
});

test('fetchPrCiStatus evaluates a cached row without spawning gh', async () => {
  const { env, cleanup } = fixture();
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    let spawned = 0;
    const execFile = (async () => {
      spawned += 1;
      throw new Error('gh must not be called on a cache hit');
    }) as never;
    const status = await fetchPrCiStatus(11, '/nonexistent', {
      execFile,
      resolveOwnerRepo: () => 'acme/widgets',
      getIntegrationRequiredChecks: () => [],
    }, { baseBranch: 'main', requireChecks: true, expectedHeadSha: HEAD });
    assert.equal(spawned, 0);
    assert.equal(status.conclusion, 'pass');
    assert.equal(status.headSha, HEAD);
    assert.equal(status.requiredSource, 'branch-protection');
    assert.deepEqual(status.requiredContexts, ['CI']);
  } finally {
    process.env = saved;
    cleanup();
  }
});

test('fetchPrCiStatus reads GitHub when the cached row is for another head', async () => {
  const { env, cleanup } = fixture();
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    let spawned = 0;
    const execFile = (async () => {
      spawned += 1;
      return {
        stdout: JSON.stringify({ headRefOid: 'd'.repeat(40), state: 'OPEN', statusCheckRollup: [] }),
        stderr: '',
      };
    }) as never;
    await fetchPrCiStatus(11, '/nonexistent', {
      execFile,
      resolveOwnerRepo: () => 'acme/widgets',
      getIntegrationRequiredChecks: () => [],
    }, { baseBranch: 'main', requireChecks: false, expectedHeadSha: 'd'.repeat(40) });
    assert.equal(spawned, 1);
  } finally {
    process.env = saved;
    cleanup();
  }
});

test('resolveRequiredContexts asks GitHub only for an unrecorded base', async () => {
  const { env, cleanup } = fixture();
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    let spawned = 0;
    const execFile = (async () => {
      spawned += 1;
      return { stdout: '["Live"]', stderr: '' };
    }) as never;
    const deps = { execFile, resolveOwnerRepo: () => 'acme/widgets', getIntegrationRequiredChecks: () => [] };
    assert.deepEqual((await resolveRequiredContexts('main', '/nonexistent', deps)).contexts, ['CI']);
    assert.equal(spawned, 0);
    assert.deepEqual(await resolveRequiredContexts('dev', '/nonexistent', deps), { contexts: [], source: 'none' });
    assert.equal(spawned, 0, 'a cached unprotected base is not re-read');
    assert.deepEqual((await resolveRequiredContexts('other', '/nonexistent', deps)).contexts, ['Live']);
    assert.equal(spawned, 1);
  } finally {
    process.env = saved;
    cleanup();
  }
});

test('probePrLiveState serves the cached row only for the checkout HEAD', async () => {
  const { dir, env, cleanup } = fixture();
  const saved = { ...process.env };
  try {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one'], { cwd: repo });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
    // A gh that always fails: any fallback read reports unavailable.
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'gh'), 0o755);
    Object.assign(process.env, env, { PATH: `${bin}:${process.env.PATH ?? ''}` });

    writeFileSync(env.WAVEMILL_SESSION_PR_CACHE as string, JSON.stringify([{
      number: 11, headRefOid: head, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    }]));
    const hit = await probePrLiveState(11, repo);
    assert.equal(hit.available, true);
    assert.equal(hit.mergeStateStatus, 'CLEAN');
    assert.deepEqual(hit.failingChecks, []);

    writeFileSync(env.WAVEMILL_SESSION_PR_CACHE as string, JSON.stringify([{
      number: 11, headRefOid: 'e'.repeat(40), mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [],
    }]));
    const miss = await probePrLiveState(11, repo);
    assert.equal(miss.available, false, 'a row for another head falls back to gh, never serves stale truth');
  } finally {
    process.env = saved;
    cleanup();
  }
});

test('probePrLiveState treats commit statuses (StatusContext) by their state, not as pending', async () => {
  const { dir, env, cleanup } = fixture();
  const saved = { ...process.env };
  try {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one'], { cwd: repo });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'gh'), 0o755);
    Object.assign(process.env, env, { PATH: `${bin}:${process.env.PATH ?? ''}` });

    const write = (state: string) => writeFileSync(env.WAVEMILL_SESSION_PR_CACHE as string, JSON.stringify([{
      number: 11, headRefOid: head, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'typecheck', status: 'COMPLETED', conclusion: 'SUCCESS' },
        // Real hokusai-site shape: Vercel posts a commit status with only `state`.
        { __typename: 'StatusContext', context: 'Vercel', state },
      ],
    }]));

    write('SUCCESS');
    const green = await probePrLiveState(11, repo);
    assert.deepEqual(green.pendingChecks, []);
    assert.deepEqual(green.failingChecks, []);
    assert.ok(
      green.statusCheckRollup?.every((c) => c.status === 'COMPLETED'),
      'a green commit status must read as completed, or deriveMergeLabel reports checks-pending forever',
    );
    assert.deepEqual(green.statusCheckRollup?.find((c) => c.name === 'Vercel'), { name: 'Vercel', status: 'COMPLETED', conclusion: 'SUCCESS' });

    write('PENDING');
    assert.deepEqual((await probePrLiveState(11, repo)).pendingChecks, ['Vercel']);

    write('ERROR');
    assert.deepEqual((await probePrLiveState(11, repo)).failingChecks, ['Vercel']);
  } finally {
    process.env = saved;
    cleanup();
  }
});

test('discoverGitHubRequiredChecks takes protection contexts from the session cache for the same repo', async () => {
  const { dir, env, cleanup } = fixture();
  const saved = { ...process.env };
  try {
    // gh fails for everything: protection must come from the cache, and the
    // live rulesets read degrades without discarding cached contexts.
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "gh: Not Found (HTTP 404)" >&2\nexit 1\n');
    chmodSync(join(bin, 'gh'), 0o755);
    Object.assign(process.env, env, { PATH: `${bin}:${process.env.PATH ?? ''}` });
    const result = await discoverGitHubRequiredChecks('acme/widgets', 'main');
    assert.deepEqual(result.checks, ['CI']);
    assert.equal(result.source, 'protection');
    await assert.rejects(discoverGitHubRequiredChecks('other/repo', 'main'), 'another repo never uses the cache');
  } finally {
    process.env = saved;
    cleanup();
  }
});
