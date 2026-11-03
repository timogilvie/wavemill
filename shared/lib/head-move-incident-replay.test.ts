/**
 * HOK-3361 incident replay (HOK-3370, REQ-F5): the three head scenarios that
 * each cost an operator touch, exercised deterministically against the
 * publication seam and the freshness primitive on real temp repositories.
 *
 * 1. Remediation commit never pushed — Ready re-checked the same red head 4×
 *    and exhausted. Now: the seam publishes it; zero operator touches.
 * 2. Mill moved the head (update-from-base) and staled the review by raw
 *    SHA; nothing re-ran review. Now: a base merge keeps the change
 *    identity, so review evidence stays fresh — no re-review, no touch.
 * 3. Reviewer committed and didn't push — Ready refused "unpushed local
 *    work". Now: the seam fast-forwards the published ancestor; the
 *    code-changing move stales review evidence so review re-runs through
 *    the stage path instead of parking.
 *
 * Evidence: .wavemill/evals/artifacts/HOK-3361/incident-2026-10-31/ (incident
 * 042069c5ffdd…, linked in tests/fixtures/incident-replay/real/inspection_required.json).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import os from 'node:os';

import { publishStageHead } from './branch-publication.ts';
import { isEvidenceFresh } from './change-identity.ts';
import { readHeadMoves, summarizeHeadMovesByStage } from './head-move-record.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function writeAndCommit(repo: string, fileName: string, content: string, message: string): string {
  writeFileSync(join(repo, fileName), content, 'utf-8');
  git(repo, ['add', fileName]);
  git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

let tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

interface Incident {
  repoDir: string;
  remoteDir: string;
  stateDir: string;
  baseSha: string;
  /** The red head the PR sat on (CI failing), pushed to origin. */
  redHead: string;
}

/** A task branch at a pushed (red) head, like PR #1749 before the touches. */
function createIncidentFixture(): Incident {
  const tmpDir = mkdtempSync(join(os.tmpdir(), 'hok3361-replay-'));
  tempDirs.push(tmpDir);
  const remoteDir = join(tmpDir, 'origin.git');
  const repoDir = join(tmpDir, 'work');
  const stateDir = join(tmpDir, 'state');
  execFileSync('git', ['init', '--bare', remoteDir], { encoding: 'utf-8' });
  execFileSync('git', ['init', repoDir], { encoding: 'utf-8' });
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'HOK-3361 Replay']);
  git(repoDir, ['remote', 'add', 'origin', remoteDir]);
  writeAndCommit(repoDir, 'base.txt', 'base\n', 'base');
  git(repoDir, ['branch', '-M', 'auto/integration']);
  const baseSha = git(repoDir, ['rev-parse', 'HEAD']);
  git(repoDir, ['push', '-u', 'origin', 'auto/integration']);
  git(repoDir, ['switch', '-c', 'task/hok-3361-c']);
  const redHead = writeAndCommit(repoDir, 'feature.txt', 'red implementation\n', 'feat: classifier cell');
  git(repoDir, ['push', '-u', 'origin', 'task/hok-3361-c']);
  return { repoDir, remoteDir, stateDir, baseSha, redHead };
}

function remoteHead(repoDir: string): string | null {
  const output = git(repoDir, ['ls-remote', 'origin', 'refs/heads/task/hok-3361-c']);
  return output ? output.split(/\s+/)[0] : null;
}

