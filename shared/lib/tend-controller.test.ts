import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildWorkflowState } from '../../tests/lib/task-builder.ts';
import type { LinearIssueSummary } from './linear.ts';
import { WM_LABELS } from './pr-state-labels.ts';
import {
  classifyBasePolicyRejection,
  createPrFetcher,
  defaultHandoffClaimRetryOps,
  defaultHealthChecker,
  defaultStrictBaseRetryOps,
  executeMerge,
  formatStatusLine,
  isBasePolicyMergeError,
  isRequiredChecksExpectedMergeError,
  mergeRetryMarkerPath,
  reconcileScratchPrepState,
  selectNextCandidate,
  waitForChecks,
  type GhPrListEntry,
  type IntegrationHealth,
  type MergeExecutionDeps,
  type SelectNextCandidateOptions,
  type StrictBaseRetryDecision,
  type StrictBaseRetryOps,
  type TendCandidate,
  type TendDecision,
  reconcileWavemillPrLabels,
  taskStateAuthorizesRemoteBranchDeletion,
} from './tend-controller.ts';
import { mergeLaneStateDir } from './merge-queue.ts';
import { readTendAttemptFact, writeTendAttemptFact } from './tend-attempt-fact.ts';
import {
  readScratchPrepMarker,
  scratchPrepMarkerPath,
  writeScratchPrepMarker,
  WorktreePrepTimeoutError,
  type ScratchPrepRunner,
} from './tend-scratch-prep.ts';
import { clearConfigCache } from './config.ts';
import { Ledger } from './ledger.ts';
import { detectDuplicates } from './side-effect-duplicate-detector.ts';
import { gitPushKey, prMergeKey, setSideEffectLedgerForTesting } from './side-effect-ledger.ts';
import {
  claimReadyHandoff,
  publishReadyHandoff,
  readReadyTendHandoff,
  readTendPushedHead,
  recordTendPushedHead,
} from './ready-tend-handoff.ts';

function metadata(lines: string[] = ['task: HOK-1437']): string {
  return ['<!-- wavemill-meta', ...lines, '-->'].join('\n');
}

function pr(overrides: Partial<GhPrListEntry> = {}): GhPrListEntry {
  return {
    number: 1,
    title: 'Test PR',
    headRefName: 'task/test-pr',
    headRefOid: 'head-current',
    createdAt: '2026-04-01T00:00:00Z',
    isDraft: false,
    labels: [{ name: WM_LABELS.wavemill }, { name: WM_LABELS.ready }],
    body: metadata(),
    ...overrides,
  };
}

function label(name: string): { name: string } {
  return { name };
}

function buildTestOptions(
  prList: GhPrListEntry[],
  healthOverride: IntegrationHealth = { state: 'healthy' },
  configOverride: Record<string, unknown> = {},
): SelectNextCandidateOptions & { cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-tend-'));
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  // HOK-3102: observer findings are gated on session capabilities. The tests
  // in this suite assert the tend controller wrote to observer-findings.jsonl,
  // so enable integration + observer by default. Individual tests that pass
  // `configOverride` with their own `integration`/`observer` sections keep
  // full control.
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({
      integration: { enabled: true, useMillSession: true, integrationBranch: 'auto/integration' },
      observer: { enabled: true },
      ...configOverride,
    }),
  );
  clearConfigCache(repoDir);

  return {
    repoDir,
    prFetcher: async () => prList,
    healthChecker: async () => healthOverride,
    challengeGateDeps: {
      linearSiblingLookup: async () => [],
      branchExists: async () => false,
    },
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

function writeWorkflowState(repoDir: string, tasks: Record<string, unknown>): void {
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), JSON.stringify({ tasks }));
}

function writeChallengeComparisons(repoDir: string, records: object[]): void {
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(
    join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl'),
    records.map((record) => JSON.stringify(record)).join('\n'),
  );
}

function writeReadyResult(repoDir: string, task: string, result: object): void {
  const featureDir = join(repoDir, 'features', task);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, '.ready-result.json'), `${JSON.stringify(result)}\n`);
}

function candidate(overrides: Partial<TendCandidate> = {}): TendCandidate {
  return {
    number: 42,
    title: 'Merge me',
    headBranch: 'task/merge-me',
    createdAt: '2026-04-01T00:00:00Z',
    dependencyDepth: 0,
    ...overrides,
  };
}

/**
 * Build a prep runner that delegates to the test's shellRunner. Keeps every
 * existing `hasCall(options.calls, /git worktree add/)` assertion green
 * while `withScratchWorktree` runs its reap/fetch/add commands through the
 * (new, async) `deps.prepRunner`.
 */
function shellRunnerBackedPrepRunner(
  shellRunnerRef: { current: MergeExecutionDeps['shellRunner'] },
  cwdOverride: string,
): ScratchPrepRunner {
  return {
    remainingDeadlineMs: () => Number.POSITIVE_INFINITY,
    run: async (cmd, opts) => {
      const out = shellRunnerRef.current(cmd, {
        encoding: 'utf-8',
        cwd: opts.cwd || cwdOverride,
        timeout: opts.perCommandDeadlineMs ?? 60_000,
      });
      return String(out);
    },
  };
}

function buildMergeTestOptions(overrides: {
  shellRunner?: MergeExecutionDeps['shellRunner'];
  readyChecker?: MergeExecutionDeps['readyChecker'];
  healthChecker?: MergeExecutionDeps['healthChecker'];
  prepRunnerFactory?: MergeExecutionDeps['prepRunnerFactory'];
  scratchPrepRetry?: MergeExecutionDeps['scratchPrepRetry'];
  handoffClaimRetry?: MergeExecutionDeps['handoffClaimRetry'];
  transientRetry?: MergeExecutionDeps['transientRetry'];
  rebaseHeadSha?: string;
} = {}): {
  repoDir: string;
  calls: string[];
  labels: string[];
  deps: Partial<MergeExecutionDeps>;
  cleanup: () => void;
} {
  const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-tend-merge-'));
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({ integration: { integrationBranch: 'auto/integration', mergeMethod: 'squash' } }),
  );
  // HOK-3242: taskStateAuthorizesRemoteBranchDeletion now fails closed on
  // a lookup miss. Seed workflow-state so the default candidate's branch
  // (`task/merge-me`) carries a launchContract that authorizes deletion;
  // tests overriding `candidate({ headBranch: ... })` to a different value
  // can seed their own row and will otherwise observe fail-closed.
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(
    join(repoDir, '.wavemill', 'workflow-state.json'),
    JSON.stringify(buildWorkflowState({
      'HOK-test-merge-me': {
        pr: '42',
        slug: 'merge-me',
        worktree: repoDir,
        branch: 'task/merge-me',
        lifecycle: {
          schemaVersion: 1,
          workflowOutcome: 'merged',
          resourceDisposition: 'reaped',
          launchContract: {
            remoteBranchDeletionPolicy: {
              allowed: true,
              mode: 'test-authorized',
              reason: 'test-fixture',
              source: 'test',
            },
          },
        },
      },
    })),
  );

  const calls: string[] = [];
  const labels: string[] = [];
  let rebasedPush = false;
  const defaultShellRunner: MergeExecutionDeps['shellRunner'] = (cmd) => {
    calls.push(cmd);
    if (cmd.includes('git push --force-with-lease') && overrides.rebaseHeadSha) rebasedPush = true;
    if (cmd.includes('gh pr list --label')) return '[]';
    if (cmd.includes('git rev-parse --git-common-dir')) return join(repoDir, '.git');
    if (cmd === 'git rev-parse HEAD' && overrides.rebaseHeadSha) return overrides.rebaseHeadSha;
    if (cmd.includes('git rev-parse') && cmd.includes('origin/')) return 'abc123def456';
    if (cmd.includes('git merge-base --is-ancestor')) { const e = new Error('Command failed: git merge-base --is-ancestor'); (e as unknown as Record<string, unknown>).status = 1; throw e; }
    if (cmd.includes('gh pr checks')) return JSON.stringify([{ name: 'ci', state: 'COMPLETED', conclusion: 'success' }]);
    if (cmd.includes('gh pr view')) {
      return JSON.stringify({
        mergeStateStatus: 'CLEAN',
        headRefOid: rebasedPush ? overrides.rebaseHeadSha : 'head-sha',
        baseRefOid: 'base-sha',
        statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      });
    }
    return '';
  };

  const shellRunnerRef = { current: overrides.shellRunner ?? defaultShellRunner };
  const noopStrictBaseRetry: StrictBaseRetryOps = {
    gate: () => 'proceed',
    increment: () => {},
    markExhausted: () => {},
    clear: () => {},
  };

  return {
    repoDir,
    calls,
    labels,
    deps: {
      shellRunner: shellRunnerRef.current,
      readyChecker: overrides.readyChecker ?? (async () => ({ ready: true })),
      healthChecker: overrides.healthChecker ?? (async () => ({ state: 'healthy' })),
      acquireMerging: (prNumber) => {
        labels.push(`merging:${prNumber}`);
      },
      releaseMerging: (prNumber) => {
        labels.push(`release-merging:${prNumber}`);
      },
      releaseMerged: (prNumber) => {
        labels.push(`merged:${prNumber}`);
      },
      restoreReady: (prNumber) => {
        labels.push(`ready:${prNumber}`);
      },
      reclaimStaleMerging: (prNumber) => {
        labels.push(`ready-reclaim:${prNumber}`);
      },
      prepRunnerFactory: overrides.prepRunnerFactory ?? (() => shellRunnerBackedPrepRunner(shellRunnerRef, repoDir)),
      scratchPrepRetry: overrides.scratchPrepRetry ?? noopStrictBaseRetry,
      // HOK-3108: keep every existing test's handoff path stable. A test that
      // wants to exercise the handoff-claim budget passes its own fake here.
      handoffClaimRetry: overrides.handoffClaimRetry ?? noopStrictBaseRetry,
      transientRetry: overrides.transientRetry ?? noopStrictBaseRetry,
    },
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

/** What `git rebase` prints on a real conflict — a recognised code failure (HOK-3176). */
const GIT_REBASE_CONFLICT_OUTPUT = 'Auto-merging file.ts\nCONFLICT (content): Merge conflict in file.ts\n'
  + 'error: could not apply 1a2b3c4... change\nhint: Resolve all conflicts manually';

/** A shell-level wm:blocked label add/remove (the comment body may name the label). */
const WM_BLOCKED_LABEL_WRITE = /labels\/wm(?:%3A|:)blocked|--(?:add|remove)-label[\s=]+['"]?wm:blocked/;

function hasCall(calls: string[], pattern: RegExp): boolean {
  return calls.some((call) => pattern.test(call));
}

function runGit(repoDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Wavemill Test',
      GIT_AUTHOR_EMAIL: 'wavemill@example.com',
      GIT_COMMITTER_NAME: 'Wavemill Test',
      GIT_COMMITTER_EMAIL: 'wavemill@example.com',
    },
  }).trim();
}

function createCommit(repoDir: string, filename: string, contents: string, message: string): string {
  writeFileSync(join(repoDir, filename), contents);
  runGit(repoDir, ['add', filename]);
  runGit(repoDir, ['commit', '-m', message]);
  return runGit(repoDir, ['rev-parse', 'HEAD']);
}

function createRepoWithRemoteIntegration(): {
  repoDir: string;
  remoteDir: string;
  seedDir: string;
  remoteSha: string;
  cleanup: () => void;
} {
  const rootDir = mkdtempSync(join(tmpdir(), 'wavemill-tend-health-'));
  const remoteDir = join(rootDir, 'remote.git');
  const seedDir = join(rootDir, 'seed');
  const repoDir = join(rootDir, 'repo');

  mkdirSync(remoteDir, { recursive: true });
  mkdirSync(seedDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  runGit(remoteDir, ['init', '--bare']);
  runGit(seedDir, ['init']);
  const remoteSha = createCommit(seedDir, 'README.md', 'remote integration\n', 'seed integration branch');
  runGit(seedDir, ['branch', '-M', 'auto/integration']);
  runGit(seedDir, ['remote', 'add', 'origin', remoteDir]);
  runGit(seedDir, ['push', 'origin', 'auto/integration']);

  runGit(repoDir, ['init']);
  runGit(repoDir, ['remote', 'add', 'origin', remoteDir]);
  runGit(repoDir, ['fetch', 'origin', 'auto/integration']);
  runGit(repoDir, ['remote', 'set-url', 'origin', 'git@github.com:example/repo.git']);
  runGit(repoDir, ['config', `url.${remoteDir}.insteadOf`, 'git@github.com:example/repo.git']);
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({ integration: { integrationBranch: 'auto/integration' } }),
  );

  return {
    repoDir,
    remoteDir,
    seedDir,
    remoteSha,
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

function writeFakeGh(
  binDir: string,
  responseBody: string,
  options: {
    logPath?: string;
    missingCommitShas?: string[];
    createRemoteRefOnMissingCommit?: { ref: string; sha: string };
  } = {},
): void {
  mkdirSync(binDir, { recursive: true });
  const scriptPath = join(binDir, 'gh');
  const missingCommitShas = options.missingCommitShas ?? [];
  const script = [
    '#!/bin/sh',
    'set -eu',
    // allow-template-curly: shell positional-parameter expansion in a gh fixture.
    'if [ "${1:-}" != "api" ]; then',
    '  echo "unexpected gh command: $*" >&2',
    '  exit 1',
    'fi',
    // allow-template-curly: shell positional-parameter expansion in a gh fixture.
    'path="${2:-}"',
    'sha=$(printf \'%s\' "$path" | sed -n \'s#repos/.*/commits/\\([^/]*\\)/check-runs#\\1#p\')',
    options.logPath ? `printf '%s\\n' "$path" >> ${JSON.stringify(options.logPath)}` : ':',
    missingCommitShas.length > 0
      ? `case "$sha" in ${missingCommitShas.map((sha) => JSON.stringify(sha)).join('|')})
  ${options.createRemoteRefOnMissingCommit
    ? `git update-ref ${JSON.stringify(options.createRemoteRefOnMissingCommit.ref)} ${JSON.stringify(options.createRemoteRefOnMissingCommit.sha)}`
    : ':'}
  echo "gh: No commit found for SHA: $sha (HTTP 422)" >&2
  exit 1
  ;;
esac`
      : ':',
    `cat <<'EOF'`,
    responseBody,
    'EOF',
  ].join('\n');
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o755);
}

async function withFakeGh<T>(
  responseBody: string,
  run: (context: { binDir: string; logPath: string }) => Promise<T>,
  options: {
    missingCommitShas?: string[];
    createRemoteRefOnMissingCommit?: { ref: string; sha: string };
  } = {},
): Promise<T> {
  const fakeRoot = mkdtempSync(join(tmpdir(), 'wavemill-gh-'));
  const binDir = join(fakeRoot, 'bin');
  const logPath = join(fakeRoot, 'gh-api-path.txt');
  const originalPath = process.env.PATH ?? '';
  writeFakeGh(binDir, responseBody, { logPath, ...options });
  process.env.PATH = `${binDir}${originalPath ? `:${originalPath}` : ''}`;

  try {
    return await run({ binDir, logPath });
  } finally {
    process.env.PATH = originalPath;
    rmSync(fakeRoot, { recursive: true, force: true });
  }
}

function hasLocalBranch(repoDir: string, branch: string): boolean {
  try {
    runGit(repoDir, ['rev-parse', '--verify', branch]);
    return true;
  } catch {
    return false;
  }
}

function readGhApiPaths(logPath: string): string[] {
  if (!existsSync(logPath)) {
    return [];
  }

  return readFileSync(logPath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function withDecision(
  prList: GhPrListEntry[],
  test: (decision: TendDecision) => void | Promise<void>,
  healthOverride?: IntegrationHealth,
): Promise<void> {
  const options = buildTestOptions(prList, healthOverride);
  try {
    const decision = await selectNextCandidate(options);
    await test(decision);
  } finally {
    options.cleanup();
  }
}

describe('selectNextCandidate filtering', () => {
  it('blocks draft PRs', async () => {
    await withDecision([pr({ isDraft: true })], (decision) => {
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked[0]?.reason, 'draft');
    });
  });

  it('honours wm:blocked without re-deriving or clearing it (HOK-3316)', async () => {
    // No workflow task: the reconciler has no decision, the label stays put,
    // and tend skips the PR instead of running a private clearer.
    const options = buildTestOptions([
      pr({ labels: [label(WM_LABELS.wavemill), label(WM_LABELS.ready), label(WM_LABELS.blocked)] }),
    ]);
    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked[0]?.reason, 'blocked-label');
    } finally {
      options.cleanup();
    }
  });

  it('names the reconciler reason for a tend-attempt block (HOK-3316)', async () => {
    const options = buildTestOptions([
      pr({ labels: [label(WM_LABELS.wavemill), label(WM_LABELS.blocked)], body: metadata(['task: HOK-1437']) }),
    ]);
    const slug = 'tend-attempt-block';
    const worktree = options.repoDir;
    const featureDir = join(worktree, 'features', slug);
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, '.ready-result.json'), JSON.stringify({
      stage: 'ready',
      status: 'completed',
      artifacts: { type: 'ready', verdict: 'pass', prNumber: 1, readyHeadSha: 'head-current' },
    }));
    // Tend's rebase failed at the live head; no base recorded, so the fact
    // holds on the head alone (the test repo has no integration ref).
    writeTendAttemptFact(featureDir, {
      phase: 'rebase',
      prNumber: 1,
      headSha: 'head-current',
      baseSha: '',
      excerpt: GIT_REBASE_CONFLICT_OUTPUT,
      failureClass: 'code-failure',
    });
    writeWorkflowState(options.repoDir, {
      'HOK-1437': { pr: '1', slug, worktree, phase: 'ready' },
    });
    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked[0]?.reason, 'blocked-label:tend-rebase-failed');
    } finally {
      options.cleanup();
    }
  });

  it('blocks PRs missing metadata', async () => {
    await withDecision([pr({ body: 'No metadata.' })], (decision) => {
      assert.equal(decision.blocked[0]?.reason, 'missing-metadata');
    });
  });

  it('blocks PRs with invalid metadata as metadata-invalid (not missing-metadata)', async () => {
    const invalidBody = [
      '<!-- wavemill-meta',
      'task: HOK-2929',
      'review-infrastructure-note: native-context-window-exceeded',
      '-->',
    ].join('\n');
    await withDecision([pr({ body: invalidBody })], (decision) => {
      assert.ok(decision.blocked[0]?.reason.startsWith('metadata-invalid:'));
      assert.ok(decision.blocked[0]?.reason.includes('review-infrastructure-note'));
      assert.notEqual(decision.blocked[0]?.reason, 'missing-metadata');
    });
  });

  it('reaches ready-failed:<reason> when metadata is valid but wm:ready absent', async () => {
    // HOK-3242: tend surfaces the merge-label reconciler's specific no-label
    // reason (`no-task-view` here, since no workflow-state is seeded for
    // this PR) in place of the generic `ready-failed:not-ready`.
    await withDecision([
      pr({ labels: [label(WM_LABELS.wavemill)] }),
    ], (decision) => {
      assert.equal(decision.blocked[0]?.reason, 'ready-failed:no-task-view');
    });
  });

  it('blocks PRs without the ready label', async () => {
    await withDecision([
      pr({ labels: [label(WM_LABELS.wavemill)] }),
    ], (decision) => {
      assert.equal(decision.blocked[0]?.reason, 'ready-failed:no-task-view');
    });
  });

  it('blocks unresolved PR dependencies', async () => {
    await withDecision([
      pr({ body: metadata(['depends_on: ["PR#99"]']) }),
    ], (decision) => {
      assert.equal(decision.blocked[0]?.reason, 'deps-unresolved');
    });
  });

  it('blocks unresolved Linear dependencies', async () => {
    await withDecision([
      pr({ body: metadata(['depends_on_linear: ["HOK-9999"]']) }),
    ], (decision) => {
      assert.equal(decision.blocked[0]?.reason, 'deps-unresolved');
    });
  });

  it('blocks unresolved challenges', async () => {
    await withDecision([
      pr({
        body: metadata(['challenge: true']),
        labels: [label(WM_LABELS.wavemill), label(WM_LABELS.ready), label(WM_LABELS.challengeUnresolved)],
      }),
    ], (decision) => {
      assert.equal(decision.blocked[0]?.reason, 'challenges-unresolved');
    });
  });

  it('ignores non-Wavemill PRs', async () => {
    await withDecision([
      pr({ labels: [], body: 'No metadata.' }),
    ], (decision) => {
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked.length, 0);
      assert.equal(decision.nextPR, null);
    });
  });

  // HOK-3242: when the merge-label reconciler produced a null decision for
  // the PR this tick, surface its specific reason in place of the generic
  // `ready-failed:not-ready` so a reader can see which null branch (missing
  // Ready evidence, head-mismatch, etc.) kept wm:ready off.
  it('surfaces the reconciler reason (ready-pending) via ready-failed:<reason>', async () => {
    const options = buildTestOptions([
      pr({ labels: [label(WM_LABELS.wavemill)], body: metadata(['task: HOK-1437']) }),
    ]);
    const slug = 'reason-threading';
    const worktree = options.repoDir;
    mkdirSync(join(worktree, 'features', slug), { recursive: true });
    // Ready result reports the same head as the live PR but is still
    // running: Rule 4 of deriveMergeLabel (`ready-pending`). The headSha in
    // the artifact is what findTaskInState reads for `task.headSha`, so
    // Rule 1 passes.
    writeFileSync(join(worktree, 'features', slug, '.ready-result.json'), JSON.stringify({
      stage: 'ready',
      status: 'running',
      artifacts: { type: 'ready', readyHeadSha: 'head-current' },
    }));
    writeWorkflowState(options.repoDir, {
      'HOK-1437': { pr: '1', slug, worktree, phase: 'ready' },
    });
    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.blocked[0]?.reason, 'ready-failed:ready-pending');
    } finally {
      options.cleanup();
    }
  });

  it('surfaces the reconciler reason (head-mismatch) via ready-failed:<reason>', async () => {
    const options = buildTestOptions([
      pr({ labels: [label(WM_LABELS.wavemill)], body: metadata(['task: HOK-1437']) }),
    ]);
    const slug = 'reason-head-mismatch';
    const worktree = options.repoDir;
    mkdirSync(join(worktree, 'features', slug), { recursive: true });
    // Ready result reports a different head than the live PR head: Rule 1
    // of deriveMergeLabel.
    writeFileSync(join(worktree, 'features', slug, '.ready-result.json'), JSON.stringify({
      stage: 'ready',
      status: 'completed',
      artifacts: { type: 'ready', verdict: 'pass', prNumber: 1, readyHeadSha: 'different-head' },
    }));
    writeWorkflowState(options.repoDir, {
      'HOK-1437': { pr: '1', slug, worktree, phase: 'ready' },
    });
    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.blocked[0]?.reason, 'ready-failed:head-mismatch');
    } finally {
      options.cleanup();
    }
  });
});

