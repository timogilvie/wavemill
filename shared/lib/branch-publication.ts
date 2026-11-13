/**
 * The one branch-publication seam (HOK-3370, generalising HOK-2914).
 *
 * Agents commit; **the mill publishes**. `publishStageHead` is the single
 * path that moves a task branch's remote head at a stage exit: it verifies
 * the local ref, fast-forwards the remote (never force) and appends one
 * `head-move/v1` row (`head-move-record.ts`). A stage whose
 * commits cannot be published fails typed through `failure-policy.ts`; it
 * never leaves a silent local head.
 *
 * `openTaskPullRequest` (HOK-3463) is the one task-PR opener: at review exit
 * the mill publishes the head through `publishStageHead` and then opens the
 * PR through the idempotent `githubCreatePr`. The review agent supplies the
 * title and body in its stage result; it never runs `gh pr create`, so the
 * agent's GitHub credentials stop deciding whether finished work gets a PR.
 *
 * `publishReviewedBranch` (HOK-2914) remains as a strict preflight for
 * native-review PR creation: it proves `origin/<branch>` resolves to exactly
 * the reviewed SHA before a PR create call, failing closed on any
 * divergence. It never force-pushes and never reconciles a conflicting
 * remote ref.
 */

import { execFileSync } from 'node:child_process';
import { readStageResult } from './stage-result.ts';
import { githubCreatePr, type GitHubToolDeps } from './native-agent/workflow-tools/github.ts';
import {
  appendHeadMove,
  lastRecordedHead,
  type HeadMoveActor,
  type HeadMoveKind,
  type HeadMoveRow,
  type HeadMoveStage,
} from './head-move-record.ts';

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
  /**
   * Task state dir for the head-move record (HOK-3370). When provided with
   * `issue`, the publication appends a `head-move/v1` row.
   */
  stateDir?: string;
  /** Issue id recorded on the head-move row. */
  issue?: string;
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

  // 3. Delegate to the stage-exit seam (HOK-3370). The expected-SHA check is
  //    already proven above, so the seam's own check is a no-op re-assertion.
  //    A remote at an *ancestor* of the reviewed SHA fast-forwards (the agent
  //    pushed an earlier head and the reviewer committed on top — the
  //    HOK-3361 class); only genuine divergence fails closed.
  const result = publishStageHead({
    worktreeDir: request.worktreeDir,
    remote,
    branch,
    expectedSha: reviewedSha,
    stateDir: request.stateDir,
    issue: request.issue,
    stage: 'review',
    actor: 'mill',
    kind: 'review-fix',
  });
  if (!result.ok) return result;
  if (result.outcome === 'remote-ahead') {
    // The remote holds commits the review never covered: for PR creation this
    // is a divergence, never a proof.
    return fail(
      'remote-divergence',
      `${remote}/${branch} is at ${result.remoteSha} which is ahead of the reviewed SHA ${reviewedSha}; refusing to open a PR for unreviewed work`,
      { localSha, remoteSha: result.remoteSha },
    );
  }
  return { ok: true, outcome: result.outcome, remote, branch, localSha: result.localSha, remoteSha: result.remoteSha };
}

// ── Stage-exit publication seam (HOK-3370) ──────────────────────────────────

export interface StageHeadPublicationRequest {
  /** Task worktree containing the branch. */
  worktreeDir: string;
  /** Remote to publish to. Defaults to 'origin'. */
  remote?: string;
  /** Branch name (no refs/heads/ prefix). */
  branch: string;
  /**
   * When provided, the local branch must still name exactly this SHA;
   * publication is refused otherwise (the stage's evidence names a head the
   * branch no longer holds).
   */
  expectedSha?: string;
  /**
   * Task state dir the head-move row is appended to. Optional only for
   * callers with no state dir (pure preflight tests); the mill's stage-exit
   * call sites always pass it so every publication is recorded.
   */
  stateDir?: string;
  /** Issue id recorded on the row (challenger arms pass their `_c` id). */
  issue?: string;
  /** Stage whose exit this publication belongs to. */
  stage: HeadMoveStage;
  /** Who is publishing. The seam is the mill's path, so usually 'mill'. */
  actor: HeadMoveActor;
  /** Why the head moved. */
  kind: HeadMoveKind;
}

