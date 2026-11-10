/**
 * Tests for the branch-publication preflight (HOK-2914).
 *
 * Uses a real temporary repository with a bare `origin` — in-memory GitHub
 * fixtures cannot detect a missing remote ref, which is the exact defect this
 * helper exists to prevent.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import os from 'node:os';

import {
  openTaskPullRequest,
  publishReviewedBranch,
  publishStageHead,
  resolveTaskPullRequestContent,
  translateGitHubHeadError,
} from './branch-publication.ts';
import { createFixtureBackedGithubDeps } from './native-agent/workflow-tools/fixtures/github-mock.ts';
import { readHeadMoves } from './head-move-record.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeAndCommit(repo: string, fileName: string, content: string, message: string): string {
  writeFileSync(join(repo, fileName), content, 'utf-8');
  git(repo, ['add', fileName]);
  git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

interface Fixture {
  tmpDir: string;
  repoDir: string;
  remoteDir: string;
  baseSha: string;
  headSha: string;
}

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function createFixture(): Fixture {
  const tmpDir = mkdtempSync(join(os.tmpdir(), 'branch-publication-'));
  tempDirs.push(tmpDir);
  const remoteDir = join(tmpDir, 'origin.git');
  const repoDir = join(tmpDir, 'work');

  execFileSync('git', ['init', '--bare', remoteDir], { encoding: 'utf-8' });
  execFileSync('git', ['init', repoDir], { encoding: 'utf-8' });
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Branch Publication Test']);
  git(repoDir, ['remote', 'add', 'origin', remoteDir]);

  writeAndCommit(repoDir, 'base.txt', 'base\n', 'base');
  git(repoDir, ['branch', '-M', 'auto/integration']);
  const baseSha = git(repoDir, ['rev-parse', 'HEAD']);
  git(repoDir, ['push', '-u', 'origin', 'auto/integration']);

  git(repoDir, ['switch', '-c', 'task/test']);
  const headSha = writeAndCommit(repoDir, 'feature.txt', 'feature\n', 'feature');

  return { tmpDir, repoDir, remoteDir, baseSha, headSha };
}

function remoteBranchSha(repoDir: string, branch: string): string | null {
  const output = git(repoDir, ['ls-remote', 'origin', `refs/heads/${branch}`]);
  return output ? output.split(/\s+/)[0] : null;
}

describe('publishReviewedBranch', () => {
  it('publishes an absent remote head and verifies the exact reviewed SHA', () => {
    const fixture = createFixture();
    assert.equal(remoteBranchSha(fixture.repoDir, 'task/test'), null);

    const result = publishReviewedBranch({
      worktreeDir: fixture.repoDir,
      branch: 'task/test',
      reviewedSha: fixture.headSha,
      baseBranch: 'auto/integration',
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.outcome, 'pushed');
    assert.equal(result.ok && result.remoteSha, fixture.headSha);
    assert.equal(remoteBranchSha(fixture.repoDir, 'task/test'), fixture.headSha);
  });

  it('reuses a matching remote head idempotently without pushing again', () => {
    const fixture = createFixture();
    git(fixture.repoDir, ['push', 'origin', 'task/test']);

    const result = publishReviewedBranch({
      worktreeDir: fixture.repoDir,
      branch: 'task/test',
      reviewedSha: fixture.headSha,
      baseBranch: 'auto/integration',
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.outcome, 'reused');
    assert.equal(result.ok && result.remoteSha, fixture.headSha);
  });

  it('fast-forwards a remote branch that is an ancestor of the reviewed SHA (HOK-3370)', () => {
    // protects: agent pushed an earlier head, reviewer committed on top and
    // did not push — the mill must publish the reviewed head, never refuse
    // (HOK-3361 operator touch #3).
    const fixture = createFixture();
    git(fixture.repoDir, ['push', 'origin', `${fixture.baseSha}:refs/heads/task/test`]);

    const result = publishReviewedBranch({
      worktreeDir: fixture.repoDir,
      branch: 'task/test',
      reviewedSha: fixture.headSha,
      baseBranch: 'auto/integration',
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.outcome, 'pushed');
    assert.equal(remoteBranchSha(fixture.repoDir, 'task/test'), fixture.headSha);
  });

  it('rejects a remote branch that genuinely diverged from the reviewed SHA', () => {
    // protects: a rewritten/foreign remote head is never overwritten by the
    // seam — divergence stays a typed failure, not a force push.
    const fixture = createFixture();
    // Build a sibling commit (same parent, different content) and park it on
    // the remote under the task branch name.
    git(fixture.repoDir, ['switch', '-c', 'task/divergent', fixture.baseSha]);
    const divergentSha = writeAndCommit(fixture.repoDir, 'other.txt', 'other\n', 'divergent work');
    git(fixture.repoDir, ['push', 'origin', `${divergentSha}:refs/heads/task/test`]);
    git(fixture.repoDir, ['switch', 'task/test']);

    const result = publishReviewedBranch({
      worktreeDir: fixture.repoDir,
      branch: 'task/test',
      reviewedSha: fixture.headSha,
      baseBranch: 'auto/integration',
    });

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'remote-divergence');
    assert.equal(!result.ok && result.remoteSha, divergentSha);
    // The remote ref was not overwritten.
    assert.equal(remoteBranchSha(fixture.repoDir, 'task/test'), divergentSha);
    assert.match(!result.ok ? result.recoveryCommand : '', /git .*push/);
  });

  it('rejects a stale reviewed SHA when the local branch has moved after review', () => {
    const fixture = createFixture();
    const movedSha = writeAndCommit(fixture.repoDir, 'unreviewed.txt', 'unreviewed\n', 'unreviewed work');

    const result = publishReviewedBranch({
      worktreeDir: fixture.repoDir,
      branch: 'task/test',
      reviewedSha: fixture.headSha,
      baseBranch: 'auto/integration',
    });

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'stale-reviewed-sha');
    assert.equal(!result.ok && result.localSha, movedSha);
    // Nothing was published.
    assert.equal(remoteBranchSha(fixture.repoDir, 'task/test'), null);
  });

  it('reports a missing local branch distinctly', () => {
    const fixture = createFixture();
    const result = publishReviewedBranch({
      worktreeDir: fixture.repoDir,
      branch: 'task/does-not-exist',
      reviewedSha: fixture.headSha,
    });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'local-ref-missing');
  });

  it('reports no-commits-ahead-of-base distinctly from an unpushed branch', () => {
    const fixture = createFixture();
    // A branch pointing at the base tip has nothing to open a PR for.
    git(fixture.repoDir, ['branch', 'task/empty', fixture.baseSha]);

    const result = publishReviewedBranch({
      worktreeDir: fixture.repoDir,
      branch: 'task/empty',
      reviewedSha: fixture.baseSha,
      baseBranch: 'auto/integration',
    });

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'no-commits-ahead-of-base');
    // Nothing was published.
    assert.equal(remoteBranchSha(fixture.repoDir, 'task/empty'), null);
  });

  it('reports a failed push distinctly and does not fabricate a proof', () => {
    const fixture = createFixture();
    // ls-remote uses the fetch URL; pushes use pushurl, so pointing pushurl at
    // a nonexistent path fails only the push step.
    git(fixture.repoDir, ['remote', 'set-url', '--push', 'origin', join(fixture.tmpDir, 'missing.git')]);

    const result = publishReviewedBranch({
      worktreeDir: fixture.repoDir,
      branch: 'task/test',
      reviewedSha: fixture.headSha,
      baseBranch: 'auto/integration',
    });

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'push-failed');
    assert.equal(remoteBranchSha(fixture.repoDir, 'task/test'), null);
  });
});

describe('publishStageHead', () => {
  function stateDirFor(fixture: Fixture): string {
    return join(fixture.tmpDir, 'state');
  }

  it('publishes an unpushed local head and appends one head-move row', () => {
    // protects: a stage exit with commits the agent never pushed (HOK-3361
    // operator touch #1 — remediation commit never pushed).
    const fixture = createFixture();
    const stateDir = stateDirFor(fixture);

    const result = publishStageHead({
      worktreeDir: fixture.repoDir,
      branch: 'task/test',
      stateDir,
      issue: 'HOK-0001',
      stage: 'coding',
      actor: 'mill',
      kind: 'coding',
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.outcome, 'pushed');
    assert.equal(remoteBranchSha(fixture.repoDir, 'task/test'), fixture.headSha);
    const rows = readHeadMoves(stateDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].to, fixture.headSha);
    assert.equal(rows[0].from, null); // first publication — no prior remote head
    assert.equal(rows[0].stage, 'coding');
    assert.equal(rows[0].actor, 'mill');
    assert.equal(rows[0].kind, 'coding');
    assert.equal(rows[0].issue, 'HOK-0001');
  });

  it('fast-forwards a remote at an ancestor and records from/to with a commit count', () => {
    const fixture = createFixture();
    const stateDir = stateDirFor(fixture);
    git(fixture.repoDir, ['push', 'origin', `${fixture.baseSha}:refs/heads/task/test`]);
    const newHead = writeAndCommit(fixture.repoDir, 'fix.txt', 'fix\n', 'review fix');

    const result = publishStageHead({
      worktreeDir: fixture.repoDir,
      branch: 'task/test',
      stateDir,
      issue: 'HOK-0001',
      stage: 'review',
      actor: 'mill',
      kind: 'review-fix',
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.outcome, 'pushed');
    assert.equal(remoteBranchSha(fixture.repoDir, 'task/test'), newHead);
    const rows = readHeadMoves(stateDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].from, fixture.baseSha);
    assert.equal(rows[0].to, newHead);
    assert.equal(rows[0].commits, 2); // feature + review fix
  });

  it('reuses a matching remote without a duplicate row for the same head', () => {
    // protects: a stage exit where nothing moved (reviewer did not commit)
    // appends nothing — the record stays one row per head.
    const fixture = createFixture();
    const stateDir = stateDirFor(fixture);
    const first = publishStageHead({
      worktreeDir: fixture.repoDir,
      branch: 'task/test',
      stateDir,
      issue: 'HOK-0001',
      stage: 'coding',
      actor: 'mill',
      kind: 'coding',
    });
    assert.equal(first.ok, true);

    const second = publishStageHead({
      worktreeDir: fixture.repoDir,
      branch: 'task/test',
      stateDir,
      issue: 'HOK-0001',
      stage: 'review',
      actor: 'mill',
      kind: 'review-fix',
    });

    assert.equal(second.ok, true);
    assert.equal(second.ok && second.outcome, 'reused');
    assert.equal(second.ok && second.headMove, null);
    assert.equal(readHeadMoves(stateDir).length, 1);
  });

  it('records an agent-pushed head on reuse (new head, no mill push)', () => {
    // protects: when the agent (or gh pr create) already pushed, the move is
    // still recorded — authorship data never depends on who pushed.
    const fixture = createFixture();
    const stateDir = stateDirFor(fixture);
    git(fixture.repoDir, ['push', 'origin', 'task/test']);

    const result = publishStageHead({
      worktreeDir: fixture.repoDir,
      branch: 'task/test',
      stateDir,
      issue: 'HOK-0001',
      stage: 'coding',
      actor: 'mill',
      kind: 'coding',
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.outcome, 'reused');
    const rows = readHeadMoves(stateDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].to, fixture.headSha);
  });

  it('reports remote-ahead without pushing or recording when all local commits are on the remote', () => {
    const fixture = createFixture();
    const stateDir = stateDirFor(fixture);
    git(fixture.repoDir, ['push', 'origin', 'task/test']);
    // Remote moves further ahead (as after a tend rebase/push from scratch).
    const aheadSha = writeAndCommit(fixture.repoDir, 'ahead.txt', 'ahead\n', 'remote-side commit');
    git(fixture.repoDir, ['push', 'origin', 'task/test']);
    git(fixture.repoDir, ['reset', '--hard', fixture.headSha]);

    const result = publishStageHead({
      worktreeDir: fixture.repoDir,
      branch: 'task/test',
      stateDir,
      issue: 'HOK-0001',
      stage: 'ready',
      actor: 'mill',
      kind: 'remediation',
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.outcome, 'remote-ahead');
    assert.equal(remoteBranchSha(fixture.repoDir, 'task/test'), aheadSha);
    assert.equal(readHeadMoves(stateDir).length, 0);
  });

  it('fails typed on genuine divergence and never overwrites the remote', () => {
    const fixture = createFixture();
    const stateDir = stateDirFor(fixture);
    git(fixture.repoDir, ['switch', '-c', 'task/divergent', fixture.baseSha]);
    const divergentSha = writeAndCommit(fixture.repoDir, 'other.txt', 'other\n', 'divergent work');
    git(fixture.repoDir, ['push', 'origin', `${divergentSha}:refs/heads/task/test`]);
    git(fixture.repoDir, ['switch', 'task/test']);

    const result = publishStageHead({
      worktreeDir: fixture.repoDir,
      branch: 'task/test',
      stateDir,
      issue: 'HOK-0001',
      stage: 'ready',
      actor: 'mill',
      kind: 'conflict',
    });

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'remote-divergence');
    assert.equal(remoteBranchSha(fixture.repoDir, 'task/test'), divergentSha);
    assert.equal(readHeadMoves(stateDir).length, 0);
  });

  it('refuses to publish when the local head is not the expected stage head', () => {
    const fixture = createFixture();
    const stateDir = stateDirFor(fixture);
    const movedSha = writeAndCommit(fixture.repoDir, 'extra.txt', 'extra\n', 'post-stage commit');

    const result = publishStageHead({
      worktreeDir: fixture.repoDir,
      branch: 'task/test',
      expectedSha: fixture.headSha,
      stateDir,
      issue: 'HOK-0001',
      stage: 'review',
      actor: 'mill',
      kind: 'review-fix',
    });

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'stale-reviewed-sha');
    assert.equal(!result.ok && result.localSha, movedSha);
    assert.equal(readHeadMoves(stateDir).length, 0);
  });
});

describe('translateGitHubHeadError', () => {
  it('translates the unresolvable-head GraphQL error into a branch-not-pushed diagnostic', () => {
    const translated = translateGitHubHeadError(
      "GraphQL: Head sha can't be blank, Base sha can't be blank, No commits between main and task/x, Head ref must be a branch (createPullRequest)",
    );
    assert.ok(translated);
    assert.match(translated!, /never pushed to origin/);
  });

  it('leaves other GitHub errors untouched', () => {
    assert.equal(translateGitHubHeadError('GraphQL: something else went wrong'), null);
  });
});

describe('openTaskPullRequest (HOK-3463)', () => {
  const REPO = 'acme/widgets';

  function open(fixture: Fixture, github: ReturnType<typeof createFixtureBackedGithubDeps>, stateDir?: string) {
    return openTaskPullRequest({
      worktreeDir: fixture.repoDir,
      branch: 'task/test',
      base: 'auto/integration',
      repo: REPO,
      stateDir,
      issue: 'HOK-1',
      title: 'HOK-1: add feature',
      body: 'body',
      githubDeps: github.deps,
    });
  }

  // protects: finished review work with an unpublished head and no PR (the HOK-3424 incident)
  it('publishes the unpushed head and creates the PR at that head', async () => {
    const fixture = createFixture();
    const stateDir = join(fixture.tmpDir, 'state');
    mkdirSync(stateDir);
    const github = createFixtureBackedGithubDeps();
    assert.equal(remoteBranchSha(fixture.repoDir, 'task/test'), null);

    const result = await open(fixture, github, stateDir);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.outcome, 'created');
    assert.equal(result.headSha, fixture.headSha);
    assert.equal(result.publication, 'pushed');
    assert.equal(remoteBranchSha(fixture.repoDir, 'task/test'), fixture.headSha);
    assert.deepEqual(
      github.state.pullRequests.map((pr) => [pr.head, pr.base, pr.title]),
      [['task/test', 'auto/integration', 'HOK-1: add feature']],
    );
    assert.deepEqual(readHeadMoves(stateDir).map((row) => [row.stage, row.kind]), [['review', 'review-fix']]);
  });

  // protects: a second tick opening a duplicate PR, or overwriting a body the mill already stamped
  it('reuses an existing open PR without touching its title or body', async () => {
    const fixture = createFixture();
    const github = createFixtureBackedGithubDeps({
      pullRequests: [{
        number: 7,
        title: 'existing title',
        body: 'stamped body',
        head: 'task/test',
        base: 'auto/integration',
        url: `https://github.com/${REPO}/pull/7`,
      }],
    });

    const result = await open(fixture, github);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.outcome, 'reused');
    assert.equal(result.number, 7);
    assert.equal(github.state.calls.createPullRequest, 0);
    assert.equal(github.state.calls.updatePullRequest, 0);
    assert.equal(github.state.pullRequests[0].body, 'stamped body');
  });

  // protects: a GitHub or credential failure being charged to the reviewer model or thrown into the monitor
  it('reports a failed PR open as a typed harness fault after publishing the head', async () => {
    const fixture = createFixture();
    const github = createFixtureBackedGithubDeps({
      failCreatePullRequest: [new Error('gh: To get started with GitHub CLI, please run: gh auth login')],
      maxAttempts: 1,
    });

    const result = await open(fixture, github);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'pr-open-failed');
    assert.equal(result.faultClass, 'harness-fault');
    assert.match(result.message, /gh auth login/);
    // The head is published even though the PR open failed, so a retry only needs GitHub.
    assert.equal(remoteBranchSha(fixture.repoDir, 'task/test'), fixture.headSha);
  });
});

describe('resolveTaskPullRequestContent (HOK-3463)', () => {
  function stateDirWith(artifacts: unknown): string {
    const dir = mkdtempSync(join(os.tmpdir(), 'task-pr-content-'));
    tempDirs.push(dir);
    if (artifacts !== undefined) {
      writeFileSync(join(dir, '.review-result.json'), JSON.stringify({ stage: 'review', status: 'completed', artifacts }));
    }
    return dir;
  }

  // protects: the PR losing the description the review agent wrote, or its task metadata block
  it('uses the recorded title and body and appends the task metadata block once', async () => {
    const stateDir = stateDirWith({ prTitle: 'HOK-9: tidy things', prBody: '## Summary\n- tidied', prDraft: true });
    const content = await resolveTaskPullRequestContent({ stateDir, issue: 'HOK-9' });
    assert.equal(content.title, 'HOK-9: tidy things');
    assert.equal(content.body, '## Summary\n- tidied\n\n<!-- wavemill-meta\ntask: HOK-9\n-->');
    assert.equal(content.draft, true);
    assert.equal(content.source, 'review-artifacts');

    const already = stateDirWith({ prTitle: 'HOK-9: x', prBody: 'b\n<!-- wavemill-meta\ntask: HOK-9\n-->' });
    assert.equal((await resolveTaskPullRequestContent({ stateDir: already, issue: 'HOK-9' })).body.match(/wavemill-meta/g)?.length, 1);
  });

  // protects: a review that recorded no description (or an unreadable result) blocking the PR
  it('falls back to the task title when the review recorded no description', async () => {
    for (const stateDir of [stateDirWith({ verdict: 'ready' }), stateDirWith(undefined)]) {
      const content = await resolveTaskPullRequestContent({ stateDir, issue: 'HOK-9', fallbackTitle: 'Tidy things' });
      assert.equal(content.title, 'HOK-9: Tidy things');
      assert.match(content.body, /Tidy things/);
      assert.match(content.body, /wavemill-meta\ntask: HOK-9/);
      assert.equal(content.draft, false);
      assert.equal(content.source, 'fallback');
    }
  });
});
