/**
 * HOK-3468 — replay the six stuck tasks of 2026-11-05/06 against sanitised
 * copies of their reap archives, and assert the report names the gate the plan
 * documented for each.
 *
 * Fixtures live in `tests/fixtures/reliability-gates/<issue>/`: ownership rows,
 * stage results without execution evidence, hook history without free text,
 * head moves and operator events. No transcripts. Every write happens under
 * `mkdtemp` (HOK-3157).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeTaskReliability, type MergedTaskRef } from './reliability-metrics.ts';
import { GATE_TO_CAUSE } from './stall-cause.ts';

const FIXTURES = fileURLToPath(new URL('../../tests/fixtures/reliability-gates/', import.meta.url));

interface FixtureMeta {
  issue: string;
  prNumber: string | null;
  branch: string | null;
  slug: string;
  mergedAt: string;
}

interface Expectation {
  gate: string;
  stage: string;
}

// The plan's table: what held each task through its longest stall.
const EXPECTED: Record<string, Expectation> = {
  // Ready remediation agent parked waiting for a person overnight.
  'HOK-3390': { gate: 'operator-attention', stage: 'ready' },
  'HOK-3430': { gate: 'operator-attention', stage: 'ready' },
  // Ready remediation ran without parking; the remediation itself was the gate.
  'HOK-3415': { gate: 'ready-remediation', stage: 'ready' },
  // Seven coding launches across the overnight coding stall.
  'HOK-3428': { gate: 'coding-agent', stage: 'coding' },
  // Review recorded error / not_ready and never completed.
  'HOK-3423': { gate: 'review-park', stage: 'review' },
  'HOK-3422': { gate: 'review-park', stage: 'review' },
};

function loadFixture(issue: string): { task: MergedTaskRef; repoDir: string; cleanup: () => void } {
  const fixturesRoot = join(FIXTURES, issue);
  const meta = JSON.parse(readFileSync(join(fixturesRoot, 'fixture.json'), 'utf-8')) as FixtureMeta;
  const repoDir = mkdtempSync(join(tmpdir(), 'wm-reliability-gates-'));
  const archiveDir = join(repoDir, '.wavemill', 'evals', 'artifacts', issue);
  cpSync(fixturesRoot, archiveDir, { recursive: true });
  return {
    task: {
      issue,
      title: issue,
      mergedAt: meta.mergedAt,
      ...(meta.prNumber ? { prNumber: meta.prNumber } : {}),
      ...(meta.branch ? { branch: meta.branch } : {}),
      slug: meta.slug,
      archiveDir,
    },
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

describe('reliability gate replay for the six stuck tasks', () => {
  for (const [issue, expected] of Object.entries(EXPECTED)) {
    it(`names ${expected.gate}/${expected.stage} as the gate that held ${issue}`, () => {
      // protects: the longest stall of each 2026-11-05/06 task is attributed
      // to the gate named in the plan, not left unknown or mislabelled.
      const { task, repoDir, cleanup } = loadFixture(issue);
      try {
        const reliability = computeTaskReliability(task, { repoDir, github: { enabled: false } });
        assert.equal(reliability.isMillTask, true);
        assert.equal(reliability.stuckCoverage, 'full');
        const longest = [...reliability.stallIntervals].sort((a, b) => b.durationMs - a.durationMs)[0];
        assert.ok(longest, `${issue} has a stall interval`);
        assert.ok(longest.durationMs >= 60 * 60_000, `${issue}'s longest stall is over an hour`);
        assert.equal(longest.gate, expected.gate, `${issue} gate`);
        assert.equal(longest.stage, expected.stage, `${issue} stage`);
        assert.equal(GATE_TO_CAUSE[longest.gate!], longest.cause, `${issue} coarse cause follows the gate`);
      } finally {
        cleanup();
      }
    });
  }

  it('leaves less than 10% of the six tasks\' stuck hours unknown', () => {
    // protects: the replay evidence shrinks unknown to a small share, so the
    // report can name every task in the table rather than hiding them.
    let stuckMs = 0;
    let unknownMs = 0;
    for (const issue of Object.keys(EXPECTED)) {
      const { task, repoDir, cleanup } = loadFixture(issue);
      try {
        const reliability = computeTaskReliability(task, { repoDir, github: { enabled: false } });
        stuckMs += reliability.stuckMs;
        for (const interval of reliability.stallIntervals) {
          for (const split of interval.gateSplit ?? []) {
            if (split.gate === 'unknown') unknownMs += split.ms;
          }
        }
      } finally {
        cleanup();
      }
    }
    assert.ok(stuckMs > 0);
    assert.ok(unknownMs / stuckMs < 0.1, `unknown share ${(unknownMs / stuckMs) * 100}% of ${stuckMs}ms`);
  });
});