export type StageHeadPublicationOutcome =
  /** This call pushed the local head to the remote. */
  | 'pushed'
  /** The remote already held the local head (agent or a prior call pushed). */
  | 'reused'
  /**
   * Every local commit is already on the remote, which has moved further
   * ahead (e.g. tend rebased). Nothing to publish; the checkout lags and the
   * existing Ready sync path fast-forwards it.
   */
  | 'remote-ahead';

export interface StageHeadPublicationSuccess {
  ok: true;
  outcome: StageHeadPublicationOutcome;
  remote: string;
  branch: string;
  localSha: string;
  remoteSha: string;
  /** The appended record row; null when nothing new needed recording. */
  headMove: HeadMoveRow | null;
}

export type StageHeadPublicationResult = StageHeadPublicationSuccess | BranchPublicationFailure;

function countCommits(worktreeDir: string, from: string | null, to: string): number | undefined {
  if (!from) return undefined;
  try {
    const count = git(worktreeDir, ['rev-list', '--count', `${from}..${to}`]);
    const parsed = Number.parseInt(count, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined; // `from` unreachable locally — authorship treats absent as "at least one"
  }
}

/**
 * Publish a task branch's local head at a stage exit (HOK-3370).
 *
 * Flow: local-ref check → optional expected-SHA check → ls-remote →
 *   remote == local      → 'reused' observation (ledger) + record row when the
 *                          head is new to the record (the agent pushed);
 *   remote ∈ ancestors   → fast-forward push → verify → ledger + record row;
 *   local  ∈ ancestors   → 'remote-ahead', nothing to publish, no row;
 *   diverged             → 'remote-divergence' failure (typed; conflict-shaped,
 *                          flows to remediation via failure-policy.ts).
 *
 * Never force-pushes. Appends at most one `head-move/v1` row per new head.
 */
export function publishStageHead(request: StageHeadPublicationRequest): StageHeadPublicationResult {
  const remote = request.remote?.trim() || 'origin';
  const branch = request.branch;
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

  // 1. Resolve the local head to publish.
  let localSha: string;
  try {
    localSha = git(request.worktreeDir, ['rev-parse', '--verify', `refs/heads/${branch}`]);
  } catch (error) {
    return fail(
      'local-ref-missing',
      `local branch ${branch} does not exist in ${request.worktreeDir}: ${errorMessage(error)}`,
    );
  }
  if (request.expectedSha && localSha !== request.expectedSha) {
    return fail(
      'stale-reviewed-sha',
      `local branch ${branch} is at ${localSha} but the ${request.stage} stage recorded ${request.expectedSha}; refusing to publish a head the stage evidence does not name`,
      { localSha },
    );
  }

  // 2. Read the authoritative remote ref.
  let remoteSha: string | null;
  try {
    remoteSha = lookupRemoteSha(request.worktreeDir, remote, branch);
  } catch (error) {
    return fail('remote-lookup-failed', `could not read ${remote} refs for ${branch}: ${errorMessage(error)}`, {
      localSha,
    });
  }

  const stateDir = request.stateDir;
  const recordRow = (from: string | null, publishedAt?: string): HeadMoveRow | null =>
    stateDir
      ? appendHeadMove(stateDir, {
          issue: request.issue ?? '',
          from,
          to: localSha,
          stage: request.stage,
          actor: request.actor,
          kind: request.kind,
          commits: countCommits(request.worktreeDir, from, localSha),
          publishedAt,
        })
      : null;

  if (remoteSha === localSha) {
    // Already published (the agent pushed, or `gh pr create` did). An
    // observation, never a duplicate push.
    // Record the move once per head: a stage exit where nothing moved (the
    // record already ends at this head) appends nothing.
    let headMove: HeadMoveRow | null = null;
    if (stateDir) {
      const priorHead = lastRecordedHead(stateDir);
      if (priorHead !== localSha) {
        headMove = recordRow(priorHead);
      }
    }
    return { ok: true, outcome: 'reused', remote, branch, localSha, remoteSha, headMove };
  }

  if (remoteSha) {
    const isAncestor = (ancestor: string, descendant: string): boolean => {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
          cwd: request.worktreeDir,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        return true;
      } catch {
        return false;
      }
    };
    // The remote head must be locally reachable to prove ancestry; fetch it
    // quietly (a no-op when the checkout already has it).
    try {
      execFileSync('git', ['fetch', '--quiet', remote, branch], {
        cwd: request.worktreeDir,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      // ancestry checks below fail closed to divergence when unreachable
    }
    if (isAncestor(localSha, remoteSha)) {
      return { ok: true, outcome: 'remote-ahead', remote, branch, localSha, remoteSha, headMove: null };
    }
    if (!isAncestor(remoteSha, localSha)) {
      // Divergence must be proven, not assumed: when the fetch above failed
      // (transient transport error) the remote head is not locally reachable,
      // both ancestry probes return false, and concluding 'remote-divergence'
      // here would misclassify a retryable network blip as conflict-shaped
      // code-failure. Only an object we actually hold can prove non-ancestry.
      let remoteHeadReachable = false;
      try {
        execFileSync('git', ['cat-file', '-e', `${remoteSha}^{commit}`], {
          cwd: request.worktreeDir,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        remoteHeadReachable = true;
      } catch {
        remoteHeadReachable = false;
      }
      if (!remoteHeadReachable) {
        return fail(
          'remote-lookup-failed',
          `${remote}/${branch} is at ${remoteSha} but that head could not be fetched locally, so ancestry against local head ${localSha} is unprovable (transient fetch failure)`,
          { localSha, remoteSha },
        );
      }
      return fail(
        'remote-divergence',
        `${remote}/${branch} is at ${remoteSha} which is neither an ancestor nor a descendant of local head ${localSha}; refusing to overwrite the remote branch (merge conflict-shaped divergence)`,
        { localSha, remoteSha },
      );
    }
  }

  // 3. Fast-forward (or first) push of the exact local head, non-force.
  try {
    git(request.worktreeDir, ['push', remote, `${localSha}:refs/heads/${branch}`]);
  } catch (error) {
    return fail('push-failed', `push of ${branch} to ${remote} failed: ${errorMessage(error)}`, { localSha });
  }

  // Upstream tracking is a convenience, never a correctness requirement.
  try {
    git(request.worktreeDir, ['branch', `--set-upstream-to=${remote}/${branch}`, branch]);
  } catch {
    // best-effort only
  }

  // 4. Re-verify the remote resolves to the published head.
  let verifiedSha: string | null;
  try {
    verifiedSha = lookupRemoteSha(request.worktreeDir, remote, branch);
  } catch (error) {
    return fail(
      'post-push-verification-failed',
      `could not verify ${remote}/${branch} after push: ${errorMessage(error)}`,
      { localSha },
    );
  }
  if (verifiedSha !== localSha) {
    return fail(
      'post-push-verification-failed',
      `${remote}/${branch} resolved to ${verifiedSha ?? '(absent)'} after push instead of the published head ${localSha}`,
      { localSha, remoteSha: verifiedSha ?? undefined },
    );
  }

  const headMove = recordRow(remoteSha);
  return { ok: true, outcome: 'pushed', remote, branch, localSha, remoteSha: verifiedSha, headMove };
}

// ── The one task-PR opener (HOK-3463) ───────────────────────────────────────

/** PR content the review agent recorded, with mill fallbacks filled in. */
export interface TaskPullRequestContent {
  title: string;
  body: string;
  draft: boolean;
  /** Where title/body came from: the review artifacts, or the mill's fallback. */
  source: 'review-artifacts' | 'fallback';
}

function metaBlock(issue: string): string {
  return `<!-- wavemill-meta\ntask: ${issue}\n-->`;
}

/**
 * Read the PR title/body the review agent recorded in its review stage
 * result (`artifacts.prTitle` / `prBody` / `prDraft`). Missing content never blocks the PR: the mill falls back to the
 * task title and a minimal body, because an absent description is cheaper
 * than finished work with no PR. The `wavemill-meta` task block is appended
 * when the body lacks one.
 */
export async function resolveTaskPullRequestContent(input: {
  stateDir: string;
  issue: string;
  fallbackTitle?: string;
}): Promise<TaskPullRequestContent> {
  let artifacts: Record<string, unknown> = {};
  try {
    const review = await readStageResult({ featureDir: input.stateDir, stage: 'review' });
    if (review?.artifacts && typeof review.artifacts === 'object') {
      artifacts = review.artifacts as Record<string, unknown>;
    }
  } catch {
    // Unreadable result: fall back rather than fail the PR.
  }
  const recordedTitle = typeof artifacts.prTitle === 'string' ? artifacts.prTitle.trim() : '';
  const recordedBody = typeof artifacts.prBody === 'string' ? artifacts.prBody.trim() : '';
  const fallbackTitle = (input.fallbackTitle ?? '').trim();
  let title = recordedTitle || fallbackTitle || 'Task changes';
  if (!title.includes(input.issue)) title = `${input.issue}: ${title}`;
  let body = recordedBody
    || `## Summary\n\n${fallbackTitle || title}\n\nThe review stage recorded no PR description; the mill opened this PR with a fallback body.`;
  if (!body.includes('wavemill-meta')) body = `${body}\n\n${metaBlock(input.issue)}`;
  return {
    title,
    body,
    draft: artifacts.prDraft === true,
    source: recordedTitle && recordedBody ? 'review-artifacts' : 'fallback',
  };
}

export interface TaskPullRequestRequest {
  /** Task worktree containing the branch. */
  worktreeDir: string;
  /** Remote to publish to. Defaults to 'origin'. */
  remote?: string;
  /** Task branch (no refs/heads/ prefix). */
  branch: string;
  /** Base branch, from the launch contract. Never taken from a prompt. */
  base: string;
  /** Repository in "owner/repo" form. */
  repo: string;
  /** Task state dir: receives the head-move row. */
  stateDir?: string;
  issue: string;
  title: string;
  body: string;
  draft?: boolean;
  /** Test seam for the GitHub calls. */
  githubDeps?: Partial<GitHubToolDeps>;
}

export interface TaskPullRequestSuccess {
  ok: true;
  /** `reused`: an open PR already existed for the branch and was left untouched. */
  outcome: 'created' | 'reused';
  number: number;
  url: string;
  headSha: string;
  publication: StageHeadPublicationOutcome;
}

export interface TaskPullRequestFailure {
  ok: false;
  reason: BranchPublicationFailureReason | 'pr-open-failed';
  message: string;
  /**
   * A failure to publish or open the PR is the mill's own (credentials,
   * network, GitHub). It is never the reviewer model's fault.
   */
  faultClass: 'harness-fault';
}

export type TaskPullRequestResult = TaskPullRequestSuccess | TaskPullRequestFailure;

/**
 * Open the task PR at review exit (HOK-3463): publish the head through the
 * one seam, then create the PR idempotently. An existing open PR for the
 * branch is reused untouched, so the mill never overwrites a body it has
 * already stamped. Never throws for GitHub or git failures.
 */
export async function openTaskPullRequest(request: TaskPullRequestRequest): Promise<TaskPullRequestResult> {
  const publication = publishStageHead({
    worktreeDir: request.worktreeDir,
    remote: request.remote,
    branch: request.branch,
    stateDir: request.stateDir,
    issue: request.issue,
    stage: 'review',
    actor: 'mill',
    kind: 'review-fix',
  });
  if (!publication.ok) {
    return { ok: false, reason: publication.reason, message: publication.message, faultClass: 'harness-fault' };
  }

  const pullRequest = await githubCreatePr(
    {
      repo: request.repo,
      phase: 'review',
      head: request.branch,
      base: request.base,
      headSha: publication.localSha,
      title: request.title,
      body: request.body,
      draft: request.draft,
      ifExists: 'reuse',
    },
    { repoDir: request.worktreeDir, ...request.githubDeps },
  );
  if (!pullRequest.ok) {
    return {
      ok: false,
      reason: 'pr-open-failed',
      message: `${pullRequest.error}: ${pullRequest.message}`,
      faultClass: 'harness-fault',
    };
  }
  const ref = pullRequest.idempotency.ref;
  return {
    ok: true,
    outcome: pullRequest.idempotency.outcome === 'created' ? 'created' : 'reused',
    number: ref.number,
    url: ref.url,
    headSha: publication.localSha,
    publication: publication.outcome,
  };
}