describe('selectNextCandidate ordering and health', () => {
  it('sorts eligible PRs by dependency depth then created date', async () => {
    await withDecision([
      pr({ number: 3, createdAt: '2026-04-01T00:00:00Z', body: metadata(['depends_on: ["PR#2"]']) }),
      pr({ number: 1, createdAt: '2026-04-03T00:00:00Z' }),
      pr({ number: 2, createdAt: '2026-04-02T00:00:00Z' }),
      pr({ number: 4, createdAt: '2026-04-04T00:00:00Z', body: metadata(['depends_on: ["PR#3"]']) }),
    ], (decision) => {
      assert.deepEqual(decision.eligible.map((candidate) => candidate.number), [2, 1, 3, 4]);
      assert.deepEqual(decision.eligible.map((candidate) => candidate.dependencyDepth), [0, 0, 1, 2]);
      assert.equal(decision.nextPR, 2);
    });
  });

  it('lists ready waiters but skips eligibility gates when integration health is unhealthy', async () => {
    const options = buildTestOptions([
      pr({ number: 10 }),
      pr({ number: 11, labels: [label(WM_LABELS.wavemill)] }),
    ], { state: 'unhealthy', reason: 'ci: failure' });
    let gateCalls = 0;
    options.crossPrGuardChecker = async () => {
      gateCalls += 1;
      return { status: 'pass', checkedHeadSha: 'head-current' };
    };
    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.integrationHealth.state, 'unhealthy');
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked.length, 0);
      assert.deepEqual(decision.waitingReady?.map((candidate) => candidate.number), [10]);
      assert.equal(decision.nextPR, null);
      assert.equal(gateCalls, 0);
    } finally {
      options.cleanup();
    }
  });

  it('returns an empty decision for empty input', async () => {
    await withDecision([], (decision) => {
      assert.deepEqual(decision.eligible, []);
      assert.deepEqual(decision.blocked, []);
      assert.equal(decision.nextPR, null);
    });
  });

  it('reports mixed eligible and blocked counts', async () => {
    await withDecision([
      pr({ number: 1 }),
      pr({ number: 2, createdAt: '2026-04-02T00:00:00Z' }),
      pr({ number: 3, isDraft: true }),
      pr({ number: 4, body: 'No metadata.' }),
      pr({ number: 5, labels: [label(WM_LABELS.wavemill)] }),
    ], (decision) => {
      assert.equal(decision.eligible.length, 2);
      assert.equal(decision.blocked.length, 3);
      assert.equal(decision.nextPR, 1);
    });
  });
});

describe('challenge-mode gating', () => {
  it('blocks both challenge PRs when the pair is unresolved', async () => {
    const first = pr({
      number: 101,
      title: 'Primary',
      headRefName: 'task/primary',
      body: metadata(['task: HOK-1439', 'challenge: true', 'challengePairId: pair-1']),
    });
    const second = pr({
      number: 102,
      title: 'Challenger',
      headRefName: 'task/challenger',
      createdAt: '2026-04-02T00:00:00Z',
      body: metadata(['task: HOK-1439_c', 'challenge: true', 'challengePairId: pair-1']),
    });
    const options = buildTestOptions([first, second]);
    const cleaned: number[] = [];
    options.loserCleanup = (candidate) => {
      cleaned.push(candidate.loserPr);
    };
    writeWorkflowState(options.repoDir, {
      HOK_1439: { pr: 101, challengePairId: 'pair-1', challengeRole: 'primary' },
      HOK_1439_c: { pr: 102, challengePairId: 'pair-1', challengeRole: 'challenger' },
    });

    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.nextPR, null);
      assert.deepEqual(
        decision.blocked.map((candidate) => [candidate.number, candidate.reason]),
        [
          [101, 'challenge:pair-unresolved:no-comparison'],
          [102, 'challenge:pair-unresolved:no-comparison'],
        ],
      );
      assert.deepEqual(cleaned, []);
    } finally {
      options.cleanup();
    }
  });

  it('keeps only the winner eligible and cleans up the loser when auto-merge is enabled', async () => {
    const first = pr({
      number: 101,
      title: 'Primary',
      headRefName: 'task/primary',
      body: metadata(['task: HOK-1439', 'challenge: true', 'challengePairId: pair-1']),
    });
    const second = pr({
      number: 102,
      title: 'Challenger',
      headRefName: 'task/challenger',
      createdAt: '2026-04-02T00:00:00Z',
      body: metadata(['task: HOK-1439_c', 'challenge: true', 'challengePairId: pair-1']),
    });
    const options = buildTestOptions([first, second], { state: 'healthy' }, {
      challenge: { autoMergeWinner: true },
    });
    const cleaned: number[] = [];
    options.loserCleanup = (candidate) => {
      cleaned.push(candidate.loserPr);
    };
    writeWorkflowState(options.repoDir, {
      HOK_1439: { pr: 101, challengePairId: 'pair-1', challengeRole: 'primary' },
      HOK_1439_c: { pr: 102, challengePairId: 'pair-1', challengeRole: 'challenger' },
    });
    writeChallengeComparisons(options.repoDir, [{
      challengePairId: 'pair-1',
      primaryPrUrl: 'https://github.com/example/repo/pull/101',
      challengerPrUrl: 'https://github.com/example/repo/pull/102',
      winner: 'primary',
      timestamp: '2026-04-28T12:00:00Z',
    }]);

    try {
      const decision = await selectNextCandidate(options);
      assert.deepEqual(decision.eligible.map((candidate) => candidate.number), [101]);
      assert.deepEqual(
        decision.blocked.map((candidate) => [candidate.number, candidate.reason]),
        [[102, 'challenge:loser:pair-1']],
      );
      assert.equal(decision.nextPR, 101);
      assert.deepEqual(cleaned, [102]);
    } finally {
      options.cleanup();
    }
  });

  it('does not re-run loser cleanup after the loser has been superseded', async () => {
    const first = pr({
      number: 101,
      title: 'Primary',
      headRefName: 'task/primary',
      body: metadata(['task: HOK-1439', 'challenge: true', 'challengePairId: pair-1']),
    });
    const second = pr({
      number: 102,
      title: 'Challenger',
      headRefName: 'task/challenger',
      createdAt: '2026-04-02T00:00:00Z',
      labels: [label(WM_LABELS.wavemill), label(WM_LABELS.ready), label(WM_LABELS.superseded)],
      body: metadata(['task: HOK-1439_c', 'challenge: true', 'challengePairId: pair-1']),
    });
    const options = buildTestOptions([first, second], { state: 'healthy' }, {
      challenge: { autoMergeWinner: true },
    });
    const cleaned: number[] = [];
    options.loserCleanup = (candidate) => {
      cleaned.push(candidate.loserPr);
    };
    writeWorkflowState(options.repoDir, {
      HOK_1439: { pr: 101, challengePairId: 'pair-1', challengeRole: 'primary' },
      HOK_1439_c: { pr: 102, challengePairId: 'pair-1', challengeRole: 'challenger' },
    });
    writeChallengeComparisons(options.repoDir, [{
      challengePairId: 'pair-1',
      primaryPrUrl: 'https://github.com/example/repo/pull/101',
      challengerPrUrl: 'https://github.com/example/repo/pull/102',
      winner: 'primary',
      timestamp: '2026-04-28T12:00:00Z',
    }]);

    try {
      const decision = await selectNextCandidate(options);
      assert.deepEqual(decision.eligible.map((candidate) => candidate.number), [101]);
      assert.deepEqual(
        decision.blocked.map((candidate) => [candidate.number, candidate.reason]),
        [[102, 'challenge:loser:pair-1']],
      );
      assert.deepEqual(cleaned, []);
    } finally {
      options.cleanup();
    }
  });

  it('holds the winner by default when autoMergeWinner is omitted', async () => {
    const first = pr({
      number: 101,
      title: 'Primary',
      headRefName: 'task/primary',
      body: metadata(['task: HOK-1439', 'challenge: true', 'challengePairId: pair-1']),
    });
    const second = pr({
      number: 102,
      title: 'Challenger',
      headRefName: 'task/challenger',
      createdAt: '2026-04-02T00:00:00Z',
      body: metadata(['task: HOK-1439_c', 'challenge: true', 'challengePairId: pair-1']),
    });
    const options = buildTestOptions([first, second]);
    const cleaned: number[] = [];
    options.loserCleanup = (candidate) => {
      cleaned.push(candidate.loserPr);
    };
    writeWorkflowState(options.repoDir, {
      HOK_1439: { pr: 101, challengePairId: 'pair-1', challengeRole: 'primary' },
      HOK_1439_c: { pr: 102, challengePairId: 'pair-1', challengeRole: 'challenger' },
    });
    writeChallengeComparisons(options.repoDir, [{
      challengePairId: 'pair-1',
      primaryPrUrl: 'https://github.com/example/repo/pull/101',
      challengerPrUrl: 'https://github.com/example/repo/pull/102',
      winner: 'primary',
      timestamp: '2026-04-28T12:00:00Z',
    }]);

    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.nextPR, null);
      assert.deepEqual(
        decision.blocked.map((candidate) => [candidate.number, candidate.reason]),
        [
          [101, 'challenge:winner-held:pair-1'],
          [102, 'challenge:loser:pair-1'],
        ],
      );
      assert.deepEqual(cleaned, [102]);
    } finally {
      options.cleanup();
    }
  });

  it('holds the winner when autoMergeWinner is false and still cleans up the loser', async () => {
    const first = pr({
      number: 101,
      title: 'Primary',
      headRefName: 'task/primary',
      body: metadata(['task: HOK-1439', 'challenge: true', 'challengePairId: pair-1']),
    });
    const second = pr({
      number: 102,
      title: 'Challenger',
      headRefName: 'task/challenger',
      createdAt: '2026-04-02T00:00:00Z',
      body: metadata(['task: HOK-1439_c', 'challenge: true', 'challengePairId: pair-1']),
    });
    const options = buildTestOptions([first, second], { state: 'healthy' }, {
      challenge: { autoMergeWinner: false },
    });
    const cleaned: number[] = [];
    options.loserCleanup = (candidate) => {
      cleaned.push(candidate.loserPr);
    };
    writeWorkflowState(options.repoDir, {
      HOK_1439: { pr: 101, challengePairId: 'pair-1', challengeRole: 'primary' },
      HOK_1439_c: { pr: 102, challengePairId: 'pair-1', challengeRole: 'challenger' },
    });
    writeChallengeComparisons(options.repoDir, [{
      challengePairId: 'pair-1',
      primaryPrUrl: 'https://github.com/example/repo/pull/101',
      challengerPrUrl: 'https://github.com/example/repo/pull/102',
      winner: 'primary',
      timestamp: '2026-04-28T12:00:00Z',
    }]);

    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.nextPR, null);
      assert.deepEqual(
        decision.blocked.map((candidate) => [candidate.number, candidate.reason]),
        [
          [101, 'challenge:winner-held:pair-1'],
          [102, 'challenge:loser:pair-1'],
        ],
      );
      assert.deepEqual(cleaned, [102]);
    } finally {
      options.cleanup();
    }
  });

  it('leaves non-challenge PR behavior unchanged', async () => {
    await withDecision([pr({ number: 201, title: 'Normal PR' })], (decision) => {
      assert.deepEqual(decision.eligible.map((candidate) => candidate.number), [201]);
      assert.deepEqual(decision.blocked, []);
      assert.equal(decision.nextPR, 201);
    });
  });

  it('blocks a primary PR when workflow state is empty but Linear exposes an open challenger sibling', async () => {
    const primary = pr({
      number: 497,
      title: 'Primary',
      headRefName: 'task/hok-1523-example',
      body: metadata(['task: HOK-1523']),
    });
    const options = buildTestOptions([primary]);
    options.challengeGateDeps = {
      linearSiblingLookup: async (): Promise<LinearIssueSummary[]> => [
        {
          id: 'issue-primary',
          identifier: 'HOK-1523',
          title: 'Primary issue',
          state: { name: 'In Progress' },
          completedAt: null,
          canceledAt: null,
        },
        {
          id: 'issue-challenger',
          identifier: 'HOK-1523_c',
          title: 'Challenger issue',
          state: { name: 'Backlog' },
          completedAt: null,
          canceledAt: null,
        },
      ],
      branchExists: async () => false,
    };

    try {
      const decision = await selectNextCandidate(options);
      assert.deepEqual(decision.eligible, []);
      assert.deepEqual(
        decision.blocked.map((candidate) => [candidate.number, candidate.reason]),
        [[497, 'challenge:pair-unresolved:linear-sibling:HOK-1523_c']],
      );
      assert.equal(decision.nextPR, null);
    } finally {
      options.cleanup();
    }
  });

  it('blocks a primary PR when workflow state has the challenge pair but the challenger PR is not open', async () => {
    const primary = pr({
      number: 497,
      title: 'Primary',
      headRefName: 'task/hok-1523-example',
      body: metadata(['task: HOK-1523', 'challengePairId: pair-1523']),
    });
    const options = buildTestOptions([primary]);
    options.challengeGateDeps = {
      linearSiblingLookup: async () => [],
      branchExists: async () => false,
    };
    writeWorkflowState(options.repoDir, {
      HOK_1523: { pr: 497, challengePairId: 'pair-1523', challengeRole: 'primary' },
      HOK_1523_c: { challengePairId: 'pair-1523', challengeRole: 'challenger', updated: new Date().toISOString() },
    });

    try {
      const decision = await selectNextCandidate(options);
      assert.deepEqual(decision.eligible, []);
      assert.deepEqual(
        decision.blocked.map((candidate) => [candidate.number, candidate.reason]),
        [[497, 'challenge:pair-unresolved:no-comparison']],
      );
      assert.equal(decision.nextPR, null);
    } finally {
      options.cleanup();
    }
  });

  it('blocks a primary PR when workflow state is empty but the challenger branch exists', async () => {
    const primary = pr({
      number: 497,
      title: 'Primary',
      headRefName: 'task/hok-1523-example',
      body: metadata(['task: HOK-1523']),
    });
    const options = buildTestOptions([primary]);
    options.challengeGateDeps = {
      linearSiblingLookup: async () => [],
      branchExists: async (branch) => branch === 'task/hok-1523-example-challenger',
    };

    try {
      const decision = await selectNextCandidate(options);
      assert.deepEqual(decision.eligible, []);
      assert.deepEqual(
        decision.blocked.map((candidate) => [candidate.number, candidate.reason]),
        [[497, 'challenge:pair-unresolved:branch-twin:task/hok-1523-example-challenger']],
      );
      assert.equal(decision.nextPR, null);
    } finally {
      options.cleanup();
    }
  });

  it('fails closed when a challenge lookup throws for a Wavemill PR', async () => {
    const primary = pr({
      number: 497,
      title: 'Primary',
      headRefName: 'task/hok-1523-example',
      body: metadata(['task: HOK-1523']),
    });
    const options = buildTestOptions([primary]);
    options.challengeGateDeps = {
      linearSiblingLookup: async () => {
        throw new Error('Linear unavailable');
      },
      branchExists: async () => false,
    };

    try {
      const decision = await selectNextCandidate(options);
      assert.deepEqual(decision.eligible, []);
      assert.deepEqual(
        decision.blocked.map((candidate) => [candidate.number, candidate.reason]),
        [[497, 'challenge:pair-unresolved:lookup-error:linear']],
      );
      assert.equal(decision.nextPR, null);
    } finally {
      options.cleanup();
    }
  });

  it('replays the registration race timing and only exposes the winner once comparison resolves', async () => {
    const primary = pr({
      number: 497,
      title: 'Primary',
      headRefName: 'task/hok-1523-example',
      createdAt: '2026-04-01T00:00:00Z',
      body: metadata(['task: HOK-1523']),
    });
    const challenger = pr({
      number: 501,
      title: 'Challenger',
      headRefName: 'task/hok-1523-example-challenger',
      createdAt: '2026-04-01T00:10:00Z',
      body: metadata(['task: HOK-1523_c', 'challenge: true', 'challengePairId: pair-1523']),
    });
    const options = buildTestOptions([primary], { state: 'healthy' }, {
      challenge: { autoMergeWinner: true },
    });
    options.challengeGateDeps = {
      linearSiblingLookup: async (): Promise<LinearIssueSummary[]> => [
        {
          id: 'issue-primary',
          identifier: 'HOK-1523',
          title: 'Primary issue',
          state: { name: 'In Progress' },
          completedAt: null,
          canceledAt: null,
        },
        {
          id: 'issue-challenger',
          identifier: 'HOK-1523_c',
          title: 'Challenger issue',
          state: { name: 'Backlog' },
          completedAt: null,
          canceledAt: null,
        },
      ],
      branchExists: async () => false,
    };

    try {
      let decision = await selectNextCandidate(options);
      assert.deepEqual(decision.eligible, []);
      assert.deepEqual(
        decision.blocked.map((candidate) => [candidate.number, candidate.reason]),
        [[497, 'challenge:pair-unresolved:linear-sibling:HOK-1523_c']],
      );

      writeWorkflowState(options.repoDir, {
        HOK_1523: { pr: 497, challengePairId: 'pair-1523', challengeRole: 'primary' },
        HOK_1523_c: { challengePairId: 'pair-1523', challengeRole: 'challenger', updated: new Date().toISOString() },
      });
      decision = await selectNextCandidate(options);
      assert.deepEqual(decision.eligible, []);
      assert.deepEqual(
        decision.blocked.map((candidate) => [candidate.number, candidate.reason]),
        [[497, 'challenge:pair-unresolved:no-comparison']],
      );

      options.prFetcher = async () => [primary, challenger];
      writeWorkflowState(options.repoDir, {
        HOK_1523: { pr: 497, challengePairId: 'pair-1523', challengeRole: 'primary' },
        HOK_1523_c: { pr: 501, challengePairId: 'pair-1523', challengeRole: 'challenger' },
      });
      writeChallengeComparisons(options.repoDir, [{
        challengePairId: 'pair-1523',
        primaryPrUrl: 'https://github.com/example/repo/pull/497',
        challengerPrUrl: 'https://github.com/example/repo/pull/501',
        winner: 'challenger',
        timestamp: '2026-04-28T12:00:00Z',
      }]);

      decision = await selectNextCandidate(options);
      assert.deepEqual(decision.eligible.map((candidate) => candidate.number), [501]);
      assert.deepEqual(
        decision.blocked.map((candidate) => [candidate.number, candidate.reason]),
        [[497, 'challenge:loser:pair-1523']],
      );
      assert.equal(decision.nextPR, 501);
    } finally {
      options.cleanup();
    }
  });
});

describe('challenge-gate race prevention', () => {
  it('blocks primary when challenger sibling branch exists but no workflow state', async () => {
    const primary = pr({
      number: 497,
      title: 'Primary',
      headRefName: 'task/hok-1523',
      createdAt: '2020-01-01T00:00:00Z',
    });
    const options = buildTestOptions([primary]);
    options.challengeGateOptions = {
      remoteBranches: ['task/hok-1523', 'task/hok-1523-challenger'],
      coolOffSeconds: 0,
    };

    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.nextPR, null);
      assert.equal(decision.blocked[0]?.reason, 'challenge:pair-unresolved:branch-pair');
    } finally {
      options.cleanup();
    }
  });

  it('blocks primary when challenger task is in workflow state but has no open PR', async () => {
    const primary = pr({
      number: 497,
      title: 'Primary',
      headRefName: 'task/hok-1523',
      body: metadata(['task: HOK-1523', 'challenge: true', 'challengePairId: pair-hok-1523']),
    });
    const options = buildTestOptions([primary]);
    options.challengeGateOptions = {
      remoteBranches: ['task/hok-1523'],
      coolOffSeconds: 0,
    };
    writeWorkflowState(options.repoDir, {
      HOK_1523: { pr: 497, challengePairId: 'pair-hok-1523', challengeRole: 'primary' },
      HOK_1523_c: { challengePairId: 'pair-hok-1523', challengeRole: 'challenger', updated: new Date().toISOString() },
    });

    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.nextPR, null);
      assert.equal(decision.blocked[0]?.reason, 'challenge:pair-unresolved:no-comparison');
    } finally {
      options.cleanup();
    }
  });

  it('blocks a young task PR via cool-off when no branch/workflow signal exists', async () => {
    const now = Date.parse('2026-04-01T00:03:00Z');
    const young = pr({
      number: 301,
      title: 'Young PR',
      headRefName: 'task/young',
      createdAt: '2026-04-01T00:01:00Z',
    });
    const options = buildTestOptions([young]);
    options.challengeGateOptions = {
      remoteBranches: [],
      coolOffSeconds: 300,
      nowMs: () => now,
    };

    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked[0]?.reason, 'challenge:cool-off');
    } finally {
      options.cleanup();
    }
  });

  it('allows an old task PR when no branch/workflow signal exists', async () => {
    const now = Date.parse('2026-04-01T01:00:00Z');
    const old = pr({
      number: 302,
      title: 'Old PR',
      headRefName: 'task/old',
      createdAt: '2026-04-01T00:01:00Z',
    });
    const options = buildTestOptions([old]);
    options.challengeGateOptions = {
      remoteBranches: [],
      coolOffSeconds: 300,
      nowMs: () => now,
    };

    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.eligible.length, 1);
      assert.equal(decision.nextPR, 302);
    } finally {
      options.cleanup();
    }
  });
});

