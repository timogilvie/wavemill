import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  TEND_CANDIDATES_MAX_PER_TICK,
  buildTendCandidates,
  candidatesFromMarkerFindings,
  readTendBlockedLaneCandidates,
} from './wavemill-incident-tend-candidates.ts';

const now = new Date('2026-09-04T12:00:00.000Z');

function withRepo(fn: (repo: string) => void): void {
  const repo = mkdtempSync(join(tmpdir(), 'incident-tend-candidates-'));
  try {
    mkdirSync(join(repo, '.wavemill'), { recursive: true });
    fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function writeTend(repo: string, tend: Record<string, unknown>): void {
  writeFileSync(join(repo, '.wavemill', 'backstage-health.json'), JSON.stringify({ services: { tend } }));
}

const lane = [
  { pr: 1324, headBranch: 'task/stale-review', gate: 'missing-metadata', labels: ['wavemill'] },
  { pr: 1325, headBranch: 'task/other-review', gate: 'ready-failed:not-ready', labels: ['wavemill', 'wm:blocked'] },
];

test('a fresh idle-blocked-stall heartbeat yields every blocked PR with its gate', () => {
  withRepo((repo) => {
    writeTend(repo, { laneCondition: 'idle-blocked-stall', heartbeatAt: '2026-09-04T11:58:00.000Z', blockedLane: lane, blockedStreak: 42 });
    const candidates = readTendBlockedLaneCandidates(repo, now, [
      { issue: 'HOK-1325', pr: 'https://github.com/o/r/pull/1325', branch: 'task/other-review', challengePairId: undefined },
    ]);
    assert.deepEqual(candidates.map((candidate) => [candidate.pr, candidate.firstBlockedGate, candidate.taskId]), [
      [1324, 'missing-metadata', undefined],
      [1325, 'ready-failed:not-ready', 'HOK-1325'],
    ]);
    assert.ok(candidates.every((candidate) => candidate.source === 'backstage-health' && candidate.blockedStreak === 42));
    assert.ok(candidates.every((candidate) => candidate.markerKind === 'merge-lane-idle-stall'));
    assert.deepEqual(candidates[1].labels, ['wavemill', 'wm:blocked']);
  });
});

test('a stale heartbeat or a non-stall lane condition yields no candidates', () => {
  withRepo((repo) => {
    writeTend(repo, { laneCondition: 'idle-blocked-stall', heartbeatAt: '2026-09-04T11:00:00.000Z', blockedLane: lane });
    assert.deepEqual(readTendBlockedLaneCandidates(repo, now), []);
    writeTend(repo, { laneCondition: 'needs-user-hold', heartbeatAt: '2026-09-04T11:59:00.000Z', blockedLane: lane });
    assert.deepEqual(readTendBlockedLaneCandidates(repo, now), []);
    writeTend(repo, { laneCondition: 'idle-blocked-stall', blockedLane: lane });
    assert.deepEqual(readTendBlockedLaneCandidates(repo, now), []);
  });
});

test('malformed backstage-health.json or lane entries yield [] without throwing', () => {
  withRepo((repo) => {
    writeFileSync(join(repo, '.wavemill', 'backstage-health.json'), '{not json');
    assert.deepEqual(readTendBlockedLaneCandidates(repo, now), []);
    writeTend(repo, { laneCondition: 'idle-blocked-stall', heartbeatAt: '2026-09-04T11:59:00.000Z', blockedLane: [null, 'x', { pr: -1 }, { pr: 7 }] });
    assert.deepEqual(readTendBlockedLaneCandidates(repo, now).map((candidate) => candidate.pr), [7]);
  });
  // Missing file
  assert.deepEqual(readTendBlockedLaneCandidates('/nonexistent-repo-for-candidates', now), []);
});

test('marker findings yield every blocked PR; the gate belongs to the first PR only', () => {
  const findings = [{
    id: 'marker-merge-lane/idle-stall/#1328-merge-lane-idle-stall',
    repoDir: '/repo',
    evidence: [
      'markerKind=merge-lane-idle-stall',
      'blockedPrs=1328,1329',
      'firstBlockedPr=1328',
      'firstBlockedGate=challenge:pair-unresolved:no-comparison',
      'firstBlockedLabels=wavemill,wm:ready',
      'consecutivePolls=30',
    ],
  }, {
    id: 'marker-other',
    repoDir: '/other-repo',
    evidence: ['markerKind=merge-lane-idle-stall', 'firstBlockedPr=1'],
  }];
  const candidates = candidatesFromMarkerFindings(findings, '/repo', [{ issue: 'HOK-2934_c', pr: '1329' }]);
  assert.deepEqual(candidates.map((candidate) => [candidate.pr, candidate.firstBlockedGate, candidate.taskId]), [
    [1328, 'challenge:pair-unresolved:no-comparison', undefined],
    [1329, undefined, 'HOK-2934_c'],
  ]);
  assert.deepEqual(candidates[0].labels, ['wavemill', 'wm:ready']);
  assert.equal(candidates[0].blockedStreak, 30);
});

test('buildTendCandidates merges sources by PR, prefers health, and caps per tick', () => {
  withRepo((repo) => {
    const manyLane = Array.from({ length: 15 }, (_, index) => ({ pr: 2000 + index, headBranch: `task/x-${index}`, gate: 'missing-metadata', labels: [] }));
    writeTend(repo, { laneCondition: 'idle-blocked-stall', heartbeatAt: '2026-09-04T11:59:00.000Z', blockedLane: [lane[0], ...manyLane] });
    const candidates = buildTendCandidates({
      repoDir: repo,
      now,
      findings: [{
        id: 'marker-x',
        repoDir: repo,
        evidence: ['markerKind=merge-lane-idle-stalled', 'firstBlockedPr=1324', 'firstBlockedGate=stale-gate', 'pairId=HOK-1'],
      }],
    });
    assert.equal(candidates.length, TEND_CANDIDATES_MAX_PER_TICK);
    const first = candidates[0];
    assert.equal(first.pr, 1324);
    assert.equal(first.source, 'backstage-health');
    assert.equal(first.firstBlockedGate, 'missing-metadata');
    assert.equal(first.pairId, 'HOK-1');
    assert.deepEqual(candidates.map((candidate) => candidate.pr), [...candidates.map((candidate) => candidate.pr)].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });
});

test('buildTendCandidates falls back to marker findings when the heartbeat has no blocked lane', () => {
  withRepo((repo) => {
    writeTend(repo, { laneCondition: 'progressing', heartbeatAt: '2026-09-04T11:59:00.000Z', blockedLane: [] });
    const candidates = buildTendCandidates({
      repoDir: repo,
      now,
      findings: [{ id: 'marker-y', repoDir: repo, evidence: ['markerKind=merge-lane-idle-stall', 'firstBlockedPr=1324', 'firstBlockedGate=review:not-ready'] }],
    });
    assert.deepEqual(candidates.map((candidate) => [candidate.pr, candidate.source]), [[1324, 'observer-marker']]);
  });
});
