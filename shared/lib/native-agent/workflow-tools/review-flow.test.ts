import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import type { ReviewResult } from '../../review-engine.ts';
import { createInMemoryDedupeRegistry } from './dedupe.ts';
import type { NetworkPolicy } from '../network-policy.ts';
import type {
  GitHubToolDeps,
  GitHubToolLabelTarget,
  GitHubToolPullRequest,
} from './github.ts';
import type {
  LinearClient,
  WorkflowToolStageArtifactEntry,
  WorkflowToolTranscriptEvent,
} from './linear-tools.ts';
import { runReviewFlow, type ReviewFindingFixExecutor } from './review-flow.ts';
import type { BranchPublicationExecutor } from '../../branch-publication.ts';

interface FixtureState {
  pullRequests: GitHubToolPullRequest[];
  labelsByTarget: Map<string, GitHubToolLabelTarget>;
  linearComments: Array<{ id: string; body: string; issueId: string; url: string }>;
  calls: Record<string, number>;
}

const ALLOW_REVIEW_FLOW_NETWORK_POLICY: NetworkPolicy = {
  review: {
    review_changes: { kind: 'allow' },
    linear_comment: { kind: 'allowlist', hosts: ['api.linear.app'] },
  },
};

// Fixture dirs are not git repos, so tests stub the publication preflight;
// dedicated coverage for the real helper lives in branch-publication.test.ts.
const stubPublishBranch: BranchPublicationExecutor = async ({ branch, reviewedSha }) => ({
  ok: true,
  outcome: 'pushed',
  remote: 'origin',
  branch,
  localSha: reviewedSha,
  remoteSha: reviewedSha,
});

function createLinearClient(state: FixtureState, behavior?: { failComment?: boolean }): LinearClient {
  return {
    async getIssue(identifier: string) {
      return {
        id: `linear-${identifier}`,
        identifier,
        title: `Issue ${identifier}`,
        url: `https://linear.app/acme/issue/${identifier}`,
      };
    },
    async createComment(issueId: string, body: string) {
      state.calls.linearCreateComment += 1;
      if (behavior?.failComment) {
        throw new Error('Linear comment failed');
      }
      const comment = {
        id: `comment-${state.linearComments.length + 1}`,
        issueId,
        body,
        url: `https://linear.app/acme/comment/${state.linearComments.length + 1}`,
      };
      state.linearComments.push(comment);
      return { id: comment.id, url: comment.url };
    },
    async updateComment(_commentId: string, _body: string) {
      state.calls.linearUpdateComment += 1;
      return { id: 'unused', url: 'https://linear.app/acme/comment/unused' };
    },
  };
}

function targetKey(repo: string, targetKind: 'pull_request' | 'issue', targetNumber: number): string {
  return `${repo}:${targetKind}:${targetNumber}`;
}

function createGitHubDeps(state: FixtureState, behavior?: {
  failCreatePr?: boolean;
  failAddLabel?: boolean;
}): GitHubToolDeps {
  return {
    async listOpenPullRequests({ repo, head, base }) {
      state.calls.listOpenPullRequests += 1;
      return state.pullRequests.filter((pr) => pr.url.includes(repo) && pr.head === head && pr.base === base);
    },
    async createPullRequest({ repo, head, base, title, body }) {
      state.calls.createPullRequest += 1;
      if (behavior?.failCreatePr) {
        throw new Error('GitHub create PR failed');
      }
      const number = state.pullRequests.length + 1;
      const pr = {
        number,
        title,
        body,
        head,
        base,
        url: `https://github.com/${repo}/pull/${number}`,
      };
      state.pullRequests.push(pr);
      state.labelsByTarget.set(targetKey(repo, 'pull_request', number), {
        number,
        labels: [],
        url: pr.url,
      });
      return pr;
    },
    async updatePullRequest({ repo, number, title, body }) {
      state.calls.updatePullRequest += 1;
      const current = state.pullRequests.find((pr) => pr.number === number && pr.url.includes(repo));
      if (!current) {
        throw new Error(`PR ${number} not found`);
      }
      current.title = title;
      current.body = body;
      return current;
    },
    async getLabels({ repo, targetKind, targetNumber }) {
      state.calls.getLabels += 1;
      const current = state.labelsByTarget.get(targetKey(repo, targetKind, targetNumber));
      if (!current) {
        throw new Error(`${targetKind} #${targetNumber} not found`);
      }
      return { ...current, labels: [...current.labels] };
    },
    async addLabel({ repo, targetKind, targetNumber, label }) {
      state.calls.addLabel += 1;
      if (behavior?.failAddLabel) {
        throw new Error(`Adding label ${label} failed`);
      }
      const current = state.labelsByTarget.get(targetKey(repo, targetKind, targetNumber));
      if (!current) {
        throw new Error(`${targetKind} #${targetNumber} not found`);
      }
      if (!current.labels.includes(label)) {
        current.labels.push(label);
      }
      return { ...current, labels: [...current.labels] };
    },
    async sleep() {},
    maxAttempts: 1,
    retryDelayMs: 1,
    getSecretEnvNames() {
      return [];
    },
  };
}