describe('selectNextCandidate dependency cycles', () => {
  it('blocks a 2-cycle', async () => {
    await withDecision([
      pr({ number: 1, body: metadata(['depends_on: ["PR#2"]']) }),
      pr({ number: 2, body: metadata(['depends_on: ["PR#1"]']) }),
    ], (decision) => {
      assert.equal(decision.eligible.length, 0);
      assert.deepEqual(decision.blocked.map((candidate) => candidate.reason), ['dependency-cycle', 'dependency-cycle']);
    });
  });

  it('blocks a 3-cycle', async () => {
    await withDecision([
      pr({ number: 1, body: metadata(['depends_on: ["PR#2"]']) }),
      pr({ number: 2, body: metadata(['depends_on: ["PR#3"]']) }),
      pr({ number: 3, body: metadata(['depends_on: ["PR#1"]']) }),
    ], (decision) => {
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked.length, 3);
      assert.ok(decision.blocked.every((candidate) => candidate.reason === 'dependency-cycle'));
    });
  });

  it('blocks a self-loop', async () => {
    await withDecision([
      pr({ number: 1, body: metadata(['depends_on: ["PR#1"]']) }),
    ], (decision) => {
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked[0]?.reason, 'dependency-cycle');
    });
  });
});

describe('defaultHealthChecker', () => {
  it('fetches origin integration before reading check runs', async () => {
    const repo = createRepoWithRemoteIntegration();

    try {
      const updatedSha = createCommit(repo.seedDir, 'CHANGE.md', 'remote update\n', 'advance integration branch');
      runGit(repo.seedDir, ['push', 'origin', 'auto/integration']);
      assert.equal(runGit(repo.repoDir, ['rev-parse', 'refs/remotes/origin/auto/integration']), repo.remoteSha);

      await withFakeGh('{"check_runs":[{"name":"ci","conclusion":"success"}]}', async ({ logPath }) => {
        const health = await defaultHealthChecker('auto/integration', repo.repoDir);
        assert.deepEqual(health, { state: 'healthy' });
        assert.deepEqual(readGhApiPaths(logPath), [`repos/example/repo/commits/${updatedSha}/check-runs`]);
      });
    } finally {
      repo.cleanup();
    }
  });

  it('keeps a known sha but reports unhealthy when the pre-check fetch fails', async () => {
    const repo = createRepoWithRemoteIntegration();

    try {
      runGit(repo.repoDir, ['config', '--unset-all', `url.${repo.remoteDir}.insteadOf`]);
      runGit(repo.repoDir, ['config', 'url./tmp/wavemill-missing-remote.git.insteadOf', 'git@github.com:example/repo.git']);

      await withFakeGh('{"check_runs":[{"name":"ci","conclusion":"success"}]}', async ({ logPath }) => {
        const health = await defaultHealthChecker('auto/integration', repo.repoDir);
        assert.equal(health.state, 'unhealthy');
        assert.match(health.reason ?? '', /^health-check-refresh-failed:/);
        assert.deepEqual(readGhApiPaths(logPath), [`repos/example/repo/commits/${repo.remoteSha}/check-runs`]);
      });
    } finally {
      repo.cleanup();
    }
  });

  it('resolves origin integration when local branch is missing', async () => {
    const repo = createRepoWithRemoteIntegration();

    try {
      assert.equal(hasLocalBranch(repo.repoDir, 'auto/integration'), false);
      assert.equal(runGit(repo.repoDir, ['rev-parse', 'refs/remotes/origin/auto/integration']), repo.remoteSha);

      await withFakeGh('{"check_runs":[{"name":"ci","conclusion":"success"}]}', async ({ logPath }) => {
        const health = await defaultHealthChecker('auto/integration', repo.repoDir);
        assert.deepEqual(health, { state: 'healthy' });
        assert.deepEqual(readGhApiPaths(logPath), [`repos/example/repo/commits/${repo.remoteSha}/check-runs`]);
      });
    } finally {
      repo.cleanup();
    }
  });

  it('prefers the remote-tracking integration sha when local branch is ahead', async () => {
    const repo = createRepoWithRemoteIntegration();

    try {
      runGit(repo.repoDir, ['checkout', '-b', 'auto/integration', 'origin/auto/integration']);
      const localSha = createCommit(repo.repoDir, 'README.md', 'local integration\n', 'local branch diverges');
      runGit(repo.repoDir, ['checkout', '--detach']);

      await withFakeGh('{"check_runs":[{"name":"ci","conclusion":"success"}]}', async ({ logPath }) => {
        const health = await defaultHealthChecker('auto/integration', repo.repoDir);
        assert.deepEqual(health, { state: 'healthy' });
        assert.notEqual(localSha, repo.remoteSha);
        assert.deepEqual(readGhApiPaths(logPath), [`repos/example/repo/commits/${repo.remoteSha}/check-runs`]);
      });
    } finally {
      repo.cleanup();
    }
  });

  it('uses refreshed origin integration instead of a local-only sha', async () => {
    const repo = createRepoWithRemoteIntegration();

    try {
      runGit(repo.repoDir, ['checkout', '-b', 'auto/integration', 'origin/auto/integration']);
      const localSha = createCommit(repo.repoDir, 'README.md', 'local integration\n', 'local-only integration sha');
      runGit(repo.repoDir, ['checkout', '--detach']);
      runGit(repo.repoDir, ['update-ref', '-d', 'refs/remotes/origin/auto/integration']);

      await withFakeGh(
        '{"check_runs":[{"name":"ci","conclusion":"success"}]}',
        async ({ logPath }) => {
          const health = await defaultHealthChecker('auto/integration', repo.repoDir);
          assert.deepEqual(health, { state: 'healthy' });
          assert.deepEqual(readGhApiPaths(logPath), [`repos/example/repo/commits/${repo.remoteSha}/check-runs`]);
          assert.notEqual(localSha, repo.remoteSha);
        },
        {
          missingCommitShas: [localSha],
          createRemoteRefOnMissingCommit: {
            ref: 'refs/remotes/origin/auto/integration',
            sha: repo.remoteSha,
          },
        },
      );
    } finally {
      repo.cleanup();
    }
  });

  it('reports unhealthy health when neither local nor origin ref resolves', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-tend-health-missing-'));
    writeFileSync(
      join(repoDir, '.wavemill-config.json'),
      JSON.stringify({ integration: { integrationBranch: 'auto/integration' } }),
    );
    runGit(repoDir, ['init']);
    runGit(repoDir, ['remote', 'add', 'origin', 'git@github.com:example/repo.git']);

    try {
      const health = await defaultHealthChecker('auto/integration', repoDir);
      assert.equal(health.state, 'unhealthy');
      assert.match(health.reason ?? '', /health-check-refresh-failed/);
      assert.match(health.reason ?? '', /auto\/integration/);
      assert.match(health.reason ?? '', /refs\/remotes\/origin\/auto\/integration/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('uses the remote-tracking sha before surfacing failing checks', async () => {
    const repo = createRepoWithRemoteIntegration();

    try {
      await withFakeGh('{"check_runs":[{"name":"ci","conclusion":"failure"}]}', async ({ logPath }) => {
        const health = await defaultHealthChecker('auto/integration', repo.repoDir);
        assert.deepEqual(health, { state: 'unhealthy', reason: 'ci: failure' });
        assert.deepEqual(readGhApiPaths(logPath), [`repos/example/repo/commits/${repo.remoteSha}/check-runs`]);
      });
    } finally {
      repo.cleanup();
    }
  });

  // HOK-3009: an advisory check (OpenRouter Alias Audit by default) failing on
  // the integration tip must not halt the merge lane — the failure is
  // surfaced through advisoryFailures so the status line and
  // backstage-health.json can display it.
  it('classifies an advisory check failure as healthy with advisoryFailures surfaced', async () => {
    const repo = createRepoWithRemoteIntegration();

    try {
      clearConfigCache();
      await withFakeGh(
        '{"check_runs":[{"name":"OpenRouter Alias Audit","conclusion":"failure"},{"name":"ci","conclusion":"success"}]}',
        async () => {
          const health = await defaultHealthChecker('auto/integration', repo.repoDir);
          assert.deepEqual(health, {
            state: 'healthy',
            advisoryFailures: [{ name: 'OpenRouter Alias Audit', conclusion: 'failure' }],
          });
        },
      );
    } finally {
      clearConfigCache();
      repo.cleanup();
    }
  });

  it('reports unhealthy when a non-advisory failure is present alongside an advisory failure', async () => {
    const repo = createRepoWithRemoteIntegration();

    try {
      clearConfigCache();
      await withFakeGh(
        '{"check_runs":[{"name":"OpenRouter Alias Audit","conclusion":"failure"},{"name":"unit","conclusion":"failure"}]}',
        async () => {
          const health = await defaultHealthChecker('auto/integration', repo.repoDir);
          assert.equal(health.state, 'unhealthy');
          assert.equal(health.reason, 'unit: failure');
        },
      );
    } finally {
      clearConfigCache();
      repo.cleanup();
    }
  });

  it('omits the advisoryFailures field when the advisory check is passing', async () => {
    const repo = createRepoWithRemoteIntegration();

    try {
      clearConfigCache();
      await withFakeGh(
        '{"check_runs":[{"name":"OpenRouter Alias Audit","conclusion":"success"},{"name":"ci","conclusion":"success"}]}',
        async () => {
          const health = await defaultHealthChecker('auto/integration', repo.repoDir);
          assert.deepEqual(health, { state: 'healthy' });
        },
      );
    } finally {
      clearConfigCache();
      repo.cleanup();
    }
  });

  it('respects a repo-level advisoryChecks override', async () => {
    const repo = createRepoWithRemoteIntegration();

    try {
      // Override the default advisory list: 'OpenRouter Alias Audit' is now
      // non-advisory (should halt), 'Something Else' is advisory.
      writeFileSync(
        join(repo.repoDir, '.wavemill-config.json'),
        JSON.stringify({
          integration: {
            integrationBranch: 'auto/integration',
            advisoryChecks: ['Something Else'],
          },
        }),
      );
      clearConfigCache();

      await withFakeGh(
        '{"check_runs":[{"name":"OpenRouter Alias Audit","conclusion":"failure"}]}',
        async () => {
          const health = await defaultHealthChecker('auto/integration', repo.repoDir);
          assert.deepEqual(health, { state: 'unhealthy', reason: 'OpenRouter Alias Audit: failure' });
        },
      );

      await withFakeGh(
        '{"check_runs":[{"name":"Something Else","conclusion":"failure"},{"name":"ci","conclusion":"success"}]}',
        async () => {
          const health = await defaultHealthChecker('auto/integration', repo.repoDir);
          assert.deepEqual(health, {
            state: 'healthy',
            advisoryFailures: [{ name: 'Something Else', conclusion: 'failure' }],
          });
        },
      );
    } finally {
      clearConfigCache();
      repo.cleanup();
    }
  });

  it('dedupes repeated advisory failures by name', async () => {
    const repo = createRepoWithRemoteIntegration();

    try {
      clearConfigCache();
      await withFakeGh(
        '{"check_runs":[{"name":"OpenRouter Alias Audit","conclusion":"failure"},{"name":"OpenRouter Alias Audit","conclusion":"timed_out"}]}',
        async () => {
          const health = await defaultHealthChecker('auto/integration', repo.repoDir);
          assert.deepEqual(health, {
            state: 'healthy',
            advisoryFailures: [{ name: 'OpenRouter Alias Audit', conclusion: 'failure' }],
          });
        },
      );
    } finally {
      clearConfigCache();
      repo.cleanup();
    }
  });
});

describe('selectNextCandidate with real integration health', () => {
  it('evaluates ready PRs when only origin integration exists locally', async () => {
    const repo = createRepoWithRemoteIntegration();

    try {
      mkdirSync(join(repo.repoDir, '.wavemill', 'evals'), { recursive: true });
      const options: SelectNextCandidateOptions = {
        repoDir: repo.repoDir,
        prFetcher: async () => [
          pr({
            number: 180,
            title: 'Ready PR',
            headRefName: 'task/ready-pr',
            body: metadata(['task: HOK-1729']),
          }),
        ],
        challengeGateDeps: {
          linearSiblingLookup: async () => [],
          branchExists: async () => false,
        },
      };

      await withFakeGh('{"check_runs":[{"name":"ci","conclusion":"success"}]}', async () => {
        const decision = await selectNextCandidate(options);
        assert.deepEqual(decision.integrationHealth, { state: 'healthy' });
        assert.equal(decision.eligible.length, 1);
        assert.equal(decision.blocked.length, 0);
        assert.equal(decision.nextPR, 180);
      });
    } finally {
      repo.cleanup();
    }
  });

  // HOK-3009: an advisory-failing tip must not prevent selection of a
  // green wm:ready PR — the lane keeps merging while the drift is red.
  it('selects a green wm:ready PR when only an advisory check is failing on the tip', async () => {
    const repo = createRepoWithRemoteIntegration();

    try {
      mkdirSync(join(repo.repoDir, '.wavemill', 'evals'), { recursive: true });
      clearConfigCache();
      const options: SelectNextCandidateOptions = {
        repoDir: repo.repoDir,
        prFetcher: async () => [
          pr({
            number: 195,
            title: 'Ready PR',
            headRefName: 'task/ready-pr',
            body: metadata(['task: HOK-1729']),
          }),
        ],
        challengeGateDeps: {
          linearSiblingLookup: async () => [],
          branchExists: async () => false,
        },
      };

      await withFakeGh(
        '{"check_runs":[{"name":"OpenRouter Alias Audit","conclusion":"failure"},{"name":"ci","conclusion":"success"}]}',
        async () => {
          const decision = await selectNextCandidate(options);
          assert.equal(decision.integrationHealth.state, 'healthy');
          assert.deepEqual(decision.integrationHealth.advisoryFailures, [
            { name: 'OpenRouter Alias Audit', conclusion: 'failure' },
          ]);
          assert.equal(decision.eligible.length, 1);
          assert.equal(decision.blocked.length, 0);
          assert.equal(decision.nextPR, 195);
        },
      );
    } finally {
      clearConfigCache();
      repo.cleanup();
    }
  });
});

describe('formatStatusLine', () => {
  it('formats the dry-run status line', async () => {
    await withDecision([pr()], (decision) => {
      assert.equal(formatStatusLine(decision), 'eligible=1 blocked=0 health=ok last=none action=idle');
    });
  });

  it('includes unhealthy health reason, last merged PR, and action overrides', () => {
    assert.equal(
      formatStatusLine({
        integrationHealth: { state: 'unhealthy', reason: 'ci:\nfailure' },
        eligible: [],
        blocked: [],
        nextPR: null,
      }, { action: 'merged-#42', lastPR: 42 }),
      'eligible=0 blocked=0 health=unhealthy reason="ci: failure" last=#42 action=merged-#42',
    );
  });

  it('includes loop iteration metadata when provided', () => {
    assert.equal(
      formatStatusLine({
        integrationHealth: { state: 'healthy' },
        eligible: [candidate()],
        blocked: [],
        nextPR: 42,
      }, {
        action: 'merging-#42',
        lastPR: null,
        iteration: 3,
        pollStartedAt: '2026-08-22T14:00:00.000Z',
        pollCompletedAt: '2026-08-22T14:00:02.000Z',
      }),
      'iter=3 poll_started=2026-08-22T14:00:00.000Z poll_completed=2026-08-22T14:00:02.000Z eligible=1 blocked=0 health=ok last=none action=merging-#42',
    );
  });

  // HOK-3009: advisory failures render inline as an `advisory=` token while
  // health stays `ok`, keeping the drift condition greppable in the status
  // stream even though it does not halt the lane.
  it('renders advisory failures with health=ok and an advisory token', () => {
    assert.equal(
      formatStatusLine({
        integrationHealth: {
          state: 'healthy',
          advisoryFailures: [{ name: 'OpenRouter Alias Audit', conclusion: 'failure' }],
        },
        eligible: [],
        blocked: [],
        nextPR: null,
      }),
      'eligible=0 blocked=0 health=ok advisory="OpenRouter Alias Audit: failure" last=none action=idle',
    );
  });

  it('omits the advisory token when there are no advisory failures', () => {
    assert.equal(
      formatStatusLine({
        integrationHealth: { state: 'healthy' },
        eligible: [],
        blocked: [],
        nextPR: null,
      }),
      'eligible=0 blocked=0 health=ok last=none action=idle',
    );
  });

  it('joins multiple advisory failures with commas', () => {
    assert.equal(
      formatStatusLine({
        integrationHealth: {
          state: 'healthy',
          advisoryFailures: [
            { name: 'OpenRouter Alias Audit', conclusion: 'failure' },
            { name: 'Other Advisory', conclusion: 'timed_out' },
          ],
        },
        eligible: [],
        blocked: [],
        nextPR: null,
      }),
      'eligible=0 blocked=0 health=ok advisory="OpenRouter Alias Audit: failure, Other Advisory: timed_out" last=none action=idle',
    );
  });
});

describe('createPrFetcher', () => {
  it('retries transient gh pr list failures and preserves terminal failures', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const transient = Object.assign(new Error('Command failed: gh pr list\nHTTP 503: No server is currently available'), {
      status: 1,
      stderr: 'HTTP 503: No server is currently available',
    });
    const fetcher = createPrFetcher({
      exec: () => {
        calls += 1;
        if (calls < 3) throw transient;
        return JSON.stringify([pr()]);
      },
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 0.5,
    });

    const result = await fetcher('auto/integration', '/repo');
    assert.equal(result.length, 1);
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [2_000, 4_000]);

    const terminal = Object.assign(new Error('HTTP 404 Not Found'), { stderr: 'HTTP 404 Not Found' });
    const terminalFetcher = createPrFetcher({ exec: () => { throw terminal; }, sleep: async () => undefined });
    await assert.rejects(terminalFetcher('auto/integration', '/repo'), (error) => error === terminal);
  });

  it('does not retry non-array JSON because that is an unknown data error', async () => {
    let calls = 0;
    const fetcher = createPrFetcher({
      exec: () => {
        calls += 1;
        return '{}';
      },
      sleep: async () => undefined,
    });

    await assert.rejects(fetcher('auto/integration', '/repo'), /non-array JSON/);
    assert.equal(calls, 1);
  });
});

describe('merge transient error classification', () => {
  it('matches GitHub required-checks expected errors without depending on the count prefix', () => {
    assert.equal(
      isRequiredChecksExpectedMergeError('GraphQL: 3 of 3 required status checks are expected. (mergePullRequest)'),
      true,
    );
    assert.equal(
      isRequiredChecksExpectedMergeError('GraphQL: Required status checks are expected. (mergePullRequest)'),
      true,
    );
    assert.equal(
      isRequiredChecksExpectedMergeError('GraphQL: Head branch was modified. Review and try the merge again.'),
      false,
    );
  });
});

describe('executeMerge', () => {
  it('claims the published Ready handoff before applying wm:merging', async () => {
    const options = buildMergeTestOptions({ rebaseHeadSha: 'head-sha' });
    const featureDir = join(options.repoDir, 'features', 'handoff-pr');
    const claims: string[] = [];
    try {
      await publishReadyHandoff(featureDir, 42, 'head-sha');
      const result = await executeMerge(
        candidate({ headSha: 'head-sha', featureDir }),
        {
          repoDir: options.repoDir,
          deps: {
            ...options.deps,
            acquireMerging: (prNumber) => {
              assert.equal(readReadyTendHandoff(featureDir)?.state, 'tend-claimed');
              claims.push(`merging:${prNumber}`);
            },
          },
        },
      );
      assert.equal(result.status, 'merged');
      assert.deepEqual(claims, ['merging:42']);
      assert.equal(readReadyTendHandoff(featureDir)?.tendOwner, 'tend');
    } finally {
      options.cleanup();
    }
  });

  it('rebinds the claimed handoff to the commit pushed by Tend rebase', async () => {
    const options = buildMergeTestOptions({ rebaseHeadSha: 'rebased-head-sha' });
    const featureDir = join(options.repoDir, 'features', 'rebased-handoff-pr');
    try {
      await publishReadyHandoff(featureDir, 42, 'head-sha');
      const result = await executeMerge(
        candidate({ headSha: 'head-sha', featureDir }),
        { repoDir: options.repoDir, deps: options.deps },
      );
      assert.equal(result.status, 'merged');
      assert.equal(readReadyTendHandoff(featureDir)?.headSha, 'rebased-head-sha');
      assert.equal(readReadyTendHandoff(featureDir)?.state, 'tend-claimed');
    } finally {
      options.cleanup();
    }
  });

  it('does not enter the merge lane when the current-head Ready handoff is absent (HOK-3108)', async () => {
    // Track the injected retry ops so we can assert the budget was consulted
    // and incremented once — the pre-HOK-3108 behavior returned a generic
    // "Ready completion artifact is missing" excerpt and never touched the
    // retry budget.
    const events: string[] = [];
    const handoffClaimRetry: StrictBaseRetryOps = {
      gate: (prNumber, headSha) => { events.push(`gate:${prNumber}:${headSha}`); return 'proceed'; },
      increment: (prNumber, headSha) => { events.push(`increment:${prNumber}:${headSha}`); },
      markExhausted: (prNumber, reason) => { events.push(`exhausted:${prNumber}:${reason}`); },
      clear: (prNumber) => { events.push(`clear:${prNumber}`); },
    };
    const options = buildMergeTestOptions({ handoffClaimRetry });
    const featureDir = join(options.repoDir, 'features', 'missing-handoff');
    const stripCalls: number[] = [];
    try {
      const result = await executeMerge(
        candidate({ headSha: 'head-sha', featureDir }),
        {
          repoDir: options.repoDir,
          deps: {
            ...options.deps,
            stripUntrustedReady: (prNumber) => {
              stripCalls.push(prNumber);
            },
          },
        },
      );
      assert.equal(result.status, 'skipped');
      assert.equal(result.phase, 'handoff');
      // HOK-3108: Excerpt names the reason so the loop's log line is informative.
      assert.match(result.failureExcerpt ?? '', /no Ready handoff file/);
      assert.match(result.failureExcerpt ?? '', /\(1\/3\)/);
      // HOK-3108: Budget consulted + incremented, never marked exhausted on the first miss.
      assert.deepEqual(events, ['gate:42:head-sha', 'increment:42:head-sha']);
      assert.ok(!options.labels.includes('merging:42'));
      // HOK-3108: Critical invariant: claim on a missing handoff MUST NOT
      // create the .ready-tend-handoff.json file. A stray `checked` record
      // was what made 950 skips of PR #1519 look like a legitimate "Ready
      // still checking" state.
      assert.equal(existsSync(join(featureDir, '.ready-tend-handoff.json')), false);
      // HOK-3107: Also verify stripUntrustedReady was called when handoff claim is rejected.
      assert.deepEqual(stripCalls, [42]);
    } finally {
      options.cleanup();
    }
  });

  // HOK-3107: reproduces the PR #1513 shape — the agent added `wm:ready` while
  // the mill had no workflow-state entry for the PR, so `resolveReadyStateDir`
  // returned null and `featureDir` was undefined. The old fail-open branch let
  // tend merge such PRs on the strength of an agent-applied label. Under the
  // new guard, tend must skip and strip the untrusted label.
  it('does not merge and strips wm:ready when featureDir is missing (agent-applied label)', async () => {
    const options = buildMergeTestOptions();
    const stripCalls: number[] = [];
    try {
      const result = await executeMerge(
        candidate({ headSha: 'head-sha' }),
        {
          repoDir: options.repoDir,
          deps: {
            ...options.deps,
            stripUntrustedReady: (prNumber) => {
              stripCalls.push(prNumber);
            },
          },
        },
      );
      assert.equal(result.status, 'skipped');
      assert.equal(result.phase, 'handoff');
      assert.match(String(result.failureExcerpt), /label stripped as untrusted/i);
      assert.deepEqual(stripCalls, [42]);
      assert.ok(!options.labels.some((label) => label.startsWith('merging:')));
    } finally {
      options.cleanup();
    }
  });

  // HOK-3107: reproduces the PR #1518/#1520 shape — the agent added `wm:ready`
  // ~5 s after PR creation, before the monitor's Ready gate had run. The
  // feature dir exists, but there is no `.ready-tend-handoff.json`. Tend must
  // skip and strip the label. This test verifies stripUntrustedReady is called
  // before entering handleHandoffClaimRejection (the error message comes from
  // that rejection handler, not from our early-exit path).
  it('does not merge and strips wm:ready when handoff has never been published for the current head', async () => {
    const options = buildMergeTestOptions();
    const featureDir = join(options.repoDir, 'features', 'agent-applied-early');
    const stripCalls: number[] = [];
    // Feature dir exists but has no handoff file yet — mirrors the pre-Ready
    // window where an agent-applied label alone could have triggered a merge.
    mkdirSync(featureDir, { recursive: true });
    try {
      const result = await executeMerge(
        candidate({ headSha: 'head-sha', featureDir }),
        {
          repoDir: options.repoDir,
          deps: {
            ...options.deps,
            stripUntrustedReady: (prNumber) => {
              stripCalls.push(prNumber);
            },
          },
        },
      );
      assert.equal(result.status, 'skipped');
      assert.equal(result.phase, 'handoff');
      // HOK-3107: Verify stripUntrustedReady was called when handoff claim fails.
      assert.deepEqual(stripCalls, [42]);
      assert.ok(!options.labels.some((label) => label.startsWith('merging:')));
    } finally {
      options.cleanup();
    }
  });

  // HOK-3107: happy-path regression — when Ready has published a matching
  // handoff for the current head, tend still merges. Guards against
  // over-tightening the check.
  it('still merges when Ready published the handoff for the current head', async () => {
    const options = buildMergeTestOptions({ rebaseHeadSha: 'head-sha' });
    const featureDir = join(options.repoDir, 'features', 'happy-path-handoff');
    const stripCalls: number[] = [];
    try {
      await publishReadyHandoff(featureDir, 42, 'head-sha');
      const result = await executeMerge(
        candidate({ headSha: 'head-sha', featureDir }),
        {
          repoDir: options.repoDir,
          deps: {
            ...options.deps,
            stripUntrustedReady: (prNumber) => {
              stripCalls.push(prNumber);
            },
          },
        },
      );
      assert.equal(result.status, 'merged');
      assert.deepEqual(stripCalls, []);
    } finally {
      options.cleanup();
    }
  });

  it('rebases, pushes, waits, merges, and marks merged', async () => {
    const options = buildMergeTestOptions();
    try {
      const result = await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      assert.deepEqual(result, { status: 'merged', prNumber: 42, haltLoop: false });
      assert.ok(hasCall(options.calls, /git worktree add/));
      assert.ok(hasCall(options.calls, /git fetch origin 'auto\/integration'/));
      assert.ok(hasCall(options.calls, /git merge-base --is-ancestor 'origin\/auto\/integration' 'abc123def456'/));
      assert.ok(hasCall(options.calls, /git rebase 'origin\/auto\/integration'/));
      assert.ok(hasCall(options.calls, /git push --force-with-lease/));
      assert.ok(hasCall(options.calls, /gh pr checks 42 --json name,state,bucket 2>&1 \|\| true/));
      assert.ok(hasCall(options.calls, /gh pr merge 42 --squash/));
      assert.ok(!hasCall(options.calls, /gh pr merge 42 --squash --delete-branch/));
      assert.ok(hasCall(options.calls, /git push origin --delete 'task\/merge-me'/));
      assert.ok(hasCall(options.calls, /git worktree remove --force/));
      assert.deepEqual(options.labels, ['merging:42', 'merged:42']);
    } finally {
      options.cleanup();
    }
  });

  it('passes finite timeouts to external shell calls in the merge path', async () => {
    const options = buildMergeTestOptions();
    const callsWithoutTimeout: string[] = [];
    const shellRunner: MergeExecutionDeps['shellRunner'] = (cmd, opts) => {
      if (typeof opts?.timeout !== 'number' || opts.timeout <= 0) {
        callsWithoutTimeout.push(cmd);
      }
      const defaultRunner = options.deps.shellRunner as MergeExecutionDeps['shellRunner'];
      return defaultRunner(cmd, opts);
    };

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: { ...options.deps, shellRunner },
      });

      assert.equal(result.status, 'merged');
      assert.deepEqual(callsWithoutTimeout, []);
    } finally {
      options.cleanup();
    }
  });

  it('skips pre-merge rebase when the PR head already contains integration', async () => {
    const options = buildMergeTestOptions({
      shellRunner: (cmd) => {
        options.calls.push(cmd);
        if (cmd.includes('gh pr list --label')) return '[]';
        if (cmd.includes('git rev-parse --git-common-dir')) return join(options.repoDir, '.git');
        if (cmd.includes('git rev-parse') && cmd.includes('origin/')) return 'abc123def456';
        if (cmd.includes("git merge-base --is-ancestor 'origin/auto/integration' 'abc123def456'")) return '';
        if (cmd.includes('git rebase')) throw new Error('rebase should have been skipped');
        if (cmd.includes('--json headRefOid')) return JSON.stringify({ headRefOid: 'abc123def456' });
        if (cmd.includes('gh pr checks')) return JSON.stringify([{ name: 'ci', state: 'COMPLETED', conclusion: 'success' }]);
        return '';
      },
    });

    try {
      const result = await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      assert.deepEqual(result, { status: 'merged', prNumber: 42, haltLoop: false });
      assert.ok(hasCall(options.calls, /git merge-base --is-ancestor 'origin\/auto\/integration' 'abc123def456'/));
      assert.ok(!hasCall(options.calls, /git rebase 'origin\/auto\/integration'/));
      assert.ok(!hasCall(options.calls, /git push --force-with-lease/));
      assert.ok(hasCall(options.calls, /gh pr checks 42 --json name,state,bucket 2>&1 \|\| true/));
      assert.ok(hasCall(options.calls, /gh pr merge 42 --squash/));
      assert.ok(hasCall(options.calls, /git push origin --delete 'task\/merge-me'/));
      assert.ok(hasCall(options.calls, /git worktree remove --force/));
      assert.deepEqual(options.labels, ['merging:42', 'merged:42']);
    } finally {
      options.cleanup();
    }
  });

  it('does not block a PR whose remote head is a conflict-resolution merge commit', async () => {
    const options = buildMergeTestOptions({
      shellRunner: (cmd) => {
        options.calls.push(cmd);
        if (cmd.includes('gh pr list --label')) return '[]';
        if (cmd.includes('git rev-parse --git-common-dir')) return join(options.repoDir, '.git');
        if (cmd.includes('git rev-parse') && cmd.includes('origin/task/merge-me')) return 'mergecommit630';
        if (cmd.includes("git merge-base --is-ancestor 'origin/auto/integration' 'mergecommit630'")) return '';
        if (cmd.includes('git rebase')) {
          throw new Error('rebase would reintroduce resolved conflicts in promotion-controller files');
        }
        if (cmd.includes('--json headRefOid')) return JSON.stringify({ headRefOid: 'mergecommit630' });
        if (cmd.includes('gh pr checks')) return JSON.stringify([{ name: 'ci', state: 'COMPLETED', conclusion: 'success' }]);
        return '';
      },
    });

    try {
      const result = await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      assert.deepEqual(result, { status: 'merged', prNumber: 42, haltLoop: false });
      assert.ok(hasCall(options.calls, /git merge-base --is-ancestor 'origin\/auto\/integration' 'mergecommit630'/));
      assert.ok(!hasCall(options.calls, /git rebase 'origin\/auto\/integration'/));
      assert.equal(options.labels.includes('release-merging:42'), false);
      assert.deepEqual(options.labels, ['merging:42', 'merged:42']);
    } finally {
      options.cleanup();
    }
  });

  it('falls back to the existing rebase path when the ancestry check errors', async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    const options = buildMergeTestOptions({
      shellRunner: (cmd) => {
        options.calls.push(cmd);
        if (cmd.includes('gh pr list --label')) return '[]';
        if (cmd.includes('git rev-parse --git-common-dir')) return join(options.repoDir, '.git');
        if (cmd.includes('git rev-parse') && cmd.includes('origin/')) return 'abc123def456';
        if (cmd.includes('git merge-base --is-ancestor')) throw new Error('fatal: bad revision');
        if (cmd.includes('gh pr checks')) return JSON.stringify([{ name: 'ci', state: 'COMPLETED', conclusion: 'success' }]);
        return '';
      },
    });

    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    try {
      const result = await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      assert.deepEqual(result, { status: 'merged', prNumber: 42, haltLoop: false });
      assert.ok(hasCall(options.calls, /git merge-base --is-ancestor 'origin\/auto\/integration' 'abc123def456'/));
      assert.ok(hasCall(options.calls, /git rebase 'origin\/auto\/integration'/));
      assert.ok(hasCall(options.calls, /git push --force-with-lease/));
      assert.ok(
        warnings.some((warning) => warning.includes('pre-merge ancestry check failed')),
        'expected a warning when ancestry probing fails operationally',
      );
    } finally {
      console.warn = originalWarn;
      options.cleanup();
    }
  });

  it('uses a detached scratch worktree so it does not fight mill task worktrees', async () => {
    // Mill's task worktree at worktrees/<slug>/ already holds the PR branch
    // checked out. Tend's scratch worktree must NOT try to check it out by
    // name — git only allows a branch in one worktree at a time. The fix:
    // `git worktree add --detach <path> origin/<branch>` so HEAD is detached.
    const options = buildMergeTestOptions();
    try {
      await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      // The worktree-add command must include --detach and the origin/ ref,
      // not just the branch name.
      assert.ok(
        hasCall(options.calls, /git worktree add --detach .* 'origin\/task\/merge-me'/),
        'expected: git worktree add --detach <path> origin/<branch>',
      );

      // The PR branch must be fetched before the worktree-add so origin/<branch>
      // is fresh.
      assert.ok(
        hasCall(options.calls, /git fetch origin 'task\/merge-me'/),
        'expected: git fetch origin <branch> before scratch worktree creation',
      );

      // The push must use HEAD:<branch> syntax because we are operating from
      // a detached HEAD.
      assert.ok(
        hasCall(options.calls, /git push --force-with-lease=.* origin HEAD:'task\/merge-me'/),
        'expected: git push ... origin HEAD:<branch>',
      );

      // The legacy form (which would break on a detached HEAD) must NOT appear.
      assert.ok(
        !options.calls.some((cmd) =>
          /git push --force-with-lease=[^ ]+ origin 'task\/merge-me'/.test(cmd) &&
          !cmd.includes('HEAD:')
        ),
        'expected legacy `git push origin <branch>` form to be replaced',
      );
    } finally {
      options.cleanup();
    }
  });

  it('queries gh pr checks with bucket, not the removed conclusion field', async () => {
    // gh CLI ≥ 2.72.0 removed `conclusion` from `gh pr checks --json`'s
    // accepted fields. Asking for it now fails the whole call with
    // "Unknown JSON field: conclusion". We must request `bucket` instead
    // and synthesize a conclusion-shaped value internally.
    const options = buildMergeTestOptions();
    try {
      await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      const checksCall = options.calls.find((c) => c.startsWith('gh pr checks'));
      assert.ok(checksCall, 'expected at least one gh pr checks call');
      assert.match(checksCall, /--json [^ ]*\bbucket\b/);
      assert.ok(
        !/--json [^ ]*\bconclusion\b/.test(checksCall),
        'expected `conclusion` to no longer be requested',
      );
    } finally {
      options.cleanup();
    }
  });

  it('treats checks as passing when only bucket is present (post-2.72.0 gh shape)', async () => {
    // Simulate the new gh CLI output shape where conclusion is absent and
    // bucket carries the categorization. Without the bucket→conclusion
    // synthesis, the merge would never reach `pass` and would block on
    // the "all checks passing" gate.
    const options = buildMergeTestOptions({
      shellRunner: (cmd) => {
        const calls = options.calls;
        calls.push(cmd);
        if (cmd.includes('gh pr list --label')) return '[]';
        if (cmd.includes('git rev-parse --git-common-dir')) return join(options.repoDir, '.git');
        if (cmd.includes('git rev-parse') && cmd.includes('origin/')) return 'abc123def456';
        if (cmd.includes('--json headRefOid')) return JSON.stringify({ headRefOid: 'abc123def456' });
        if (cmd.includes('gh pr checks')) {
          // New gh shape: only `bucket` and `state`, no `conclusion`.
          return JSON.stringify([{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }]);
        }
        return '';
      },
    });
    try {
      const result = await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });
      assert.equal(result.status, 'merged');
    } finally {
      options.cleanup();
    }
  });

  it('keeps checks pending when configured required checks have not appeared', async () => {
    const calls: string[] = [];
    const result = await waitForChecks(
      42,
      '/tmp/repo',
      (cmd) => {
        calls.push(cmd);
        return JSON.stringify([{ name: 'Shell and Unit Tests', state: 'SUCCESS', bucket: 'pass' }]);
      },
      {
        timeoutMs: 0,
        requiredChecks: ['Shell and Unit Tests', 'Lifecycle Integration Tests'],
      },
    );

    assert.equal(result.outcome, 'timeout');
    assert.match(result.summary, /Shell and Unit Tests: pass/);
    assert.match(result.summary, /Missing required checks: Lifecycle Integration Tests/);
    assert.ok(calls.some((cmd) => cmd.includes('gh pr checks 42 --json name,state,bucket')));
  });

  it('waitForChecks reports liveness on every poll while CI is pending (HOK-3264)', async () => {
    // A long CI wait must keep tend's heartbeat fresh; otherwise the monitor
    // respawns tend mid-merge and strands the rebased PR without wm:ready.
    let checkPolls = 0;
    let onPollCalls = 0;
    const result = await waitForChecks(
      42,
      '/tmp/repo',
      (cmd) => {
        if (cmd.includes('--json headRefOid')) return JSON.stringify({ headRefOid: 'new000' });
        checkPolls += 1;
        return checkPolls < 4
          ? JSON.stringify([{ name: 'Shell and Unit Tests', state: 'IN_PROGRESS', bucket: 'pending' }])
          : JSON.stringify([{ name: 'Shell and Unit Tests', state: 'SUCCESS', bucket: 'pass' }]);
      },
      {
        timeoutMs: 60_000,
        pollIntervalMs: 0,
        expectedHeadSha: 'new000',
        requiredChecks: ['Shell and Unit Tests'],
        onPoll: () => {
          onPollCalls += 1;
          if (onPollCalls === 2) throw new Error('heartbeat write failed');
        },
      },
    );

    assert.equal(result.outcome, 'pass');
    assert.equal(checkPolls, 4);
    assert.equal(onPollCalls, 4, 'expected one liveness callback per poll, including after a callback throw');
  });

  it('waitForChecks passes when the head matches on every poll (regression)', async () => {
    const calls: string[] = [];
    const result = await waitForChecks(
      42,
      '/tmp/repo',
      (cmd) => {
        calls.push(cmd);
        if (cmd.includes('--json headRefOid')) return JSON.stringify({ headRefOid: 'new000' });
        return JSON.stringify([{ name: 'Shell and Unit Tests', state: 'COMPLETED', bucket: 'pass' }]);
      },
      {
        timeoutMs: 60_000,
        pollIntervalMs: 0,
        expectedHeadSha: 'new000',
        requiredChecks: ['Shell and Unit Tests'],
      },
    );

    assert.equal(result.outcome, 'pass');
    assert.ok(calls.some((cmd) => cmd.includes('gh pr view 42 --json headRefOid')));
  });

  it('waitForChecks skips a stale head\'s cancelled checks and passes on the real head (REQ-F4)', async () => {
    // The PR #1301 race: right after tend force-pushes new000, GitHub briefly
    // serves the old head old000 — whose run the HOK-2938 concurrency policy
    // has cancelled. Those CANCELLED checks must not block the wait.
    let headPolls = 0;
    let checksReadWhileMismatched = 0;
    const result = await waitForChecks(
      42,
      '/tmp/repo',
      (cmd) => {
        if (cmd.includes('--json headRefOid')) {
          headPolls += 1;
          return JSON.stringify({ headRefOid: headPolls === 1 ? 'old000' : 'new000' });
        }
        // gh pr checks: serve the superseded head's cancelled run until the
        // head settles. If the guard ever evaluated this, the wait would fail.
        if (headPolls <= 1) {
          checksReadWhileMismatched += 1;
          return JSON.stringify([{ name: 'Shell and Unit Tests', state: 'COMPLETED', bucket: 'cancel' }]);
        }
        return JSON.stringify([{ name: 'Shell and Unit Tests', state: 'COMPLETED', bucket: 'pass' }]);
      },
      {
        timeoutMs: 60_000,
        pollIntervalMs: 0,
        expectedHeadSha: 'new000',
        requiredChecks: ['Shell and Unit Tests'],
      },
    );

    assert.equal(result.outcome, 'pass');
    assert.equal(checksReadWhileMismatched, 0, 'checks must never be evaluated while the head mismatches');
  });

  it('waitForChecks returns head-changed when the head is permanently superseded', async () => {
    let checksReads = 0;
    const result = await waitForChecks(
      42,
      '/tmp/repo',
      (cmd) => {
        if (cmd.includes('--json headRefOid')) return JSON.stringify({ headRefOid: 'other999' });
        checksReads += 1;
        return JSON.stringify([{ name: 'Shell and Unit Tests', state: 'COMPLETED', bucket: 'pass' }]);
      },
      {
        timeoutMs: 60_000,
        pollIntervalMs: 0,
        expectedHeadSha: 'new000',
        requiredChecks: ['Shell and Unit Tests'],
      },
    );

    assert.equal(result.outcome, 'head-changed');
    assert.match(result.summary, /expected new000/);
    assert.match(result.summary, /observed other999/);
    assert.equal(checksReads, 0, 'another head\'s checks must never be evaluated');
  });

  it('waitForChecks fails on a cancelled check belonging to the expected head (REQ-F5)', async () => {
    const result = await waitForChecks(
      42,
      '/tmp/repo',
      (cmd) => {
        if (cmd.includes('--json headRefOid')) return JSON.stringify({ headRefOid: 'new000' });
        return JSON.stringify([{ name: 'Shell and Unit Tests', state: 'COMPLETED', bucket: 'cancel' }]);
      },
      {
        timeoutMs: 60_000,
        pollIntervalMs: 0,
        expectedHeadSha: 'new000',
        requiredChecks: ['Shell and Unit Tests'],
      },
    );

    assert.equal(result.outcome, 'fail');
    assert.match(result.summary, /Shell and Unit Tests: cancel/);
  });

  it('waitForChecks times out conservatively when the head cannot be verified', async () => {
    // A head read that stays unparseable must never produce a pass/fail
    // verdict — provenance is unknown, so the wait degrades to a timeout.
    let checksReads = 0;
    const result = await waitForChecks(
      42,
      '/tmp/repo',
      (cmd) => {
        if (cmd.includes('--json headRefOid')) return 'gh: unexpected error';
        checksReads += 1;
        return JSON.stringify([{ name: 'Shell and Unit Tests', state: 'COMPLETED', bucket: 'pass' }]);
      },
      {
        timeoutMs: 0,
        pollIntervalMs: 0,
        expectedHeadSha: 'new000',
        requiredChecks: ['Shell and Unit Tests'],
        retrySleep: async () => {},
      },
    );

    assert.equal(result.outcome, 'timeout');
    assert.match(result.summary, /Could not verify PR head/);
    assert.equal(checksReads, 0);
  });

  it('blocks and comments when rebase fails', async () => {
    const options = buildMergeTestOptions();
    const shellRunner: MergeExecutionDeps['shellRunner'] = (cmd, opts) => {
      options.calls.push(cmd);
      const defaultRunner = options.deps.shellRunner as MergeExecutionDeps['shellRunner'];
      if (cmd.includes('git rebase')) {
        throw new Error(GIT_REBASE_CONFLICT_OUTPUT);
      }
      return defaultRunner(cmd, opts);
    };

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: { ...options.deps, shellRunner },
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.phase, 'rebase');
      assert.ok(hasCall(options.calls, /gh pr comment 42 --body/));
      assert.ok(hasCall(options.calls, /Wavemill Rebase failed/));
      assert.ok(hasCall(options.calls, /git worktree remove --force/));
      assert.deepEqual(options.labels, ['merging:42', 'release-merging:42']);
    } finally {
      options.cleanup();
    }
  });

  it('records a rebase failure as a fact for deriveMergeLabel, never a wm:blocked write (HOK-3316)', async () => {
    const options = buildMergeTestOptions();
    const featureDir = join(options.repoDir, 'features', 'merge-me');
    const shellRunner: MergeExecutionDeps['shellRunner'] = (cmd, opts) => {
      options.calls.push(cmd);
      if (cmd.includes('git rebase')) {
        throw new Error(GIT_REBASE_CONFLICT_OUTPUT);
      }
      return (options.deps.shellRunner as MergeExecutionDeps['shellRunner'])(cmd, opts);
    };

    try {
      await publishReadyHandoff(featureDir, 42, 'head-sha');
      const result = await executeMerge(candidate({ headSha: 'head-sha', featureDir }), {
        repoDir: options.repoDir,
        deps: { ...options.deps, shellRunner },
      });

      assert.equal(result.status, 'blocked');
      const fact = readTendAttemptFact(featureDir);
      assert.equal(fact?.phase, 'rebase');
      assert.equal(fact?.headSha, 'head-sha');
      assert.equal(fact?.baseSha, 'abc123def456');
      assert.equal(fact?.failureClass, 'code-failure');
      assert.match(fact?.excerpt ?? '', /CONFLICT \(content\)/);
      // Lane progression only: wm:merging released, no label decision taken.
      assert.deepEqual(options.labels, ['merging:42', 'release-merging:42']);
      assert.ok(!hasCall(options.calls, WM_BLOCKED_LABEL_WRITE), 'tend must not touch wm:blocked');
    } finally {
      options.cleanup();
    }
  });

  it('replays PR #1697: one attempt, one comment and a stable tend-rebase-failed block per (head, base) (HOK-3316)', async () => {
    const { deriveMergeLabel, readMergeLabelEvidence } = await import('./merge-labels.ts');
    const options = buildMergeTestOptions();
    const featureDir = join(options.repoDir, 'features', 'merge-me');
    let integrationTip = 'base-1';
    let rebaseAttempts = 0;
    // One PR comment thread on GitHub: created once, then edited in place.
    const thread: Array<{ id: number; body: string }> = [];
    const unquote = (arg: string) => arg.replace(/^'/, '').replace(/'$/, '').replace(/'\\''/g, "'");
    const shellRunner: MergeExecutionDeps['shellRunner'] = (cmd, opts) => {
      options.calls.push(cmd);
      if (cmd.includes('git rebase') && !cmd.includes('--abort')) {
        rebaseAttempts += 1;
        throw new Error(GIT_REBASE_CONFLICT_OUTPUT);
      }
      if (cmd.includes('git rev-parse') && cmd.includes('origin/auto/integration')) return integrationTip;
      if (cmd.startsWith('gh pr view 42 --json comments')) {
        return JSON.stringify({ comments: thread.map((c) => ({ id: c.id, body: c.body, createdAt: '2026-10-22T12:51:00Z' })) });
      }
      if (cmd.startsWith('gh pr comment 42 --body ')) {
        thread.push({ id: thread.length + 1, body: unquote(cmd.slice('gh pr comment 42 --body '.length)) });
        return '';
      }
      const patch = cmd.match(/issues\/comments\/(\d+)' -f (.*)$/s);
      if (patch) {
        thread.find((c) => String(c.id) === patch[1])!.body = unquote(patch[2]).replace(/^body=/, '');
        return '';
      }
      return (options.deps.shellRunner as MergeExecutionDeps['shellRunner'])(cmd, opts);
    };
    // The incident's reconciler view: Ready passed at head, CI green, GitHub
    // says MERGEABLE (its 3-way merge is clean), handoff at head.
    const task = { prNumber: 42, headSha: 'head-sha', phase: 'ready', featureDir };
    const prView = { number: 42, labels: [] as string[], headSha: 'head-sha' };
    const derive = async () => deriveMergeLabel(task, prView, {
      prHeadSha: 'head-sha',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      integrationBaseSha: integrationTip,
      ...(await readMergeLabelEvidence(featureDir)),
    });
    const poll = async () => {
      const decision = await derive();
      if (decision.label === 'wm:ready') {
        await executeMerge(candidate({ headSha: 'head-sha', featureDir }), {
          repoDir: options.repoDir,
          deps: { ...options.deps, shellRunner },
        });
      }
      return decision;
    };

    try {
      mkdirSync(featureDir, { recursive: true });
      writeFileSync(join(featureDir, '.ready-result.json'), JSON.stringify({
        stage: 'ready',
        status: 'completed',
        artifacts: { type: 'ready', verdict: 'pass', prNumber: 42, readyHeadSha: 'head-sha' },
      }));
      await publishReadyHandoff(featureDir, 42, 'head-sha');

      const decisions = [];
      for (let tick = 0; tick < 10; tick += 1) decisions.push(await poll());
      assert.deepEqual(decisions[0], { label: 'wm:ready' });
      for (const decision of decisions.slice(1)) {
        assert.deepEqual(decision, { label: 'wm:blocked', reason: 'tend-rebase-failed' });
      }
      assert.equal(rebaseAttempts, 1, 'tend retries the same rebase against the same base exactly zero times');
      assert.equal(thread.length, 1, 'one comment, not one per poll');
      assert.equal(options.calls.filter((cmd) => cmd.startsWith('gh pr comment')).length, 1);
      // The remediation request: Ready's merge-conflict check reads the same fact.
      assert.equal(readTendAttemptFact(featureDir)?.failureClass, 'code-failure');

      // The base moves: the fact lapses, exactly one new attempt runs, and the
      // standing comment is edited in place for the new condition.
      integrationTip = 'base-2';
      const afterMove = [];
      for (let tick = 0; tick < 5; tick += 1) afterMove.push(await poll());
      assert.deepEqual(afterMove[0], { label: 'wm:ready' });
      assert.ok(afterMove.slice(1).every((decision) => decision.label === 'wm:blocked'));
      assert.equal(rebaseAttempts, 2);
      assert.equal(readTendAttemptFact(featureDir)?.baseSha, 'base-2');
      assert.equal(thread.length, 1);
      assert.match(thread[0].body, /42\|rebase\|head-sha\|base-2/);
      assert.ok(!hasCall(options.calls, WM_BLOCKED_LABEL_WRITE));
    } finally {
      options.cleanup();
    }
  });

  describe('HOK-3176: retryable in-lane failures never latch wm:blocked', () => {
    const DROPPED_PUSH = "error: RPC failed; curl 56 Recv failure: Connection reset by peer\n"
      + "fatal: unable to access 'https://github.com/timogilvie/wavemill.git/': Recv failure: Connection reset by peer";

    /** In-memory stand-in for the bounded-retry.sh bucket semantics. */
    function countingRetry(limit: number) {
      const state = { count: 0, exhaustedReason: '', gates: [] as Array<{ head: string; base?: string }> };
      const ops: StrictBaseRetryOps = {
        gate: (_pr, head, _repoDir, base) => {
          state.gates.push({ head, base });
          if (state.exhaustedReason) return 'exhausted-quiet';
          return state.count >= limit ? 'exhausted' : 'proceed';
        },
        increment: () => { state.count += 1; },
        markExhausted: (_pr, reason) => { state.exhaustedReason = reason; },
        clear: () => { state.count = 0; },
      };
      return { state, ops };
    }

    function pushFailingRunner(options: ReturnType<typeof buildMergeTestOptions>, failures: { remaining: number }) {
      const defaultRunner = options.deps.shellRunner as MergeExecutionDeps['shellRunner'];
      return ((cmd, opts) => {
        options.calls.push(cmd);
        if (cmd.includes('git push --force-with-lease') && failures.remaining > 0) {
          failures.remaining -= 1;
          throw new Error(DROPPED_PUSH);
        }
        return defaultRunner(cmd, opts);
      }) as MergeExecutionDeps['shellRunner'];
    }

    it('returns a dropped-connection push to wm:ready instead of blocking', async () => {
      const retry = countingRetry(3);
      const options = buildMergeTestOptions({ transientRetry: retry.ops });
      try {
        const result = await executeMerge(candidate(), {
          repoDir: options.repoDir,
          deps: { ...options.deps, shellRunner: pushFailingRunner(options, { remaining: 1 }) },
        });

        assert.equal(result.status, 'skipped');
        assert.equal(result.phase, 'rebase-retry-deferred');
        assert.deepEqual(options.labels, ['merging:42', 'ready:42']);
        assert.ok(!hasCall(options.calls, /gh pr comment 42/), 'a deferred retry posts no failure comment');
        assert.equal(retry.state.count, 1);
        assert.equal(retry.state.gates[0]?.base, 'abc123def456', 'retry key carries the integration tip (HOK-3103)');
      } finally {
        options.cleanup();
      }
    });

    it('dropped-connection-push replay fixture converges to merged with no wm:blocked', async () => {
      const fixture = JSON.parse(readFileSync(
        join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'incident-replay', 'dropped-connection-push.json'),
        'utf-8',
      )) as { fault: string; faultParams: { throwCount: number }; convergence: { mustMerge: boolean; maxTickCount: number } };
      assert.equal(fixture.fault, 'dropped_connection_push_rebase');

      const retry = countingRetry(3);
      const options = buildMergeTestOptions({ transientRetry: retry.ops });
      const failures = { remaining: fixture.faultParams.throwCount };
      try {
        let result: Awaited<ReturnType<typeof executeMerge>> | undefined;
        for (let tick = 0; tick < fixture.convergence.maxTickCount; tick += 1) {
          result = await executeMerge(candidate(), {
            repoDir: options.repoDir,
            deps: { ...options.deps, shellRunner: pushFailingRunner(options, failures) },
          });
          if (result.status === 'merged') break;
        }

        assert.equal(fixture.convergence.mustMerge, true);
        assert.equal(result?.status, 'merged');
        assert.ok(!options.labels.some((label) => label.startsWith('release-merging:')), `labels: ${options.labels.join(', ')}`);
        assert.equal(retry.state.exhaustedReason, '');
      } finally {
        options.cleanup();
      }
    });

    it('dropped-connection-push replay leaves one push row and one merge row, no duplicates (HOK-3183)', async () => {
      const fixture = JSON.parse(readFileSync(
        join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'incident-replay', 'dropped-connection-push.json'),
        'utf-8',
      )) as { faultParams: { throwCount: number }; convergence: { maxTickCount: number } };
      const retry = countingRetry(3);
      const options = buildMergeTestOptions({ transientRetry: retry.ops, rebaseHeadSha: 'rebased-head-sha' });
      const featureDir = join(options.repoDir, 'features', 'dropped-push-ledger');
      const ledger = Ledger.open({ dbPath: join(options.repoDir, 'ledger.sqlite') });
      setSideEffectLedgerForTesting(ledger);
      const failures = { remaining: fixture.faultParams.throwCount };
      try {
        await publishReadyHandoff(featureDir, 42, 'head-sha');
        let result: Awaited<ReturnType<typeof executeMerge>> | undefined;
        for (let tick = 0; tick < fixture.convergence.maxTickCount; tick += 1) {
          result = await executeMerge(candidate({ headSha: 'head-sha', featureDir }), {
            repoDir: options.repoDir,
            deps: { ...options.deps, shellRunner: pushFailingRunner(options, failures) },
          });
          if (result.status === 'merged') break;
        }

        assert.equal(result?.status, 'merged');
        const pushes = ledger.listSideEffectsByKind('git-push');
        assert.deepEqual(pushes.map((row) => [row.idempotency_key, row.attempt]), [
          [gitPushKey('origin', 'task/merge-me', 'rebased-head-sha'), 0],
        ], 'dropped pushes never land a row; the successful one lands exactly one');
        const merges = ledger.listSideEffectsByKind('pr-merge');
        assert.deepEqual(merges.map((row) => [row.idempotency_key, row.attempt]), [[prMergeKey(42, 'rebased-head-sha'), 0]]);
        assert.ok(merges[0].applied_at);
        assert.equal(detectDuplicates(ledger, { labelWrites: [] }).duplicates, 0);
      } finally {
        setSideEffectLedgerForTesting(null);
        ledger.close();
        options.cleanup();
      }
    });

    it('blocks with the evidence once the transient budget is exhausted', async () => {
      const retry = countingRetry(3);
      const options = buildMergeTestOptions({ transientRetry: retry.ops });
      try {
        let result: Awaited<ReturnType<typeof executeMerge>> | undefined;
        for (let tick = 0; tick < 4; tick += 1) {
          result = await executeMerge(candidate(), {
            repoDir: options.repoDir,
            deps: { ...options.deps, shellRunner: pushFailingRunner(options, { remaining: 1 }) },
          });
        }

        assert.equal(result?.status, 'blocked');
        assert.equal(result?.phase, 'rebase');
        assert.match(result?.failureExcerpt ?? '', /Connection reset by peer/);
        assert.match(result?.failureExcerpt ?? '', /deferred retries/);
        assert.match(retry.state.exhaustedReason, /rebase failure kept recurring after 3 deferred retries/);
        assert.equal(options.labels.filter((label) => label === 'release-merging:42').length, 1);
      } finally {
        options.cleanup();
      }
    });

    it('still blocks a real rebase conflict immediately (recognised code failure)', async () => {
      const retry = countingRetry(3);
      const options = buildMergeTestOptions({ transientRetry: retry.ops });
      const defaultRunner = options.deps.shellRunner as MergeExecutionDeps['shellRunner'];
      try {
        const result = await executeMerge(candidate(), {
          repoDir: options.repoDir,
          deps: {
            ...options.deps,
            shellRunner: (cmd, opts) => {
              options.calls.push(cmd);
              if (cmd.includes('git rebase')) throw new Error(GIT_REBASE_CONFLICT_OUTPUT);
              return defaultRunner(cmd, opts);
            },
          },
        });

        assert.equal(result.status, 'blocked');
        assert.equal(retry.state.gates.length, 0, 'a code failure never consults the retry budget');
      } finally {
        options.cleanup();
      }
    });

    it('retries a ready checker that threw instead of blocking', async () => {
      const retry = countingRetry(3);
      const options = buildMergeTestOptions({
        transientRetry: retry.ops,
        readyChecker: async () => { throw new Error('socket hang up'); },
      });
      try {
        const result = await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

        assert.equal(result.status, 'skipped');
        assert.equal(result.phase, 'ready-retry-deferred');
        assert.ok(!options.labels.includes('release-merging:42'));
      } finally {
        options.cleanup();
      }
    });
  });

  it('blocks when PR checks fail and does not merge', async () => {
    const options = buildMergeTestOptions({
      shellRunner: (cmd) => {
        options.calls.push(cmd);
        if (cmd.includes('gh pr list --label')) return '[]';
        if (cmd.includes('git rev-parse --git-common-dir')) return join(options.repoDir, '.git');
        if (cmd.includes('gh pr checks')) return JSON.stringify([{ name: 'ci', state: 'COMPLETED', conclusion: 'failure' }]);
        return '';
      },
    });

    try {
      const result = await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      assert.equal(result.status, 'blocked');
      assert.equal(result.phase, 'checks');
      assert.ok(!hasCall(options.calls, /gh pr merge/));
      assert.deepEqual(options.labels, ['merging:42', 'release-merging:42']);
    } finally {
      options.cleanup();
    }
  });

  it('blocks when PR checks report a failing gh bucket', async () => {
    const options = buildMergeTestOptions({
      shellRunner: (cmd) => {
        options.calls.push(cmd);
        if (cmd.includes('gh pr list --label')) return '[]';
        if (cmd.includes('git rev-parse --git-common-dir')) return join(options.repoDir, '.git');
        if (cmd.includes('gh pr checks')) return JSON.stringify([{ name: 'ci', state: 'COMPLETED', bucket: 'fail' }]);
        return '';
      },
    });

    try {
      const result = await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      assert.equal(result.status, 'blocked');
      assert.equal(result.phase, 'checks');
      assert.ok(!hasCall(options.calls, /gh pr merge/));
      assert.deepEqual(options.labels, ['merging:42', 'release-merging:42']);
    } finally {
      options.cleanup();
    }
  });

  it('blocks when the ready re-check fails', async () => {
    const options = buildMergeTestOptions({
      readyChecker: async () => ({ ready: false, reason: 'missing risk field' }),
    });

    try {
      const result = await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      assert.equal(result.status, 'blocked');
      assert.equal(result.phase, 'ready');
      assert.ok(hasCall(options.calls, /missing risk field/));
      assert.ok(!hasCall(options.calls, /gh pr merge/));
      assert.deepEqual(options.labels, ['merging:42', 'release-merging:42']);
    } finally {
      options.cleanup();
    }
  });

  it('halts after merge when integration becomes unhealthy', async () => {
    const options = buildMergeTestOptions({
      healthChecker: async () => ({ state: 'unhealthy', reason: 'ci: failure' }),
    });

    try {
      const result = await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      assert.equal(result.status, 'halted');
      assert.equal(result.haltLoop, true);
      assert.equal(result.phase, 'integration');
      assert.ok(hasCall(options.calls, /gh pr merge 42/));
      assert.ok(hasCall(options.calls, /gh pr comment 42 --body/));
      assert.deepEqual(options.labels, ['merging:42', 'merged:42']);
    } finally {
      options.cleanup();
    }
  });

  // HOK-3009: a post-merge health check returning healthy-with-advisory must
  // not halt the loop — advisory failures are surfaced but do not gate
  // merges.
  it('does not halt after merge when only advisory checks fail on the tip', async () => {
    const options = buildMergeTestOptions({
      healthChecker: async () => ({
        state: 'healthy',
        advisoryFailures: [{ name: 'OpenRouter Alias Audit', conclusion: 'failure' }],
      }),
    });

    try {
      const result = await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      assert.equal(result.status, 'merged');
      assert.equal(result.haltLoop, false);
      assert.ok(hasCall(options.calls, /gh pr merge 42/));
      assert.deepEqual(options.labels, ['merging:42', 'merged:42']);
    } finally {
      options.cleanup();
    }
  });

  it('treats remote branch deletion failure as a merged PR, not a blocked PR', async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    const options = buildMergeTestOptions({
      shellRunner: (cmd) => {
        options.calls.push(cmd);
        if (cmd.includes("git push origin --delete 'task/merge-me'")) {
          throw new Error('remote branch already deleted');
        }
        if (cmd.includes('gh pr list --label')) return '[]';
        if (cmd.includes('git rev-parse --git-common-dir')) return join(options.repoDir, '.git');
        if (cmd.includes('git rev-parse') && cmd.includes('origin/')) return 'abc123def456';
        if (cmd.includes('--json headRefOid')) return JSON.stringify({ headRefOid: 'abc123def456' });
        if (cmd.includes('gh pr checks')) return JSON.stringify([{ name: 'ci', state: 'COMPLETED', conclusion: 'success' }]);
        return '';
      },
    });

    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    try {
      const result = await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      assert.deepEqual(result, { status: 'merged', prNumber: 42, haltLoop: false });
      assert.ok(hasCall(options.calls, /gh pr merge 42 --squash/));
      assert.ok(hasCall(options.calls, /git push origin --delete 'task\/merge-me'/));
      assert.deepEqual(options.labels, ['merging:42', 'merged:42']);
      assert.ok(!options.labels.includes('release-merging:42'));
      assert.ok(warnings.some((warning) => warning.includes('post-merge remote branch cleanup failed')));
    } finally {
      console.warn = originalWarn;
      options.cleanup();
    }
  });

  it('skips branch cleanup commands when deleteBranchAfterMerge is disabled', async () => {
    const options = buildMergeTestOptions();
    writeFileSync(
      join(options.repoDir, '.wavemill-config.json'),
      JSON.stringify({
        integration: {
          integrationBranch: 'auto/integration',
          mergeMethod: 'squash',
          deleteBranchAfterMerge: false,
        },
      }),
    );

    try {
      const result = await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      assert.deepEqual(result, { status: 'merged', prNumber: 42, haltLoop: false });
      assert.ok(hasCall(options.calls, /gh pr merge 42 --squash/));
      assert.ok(!hasCall(options.calls, /--delete-branch/));
      assert.ok(!hasCall(options.calls, /git push origin --delete/));
    } finally {
      options.cleanup();
    }
  });

  it('retries a transient required-checks expected merge failure and merges without blocking', async () => {
    const options = buildMergeTestOptions();
    const sleeps: number[] = [];
    let mergeAttempts = 0;
    const shellRunner: MergeExecutionDeps['shellRunner'] = (cmd, opts) => {
      options.calls.push(cmd);
      const defaultRunner = options.deps.shellRunner as MergeExecutionDeps['shellRunner'];
      if (cmd.includes('gh pr merge 42')) {
        mergeAttempts += 1;
        if (mergeAttempts === 1) {
          const error = new Error('merge failed');
          (error as unknown as { stderr: string }).stderr = 'GraphQL: 3 of 3 required status checks are expected. (mergePullRequest)';
          throw error;
        }
        return '';
      }
      return defaultRunner(cmd, opts);
    };

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: {
          ...options.deps,
          shellRunner,
          retrySleep: async (ms) => {
            sleeps.push(ms);
          },
          currentTimeMs: () => 0,
        },
      });

      assert.deepEqual(result, { status: 'merged', prNumber: 42, haltLoop: false });
      assert.equal(mergeAttempts, 2);
      assert.deepEqual(sleeps, [30_000]);
      assert.ok(hasCall(options.calls, /gh pr view 42 --json mergeStateStatus,mergeable,statusCheckRollup,headRefOid,baseRefOid/));
      assert.deepEqual(options.labels, ['merging:42', 'merged:42']);
    } finally {
      options.cleanup();
    }
  });

  it('writes and clears the cross-process merge-retry marker while retrying a transient failure', async () => {
    const options = buildMergeTestOptions();
    let mergeAttempts = 0;
    const markerPath = mergeRetryMarkerPath(42, options.repoDir);
    let markerExistedDuringRetry = false;
    let markerUntilDuringRetry: string | null = null;
    const shellRunner: MergeExecutionDeps['shellRunner'] = (cmd, opts) => {
      options.calls.push(cmd);
      const defaultRunner = options.deps.shellRunner as MergeExecutionDeps['shellRunner'];
      if (cmd.includes('gh pr merge 42')) {
        mergeAttempts += 1;
        if (mergeAttempts === 1) {
          const error = new Error('merge failed');
          (error as unknown as { stderr: string }).stderr = 'GraphQL: 3 of 3 required status checks are expected. (mergePullRequest)';
          throw error;
        }
        return '';
      }
      return defaultRunner(cmd, opts);
    };

    try {
      // Exercise the real default writer (not a spy): observe the marker mid-retry
      // from inside retrySleep, which runs after the marker has been persisted.
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: {
          ...options.deps,
          shellRunner,
          retrySleep: async () => {
            markerExistedDuringRetry = existsSync(markerPath);
            if (markerExistedDuringRetry) {
              markerUntilDuringRetry = JSON.parse(readFileSync(markerPath, 'utf-8')).until;
            }
          },
          currentTimeMs: () => 1_000,
        },
      });

      assert.equal(result.status, 'merged');
      assert.equal(markerExistedDuringRetry, true, 'marker should exist while tend is retrying');
      // Window ends at currentTimeMs (1_000ms) + 5min retry window.
      assert.equal(markerUntilDuringRetry, new Date(1_000 + 5 * 60 * 1000).toISOString());
      assert.equal(existsSync(markerPath), false, 'marker should be cleared after the merge resolves');
    } finally {
      options.cleanup();
    }
  });

  it('blocks once with final diagnostics when transient merge retries exhaust', async () => {
    const options = buildMergeTestOptions();
    const sleeps: number[] = [];
    let mergeAttempts = 0;
    const shellRunner: MergeExecutionDeps['shellRunner'] = (cmd, opts) => {
      options.calls.push(cmd);
      const defaultRunner = options.deps.shellRunner as MergeExecutionDeps['shellRunner'];
      if (cmd.includes('gh pr merge 42')) {
        mergeAttempts += 1;
        const error = new Error('merge failed');
        (error as unknown as { stderr: string }).stderr = 'GraphQL: 3 of 3 required status checks are expected. (mergePullRequest)';
        throw error;
      }
      if (cmd.includes('gh pr checks')) {
        return JSON.stringify([
          { name: 'Shell and Unit Tests', state: 'COMPLETED', bucket: 'pass' },
          { name: 'Lifecycle Integration Tests', state: 'COMPLETED', bucket: 'pass' },
        ]);
      }
      if (cmd.includes('gh pr view 42')) {
        return JSON.stringify({
          mergeStateStatus: 'CLEAN',
          headRefOid: 'final-head-sha',
          baseRefOid: 'final-base-sha',
          statusCheckRollup: [
            { name: 'Shell and Unit Tests', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'Lifecycle Integration Tests', status: 'COMPLETED', conclusion: 'SUCCESS' },
          ],
        });
      }
      return defaultRunner(cmd, opts);
    };
    writeFileSync(
      join(options.repoDir, '.wavemill-config.json'),
      JSON.stringify({
        integration: {
          integrationBranch: 'auto/integration',
          mergeMethod: 'squash',
          requiredChecks: ['Shell and Unit Tests', 'Lifecycle Integration Tests'],
        },
      }),
    );

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: {
          ...options.deps,
          shellRunner,
          retrySleep: async (ms) => {
            sleeps.push(ms);
          },
          currentTimeMs: () => 0,
        },
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.phase, 'merge');
      assert.equal(mergeAttempts, 8);
      assert.equal(sleeps.length, 7);
      assert.deepEqual(options.labels, ['merging:42', 'release-merging:42']);
      assert.ok(hasCall(options.calls, /gh pr comment 42 --body/));
      assert.ok(hasCall(options.calls, /Exact GitHub error:/));
      assert.ok(hasCall(options.calls, /required status checks are expected/));
      assert.ok(hasCall(options.calls, /Required checks: Shell and Unit Tests, Lifecycle Integration Tests/));
      assert.ok(hasCall(options.calls, /Final mergeStateStatus: CLEAN/));
      assert.ok(hasCall(options.calls, /PR head SHA: final-head-sha/));
      assert.ok(hasCall(options.calls, /Base SHA: final-base-sha/));
      assert.ok(hasCall(options.calls, /Shell and Unit Tests: COMPLETED\/SUCCESS/));
    } finally {
      options.cleanup();
    }
  });

  it('still blocks non-transient merge failures immediately', async () => {
    const options = buildMergeTestOptions();
    const sleeps: number[] = [];
    let mergeAttempts = 0;
    const shellRunner: MergeExecutionDeps['shellRunner'] = (cmd, opts) => {
      options.calls.push(cmd);
      const defaultRunner = options.deps.shellRunner as MergeExecutionDeps['shellRunner'];
      if (cmd.includes('gh pr merge 42')) {
        mergeAttempts += 1;
        throw new Error('GraphQL: Head branch was modified. Review and try the merge again.');
      }
      return defaultRunner(cmd, opts);
    };

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: {
          ...options.deps,
          shellRunner,
          retrySleep: async (ms) => {
            sleeps.push(ms);
          },
          currentTimeMs: () => 0,
        },
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.phase, 'merge');
      assert.equal(mergeAttempts, 1);
      assert.deepEqual(sleeps, []);
      assert.ok(!hasCall(options.calls, /gh pr view 42 --json mergeStateStatus/));
      assert.deepEqual(options.labels, ['merging:42', 'release-merging:42']);
    } finally {
      options.cleanup();
    }
  });

  it('skips when another PR is already marked merging', async () => {
    const options = buildMergeTestOptions({
      shellRunner: (cmd) => {
        options.calls.push(cmd);
        if (cmd.includes('gh pr list --label')) return JSON.stringify([{ number: 7 }]);
        return '';
      },
    });

    try {
      const result = await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      assert.deepEqual(result, {
        status: 'skipped',
        prNumber: 42,
        phase: 'merge-lane-held',
        heldBy: [7],
        haltLoop: false,
      });
      assert.ok(!hasCall(options.calls, /git worktree add/));
      assert.deepEqual(options.labels, []);
    } finally {
      options.cleanup();
    }
  });

  it('retries transient merge-lane probe failures before proceeding', async () => {
    const options = buildMergeTestOptions();
    let probeAttempts = 0;
    const sleeps: number[] = [];
    const shellRunner: MergeExecutionDeps['shellRunner'] = (cmd, opts) => {
      options.calls.push(cmd);
      const defaultRunner = options.deps.shellRunner as MergeExecutionDeps['shellRunner'];
      if (cmd.includes('gh pr list --label')) {
        probeAttempts += 1;
        if (probeAttempts < 3) {
          const error = Object.assign(new Error('HTTP 503 Service Unavailable'), { stderr: 'HTTP 503 Service Unavailable' });
          throw error;
        }
      }
      return defaultRunner(cmd, opts);
    };

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: {
          ...options.deps,
          shellRunner,
          retrySleep: async (ms) => { sleeps.push(ms); },
        },
      });

      assert.equal(result.status, 'merged');
      assert.equal(probeAttempts, 3);
      assert.equal(sleeps.length, 2);
    } finally {
      options.cleanup();
    }
  });

  it('skips the cycle when merge-lane probe transient retries exhaust', async () => {
    const options = buildMergeTestOptions();
    const sleeps: number[] = [];
    const shellRunner: MergeExecutionDeps['shellRunner'] = (cmd, opts) => {
      options.calls.push(cmd);
      if (cmd.includes('gh pr list --label')) {
        throw Object.assign(new Error('HTTP 503 Service Unavailable'), { stderr: 'HTTP 503 Service Unavailable' });
      }
      const defaultRunner = options.deps.shellRunner as MergeExecutionDeps['shellRunner'];
      return defaultRunner(cmd, opts);
    };

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: {
          ...options.deps,
          shellRunner,
          retrySleep: async (ms) => { sleeps.push(ms); },
        },
      });

      assert.equal(result.status, 'skipped');
      assert.equal(result.phase, 'merge-lane-probe');
      assert.deepEqual(options.labels, []);
      assert.equal(sleeps.length, 3);
    } finally {
      options.cleanup();
    }
  });

  it('retries transient gh pr checks output instead of blocking the PR', async () => {
    const options = buildMergeTestOptions();
    let checkAttempts = 0;
    const sleeps: number[] = [];
    const shellRunner: MergeExecutionDeps['shellRunner'] = (cmd, opts) => {
      options.calls.push(cmd);
      if (cmd.includes('gh pr checks')) {
        checkAttempts += 1;
        if (checkAttempts === 1) return 'HTTP 502 Bad Gateway';
      }
      const defaultRunner = options.deps.shellRunner as MergeExecutionDeps['shellRunner'];
      return defaultRunner(cmd, opts);
    };

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: {
          ...options.deps,
          shellRunner,
          retrySleep: async (ms) => { sleeps.push(ms); },
        },
      });

      assert.equal(result.status, 'merged');
      assert.equal(checkAttempts, 2);
      assert.equal(options.labels.includes('release-merging:42'), false);
      assert.equal(sleeps.length, 1);
    } finally {
      options.cleanup();
    }
  });

  it('treats an already-merged retry response as merge success', async () => {
    const options = buildMergeTestOptions();
    let mergeAttempts = 0;
    const sleeps: number[] = [];
    const shellRunner: MergeExecutionDeps['shellRunner'] = (cmd, opts) => {
      options.calls.push(cmd);
      if (cmd.includes('gh pr merge 42')) {
        mergeAttempts += 1;
        if (mergeAttempts === 1) {
          throw Object.assign(new Error('HTTP 503 Service Unavailable'), { stderr: 'HTTP 503 Service Unavailable' });
        }
        throw Object.assign(new Error('Pull request #42 is already merged'), { stderr: 'Pull request #42 is already merged' });
      }
      const defaultRunner = options.deps.shellRunner as MergeExecutionDeps['shellRunner'];
      return defaultRunner(cmd, opts);
    };

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: {
          ...options.deps,
          shellRunner,
          retrySleep: async (ms) => { sleeps.push(ms); },
          currentTimeMs: () => 0,
        },
      });

      assert.equal(result.status, 'merged');
      assert.equal(mergeAttempts, 2);
      assert.deepEqual(options.labels, ['merging:42', 'merged:42']);
    } finally {
      options.cleanup();
    }
  });

  it('cleans up worktree on all exit paths', async () => {
    const options = buildMergeTestOptions({
      shellRunner: (cmd) => {
        options.calls.push(cmd);
        if (cmd.includes('gh pr list --label')) return '[]';
        if (cmd.includes('git rev-parse --git-common-dir')) return join(options.repoDir, '.git');
        if (cmd.includes('git rebase')) throw new Error('rebase failed');
        return '';
      },
    });

    try {
      await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      // Verify worktree was both added and removed, even though rebase failed
      assert.ok(hasCall(options.calls, /git worktree add/));
      assert.ok(hasCall(options.calls, /git worktree remove --force/));
      // Verify the remove call happened even on error path
      const addIdx = options.calls.findIndex((c) => c.includes('git worktree add'));
      const removeIdx = options.calls.findIndex((c) => c.includes('git worktree remove --force'));
      assert.ok(addIdx >= 0 && removeIdx > addIdx, 'worktree remove should happen after add');
    } finally {
      options.cleanup();
    }
  });

  it('retries a transient wm:merging release on the rebase failure path', async () => {
    const options = buildMergeTestOptions();
    const sleeps: number[] = [];
    let releaseAttempts = 0;
    const shellRunner: MergeExecutionDeps['shellRunner'] = (cmd, opts) => {
      options.calls.push(cmd);
      if (cmd.includes('git rebase')) {
        throw new Error(GIT_REBASE_CONFLICT_OUTPUT);
      }
      const defaultRunner = options.deps.shellRunner as MergeExecutionDeps['shellRunner'];
      return defaultRunner(cmd, opts);
    };

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: {
          ...options.deps,
          shellRunner,
          releaseMerging: (prNumber) => {
            releaseAttempts += 1;
            if (releaseAttempts === 1) {
              throw Object.assign(new Error('HTTP 503 Service Unavailable'), { stderr: 'HTTP 503 Service Unavailable' });
            }
            options.labels.push(`release-merging:${prNumber}`);
          },
          retrySleep: async (ms) => { sleeps.push(ms); },
        },
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.phase, 'rebase');
      assert.equal(releaseAttempts, 2);
      assert.equal(sleeps.length, 1);
      assert.deepEqual(options.labels, ['merging:42', 'release-merging:42']);
    } finally {
      options.cleanup();
    }
  });

  it('still returns blocked and warns when the wm:merging release persistently fails', async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    const options = buildMergeTestOptions();
    const shellRunner: MergeExecutionDeps['shellRunner'] = (cmd, opts) => {
      options.calls.push(cmd);
      if (cmd.includes('git rebase')) {
        throw new Error(GIT_REBASE_CONFLICT_OUTPUT);
      }
      const defaultRunner = options.deps.shellRunner as MergeExecutionDeps['shellRunner'];
      return defaultRunner(cmd, opts);
    };

    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: {
          ...options.deps,
          shellRunner,
          releaseMerging: () => {
            throw new Error('label update failed');
          },
        },
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.phase, 'rebase');
      assert.ok(
        warnings.some((warning) => warning.includes('wm:merging may be leaked')),
        'expected a leak warning when the wm:merging release exhausts retries',
      );
    } finally {
      console.warn = originalWarn;
      options.cleanup();
    }
  });

  it('warns instead of staying silent when the ready restore fails after acquisition failure', async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    const options = buildMergeTestOptions();

    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: {
          ...options.deps,
          acquireMerging: () => {
            throw new Error('label service down');
          },
          restoreReady: () => {
            throw new Error('label update failed');
          },
        },
      });

      assert.equal(result.status, 'skipped');
      assert.equal(result.phase, 'label');
      assert.ok(
        warnings.some((warning) => warning.includes('wm:merging may be leaked')),
        'expected a leak warning when the ready restore fails',
      );
    } finally {
      console.warn = originalWarn;
      options.cleanup();
    }
  });

  it('reaps stale tend worktrees before creating the scratch worktree', async () => {
    const options = buildMergeTestOptions();
    const tendDir = join(options.repoDir, '.git', 'wavemill-tend');
    mkdirSync(join(tendDir, '42'), { recursive: true });
    mkdirSync(join(tendDir, '937'), { recursive: true });
    writeFileSync(join(tendDir, '937', 'stale.txt'), 'leftover from an interrupted run');

    try {
      const result = await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });

      assert.equal(result.status, 'merged');
      assert.ok(hasCall(options.calls, /git worktree remove --force '[^']*wavemill-tend\/42'/));
      assert.ok(hasCall(options.calls, /git worktree remove --force '[^']*wavemill-tend\/937'/));
      assert.ok(hasCall(options.calls, /^git worktree prune$/));
      assert.equal(existsSync(join(tendDir, '42', 'stale.txt')), false);
      assert.equal(existsSync(join(tendDir, '937')), false, 'stale worktree directories should be deleted');
      // The reap (ending in prune) must happen before the new worktree is added.
      const pruneIdx = options.calls.findIndex((c) => c === 'git worktree prune');
      const addIdx = options.calls.findIndex((c) => c.includes('git worktree add'));
      assert.ok(pruneIdx >= 0 && addIdx > pruneIdx, 'reap should complete before worktree add');
    } finally {
      options.cleanup();
    }
  });
});

