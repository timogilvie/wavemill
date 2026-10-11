import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import * as github from './github.ts';

afterEach(() => {
  mock.restoreAll();
});

describe('addLabelsToPullRequest', () => {
  it('posts labels to the REST API and re-reads the pull request', () => {
    const execMock = mock.method(github.githubDeps, 'execShellCommand', () => '');
    const repoMock = mock.method(github.githubDeps, 'resolveOwnerRepo', () => 'acme/widgets');
    const prMock = mock.method(github.githubDeps, 'getPullRequest', () => ({
      number: 229,
      title: 'Fix label flow',
      body: '',
      state: 'OPEN',
      author: 'octocat',
      headRefName: 'task/label-fix',
      baseRefName: 'main',
      labels: [{ name: 'HOK-1305' }],
      url: 'https://github.com/acme/widgets/pull/229',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      mergedAt: null,
      closedAt: null,
    }));

    try {
      const result = github.addLabelsToPullRequest(229, ['HOK-1305', 'HOK-1305', 'needs review']);

      assert.equal(repoMock.mock.callCount(), 1);
      assert.equal(execMock.mock.callCount(), 1);
      const [command, options] = execMock.mock.calls[0].arguments as [string, { encoding: string }];
      assert.match(command, /repos\/acme\/widgets\/issues\/229\/labels/);
      assert.match(command, /printf '%s'/);
      assert.match(command, /HOK-1305/);
      assert.match(command, /needs review/);
      assert.deepEqual(options, { encoding: 'utf-8' });
      assert.equal(prMock.mock.callCount(), 1);
      assert.equal(result.labels.length, 1);
      assert.equal(result.labels[0].name, 'HOK-1305');
    } finally {
      prMock.mock.restore();
      repoMock.mock.restore();
      execMock.mock.restore();
    }
  });

  it('requires at least one non-empty label', () => {
    assert.throws(
      () => github.addLabelsToPullRequest(229, ['   '], { repo: 'acme/widgets' }),
      /Label name is required/
    );
  });

  it('throws a clear error when the repository cannot be resolved', () => {
    const repoMock = mock.method(github.githubDeps, 'resolveOwnerRepo', () => undefined);

    try {
      assert.throws(
        () => github.addLabelsToPullRequest(229, ['bug']),
        /Unable to determine GitHub repository/
      );
    } finally {
      repoMock.mock.restore();
    }
  });

  it('translates 404 responses into a not found error', () => {
    const execMock = mock.method(github.githubDeps, 'execShellCommand', () => {
      throw new Error('HTTP 404: Not Found');
    });

    try {
      assert.throws(
        () => github.addLabelsToPullRequest(229, ['bug'], { repo: 'acme/widgets' }),
        /Pull request #229 not found/
      );
    } finally {
      execMock.mock.restore();
    }
  });
});

describe('removeLabelFromPullRequest', () => {
  it('deletes a label via the REST API and encodes the label name', () => {
    const execMock = mock.method(github.githubDeps, 'execShellCommand', () => '');
    const prMock = mock.method(github.githubDeps, 'getPullRequest', () => ({
      number: 7,
      title: 'Cleanup',
      body: '',
      state: 'OPEN',
      author: 'octocat',
      headRefName: 'cleanup',
      baseRefName: 'main',
      labels: [],
      url: 'https://github.com/acme/widgets/pull/7',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      mergedAt: null,
      closedAt: null,
    }));

    try {
      github.removeLabelFromPullRequest(7, 'needs review', { repo: 'acme/widgets' });

      assert.equal(execMock.mock.callCount(), 1);
      const [command] = execMock.mock.calls[0].arguments as [string];
      assert.match(command, /DELETE/);
      assert.match(command, /needs%20review/);
      assert.equal(prMock.mock.callCount(), 1);
    } finally {
      prMock.mock.restore();
      execMock.mock.restore();
    }
  });

  it('treats a missing label as a no-op', () => {
    const execMock = mock.method(github.githubDeps, 'execShellCommand', () => {
      throw new Error('HTTP 404: label does not exist');
    });
    const prMock = mock.method(github.githubDeps, 'getPullRequest', () => ({
      number: 7,
      title: 'Cleanup',
      body: '',
      state: 'OPEN',
      author: 'octocat',
      headRefName: 'cleanup',
      baseRefName: 'main',
      labels: [],
      url: 'https://github.com/acme/widgets/pull/7',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      mergedAt: null,
      closedAt: null,
    }));

    try {
      const result = github.removeLabelFromPullRequest(7, 'missing', { repo: 'acme/widgets' });
      assert.equal(result.number, 7);
      assert.equal(execMock.mock.callCount(), 1);
      assert.equal(prMock.mock.callCount(), 1);
    } finally {
      prMock.mock.restore();
      execMock.mock.restore();
    }
  });
});

describe('mill label-write ledger hook (HOK-3182)', () => {
  const pr = {
    number: 7, title: 't', body: '', state: 'OPEN', author: 'octocat', headRefName: 'task/x', baseRefName: 'main',
    labels: [], url: 'https://github.com/acme/widgets/pull/7', createdAt: '', updatedAt: '', mergedAt: null, closedAt: null,
  };

  it('records successful adds and removes, but not failed writes', () => {
    mock.method(github.githubDeps, 'resolveOwnerRepo', () => 'acme/widgets');
    mock.method(github.githubDeps, 'getPullRequest', () => pr);
    const record = mock.method(github.githubDeps, 'recordLabelWrite', () => undefined);
    const exec = mock.method(github.githubDeps, 'execShellCommand', () => '');

    github.addLabelsToPullRequest(7, ['wm:ready']);
    github.removeLabelFromPullRequest(7, 'wm:blocked');
    assert.deepEqual(record.mock.calls.map((c) => c.arguments), [
      [7, ['wm:ready'], 'labeled'],
      [7, ['wm:blocked'], 'unlabeled'],
    ]);

    exec.mock.mockImplementation(() => { throw new Error('HTTP 500'); });
    assert.throws(() => github.addLabelsToPullRequest(7, ['wm:ready']));
    assert.equal(record.mock.callCount(), 2);
  });
});
