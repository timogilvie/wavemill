/**
 * Ledger replay: PR #1666 (2026-10-19, HOK-3449).
 *
 * The recorded sequence is the incident: `wm:ready` applied, then cleared;
 * `wm:merging` acquired and released; `wm:blocked` applied at 13:52:59;
 * `wavemill` removed at 13:53:18 and `wm:blocked` at 13:53:20. That removal
 * order is `ALL_WM_LABELS`: the reconciler's null path was stripping every
 * `wm:*` label plus `wavemill`, not just the two it means to clear.
 *
 * The replay folds the ledger up to each decision point and drives it through
 * the real reconciler + `setMergeLabel` writer. With the fix the null decision
 * removes exactly `wm:blocked`; `wavemill` survives.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it, mock } from 'node:test';
import {
  reconcileMergeLabelsForPr,
  type MergeLabelLiveState,
  type MergeLabelTaskView,
  type ReconcileMergeLabelsDeps,
} from '../../../shared/lib/merge-labels.ts';
import { prStateLabelDeps, setMergeLabel } from '../../../shared/lib/pr-state-labels.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PR_NUMBER = 1666;
const HEAD = 'head-1666';
const TASK: MergeLabelTaskView = {
  prNumber: PR_NUMBER,
  headSha: HEAD,
  phase: 'ready',
  featureDir: '/tmp/feat-1666',
};

interface LedgerLine {
  at: string;
  label: string;
  action: 'labeled' | 'unlabeled';
}

const LEDGER: LedgerLine[] = readFileSync(join(HERE, 'pr-1666.jsonl'), 'utf-8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as LedgerLine);

/** Label set after every ledger line at or before `cutoff`; `wavemill` predates the ledger. */
function labelsAt(cutoff: string): string[] {
  const labels = new Set<string>(['wavemill']);
  for (const line of LEDGER) {
    if (line.at > cutoff) break;
    if (line.action === 'labeled') labels.add(line.label);
    else labels.delete(line.label);
  }
  return [...labels];
}

function buildPullRequest(labels: string[]) {
  return {
    number: PR_NUMBER,
    title: 'PR #1666 replay',
    body: '',
    state: 'OPEN',
    author: 'wavemill-bot',
    headRefName: 'task/hok-3220',
    headRefOid: HEAD,
    baseRefName: 'auto/integration',
    labels: labels.map((name) => ({ name })),
    url: `https://github.com/acme/widgets/pull/${PR_NUMBER}`,
    createdAt: '2026-10-19T13:49:00Z',
    updatedAt: '2026-10-19T13:49:00Z',
    mergedAt: null,
    closedAt: null,
  };
}

const GREEN_READY: MergeLabelLiveState = {
  prHeadSha: HEAD,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS', status: 'COMPLETED' }],
  readyAtHead: { verdict: 'ready', sha: HEAD },
  handoffAtHead: { state: 'ready-published', headSha: HEAD, prNumber: PR_NUMBER },
};

/** Drives the real writer (`setMergeLabel`) against an in-memory PR. */
function inMemoryDeps(labels: string[], liveState: MergeLabelLiveState) {
  const current = { labels: [...labels] };
  const removed: string[] = [];
  const added: string[][] = [];
  const snapshot = () => buildPullRequest(current.labels);

  mock.method(prStateLabelDeps, 'getPullRequest', snapshot);
  mock.method(prStateLabelDeps, 'removeLabelFromPullRequest', (_pr: number | string, label: string) => {
    removed.push(label);
    current.labels = current.labels.filter((name) => name !== label);
    return snapshot();
  });
  mock.method(prStateLabelDeps, 'addLabelsToPullRequest', (_pr: number | string, names: string[]) => {
    added.push(names);
    current.labels.push(...names);
    return snapshot();
  });

  const deps: ReconcileMergeLabelsDeps = {
    readTaskView: async () => TASK,
    probeLiveState: async () => liveState,
    writeMergeLabel: async (prNumber, label) => {
      setMergeLabel(prNumber, label);
    },
    logger: { info: () => {}, warn: () => {} },
  };
  return { deps, current, removed, added };
}

afterEach(() => {
  mock.restoreAll();
});

describe('PR #1666 ledger replay (HOK-3449)', () => {
  it('a null decision at 13:52:59 removes only wm:blocked, not wavemill', async () => {
    const labels = labelsAt('2026-10-19T13:52:59.866Z');
    assert.deepEqual(labels.sort(), ['wavemill', 'wm:blocked'], 'seed fold matches the recorded label set');

    const { deps, current, removed, added } = inMemoryDeps(labels, {
      ...GREEN_READY,
      statusCheckRollup: [{ name: 'ci', conclusion: '', status: 'IN_PROGRESS' }],
    });
    const result = await reconcileMergeLabelsForPr(
      { number: PR_NUMBER, labels, headSha: HEAD },
      deps,
    );

    assert.deepEqual(result.decision, { label: null, reason: 'checks-pending' });
    assert.deepEqual(removed, ['wm:blocked'], 'only wm:blocked is removed');
    assert.deepEqual(added, []);
    assert.deepEqual(current.labels, ['wavemill'], 'wavemill is not a merge decision\'s to remove');
    assert.deepEqual(result.updatedLabels, ['wavemill']);
  });

  it('the 13:49:36 wm:merging point gets no reconciler write', async () => {
    const labels = labelsAt('2026-10-19T13:49:36.917Z');
    assert.deepEqual(labels.sort(), ['wavemill', 'wm:merging'], 'seed fold matches the lane-lock point');

    const { deps, current, removed, added } = inMemoryDeps(labels, GREEN_READY);
    const result = await reconcileMergeLabelsForPr(
      { number: PR_NUMBER, labels, headSha: HEAD },
      deps,
    );

    assert.deepEqual(result.decision, { label: 'wm:ready' }, 'the decision is still reported');
    assert.deepEqual(removed, [], 'a lane-locked PR gets no removal');
    assert.deepEqual(added, [], 'a lane-locked PR gets no addition');
    assert.deepEqual(current.labels, labels);
    assert.deepEqual(result.updatedLabels, labels);
  });
});