describe('merge-lane stale lock reclaim', () => {
  const NOW_MS = Date.parse('2026-08-27T12:00:00Z');

  function minutesAgo(minutes: number): string {
    return new Date(NOW_MS - minutes * 60_000).toISOString();
  }

  function eventLines(events: Array<{ name: string; at: string }>): string {
    return events.map((event) => JSON.stringify(event)).join('\n');
  }

  function laneHolderShellRunner(
    options: { calls: string[]; repoDir: string },
    holderNumber: number,
    events: string | Error,
  ): MergeExecutionDeps['shellRunner'] {
    return (cmd) => {
      options.calls.push(cmd);
      if (cmd.includes('gh pr list --label')) return JSON.stringify([{ number: holderNumber }]);
      if (cmd.includes('git remote get-url origin')) return 'git@github.com:example/repo.git';
      if (cmd.includes(`issues/${holderNumber}/events`)) {
        if (events instanceof Error) throw events;
        return events;
      }
      if (cmd.includes('git rev-parse --git-common-dir')) return join(options.repoDir, '.git');
      if (cmd.includes('git rev-parse') && cmd.includes('origin/')) return 'abc123def456';
      if (cmd.includes('git merge-base --is-ancestor')) {
        const error = new Error('Command failed: git merge-base --is-ancestor');
        (error as unknown as Record<string, unknown>).status = 1;
        throw error;
      }
      if (cmd.includes('gh pr checks')) return JSON.stringify([{ name: 'ci', state: 'COMPLETED', conclusion: 'success' }]);
      return '';
    };
  }

  it('reclaims a stale lock, posts an audit comment, and proceeds to merge', async () => {
    const options = buildMergeTestOptions();
    const shellRunner = laneHolderShellRunner(options, 99, eventLines([
      { name: WM_LABELS.ready, at: minutesAgo(120) },
      { name: WM_LABELS.merging, at: minutesAgo(70) },
    ]));

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: {
          ...options.deps,
          shellRunner,
          currentTimeMs: () => NOW_MS,
          retrySleep: async () => {},
        },
      });

      assert.deepEqual(result, { status: 'merged', prNumber: 42, haltLoop: false });
      assert.deepEqual(options.labels, ['ready-reclaim:99', 'merging:42', 'merged:42']);
      assert.ok(hasCall(options.calls, /gh pr comment 99 --body/), 'expected an audit comment on the holder PR');
      assert.ok(hasCall(options.calls, /merge-lane lock reclaimed/));
    } finally {
      options.cleanup();
    }
  });

  it('respects a fresh lock, measuring age from the latest labeled event', async () => {
    const options = buildMergeTestOptions();
    // An old application followed by a recent re-application: age must be
    // measured from the most recent acquisition, so the lock is fresh.
    const shellRunner = laneHolderShellRunner(options, 99, eventLines([
      { name: WM_LABELS.merging, at: minutesAgo(300) },
      { name: WM_LABELS.merging, at: minutesAgo(5) },
    ]));

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: {
          ...options.deps,
          shellRunner,
          currentTimeMs: () => NOW_MS,
          retrySleep: async () => {},
        },
      });

      assert.deepEqual(result, {
        status: 'skipped',
        prNumber: 42,
        phase: 'merge-lane-held',
        heldBy: [99],
        haltLoop: false,
      });
      assert.deepEqual(options.labels, []);
      assert.ok(!hasCall(options.calls, /gh pr comment/));
    } finally {
      options.cleanup();
    }
  });

  it('fails safe (keeps skipping) when the events query fails', async () => {
    const options = buildMergeTestOptions();
    const shellRunner = laneHolderShellRunner(
      options,
      99,
      Object.assign(new Error('gh api failed'), { stderr: 'HTTP 500 Internal Server Error' }),
    );

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: {
          ...options.deps,
          shellRunner,
          currentTimeMs: () => NOW_MS,
          retrySleep: async () => {},
        },
      });

      assert.deepEqual(result, {
        status: 'skipped',
        prNumber: 42,
        phase: 'merge-lane-held',
        heldBy: [99],
        haltLoop: false,
      });
      assert.deepEqual(options.labels, []);
    } finally {
      options.cleanup();
    }
  });

  it('fails safe when no merging labeled event is found', async () => {
    const options = buildMergeTestOptions();
    const shellRunner = laneHolderShellRunner(options, 99, eventLines([
      { name: WM_LABELS.ready, at: minutesAgo(300) },
    ]));

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: {
          ...options.deps,
          shellRunner,
          currentTimeMs: () => NOW_MS,
          retrySleep: async () => {},
        },
      });

      assert.equal(result.status, 'skipped');
      assert.equal(result.phase, 'merge-lane-held');
      assert.deepEqual(result.heldBy, [99]);
      assert.deepEqual(options.labels, []);
    } finally {
      options.cleanup();
    }
  });

  it('never queries events or reclaims when mergeLockTimeoutMinutes is 0', async () => {
    const options = buildMergeTestOptions();
    writeFileSync(
      join(options.repoDir, '.wavemill-config.json'),
      JSON.stringify({
        integration: {
          integrationBranch: 'auto/integration',
          mergeMethod: 'squash',
          mergeLockTimeoutMinutes: 0,
        },
      }),
    );
    const shellRunner = laneHolderShellRunner(options, 99, eventLines([
      { name: WM_LABELS.merging, at: minutesAgo(1_000) },
    ]));

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: {
          ...options.deps,
          shellRunner,
          currentTimeMs: () => NOW_MS,
          retrySleep: async () => {},
        },
      });

      assert.equal(result.status, 'skipped');
      assert.equal(result.phase, 'merge-lane-held');
      assert.deepEqual(result.heldBy, [99]);
      assert.ok(!hasCall(options.calls, /issues\/99\/events/), 'expiry disabled: the events API must not be queried');
      assert.deepEqual(options.labels, []);
    } finally {
      options.cleanup();
    }
  });

  it('keeps the holder in heldBy when the reclaim label call fails', async () => {
    const options = buildMergeTestOptions();
    const shellRunner = laneHolderShellRunner(options, 99, eventLines([
      { name: WM_LABELS.merging, at: minutesAgo(70) },
    ]));

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: {
          ...options.deps,
          shellRunner,
          reclaimStaleMerging: () => {
            throw new Error('label update failed');
          },
          currentTimeMs: () => NOW_MS,
          retrySleep: async () => {},
        },
      });

      assert.deepEqual(result, {
        status: 'skipped',
        prNumber: 42,
        phase: 'merge-lane-held',
        heldBy: [99],
        haltLoop: false,
      });
      assert.deepEqual(options.labels, []);
      assert.ok(!hasCall(options.calls, /gh pr comment/));
    } finally {
      options.cleanup();
    }
  });
});

