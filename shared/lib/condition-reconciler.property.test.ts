/**
 * HOK-3230 property-based tests for `condition_reconcile_task`.
 *
 * Pins the HOK-3172 invariants:
 *   - A marker written with `--expires-on head --head A` survives at HEAD=A,
 *     and is cleared at HEAD=B ≠ A.
 *   - A marker with a `recheckAfter` deadline survives when the deadline is
 *     in the future and clears once the clock has passed it.
 *   - A `.ready-waiting-on.json` marker clears exactly when the awaited PR
 *     head catches up.
 *   - Reconciliation is idempotent: a second tick clears nothing new.
 *
 * Each property shells `condition_reconcile_task` through a tiny bash harness
 * that sources `wavemill-common.sh`, `bounded-retry.sh`, `transient-marker.sh`
 * and `condition-reconciler.sh`. `numRuns` is kept small (10–15) because the
 * fixture setup is dominated by `git init` + `jq` wall-clock.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertProperty } from './fast-check-utils.ts';
import { arbitraryHexSha } from './property-generators.ts';

const __filename = fileURLToPath(import.meta.url);
const LIB_DIR = dirname(__filename);
// We skip `wavemill-common.sh` here: the only reconciler branch that calls
// into it is `status === "error"`, which our fixtures leave as `active`.
// Omitting the 10k-line common.sh saves ~500 ms per shell invocation.
const SOURCES = [
  join(LIB_DIR, 'bounded-retry.sh'),
  join(LIB_DIR, 'transient-marker.sh'),
  join(LIB_DIR, 'condition-reconciler.sh'),
];
const SOURCE_PREFIX = SOURCES.map((p) => `source "${p}"`).join(' && ');

interface Fixture {
  dir: string;
  worktree: string;
  stateDir: string;
  stateFile: string;
  prCache: string;
  oldHead: string;
  head: string;
}

/** One shared worktree + fixture per test file; each property resets state. */
let shared: Fixture | null = null;

before(() => {
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-prop-'));
  const worktree = join(dir, 'wt');
  const stateDir = join(worktree, 'features', 'task');
  const stateFile = join(dir, 'state.json');
  const prCache = join(dir, 'pr-cache.json');
  execFileSync('git', ['init', '-q', worktree]);
  execFileSync('git', ['-C', worktree, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one']);
  const oldHead = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  execFileSync('git', ['-C', worktree, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'two']);
  const head = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ tasks: { 'HOK-9999': { status: 'active', phase: 'ready', pr: '1591' } } }));
  writeFileSync(prCache, '[]');
  shared = { dir, worktree, stateDir, stateFile, prCache, oldHead, head };
});

after(() => {
  if (shared) {
    rmSync(shared.dir, { recursive: true, force: true });
    shared = null;
  }
});

function getFixture(): Fixture {
  if (!shared) throw new Error('shared fixture not initialised');
  return shared;
}

/**
 * Reset the fixture's state_dir to a clean, task-less slate between runs
 * (keep the git repo + two commits — those are the expensive bits). Resets
 * HEAD to the two-commit baseline when a prior property advanced it.
 */
