/**
 * Branch publication preflight for native-review PR creation (HOK-2914).
 *
 * GitHub cannot open a pull request for a branch that was never pushed; it
 * rejects the create call with the misleading "Head sha can't be blank /
 * No commits between ..." error, which reads as though the arm produced no
 * work. This module proves — before any PR create call — that
 * `origin/<branch>` resolves to exactly the reviewed local SHA, publishing
 * the branch when it is absent and failing closed on any divergence.
 *
 * The proof binds (remote, branch, reviewed SHA). It never force-pushes and
 * never reconciles a conflicting remote ref.
 */

import { execFileSync } from 'node:child_process';
import { gitPushKey, shadowRecordSideEffect } from './side-effect-ledger.ts';

export interface BranchPublicationRequest {
  /** Task worktree containing the reviewed branch. */
  worktreeDir: string;
  /** Remote to publish to. Defaults to 'origin'. */
  remote?: string;
  /** Branch name (no refs/heads/ prefix). */
  branch: string;
  /** The exact SHA that was reviewed; publication is rejected if the local branch has moved. */
  reviewedSha: string;
  /**
   * Configured mill base branch. When provided, the preflight also asserts the
   * reviewed head has commits ahead of the base, so a genuinely empty branch is
   * reported distinctly from an unpublished one.
   */
  baseBranch?: string;
}

export type BranchPublicationFailureReason =
  | 'local-ref-missing'
  | 'stale-reviewed-sha'
  | 'no-commits-ahead-of-base'
  | 'remote-lookup-failed'
  | 'remote-divergence'
  | 'push-failed'
  | 'post-push-verification-failed';

export interface BranchPublicationSuccess {
  ok: true;
  /** 'pushed' when this call published the branch; 'reused' when the remote already matched. */
  outcome: 'pushed' | 'reused';
  remote: string;
  branch: string;
  localSha: string;
  remoteSha: string;
}

export interface BranchPublicationFailure {
  ok: false;
  reason: BranchPublicationFailureReason;
  message: string;
  remote: string;
  branch: string;
  localSha?: string;
  remoteSha?: string;
  /** Copyable operator command that recovers the stranded work. */
  recoveryCommand: string;
}

export type BranchPublicationResult = BranchPublicationSuccess | BranchPublicationFailure;

export type BranchPublicationExecutor = (
  request: BranchPublicationRequest,
) => Promise<BranchPublicationResult> | BranchPublicationResult;