describe('strict-base rejection classification (HOK-2919)', () => {
  it('matches the GitHub strict-mode rejection text', () => {
    assert.ok(isBasePolicyMergeError(
      'X Pull request timogilvie/wavemill#1267 is not mergeable: the base branch policy prohibits the merge.',
    ));
    assert.ok(!isBasePolicyMergeError('GraphQL: Head branch was modified. Review and try the merge again.'));
  });

  it('classifies MERGEABLE/BEHIND with green checks as stale-base', () => {
    const verdict = classifyBasePolicyRejection({
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BEHIND',
      headRefOid: 'head-1',
      statusCheckRollup: [
        { name: 'Shell and Unit Tests', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'Lifecycle Integration Tests', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
    });
    assert.equal(verdict.classification, 'stale-base');
    assert.match(verdict.detail, /BEHIND/);
  });

  it('classifies a failing required check as policy-failure even when BEHIND', () => {
    const verdict = classifyBasePolicyRejection({
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BEHIND',
      statusCheckRollup: [{ name: 'Shell and Unit Tests', status: 'COMPLETED', conclusion: 'FAILURE' }],
    });
    assert.equal(verdict.classification, 'policy-failure');
    assert.match(verdict.detail, /failingChecks=Shell and Unit Tests/);
  });

  it('classifies non-BEHIND, non-MERGEABLE, and unreadable states as policy-failure', () => {
    assert.equal(classifyBasePolicyRejection({
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [],
    }).classification, 'policy-failure');
    assert.equal(classifyBasePolicyRejection({
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      statusCheckRollup: [],
    }).classification, 'policy-failure');
    assert.equal(classifyBasePolicyRejection({ unavailableReason: 'HTTP 500' }).classification, 'policy-failure');
  });
});

function strictBaseShellRunner(options: {
  calls: string[];
  repoDir: string;
  diagnostics: object;
  mergeError?: string;
}): MergeExecutionDeps['shellRunner'] {
  return (cmd) => {
    options.calls.push(cmd);
    if (cmd.includes('gh pr list --label')) return '[]';
    if (cmd.includes('git rev-parse --git-common-dir')) return join(options.repoDir, '.git');
    if (cmd.includes('git rev-parse') && cmd.includes('origin/')) return 'abc123def456';
    if (cmd === 'git rev-parse HEAD' || cmd.includes('git rev-parse HEAD')) return 'refreshed-head-sha';
    if (cmd.includes('git merge-base --is-ancestor')) {
      const error = new Error('not an ancestor');
      (error as unknown as Record<string, unknown>).status = 1;
      throw error;
    }
    if (cmd.includes('gh pr checks')) return JSON.stringify([{ name: 'ci', state: 'COMPLETED', conclusion: 'success' }]);
    if (cmd.includes('gh pr merge 42')) {
      const error = new Error('merge failed');
      (error as unknown as { stderr: string }).stderr = options.mergeError
        ?? 'X Pull request timogilvie/wavemill#42 is not mergeable: the base branch policy prohibits the merge.';
      throw error;
    }
    if (cmd.includes('gh pr view 42 --json mergeStateStatus,mergeable')) {
      return JSON.stringify(options.diagnostics);
    }
    if (cmd.includes('--json headRefOid')) return JSON.stringify({ headRefOid: 'refreshed-head-sha' });
    return '';
  };
}

function fakeStrictBaseRetry(decision: StrictBaseRetryDecision): {
  ops: StrictBaseRetryOps;
  events: string[];
} {
  const events: string[] = [];
  return {
    events,
    ops: {
      gate: (prNumber, headSha) => {
        events.push(`gate:${prNumber}:${headSha}`);
        return decision;
      },
      increment: (prNumber, headSha) => {
        events.push(`increment:${prNumber}:${headSha}`);
      },
      markExhausted: (prNumber, reason) => {
        events.push(`exhausted:${prNumber}:${reason}`);
      },
      clear: (prNumber) => {
        events.push(`clear:${prNumber}`);
      },
    },
  };
}

describe('executeMerge strict-base refresh-and-retry (HOK-2919)', () => {
  const staleBaseDiagnostics = {
    mergeStateStatus: 'BEHIND',
    mergeable: 'MERGEABLE',
    headRefOid: 'rejected-head-sha',
    baseRefOid: 'base-sha',
    statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  };

  it('refreshes and retries a stale-base rejection instead of blocking (REQ-F1)', async () => {
    const options = buildMergeTestOptions();
    const retry = fakeStrictBaseRetry('proceed');
    const laneEvents: string[] = [];
    const shellRunner = strictBaseShellRunner({ calls: options.calls, repoDir: options.repoDir, diagnostics: staleBaseDiagnostics });

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: {
          ...options.deps,
          shellRunner,
          strictBaseRetry: retry.ops,
          recordLaneProgress: async (prNumber, event) => {
            laneEvents.push(`${event}:${prNumber}`);
          },
        },
      });

      assert.equal(result.status, 'retried');
      assert.equal(result.phase, 'stale-base-refresh');
      assert.equal(result.haltLoop, false);
      assert.match(result.failureExcerpt ?? '', /stale-base/);
      // The PR returns to wm:ready, never wm:blocked.
      assert.deepEqual(options.labels, ['merging:42', 'ready:42']);
      // Bounded-retry contract: gate then increment, keyed by the rejected head.
      assert.deepEqual(
        retry.events,
        ['gate:42:rejected-head-sha', 'increment:42:rejected-head-sha'],
      );
      // The branch was refreshed in place (a second rebase+push restarts CI).
      assert.equal(options.calls.filter((call) => /git push --force-with-lease/.test(call)).length, 2);
      assert.ok(laneEvents.includes('stale-base-refresh:42'));
      // No terminal failure comment is posted for transient staleness.
      assert.ok(!hasCall(options.calls, /gh pr comment 42/));
    } finally {
      options.cleanup();
    }
  });

  it('defers the refresh but still restores wm:ready while in backoff', async () => {
    const options = buildMergeTestOptions();
    const retry = fakeStrictBaseRetry('backoff');
    const shellRunner = strictBaseShellRunner({ calls: options.calls, repoDir: options.repoDir, diagnostics: staleBaseDiagnostics });

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: { ...options.deps, shellRunner, strictBaseRetry: retry.ops, recordLaneProgress: async () => {} },
      });

      assert.equal(result.status, 'retried');
      assert.equal(result.phase, 'stale-base-backoff');
      assert.deepEqual(options.labels, ['merging:42', 'ready:42']);
      assert.deepEqual(retry.events, ['gate:42:rejected-head-sha']);
      assert.equal(options.calls.filter((call) => /git push --force-with-lease/.test(call)).length, 1);
    } finally {
      options.cleanup();
    }
  });

  it('terminalizes with a recorded reason when the refresh budget is exhausted', async () => {
    const options = buildMergeTestOptions();
    const retry = fakeStrictBaseRetry('exhausted');
    const shellRunner = strictBaseShellRunner({ calls: options.calls, repoDir: options.repoDir, diagnostics: staleBaseDiagnostics });

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: { ...options.deps, shellRunner, strictBaseRetry: retry.ops, recordLaneProgress: async () => {} },
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.phase, 'merge');
      assert.match(result.failureExcerpt ?? '', /strict-base-refresh budget exhausted/);
      assert.deepEqual(options.labels, ['merging:42', 'release-merging:42']);
      assert.ok(retry.events.some((event) => event.startsWith('exhausted:42:')));
      assert.ok(hasCall(options.calls, /gh pr comment 42/));
    } finally {
      options.cleanup();
    }
  });

  it('still blocks a genuine policy failure with a distinguishable classifier line (REQ-F2)', async () => {
    const options = buildMergeTestOptions();
    const retry = fakeStrictBaseRetry('proceed');
    const shellRunner = strictBaseShellRunner({
      calls: options.calls,
      repoDir: options.repoDir,
      diagnostics: {
        mergeStateStatus: 'BEHIND',
        mergeable: 'MERGEABLE',
        headRefOid: 'rejected-head-sha',
        statusCheckRollup: [{ name: 'Shell and Unit Tests', status: 'COMPLETED', conclusion: 'FAILURE' }],
      },
    });

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: { ...options.deps, shellRunner, strictBaseRetry: retry.ops, recordLaneProgress: async () => {} },
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.phase, 'merge');
      assert.match(result.failureExcerpt ?? '', /policy-failure/);
      assert.match(result.failureExcerpt ?? '', /failingChecks=Shell and Unit Tests/);
      // The retry machinery is never consulted for a genuine policy failure.
      assert.deepEqual(retry.events, []);
      assert.deepEqual(options.labels, ['merging:42', 'release-merging:42']);
      assert.ok(hasCall(options.calls, /gh pr comment 42/));
      assert.ok(hasCall(options.calls, /policy-failure/));
    } finally {
      options.cleanup();
    }
  });

  it('clears the strict-base budget and records lane progress on a successful merge', async () => {
    const options = buildMergeTestOptions();
    const retry = fakeStrictBaseRetry('proceed');
    const laneEvents: string[] = [];

    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: {
          ...options.deps,
          strictBaseRetry: retry.ops,
          recordLaneProgress: async (prNumber, event) => {
            laneEvents.push(`${event}:${prNumber}`);
          },
        },
      });

      assert.equal(result.status, 'merged');
      assert.deepEqual(retry.events, ['clear:42']);
      assert.ok(laneEvents.includes('merge-attempt:42'));
      assert.ok(laneEvents.includes('rebase:42'));
      assert.ok(laneEvents.includes('ci-restart:42'));
      assert.ok(laneEvents.includes('merged:42'));
    } finally {
      options.cleanup();
    }
  });
});

