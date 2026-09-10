/**
 * Tests for the lifecycle soak report generator (HOK-2957 Phase 6).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateSoakReport } from './lifecycle-soak.ts';

function withTempRepo(): { repoDir: string; stateDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'wavemill-soak-'));
  const stateDir = path.join(repoDir, '.wavemill');
  mkdirSync(stateDir, { recursive: true });
  return {
    repoDir,
    stateDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

test('empty repo produces a pass verdict', () => {
  const { repoDir, cleanup } = withTempRepo();
  try {
    const report = generateSoakReport({ repoDir });
    assert.equal(report.pass, true);
    assert.equal(report.cleanup.totalEpisodes, 0);
    assert.equal(report.shadow.totalEntries, 0);
  } finally {
    cleanup();
  }
});

test('monitor p95 above pollSeconds*1000 is flagged', () => {
  const { repoDir, stateDir, cleanup } = withTempRepo();
  try {
    writeFileSync(path.join(stateDir, 'monitor-timing.json'), JSON.stringify({
      p95Ms: 12_000,
      pollSeconds: 10,
      samples: [1000, 2000, 12000],
    }));
    const report = generateSoakReport({ repoDir });
    assert.equal(report.pass, false);
    assert.equal(report.monitor.withinBudget, false);
    assert.ok(report.failures.some((f) => f.includes('monitor p95')));
  } finally {
    cleanup();
  }
});

test('repeated cleanup episode above the attempt threshold is a failure', () => {
  const { repoDir, stateDir, cleanup } = withTempRepo();
  try {
    writeFileSync(path.join(stateDir, 'workflow-state.json'), JSON.stringify({
      tasks: {
        'HOK-1': {
          lifecycle: {
            cleanupEpisode: { attemptCount: 5, fingerprint: 'a' },
          },
        },
      },
    }));
    const report = generateSoakReport({ repoDir, maxRepeatedAttempts: 3 });
    assert.equal(report.pass, false);
    assert.equal(report.cleanup.repeatedEpisodes, 1);
  } finally {
    cleanup();
  }
});

test('preserved-branches markers count as retained work', () => {
  const { repoDir, cleanup } = withTempRepo();
  try {
    const dir = path.join(repoDir, '.wavemill', 'incidents', 'preserved-branches');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'x.json'), '{}');
    const report = generateSoakReport({ repoDir });
    assert.equal(report.pass, false);
    assert.equal(report.cleanup.retainedBranchCount, 1);
    assert.ok(report.failures.some((f) => f.includes('preserved-branch')));
  } finally {
    cleanup();
  }
});

test('shadow disagreements fail the soak gate', () => {
  const { repoDir, cleanup } = withTempRepo();
  try {
    const dir = path.join(repoDir, '.wavemill', 'shadow');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'cleanup-decisions.jsonl'),
      JSON.stringify({
        branch: 'task/x',
        classification: 'weird',
        mode: 'shadow',
        wouldDelete: true,
      }) + '\n');
    const report = generateSoakReport({ repoDir });
    assert.equal(report.pass, false);
    assert.equal(report.shadow.disagreements, 1);
  } finally {
    cleanup();
  }
});
