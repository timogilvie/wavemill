import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  computeProductionDelta,
  consolidationDeps,
  evaluateConsolidation,
  isProductionFile,
  type PrMeta,
  type ProductionDelta,
} from './check-consolidation.ts';

afterEach(() => {
  mock.restoreAll();
});

const delta = (added: number, removed: number, perFile: ProductionDelta['perFile'] = []): ProductionDelta => ({
  added,
  removed,
  perFile,
});

const pr = (labels: string[], body = ''): PrMeta => ({ number: 1, labels, body });

describe('isProductionFile', () => {
  it('counts .ts/.sh under the production roots and excludes tests, fixtures, allowlists, docs', () => {
    // protects: the delta silently counts test or allowlist lines for or against a PR.
    for (const file of [
      'shared/lib/wavemill-monitor.sh',
      'shared/lib/task-progress.ts',
      'shared/hooks/claude-status-hook.sh',
      'tools/check-consolidation.ts',
    ]) {
      assert.equal(isProductionFile(file), true, file);
    }
    for (const file of [
      'shared/lib/task-progress.test.ts',
      'shared/lib/native-agent/fixtures/compat/index.ts',
      'tools/attention-allowlist.txt',
      'tools/example-allowlist.ts',
      'shared/lib/docs-example.ts',
      'tools/check-consolidation.js',
      'src/index.ts',
      'README.md',
    ]) {
      assert.equal(isProductionFile(file), false, file);
    }
  });
});

describe('computeProductionDelta', () => {
  it('sums only production files from the merge base and ignores binary rows', () => {
    // protects: a test/fixture/binary row moves the gate's delta, or renames hide deletions.
    const calls: string[] = [];
    mock.method(consolidationDeps, 'execShellCommand', (command: string) => {
      calls.push(command);
      if (command.startsWith('git merge-base')) return 'abc123\n';
      return [
        '10\t0\tshared/lib/new-module.ts',
        '0\t120\tshared/lib/old-module.ts',
        '5\t0\tshared/lib/new-module.test.ts',
        '-\t-\tshared/lib/binary.sh',
        '3\t1\tshared/lib/example-allowlist.ts',
        '7\t0\tshared/lib/native-agent/fixtures/case.ts',
        '2\t2\tshared/lib/deep/nested.ts',
        '',
      ].join('\n');
    });

    const result = computeProductionDelta('/repo', 'origin/auto/integration');

    assert.deepEqual(result, {
      added: 12,
      removed: 122,
      perFile: [
        { file: 'shared/lib/new-module.ts', added: 10, removed: 0 },
        { file: 'shared/lib/old-module.ts', added: 0, removed: 120 },
        { file: 'shared/lib/deep/nested.ts', added: 2, removed: 2 },
      ],
    });
    assert.match(calls[1], /--numstat/);
    assert.match(calls[1], /--no-renames/);
  });

  it('throws instead of reporting a zero delta when git cannot be read', () => {
    // protects: a failed merge-base/diff reads as a green "no lines changed" gate.
    mock.method(consolidationDeps, 'execShellCommand', () => {
      throw new Error('fatal: bad revision');
    });
    assert.throws(() => computeProductionDelta('/repo', 'origin/main'), /cannot diff production lines/);
  });
});

describe('evaluateConsolidation', () => {
  it('prints the delta and passes for a PR without the consolidation label', () => {
    // protects: the gate fails or stays silent on ordinary PRs.
    const verdict = evaluateConsolidation(pr(['bug']), delta(10, 2));
    assert.equal(verdict.exitCode, 0);
    assert.deepEqual(verdict.lines, ['Production delta: +10 -2']);
  });

  it('skips with a warning when there is no PR', () => {
    // protects: push/schedule runs fail CI for lack of a PR.
    const verdict = evaluateConsolidation(null, null);
    assert.equal(verdict.exitCode, 0);
    assert.match(verdict.lines[0], /no PR detected/);
  });

  it('fails a consolidation PR that adds net production lines and names the largest files', () => {
    // protects: the HOK-3470 regression — a consolidation PR growing the code base passes.
    const perFile = Array.from({ length: 7 }, (_, index) => ({
      file: `shared/lib/added-${index}.ts`,
      added: index + 1,
      removed: 0,
    }));
    const verdict = evaluateConsolidation(pr(['consolidation']), delta(40, 12, perFile));
    assert.equal(verdict.exitCode, 1);
    const text = verdict.lines.join('\n');
    assert.match(text, /Delta: \+40 -12/);
    assert.match(text, /shared\/lib\/added-6\.ts/);
    assert.doesNotMatch(text, /added-0\.ts/); // only the top five are listed
  });

  it('passes a consolidation PR that deletes more than it adds', () => {
    // protects: deleting the old callers in the same PR still fails.
    const verdict = evaluateConsolidation(pr(['consolidation']), delta(5, 40));
    assert.equal(verdict.exitCode, 0);
    assert.match(verdict.lines[0], /Consolidation successful: net decrease \(-35\)/);
  });

  it('honours a recorded exception in the PR body', () => {
    // protects: a deliberate, recorded exception is rejected.
    const verdict = evaluateConsolidation(
      pr(['consolidation'], 'Notes.\n\nConsolidation Exception: legacy support needs it\n'),
      delta(10, 0),
    );
    assert.equal(verdict.exitCode, 0);
    assert.match(verdict.lines[0], /Exception used: legacy support needs it/);
  });

  it('exits 2 when the PR read failed on a PR event instead of passing silently', () => {
    // protects: a broken or missing GH_TOKEN turns the consolidation gate into a no-op.
    const verdict = evaluateConsolidation(null, null, undefined, true);
    assert.equal(verdict.exitCode, 2);
    assert.match(verdict.lines[0], /could not be read/);
  });

  it('exits 2 when the delta could not be computed for a PR', () => {
    // protects: an uncomputable delta passes as green.
    const verdict = evaluateConsolidation(pr(['consolidation']), null, 'cannot diff production lines');
    assert.equal(verdict.exitCode, 2);
    assert.match(verdict.lines[0], /cannot compute production delta/);
  });
});
