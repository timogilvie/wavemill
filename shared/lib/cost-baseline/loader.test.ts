import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBaseline, parsePrStates, prNumberFromUrl, reduceEvalRecord, resolveBaselineSources } from './loader.ts';

const WINDOW = { since: '2026-10-02T00:00:00.000Z', until: '2026-10-30T23:59:59.000Z' };

function evalRow(issueId: string, timestamp: string, merged: boolean, extra: Record<string, unknown> = {}) {
  return { issueId, timestamp, prUrl: 'https://github.com/o/r/pull/101', outcomes: { delivery: { merged } }, ...extra };
}

function economics() {
  const planningRole = { value: 'planning', kind: 'planning', confidence: 'launch_record', evidence: 'launch planning@abc1234#1793000000 at 2026-10-20T08:00:00.000Z' };
  const legacyRole = { value: 'review', confidence: 'timestamp' + '_window', evidence: 'session window overlaps .review-result.json window' };
  const planning = {
    sessionId: 's-plan',
    stageRole: planningRole,
    estimatedCostUsd: 2.5,
    actualCostUsd: null,
    costSource: 'local_estimate',
    usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
    turns: [{ timestamp: '2026-10-20T08:00:05.000Z' }, { timestamp: '2026-10-20T08:09:00.000Z' }],
  };
  const legacy = { sessionId: 's-legacy', stageRole: legacyRole, estimatedCostUsd: 1, actualCostUsd: 0.75, turnCount: 3 };
  const unlabelled = { sessionId: 's-none', estimatedCostUsd: 4 };
  return [{ harness: 'claude-code', sessions: [planning, legacy] }, { harness: 'codex', sessions: [unlabelled, { noId: true }] }];
}