describe('defaultStrictBaseRetryOps (bounded-retry.sh integration)', () => {
  it('gates, increments, terminalizes at the ceiling, and clears via the shared helper', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-strict-retry-'));
    try {
      assert.equal(defaultStrictBaseRetryOps.gate(7, 'aaaa1111', repoDir), 'proceed');
      for (let attempt = 0; attempt < 4; attempt += 1) {
        defaultStrictBaseRetryOps.increment(7, 'aaaa1111', repoDir);
      }
      assert.equal(defaultStrictBaseRetryOps.gate(7, 'aaaa1111', repoDir), 'exhausted');
      defaultStrictBaseRetryOps.markExhausted(7, 'strict-base-refresh budget exhausted', repoDir);
      assert.equal(defaultStrictBaseRetryOps.gate(7, 'aaaa1111', repoDir), 'exhausted-quiet');
      const sentinel = join(repoDir, '.wavemill', 'merge-lane', '7', '.retry-strict-base-refresh-exhausted');
      assert.match(readFileSync(sentinel, 'utf-8'), /budget exhausted/);
      // A new head resets the budget, including the terminal sentinel.
      assert.equal(defaultStrictBaseRetryOps.gate(7, 'bbbb2222', repoDir), 'proceed');
      assert.ok(!existsSync(sentinel));
      defaultStrictBaseRetryOps.increment(7, 'bbbb2222', repoDir);
      defaultStrictBaseRetryOps.clear(7, repoDir);
      assert.equal(defaultStrictBaseRetryOps.gate(7, 'bbbb2222', repoDir), 'proceed');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('executeMerge handoff-claim budget (HOK-3108)', () => {
  function makeRetry(decision: StrictBaseRetryDecision): { ops: StrictBaseRetryOps; events: string[] } {
    const events: string[] = [];
    return {
      events,
      ops: {
        gate: (prNumber, headSha) => { events.push(`gate:${prNumber}:${headSha}`); return decision; },
        increment: (prNumber, headSha) => { events.push(`increment:${prNumber}:${headSha}`); },
        markExhausted: (prNumber, reason) => { events.push(`exhausted:${prNumber}:${reason}`); },
        clear: (prNumber) => { events.push(`clear:${prNumber}`); },
      },
    };
  }

  it('proceed: skips, increments, and includes a per-attempt hint in the excerpt', async () => {
    const { ops, events } = makeRetry('proceed');
    const options = buildMergeTestOptions({ handoffClaimRetry: ops });
    const featureDir = join(options.repoDir, 'features', 'missing-handoff-proceed');
    try {
      const result = await executeMerge(
        candidate({ headSha: 'head-sha', featureDir }),
        { repoDir: options.repoDir, deps: options.deps },
      );
      assert.equal(result.status, 'skipped');
      assert.equal(result.phase, 'handoff');
      assert.match(result.failureExcerpt ?? '', /Tend claim rejected/);
      assert.match(result.failureExcerpt ?? '', /no Ready handoff file/);
      assert.deepEqual(events, ['gate:42:head-sha', 'increment:42:head-sha']);
      // No labels change on a skipped result.
      assert.deepEqual(options.labels, []);
    } finally {
      options.cleanup();
    }
  });

  it('exhausted: markExhausted, block, wm:blocked, comment names the missing handoff', async () => {
    const { ops, events } = makeRetry('exhausted');
    const options = buildMergeTestOptions({ handoffClaimRetry: ops });
    const featureDir = join(options.repoDir, 'features', 'missing-handoff-exhausted');
    try {
      const result = await executeMerge(
        candidate({ headSha: 'head-sha', featureDir }),
        { repoDir: options.repoDir, deps: options.deps },
      );
      assert.equal(result.status, 'blocked');
      assert.equal(result.phase, 'handoff');
      assert.match(result.failureExcerpt ?? '', /wm:ready without a published Ready handoff for head head-sha/);
      // Labels: block only. wm:merging is never applied.
      assert.deepEqual(options.labels, ['release-merging:42']);
      assert.ok(events.some((event) => event.startsWith('exhausted:42:')));
      // A failure comment is posted with the diagnostic text.
      assert.ok(options.calls.some((cmd) => /gh pr comment 42/.test(cmd)));
      // Critical: HOK-3105's tend-handoff-block sentinel MUST NOT be written
      // for this path. If it were, the self-heal would clear wm:blocked and
      // the loop would come back two polls later.
      assert.equal(
        existsSync(join(mergeLaneStateDir(42, options.repoDir), 'tend-handoff-block.json')),
        false,
      );
    } finally {
      options.cleanup();
    }
  });

  it('exhausted-quiet: block without re-marking exhausted', async () => {
    const { ops, events } = makeRetry('exhausted-quiet');
    const options = buildMergeTestOptions({ handoffClaimRetry: ops });
    const featureDir = join(options.repoDir, 'features', 'missing-handoff-quiet');
    try {
      const result = await executeMerge(
        candidate({ headSha: 'head-sha', featureDir }),
        { repoDir: options.repoDir, deps: options.deps },
      );
      assert.equal(result.status, 'blocked');
      assert.equal(result.phase, 'handoff');
      assert.ok(!events.some((event) => event.startsWith('exhausted:42:')));
      assert.deepEqual(options.labels, ['release-merging:42']);
    } finally {
      options.cleanup();
    }
  });

  it('fail-closed: a gate that throws blocks with the gate error appended', async () => {
    const options = buildMergeTestOptions({
      handoffClaimRetry: {
        gate: () => { throw new Error('bash: bounded-retry.sh not found'); },
        increment: () => {},
        markExhausted: () => {},
        clear: () => {},
      },
    });
    const featureDir = join(options.repoDir, 'features', 'missing-handoff-gate-fail');
    try {
      const result = await executeMerge(
        candidate({ headSha: 'head-sha', featureDir }),
        { repoDir: options.repoDir, deps: options.deps },
      );
      assert.equal(result.status, 'blocked');
      assert.equal(result.phase, 'handoff');
      assert.match(result.failureExcerpt ?? '', /bounded-retry.sh not found/);
      assert.match(result.failureExcerpt ?? '', /wm:ready without a published Ready handoff/);
    } finally {
      options.cleanup();
    }
  });

  it('successful claim clears the handoff-claim budget', async () => {
    const { ops, events } = makeRetry('proceed');
    const options = buildMergeTestOptions({ handoffClaimRetry: ops, rebaseHeadSha: 'head-sha' });
    const featureDir = join(options.repoDir, 'features', 'handoff-claim-clear');
    try {
      // A published handoff means the claim succeeds; the budget clear must
      // fire so a later same-head relabel starts fresh.
      await import('./ready-tend-handoff.ts').then(({ publishReadyHandoff }) => publishReadyHandoff(featureDir, 42, 'head-sha'));
      const result = await executeMerge(
        candidate({ headSha: 'head-sha', featureDir }),
        { repoDir: options.repoDir, deps: options.deps },
      );
      assert.equal(result.status, 'merged');
      assert.ok(events.includes('clear:42'), `expected clear in events=${events.join(',')}`);
    } finally {
      options.cleanup();
    }
  });

  it('bounded-retry integration: proceed×3 then blocked; a new head SHA resets the budget', async () => {
    // Real bounded-retry.sh + wm:ready without a handoff → three skips at
    // (1/3), (2/3), (3/3), then a fourth call blocks and writes the
    // exhausted sentinel. A fifth gate on a NEW head resets it.
    //
    // `sanitizeHeadShaForRetryKey` requires the head to match a hex regex
    // for it to be persisted into the head file (so a bad head cannot fake
    // a reset). Use hex-only SHAs here.
    const HEAD_A = 'aaaa1111bbbb2222';
    const HEAD_B = 'cccc3333dddd4444';
    const options = buildMergeTestOptions({ handoffClaimRetry: defaultHandoffClaimRetryOps });
    const featureDir = join(options.repoDir, 'features', 'bounded-retry-real');
    const runMerge = async (head: string) => executeMerge(
      candidate({ headSha: head, featureDir }),
      { repoDir: options.repoDir, deps: { ...options.deps, shellRunner: (cmd, opts) => {
        if (cmd.includes('gh pr view')) {
          return JSON.stringify({ mergeStateStatus: 'CLEAN', headRefOid: head, baseRefOid: 'base' });
        }
        return (options.deps.shellRunner as MergeExecutionDeps['shellRunner'])(cmd, opts);
      } } },
    );
    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const result = await runMerge(HEAD_A);
        assert.equal(result.status, 'skipped', `attempt ${attempt} should skip`);
        assert.match(result.failureExcerpt ?? '', new RegExp(`\\(${attempt}/3\\)`));
      }
      const fourth = await runMerge(HEAD_A);
      assert.equal(fourth.status, 'blocked', 'fourth attempt should block');
      const sentinel = join(mergeLaneStateDir(42, options.repoDir), '.retry-handoff-claim-exhausted');
      assert.ok(existsSync(sentinel), 'exhausted sentinel must exist');
      assert.match(readFileSync(sentinel, 'utf-8'), /handoff-claim rejected/);
      // A new head SHA resets the budget. We can't call executeMerge again
      // because the PR is already labelled blocked — bypass and call the
      // retry ops directly to exercise the reset.
      assert.equal(defaultHandoffClaimRetryOps.gate(42, HEAD_B, options.repoDir), 'proceed');
      assert.equal(existsSync(sentinel), false, 'a new head must clear the sentinel');
    } finally {
      options.cleanup();
    }
  });
});

describe('mill/tend disagreement (HOK-2919)', () => {
  it('emits a mill/tend disagreement finding when the mill holds a blocked PR as a merge candidate (REQ-F5)', async () => {
    const options = buildTestOptions([
      pr({ labels: [label(WM_LABELS.wavemill)] }),
    ]);
    writeReadyResult(options.repoDir, 'HOK-1437', {
      stage: 'ready',
      status: 'completed',
      artifacts: {
        type: 'ready',
        verdict: 'pass',
        prNumber: 1,
        queueState: 'merge-candidate',
        lastCiSummary: 'pass: 16/3 checks',
        lastCiHeadSha: 'head-current',
      },
    });

    try {
      const decision = await selectNextCandidate(options);
      // Blocked because wm:ready is missing — while the mill calls it a candidate.
      // HOK-3242: the reason now carries the reconciler's specific no-label
      // reason (`no-task-view` here, since no workflow-state is seeded)
      // instead of the generic `not-ready`.
      assert.equal(decision.blocked[0]?.reason, 'ready-failed:no-task-view');
      assert.deepEqual(decision.blocked[0]?.labels, ['wavemill']);
      const findings = readFileSync(join(options.repoDir, '.wavemill', 'observer-findings.jsonl'), 'utf-8');
      assert.match(findings, /Mill and tend disagree on PR #1 merge candidacy/);
      assert.match(findings, /ready-failed:no-task-view/);
      assert.match(findings, /pass: 16\/3 checks/);
    } finally {
      options.cleanup();
    }
  });
});

describe('executeMerge worktree-prep timeout (HOK-3039)', () => {
  function makeTimeoutRunner(phase: 'reap' | 'fetch' | 'add'): () => ScratchPrepRunner {
    return () => ({
      remainingDeadlineMs: () => 0,
      run: (cmd, opts) => {
        if (opts.phase !== phase) {
          // Let earlier prep phases succeed.
          return Promise.resolve('');
        }
        return Promise.reject(new WorktreePrepTimeoutError({
          phase,
          elapsedMs: 42,
          output: `simulated ${cmd}`,
        }));
      },
    });
  }

  it('returns wm:ready and skipped when the first prep timeout fits in the recovery budget', async () => {
    let gateCalls = 0;
    const scratchPrepRetry: StrictBaseRetryOps = {
      gate: () => { gateCalls += 1; return 'proceed'; },
      increment: () => {},
      markExhausted: () => { throw new Error('markExhausted should not be called on the first timeout'); },
      clear: () => {},
    };
    const options = buildMergeTestOptions({
      prepRunnerFactory: makeTimeoutRunner('add'),
      scratchPrepRetry,
    });
    const featureDir = join(options.repoDir, 'features', 'prep-timeout-first');
    await publishReadyHandoff(featureDir, 42, 'head-first-timeout');
    // Handoff guard reads GitHub's live head to validate it matches the
    // selection's headSha before claiming ownership.
    const shellRunnerRef: MergeExecutionDeps['shellRunner'] = (cmd, opts) => {
      if (cmd.includes('gh pr view')) {
        return JSON.stringify({
          mergeStateStatus: 'CLEAN',
          headRefOid: 'head-first-timeout',
          baseRefOid: 'base-sha',
          statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        });
      }
      return (options.deps.shellRunner as MergeExecutionDeps['shellRunner'])(cmd, opts);
    };
    try {
      const result = await executeMerge(
        candidate({ headSha: 'head-first-timeout', featureDir }),
        { repoDir: options.repoDir, deps: { ...options.deps, shellRunner: shellRunnerRef } },
      );
      assert.equal(result.status, 'skipped');
      assert.equal(result.phase, 'worktree-timeout');
      assert.match(String(result.failureExcerpt), /worktree-prep-timeout phase=add/);
      // Ready restored on the way out — the incident should NOT terminally block.
      assert.ok(options.labels.includes('ready:42'), `labels=${options.labels.join(',')}`);
      assert.ok(!options.labels.includes('release-merging:42'));
      assert.equal(gateCalls, 1);
      // Marker cleared on the recovery path so the next Tend loop starts clean.
      assert.ok(!existsSync(scratchPrepMarkerPath(42, options.repoDir)));
    } finally {
      options.cleanup();
    }
  });

  it('blocks the PR when scratch-prep recovery is exhausted at the same head', async () => {
    let markExhaustedCalled = false;
    const scratchPrepRetry: StrictBaseRetryOps = {
      gate: () => 'exhausted',
      increment: () => {},
      markExhausted: () => { markExhaustedCalled = true; },
      clear: () => {},
    };
    const options = buildMergeTestOptions({
      prepRunnerFactory: makeTimeoutRunner('add'),
      scratchPrepRetry,
    });
    const featureDir = join(options.repoDir, 'features', 'prep-timeout-exhausted');
    await publishReadyHandoff(featureDir, 42, 'head-exhausted');
    const shellRunnerRef: MergeExecutionDeps['shellRunner'] = (cmd, opts) => {
      if (cmd.includes('gh pr view')) {
        return JSON.stringify({
          mergeStateStatus: 'CLEAN',
          headRefOid: 'head-exhausted',
          baseRefOid: 'base-sha',
          statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        });
      }
      return (options.deps.shellRunner as MergeExecutionDeps['shellRunner'])(cmd, opts);
    };
    try {
      const result = await executeMerge(
        candidate({ headSha: 'head-exhausted', featureDir }),
        { repoDir: options.repoDir, deps: { ...options.deps, shellRunner: shellRunnerRef } },
      );
      assert.equal(result.status, 'blocked');
      assert.equal(result.phase, 'worktree-timeout');
      assert.match(String(result.failureExcerpt), /scratch-prep-recovery budget exhausted/);
      assert.ok(options.labels.includes('release-merging:42'), `labels=${options.labels.join(',')}`);
      assert.ok(markExhaustedCalled);
    } finally {
      options.cleanup();
    }
  });

  it('never leaves the marker after a normal merge lifecycle', async () => {
    const options = buildMergeTestOptions();
    try {
      const result = await executeMerge(candidate(), { repoDir: options.repoDir, deps: options.deps });
      assert.equal(result.status, 'merged');
      assert.ok(!existsSync(scratchPrepMarkerPath(42, options.repoDir)));
    } finally {
      options.cleanup();
    }
  });

  it('invokes onPhaseProgress for each scratch-prep phase during a normal merge', async () => {
    const options = buildMergeTestOptions();
    const phases: string[] = [];
    try {
      const result = await executeMerge(candidate(), {
        repoDir: options.repoDir,
        deps: options.deps,
        onPhaseProgress: async ({ phase }) => { phases.push(phase); },
      });
      assert.equal(result.status, 'merged');
      // We expect reap, fetch, add, and ready — the safe prep phases — in order.
      assert.deepEqual(
        phases.filter((p) => p !== 'heartbeat').slice(0, 4),
        ['reap', 'fetch', 'add', 'ready'],
      );
      // HOK-3264: the post-push CI wait reports progress too.
      assert.ok(phases.includes('checks-wait'), `expected a checks-wait phase, got ${phases.join(',')}`);
    } finally {
      options.cleanup();
    }
  });
});

describe('reconcileScratchPrepState (HOK-3039)', () => {
  it('returns none when no markers are present', async () => {
    const options = buildMergeTestOptions();
    try {
      const outcomes = await reconcileScratchPrepState(options.repoDir, options.deps);
      assert.deepEqual(outcomes, []);
    } finally {
      options.cleanup();
    }
  });

  it('refuses to touch a marker whose owning pid is still alive (active-run guard)', async () => {
    const options = buildMergeTestOptions();
    try {
      await writeScratchPrepMarker(options.repoDir, {
        prNumber: 42,
        headBranch: 'task/merge-me',
        phase: 'push',
        pid: process.pid, // We are the "live" owner.
        prePushSha: 'pre-sha',
        rebasedHeadSha: 'rebased-sha',
      });
      const outcomes = await reconcileScratchPrepState(options.repoDir, options.deps);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].kind, 'active-run');
      assert.equal((outcomes[0] as { prNumber: number }).prNumber, 42);
      // Marker not cleared, labels not touched.
      assert.ok(existsSync(scratchPrepMarkerPath(42, options.repoDir)));
      assert.deepEqual(options.labels, []);
    } finally {
      options.cleanup();
    }
  });

  it('recovers a safe-phase marker with a dead owner by cleaning + restoring wm:ready', async () => {
    let incrementCalled = false;
    const scratchPrepRetry: StrictBaseRetryOps = {
      gate: () => 'proceed',
      increment: () => { incrementCalled = true; },
      markExhausted: () => {},
      clear: () => {},
    };
    const options = buildMergeTestOptions({ scratchPrepRetry });
    try {
      await writeScratchPrepMarker(options.repoDir, {
        prNumber: 77,
        headBranch: 'task/dead-owner',
        phase: 'add',
        headSha: 'head-77',
        pid: 999_999, // Not this process; treated as dead.
      });
      const outcomes = await reconcileScratchPrepState(options.repoDir, options.deps);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].kind, 'recovered-retryable');
      assert.ok(!existsSync(scratchPrepMarkerPath(77, options.repoDir)));
      assert.ok(options.labels.includes('ready:77'));
      assert.ok(incrementCalled);
    } finally {
      options.cleanup();
    }
  });

  it('recovers a push marker whose origin already matches the pushed head', async () => {
    const options = buildMergeTestOptions({
      shellRunner: (cmd) => {
        options.calls.push(cmd);
        if (cmd.includes('git fetch origin')) return '';
        if (cmd.includes('git rev-parse') && cmd.includes('origin/')) return 'rebased-sha';
        return '';
      },
    });
    try {
      await writeScratchPrepMarker(options.repoDir, {
        prNumber: 88,
        headBranch: 'task/push-recovered',
        phase: 'push',
        headSha: 'head-88',
        prePushSha: 'pre-sha',
        rebasedHeadSha: 'rebased-sha',
        pid: 999_999,
      });
      const outcomes = await reconcileScratchPrepState(options.repoDir, options.deps);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].kind, 'recovered-pushed');
      assert.ok(options.labels.includes('ready:88'));
      assert.ok(!existsSync(scratchPrepMarkerPath(88, options.repoDir)));
    } finally {
      options.cleanup();
    }
  });

  it('rebinds the Tend handoff when recovering a push that landed before a crash', async () => {
    const options = buildMergeTestOptions({
      shellRunner: (cmd) => {
        if (cmd.includes('git rev-parse') && cmd.includes('origin/')) return 'rebased-sha';
        if (cmd.includes('gh pr view')) return JSON.stringify({ headRefOid: 'rebased-sha', mergeStateStatus: 'CLEAN' });
        return '';
      },
    });
    const featureDir = join(options.repoDir, 'features', 'push-recovered');
    try {
      await publishReadyHandoff(featureDir, 88, 'pre-sha');
      await claimReadyHandoff(featureDir, 88, 'pre-sha');
      await writeScratchPrepMarker(options.repoDir, {
        prNumber: 88,
        headBranch: 'task/push-recovered',
        featureDir,
        phase: 'push',
        headSha: 'pre-sha',
        prePushSha: 'pre-sha',
        rebasedHeadSha: 'rebased-sha',
        pid: 999_999,
      });
      const outcomes = await reconcileScratchPrepState(options.repoDir, options.deps);
      assert.equal(outcomes[0]?.kind, 'recovered-pushed');
      assert.equal(readReadyTendHandoff(featureDir)?.headSha, 'rebased-sha');
      assert.ok(options.labels.includes('ready:88'));
    } finally {
      options.cleanup();
    }
  });

  it('holds a push marker as recovery-uncertain when origin matches neither pre nor rebased', async () => {
    const options = buildMergeTestOptions({
      shellRunner: (cmd) => {
        options.calls.push(cmd);
        if (cmd.includes('git fetch origin')) return '';
        if (cmd.includes('git rev-parse') && cmd.includes('origin/')) return 'unrelated-third-party-sha';
        return '';
      },
    });
    try {
      await writeScratchPrepMarker(options.repoDir, {
        prNumber: 99,
        headBranch: 'task/push-uncertain',
        phase: 'push',
        prePushSha: 'pre-sha',
        rebasedHeadSha: 'rebased-sha',
        pid: 999_999,
      });
      const outcomes = await reconcileScratchPrepState(options.repoDir, options.deps);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].kind, 'recovery-uncertain');
      // Fail-closed: no label changes, marker still present, retained reason recorded.
      assert.deepEqual(options.labels, []);
      const marker = readScratchPrepMarker(options.repoDir, 99);
      assert.ok(marker);
      assert.ok(marker?.retained?.reason.includes('push-recovery-uncertain'));
    } finally {
      options.cleanup();
    }
  });

  it('recovers a push marker as safe when origin still points at the pre-push SHA', async () => {
    const options = buildMergeTestOptions({
      shellRunner: (cmd) => {
        options.calls.push(cmd);
        if (cmd.includes('git fetch origin')) return '';
        if (cmd.includes('git rev-parse') && cmd.includes('origin/')) return 'pre-sha';
        return '';
      },
    });
    try {
      await writeScratchPrepMarker(options.repoDir, {
        prNumber: 55,
        headBranch: 'task/push-never-landed',
        phase: 'push',
        headSha: 'head-55',
        prePushSha: 'pre-sha',
        rebasedHeadSha: 'rebased-sha',
        pid: 999_999,
      });
      const outcomes = await reconcileScratchPrepState(options.repoDir, options.deps);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].kind, 'recovered-retryable');
      assert.ok(options.labels.includes('ready:55'));
      assert.ok(!existsSync(scratchPrepMarkerPath(55, options.repoDir)));
    } finally {
      options.cleanup();
    }
  });

  it('is idempotent: reconciling twice over the same dead marker leaves no state', async () => {
    const options = buildMergeTestOptions();
    try {
      await writeScratchPrepMarker(options.repoDir, {
        prNumber: 200,
        headBranch: 'task/idempotent',
        phase: 'ready',
        pid: 999_999,
      });
      const first = await reconcileScratchPrepState(options.repoDir, options.deps);
      assert.equal(first[0].kind, 'recovered-retryable');
      const second = await reconcileScratchPrepState(options.repoDir, options.deps);
      assert.deepEqual(second, []); // marker cleared after first pass
    } finally {
      options.cleanup();
    }
  });
});