describe('HOK-3361 replay — touch #1: remediation commit never pushed', () => {
  it('publishes the unpushed remediation commit so Ready re-checks the fixed head, not the red one', () => {
    // protects: Ready exhausted 4 re-checks of the same red head because the
    // remediation agent committed 4ea98a06 and never pushed.
    const f = createIncidentFixture();
    const fixedHead = writeAndCommit(f.repoDir, 'feature.txt', 'fixed implementation\n', 'fix: Resolve ready-check failure (attempt 1/3)');
    assert.equal(remoteHead(f.repoDir), f.redHead); // the incident state

    const result = publishStageHead({
      worktreeDir: f.repoDir,
      branch: 'task/hok-3361-c',
      stateDir: f.stateDir,
      issue: 'HOK-3361_c',
      stage: 'ready',
      actor: 'mill',
      kind: 'remediation',
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.outcome, 'pushed');
    // Ready's next check reads the remediated head — zero operator touches.
    assert.equal(remoteHead(f.repoDir), fixedHead);
    const rows = readHeadMoves(f.stateDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'remediation');
    assert.equal(rows[0].from, f.redHead);
    assert.equal(rows[0].to, fixedHead);
    // The remediation commit is a code-changing move: review evidence at the
    // red head is stale and review re-runs through the stage path.
    const freshness = isEvidenceFresh({
      gitDir: f.repoDir,
      evidenceHeadSha: f.redHead,
      currentHeadSha: fixedHead,
      baseRef: 'origin/auto/integration',
    });
    assert.deepEqual(freshness, { fresh: false, reason: 'change-identity-differs' });
  });
});

describe('HOK-3361 replay — touch #2: mill base merge staled the review', () => {
  it('keeps review evidence fresh across the update-from-base merge — no re-review, no touch', () => {
    // protects: the HOK-3092 update-from-base pushed d8a96fc and the route
    // stamp failed `reviewer: stage_result_stale_head`; nothing re-ran a
    // review and the operator had to `re-review` by hand.
    const f = createIncidentFixture();
    const reviewedHead = f.redHead; // review evidence recorded here

    // Base advances with unrelated work; the mill merges it into the branch.
    git(f.repoDir, ['switch', 'auto/integration']);
    writeAndCommit(f.repoDir, 'other.txt', 'unrelated base work\n', 'base advances');
    git(f.repoDir, ['push', 'origin', 'auto/integration']);
    git(f.repoDir, ['switch', 'task/hok-3361-c']);
    git(f.repoDir, ['fetch', 'origin', 'auto/integration']);
    git(f.repoDir, ['merge', '--no-edit', 'origin/auto/integration']);
    const mergedHead = git(f.repoDir, ['rev-parse', 'HEAD']);
    assert.notEqual(mergedHead, reviewedHead);

    const freshness = isEvidenceFresh({
      gitDir: f.repoDir,
      evidenceHeadSha: reviewedHead,
      currentHeadSha: mergedHead,
      baseRef: 'origin/auto/integration',
    });
    assert.equal(freshness.fresh, true);
    assert.equal(freshness.reason, 'same-change-identity');

    // The seam publishes the merge as a base-merge move.
    const result = publishStageHead({
      worktreeDir: f.repoDir,
      branch: 'task/hok-3361-c',
      stateDir: f.stateDir,
      issue: 'HOK-3361_c',
      stage: 'ready',
      actor: 'mill',
      kind: 'base-merge',
    });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.outcome, 'pushed');
    assert.equal(readHeadMoves(f.stateDir)[0].kind, 'base-merge');
  });
});

describe('HOK-3361 replay — touch #3: reviewer committed and did not push', () => {
  it('fast-forwards the published branch over the reviewer commit and stales review evidence', () => {
    // protects: Ready refused "task worktree HEAD 28512ec has commits that
    // are not on PR head d8a96fc (unpushed local work)" and the operator had
    // to push by hand. The refusal branch is deleted; the seam publishes.
    const f = createIncidentFixture();
    const reviewerHead = writeAndCommit(f.repoDir, 'tools-backfill.txt', 'JSON.parse handling\n', 'fix: handle malformed JSON in backfill');

    const result = publishStageHead({
      worktreeDir: f.repoDir,
      branch: 'task/hok-3361-c',
      stateDir: f.stateDir,
      issue: 'HOK-3361_c',
      stage: 'review',
      actor: 'mill',
      kind: 'review-fix',
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.outcome, 'pushed');
    assert.equal(remoteHead(f.repoDir), reviewerHead);

    // The reviewer's commit is a code-changing move: the prior review is
    // stale and re-runs; the authorship is visible per stage.
    const freshness = isEvidenceFresh({
      gitDir: f.repoDir,
      evidenceHeadSha: f.redHead,
      currentHeadSha: reviewerHead,
      baseRef: 'origin/auto/integration',
    });
    assert.deepEqual(freshness, { fresh: false, reason: 'change-identity-differs' });

    const summary = summarizeHeadMovesByStage(readHeadMoves(f.stateDir));
    assert.deepEqual(summary.map((s) => s.stage), ['review']);
    assert.deepEqual(summary[0].kinds, ['review-fix']);
    assert.equal(summary[0].commits, 1);
  });
});