function writeRepo(root: string): void {
  const wm = join(root, '.wavemill');
  mkdirSync(join(wm, 'evals', 'artifacts', 'HOK-10'), { recursive: true });
  mkdirSync(join(wm, 'state-archive'), { recursive: true });
  mkdirSync(join(wm, 'merge-lane', '101'), { recursive: true });
  mkdirSync(join(wm, 'merge-lane', '102'), { recursive: true });
  const rows = [
    evalRow('HOK-10', '2026-10-20T12:00:00.000Z', true, {
      workflowCost: 7.25,
      workflowCostStatus: 'success',
      phaseDurationsSeconds: { planning: 540, coding: 1200 },
      executionEconomics: economics(),
      outcomes: {
        delivery: { merged: true, timeToMergeSeconds: 900 },
        ci: { passed: true, checks: [{ name: 'unit', status: 'success', durationSeconds: 60 }, { name: 'lint', status: 'success' }] },
      },
    }),
    evalRow('HOK-11', '2026-10-21T00:00:00.000Z', false),
    evalRow('HOK-12', '2026-09-01T00:00:00.000Z', true),
    evalRow('HOK-13', '2026-10-22T00:00:00.000Z', true, { prUrl: 'https://github.com/o/r/pull/102', workflowCost: 1 }),
    evalRow('HOK-13', '2026-10-25T00:00:00.000Z', true, { prUrl: 'https://github.com/o/r/pull/102', workflowCost: 2 }),
    evalRow('HOK-14_c', '2026-10-26T00:00:00.000Z', true, { prUrl: null }),
  ];
  writeFileSync(join(wm, 'evals', 'evals.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n{not json\n\n`);
  writeFileSync(join(wm, 'state-archive', 'tombstones.jsonl'), [
    { workflowOutcome: 'merged', createdAt: '2026-10-20T12:00:00Z' },
    { workflowOutcome: 'error', createdAt: '2026-10-21T12:00:00Z' },
    { workflowOutcome: 'error', createdAt: '2026-09-21T12:00:00Z' },
  ].map((r) => JSON.stringify(r)).join('\n'));
  writeFileSync(join(wm, 'merge-lane', '101', 'progress.json'), JSON.stringify({
    prNumber: 101, enteredLaneAt: '2026-10-20T11:50:00.000Z', lastProgressAt: '2026-10-20T11:55:00.000Z', lastEvent: 'merged', laneHoldSeconds: 300, mergeAttemptCount: 2, rebaseCount: 1,
  }));
  writeFileSync(join(wm, 'merge-lane', '102', 'progress.json'), '{broken');
  writeFileSync(join(wm, 'label-writes.jsonl'), [
    { at: '2026-10-20T11:40:00.000Z', prNumber: 101, label: 'wm:ready', action: 'labeled' },
    { at: '2026-10-20T11:30:00.000Z', prNumber: 999, label: 'wm:ready', action: 'labeled' },
    { at: 'garbage', prNumber: 101, label: 'wm:ready', action: 'labeled' },
    { at: '2026-10-20T11:49:59.000Z', prNumber: 101, label: 'wm:ready', action: 'unlabeled' },
  ].map((r) => JSON.stringify(r)).join('\n'));
  writeFileSync(join(wm, 'evals', 'artifacts', 'HOK-10', '.review-result.json'), JSON.stringify({
    stage: 'review',
    status: 'completed',
    startedAt: '2026-10-20T09:00:00Z',
    finishedAt: '2026-10-20T10:00:00Z',
    agent: 'claude',
    model: 'claude-opus-5-5',
    artifacts: {
      type: 'review',
      iterations: 2,
      reviewIterations: [{ iteration: 1, recordedAt: '2026-10-20T10:00:00Z', verdict: 'ready', findings: [{ location: 'a.ts:1', severity: 'warning' }], reviewerDelta: { filesChanged: ['a.ts'] } }],
    },
  }));
}

// protects: the join across evals, tombstones, lane progress, label ledger and archived review
test('loadBaseline joins every source for merged in-window tasks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cost-baseline-'));
  try {
    writeRepo(root);
    const loaded = await loadBaseline(resolveBaselineSources(root), WINDOW);
    assert.deepEqual(loaded.tasks.map((t) => t.issueId), ['HOK-10', 'HOK-13', 'HOK-14_c']);
    assert.deepEqual(loaded.counts, {
      evalRowsInWindow: 5,
      mergedRows: 4,
      duplicateRowsCollapsed: 1,
      malformedLines: 1,
      tombstonesByOutcome: { merged: 1, error: 1 },
    });

    const [hok10, hok13, challenger] = loaded.tasks;
    assert.equal(hok10.prNumber, 101);
    assert.equal(hok10.lane?.mergeAttemptCount, 2);
    assert.equal(hok10.lane?.ciRestartCount, null);
    assert.deepEqual(hok10.labelEvents.map((e) => e.action), ['labeled', 'unlabeled']);
    assert.deepEqual(hok10.phaseDurations, { planning: 540, coding: 1200 });
    assert.equal(hok10.timeToMergeSeconds, 900);
    assert.deepEqual(hok10.ciChecks.map((c) => c.durationSeconds), [60, null]);
    assert.equal(hok10.review?.iterations, 2);
    assert.deepEqual(hok10.review?.reviewIterations?.[0].filesChanged, ['a.ts']);
    assert.deepEqual(
      hok10.sessions.map((s) => [s.sessionId, s.harness, s.kind, s.costUsd, s.launchEvidence !== null]),
      [['s-plan', 'claude-code', 'planning', 2.5, true], ['s-legacy', 'claude-code', 'review', 0.75, false], ['s-none', 'codex', 'unattributed', 4, false]],
    );
    assert.deepEqual([hok10.sessions[0].firstTurnAt, hok10.sessions[0].lastTurnAt, hok10.sessions[0].turnCount], ['2026-10-20T08:00:05.000Z', '2026-10-20T08:09:00.000Z', 2]);
    assert.equal(hok10.sessions[1].turnCount, 3);

    assert.equal(hok13.workflowCost, 2, 'the later row for a duplicated issue wins');
    assert.equal(hok13.lane, null, 'an unreadable progress.json is skipped');
    assert.equal(challenger.isChallenger, true);
    assert.equal(challenger.prNumber, null);
    assert.equal(loaded.labelEvents.length, 3, 'unparseable ledger timestamps are dropped');
    assert.deepEqual(loaded.laneProgress.map((l) => l.prNumber), [101]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// protects: a missing .wavemill tree crashing the one-off instead of producing an empty report
test('loadBaseline on an empty repo yields an empty cohort', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cost-baseline-empty-'));
  try {
    const loaded = await loadBaseline(resolveBaselineSources(root), WINDOW);
    assert.equal(loaded.tasks.length, 0);
    assert.equal(loaded.laneProgress.length, 0);
    assert.deepEqual(loaded.counts.tombstonesByOutcome, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// protects: PR states joined from gh output with the wrong shape
test('parsePrStates keeps valid rows and loadBaseline attaches them to tasks', async () => {
  const states = parsePrStates(JSON.stringify([
    { number: 101, state: 'MERGED', mergedAt: '2026-10-20T11:55:00Z', closedAt: '2026-10-20T11:55:00Z' },
    { number: 5, state: 'DRAFT' },
    { state: 'OPEN' },
  ]));
  assert.deepEqual([...states.keys()], [101]);
  const root = mkdtempSync(join(tmpdir(), 'cost-baseline-gh-'));
  try {
    writeRepo(root);
    const loaded = await loadBaseline(resolveBaselineSources(root), WINDOW, { prStates: states });
    assert.equal(loaded.tasks[0].prState?.mergedAt, '2026-10-20T11:55:00Z');
    assert.equal(loaded.tasks[1].prState, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// protects: non-PR URLs parsed as PR numbers; rows without identity accepted
test('prNumberFromUrl and reduceEvalRecord reject malformed input', () => {
  assert.equal(prNumberFromUrl('https://github.com/o/r/pull/1744'), 1744);
  assert.equal(prNumberFromUrl('https://github.com/o/r/pull/1744/files'), 1744);
  assert.equal(prNumberFromUrl('https://github.com/o/r/issues/12'), null);
  assert.equal(prNumberFromUrl(undefined), null);
  assert.equal(reduceEvalRecord({ timestamp: '2026-10-20T00:00:00Z' }), null);
});