describe('executeMerge handoff-rebind lag (HOK-3105)', () => {
  /**
   * Build a shell runner that behaves like the default one but lets the test
   * control what `gh pr view` returns on the *post-push* poll — the read that
   * exercises the HOK-3105 convergence loop.
   */
  function buildRebindShellRunner(args: {
    repoDir: string;
    calls: string[];
    initialHeadSha: string;
    pushedSha: string;
    postPushHeadFor: (callIndex: number) => string;
  }): MergeExecutionDeps['shellRunner'] {
    let rebasedPush = false;
    let postPushViewCalls = 0;
    return (cmd) => {
      args.calls.push(cmd);
      if (cmd.includes('git push --force-with-lease')) rebasedPush = true;
      if (cmd.includes('gh pr list --label')) return '[]';
      if (cmd.includes('git rev-parse --git-common-dir')) return join(args.repoDir, '.git');
      if (cmd === 'git rev-parse HEAD') return args.pushedSha;
      if (cmd.includes('git rev-parse') && cmd.includes('origin/')) return 'pre-push-sha';
      if (cmd.includes('git merge-base --is-ancestor')) {
        const e = new Error('Command failed: git merge-base --is-ancestor');
        (e as unknown as Record<string, unknown>).status = 1;
        throw e;
      }
      if (cmd.includes('gh pr checks')) {
        return JSON.stringify([{ name: 'ci', state: 'COMPLETED', conclusion: 'success' }]);
      }
      if (cmd.includes('gh pr comment')) return '';
      if (cmd.includes('gh pr view')) {
        if (!rebasedPush) {
          return JSON.stringify({
            mergeStateStatus: 'CLEAN',
            headRefOid: args.initialHeadSha,
            baseRefOid: 'base-sha',
            statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
          });
        }
        postPushViewCalls += 1;
        return JSON.stringify({
          mergeStateStatus: 'CLEAN',
          headRefOid: args.postPushHeadFor(postPushViewCalls),
          baseRefOid: 'base-sha',
          statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        });
      }
      return '';
    };
  }

  it('succeeds when the pushed head appears after two stale reads (backoff poll converges)', async () => {
    const pushedSha = 'rebased-head-sha';
    const initialHeadSha = 'head-sha';
    const options = buildMergeTestOptions({ rebaseHeadSha: pushedSha });
    const shellRunner = buildRebindShellRunner({
      repoDir: options.repoDir,
      calls: options.calls,
      initialHeadSha,
      pushedSha,
      // rebindPushedTendHead is called with previousHeadSha=candidate.headSha
      // (= initialHeadSha), so the "still returning the pre-push head" lag we
      // simulate must return `initialHeadSha` — not any other pre-push SHA.
      postPushHeadFor: (i) => (i <= 2 ? initialHeadSha : pushedSha),
    });

    const sleeps: number[] = [];
    const retrySleep = async (ms: number) => { sleeps.push(ms); };

    const featureDir = join(options.repoDir, 'features', 'lag-converge');
    try {
      await publishReadyHandoff(featureDir, 42, initialHeadSha);
      const result = await executeMerge(
        candidate({ headSha: initialHeadSha, featureDir }),
        {
          repoDir: options.repoDir,
          deps: { ...options.deps, shellRunner, retrySleep },
        },
      );

      assert.equal(result.status, 'merged');
      assert.equal(readReadyTendHandoff(featureDir)?.headSha, pushedSha);
      assert.equal(readReadyTendHandoff(featureDir)?.state, 'tend-claimed');
      // Two backoff sleeps precede convergence — 1s then 2s (schedule 1s,2s,4s,8s).
      const backoffSleeps = sleeps.filter((ms) => ms === 1000 || ms === 2000 || ms === 4000 || ms === 8000);
      assert.ok(backoffSleeps.length >= 2, `expected at least 2 backoff sleeps, got ${backoffSleeps.length}`);
      assert.equal(backoffSleeps[0], 1000);
      assert.equal(backoffSleeps[1], 2000);
      assert.ok(!options.labels.includes('release-merging:42'), `labels=${options.labels.join(',')}`);
    } finally {
      options.cleanup();
    }
  });

  it('refuses immediately when a third-party push shows a different head', async () => {
    const pushedSha = 'rebased-head-sha';
    const initialHeadSha = 'head-sha';
    const options = buildMergeTestOptions({ rebaseHeadSha: pushedSha });
    const shellRunner = buildRebindShellRunner({
      repoDir: options.repoDir,
      calls: options.calls,
      initialHeadSha,
      pushedSha,
      postPushHeadFor: () => 'competing-third-party-sha',
    });

    const sleeps: number[] = [];
    const retrySleep = async (ms: number) => { sleeps.push(ms); };
    const featureDir = join(options.repoDir, 'features', 'third-head');
    try {
      await publishReadyHandoff(featureDir, 42, initialHeadSha);
      const result = await executeMerge(
        candidate({ headSha: initialHeadSha, featureDir }),
        {
          repoDir: options.repoDir,
          deps: { ...options.deps, shellRunner, retrySleep },
        },
      );

      assert.equal(result.status, 'blocked');
      assert.equal(result.phase, 'handoff');
      assert.match(String(result.failureExcerpt), /diverged/);
      assert.ok(options.labels.includes('release-merging:42'), `labels=${options.labels.join(',')}`);
      // HOK-3316: the outcome is a handoff fact for the pushed head, which the
      // reconciler renders as wm:blocked until the third head expires it.
      const fact = readTendAttemptFact(featureDir);
      assert.equal(fact?.phase, 'handoff');
      assert.equal(fact?.headSha, pushedSha);
      assert.ok(fact?.baseSha, 'the fact is keyed on the integration tip tend rebased onto');
      // HOK-3112: the push happened even though the rebind was refused, so the
      // task worktree is marked stale for the monitor to resync.
      const pushedMarker = readTendPushedHead(featureDir);
      assert.equal(pushedMarker?.previousHeadSha, initialHeadSha);
      assert.equal(pushedMarker?.pushedHeadSha, pushedSha);
      // No convergence backoff sleeps — third-head refusal fires on the first read.
      const backoffSleeps = sleeps.filter((ms) => ms === 1000 || ms === 2000 || ms === 4000 || ms === 8000);
      assert.equal(backoffSleeps.length, 0);
    } finally {
      options.cleanup();
    }
  });

  it('defers a lag-only mismatch through the bounded-retry budget without posting a failure comment', async () => {
    const pushedSha = 'rebased-head-sha';
    const initialHeadSha = 'head-sha';
    const options = buildMergeTestOptions({ rebaseHeadSha: pushedSha });
    let commentCalls = 0;
    const baseShellRunner = buildRebindShellRunner({
      repoDir: options.repoDir,
      calls: options.calls,
      initialHeadSha,
      pushedSha,
      // Lag returns the previous head (candidate.headSha = initialHeadSha)
      // for every poll — never converges within the window.
      postPushHeadFor: () => initialHeadSha,
    });
    const shellRunner: MergeExecutionDeps['shellRunner'] = (cmd, opts) => {
      if (cmd.includes('gh pr comment')) { commentCalls += 1; return ''; }
      return baseShellRunner(cmd, opts);
    };

    let incrementCalled = false;
    const handoffRebindRetry: StrictBaseRetryOps = {
      gate: () => 'proceed',
      increment: () => { incrementCalled = true; },
      markExhausted: () => { throw new Error('markExhausted should not fire while budget remains'); },
      clear: () => {},
    };

    const featureDir = join(options.repoDir, 'features', 'lag-defer');
    const retrySleep = async (_ms: number) => {};
    try {
      await publishReadyHandoff(featureDir, 42, initialHeadSha);
      const result = await executeMerge(
        candidate({ headSha: initialHeadSha, featureDir }),
        {
          repoDir: options.repoDir,
          deps: { ...options.deps, shellRunner, handoffRebindRetry, retrySleep },
        },
      );

      assert.equal(result.status, 'skipped');
      assert.equal(result.phase, 'handoff-rebind-deferred');
      assert.ok(incrementCalled, 'expected handoff-rebind budget increment on deferred path');
      assert.equal(commentCalls, 0, 'no failure comment should be posted on the deferred path');
      assert.ok(options.labels.includes('ready:42'), `labels=${options.labels.join(',')}`);
      assert.ok(!options.labels.includes('release-merging:42'));
      assert.equal(readTendAttemptFact(featureDir), null, 'a deferral records no attempt fact');
      // HOK-3112: a lag-deferred rebind still marks the task worktree stale.
      assert.equal(readTendPushedHead(featureDir)?.pushedHeadSha, pushedSha);
    } finally {
      options.cleanup();
    }
  });

  it('takes the terminal block path when the handoff-rebind budget is exhausted', async () => {
    const pushedSha = 'rebased-head-sha';
    const initialHeadSha = 'head-sha';
    const options = buildMergeTestOptions({ rebaseHeadSha: pushedSha });
    const shellRunner = buildRebindShellRunner({
      repoDir: options.repoDir,
      calls: options.calls,
      initialHeadSha,
      pushedSha,
      // Lag never converges — head keeps reporting the pre-push (previous) head.
      postPushHeadFor: () => initialHeadSha,
    });

    let markExhaustedCalled = false;
    const handoffRebindRetry: StrictBaseRetryOps = {
      gate: () => 'exhausted',
      increment: () => {},
      markExhausted: () => { markExhaustedCalled = true; },
      clear: () => {},
    };

    const featureDir = join(options.repoDir, 'features', 'lag-exhausted');
    const retrySleep = async (_ms: number) => {};
    try {
      await publishReadyHandoff(featureDir, 42, initialHeadSha);
      const result = await executeMerge(
        candidate({ headSha: initialHeadSha, featureDir }),
        {
          repoDir: options.repoDir,
          deps: { ...options.deps, shellRunner, handoffRebindRetry, retrySleep },
        },
      );

      assert.equal(result.status, 'blocked');
      assert.equal(result.phase, 'handoff');
      assert.match(String(result.failureExcerpt), /handoff-rebind budget exhausted/);
      assert.ok(options.labels.includes('release-merging:42'));
      assert.ok(markExhaustedCalled);
      assert.equal(readTendAttemptFact(featureDir)?.phase, 'handoff');
    } finally {
      options.cleanup();
    }
  });
});