function makeReview(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    verdict: 'not_ready',
    codeReviewFindings: [
      {
        severity: 'blocker',
        location: 'src/app.ts:10',
        category: 'correctness',
        description: 'Guard against empty review summaries.',
      },
      {
        severity: 'warning',
        location: 'src/app.ts:22',
        category: 'maintainability',
        description: 'Tighten transient warning handling.',
      },
    ],
    uiFindings: [
      {
        severity: 'warning',
        location: 'src/view.tsx:5',
        category: 'ui',
        description: 'Clarify stronger reviewer messaging.',
      },
    ],
    ...overrides,
  };
}

function makeRecorder() {
  const transcriptEvents: WorkflowToolTranscriptEvent[] = [];
  const stageArtifactEntries: WorkflowToolStageArtifactEntry[] = [];
  return {
    transcript: { append(event: WorkflowToolTranscriptEvent) { transcriptEvents.push(event); } },
    stageArtifact: { append(entry: WorkflowToolStageArtifactEntry) { stageArtifactEntries.push(entry); } },
    transcriptEvents,
    stageArtifactEntries,
  };
}

function makeFixExecutor(outcome: ReviewFindingFixExecutor): ReviewFindingFixExecutor {
  return outcome;
}

const MERGE_TOOL_PATTERNS = [/merge/i, /^github_merge/i];
const MERGE_ACTION_PATTERNS = [/merge/i, /^merge_pr$/i, /^enable_auto_merge$/i];

function assertNoMergeOperations(
  transcriptEvents: WorkflowToolTranscriptEvent[],
  stageArtifactEntries: WorkflowToolStageArtifactEntry[],
): void {
  for (const event of transcriptEvents) {
    for (const pattern of MERGE_TOOL_PATTERNS) {
      assert.ok(
        !pattern.test(event.tool),
        `transcript recorded merge tool "${event.tool}"; flow must halt before merge`,
      );
    }
    for (const pattern of MERGE_ACTION_PATTERNS) {
      assert.ok(
        !pattern.test(event.action),
        `transcript recorded merge action "${event.action}"; flow must halt before merge`,
      );
    }
  }
  for (const entry of stageArtifactEntries) {
    for (const pattern of MERGE_TOOL_PATTERNS) {
      assert.ok(
        !pattern.test(entry.tool),
        `stage artifact recorded merge tool "${entry.tool}"; flow must halt before merge`,
      );
    }
  }
}

let tempDirs: string[] = [];

beforeEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('runReviewFlow', () => {
  it('covers review through PR creation and rerun reuse/update behavior', async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    tempDirs.push(featureDir);
    const state: FixtureState = {
      pullRequests: [],
      labelsByTarget: new Map(),
      linearComments: [],
      calls: {
        linearCreateComment: 0,
        linearUpdateComment: 0,
        listOpenPullRequests: 0,
        createPullRequest: 0,
        updatePullRequest: 0,
        getLabels: 0,
        addLabel: 0,
      },
    };
    const registry = createInMemoryDedupeRegistry({ clock: () => 1_000 });
    const recorder = makeRecorder();
    const linearClient = createLinearClient(state);
    const githubDeps = createGitHubDeps(state);
    const fixExecutor = makeFixExecutor(async ({ finding }) => ({
      ok: true,
      outcome: finding.severity === 'blocker' ? 'applied' : 'skipped',
      findingId: finding.id,
      filesChanged: finding.severity === 'blocker' ? ['src/app.ts'] : [],
      message: finding.severity === 'blocker' ? 'Applied narrow fix' : 'No safe narrow fix',
    }));

    const first = await runReviewFlow({
      issueId: 'HOK-2360',
      featureDir,
      repo: 'acme/widgets',
      base: 'auto/integration',
      head: 'task/review-flow',
      headSha: 'abc123',
      title: 'Implement native review flow',
      body: 'Implements native review flow.',
      labels: ['needs-review', 'native-review'],
      sessionId: 'sess-1',
      registry,
      transcript: recorder.transcript,
      stageArtifact: recorder.stageArtifact,
      clock: () => 1_000,
      linearClient,
      githubDeps,
      networkPolicy: ALLOW_REVIEW_FLOW_NETWORK_POLICY,
      publishBranchImpl: stubPublishBranch,
      reviewChangesImpl: async () => makeReview(),
      fixFindings: fixExecutor,
    });

    assert.equal(first.ok, true);
    assert.equal(first.review.findingCount, 3);
    assert.equal(first.fixes.applied, 1);
    assert.equal(first.fixes.skipped, 2);
    assert.equal(first.pullRequest?.ok, true);
    assert.equal(first.pullRequest?.ok && first.pullRequest.idempotency.outcome, 'created');
    assert.deepEqual(first.labels.map((label) => label.ok && label.idempotency.outcome), ['created', 'created']);
    assert.equal(first.haltedBeforeMerge, true);
    assert.equal(first.merged, false);
    assert.equal(state.calls.createPullRequest, 1);
    assert.equal(state.calls.addLabel, 2);
    assert.ok(recorder.transcriptEvents.some((event) => event.tool === 'review_changes'));
    assert.ok(recorder.transcriptEvents.some((event) => event.tool === 'review_fix'));
    assert.ok(recorder.transcriptEvents.some((event) => event.tool === 'linear_comment'));
    assert.ok(recorder.transcriptEvents.some((event) => event.tool === 'github_create_pr'));
    assert.ok(recorder.transcriptEvents.some((event) => event.tool === 'github_add_label'));
    assert.ok(recorder.transcriptEvents.some((event) => event.tool === 'write_stage_result'));
    assert.ok(recorder.stageArtifactEntries.some((entry) => entry.tool === 'review_fix'));
    assert.ok(recorder.stageArtifactEntries.some((entry) => entry.tool === 'linear_comment'));
    assert.ok(recorder.stageArtifactEntries.some((entry) => entry.tool === 'github_create_pr'));
    assert.ok(recorder.stageArtifactEntries.some((entry) => entry.tool === 'github_add_label'));
    assert.ok(recorder.stageArtifactEntries.some((entry) => entry.tool === 'write_stage_result'));

    const second = await runReviewFlow({
      issueId: 'HOK-2360',
      featureDir,
      repo: 'acme/widgets',
      base: 'auto/integration',
      head: 'task/review-flow',
      headSha: 'abc123',
      title: 'Implement native review flow',
      body: 'Implements native review flow.',
      labels: ['needs-review', 'native-review'],
      sessionId: 'sess-1',
      registry,
      transcript: recorder.transcript,
      stageArtifact: recorder.stageArtifact,
      clock: () => 1_000,
      linearClient,
      githubDeps,
      networkPolicy: ALLOW_REVIEW_FLOW_NETWORK_POLICY,
      publishBranchImpl: stubPublishBranch,
      reviewChangesImpl: async () => makeReview(),
      fixFindings: fixExecutor,
    });

    assert.equal(second.ok, true);
    assert.equal(second.pullRequest?.ok, true);
    assert.equal(second.pullRequest?.ok && second.pullRequest.idempotency.outcome, 'reused');
    assert.deepEqual(second.labels.map((label) => label.ok && label.idempotency.outcome), ['skipped', 'skipped']);
    assert.equal(second.linearComment?.ok, true);
    assert.equal(second.linearComment?.ok && second.linearComment.idempotency.outcome, 'reused');
    assert.equal(second.stageResult?.ok, true);
    assert.equal(second.stageResult?.ok && second.stageResult.idempotency.outcome, 'updated');
    assert.equal(state.calls.createPullRequest, 1);

    const stageFile = path.join(featureDir, '.review-result.json');
    const stored = JSON.parse(readFileSync(stageFile, 'utf8')) as {
      artifacts: { pullRequest: { idempotency: { outcome: string } } };
    };
    assert.equal(stored.artifacts.pullRequest.idempotency.outcome, 'reused');
    assertNoMergeOperations(recorder.transcriptEvents, recorder.stageArtifactEntries);
  });

  it('continues when fixes are denied and surfaces them in the result', async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    tempDirs.push(featureDir);
    const state: FixtureState = {
      pullRequests: [],
      labelsByTarget: new Map(),
      linearComments: [],
      calls: {
        linearCreateComment: 0,
        linearUpdateComment: 0,
        listOpenPullRequests: 0,
        createPullRequest: 0,
        updatePullRequest: 0,
        getLabels: 0,
        addLabel: 0,
      },
    };
    const recorder = makeRecorder();

    const result = await runReviewFlow({
      issueId: 'HOK-2360',
      featureDir,
      repo: 'acme/widgets',
      base: 'auto/integration',
      head: 'task/review-flow',
      headSha: 'abc123',
      title: 'Implement native review flow',
      body: 'Implements native review flow.',
      labels: ['needs-review'],
      sessionId: 'sess-1',
      registry: createInMemoryDedupeRegistry({ clock: () => 1_000 }),
      transcript: recorder.transcript,
      stageArtifact: recorder.stageArtifact,
      clock: () => 1_000,
      linearClient: createLinearClient(state),
      githubDeps: createGitHubDeps(state),
      networkPolicy: ALLOW_REVIEW_FLOW_NETWORK_POLICY,
      publishBranchImpl: stubPublishBranch,
      reviewChangesImpl: async () => makeReview(),
      fixFindings: async ({ finding }) => ({
        ok: true,
        outcome: 'denied',
        findingId: finding.id,
        message: 'Policy denied narrow fix',
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.fixes.applied, 0);
    assert.equal(result.fixes.denied, 3);
    assert.equal(result.pullRequest?.ok, true);
    assert.ok(result.warnings.some((warning) => warning.includes('Policy denied narrow fix')));
    assertNoMergeOperations(recorder.transcriptEvents, recorder.stageArtifactEntries);
  });

  it('runs review against worktreeDir while writing review artifacts to featureDir', async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'review-flow-feature-'));
    const worktreeDir = mkdtempSync(path.join(os.tmpdir(), 'review-flow-worktree-'));
    tempDirs.push(featureDir, worktreeDir);
    const state: FixtureState = {
      pullRequests: [],
      labelsByTarget: new Map(),
      linearComments: [],
      calls: {
        linearCreateComment: 0,
        linearUpdateComment: 0,
        listOpenPullRequests: 0,
        createPullRequest: 0,
        updatePullRequest: 0,
        getLabels: 0,
        addLabel: 0,
      },
    };
    const recorder = makeRecorder();
    let reviewOptions: { repoDir?: string; featureDir?: string; additionalContext?: string } | undefined;

    const result = await runReviewFlow({
      issueId: 'HOK-2543',
      featureDir,
      worktreeDir,
      repo: 'acme/widgets',
      base: 'auto/integration',
      head: 'task/native-review-handoff',
      headSha: 'review123',
      title: 'Complete native review workflow',
      body: 'Native review body.',
      labels: ['native-review'],
      sessionId: 'sess-native-review',
      registry: createInMemoryDedupeRegistry({ clock: () => 1_000 }),
      transcript: recorder.transcript,
      stageArtifact: recorder.stageArtifact,
      clock: () => 1_000,
      linearClient: createLinearClient(state),
      githubDeps: createGitHubDeps(state),
      networkPolicy: ALLOW_REVIEW_FLOW_NETWORK_POLICY,
      publishBranchImpl: stubPublishBranch,
      reviewContextAppendix: 'Native coding handoff: commitCount=1 verification passed',
      reviewChangesImpl: async (options) => {
        reviewOptions = options;
        return makeReview({ verdict: 'ready', codeReviewFindings: [], uiFindings: [] });
      },
    });

    assert.equal(result.ok, true);
    assert.equal(reviewOptions?.repoDir, worktreeDir);
    assert.equal(reviewOptions?.featureDir, featureDir);
    assert.match(reviewOptions?.additionalContext ?? '', /Native coding handoff/);
    assert.equal(existsSync(path.join(featureDir, '.review-result.json')), true);
    assert.equal(existsSync(path.join(worktreeDir, '.review-result.json')), false);

    const stored = JSON.parse(readFileSync(path.join(featureDir, '.review-result.json'), 'utf8')) as {
      artifacts: {
        review: { verdict: string; findingCount: number; blockingCount: number; reviewHeadSha?: string };
        reviewHeadSha?: string;
      };
    };
    assert.equal(stored.artifacts.review.verdict, 'ready');
    assert.equal(stored.artifacts.review.exitCode, 0);
    assert.equal(stored.artifacts.review.iterations, 1);
    assert.equal(stored.artifacts.review.findingCount, 0);
    assert.equal(stored.artifacts.review.blockingCount, 0);
    assert.equal(stored.artifacts.exitCode, 0);
    assert.equal(stored.artifacts.verdict, 'ready');
    assert.equal(stored.artifacts.iterations, 1);
    assert.equal(stored.artifacts.blockerCount, 0);
    // HOK-2964: the reviewed head is recorded so a later commit can be
    // detected as invalidating this verdict.
    assert.equal(stored.artifacts.reviewHeadSha, 'review123');
    assert.equal(stored.artifacts.review.reviewHeadSha, 'review123');
    assertNoMergeOperations(recorder.transcriptEvents, recorder.stageArtifactEntries);
  });

  it('filters wm:ready when final review verdict is not passing', async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    tempDirs.push(featureDir);
    const state: FixtureState = {
      pullRequests: [],
      labelsByTarget: new Map(),
      linearComments: [],
      calls: {
        linearCreateComment: 0,
        linearUpdateComment: 0,
        listOpenPullRequests: 0,
        createPullRequest: 0,
        updatePullRequest: 0,
        getLabels: 0,
        addLabel: 0,
      },
    };
    const recorder = makeRecorder();

    const result = await runReviewFlow({
      issueId: 'HOK-2849',
      featureDir,
      repo: 'acme/widgets',
      base: 'auto/integration',
      head: 'task/review-flow',
      headSha: 'abc123',
      title: 'Implement review gate',
      body: 'Implements review gate.',
      labels: ['wm:ready', 'wavemill'],
      sessionId: 'sess-1',
      registry: createInMemoryDedupeRegistry({ clock: () => 1_000 }),
      transcript: recorder.transcript,
      stageArtifact: recorder.stageArtifact,
      clock: () => 1_000,
      linearClient: createLinearClient(state),
      githubDeps: createGitHubDeps(state),
      networkPolicy: ALLOW_REVIEW_FLOW_NETWORK_POLICY,
      publishBranchImpl: stubPublishBranch,
      reviewChangesImpl: async () => makeReview(),
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.labels.map((label) => label.ok && label.idempotency.ref?.id), ['acme/widgets#1:wavemill']);
    assert.deepEqual([...state.labelsByTarget.values()][0]?.labels, ['wavemill']);
    assert.equal(state.calls.addLabel, 1);
  });

  it('keeps wm:ready when every blocker is validly dismissed and records the audit trail (HOK-2932)', async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    tempDirs.push(featureDir);
    const state: FixtureState = {
      pullRequests: [],
      labelsByTarget: new Map(),
      linearComments: [],
      calls: {
        linearCreateComment: 0,
        linearUpdateComment: 0,
        listOpenPullRequests: 0,
        createPullRequest: 0,
        updatePullRequest: 0,
        getLabels: 0,
        addLabel: 0,
      },
    };
    const recorder = makeRecorder();
    const fixAttempts: string[] = [];

    const result = await runReviewFlow({
      issueId: 'HOK-2932',
      featureDir,
      repo: 'acme/widgets',
      base: 'auto/integration',
      head: 'task/dismissal-path',
      headSha: 'abc123',
      title: 'Dismissal path',
      body: 'Adds the dismissal path.',
      labels: ['wm:ready', 'wavemill'],
      sessionId: 'sess-1',
      registry: createInMemoryDedupeRegistry({ clock: () => 1_000 }),
      transcript: recorder.transcript,
      stageArtifact: recorder.stageArtifact,
      clock: () => 1_000,
      linearClient: createLinearClient(state),
      githubDeps: createGitHubDeps(state),
      networkPolicy: ALLOW_REVIEW_FLOW_NETWORK_POLICY,
      publishBranchImpl: stubPublishBranch,
      fixFindings: makeFixExecutor(async ({ finding }) => {
        fixAttempts.push(finding.id);
        return { ok: true, outcome: 'skipped', findingId: finding.id, message: 'noop' };
      }),
      reviewChangesImpl: async () => makeReview({
        verdict: 'ready',
        codeReviewFindings: [
          {
            severity: 'blocker',
            location: 'scope-guard',
            category: 'plan_compliance',
            description: 'Diff includes files from already-merged PRs.',
            dismissed: true,
            dismissalJustification: 'False positive: stale diff base; PR diff touches only in-scope files.',
            dismissalEvidence: 'git log auto/integration..HEAD -- <in-scope paths>',
          },
        ],
        uiFindings: [],
      }),
    });

    assert.equal(result.ok, true);
    // wm:ready survives the label filter: raw blocker count is 1 but every
    // blocker is validly dismissed.
    assert.deepEqual([...state.labelsByTarget.values()][0]?.labels, ['wm:ready', 'wavemill']);
    assert.equal(result.review.blockingCount, 1);
    assert.equal(result.review.dismissedBlockers.length, 1);
    // A dismissed finding is a disproved false positive — nothing to fix.
    assert.deepEqual(fixAttempts, []);

    const stageResultPath = path.join(featureDir, '.review-result.json');
    assert.ok(existsSync(stageResultPath));
    const stageResult = JSON.parse(readFileSync(stageResultPath, 'utf8'));
    assert.equal(stageResult.artifacts.blockerCount, 1);
    assert.equal(stageResult.artifacts.dismissedBlockers.length, 1);
    assert.equal(
      stageResult.artifacts.dismissedBlockers[0].justification,
      'False positive: stale diff base; PR diff touches only in-scope files.',
    );
    assertNoMergeOperations(recorder.transcriptEvents, recorder.stageArtifactEntries);
  });

  it('filters wm:ready when a dismissal lacks justification', async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    tempDirs.push(featureDir);
    const state: FixtureState = {
      pullRequests: [],
      labelsByTarget: new Map(),
      linearComments: [],
      calls: {
        linearCreateComment: 0,
        linearUpdateComment: 0,
        listOpenPullRequests: 0,
        createPullRequest: 0,
        updatePullRequest: 0,
        getLabels: 0,
        addLabel: 0,
      },
    };
    const recorder = makeRecorder();

    const result = await runReviewFlow({
      issueId: 'HOK-2932',
      featureDir,
      repo: 'acme/widgets',
      base: 'auto/integration',
      head: 'task/dismissal-path',
      headSha: 'abc123',
      title: 'Dismissal path',
      body: 'Adds the dismissal path.',
      labels: ['wm:ready', 'wavemill'],
      sessionId: 'sess-1',
      registry: createInMemoryDedupeRegistry({ clock: () => 1_000 }),
      transcript: recorder.transcript,
      stageArtifact: recorder.stageArtifact,
      clock: () => 1_000,
      linearClient: createLinearClient(state),
      githubDeps: createGitHubDeps(state),
      networkPolicy: ALLOW_REVIEW_FLOW_NETWORK_POLICY,
      publishBranchImpl: stubPublishBranch,
      reviewChangesImpl: async () => makeReview({
        verdict: 'ready',
        codeReviewFindings: [
          {
            severity: 'blocker',
            location: 'scope-guard',
            category: 'plan_compliance',
            description: 'Diff includes files from already-merged PRs.',
            dismissed: true,
            dismissalJustification: '   ',
          },
        ],
        uiFindings: [],
      }),
    });

    assert.equal(result.ok, true);
    assert.deepEqual([...state.labelsByTarget.values()][0]?.labels, ['wavemill']);
    assert.equal(result.review.dismissedBlockers.length, 0);
  });

  it('records exit code 2 and error verdict when review tool fails', async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    tempDirs.push(featureDir);
    const state: FixtureState = {
      pullRequests: [],
      labelsByTarget: new Map(),
      linearComments: [],
      calls: {
        linearCreateComment: 0,
        linearUpdateComment: 0,
        listOpenPullRequests: 0,
        createPullRequest: 0,
        updatePullRequest: 0,
        getLabels: 0,
        addLabel: 0,
      },
    };
    const recorder = makeRecorder();

    const result = await runReviewFlow({
      issueId: 'HOK-2849',
      featureDir,
      repo: 'acme/widgets',
      base: 'auto/integration',
      head: 'task/review-flow',
      headSha: 'abc123',
      title: 'Implement review gate',
      body: 'Implements review gate.',
      labels: ['wm:ready'],
      sessionId: 'sess-1',
      registry: createInMemoryDedupeRegistry({ clock: () => 1_000 }),
      transcript: recorder.transcript,
      stageArtifact: recorder.stageArtifact,
      clock: () => 1_000,
      linearClient: createLinearClient(state),
      githubDeps: createGitHubDeps(state),
      networkPolicy: ALLOW_REVIEW_FLOW_NETWORK_POLICY,
      publishBranchImpl: stubPublishBranch,
      reviewChangesImpl: async () => {
        throw new Error('review provider failed');
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.pullRequest, undefined);
    assert.equal(state.calls.addLabel, 0);

    const stored = JSON.parse(readFileSync(path.join(featureDir, '.review-result.json'), 'utf8')) as {
      status: string;
      artifacts: { type: string; exitCode: number; verdict: string; iterations: number; reviewToolError: string };
    };
    assert.equal(stored.status, 'failed');
    assert.equal(stored.artifacts.type, 'review');
    assert.equal(stored.artifacts.exitCode, 2);
    assert.equal(stored.artifacts.verdict, 'error');
    assert.equal(stored.artifacts.iterations, 1);
    assert.match(stored.artifacts.reviewToolError, /review provider failed/);
  });

  it('short-circuits PR mutation when a stronger reviewer is needed', async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    tempDirs.push(featureDir);
    const state: FixtureState = {
      pullRequests: [],
      labelsByTarget: new Map(),
      linearComments: [],
      calls: {
        linearCreateComment: 0,
        linearUpdateComment: 0,
        listOpenPullRequests: 0,
        createPullRequest: 0,
        updatePullRequest: 0,
        getLabels: 0,
        addLabel: 0,
      },
    };
    const recorder = makeRecorder();

    const result = await runReviewFlow({
      issueId: 'HOK-2360',
      featureDir,
      repo: 'acme/widgets',
      base: 'auto/integration',
      head: 'task/review-flow',
      headSha: 'abc123',
      title: 'Implement native review flow',
      body: 'Implements native review flow.',
      sessionId: 'sess-1',
      registry: createInMemoryDedupeRegistry({ clock: () => 1_000 }),
      transcript: recorder.transcript,
      stageArtifact: recorder.stageArtifact,
      clock: () => 1_000,
      linearClient: createLinearClient(state),
      githubDeps: createGitHubDeps(state),
      networkPolicy: ALLOW_REVIEW_FLOW_NETWORK_POLICY,
      publishBranchImpl: stubPublishBranch,
      reviewChangesImpl: async () => makeReview({ needsStrongerReviewer: true, strongerReviewerReason: 'Human review needed' }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.review.needsStrongerReviewer, true);
    assert.equal(result.pullRequest, undefined);
    assert.equal(result.fixes.attempted, 0);
    assert.equal(state.calls.createPullRequest, 0);
    assert.equal(result.stageResult?.ok, true);
    assertNoMergeOperations(recorder.transcriptEvents, recorder.stageArtifactEntries);
  });

  it('writes a failed stage result when GitHub PR creation fails', async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    tempDirs.push(featureDir);
    const state: FixtureState = {
      pullRequests: [],
      labelsByTarget: new Map(),
      linearComments: [],
      calls: {
        linearCreateComment: 0,
        linearUpdateComment: 0,
        listOpenPullRequests: 0,
        createPullRequest: 0,
        updatePullRequest: 0,
        getLabels: 0,
        addLabel: 0,
      },
    };
    const recorder = makeRecorder();

    const result = await runReviewFlow({
      issueId: 'HOK-2360',
      featureDir,
      repo: 'acme/widgets',
      base: 'auto/integration',
      head: 'task/review-flow',
      headSha: 'abc123',
      title: 'Implement native review flow',
      body: 'Implements native review flow.',
      sessionId: 'sess-1',
      registry: createInMemoryDedupeRegistry({ clock: () => 1_000 }),
      transcript: recorder.transcript,
      stageArtifact: recorder.stageArtifact,
      clock: () => 1_000,
      linearClient: createLinearClient(state, { failComment: true }),
      githubDeps: createGitHubDeps(state, { failCreatePr: true }),
      networkPolicy: ALLOW_REVIEW_FLOW_NETWORK_POLICY,
      publishBranchImpl: stubPublishBranch,
      reviewChangesImpl: async () => makeReview(),
    });

    assert.equal(result.ok, false);
    assert.equal(result.pullRequest?.ok, false);
    assert.ok(result.warnings.some((warning) => warning.includes('linear_comment')));
    assert.ok(result.warnings.some((warning) => warning.includes('github_create_pr')));
    assert.equal(result.stageResult?.ok, true);

    const stageFile = path.join(featureDir, '.review-result.json');
    const stored = JSON.parse(readFileSync(stageFile, 'utf8')) as { status: string; artifacts: { failureReason: string } };
    assert.equal(stored.status, 'failed');
    assert.match(stored.artifacts.failureReason, /GitHub create PR failed/);
    assertNoMergeOperations(recorder.transcriptEvents, recorder.stageArtifactEntries);
  });

  function makeState(): FixtureState {
    return {
      pullRequests: [],
      labelsByTarget: new Map(),
      linearComments: [],
      calls: {
        linearCreateComment: 0,
        linearUpdateComment: 0,
        listOpenPullRequests: 0,
        createPullRequest: 0,
        updatePullRequest: 0,
        getLabels: 0,
        addLabel: 0,
      },
    };
  }

  function baseOptions(featureDir: string, state: FixtureState, recorder: ReturnType<typeof makeRecorder>) {
    return {
      issueId: 'HOK-2914',
      featureDir,
      repo: 'acme/widgets',
      base: 'auto/integration',
      head: 'task/review-flow',
      headSha: 'abc123',
      title: 'Implement native review flow',
      body: 'Implements native review flow.',
      sessionId: 'sess-1',
      registry: createInMemoryDedupeRegistry({ clock: () => 1_000 }),
      transcript: recorder.transcript,
      stageArtifact: recorder.stageArtifact,
      clock: () => 1_000,
      linearClient: createLinearClient(state),
      githubDeps: createGitHubDeps(state),
      networkPolicy: ALLOW_REVIEW_FLOW_NETWORK_POLICY,
      reviewChangesImpl: async () => makeReview(),
    };
  }

  it('blocks PR creation and persists a branch-publication failure when the push fails (HOK-2914)', async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    tempDirs.push(featureDir);
    const state = makeState();
    const recorder = makeRecorder();

    const result = await runReviewFlow({
      ...baseOptions(featureDir, state, recorder),
      publishBranchImpl: async ({ branch }) => ({
        ok: false,
        reason: 'push-failed',
        message: `push of ${branch} to origin failed: auth denied`,
        remote: 'origin',
        branch,
        localSha: 'abc123',
        recoveryCommand: 'git push -u origin task/review-flow',
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.pullRequest, undefined);
    assert.equal(result.branchPublication?.ok, false);
    assert.equal(state.calls.createPullRequest, 0);
    assert.equal(state.calls.listOpenPullRequests, 0);
    assert.equal(state.calls.addLabel, 0);
    assert.ok(result.warnings.some((warning) => warning.includes('branch_publication')));

    const stored = JSON.parse(readFileSync(path.join(featureDir, '.review-result.json'), 'utf8')) as {
      status: string;
      artifacts: { failureReason: string; failureCategory: string; branchPublication: { reason: string; recoveryCommand: string } };
    };
    assert.equal(stored.status, 'failed');
    assert.equal(stored.artifacts.failureCategory, 'branch-publication');
    assert.equal(stored.artifacts.branchPublication.reason, 'push-failed');
    assert.match(stored.artifacts.failureReason, /push-failed/);
    assert.match(stored.artifacts.branchPublication.recoveryCommand, /git push -u origin/);
    assertNoMergeOperations(recorder.transcriptEvents, recorder.stageArtifactEntries);
  });

  it('reports an empty branch (no commits ahead of base) distinctly from an unpushed branch', async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    tempDirs.push(featureDir);
    const state = makeState();
    const recorder = makeRecorder();

    const result = await runReviewFlow({
      ...baseOptions(featureDir, state, recorder),
      publishBranchImpl: async ({ branch, baseBranch }) => ({
        ok: false,
        reason: 'no-commits-ahead-of-base',
        message: `branch ${branch} has no commits ahead of base ${baseBranch}`,
        remote: 'origin',
        branch,
        localSha: 'abc123',
        recoveryCommand: 'git push -u origin task/review-flow',
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(state.calls.createPullRequest, 0);
    const stored = JSON.parse(readFileSync(path.join(featureDir, '.review-result.json'), 'utf8')) as {
      artifacts: { failureCategory: string; failureReason: string };
    };
    assert.equal(stored.artifacts.failureCategory, 'pr-orchestration');
    assert.match(stored.artifacts.failureReason, /no commits ahead of base auto\/integration/);
  });

  it('publishes the reviewed SHA before PR creation and records the proof in artifacts', async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    tempDirs.push(featureDir);
    const state = makeState();
    const recorder = makeRecorder();
    const callOrder: string[] = [];
    const githubDeps = createGitHubDeps(state);
    const originalCreate = githubDeps.createPullRequest.bind(githubDeps);
    githubDeps.createPullRequest = async (input) => {
      callOrder.push('createPullRequest');
      return originalCreate(input);
    };

    const result = await runReviewFlow({
      ...baseOptions(featureDir, state, recorder),
      githubDeps,
      publishBranchImpl: async ({ branch, reviewedSha }) => {
        callOrder.push('publishBranch');
        return {
          ok: true,
          outcome: 'pushed',
          remote: 'origin',
          branch,
          localSha: reviewedSha,
          remoteSha: reviewedSha,
        };
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(callOrder, ['publishBranch', 'createPullRequest']);
    assert.equal(result.branchPublication?.ok, true);
    assert.equal(result.branchPublication?.ok && result.branchPublication.remoteSha, 'abc123');
    const publicationIndex = recorder.transcriptEvents.findIndex((event) => event.tool === 'branch_publication');
    const prIndex = recorder.transcriptEvents.findIndex((event) => event.tool === 'github_create_pr');
    assert.ok(publicationIndex >= 0 && prIndex >= 0 && publicationIndex < prIndex);

    const stored = JSON.parse(readFileSync(path.join(featureDir, '.review-result.json'), 'utf8')) as {
      status: string;
      artifacts: { branchPublication: { ok: boolean; outcome: string; remoteSha: string } };
    };
    assert.equal(stored.status, 'completed');
    assert.equal(stored.artifacts.branchPublication.ok, true);
    assert.equal(stored.artifacts.branchPublication.remoteSha, 'abc123');
    assertNoMergeOperations(recorder.transcriptEvents, recorder.stageArtifactEntries);
  });

  it("translates GitHub's unresolvable-head error into a branch-not-pushed diagnostic", async () => {
    const featureDir = mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    tempDirs.push(featureDir);
    const state = makeState();
    const recorder = makeRecorder();
    const githubDeps = createGitHubDeps(state);
    githubDeps.createPullRequest = async () => {
      throw new Error(
        "GraphQL: Head sha can't be blank, Base sha can't be blank, No commits between main and task/review-flow, Head ref must be a branch (createPullRequest)",
      );
    };

    const result = await runReviewFlow({
      ...baseOptions(featureDir, state, recorder),
      githubDeps,
      publishBranchImpl: stubPublishBranch,
    });

    assert.equal(result.ok, false);
    assert.equal(result.pullRequest?.ok, false);
    const stored = JSON.parse(readFileSync(path.join(featureDir, '.review-result.json'), 'utf8')) as {
      artifacts: { failureReason: string; failureCategory: string };
    };
    assert.match(stored.artifacts.failureReason, /branch was never pushed to origin/);
    assert.equal(stored.artifacts.failureCategory, 'branch-publication');
  });
});
