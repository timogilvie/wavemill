import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import * as prStateLabels from './pr-state-labels.ts';

function buildPullRequest(labelNames: string[]) {
  return {
    number: 229,
    title: 'Add label helpers',
    body: '',
    state: 'OPEN',
    author: 'octocat',
    headRefName: 'task/labels',
    headRefOid: 'head-229',
    baseRefName: 'main',
    labels: labelNames.map((name) => ({ name })),
    url: 'https://github.com/acme/widgets/pull/229',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    mergedAt: null,
    closedAt: null,
  };
}

afterEach(() => {
  mock.restoreAll();
});

describe('setWavemillReady', () => {
  it('is a no-op when the pull request is already ready', () => {
    const getMock = mock.method(prStateLabels.prStateLabelDeps, 'getPullRequest', () =>
      buildPullRequest([prStateLabels.WM_LABELS.ready]),
    );
    const addMock = mock.method(prStateLabels.prStateLabelDeps, 'addLabelsToPullRequest', () => {
      throw new Error('should not add labels');
    });
    const removeMock = mock.method(prStateLabels.prStateLabelDeps, 'removeLabelFromPullRequest', () => {
      throw new Error('should not remove labels');
    });

    try {
      const result = prStateLabels.setWavemillReady(229);
      assert.equal(result.number, 229);
      assert.equal(getMock.mock.callCount(), 1);
      assert.equal(addMock.mock.callCount(), 0);
      assert.equal(removeMock.mock.callCount(), 0);
    } finally {
      removeMock.mock.restore();
      addMock.mock.restore();
      getMock.mock.restore();
    }
  });

  it('adds ready and removes conflicting states', () => {
    const getMock = mock.method(prStateLabels.prStateLabelDeps, 'getPullRequest', () =>
      buildPullRequest([prStateLabels.WM_LABELS.blocked]),
    );
    const addMock = mock.method(prStateLabels.prStateLabelDeps, 'addLabelsToPullRequest', () =>
      buildPullRequest([prStateLabels.WM_LABELS.ready]),
    );
    const removeMock = mock.method(prStateLabels.prStateLabelDeps, 'removeLabelFromPullRequest', () =>
      buildPullRequest([]),
    );

    try {
      const result = prStateLabels.setWavemillReady(229, { repo: 'acme/widgets' });
      assert.equal(result.labels[0]?.name, prStateLabels.WM_LABELS.ready);
      assert.equal(getMock.mock.callCount(), 1);
      assert.deepEqual(removeMock.mock.calls[0]?.arguments, [229, prStateLabels.WM_LABELS.blocked, { repo: 'acme/widgets' }]);
      assert.deepEqual(addMock.mock.calls[0]?.arguments, [229, [prStateLabels.WM_LABELS.ready], { repo: 'acme/widgets' }]);
    } finally {
      removeMock.mock.restore();
      addMock.mock.restore();
      getMock.mock.restore();
    }
  });

  it('removes blocked when ready is already present', () => {
    const getMock = mock.method(prStateLabels.prStateLabelDeps, 'getPullRequest', () =>
      buildPullRequest([prStateLabels.WM_LABELS.ready, prStateLabels.WM_LABELS.blocked]),
    );
    const addMock = mock.method(prStateLabels.prStateLabelDeps, 'addLabelsToPullRequest', () => {
      throw new Error('should not add existing ready label');
    });
    const removeMock = mock.method(prStateLabels.prStateLabelDeps, 'removeLabelFromPullRequest', () =>
      buildPullRequest([prStateLabels.WM_LABELS.ready]),
    );

    try {
      const result = prStateLabels.setWavemillReady(229);
      assert.deepEqual(result.labels.map((label) => label.name), [prStateLabels.WM_LABELS.ready]);
      assert.equal(getMock.mock.callCount(), 1);
      assert.equal(addMock.mock.callCount(), 0);
      assert.deepEqual(removeMock.mock.calls[0]?.arguments, [229, prStateLabels.WM_LABELS.blocked, {}]);
    } finally {
      removeMock.mock.restore();
      addMock.mock.restore();
      getMock.mock.restore();
    }
  });

  it('does not attempt to remove missing conflicting labels', () => {
    const getMock = mock.method(prStateLabels.prStateLabelDeps, 'getPullRequest', () =>
      buildPullRequest([]),
    );
    const addMock = mock.method(prStateLabels.prStateLabelDeps, 'addLabelsToPullRequest', () =>
      buildPullRequest([prStateLabels.WM_LABELS.ready]),
    );
    const removeMock = mock.method(prStateLabels.prStateLabelDeps, 'removeLabelFromPullRequest', () => {
      throw new Error('should not remove missing labels');
    });

    try {
      prStateLabels.setWavemillReady(229);
      assert.equal(getMock.mock.callCount(), 1);
      assert.equal(addMock.mock.callCount(), 1);
      assert.equal(removeMock.mock.callCount(), 0);
    } finally {
      removeMock.mock.restore();
      addMock.mock.restore();
      getMock.mock.restore();
    }
  });
});