function git(worktreeDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: worktreeDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function lookupRemoteSha(worktreeDir: string, remote: string, branch: string): string | null {
  const output = git(worktreeDir, ['ls-remote', remote, `refs/heads/${branch}`]);
  if (!output) {
    return null;
  }
  return output.split(/\s+/)[0] || null;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Match GitHub's misleading unpushed-branch PR-create error so callers can
 * surface the real diagnosis instead of "No commits between ...".
 */
export function translateGitHubHeadError(message: string): string | null {
  if (/head sha can't be blank|head ref must be a branch/i.test(message)) {
    return 'branch was never pushed to origin (GitHub cannot resolve the head ref); publish the branch and retry';
  }
  return null;
}

/**
 * Verify — and if necessary establish — that `<remote>/<branch>` resolves to
 * exactly `reviewedSha` before a PR is created for it.
 *
 * Fails closed: a missing/moved local ref, a diverged remote ref, or any push
 * or verification error blocks PR creation. A matching remote ref is reused
 * idempotently. Never force-pushes.
 */
export function publishReviewedBranch(request: BranchPublicationRequest): BranchPublicationResult {
  const remote = request.remote?.trim() || 'origin';
  const branch = request.branch;
  const reviewedSha = request.reviewedSha;
  const recoveryCommand = `git -C ${request.worktreeDir} push -u ${remote} ${branch}`;

  const fail = (
    reason: BranchPublicationFailureReason,
    message: string,
    extra: { localSha?: string; remoteSha?: string } = {},
  ): BranchPublicationFailure => ({
    ok: false,
    reason,
    message,
    remote,
    branch,
    recoveryCommand,
    ...extra,
  });

  // 1. The local branch must still name the exact SHA that was reviewed.
  let localSha: string;
  try {
    localSha = git(request.worktreeDir, ['rev-parse', '--verify', `refs/heads/${branch}`]);
  } catch (error) {
    return fail('local-ref-missing', `local branch ${branch} does not exist in ${request.worktreeDir}: ${errorMessage(error)}`);
  }
  if (localSha !== reviewedSha) {
    return fail(
      'stale-reviewed-sha',
      `local branch ${branch} is at ${localSha} but the reviewed SHA is ${reviewedSha}; refusing to publish unreviewed work`,
      { localSha },
    );
  }

  // 2. A branch with no commits ahead of the configured base is a distinct,
  //    actionable failure ("agent committed nothing"), not a publication bug.
  if (request.baseBranch) {
    const baseCandidates = [`refs/remotes/${remote}/${request.baseBranch}`, `refs/heads/${request.baseBranch}`];
    for (const baseRef of baseCandidates) {
      let count: string;
      try {
        count = git(request.worktreeDir, ['rev-list', '--count', `${baseRef}..${reviewedSha}`]);
      } catch {
        continue; // base ref not resolvable locally; try the next candidate
      }
      if (count === '0') {
        return fail(
          'no-commits-ahead-of-base',
          `branch ${branch} has no commits ahead of base ${request.baseBranch}; there is nothing to open a PR for`,
          { localSha },
        );
      }
      break;
    }
  }

  // 3. Read the authoritative remote ref.
  let remoteSha: string | null;
  try {
    remoteSha = lookupRemoteSha(request.worktreeDir, remote, branch);
  } catch (error) {
    return fail('remote-lookup-failed', `could not read ${remote} refs for ${branch}: ${errorMessage(error)}`, { localSha });
  }

  if (remoteSha === reviewedSha) {
    // HOK-3183 shadow: the publication is already in place — an observation,
    // never a duplicate push.
    shadowRecordSideEffect({
      kind: 'git-push',
      idempotencyKey: gitPushKey(remote, branch, reviewedSha),
      result: { outcome: 'reused', source: 'branch-publication' },
      observation: true,
      cwd: request.worktreeDir,
    });
    return { ok: true, outcome: 'reused', remote, branch, localSha, remoteSha };
  }
  if (remoteSha) {
    return fail(
      'remote-divergence',
      `${remote}/${branch} is at ${remoteSha} but the reviewed SHA is ${reviewedSha}; refusing to overwrite the remote branch`,
      { localSha, remoteSha },
    );
  }

  // 4. Absent remote ref: publish the exact reviewed SHA, non-force.
  try {
    git(request.worktreeDir, ['push', remote, `${reviewedSha}:refs/heads/${branch}`]);
  } catch (error) {
    return fail('push-failed', `push of ${branch} to ${remote} failed: ${errorMessage(error)}`, { localSha });
  }
  shadowRecordSideEffect({
    kind: 'git-push',
    idempotencyKey: gitPushKey(remote, branch, reviewedSha),
    result: { outcome: 'pushed', source: 'branch-publication' },
    cwd: request.worktreeDir,
  });

  // Upstream tracking is a convenience, never a correctness requirement.
  try {
    git(request.worktreeDir, ['branch', `--set-upstream-to=${remote}/${branch}`, branch]);
  } catch {
    // best-effort only
  }

  // 5. Re-verify: the proof requires the remote to resolve to the reviewed SHA.
  let verifiedSha: string | null;
  try {
    verifiedSha = lookupRemoteSha(request.worktreeDir, remote, branch);
  } catch (error) {
    return fail('post-push-verification-failed', `could not verify ${remote}/${branch} after push: ${errorMessage(error)}`, { localSha });
  }
  if (verifiedSha !== reviewedSha) {
    return fail(
      'post-push-verification-failed',
      `${remote}/${branch} resolved to ${verifiedSha ?? '(absent)'} after push instead of the reviewed SHA ${reviewedSha}`,
      { localSha, remoteSha: verifiedSha ?? undefined },
    );
  }

  return { ok: true, outcome: 'pushed', remote, branch, localSha, remoteSha: verifiedSha };
}