function resetFixtureState(fixture: Fixture): void {
  // Clean every marker/log/retry file in the state_dir.
  rmSync(fixture.stateDir, { recursive: true, force: true });
  mkdirSync(fixture.stateDir, { recursive: true });
  // Clean worktree HEAD back to the baseline (second commit).
  execFileSync('git', ['-C', fixture.worktree, 'reset', '-q', '--hard', fixture.head]);
  writeFileSync(fixture.stateFile, JSON.stringify({ tasks: { 'HOK-9999': { status: 'active', phase: 'ready', pr: '1591' } } }));
  writeFileSync(fixture.prCache, '[]');
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Write one or more markers and immediately run the reconciler in a single bash. */
function writeMarkersAndReconcile(
  fixture: Fixture,
  markers: Array<{ name: string; flags: string[]; head: string }>,
): void {
  const parts = markers.map((m) => {
    const flagsStr = m.flags.map(shQuote).join(' ');
    return `marker_write ${shQuote(join(fixture.stateDir, m.name))} --kind test-marker --head ${shQuote(m.head)} --state-dir ${shQuote(fixture.stateDir)} ${flagsStr}`;
  }).join(' && ');
  const script = `${SOURCE_PREFIX}
export STATE_FILE=${shQuote(fixture.stateFile)}
export MONITOR_PR_CACHE=${shQuote(fixture.prCache)}
export SESSION="prop-reconcile"
${parts}
condition_reconcile_task "HOK-9999" ${shQuote(fixture.worktree)} ${shQuote(fixture.stateDir)} || true`;
  execFileSync('bash', ['-c', script], { encoding: 'utf-8' });
}

/** Run the reconciler against a prepared fixture (no marker write). */
function runReconcile(fixture: Fixture): void {
  const script = `${SOURCE_PREFIX}
export STATE_FILE=${shQuote(fixture.stateFile)}
export MONITOR_PR_CACHE=${shQuote(fixture.prCache)}
export SESSION="prop-reconcile"
condition_reconcile_task "HOK-9999" ${shQuote(fixture.worktree)} ${shQuote(fixture.stateDir)} || true`;
  execFileSync('bash', ['-c', script], { encoding: 'utf-8' });
}

function writePrCache(fixture: Fixture, prNumber: number, headRefOid: string): void {
  writeFileSync(
    fixture.prCache,
    JSON.stringify([
      { number: 42, headRefOid: 'deadbeef' },
      { number: prNumber, headRefOid },
    ]),
  );
}

test('P1 head-expiry: marker survives at the condition head, clears at a different head', () => {
  assertProperty(
    fc.property(fc.boolean(), (headShouldChange) => {
      const fixture = getFixture();
      resetFixtureState(fixture);
      writeMarkersAndReconcile(fixture, [
        { name: '.needs-attention', flags: ['--expires-on', 'head'], head: fixture.head },
      ]);
      assert.ok(
        existsSync(join(fixture.stateDir, '.needs-attention')),
        'marker must survive while worktree HEAD matches the condition head',
      );
      if (headShouldChange) {
        execFileSync('git', [
          '-C',
          fixture.worktree,
          '-c',
          'user.email=t@t',
          '-c',
          'user.name=t',
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          'three',
        ]);
        runReconcile(fixture);
        assert.equal(
          existsSync(join(fixture.stateDir, '.needs-attention')),
          false,
          'marker must be cleared when the condition head no longer matches worktree HEAD',
        );
      } else {
        runReconcile(fixture);
        assert.ok(
          existsSync(join(fixture.stateDir, '.needs-attention')),
          'marker must still survive without a head change',
        );
      }
    }),
    { name: 'P1 head-expiry correctness', numRuns: 4 },
  );
});

test('P2 idempotency: a second reconcile tick is a no-op', () => {
  assertProperty(
    fc.property(fc.integer({ min: 1, max: 2 }), (nMarkers) => {
      const fixture = getFixture();
      resetFixtureState(fixture);
      const markers = Array.from({ length: nMarkers }, (_, i) => ({
        name: i === 0 ? '.needs-attention' : '.needs-attention-transient',
        flags: ['--expires-on', 'head'],
        head: fixture.head,
      }));
      writeMarkersAndReconcile(fixture, markers);
      const beforeFiles = ['.needs-attention', '.needs-attention-transient']
        .filter((n) => existsSync(join(fixture.stateDir, n)));
      runReconcile(fixture);
      const afterFiles = ['.needs-attention', '.needs-attention-transient']
        .filter((n) => existsSync(join(fixture.stateDir, n)));
      assert.deepEqual(
        afterFiles,
        beforeFiles,
        `second reconcile must leave the marker set unchanged (before=${JSON.stringify(beforeFiles)}, after=${JSON.stringify(afterFiles)})`,
      );
    }),
    { name: 'P2 idempotency', numRuns: 4 },
  );
});

test('P3 deadline: future deadline survives, past deadline clears', () => {
  assertProperty(
    fc.property(
      fc.integer({ min: 60, max: 86400 }),
      fc.boolean(),
      (deltaSeconds, pastDeadline) => {
        const fixture = getFixture();
        resetFixtureState(fixture);
        writeMarkersAndReconcile(fixture, [
          {
            name: '.needs-attention-transient',
            flags: ['--expires-on', 'deadline', '--recheck-after-seconds', String(deltaSeconds)],
            head: fixture.head,
          },
        ]);
        if (!pastDeadline) {
          assert.ok(
            existsSync(join(fixture.stateDir, '.needs-attention-transient')),
            'future-deadline marker must survive the first reconcile',
          );
        } else {
          // Rewrite recheckAfter to be in the past, then reconcile.
          execFileSync(
            'bash',
            [
              '-c',
              `jq '.condition.recheckAfter = "2000-01-01T00:00:00Z"' "${join(fixture.stateDir, '.needs-attention-transient')}" > "${fixture.dir}/m" && mv "${fixture.dir}/m" "${join(fixture.stateDir, '.needs-attention-transient')}"`,
            ],
            { encoding: 'utf-8' },
          );
          runReconcile(fixture);
          assert.equal(
            existsSync(join(fixture.stateDir, '.needs-attention-transient')),
            false,
            'past-deadline marker must be cleared',
          );
        }
      },
    ),
    { name: 'P3 deadline trigger', numRuns: 6 },
  );
});

test('P4 waiting-on PR head: cleared iff PR head catches up to the awaited value', () => {
  assertProperty(
    fc.property(arbitraryHexSha(40), arbitraryHexSha(40), (awaited, remote) => {
      fc.pre(awaited !== remote);
      const fixture = getFixture();
      resetFixtureState(fixture);
      writePrCache(fixture, 1591, remote);
      writeMarkersAndReconcile(fixture, [
        {
          name: '.ready-waiting-on.json',
          flags: ['--waiting-on', `pr-head=${awaited}@1591`, '--expires-on', 'head,waiting-on'],
          head: fixture.head,
        },
      ]);
      assert.equal(
        existsSync(join(fixture.stateDir, '.ready-waiting-on.json')),
        true,
        `wait must persist while PR head (${remote}) ≠ awaited (${awaited})`,
      );
      // PR head catches up — reconcile once more.
      writePrCache(fixture, 1591, awaited);
      runReconcile(fixture);
      assert.equal(
        existsSync(join(fixture.stateDir, '.ready-waiting-on.json')),
        false,
        `wait must clear once PR head reaches ${awaited}`,
      );
    }),
    { name: 'P4 waiting-on PR head', numRuns: 4 },
  );
});