describe('setWavemillMerged', () => {
  it('adds merged and clears active states', () => {
    const getMock = mock.method(prStateLabels.prStateLabelDeps, 'getPullRequest', () =>
      buildPullRequest([
        prStateLabels.WM_LABELS.ready,
        prStateLabels.WM_LABELS.blocked,
        prStateLabels.WM_LABELS.merging,
      ]),
    );
    const addMock = mock.method(prStateLabels.prStateLabelDeps, 'addLabelsToPullRequest', () =>
      buildPullRequest([prStateLabels.WM_LABELS.merged]),
    );
    const removed: string[] = [];
    const removeMock = mock.method(prStateLabels.prStateLabelDeps, 'removeLabelFromPullRequest', (_prNumber: number | string, label: string) => {
      removed.push(label);
      return buildPullRequest([prStateLabels.WM_LABELS.merged]);
    });

    try {
      const result = prStateLabels.setWavemillMerged(229);
      assert.equal(result.labels[0]?.name, prStateLabels.WM_LABELS.merged);
      assert.equal(getMock.mock.callCount(), 1);
      assert.equal(addMock.mock.callCount(), 1);
      assert.deepEqual(removed, [
        prStateLabels.WM_LABELS.ready,
        prStateLabels.WM_LABELS.blocked,
        prStateLabels.WM_LABELS.merging,
      ]);
      assert.equal(removeMock.mock.callCount(), 3);
    } finally {
      removeMock.mock.restore();
      addMock.mock.restore();
      getMock.mock.restore();
    }
  });
});

