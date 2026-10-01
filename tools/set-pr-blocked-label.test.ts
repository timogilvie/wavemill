import { strict as assert } from 'node:assert';
import { afterEach, describe, it, mock } from 'node:test';

import type { PullRequest } from '../shared/lib/github.ts';
import { WM_LABELS } from '../shared/lib/pr-state-labels.ts';
import { setPrBlockedLabel, setPrBlockedLabelDeps } from './set-pr-blocked-label.ts';

function pullRequestWithLabels(labelNames: string[]): PullRequest {
  return {
    number: 1519,
    title: 'Example',
    headRefName: 'task/ready-pr',
    headRefOid: 'head-1519',
    baseRefName: 'auto/integration',
    labels: labelNames.map((name) => ({ name })),
    url: 'https://github.com/acme/widgets/pull/1519',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    mergedAt: null,
    closedAt: null,
  } as unknown as PullRequest;
}

afterEach(() => {
  mock.restoreAll();
});

describe('setPrBlockedLabel', () => {
  it('demotes a wm:ready PR to wm:blocked and posts a comment with the reason', () => {
    mock.method(setPrBlockedLabelDeps, 'getPullRequest', () =>
      pullRequestWithLabels(['wavemill', WM_LABELS.ready]));
    const blockedMock = mock.method(setPrBlockedLabelDeps, 'setWavemillBlocked', () =>
      pullRequestWithLabels(['wavemill', WM_LABELS.blocked]));
    const shellCalls: string[] = [];
    mock.method(setPrBlockedLabelDeps, 'execShellCommand', (cmd: string) => {
      shellCalls.push(cmd);
      return '';
    });
    mock.method(setPrBlockedLabelDeps, 'log', () => {});

    const reason = 'Cross-PR revert guard blocked ready phase';
    const result = setPrBlockedLabel('1519', reason, 'acme/widgets', '/repo-root', 'abcdef1234567890');

    assert.equal(result.outcome, 'blocked');
    assert.equal(blockedMock.mock.callCount(), 1);
    const call = blockedMock.mock.calls[0]?.arguments;
    assert.deepEqual(call, [
      '1519',
      { headSha: 'abcdef1234567890', reason },
      { repo: 'acme/widgets', markerRoot: '/repo-root' },
    ]);

    assert.equal(shellCalls.length, 1);
    assert.match(shellCalls[0], /^gh pr comment '1519' --body /);
    assert.match(shellCalls[0], /Cross-PR revert guard blocked ready phase/);
    assert.match(shellCalls[0], /abcdef1/);
    assert.match(shellCalls[0], /--repo 'acme\/widgets'/);
  });

  it('demotes a wm:merging PR to wm:blocked when Tend never claimed it', () => {
    mock.method(setPrBlockedLabelDeps, 'getPullRequest', () =>
      pullRequestWithLabels(['wavemill', WM_LABELS.merging]));
    const blockedMock = mock.method(setPrBlockedLabelDeps, 'setWavemillBlocked', () =>
      pullRequestWithLabels(['wavemill', WM_LABELS.blocked]));
    mock.method(setPrBlockedLabelDeps, 'execShellCommand', () => '');
    mock.method(setPrBlockedLabelDeps, 'log', () => {});

    const result = setPrBlockedLabel('1519', 'Ready checks failed');

    assert.equal(result.outcome, 'blocked');
    assert.equal(blockedMock.mock.callCount(), 1);
  });

  it('transitions a PR with no wm:* labels to wm:blocked (REQ-F4)', () => {
    // Ready can observe a PR before any wm:* label has been applied -- for
    // example the first Ready pass that fails before set-pr-ready-label.ts
    // ran. The demotion must still happen so Tend never promotes it.
    mock.method(setPrBlockedLabelDeps, 'getPullRequest', () =>
      pullRequestWithLabels(['wavemill']));
    const blockedMock = mock.method(setPrBlockedLabelDeps, 'setWavemillBlocked', () =>
      pullRequestWithLabels(['wavemill', WM_LABELS.blocked]));
    const shellCalls: string[] = [];
    mock.method(setPrBlockedLabelDeps, 'execShellCommand', (cmd: string) => {
      shellCalls.push(cmd);
      return '';
    });
    mock.method(setPrBlockedLabelDeps, 'log', () => {});

    const result = setPrBlockedLabel('1519', 'Ready checks failed');

    assert.equal(result.outcome, 'blocked');
    assert.equal(blockedMock.mock.callCount(), 1);
    assert.equal(shellCalls.length, 1);
  });

  it('is a no-op when the PR is already wm:blocked (idempotency per head)', () => {
    // Direct regression for "idempotent per head": calling twice in a row
    // against unchanged PR state only mutates once. The bash caller runs
    // every monitor tick while a PR sits in backoff, so this is the hot path.
    mock.method(setPrBlockedLabelDeps, 'getPullRequest', () =>
      pullRequestWithLabels(['wavemill', WM_LABELS.blocked]));
    const blockedMock = mock.method(setPrBlockedLabelDeps, 'setWavemillBlocked', () => {
      throw new Error('setWavemillBlocked must not be called for already-blocked PRs');
    });
    const shellCalls: string[] = [];
    mock.method(setPrBlockedLabelDeps, 'execShellCommand', (cmd: string) => {
      shellCalls.push(cmd);
      return '';
    });
    mock.method(setPrBlockedLabelDeps, 'log', () => {});

    const result = setPrBlockedLabel('1519', 'Ready checks failed');

    assert.equal(result.outcome, 'unchanged');
    assert.equal(blockedMock.mock.callCount(), 0);
    assert.equal(shellCalls.length, 0);
  });

  it('re-runs the demotion when wm:blocked coexists with a lingering wm:ready', () => {
    // Belt and braces: if a prior demotion partially succeeded (blocked
    // added, ready not removed), we still owe the transition. The lingering
    // wm:ready is exactly the state tend reads as "merge candidate", so the
    // short-circuit must not fire here.
    mock.method(setPrBlockedLabelDeps, 'getPullRequest', () =>
      pullRequestWithLabels(['wavemill', WM_LABELS.blocked, WM_LABELS.ready]));
    const blockedMock = mock.method(setPrBlockedLabelDeps, 'setWavemillBlocked', () =>
      pullRequestWithLabels(['wavemill', WM_LABELS.blocked]));
    mock.method(setPrBlockedLabelDeps, 'execShellCommand', () => '');
    mock.method(setPrBlockedLabelDeps, 'log', () => {});

    const result = setPrBlockedLabel('1519', 'Ready checks failed');

    assert.equal(result.outcome, 'blocked');
    assert.equal(blockedMock.mock.callCount(), 1);
  });

  it('still demotes when the comment post fails', () => {
    // The comment is best-effort documentation. A failing gh pr comment must
    // not raise, or a transient GitHub hiccup would bubble up as a Ready
    // stage error on every monitor tick until it clears.
    mock.method(setPrBlockedLabelDeps, 'getPullRequest', () =>
      pullRequestWithLabels(['wavemill', WM_LABELS.ready]));
    const blockedMock = mock.method(setPrBlockedLabelDeps, 'setWavemillBlocked', () =>
      pullRequestWithLabels(['wavemill', WM_LABELS.blocked]));
    mock.method(setPrBlockedLabelDeps, 'execShellCommand', () => {
      throw new Error('gh: rate limited');
    });
    const logged: string[] = [];
    mock.method(setPrBlockedLabelDeps, 'log', (line: string) => { logged.push(line); });

    const result = setPrBlockedLabel('1519', 'Ready checks failed');

    assert.equal(result.outcome, 'blocked');
    assert.equal(blockedMock.mock.callCount(), 1);
    assert.ok(
      logged.some((line) => /Warning:.*blocked-label comment/.test(line)),
      `expected a warning log, saw: ${JSON.stringify(logged)}`,
    );
  });

  it('rejects a missing PR number', () => {
    assert.throws(() => setPrBlockedLabel('', 'reason'), /PR number is required/);
  });

  it('rejects a missing reason', () => {
    assert.throws(() => setPrBlockedLabel('1519', ''), /Reason is required/);
  });
});
