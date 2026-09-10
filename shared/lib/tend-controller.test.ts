import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { LinearIssueSummary } from './linear.ts';
import { WM_LABELS, writePrStateMarker } from './pr-state-labels.ts';
import {
  classifyBasePolicyRejection,
  createPrFetcher,
  defaultHealthChecker,
  defaultStrictBaseRetryOps,
  executeMerge,
  formatStatusLine,
  isBasePolicyMergeError,
  isRequiredChecksExpectedMergeError,
  mergeRetryMarkerPath,
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
} from './tend-controller.ts';

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
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({
      integration: { integrationBranch: 'auto/integration' },
      ...configOverride,
    }),
  );

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

function buildMergeTestOptions(overrides: {
  shellRunner?: MergeExecutionDeps['shellRunner'];
  readyChecker?: MergeExecutionDeps['readyChecker'];
  healthChecker?: MergeExecutionDeps['healthChecker'];
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
    JSON.stringify({
      integration: { integrationBranch: 'auto/integration', mergeMethod: 'squash' },
      // HOK-2957: existing tend-controller assertions predate the shadow
      // rollout default. Force enforce so the pre-existing behavior is what
      // gets asserted; shadow mode is exercised in its own test file.
      cleanup: { branchDeletion: { mode: 'enforce' } },
    }),
  );

  const calls: string[] = [];
  const labels: string[] = [];
  const defaultShellRunner: MergeExecutionDeps['shellRunner'] = (cmd) => {
    calls.push(cmd);
    if (cmd.includes('gh pr list --label')) return '[]';
    if (cmd.includes('git rev-parse --git-common-dir')) return join(repoDir, '.git');
    if (cmd.includes('git rev-parse') && cmd.includes('origin/')) return 'abc123def456';
    if (cmd.includes('git merge-base --is-ancestor')) { const e = new Error('Command failed: git merge-base --is-ancestor'); (e as unknown as Record<string, unknown>).status = 1; throw e; }
    if (cmd.includes('gh pr checks')) return JSON.stringify([{ name: 'ci', state: 'COMPLETED', conclusion: 'success' }]);
    if (cmd.includes('gh pr view')) {
      return JSON.stringify({
        mergeStateStatus: 'CLEAN',
        headRefOid: 'head-sha',
        baseRefOid: 'base-sha',
        statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      });
    }
    return '';
  };

  return {
    repoDir,
    calls,
    labels,
    deps: {
      shellRunner: overrides.shellRunner ?? defaultShellRunner,
      readyChecker: overrides.readyChecker ?? (async () => ({ ready: true })),
      healthChecker: overrides.healthChecker ?? (async () => ({ state: 'healthy' })),
      acquireMerging: (prNumber) => {
        labels.push(`merging:${prNumber}`);
      },
      releaseToBlocked: (prNumber) => {
        labels.push(`blocked:${prNumber}`);
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
    },
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

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
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({ integration: { integrationBranch: 'auto/integration' } }),
  );

  return {
    repoDir,
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

  it('re-derives and clears a blocked label that has no marker sidecar', async () => {
    const options = buildTestOptions([
      pr({ labels: [label(WM_LABELS.wavemill), label(WM_LABELS.ready), label(WM_LABELS.blocked)] }),
    ]);
    const cleared: number[] = [];
    options.blockedLabelClearer = (prNumber) => { cleared.push(prNumber); };
    try {
      const decision = await selectNextCandidate(options);
      assert.deepEqual(decision.eligible.map((candidate) => candidate.number), [1]);
      assert.deepEqual(decision.blocked, []);
      assert.deepEqual(cleared, [1]);
    } finally {
      options.cleanup();
    }
  });

  it('keeps a current cross-PR guard block parked without rechecking', async () => {
    const options = buildTestOptions([
      pr({ labels: [label(WM_LABELS.wavemill), label(WM_LABELS.ready), label(WM_LABELS.blocked)] }),
    ]);
    let recheckCalls = 0;
    options.crossPrGuardChecker = async () => {
      recheckCalls += 1;
      return { status: 'pass', checkedHeadSha: 'head-current' };
    };
    writeReadyResult(options.repoDir, 'HOK-1437', {
      stage: 'ready',
      status: 'failed',
      artifacts: {
        type: 'ready',
        verdict: 'fail',
        prNumber: 1,
        readyHeadSha: 'head-current',
        crossPrGuard: {
          source: 'cross-pr-revert-guard',
          status: 'blocked',
          checkedHeadSha: 'head-current',
        },
      },
    });
    writePrStateMarker(1, {
      headSha: 'head-current',
      activeLabels: [WM_LABELS.ready, WM_LABELS.blocked],
      markerRoot: options.repoDir,
    });

    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked[0]?.reason, 'blocked-label:cross-pr-guard');
      assert.equal(recheckCalls, 0);
    } finally {
      options.cleanup();
    }
  });

  it('rechecks stale cross-PR guard evidence, clears the label, and keeps the PR eligible in the same cycle', async () => {
    const options = buildTestOptions([
      pr({ labels: [label(WM_LABELS.wavemill), label(WM_LABELS.ready), label(WM_LABELS.blocked)] }),
    ]);
    const cleared: number[] = [];
    options.crossPrGuardChecker = async ({ pr: checkedPr }) => ({
      status: 'pass',
      checkedHeadSha: checkedPr.headRefOid ?? '',
    });
    options.blockedLabelClearer = (prNumber) => {
      cleared.push(prNumber);
    };
    writeReadyResult(options.repoDir, 'HOK-1437', {
      stage: 'ready',
      status: 'failed',
      artifacts: {
        type: 'ready',
        verdict: 'fail',
        prNumber: 1,
        readyHeadSha: 'head-old',
        crossPrGuard: {
          source: 'cross-pr-revert-guard',
          status: 'blocked',
          checkedHeadSha: 'head-old',
        },
      },
    });
    writePrStateMarker(1, {
      headSha: 'head-old',
      activeLabels: [WM_LABELS.ready, WM_LABELS.blocked],
      markerRoot: options.repoDir,
    });

    try {
      const decision = await selectNextCandidate(options);
      assert.deepEqual(decision.eligible.map((candidate) => candidate.number), [1]);
      assert.deepEqual(decision.blocked, []);
      assert.equal(decision.nextPR, 1);
      assert.deepEqual(cleared, [1]);
      assert.match(
        readFileSync(join(options.repoDir, '.wavemill', 'observer-findings.jsonl'), 'utf-8'),
        /Stale marker: pr-label/,
      );
    } finally {
      options.cleanup();
    }
  });

  it('keeps a stale guard block when the current-head recheck still blocks', async () => {
    const options = buildTestOptions([
      pr({ labels: [label(WM_LABELS.wavemill), label(WM_LABELS.ready), label(WM_LABELS.blocked)] }),
    ]);
    options.crossPrGuardChecker = async ({ pr: checkedPr }) => ({
      status: 'blocked',
      checkedHeadSha: checkedPr.headRefOid ?? '',
    });
    writeReadyResult(options.repoDir, 'HOK-1437', {
      stage: 'ready',
      status: 'failed',
      artifacts: {
        type: 'ready',
        verdict: 'fail',
        prNumber: 1,
        crossPrGuard: {
          source: 'cross-pr-revert-guard',
          status: 'blocked',
          checkedHeadSha: 'head-old',
        },
      },
    });

    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked[0]?.reason, 'blocked-label:cross-pr-guard');
    } finally {
      options.cleanup();
    }
  });

  it('fails closed when a revalidated block cannot refresh its marker sidecar', async () => {
    const options = buildTestOptions([
      pr({ labels: [label(WM_LABELS.wavemill), label(WM_LABELS.ready), label(WM_LABELS.blocked)] }),
    ]);
    options.crossPrGuardChecker = async ({ pr: checkedPr }) => ({
      status: 'blocked',
      checkedHeadSha: checkedPr.headRefOid ?? '',
    });
    options.prStateMarkerWriter = () => {
      throw new Error('sidecar disk unavailable');
    };
    writeReadyResult(options.repoDir, 'HOK-1437', {
      stage: 'ready',
      status: 'failed',
      artifacts: {
        type: 'ready',
        verdict: 'fail',
        prNumber: 1,
        crossPrGuard: {
          source: 'cross-pr-revert-guard',
          status: 'blocked',
          checkedHeadSha: 'head-old',
        },
      },
    });

    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.eligible.length, 0);
      assert.equal(
        decision.blocked[0]?.reason,
        'blocked-label:marker-write-error:sidecar disk unavailable',
      );
    } finally {
      options.cleanup();
    }
  });

  it('fails closed with a distinct reason when stale guard evidence recheck hits a tool error', async () => {
    const options = buildTestOptions([
      pr({ labels: [label(WM_LABELS.wavemill), label(WM_LABELS.ready), label(WM_LABELS.blocked)] }),
    ]);
    options.crossPrGuardChecker = async ({ pr: checkedPr }) => ({
      status: 'tool-error',
      checkedHeadSha: checkedPr.headRefOid ?? '',
      detail: 'git merge-base failed',
    });
    writeReadyResult(options.repoDir, 'HOK-1437', {
      stage: 'ready',
      status: 'failed',
      artifacts: {
        type: 'ready',
        verdict: 'fail',
        prNumber: 1,
        crossPrGuard: {
          source: 'cross-pr-revert-guard',
          status: 'blocked',
          checkedHeadSha: 'head-old',
        },
      },
    });

    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked[0]?.reason, 'blocked-label:cross-pr-guard-tool-error');
    } finally {
      options.cleanup();
    }
  });

  it('fails closed when stale guard evidence rechecks clean but blocked-label removal fails', async () => {
    const options = buildTestOptions([
      pr({ labels: [label(WM_LABELS.wavemill), label(WM_LABELS.ready), label(WM_LABELS.blocked)] }),
    ]);
    options.crossPrGuardChecker = async ({ pr: checkedPr }) => ({
      status: 'pass',
      checkedHeadSha: checkedPr.headRefOid ?? '',
    });
    options.blockedLabelClearer = () => {
      throw new Error('GitHub label API unavailable');
    };
    writeReadyResult(options.repoDir, 'HOK-1437', {
      stage: 'ready',
      status: 'failed',
      artifacts: {
        type: 'ready',
        verdict: 'fail',
        prNumber: 1,
        crossPrGuard: {
          source: 'cross-pr-revert-guard',
          status: 'blocked',
          checkedHeadSha: 'head-old',
        },
      },
    });

    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.eligible.length, 0);
      assert.match(decision.blocked[0]?.reason ?? '', /^blocked-label:clear-failed:GitHub label API unavailable/);
    } finally {
      options.cleanup();
    }
  });

  it('clears a contradictory blocked label when current ready-pass evidence already supersedes it', async () => {
    const options = buildTestOptions([
      pr({ labels: [label(WM_LABELS.wavemill), label(WM_LABELS.ready), label(WM_LABELS.blocked)] }),
    ]);
    let recheckCalls = 0;
    const cleared: number[] = [];
    options.crossPrGuardChecker = async () => {
      recheckCalls += 1;
      return { status: 'blocked', checkedHeadSha: 'head-current' };
    };
    options.blockedLabelClearer = (prNumber) => {
      cleared.push(prNumber);
    };
    writeReadyResult(options.repoDir, 'HOK-1437', {
      stage: 'ready',
      status: 'completed',
      artifacts: {
        type: 'ready',
        verdict: 'pass',
        prNumber: 1,
        readyHeadSha: 'head-current',
        readyLabelsUpdated: true,
      },
    });

    try {
      const decision = await selectNextCandidate(options);
      assert.deepEqual(decision.eligible.map((candidate) => candidate.number), [1]);
      assert.deepEqual(cleared, [1]);
      assert.equal(recheckCalls, 0);
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

  it('reaches ready-failed:not-ready when metadata is valid but wm:ready absent', async () => {
    await withDecision([
      pr({ labels: [label(WM_LABELS.wavemill)] }),
    ], (decision) => {
      assert.equal(decision.blocked[0]?.reason, 'ready-failed:not-ready');
    });
  });

  it('blocks PRs without the ready label', async () => {
    await withDecision([
      pr({ labels: [label(WM_LABELS.wavemill)] }),
    ], (decision) => {
      assert.equal(decision.blocked[0]?.reason, 'ready-failed:not-ready');
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

  it('short-circuits when integration health is unhealthy', async () => {
    await withDecision([pr()], (decision) => {
      assert.equal(decision.integrationHealth.state, 'unhealthy');
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked.length, 0);
      assert.equal(decision.nextPR, null);
    }, { state: 'unhealthy', reason: 'ci: failure' });
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
      HOK_1523_c: { challengePairId: 'pair-1523', challengeRole: 'challenger' },
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
        HOK_1523_c: { challengePairId: 'pair-1523', challengeRole: 'challenger' },
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
      HOK_1523_c: { challengePairId: 'pair-hok-1523', challengeRole: 'challenger' },
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

  it('retries once with origin integration after a local-only sha gets a missing-commit 422', async () => {
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
          assert.deepEqual(readGhApiPaths(logPath), [
            `repos/example/repo/commits/${localSha}/check-runs`,
            `repos/example/repo/commits/${repo.remoteSha}/check-runs`,
          ]);
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

  it('reports degraded health when neither local nor origin ref resolves', async () => {
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
      assert.match(health.reason ?? '', /health-check-error/);
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
});

describe('formatStatusLine', () => {
  it('formats the dry-run status line', async () => {
    await withDecision([pr()], (decision) => {
      assert.equal(formatStatusLine(decision), 'eligible=1 blocked=0 health=ok last=none action=idle');
    });
  });

  it('includes degraded health, last merged PR, and action overrides', () => {
    assert.equal(
      formatStatusLine({
        integrationHealth: { state: 'unhealthy', reason: 'ci: failure' },
        eligible: [],
        blocked: [],
        nextPR: null,
      }, { action: 'merged-#42', lastPR: 42 }),
      'eligible=0 blocked=0 health=degraded last=#42 action=merged-#42',
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
      assert.equal(options.labels.includes('blocked:42'), false);
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
        throw new Error('rebase conflict\nfile.ts');
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
      assert.deepEqual(options.labels, ['merging:42', 'blocked:42']);
    } finally {
      options.cleanup();
    }
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
      assert.deepEqual(options.labels, ['merging:42', 'blocked:42']);
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
      assert.deepEqual(options.labels, ['merging:42', 'blocked:42']);
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
      assert.deepEqual(options.labels, ['merging:42', 'blocked:42']);
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
      assert.ok(!options.labels.includes('blocked:42'));
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
      assert.deepEqual(options.labels, ['merging:42', 'blocked:42']);
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
      assert.deepEqual(options.labels, ['merging:42', 'blocked:42']);
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
      assert.equal(options.labels.includes('blocked:42'), false);
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

  it('retries a transient blocked-label release on the rebase failure path', async () => {
    const options = buildMergeTestOptions();
    const sleeps: number[] = [];
    let releaseAttempts = 0;
    const shellRunner: MergeExecutionDeps['shellRunner'] = (cmd, opts) => {
      options.calls.push(cmd);
      if (cmd.includes('git rebase')) {
        throw new Error('rebase conflict');
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
          releaseToBlocked: (prNumber) => {
            releaseAttempts += 1;
            if (releaseAttempts === 1) {
              throw Object.assign(new Error('HTTP 503 Service Unavailable'), { stderr: 'HTTP 503 Service Unavailable' });
            }
            options.labels.push(`blocked:${prNumber}`);
          },
          retrySleep: async (ms) => { sleeps.push(ms); },
        },
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.phase, 'rebase');
      assert.equal(releaseAttempts, 2);
      assert.equal(sleeps.length, 1);
      assert.deepEqual(options.labels, ['merging:42', 'blocked:42']);
    } finally {
      options.cleanup();
    }
  });

  it('still returns blocked and warns when the blocked-label release persistently fails', async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    const options = buildMergeTestOptions();
    const shellRunner: MergeExecutionDeps['shellRunner'] = (cmd, opts) => {
      options.calls.push(cmd);
      if (cmd.includes('git rebase')) {
        throw new Error('rebase conflict');
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
          releaseToBlocked: () => {
            throw new Error('label update failed');
          },
        },
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.phase, 'rebase');
      assert.ok(
        warnings.some((warning) => warning.includes('wm:merging may be leaked')),
        'expected a leak warning when the blocked-label release exhausts retries',
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
      assert.deepEqual(options.labels, ['merging:42', 'blocked:42']);
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
      assert.deepEqual(options.labels, ['merging:42', 'blocked:42']);
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

describe('wm:blocked reconciliation against live state (HOK-2919)', () => {
  function blockedPr(): GhPrListEntry {
    return pr({ labels: [label(WM_LABELS.wavemill), label(WM_LABELS.ready), label(WM_LABELS.blocked)] });
  }

  it('invalidates a block written against a prior head when no live gate remains (REQ-F3/REQ-F4)', async () => {
    const options = buildTestOptions([blockedPr()]);
    const cleared: number[] = [];
    options.blockedLabelClearer = (prNumber) => { cleared.push(prNumber); };
    options.blockedPrLiveStateProber = async () => ({
      available: true,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      failingChecks: [],
      pendingChecks: [],
    });
    writePrStateMarker(1, {
      headSha: 'head-old',
      activeLabels: [WM_LABELS.ready, WM_LABELS.blocked],
      markerRoot: options.repoDir,
    });

    try {
      const decision = await selectNextCandidate(options);
      assert.deepEqual(decision.eligible.map((item) => item.number), [1]);
      assert.deepEqual(decision.blocked, []);
      assert.deepEqual(cleared, [1]);
    } finally {
      options.cleanup();
    }
  });

  it('keeps a stale-marker block when live truth confirms failing checks, with a named gate', async () => {
    const options = buildTestOptions([blockedPr()]);
    const cleared: number[] = [];
    options.blockedLabelClearer = (prNumber) => { cleared.push(prNumber); };
    options.blockedPrLiveStateProber = async () => ({
      available: true,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      failingChecks: ['Shell and Unit Tests'],
      pendingChecks: [],
    });
    writePrStateMarker(1, {
      headSha: 'head-old',
      activeLabels: [WM_LABELS.ready, WM_LABELS.blocked],
      markerRoot: options.repoDir,
    });

    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.eligible.length, 0);
      assert.match(decision.blocked[0]?.reason ?? '', /^blocked-label:checks-failing:Shell and Unit Tests/);
      assert.deepEqual(cleared, []);
    } finally {
      options.cleanup();
    }
  });

  it('surfaces a contradiction finding for a valid same-head block on a CLEAN green PR (REQ-F5)', async () => {
    const options = buildTestOptions([blockedPr()]);
    options.blockedPrLiveStateProber = async () => ({
      available: true,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      failingChecks: [],
      pendingChecks: [],
    });
    writePrStateMarker(1, {
      headSha: 'head-current',
      activeLabels: [WM_LABELS.ready, WM_LABELS.blocked],
      markerRoot: options.repoDir,
    });

    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.blocked[0]?.reason, 'blocked-label:contradicted-by-live-state');
      const findings = readFileSync(join(options.repoDir, '.wavemill', 'observer-findings.jsonl'), 'utf-8');
      assert.match(findings, /contradicted by live state/);
      assert.match(findings, /merge-lane-blocked-contradiction/);
      // A second poll with unchanged state does not re-emit the finding.
      const findingCount = findings.split('\n').filter((line) => line.includes('merge-lane-blocked-contradiction')).length;
      await selectNextCandidate(options);
      const findingsAfter = readFileSync(join(options.repoDir, '.wavemill', 'observer-findings.jsonl'), 'utf-8');
      assert.equal(
        findingsAfter.split('\n').filter((line) => line.includes('merge-lane-blocked-contradiction')).length,
        findingCount,
      );
    } finally {
      options.cleanup();
    }
  });

  it('names the behind-base gate for a valid same-head block that is merely stale', async () => {
    const options = buildTestOptions([blockedPr()]);
    options.blockedPrLiveStateProber = async () => ({
      available: true,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BEHIND',
      failingChecks: [],
      pendingChecks: [],
    });
    writePrStateMarker(1, {
      headSha: 'head-current',
      activeLabels: [WM_LABELS.ready, WM_LABELS.blocked],
      markerRoot: options.repoDir,
    });

    try {
      const decision = await selectNextCandidate(options);
      assert.equal(decision.blocked[0]?.reason, 'blocked-label:behind-base');
    } finally {
      options.cleanup();
    }
  });

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
      assert.equal(decision.blocked[0]?.reason, 'ready-failed:not-ready');
      assert.deepEqual(decision.blocked[0]?.labels, ['wavemill']);
      const findings = readFileSync(join(options.repoDir, '.wavemill', 'observer-findings.jsonl'), 'utf-8');
      assert.match(findings, /Mill and tend disagree on PR #1 merge candidacy/);
      assert.match(findings, /ready-failed:not-ready/);
      assert.match(findings, /pass: 16\/3 checks/);
    } finally {
      options.cleanup();
    }
  });
});