describe('setMergeLabel (HOK-3449: the reconciler changes only wm:ready / wm:blocked)', () => {
  function stubLabels(initial: string[]) {
    const labels = [...initial];
    const removed: string[] = [];
    const added: string[][] = [];
    const current = () => buildPullRequest(labels);
    const getMock = mock.method(prStateLabels.prStateLabelDeps, 'getPullRequest', current);
    const addMock = mock.method(prStateLabels.prStateLabelDeps, 'addLabelsToPullRequest', (
      _prNumber: number | string,
      names: string[],
    ) => {
      added.push(names);
      labels.push(...names);
      return current();
    });
    const removeMock = mock.method(prStateLabels.prStateLabelDeps, 'removeLabelFromPullRequest', (
      _prNumber: number | string,
      label: string,
    ) => {
      removed.push(label);
      labels.splice(labels.indexOf(label), 1);
      return current();
    });
    return { labels, removed, added, getMock, addMock, removeMock };
  }

  it('a null decision removes only wm:ready, leaving wavemill and operator labels', () => {
    const stub = stubLabels([
      prStateLabels.WM_LABELS.wavemill,
      prStateLabels.WM_LABELS.riskAcknowledged,
      prStateLabels.WM_LABELS.approved,
      prStateLabels.WM_LABELS.ready,
    ]);

    try {
      const result = prStateLabels.setMergeLabel(229, null);
      assert.equal(result.written, true);
      assert.deepEqual(stub.removed, [prStateLabels.WM_LABELS.ready]);
      assert.deepEqual(stub.added, []);
      assert.deepEqual(stub.labels, [
        prStateLabels.WM_LABELS.wavemill,
        prStateLabels.WM_LABELS.riskAcknowledged,
        prStateLabels.WM_LABELS.approved,
      ]);
    } finally {
      mock.restoreAll();
    }
  });

  it('wm:blocked removes only wm:ready and adds wm:blocked', () => {
    const stub = stubLabels([
      prStateLabels.WM_LABELS.wavemill,
      prStateLabels.WM_LABELS.risky,
      prStateLabels.WM_LABELS.ready,
    ]);

    try {
      const result = prStateLabels.setMergeLabel(229, prStateLabels.WM_LABELS.blocked);
      assert.equal(result.written, true);
      assert.deepEqual(stub.removed, [prStateLabels.WM_LABELS.ready]);
      assert.deepEqual(stub.added, [[prStateLabels.WM_LABELS.blocked]]);
      assert.deepEqual(stub.labels, [
        prStateLabels.WM_LABELS.wavemill,
        prStateLabels.WM_LABELS.risky,
        prStateLabels.WM_LABELS.blocked,
      ]);
    } finally {
      mock.restoreAll();
    }
  });

  it('is a no-op when the PR already carries the decided label', () => {
    const stub = stubLabels([prStateLabels.WM_LABELS.ready]);

    try {
      const result = prStateLabels.setMergeLabel(229, prStateLabels.WM_LABELS.ready);
      assert.equal(result.written, false);
      assert.deepEqual(stub.removed, []);
      assert.deepEqual(stub.added, []);
      assert.equal(stub.getMock.mock.callCount(), 1);
    } finally {
      mock.restoreAll();
    }
  });

  for (const label of [prStateLabels.WM_LABELS.ready, prStateLabels.WM_LABELS.blocked, null] as const) {
    it(`writes nothing while wm:merging is held (decision ${label ?? 'null'})`, () => {
      const stub = stubLabels([
        prStateLabels.WM_LABELS.wavemill,
        prStateLabels.WM_LABELS.ready,
        prStateLabels.WM_LABELS.merging,
      ]);

      try {
        const result = prStateLabels.setMergeLabel(229, label);
        assert.equal(result.written, false);
        assert.equal(result.skipped, 'merge-lane-lock');
        assert.deepEqual(stub.removed, []);
        assert.deepEqual(stub.added, []);
      } finally {
        mock.restoreAll();
      }
    });
  }
});

describe('no pr-label marker (HOK-3316)', () => {
  it('label writes leave no .wavemill/pr-state sidecar behind', () => {
    const markerRoot = mkdtempSync(join(tmpdir(), 'wavemill-pr-marker-'));
    mock.method(prStateLabels.prStateLabelDeps, 'getPullRequest', () => buildPullRequest([]));
    mock.method(prStateLabels.prStateLabelDeps, 'addLabelsToPullRequest', () =>
      buildPullRequest([prStateLabels.WM_LABELS.blocked]));
    try {
      const { pr } = prStateLabels.setMergeLabel(229, prStateLabels.WM_LABELS.blocked, { markerRoot });
      assert.deepEqual(pr.labels, [{ name: prStateLabels.WM_LABELS.blocked }]);
      assert.equal(existsSync(join(markerRoot, '.wavemill', 'pr-state')), false);
      assert.equal('writePrStateMarker' in prStateLabels, false);
      assert.equal('readPrStateMarker' in prStateLabels, false);
    } finally {
      rmSync(markerRoot, { recursive: true, force: true });
    }
  });
});
