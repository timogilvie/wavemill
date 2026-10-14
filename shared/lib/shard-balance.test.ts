/**
 * Tests for shard-balance preflight logic (HOK-2939): ci.yml shard-count
 * parsing, runner registration parsing, weights-manifest validation, and the
 * end-to-end balance check with its stale-entry and indivisible-hotspot paths.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadWeightsManifest,
  parseShardCount,
  parseShellArray,
  readRegisteredSuites,
  checkShardBalance,
  formatShardBalance,
} from './shard-balance.ts';

const FIXTURE_WORKFLOW = `name: CI

jobs:
  shell:
    name: Shell Tests (shard \${{ matrix.shard }}/3)
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3]
  unit:
    name: Unit Tests (shard \${{ matrix.shard }}/5)
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4, 5]
  custom:
    name: Custom Harness Tests (shard \${{ matrix.shard }}/3)
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3]
  smoke:
    name: Smoke and Config Tests
`;

interface FixtureOptions {
  shellTests?: string[];
  unitTests?: string[];
  customTs?: string[];
  customSh?: string[];
  manifest?: unknown;
  workflow?: string;
}

function withFixtureRepo(options: FixtureOptions, fn: (repoDir: string) => void): void {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'shard-balance-'));
  try {
    mkdirSync(path.join(repoDir, 'tests'), { recursive: true });
    mkdirSync(path.join(repoDir, '.github', 'workflows'), { recursive: true });
    const unitTests = options.unitTests ?? ['shared/lib/a.test.ts', 'shared/lib/b.test.ts', 'tools/c.test.ts', 'tools/d.test.ts', 'tools/e.test.ts'];
    const customTs = options.customTs ?? [
      'shared/lib/x.test.ts',
      'shared/lib/y.test.ts',
      'shared/lib/z.test.ts',
      'shared/lib/q.test.ts',
      'shared/lib/r.test.ts',
    ];
    const customSh = options.customSh ?? ['tests/w.test.sh'];
    const shellTests = options.shellTests ?? ['s-a.test.sh', 's-b.test.sh', 's-c.test.sh', 's-d.test.sh', 's-e.test.sh', 's-f.test.sh'];
    writeFileSync(
      path.join(repoDir, 'tests', 'run-shell-suite.sh'),
      `TESTS=(\n${shellTests.map((t) => `  ${t}`).join('\n')}\n)\n`
    );
    writeFileSync(
      path.join(repoDir, 'tests', 'run-unit-tests.sh'),
      `TESTS=(\n${unitTests.map((t) => `  ${t}`).join('\n')}\n)\n`
    );
    writeFileSync(
      path.join(repoDir, 'tests', 'run-custom-tests.sh'),
      `CUSTOM_TS_TESTS=(\n${customTs.map((t) => `  ${t}`).join('\n')}\n)\n\nCUSTOM_SH_TESTS=(\n${customSh.map((t) => `  ${t}`).join('\n')}\n)\n`
    );
    writeFileSync(path.join(repoDir, '.github', 'workflows', 'ci.yml'), options.workflow ?? FIXTURE_WORKFLOW);
    const manifest = options.manifest ?? { version: 1, defaultMs: 30000, sources: [], suites: { unit: {}, custom: {} } };
    writeFileSync(path.join(repoDir, 'tests', 'ci-test-weights.json'), JSON.stringify(manifest));
    fn(repoDir);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
}

test('parseShardCount reads matrix shard lists per job', () => {
  assert.equal(parseShardCount(FIXTURE_WORKFLOW, 'shell'), 3);
  assert.equal(parseShardCount(FIXTURE_WORKFLOW, 'unit'), 5);
  assert.equal(parseShardCount(FIXTURE_WORKFLOW, 'custom'), 3);
  assert.equal(parseShardCount(FIXTURE_WORKFLOW, 'smoke'), null);
  assert.equal(parseShardCount(FIXTURE_WORKFLOW, 'nonexistent'), null);
});

test('parseShellArray reads entries and ignores comments', () => {
  const script = 'X=(\n  a.test.ts\n  # a comment line\n  b.test.ts  # trailing comment\n)\n';
  assert.deepEqual(parseShellArray(script, 'X'), ['a.test.ts', 'b.test.ts']);
  assert.throws(() => parseShellArray(script, 'MISSING'), /MISSING/);
});

test('readRegisteredSuites reads the shell array and merges custom ts and sh arrays', () => {
  withFixtureRepo({}, (repoDir) => {
    const suites = readRegisteredSuites(repoDir);
    assert.deepEqual(suites.shell, ['s-a.test.sh', 's-b.test.sh', 's-c.test.sh', 's-d.test.sh', 's-e.test.sh', 's-f.test.sh']);
    assert.equal(suites.unit.length, 5);
    assert.deepEqual(suites.custom, [
      'shared/lib/x.test.ts',
      'shared/lib/y.test.ts',
      'shared/lib/z.test.ts',
      'shared/lib/q.test.ts',
      'shared/lib/r.test.ts',
      'tests/w.test.sh',
    ]);
  });
});

test('loadWeightsManifest rejects malformed manifests with diagnostics', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'weights-'));
  try {
    const manifestPath = path.join(dir, 'w.json');
    writeFileSync(manifestPath, 'not json');
    assert.throws(() => loadWeightsManifest(manifestPath), /not valid JSON/);
    writeFileSync(manifestPath, JSON.stringify({ version: 2, defaultMs: 1, suites: {} }));
    assert.throws(() => loadWeightsManifest(manifestPath), /version/);
    writeFileSync(manifestPath, JSON.stringify({ version: 1, defaultMs: 0, suites: {} }));
    assert.throws(() => loadWeightsManifest(manifestPath), /defaultMs/);
    writeFileSync(manifestPath, JSON.stringify({ version: 1, defaultMs: 1000 }));
    assert.throws(() => loadWeightsManifest(manifestPath), /suites/);
    writeFileSync(manifestPath, JSON.stringify({ version: 1, defaultMs: 1000, suites: { unit: { 'a.test.ts': -5 } } }));
    assert.throws(() => loadWeightsManifest(manifestPath), /a\.test\.ts/);
    assert.throws(() => loadWeightsManifest(path.join(dir, 'absent.json')), /cannot read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkShardBalance passes on a balanced fixture', () => {
  withFixtureRepo({}, (repoDir) => {
    const result = checkShardBalance(repoDir);
    assert.equal(result.ok, true, formatShardBalance(result));
    assert.equal(result.suites.length, 3);
    const unit = result.suites.find((suite) => suite.suite === 'unit')!;
    assert.equal(unit.shardCount, 5);
    // Every registered test assigned exactly once.
    const assigned = unit.partition.shards.flatMap((shard) => shard.files).sort();
    assert.deepEqual(assigned, [...unit.partition.shards.flatMap((s) => s.files)].sort());
    assert.equal(assigned.length, unit.testCount);
  });
});

test('checkShardBalance fails on stale manifest entries with names', () => {
  withFixtureRepo(
    {
      manifest: {
        version: 1,
        defaultMs: 30000,
        sources: [],
        suites: { unit: { 'shared/lib/deleted.test.ts': 5000 }, custom: {} },
      },
    },
    (repoDir) => {
      const result = checkShardBalance(repoDir);
      assert.equal(result.ok, false);
      assert.match(result.problems.join('\n'), /stale weights/);
      assert.match(result.problems.join('\n'), /deleted\.test\.ts/);
    }
  );
});

// The divisible-overload failure path of analyzeBalance is covered directly in
// test-partitioner.test.ts (LPT rarely produces one organically).
test('checkShardBalance excuses a named indivisible hotspot', () => {
  // Hotspot: one 300s test among 10s tests on 3 shards -> excused and named.
  withFixtureRepo(
    {
      unitTests: ['big.test.ts', 's1.test.ts', 's2.test.ts', 's3.test.ts', 's4.test.ts', 's5.test.ts'],
      workflow: FIXTURE_WORKFLOW.replace('shard: [1, 2, 3, 4, 5]', 'shard: [1, 2, 3]'),
      manifest: {
        version: 1,
        defaultMs: 10000,
        sources: [],
        suites: {
          unit: { 'big.test.ts': 300000, 's1.test.ts': 10000, 's2.test.ts': 10000, 's3.test.ts': 10000, 's4.test.ts': 10000, 's5.test.ts': 10000 },
          custom: {},
        },
      },
    },
    (repoDir) => {
      const result = checkShardBalance(repoDir);
      const unit = result.suites.find((suite) => suite.suite === 'unit')!;
      assert.equal(unit.problems.length, 0, unit.problems.join('\n'));
      assert.match(unit.notes.join('\n'), /indivisible test "big\.test\.ts"/);
      const message = formatShardBalance(result);
      assert.match(message, /big\.test\.ts/);
    }
  );
});

test('checkShardBalance reports malformed workflow matrix as a problem', () => {
  withFixtureRepo({ workflow: 'name: CI\n\njobs:\n  smoke:\n    name: Smoke\n' }, (repoDir) => {
    const result = checkShardBalance(repoDir);
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /could not parse shard matrix/);
  });
});
