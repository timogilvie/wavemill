import { strict as assert } from 'node:assert';
import { afterEach, describe, it, mock } from 'node:test';

import type { PullRequest } from '../shared/lib/github.ts';
import { WM_LABELS } from '../shared/lib/pr-state-labels.ts';
import { setPrReadyLabel, setPrReadyLabelDeps } from './set-pr-ready-label.ts';

function pullRequestWithLabels(labelNames: string[]): PullRequest {
  return {
    number: 304,
    title: 'Example',
    headRefName: 'task/ready-pr',
    headRefOid: 'head-304',
    baseRefName: 'auto/integration',
    labels: labelNames.map((name) => ({ name })),
    url: 'https://github.com/acme/widgets/pull/304',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    mergedAt: null,
    closedAt: null,
  } as unknown as PullRequest;
}

afterEach(() => {
  mock.restoreAll();
});

describe('setPrReadyLabel', () => {
  it('reports success when the write actually landed', () => {
    const readyMock = mock.method(setPrReadyLabelDeps, 'setWavemillReady', () =>
      pullRequestWithLabels(['wavemill', WM_LABELS.ready]));
    const logged: string[] = [];
    mock.method(setPrReadyLabelDeps, 'log', (line: string) => { logged.push(line); });

    setPrReadyLabel('304', 'acme/widgets', '/repo-root');

    assert.equal(logged.length, 1);
    assert.match(logged[0], /Canonicalized ready labels for PR #304/);
    assert.deepEqual(readyMock.mock.calls[0]?.arguments, [
      '304',
      { repo: 'acme/widgets', markerRoot: '/repo-root' },
    ]);
  });

  it('throws when the ready label did not land', () => {
    // The failure this guards: a label mutation that reports success while
    // changing nothing, leaving the PR exactly as it was.
    mock.method(setPrReadyLabelDeps, 'setWavemillReady', () =>
      pullRequestWithLabels(['wavemill']));
    const logged: string[] = [];
    mock.method(setPrReadyLabelDeps, 'log', (line: string) => { logged.push(line); });

    assert.throws(() => setPrReadyLabel('304'), /missing wm:ready/);
    assert.equal(logged.length, 0, 'must not claim success when the write failed');
  });

  it('throws when the blocked label survived the transition', () => {
    mock.method(setPrReadyLabelDeps, 'setWavemillReady', () =>
      pullRequestWithLabels(['wavemill', WM_LABELS.ready, WM_LABELS.blocked]));
    mock.method(setPrReadyLabelDeps, 'log', () => {});

    assert.throws(() => setPrReadyLabel('304'), /still has wm:blocked/);
  });

  it('throws when the merging lane lock survived the transition', () => {
    // wm:merging is an exclusive merge-lane lock. Leaving it applied stalls
    // every other PR, so a silent failure here is especially expensive.
    mock.method(setPrReadyLabelDeps, 'setWavemillReady', () =>
      pullRequestWithLabels(['wavemill', WM_LABELS.ready, WM_LABELS.merging]));
    mock.method(setPrReadyLabelDeps, 'log', () => {});

    assert.throws(() => setPrReadyLabel('304'), /still has wm:merging/);
  });

  it('treats a matching Tend claim as successful handoff (HOK-3038)', () => {
    // Regression: Tend claims the PR (applies wm:merging) between Ready's
    // label write and verification. With a matching handoff record, Ready
    // should succeed instead of throwing.
    mock.method(setPrReadyLabelDeps, 'setWavemillReady', () =>
      pullRequestWithLabels(['wavemill', WM_LABELS.merging]));
    mock.method(setPrReadyLabelDeps, 'isTendClaimedForHead', () => true);
    const logged: string[] = [];
    mock.method(setPrReadyLabelDeps, 'log', (line: string) => { logged.push(line); });

    const result = setPrReadyLabel('304', undefined, undefined, '/tmp/state-dir');

    assert.equal(result.tendClaimed, true);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /Tend claimed PR #304/);
  });

  it('still throws on wm:merging without a handoff state dir', () => {
    mock.method(setPrReadyLabelDeps, 'setWavemillReady', () =>
      pullRequestWithLabels(['wavemill', WM_LABELS.merging]));
    mock.method(setPrReadyLabelDeps, 'log', () => {});

    assert.throws(() => setPrReadyLabel('304'), /still has wm:merging/);
  });

  it('still throws on wm:merging when Tend has not claimed the handoff', () => {
    mock.method(setPrReadyLabelDeps, 'setWavemillReady', () =>
      pullRequestWithLabels(['wavemill', WM_LABELS.merging]));
    mock.method(setPrReadyLabelDeps, 'isTendClaimedForHead', () => false);
    mock.method(setPrReadyLabelDeps, 'log', () => {});

    assert.throws(() => setPrReadyLabel('304', undefined, undefined, '/tmp/state-dir'), /still has wm:merging/);
  });

  it('names every observed label so the failure is diagnosable', () => {
    mock.method(setPrReadyLabelDeps, 'setWavemillReady', () =>
      pullRequestWithLabels(['wavemill', WM_LABELS.blocked]));
    mock.method(setPrReadyLabelDeps, 'log', () => {});

    assert.throws(() => setPrReadyLabel('304'), (error: Error) => {
      assert.match(error.message, /PR #304/);
      assert.match(error.message, /Observed labels: \[wavemill, wm:blocked\]/);
      return true;
    });
  });

  it('still rejects a missing PR number', () => {
    assert.throws(() => setPrReadyLabel(''), /PR number is required/);
  });
});