describe('reconcileWavemillPrLabels', () => {
  // protects: tend handing raw `gh pr list` entries (labels as {name},
  // head as headRefOid) to the reconciler, which reads string labels and
  // headSha — every PR then looked label-less and headless, so wm:ready was
  // never applied and nothing merged (found by the golden journey, HOK-3227).
  it('gives the reconciler string labels and the head SHA, then maps labels back', async () => {
    const prs = [{
      number: 7,
      title: 't',
      headRefName: 'task/x',
      headRefOid: 'abc123',
      createdAt: '2026-10-14T00:00:00Z',
      isDraft: false,
      labels: [{ name: 'wavemill' }],
      body: '',
    }];
    let seen: unknown;
    const report = await reconcileWavemillPrLabels(prs, '/repo', async (views) => {
      seen = structuredClone(views);
      views[0].labels.push('wm:ready');
      return { decisionByPr: new Map([[7, { label: 'wm:ready' as const }]]), noTaskViewPrs: [] };
    });
    assert.deepEqual(seen, [{ number: 7, labels: ['wavemill'], headSha: 'abc123' }]);
    assert.deepEqual(prs[0].labels, [{ name: 'wavemill' }, { name: 'wm:ready' }]);
    assert.deepEqual(report.decisionByPr.get(7), { label: 'wm:ready' });
  });
});

// HOK-3242: fail-closed on a miss in the branch-deletion authorization lookup.
describe('taskStateAuthorizesRemoteBranchDeletion fails closed on a miss', () => {
  it('returns false when workflow-state is missing', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-tsabrd-'));
    try {
      // No `.wavemill/workflow-state.json` written: the resolver emits a
      // state-unavailable miss and the function returns false.
      assert.equal(taskStateAuthorizesRemoteBranchDeletion(repoDir, 'task/anything'), false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('returns false when no task row carries that branch', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-tsabrd-'));
    try {
      mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
      writeFileSync(
        join(repoDir, '.wavemill', 'workflow-state.json'),
        JSON.stringify(buildWorkflowState({
          'HOK-1': { pr: '42', slug: 's', worktree: repoDir, branch: 'task/other' },
        })),
      );
      assert.equal(taskStateAuthorizesRemoteBranchDeletion(repoDir, 'task/missing'), false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('returns the lifecycle flag when the branch matches a task row', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-tsabrd-'));
    try {
      mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
      // normalizeTaskLifecycle authorizes deletion when the task carries a
      // valid launchContract.remoteBranchDeletionPolicy.
      writeFileSync(
        join(repoDir, '.wavemill', 'workflow-state.json'),
        JSON.stringify(buildWorkflowState({
          'HOK-1': {
            pr: '42',
            slug: 's',
            worktree: repoDir,
            branch: 'task/match',
            lifecycle: {
              schemaVersion: 1,
              workflowOutcome: 'merged',
              resourceDisposition: 'reaped',
              launchContract: {
                remoteBranchDeletionPolicy: {
                  allowed: true,
                  mode: 'test-authorized',
                  reason: 'test-fixture',
                  source: 'test',
                },
              },
            },
          },
        })),
      );
      assert.equal(taskStateAuthorizesRemoteBranchDeletion(repoDir, 'task/match'), true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
