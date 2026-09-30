import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  classifyReadyTask,
  normalizeStatusCheckRollup,
  setReadyWatchdogUnconfirmedEntryTtlMsForTest,
  tickReadyWatchdog,
  type GitHubPRTruth,
  type ReadyTaskSnapshot,
} from './ready-watchdog.ts';

function makeSnapshot(overrides: Partial<ReadyTaskSnapshot> = {}): ReadyTaskSnapshot {
  return {
    issueId: 'HOK-1579',
    slug: 'ready-watchdog-task',
    branch: 'task/ready-watchdog-task',
    worktree: '/tmp/worktree',
    prNumber: 528,
    controllerPhase: 'ready',
    controllerUpdatedAt: '2026-05-05T12:00:00.000Z',
    currentAgent: 'codex',
    currentModel: 'gpt-5.5',
    challengePairId: null,
    readyStateDir: '/tmp/worktree/features/ready-watchdog-task',
    readyResult: null,
    readyArtifacts: null,
    readyResultStatus: 'running',
    readyVerdict: 'fail',
    readyAttentionDetail: null,
    hasNeedsAttention: false,
    hasConflictMarker: false,
    remediationLaunchHead: null,
    currentHead: 'head-sha',
    remediationPaneActive: null,
    worktreeMergeState: {
      mergeHead: null,
      unmergedPaths: [],
      stagedPaths: [],
      unstagedPaths: [],
      untrackedPaths: [],
      rawStatus: [],
    },
    relevantJobs: [],
    lastProgressAt: '2026-05-05T12:00:00.000Z',
    idleMinutes: 30,
    backstageHealth: null,
    ...overrides,
  };
}

function makeTruth(overrides: Partial<GitHubPRTruth> = {}): GitHubPRTruth {
  return {
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    checks: [
      { name: 'build', status: 'success', rawStatus: 'SUCCESS' },
    ],
    ...overrides,
  };
}

function setupReadyTask(issueId = 'HOK-1579', prNumber = 528): {
  repoDir: string;
  stateDir: string;
  stateFile: string;
  worktree: string;
  featureDir: string;
} {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'ready-watchdog-'));
  const stateDir = path.join(repoDir, '.wavemill');
  const worktree = path.join(repoDir, 'worktrees', 'ready-watchdog-task');
  const featureDir = path.join(worktree, 'features', 'ready-watchdog-task');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(featureDir, { recursive: true });

  const stateFile = path.join(stateDir, 'workflow-state.json');
  writeFileSync(path.join(repoDir, '.wavemill-config.json'), JSON.stringify({
    // HOK-3102: keep pre-3102 semantics — with integration on + useMillSession,
    // the ready-watchdog auto-update path stays live so existing tests that
    // exercise BEHIND branches still see them classified as `auto-update`.
    integration: { enabled: true, useMillSession: true },
    ready: {
      transientRetryBudget: 2,
      remediationLogMaxBytes: 200,
      verificationGatingEnabled: true,
      localCommandMap: {
        'Alembic Check': 'npm run ready:migrations',
        'Unit Tests': 'npm test',
        lint: 'npm run lint',
      },
    },
  }, null, 2));
  writeFileSync(stateFile, JSON.stringify({
    tasks: {
      [issueId]: {
        slug: 'ready-watchdog-task',
        branch: 'task/ready-watchdog-task',
        worktree,
        pr: prNumber,
        phase: 'ready',
        updated: '2026-05-05T12:00:00.000Z',
        agent: 'codex',
        model: 'gpt-5.5',
      },
    },
    jobs: {},
  }, null, 2));

  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: null,
    agent: 'codex',
    model: 'gpt-5.5',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pending', prNumber },
  }, null, 2));

  return { repoDir, stateDir, stateFile, worktree, featureDir };
}

const WATCHDOG_CONFIG = {
  enabled: true,
  thresholdMinutes: 10,
  autoRecover: true,
  timeoutSeconds: 30,
} as const;

const WATCHDOG_CLASSIFIER_CONFIG = {
  ...WATCHDOG_CONFIG,
  localCommandMap: {
    lint: 'npm run lint',
    'Alembic Check': 'npm run ready:migrations',
  },
  remediationLogMaxBytes: 20_000,
} as const;

test('classify clean green stale ready as stuck', () => {
  const classification = classifyReadyTask(
    makeSnapshot(),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: true,
      timeoutSeconds: 30,
    },
  );

  assert.equal(classification.kind, 'stuck');
  assert.equal(classification.autoRecoverable, true);
});

test('classify clean green PR parked in merge lane as waiting-on-merge-lane (not stuck)', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 15,
      readyArtifacts: { type: 'ready', verdict: 'pass', queueState: 'ready-stale' },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
  );

  // Parked-and-waiting must not be auto-recovered (no needless ready re-run).
  assert.equal(classification.kind, 'waiting-on-merge-lane');
  assert.notEqual(classification.autoRecoverable, true);
});

test('escalate a long-parked merge-lane PR to needs-user (lane stalled)', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 35, // >= thresholdMinutes(10) * 3
      readyArtifacts: { type: 'ready', verdict: 'pass', queueState: 'ready-stale' },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
  );

  assert.equal(classification.kind, 'needs-user');
  assert.match(classification.detail, /merge lane appears stalled/i);
});

test('a selected merge candidate that is clean green classifies as waiting-on-merge-lane (not stuck)', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 15,
      readyArtifacts: { type: 'ready', verdict: 'pass', queueState: 'merge-candidate' },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
  );

  // A merge-candidate PR is in the lane waiting for the merge — auto-recovering
  // it just re-runs ready checks that will pass again, re-arming the watchdog
  // every 10 minutes indefinitely.
  assert.equal(classification.kind, 'waiting-on-merge-lane');
  assert.notEqual(classification.autoRecoverable, true);
});

test('a long-idle merge candidate escalates to needs-user (lane stalled)', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 35, // >= thresholdMinutes(10) * 3
      readyArtifacts: { type: 'ready', verdict: 'pass', queueState: 'merge-candidate' },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
  );

  assert.equal(classification.kind, 'needs-user');
  assert.match(classification.detail, /merge lane appears stalled/i);
});

test('a long-idle merge candidate reports missing tend loop when backstage executor is absent', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 35,
      readyArtifacts: { type: 'ready', verdict: 'pass', queueState: 'merge-candidate' },
      backstageHealth: {
        updatedAt: '2026-05-05T12:20:00.000Z',
        status: 'missing-tend-loop',
        detail: 'backstage window is missing the Wavemill Tend Loop executor pane while status panes remain',
        restartAttemptCount: 1,
        lastRestartAttemptAt: '2026-05-05T12:19:00.000Z',
        executorPaneId: null,
      },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
  );

  assert.equal(classification.kind, 'needs-user');
  assert.match(classification.detail, /missing tend loop/i);
  assert.doesNotMatch(classification.detail, /merge lane appears stalled/i);
});

test('a long-idle merge candidate reports stalled tend heartbeat', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 35,
      readyArtifacts: { type: 'ready', verdict: 'pass', queueState: 'merge-candidate' },
      backstageHealth: {
        updatedAt: '2026-05-05T12:20:00.000Z',
        status: 'stalled',
        detail: 'tend heartbeat is stale (420s old)',
        restartAttemptCount: 1,
        lastRestartAttemptAt: '2026-05-05T12:19:00.000Z',
        executorPaneId: '%9',
      },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
  );

  assert.equal(classification.kind, 'needs-user');
  assert.match(classification.detail, /stalled tend loop/i);
  assert.match(classification.detail, /heartbeat is stale/i);
  assert.doesNotMatch(classification.detail, /merge lane appears stalled/i);
});

test('a completed-ready PR (queueState=ready) with clean green classifies as waiting-on-merge-lane', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 15,
      readyResultStatus: 'completed',
      readyArtifacts: { type: 'ready', verdict: 'pass', queueState: 'ready' },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
  );

  // PR passed checks against current base, not yet selected by the merge queue.
  // Auto-recovering it is needless — the queue will select it on the next tick.
  assert.equal(classification.kind, 'waiting-on-merge-lane');
  assert.notEqual(classification.autoRecoverable, true);
});

test('a running-ready PR with queueState=ready and clean green still classifies as stuck', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 15,
      readyResultStatus: 'running',
      readyArtifacts: { type: 'ready', verdict: 'pending', queueState: 'ready' },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
  );

  // A running (not completed) ready stage with queueState=ready is unexpected
  // for a clean/green PR — classify as stuck so the controller can recover it.
  assert.equal(classification.kind, 'stuck');
});

test('classify failing CI as waiting-on-ci', () => {
  const classification = classifyReadyTask(
    makeSnapshot(),
    makeTruth({
      checks: [{ name: 'build', status: 'failure', rawStatus: 'FAILURE' }],
    }),
    new Date('2026-05-05T12:30:00.000Z'),
    {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: true,
      timeoutSeconds: 30,
    },
  );

  assert.equal(classification.kind, 'needs-user');
  assert.match(classification.detail, /operator attention/);
});

test('classify pending CI as waiting-on-ci', () => {
  const classification = classifyReadyTask(
    makeSnapshot(),
    makeTruth({
      checks: [{ name: 'build', status: 'pending', rawStatus: 'PENDING' }],
    }),
    new Date('2026-05-05T12:30:00.000Z'),
    {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: true,
      timeoutSeconds: 30,
    },
  );

  assert.equal(classification.kind, 'waiting-on-ci');
  assert.match(classification.detail, /pending/);
});

test('normalizes check detailsUrl and databaseId for failed log enrichment', () => {
  const checks = normalizeStatusCheckRollup([{
    name: 'Unit Tests',
    conclusion: 'FAILURE',
    detailsUrl: 'https://github.com/acme/widgets/actions/runs/12345/job/67890',
    databaseId: 112233,
  }]);

  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, 'failure');
  assert.equal(checks[0].detailsUrl, 'https://github.com/acme/widgets/actions/runs/12345/job/67890');
  assert.equal(checks[0].databaseId, 112233);
  assert.match(checks[0].text ?? '', /actions\/runs\/12345/);
});

test('classify completed failing CI as auto-remediable waiting-on-ci', () => {
  const classification = classifyReadyTask(
    makeSnapshot(),
    makeTruth({
      checks: [{ name: 'Alembic Check', status: 'failure', rawStatus: 'FAILURE', text: 'Tests failed in migration chain' }],
    }),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CLASSIFIER_CONFIG,
  );

  assert.equal(classification.kind, 'waiting-on-ci');
  assert.equal(classification.autoRemediable, false);
  assert.equal(classification.ciFailureCategory, 'deterministic-local');
});

test('classify stable safe failing CI as stable-failing-safe after repeated polls', () => {
  const classification = classifyReadyTask(
    makeSnapshot(),
    makeTruth({
      checks: [{ name: 'lint', status: 'failure', rawStatus: 'FAILURE', text: 'eslint lint error: no-unused-vars' }],
    }),
    new Date('2026-05-05T12:30:00.000Z'),
    {
      ...WATCHDOG_CLASSIFIER_CONFIG,
      stableFailureConsecutivePolls: 2,
      stableFailureEscalateAfterPolls: 4,
    },
    {
      issueId: 'HOK-1579',
      slug: 'ready-watchdog-task',
      prNumber: 528,
      classification: 'waiting-on-ci',
      displayLabel: 'waiting on CI',
      detail: 'Failing checks: lint (FAILURE).',
      action: 'reported',
      updatedAt: '2026-05-05T12:20:00.000Z',
      idleMinutes: 20,
      lastProgressAt: '2026-05-05T12:00:00.000Z',
      prStateKey: 'OPEN|MERGEABLE|CLEAN',
      detailFingerprint: 'Failing checks: lint (FAILURE).',
      consecutiveFailurePolls: 1,
    },
  );

  assert.equal(classification.kind, 'stable-failing-safe');
  assert.deepEqual(classification.remediationCategories, ['lint']);
  assert.equal(classification.autoRemediable, true);
  assert.equal(classification.localCommand, 'npm run lint');
});

test('classify sharded deterministic CI failure with local replay command', () => {
  const classification = classifyReadyTask(
    makeSnapshot(),
    makeTruth({
      checks: [{
        name: 'Shell Tests (shard 2/4)',
        status: 'failure',
        rawStatus: 'FAILURE',
        text: 'Assertion failed: expected shell output actual error',
      }],
    }),
    new Date('2026-05-05T12:30:00.000Z'),
    {
      ...WATCHDOG_CLASSIFIER_CONFIG,
      stableFailureConsecutivePolls: 2,
      stableFailureEscalateAfterPolls: 4,
      localCommandMap: {
        ...WATCHDOG_CLASSIFIER_CONFIG.localCommandMap,
        'Shell Tests': 'npm run test:shell',
      },
    },
    {
      issueId: 'HOK-1579',
      slug: 'ready-watchdog-task',
      prNumber: 528,
      classification: 'waiting-on-ci',
      displayLabel: 'waiting on CI',
      detail: 'Failing checks: Shell Tests (shard 2/4) (FAILURE).',
      action: 'reported',
      updatedAt: '2026-05-05T12:20:00.000Z',
      idleMinutes: 20,
      lastProgressAt: '2026-05-05T12:00:00.000Z',
      prStateKey: 'OPEN|MERGEABLE|CLEAN',
      detailFingerprint: 'Failing checks: Shell Tests (shard 2/4) (FAILURE).',
      consecutiveFailurePolls: 1,
    },
  );

  assert.equal(classification.kind, 'stable-failing-safe');
  assert.equal(classification.ciFailureCategory, 'deterministic-local');
  assert.equal(classification.localCommand, 'npm run test:shell');
  assert.match(classification.detail, /Local replay: npm run test:shell/);
});

test('classify resets consecutiveFailurePolls when prStateKey changes between polls', () => {
  const classification = classifyReadyTask(
    makeSnapshot(),
    makeTruth({
      checks: [{ name: 'lint', status: 'failure', rawStatus: 'FAILURE', text: 'eslint lint error: no-unused-vars' }],
    }),
    new Date('2026-05-05T12:30:00.000Z'),
    {
      ...WATCHDOG_CLASSIFIER_CONFIG,
      stableFailureConsecutivePolls: 2,
      stableFailureEscalateAfterPolls: 4,
    },
    {
      issueId: 'HOK-1579',
      slug: 'ready-watchdog-task',
      prNumber: 528,
      classification: 'waiting-on-ci',
      displayLabel: 'waiting on CI',
      detail: 'Failing checks: lint (FAILURE).',
      action: 'reported',
      updatedAt: '2026-05-05T12:20:00.000Z',
      idleMinutes: 20,
      lastProgressAt: '2026-05-05T12:00:00.000Z',
      prStateKey: 'OPEN|UNKNOWN|UNKNOWN',
      detailFingerprint: 'Failing checks: lint (FAILURE).',
      consecutiveFailurePolls: 5,
    },
  );

  assert.equal(classification.kind, 'waiting-on-ci');
  assert.equal(classification.consecutiveFailurePolls, 1);
});

test('classify repeated unsafe failing CI as needs-user after the escalation threshold', () => {
  const classification = classifyReadyTask(
    makeSnapshot(),
    makeTruth({
      checks: [{ name: 'deploy', status: 'failure', rawStatus: 'FAILURE' }],
    }),
    new Date('2026-05-05T12:30:00.000Z'),
    {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: true,
      timeoutSeconds: 30,
      stableFailureConsecutivePolls: 2,
      stableFailureEscalateAfterPolls: 3,
      safeRemediationCategories: ['lint', 'type', 'test', 'build', 'migration-chain', 'alembic'],
    },
    {
      issueId: 'HOK-1579',
      slug: 'ready-watchdog-task',
      prNumber: 528,
      classification: 'waiting-on-ci',
      displayLabel: 'waiting on CI',
      detail: 'Failing checks: deploy (FAILURE).',
      action: 'reported',
      updatedAt: '2026-05-05T12:20:00.000Z',
      idleMinutes: 20,
      lastProgressAt: '2026-05-05T12:00:00.000Z',
      prStateKey: 'OPEN|MERGEABLE|CLEAN',
      detailFingerprint: 'Failing checks: deploy (FAILURE).',
      consecutiveFailurePolls: 2,
    },
  );

  assert.equal(classification.kind, 'needs-user');
  assert.match(classification.detail, /operator attention/);
});

test('classify active eval or comparison as waiting-on-eval-comparison', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      relevantJobs: [{
        id: 'eval-HOK-1579-primary-528',
        kind: 'eval',
        issueId: 'HOK-1579',
        side: 'primary',
        pairId: undefined,
        prNumbers: [528],
        pid: 1,
        startedAt: '2026-05-05T12:10:00.000Z',
        timeoutSeconds: 600,
        logPath: '/tmp/eval.log',
        resultPath: '/tmp/eval.json',
        status: 'running',
        exitCode: null,
        finishedAt: null,
        reason: null,
        excerpt: null,
        settled: false,
      }],
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: true,
      timeoutSeconds: 30,
    },
  );

  assert.equal(classification.kind, 'waiting-on-eval-comparison');
});

test('classify real conflict as needs-user', () => {
  const classification = classifyReadyTask(
    makeSnapshot({ hasConflictMarker: true }),
    makeTruth({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
    new Date('2026-05-05T12:30:00.000Z'),
    {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: true,
      timeoutSeconds: 30,
    },
  );

  assert.equal(classification.kind, 'needs-user');
  assert.match(classification.detail, /merge conflicts/);
});

test('classify disconnected resolved merge remediation as auto-resumable', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      hasConflictMarker: true,
      readyResultStatus: 'running',
      remediationLaunchHead: 'head-sha',
      currentHead: 'head-sha',
      remediationPaneActive: false,
      worktreeMergeState: {
        mergeHead: 'base-sha',
        unmergedPaths: [],
        stagedPaths: ['package.json'],
        unstagedPaths: [],
        untrackedPaths: [],
        rawStatus: ['M  package.json'],
      },
    }),
    makeTruth({ mergeStateStatus: 'DIRTY' }),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
  );

  assert.equal(classification.kind, 'disconnected-remediation');
  assert.equal(classification.autoRecoverable, true);
  assert.match(classification.detail, /package\.json/);
});

test('classify disconnected unresolved merge remediation as needs-user with next command', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      hasConflictMarker: true,
      readyResultStatus: 'running',
      remediationLaunchHead: 'head-sha',
      currentHead: 'head-sha',
      remediationPaneActive: false,
      worktreeMergeState: {
        mergeHead: 'base-sha',
        unmergedPaths: ['package.json'],
        stagedPaths: [],
        unstagedPaths: [],
        untrackedPaths: [],
        rawStatus: ['UU package.json'],
      },
    }),
    makeTruth({ mergeStateStatus: 'DIRTY' }),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
  );

  assert.equal(classification.kind, 'needs-user');
  assert.match(classification.detail, /MERGE_HEAD=base-sha/);
  assert.match(classification.detail, /unmerged=package\.json/);
  assert.match(classification.detail, /Next command: cd/);
});

test('classify mergeable behind PR as auto-update eligible', () => {
  const classification = classifyReadyTask(
    makeSnapshot(),
    makeTruth({ mergeStateStatus: 'BEHIND', baseRefName: 'auto/integration' }),
    new Date('2026-05-05T12:30:00.000Z'),
    {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: true,
      timeoutSeconds: 30,
    },
  );

  assert.equal(classification.kind, 'auto-update');
  assert.match(classification.detail, /behind auto\/integration/);
});

test('tick auto-recovers stale local state for clean green PRs', async () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'ready-watchdog-'));
  const stateDir = path.join(repoDir, '.wavemill');
  const worktree = path.join(repoDir, 'worktrees', 'ready-watchdog-task');
  const featureDir = path.join(worktree, 'features', 'ready-watchdog-task');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(featureDir, { recursive: true });

  const stateFile = path.join(stateDir, 'workflow-state.json');
  writeFileSync(stateFile, JSON.stringify({
    updated: '2026-05-05T12:00:00.000Z',
    tasks: {
      'HOK-1579': {
        slug: 'ready-watchdog-task',
        branch: 'task/ready-watchdog-task',
        worktree,
        pr: 528,
        phase: 'ready',
        updated: '2026-05-05T12:00:00.000Z',
        agent: 'codex',
        model: 'gpt-5.5',
      },
    },
    jobs: {},
  }, null, 2));
  writeFileSync(path.join(featureDir, '.needs-attention'), 'stale local state\n');
  writeFileSync(path.join(featureDir, '.conflict-detected'), '');
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: null,
    agent: 'codex',
    model: 'gpt-5.5',
    notes: 'Ready checks failed',
    artifacts: {
      type: 'ready',
      verdict: 'fail',
      prNumber: 528,
      remediationLaunchHead: 'old-head',
    },
  }, null, 2));

  const result = await tickReadyWatchdog({
    repoDir,
    stateFile,
    config: {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: true,
      timeoutSeconds: 30,
    },
    deps: {
      fetchGitHubTruth: async () => makeTruth(),
      getCurrentHead: async () => 'new-head',
      now: () => new Date('2030-05-05T12:30:00.000Z'),
    },
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].classification, 'stuck');
  assert.equal(result.findings[0].action, 'auto-recovered');
  assert.equal(existsSync(path.join(featureDir, '.needs-attention')), false);
  assert.equal(existsSync(path.join(featureDir, '.conflict-detected')), false);

  const readyResult = JSON.parse(readFileSync(path.join(featureDir, '.ready-result.json'), 'utf-8')) as {
    status: string;
    artifacts: { verdict: string };
  };
  assert.equal(readyResult.status, 'running');
  assert.equal(readyResult.artifacts.verdict, 'pending');

  const watchdogState = JSON.parse(readFileSync(path.join(stateDir, 'ready-watchdog-state.json'), 'utf-8')) as {
    tasks: Record<string, { action: string; failingChecksFingerprint?: string }>;
  };
  assert.equal(watchdogState.tasks['HOK-1579'].action, 'auto-recovered');
  assert.equal(watchdogState.tasks['HOK-1579'].failingChecksFingerprint, undefined);

  await rm(repoDir, { recursive: true, force: true });
});

test('tick completes disconnected resolved conflict remediation', async () => {
  const { repoDir, stateDir, stateFile, featureDir } = setupReadyTask('HOK-2268', 2268);
  writeFileSync(path.join(featureDir, '.conflict-detected'), '');
  writeFileSync(path.join(featureDir, '.needs-attention'), 'stale conflict detail\n');
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: null,
    agent: 'codex',
    model: 'gpt-5.5',
    notes: 'Conflict remediation in progress',
    artifacts: {
      type: 'ready',
      verdict: 'pending',
      prNumber: 2268,
      mergeConflict: 'CONFLICTED',
      launchHead: 'head-1',
    },
  }, null, 2));
  let resumed = false;

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({ mergeStateStatus: 'DIRTY' }),
        getCurrentHead: async () => 'head-1',
        getWorktreeMergeState: async () => ({
          mergeHead: 'base-sha',
          unmergedPaths: [],
          stagedPaths: ['package.json'],
          unstagedPaths: [],
          untrackedPaths: [],
          rawStatus: ['M  package.json'],
        }),
        isTaskPaneActive: async () => false,
        resumeResolvedConflictRemediation: async () => {
          resumed = true;
          return { status: 'completed', detail: 'Committed and pushed resolved conflict remediation for PR #2268.' };
        },
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(resumed, true);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].classification, 'disconnected-remediation');
    assert.equal(result.findings[0].action, 'completed-conflict-remediation');
    assert.equal(existsSync(path.join(featureDir, '.conflict-detected')), false);
    assert.equal(existsSync(path.join(featureDir, '.needs-attention')), false);

    const readyResult = JSON.parse(readFileSync(path.join(featureDir, '.ready-result.json'), 'utf-8')) as {
      status: string;
      artifacts: { verdict: string; launchHead?: string };
    };
    assert.equal(readyResult.status, 'running');
    assert.equal(readyResult.artifacts.verdict, 'pending');
    assert.equal(readyResult.artifacts.launchHead, undefined);

    const watchdogState = JSON.parse(readFileSync(path.join(stateDir, 'ready-watchdog-state.json'), 'utf-8')) as {
      tasks: Record<string, { action: string }>;
    };
    assert.equal(watchdogState.tasks['HOK-2268'].action, 'completed-conflict-remediation');
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick writes needs-attention for disconnected unsafe merge remediation', async () => {
  const { repoDir, stateFile, featureDir } = setupReadyTask('HOK-2268', 2268);
  writeFileSync(path.join(featureDir, '.conflict-detected'), '');
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: null,
    agent: 'codex',
    model: 'gpt-5.5',
    notes: 'Conflict remediation in progress',
    artifacts: {
      type: 'ready',
      verdict: 'pending',
      prNumber: 2268,
      mergeConflict: 'CONFLICTED',
      launchHead: 'head-1',
    },
  }, null, 2));

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({ mergeStateStatus: 'DIRTY' }),
        getCurrentHead: async () => 'head-1',
        getWorktreeMergeState: async () => ({
          mergeHead: 'base-sha',
          unmergedPaths: ['package.json'],
          stagedPaths: [],
          unstagedPaths: [],
          untrackedPaths: [],
          rawStatus: ['UU package.json'],
        }),
        isTaskPaneActive: async () => false,
        resumeResolvedConflictRemediation: async () => {
          throw new Error('should not resume unsafe merge');
        },
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].classification, 'needs-user');
    assert.equal(result.findings[0].action, 'needs-user');
    const attention = readFileSync(path.join(featureDir, '.needs-attention'), 'utf-8');
    assert.match(attention, /unmerged=package\.json/);
    assert.match(attention, /Next command:/);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick launches remediation on stable completed failure', async () => {
  const { repoDir, stateDir, stateFile } = setupReadyTask('HOK-2039', 2039);
  const readyWatchdogToolPath = '/opt/wavemill/tools/ready-watchdog.ts';
  const launches: Array<{ summary: string; names: string[]; attemptNumber: number; maxAttempts: number; toolPath: string }> = [];

  try {
    const deps = {
      fetchGitHubTruth: async () => makeTruth({
        checks: [{ name: 'Alembic Check', status: 'failure', rawStatus: 'FAILURE', text: 'Tests failed in migration chain' }],
      }),
      getCurrentHead: async () => 'head-1',
      launchReadyRemediation: async (
        _snapshot: ReadyTaskSnapshot,
        failedCheckSummary: string,
        failedCheckNames: string[],
        attemptNumber: number,
        maxAttempts: number,
        _repoDir: string,
        toolPath: string,
      ) => {
        launches.push({ summary: failedCheckSummary, names: failedCheckNames, attemptNumber, maxAttempts, toolPath });
        return {
          status: 'launched' as const,
          detail: `Launched ready remediation attempt ${attemptNumber}/${maxAttempts} for failing checks: ${failedCheckSummary}.`,
          attemptNumber,
          launchHead: 'head-1',
        };
      },
      now: () => new Date('2030-05-05T12:30:00.000Z'),
    };

    const first = await tickReadyWatchdog({ repoDir, stateFile, config: WATCHDOG_CONFIG, deps });
    assert.equal(first.findings.length, 1);
    assert.equal(first.findings[0].action, 'waiting-on-ci-stabilizing');
    assert.equal(launches.length, 0);

    const second = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      readyWatchdogToolPath,
      deps: { ...deps, now: () => new Date('2030-05-05T12:31:00.000Z') },
    });
    assert.equal(second.findings.length, 1);
    assert.equal(second.findings[0].action, 'launched-remediation');
    assert.equal(launches.length, 1);
    assert.match(launches[0].summary, /Alembic Check \(FAILURE\)/);
    assert.match(launches[0].summary, /localCommand: npm run ready:migrations/);
    assert.match(launches[0].summary, /logExcerpt:/);
    assert.deepEqual(launches[0].names, ['Alembic Check']);
    assert.equal(launches[0].attemptNumber, 1);
    assert.equal(launches[0].maxAttempts, 3);
    assert.equal(launches[0].toolPath, readyWatchdogToolPath);

    const watchdogState = JSON.parse(readFileSync(path.join(stateDir, 'ready-watchdog-state.json'), 'utf-8')) as {
      tasks: Record<string, { failingChecksObservedCount?: number; action: string }>;
    };
    assert.equal(watchdogState.tasks['HOK-2039'].failingChecksObservedCount, 2);
    assert.equal(watchdogState.tasks['HOK-2039'].action, 'launched-remediation');
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick does not launch remediation while checks are still pending', async () => {
  const { repoDir, stateFile } = setupReadyTask('HOK-2039', 2039);
  let launchCalled = false;

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({
          checks: [
            { name: 'Alembic Check', status: 'failure', rawStatus: 'FAILURE', text: 'Tests failed in migration chain' },
            { name: 'Unit Tests', status: 'pending', rawStatus: 'IN_PROGRESS' },
          ],
        }),
        getCurrentHead: async () => 'head-1',
        launchReadyRemediation: async () => {
          launchCalled = true;
          return { status: 'failed', detail: 'unexpected', attemptNumber: 1 };
        },
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].action, 'reported');
    assert.equal(launchCalled, false);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick preserves recent prior state when GitHub truth is unreadable', async () => {
  const { repoDir, stateDir, stateFile } = setupReadyTask('HOK-2604', 2604);
  let launchCalled = false;
  writeFileSync(path.join(stateDir, 'ready-watchdog-state.json'), JSON.stringify({
    updatedAt: '2030-05-05T12:00:00.000Z',
    tasks: {
      'HOK-2604': {
        issueId: 'HOK-2604',
        slug: 'ready-watchdog-task',
        prNumber: 2604,
        classification: 'needs-user',
        displayLabel: 'Needs user',
        detail: 'PR #2604 has real merge conflicts on GitHub.',
        action: 'needs-user',
        updatedAt: '2030-05-05T12:00:00.000Z',
        classificationSince: '2030-05-05T12:00:00.000Z',
        lastConfirmedAt: '2030-05-05T12:00:00.000Z',
        idleMinutes: 30,
        lastProgressAt: '2030-05-05T11:30:00.000Z',
      },
    },
  }, null, 2));

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({
          state: '',
          mergeable: 'UNKNOWN',
          mergeStateStatus: 'UNKNOWN',
          checks: [],
          checkReadError: { errorType: 'command-failed', reason: 'gh pr view exited 1' },
        }),
        getCurrentHead: async () => 'head-1',
        launchReadyRemediation: async () => {
          launchCalled = true;
          return { status: 'failed', detail: 'unexpected', attemptNumber: 1 };
        },
        now: () => new Date('2030-05-05T12:10:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 0);
    assert.equal(result.reaped.length, 0);
    assert.equal(launchCalled, false);
    const stateAfter = JSON.parse(readFileSync(path.join(stateDir, 'ready-watchdog-state.json'), 'utf-8')) as {
      tasks: Record<string, { updatedAt?: string; classificationSince?: string; lastConfirmedAt?: string }>;
    };
    assert.equal(stateAfter.tasks['HOK-2604'].updatedAt, '2030-05-05T12:00:00.000Z');
    assert.equal(stateAfter.tasks['HOK-2604'].classificationSince, '2030-05-05T12:00:00.000Z');
    assert.equal(stateAfter.tasks['HOK-2604'].lastConfirmedAt, '2030-05-05T12:00:00.000Z');
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick expires old unconfirmed prior state using legacy timestamps', async () => {
  const { repoDir, stateDir, stateFile } = setupReadyTask('HOK-2605', 2605);
  const watchdogStatePath = path.join(stateDir, 'ready-watchdog-state.json');
  writeFileSync(watchdogStatePath, JSON.stringify({
    updatedAt: '2030-05-05T12:00:00.000Z',
    tasks: {
      'HOK-2605': {
        issueId: 'HOK-2605',
        slug: 'ready-watchdog-task',
        prNumber: 2605,
        classification: 'stuck',
        displayLabel: 'Stuck',
        detail: 'old stuck state',
        action: 'reported',
        updatedAt: '2030-05-05T12:00:00.000Z',
        classificationSince: '2030-05-05T12:00:00.000Z',
        idleMinutes: 30,
        lastProgressAt: '2030-05-05T11:30:00.000Z',
      },
    },
  }, null, 2));

  setReadyWatchdogUnconfirmedEntryTtlMsForTest(5 * 60 * 1000);
  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({
          state: '',
          mergeable: 'UNKNOWN',
          mergeStateStatus: 'UNKNOWN',
          checks: [],
          checkReadError: { errorType: 'timeout', reason: 'gh timed out' },
        }),
        getCurrentHead: async () => 'head-1',
        now: () => new Date('2030-05-05T12:10:01.000Z'),
      },
    });

    assert.equal(result.findings.length, 0);
    assert.equal(result.reaped.length, 1);
    assert.equal(result.reaped[0].issueId, 'HOK-2605');
    assert.equal(result.reaped[0].reason, 'unconfirmed-expired');
    const stateAfter = JSON.parse(readFileSync(watchdogStatePath, 'utf-8')) as {
      tasks: Record<string, unknown>;
    };
    assert.equal(stateAfter.tasks['HOK-2605'], undefined);
  } finally {
    setReadyWatchdogUnconfirmedEntryTtlMsForTest(null);
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick enriches failed check logs before classifying CI failures', async () => {
  const { repoDir, stateFile } = setupReadyTask('HOK-2674', 2674);
  const launches: Array<{ summary: string }> = [];
  const deps = {
    fetchGitHubTruth: async () => makeTruth({
      checks: [{ name: 'Unit Tests', status: 'failure' as const, rawStatus: 'FAILURE' }],
    }),
    enrichFailingChecks: async (checks: GitHubPRTruth['checks']) => checks.map((check) => check.status === 'failure'
      ? {
          ...check,
          text: 'Config validation failed:\n  /nativeAgent/providers/openai/models: Repo-local model configuration removed',
        }
      : check),
    getCurrentHead: async () => 'head-1',
    launchReadyRemediation: async (
      _snapshot: ReadyTaskSnapshot,
      failedCheckSummary: string,
    ) => {
      launches.push({ summary: failedCheckSummary });
      return {
        status: 'launched' as const,
        detail: 'Launched remediation for Unit Tests.',
        attemptNumber: 1,
        launchHead: 'head-1',
      };
    },
  };

  try {
    const first = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: { ...deps, now: () => new Date('2030-05-05T12:30:00.000Z') },
    });
    assert.equal(first.findings[0].action, 'waiting-on-ci-stabilizing');
    assert.equal(first.findings[0].lastCiFailureCategory, 'deterministic-local');

    const second = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: { ...deps, now: () => new Date('2030-05-05T12:31:00.000Z') },
    });
    assert.equal(second.findings[0].action, 'launched-remediation');
    assert.equal(launches.length, 1);
    assert.match(launches[0].summary, /Config validation failed/);
    assert.match(launches[0].summary, /Repo-local model configuration removed/);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick degrades to current classification when failed check log enrichment throws', async () => {
  const { repoDir, stateFile } = setupReadyTask('HOK-2674', 2674);

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({
          checks: [{ name: 'Unit Tests', status: 'failure', rawStatus: 'FAILURE' }],
        }),
        enrichFailingChecks: async () => {
          throw new Error('gh api failed');
        },
        getCurrentHead: async () => 'head-1',
        launchReadyRemediation: async () => {
          throw new Error('should not launch');
        },
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].classification, 'needs-user');
    assert.equal(result.findings[0].action, 'reported');
    assert.match(result.findings[0].detail, /operator attention/);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick retries transient CI failures without launching remediation and then escalates', async () => {
  const { repoDir, stateFile, stateDir, featureDir } = setupReadyTask('HOK-2604', 2604);
  let launchCalled = false;
  const deps = {
    fetchGitHubTruth: async () => makeTruth({
      checks: [{
        name: 'Unit Tests',
        status: 'failure' as const,
        rawStatus: 'TIMED_OUT',
        text: 'The hosted runner encountered an error while running your job.',
      }],
    }),
    getCurrentHead: async () => 'head-1',
    launchReadyRemediation: async () => {
      launchCalled = true;
      return { status: 'failed' as const, detail: 'unexpected', attemptNumber: 1 };
    },
  };

  try {
    const first = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: { ...deps, now: () => new Date('2030-05-05T12:30:00.000Z') },
    });
    const second = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: { ...deps, now: () => new Date('2030-05-05T12:31:00.000Z') },
    });
    const third = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: { ...deps, now: () => new Date('2030-05-05T12:32:00.000Z') },
    });

    assert.equal(first.findings[0].action, 'waiting-on-ci-transient');
    assert.equal(second.findings[0].action, 'waiting-on-ci-transient');
    assert.equal(third.findings[0].action, 'transient-retry-exhausted');
    assert.equal(third.findings[0].classification, 'needs-user');
    assert.equal(launchCalled, false);
    assert.match(readFileSync(path.join(featureDir, '.needs-attention'), 'utf-8'), /Transient CI failure budget exhausted/);
    const state = JSON.parse(readFileSync(path.join(stateDir, 'ready-watchdog-state.json'), 'utf-8')) as {
      tasks: Record<string, { transientFailureCount?: number; lastCiFailureCategory?: string }>;
    };
    assert.equal(state.tasks['HOK-2604'].transientFailureCount, 3);
    assert.equal(state.tasks['HOK-2604'].lastCiFailureCategory, 'transient-infra');
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick respects same-head remediation in-flight guard', async () => {
  const { repoDir, stateDir, stateFile, featureDir } = setupReadyTask('HOK-2039', 2039);
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: null,
    agent: 'codex',
    model: 'gpt-5.5',
    notes: null,
    artifacts: { type: 'ready', verdict: 'fail', prNumber: 2039, remediationAttempts: 1, remediationLaunchHead: 'head-1' },
  }, null, 2));
  writeFileSync(path.join(stateDir, 'ready-watchdog-state.json'), JSON.stringify({
    updatedAt: '2030-05-05T12:00:00.000Z',
    tasks: {
      'HOK-2039': {
        issueId: 'HOK-2039',
        slug: 'ready-watchdog-task',
        prNumber: 2039,
        classification: 'waiting-on-ci',
        displayLabel: 'waiting on CI',
        detail: 'prior',
        action: 'reported',
        updatedAt: '2030-05-05T12:00:00.000Z',
        idleMinutes: 30,
        lastProgressAt: '2030-05-05T11:30:00.000Z',
        failingChecksFingerprint: 'alembic check:failure',
        failingChecksObservedCount: 1,
      },
    },
  }, null, 2));

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({
          checks: [{ name: 'Alembic Check', status: 'failure', rawStatus: 'FAILURE', text: 'Tests failed in migration chain' }],
        }),
        getCurrentHead: async () => 'head-1',
        launchReadyRemediation: async () => {
          throw new Error('should not launch');
        },
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].action, 'remediation-in-flight');
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick waits for a fresh verification artifact after remediation push when protocol is present', async () => {
  const { repoDir, stateFile, featureDir } = setupReadyTask('HOK-2604', 2604);
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2030-05-05T12:00:00.000Z',
    finishedAt: null,
    agent: 'codex',
    model: 'gpt-5.5',
    notes: null,
    artifacts: { type: 'ready', verdict: 'fail', prNumber: 2604, remediationAttempts: 1, remediationLaunchHead: 'old-head' },
  }, null, 2));
  writeFileSync(path.join(featureDir, '.verification-artifact-old-head.json'), JSON.stringify({
    headSha: 'old-head',
    timestamp: '2030-05-05T11:59:00.000Z',
  }, null, 2));
  let fetchCalled = false;

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => {
          fetchCalled = true;
          return makeTruth();
        },
        getCurrentHead: async () => 'new-head',
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(fetchCalled, false);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].action, 'awaiting-verification');
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick proceeds to poll CI when verification artifact for remediated head is fresh', async () => {
  const { repoDir, stateFile, featureDir } = setupReadyTask('HOK-2604', 2604);
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2030-05-05T12:00:00.000Z',
    finishedAt: null,
    agent: 'codex',
    model: 'gpt-5.5',
    notes: null,
    artifacts: { type: 'ready', verdict: 'fail', prNumber: 2604, remediationAttempts: 1, remediationLaunchHead: 'old-head' },
  }, null, 2));
  writeFileSync(path.join(featureDir, '.verification-artifact-new-head.json'), JSON.stringify({
    headSha: 'new-head',
    timestamp: '2030-05-05T12:10:00.000Z',
  }, null, 2));
  let fetchCalled = false;

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => {
          fetchCalled = true;
          return makeTruth();
        },
        getCurrentHead: async () => 'new-head',
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(fetchCalled, true);
    assert.notEqual(result.findings[0]?.action, 'awaiting-verification');
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick respects remediation max attempts', async () => {
  const { repoDir, stateDir, stateFile, featureDir } = setupReadyTask('HOK-2039', 2039);
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: null,
    agent: 'codex',
    model: 'gpt-5.5',
    notes: null,
    artifacts: { type: 'ready', verdict: 'fail', prNumber: 2039, remediationAttempts: 3 },
  }, null, 2));
  writeFileSync(path.join(stateDir, 'ready-watchdog-state.json'), JSON.stringify({
    updatedAt: '2030-05-05T12:00:00.000Z',
    tasks: {
      'HOK-2039': {
        issueId: 'HOK-2039',
        slug: 'ready-watchdog-task',
        prNumber: 2039,
        classification: 'waiting-on-ci',
        displayLabel: 'waiting on CI',
        detail: 'prior',
        action: 'reported',
        updatedAt: '2030-05-05T12:00:00.000Z',
        idleMinutes: 30,
        lastProgressAt: '2030-05-05T11:30:00.000Z',
        failingChecksFingerprint: 'alembic check:failure',
        failingChecksObservedCount: 1,
      },
    },
  }, null, 2));

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({
          checks: [{ name: 'Alembic Check', status: 'failure', rawStatus: 'FAILURE', text: 'Tests failed in migration chain' }],
        }),
        getCurrentHead: async () => 'head-2',
        launchReadyRemediation: async () => {
          throw new Error('should not launch');
        },
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].action, 'remediation-exhausted');
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick relaunches remediation when head advances past prior launch head', async () => {
  const { repoDir, stateDir, stateFile, featureDir } = setupReadyTask('HOK-2039', 2039);
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: null,
    agent: 'codex',
    model: 'gpt-5.5',
    notes: null,
    artifacts: { type: 'ready', verdict: 'fail', prNumber: 2039, remediationAttempts: 1, remediationLaunchHead: 'head-1' },
  }, null, 2));
  writeFileSync(path.join(stateDir, 'ready-watchdog-state.json'), JSON.stringify({
    updatedAt: '2030-05-05T12:00:00.000Z',
    tasks: {
      'HOK-2039': {
        issueId: 'HOK-2039',
        slug: 'ready-watchdog-task',
        prNumber: 2039,
        classification: 'waiting-on-ci',
        displayLabel: 'waiting on CI',
        detail: 'prior',
        action: 'reported',
        updatedAt: '2030-05-05T12:00:00.000Z',
        idleMinutes: 30,
        lastProgressAt: '2030-05-05T11:30:00.000Z',
        failingChecksFingerprint: 'alembic check:failure',
        failingChecksObservedCount: 1,
      },
    },
  }, null, 2));
  const launches: Array<{ attemptNumber: number }> = [];

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({
          checks: [{ name: 'Alembic Check', status: 'failure', rawStatus: 'FAILURE', text: 'Tests failed in migration chain' }],
        }),
        getCurrentHead: async () => 'head-2',
        launchReadyRemediation: async (_snapshot, _summary, _names, attemptNumber, maxAttempts) => {
          launches.push({ attemptNumber });
          return {
            status: 'launched' as const,
            detail: `Launched ready remediation attempt ${attemptNumber}/${maxAttempts} for PR #2039.`,
            attemptNumber,
            launchHead: 'head-2',
          };
        },
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].action, 'launched-remediation');
    assert.equal(launches.length, 1);
    assert.equal(launches[0].attemptNumber, 2);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick surfaces remediation launch failures', async () => {
  const { repoDir, stateDir, stateFile } = setupReadyTask('HOK-2039', 2039);
  writeFileSync(path.join(stateDir, 'ready-watchdog-state.json'), JSON.stringify({
    updatedAt: '2030-05-05T12:00:00.000Z',
    tasks: {
      'HOK-2039': {
        issueId: 'HOK-2039',
        slug: 'ready-watchdog-task',
        prNumber: 2039,
        classification: 'waiting-on-ci',
        displayLabel: 'waiting on CI',
        detail: 'prior',
        action: 'reported',
        updatedAt: '2030-05-05T12:00:00.000Z',
        idleMinutes: 30,
        lastProgressAt: '2030-05-05T11:30:00.000Z',
        failingChecksFingerprint: 'alembic check:failure',
        failingChecksObservedCount: 1,
      },
    },
  }, null, 2));

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({
          checks: [{ name: 'Alembic Check', status: 'failure', rawStatus: 'FAILURE', text: 'Tests failed in migration chain' }],
        }),
        getCurrentHead: async () => 'head-2',
        launchReadyRemediation: async () => ({
          status: 'failed',
          detail: 'Failed to launch ready remediation attempt 1/3 for PR #2039.',
          attemptNumber: 1,
        }),
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].action, 'remediation-launch-failed');
    assert.match(result.findings[0].detail, /Failed to launch ready remediation attempt 1\/3/);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick suppresses repeated needs-user when classification and detail are unchanged', async () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'ready-watchdog-'));
  const stateDir = path.join(repoDir, '.wavemill');
  const worktree = path.join(repoDir, 'worktrees', 'ready-watchdog-task');
  const featureDir = path.join(worktree, 'features', 'ready-watchdog-task');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(featureDir, { recursive: true });

  const stateFile = path.join(stateDir, 'workflow-state.json');
  writeFileSync(stateFile, JSON.stringify({
    tasks: {
      'HOK-1581': {
        slug: 'ready-watchdog-task',
        branch: 'task/ready-watchdog-task',
        worktree,
        pr: 541,
        phase: 'ready',
        updated: '2026-05-05T12:00:00.000Z',
      },
    },
    jobs: {},
  }, null, 2));
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: null,
    agent: 'codex',
    model: 'gpt-5.5',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pending', prNumber: 541 },
  }, null, 2));

  const tickOptions = {
    repoDir,
    stateFile,
    config: {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: false,
      timeoutSeconds: 30,
    },
    deps: {
      fetchGitHubTruth: async () => makeTruth({ state: 'MERGED' }),
      getCurrentHead: async () => 'head',
      now: () => new Date('2030-05-05T12:30:00.000Z'),
    },
  };

  const first = await tickReadyWatchdog(tickOptions);
  assert.equal(first.findings.length, 1);
  assert.equal(first.findings[0].classification, 'needs-user');

  const second = await tickReadyWatchdog(tickOptions);
  assert.equal(second.findings.length, 0, 'repeated needs-user should be suppressed on second tick');

  await rm(repoDir, { recursive: true, force: true });
});

test('tick suppresses repeated stable-failure findings across N identical polls', async () => {
  const { repoDir, stateDir, stateFile } = setupReadyTask('HOK-2675', 2675);
  const savedEnv = process.env.WAVEMILL_READY_WATCHDOG_REPORT_INTERVAL_SECONDS;
  process.env.WAVEMILL_READY_WATCHDOG_REPORT_INTERVAL_SECONDS = '3600';

  try {
    const start = new Date('2030-05-05T12:30:00.000Z');
    const configPath = path.join(repoDir, '.wavemill-config.json');
    const repoConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      ready?: Record<string, unknown>;
    };
    writeFileSync(configPath, JSON.stringify({
      ...repoConfig,
      ready: {
        ...(repoConfig.ready ?? {}),
        remediation: { enabled: false },
      },
    }, null, 2));
    let checks: GitHubPRTruth['checks'] = [
      { name: 'lint', status: 'failure', rawStatus: 'FAILURE', text: 'eslint lint error: no-unused-vars' },
      { name: 'Network Probe', status: 'failure', rawStatus: 'FAILURE', text: 'workflow timed out' },
    ];
    writeFileSync(path.join(stateDir, 'ready-watchdog-state.json'), JSON.stringify({
      updatedAt: start.toISOString(),
      tasks: {
        'HOK-2675': {
          issueId: 'HOK-2675',
          slug: 'ready-watchdog-task',
          prNumber: 2675,
          classification: 'waiting-on-ci',
          displayLabel: 'waiting on CI',
          detail: 'Failing checks: lint (FAILURE), Network Probe (FAILURE).',
          action: 'reported',
          updatedAt: start.toISOString(),
          idleMinutes: 30,
          lastProgressAt: '2026-05-05T12:00:00.000Z',
          prStateKey: 'OPEN|MERGEABLE|CLEAN',
          detailFingerprint: 'Failing checks: lint (FAILURE), Network Probe (FAILURE).',
          consecutiveFailurePolls: 1,
          failingChecksFingerprint: 'lint:failure,network probe:failure',
          failingChecksObservedCount: 2,
          lastLoggedAt: start.toISOString(),
          lastLoggedFingerprint: 'Failing checks: lint (FAILURE), Network Probe (FAILURE).',
          lastLoggedClassification: 'waiting-on-ci',
          lastLoggedAction: 'reported',
          lastCiFailureCategory: 'deterministic-local',
          lastFailingJob: 'lint',
          lastLocalCommand: 'npm run lint',
          terminal: false,
        },
      },
    }, null, 2));

    const runTick = (index: number) => tickReadyWatchdog({
      repoDir,
      stateFile,
      config: {
        ...WATCHDOG_CLASSIFIER_CONFIG,
        stableFailureEscalateAfterPolls: 99,
      },
      deps: {
        fetchGitHubTruth: async () => makeTruth({ checks }),
        getCurrentHead: async () => 'head-1',
        now: () => new Date(start.getTime() + index * 23_000),
      },
    });

    for (let index = 1; index <= 5; index += 1) {
      const repeated = await runTick(index);
      assert.equal(repeated.findings.length, 0, `poll ${index} should be rate-limited`);
    }

    const watchdogState = JSON.parse(readFileSync(path.join(stateDir, 'ready-watchdog-state.json'), 'utf-8')) as {
      tasks: Record<string, {
        consecutiveFailurePolls?: number;
        failingChecksObservedCount?: number;
        lastLoggedAt?: string;
      }>;
    };
    assert.equal(watchdogState.tasks['HOK-2675'].consecutiveFailurePolls, 6);
    assert.equal(watchdogState.tasks['HOK-2675'].failingChecksObservedCount, 7);
    assert.equal(watchdogState.tasks['HOK-2675'].lastLoggedAt, start.toISOString());

    checks = [
      { name: 'lint', status: 'failure', rawStatus: 'FAILURE', text: 'eslint lint error: no-unused-vars' },
      { name: 'Network Probe', status: 'failure', rawStatus: 'FAILURE', text: 'workflow timed out' },
      { name: 'Deploy Gate', status: 'failure', rawStatus: 'FAILURE', text: 'manual approval' },
    ];
    const changedFailureSet = await runTick(6);
    assert.equal(changedFailureSet.findings.length, 1, 'new failing check should emit immediately');
  } finally {
    if (savedEnv === undefined) {
      delete process.env.WAVEMILL_READY_WATCHDOG_REPORT_INTERVAL_SECONDS;
    } else {
      process.env.WAVEMILL_READY_WATCHDOG_REPORT_INTERVAL_SECONDS = savedEnv;
    }
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick emits when stable failure crosses escalation threshold', async () => {
  const { repoDir, stateDir, stateFile } = setupReadyTask('HOK-2676', 2676);
  const configPath = path.join(repoDir, '.wavemill-config.json');
  const repoConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as {
    ready?: Record<string, unknown>;
  };
  writeFileSync(configPath, JSON.stringify({
    ...repoConfig,
    ready: {
      ...(repoConfig.ready ?? {}),
      remediation: { enabled: false },
    },
  }, null, 2));
  const savedEnv = process.env.WAVEMILL_READY_WATCHDOG_REPORT_INTERVAL_SECONDS;
  process.env.WAVEMILL_READY_WATCHDOG_REPORT_INTERVAL_SECONDS = '3600';

  try {
    const start = new Date('2030-05-05T12:30:00.000Z');
    writeFileSync(path.join(stateDir, 'ready-watchdog-state.json'), JSON.stringify({
      updatedAt: start.toISOString(),
      tasks: {
        'HOK-2676': {
          issueId: 'HOK-2676',
          slug: 'ready-watchdog-task',
          prNumber: 2676,
          classification: 'waiting-on-ci',
          displayLabel: 'waiting on CI',
          detail: 'Failing checks: lint (FAILURE).',
          action: 'reported',
          updatedAt: start.toISOString(),
          idleMinutes: 30,
          lastProgressAt: '2026-05-05T12:00:00.000Z',
          prStateKey: 'OPEN|MERGEABLE|CLEAN',
          detailFingerprint: 'Failing checks: lint (FAILURE).',
          consecutiveFailurePolls: 1,
          failingChecksFingerprint: 'lint:failure',
          failingChecksObservedCount: 1,
          lastLoggedAt: start.toISOString(),
          lastLoggedFingerprint: 'Failing checks: lint (FAILURE).',
          lastLoggedClassification: 'waiting-on-ci',
          lastLoggedAction: 'reported',
        },
      },
    }, null, 2));

    const thresholdCrossing = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: {
        ...WATCHDOG_CLASSIFIER_CONFIG,
        stableFailureConsecutivePolls: 2,
        stableFailureEscalateAfterPolls: 4,
      },
      deps: {
        fetchGitHubTruth: async () => makeTruth({
          checks: [{ name: 'lint', status: 'failure', rawStatus: 'FAILURE', text: 'eslint lint error: no-unused-vars' }],
        }),
        getCurrentHead: async () => 'head-1',
        now: () => new Date(start.getTime() + 23_000),
      },
    });

    assert.equal(thresholdCrossing.findings.length, 1, 'classification threshold crossing should emit immediately');
    assert.equal(thresholdCrossing.findings[0].classification, 'stable-failing-safe');
    assert.equal(thresholdCrossing.findings[0].action, 'reported');
  } finally {
    if (savedEnv === undefined) {
      delete process.env.WAVEMILL_READY_WATCHDOG_REPORT_INTERVAL_SECONDS;
    } else {
      process.env.WAVEMILL_READY_WATCHDOG_REPORT_INTERVAL_SECONDS = savedEnv;
    }
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick re-surfaces needs-user when detail changes', async () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'ready-watchdog-'));
  const stateDir = path.join(repoDir, '.wavemill');
  const worktree = path.join(repoDir, 'worktrees', 'ready-watchdog-task');
  const featureDir = path.join(worktree, 'features', 'ready-watchdog-task');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(featureDir, { recursive: true });

  const stateFile = path.join(stateDir, 'workflow-state.json');
  writeFileSync(stateFile, JSON.stringify({
    tasks: {
      'HOK-1581': {
        slug: 'ready-watchdog-task',
        branch: 'task/ready-watchdog-task',
        worktree,
        pr: 541,
        phase: 'ready',
        updated: '2026-05-05T12:00:00.000Z',
      },
    },
    jobs: {},
  }, null, 2));
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: null,
    agent: 'codex',
    model: 'gpt-5.5',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pending', prNumber: 541 },
  }, null, 2));

  // Seed prior state with an old needs-user entry for the same issue
  const watchdogStatePath = path.join(stateDir, 'ready-watchdog-state.json');
  writeFileSync(watchdogStatePath, JSON.stringify({
    updatedAt: '2030-05-05T12:00:00.000Z',
    tasks: {
      'HOK-1581': {
        issueId: 'HOK-1581',
        slug: 'ready-watchdog-task',
        prNumber: 541,
        classification: 'needs-user',
        displayLabel: 'needs user',
        detail: 'PR #541 is merged, so ready cannot advance automatically.',
        action: 'reported',
        updatedAt: '2030-05-05T12:00:00.000Z',
        idleMinutes: 30,
        lastProgressAt: '2030-05-05T11:30:00.000Z',
      },
    },
  }, null, 2));

  // Tick with different GitHub state (CLOSED instead of MERGED) → different detail string
  const result = await tickReadyWatchdog({
    repoDir,
    stateFile,
    config: {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: false,
      timeoutSeconds: 30,
    },
    deps: {
      fetchGitHubTruth: async () => makeTruth({ state: 'CLOSED' }),
      getCurrentHead: async () => 'head',
      now: () => new Date('2030-05-05T12:30:00.000Z'),
    },
  });

  assert.equal(result.findings.length, 1, 'changed detail should re-surface the finding');
  assert.match(result.findings[0].detail, /closed/i);

  await rm(repoDir, { recursive: true, force: true });
});

test('tick ignores merged tasks still held in ready phase for review', async () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'ready-watchdog-'));
  const stateDir = path.join(repoDir, '.wavemill');
  const worktree = path.join(repoDir, 'worktrees', 'ready-watchdog-task');
  const featureDir = path.join(worktree, 'features', 'ready-watchdog-task');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(featureDir, { recursive: true });

  const stateFile = path.join(stateDir, 'workflow-state.json');
  writeFileSync(stateFile, JSON.stringify({
    tasks: {
      'HOK-1579': {
        slug: 'ready-watchdog-task',
        branch: 'task/ready-watchdog-task',
        worktree,
        pr: 528,
        phase: 'ready',
        status: 'merged',
        updated: '2026-05-05T12:00:00.000Z',
      },
    },
    jobs: {},
  }, null, 2));
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'completed',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: '2026-05-05T12:00:00.000Z',
    artifacts: {
      type: 'ready',
      verdict: 'pass',
      prNumber: 528,
    },
  }, null, 2));

  let queriedGitHub = false;
  const result = await tickReadyWatchdog({
    repoDir,
    stateFile,
    config: {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: true,
      timeoutSeconds: 30,
    },
    deps: {
      fetchGitHubTruth: async () => {
        queriedGitHub = true;
        return makeTruth({ state: 'MERGED' });
      },
      getCurrentHead: async () => 'head',
      now: () => new Date('2030-05-05T12:30:00.000Z'),
    },
  });

  assert.equal(result.findings.length, 0);
  assert.equal(queriedGitHub, false);

  await rm(repoDir, { recursive: true, force: true });
});

test('tick surfaces a manual recovery command when auto-recover is disabled', async () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'ready-watchdog-'));
  const readyWatchdogToolPath = '/opt/wavemill/tools/ready-watchdog.ts';
  const stateDir = path.join(repoDir, '.wavemill');
  const worktree = path.join(repoDir, 'worktrees', 'ready-watchdog-task');
  const featureDir = path.join(worktree, 'features', 'ready-watchdog-task');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(featureDir, { recursive: true });

  const stateFile = path.join(stateDir, 'workflow-state.json');
  writeFileSync(stateFile, JSON.stringify({
    tasks: {
      'HOK-1579': {
        slug: 'ready-watchdog-task',
        branch: 'task/ready-watchdog-task',
        worktree,
        pr: 528,
        phase: 'ready',
        updated: '2026-05-05T12:00:00.000Z',
      },
    },
    jobs: {},
  }, null, 2));
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: null,
    agent: 'codex',
    model: 'gpt-5.5',
    notes: 'Ready checks failed',
    artifacts: {
      type: 'ready',
      verdict: 'fail',
      prNumber: 528,
    },
  }, null, 2));

  const result = await tickReadyWatchdog({
    repoDir,
    stateFile,
    config: {
      enabled: true,
      thresholdMinutes: 10,
      autoRecover: false,
      timeoutSeconds: 30,
    },
    readyWatchdogToolPath,
    deps: {
      fetchGitHubTruth: async () => makeTruth(),
      getCurrentHead: async () => 'head',
      now: () => new Date('2030-05-05T12:30:00.000Z'),
    },
  });

  assert.equal(result.findings[0].action, 'recovery-command');
  assert.match(result.findings[0].recoveryCommand ?? '', /--recover 'HOK-1579'/);
  assert.match(result.findings[0].recoveryCommand ?? '', /'\/opt\/wavemill\/tools\/ready-watchdog\.ts'/);
  assert.ok(
    !(result.findings[0].recoveryCommand ?? '').includes(path.join(repoDir, 'tools', 'ready-watchdog.ts')),
    'recovery command should not point at the target repo tools directory',
  );

  await rm(repoDir, { recursive: true, force: true });
});

test('tick auto-updates mergeable behind PRs and resets ready state without reporting needs-user', async () => {
  const { repoDir, stateFile, featureDir } = setupReadyTask('HOK-1716', 716);
  let updateCalls = 0;

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: {
        enabled: true,
        thresholdMinutes: 10,
        autoRecover: true,
        timeoutSeconds: 30,
      },
      deps: {
        fetchGitHubTruth: async () => makeTruth({
          mergeStateStatus: 'BEHIND',
          headRefName: 'task/ready-watchdog-task',
          baseRefName: 'auto/integration',
        }),
        getCurrentHead: async () => 'head',
        updateBehindBranch: async () => {
          updateCalls += 1;
          return {
            status: 'success',
            detail: 'updated task/ready-watchdog-task with origin/auto/integration',
          };
        },
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(updateCalls, 1);
    assert.equal(result.findings.length, 0);
    const readyResult = JSON.parse(readFileSync(path.join(featureDir, '.ready-result.json'), 'utf-8')) as {
      status: string;
      notes: string;
      artifacts: { verdict: string };
    };
    assert.equal(readyResult.status, 'running');
    assert.equal(readyResult.artifacts.verdict, 'pending');
    assert.match(readyResult.notes, /updated the PR branch/);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick escalates auto-update conflicts as needs-user with git output', async () => {
  const { repoDir, stateFile } = setupReadyTask('HOK-1716', 716);

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: {
        enabled: true,
        thresholdMinutes: 10,
        autoRecover: true,
        timeoutSeconds: 30,
      },
      deps: {
        fetchGitHubTruth: async () => makeTruth({
          mergeStateStatus: 'BEHIND',
          baseRefName: 'auto/integration',
        }),
        getCurrentHead: async () => 'head',
        updateBehindBranch: async () => ({
          status: 'conflict',
          detail: 'CONFLICT (content): merge conflict in shared/lib/ready-watchdog.ts',
        }),
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].classification, 'needs-user');
    assert.match(result.findings[0].detail, /CONFLICT \(content\)/);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick retries push failures, defaults missing attempts to zero, and exhausts after three attempts', async () => {
  const { repoDir, stateDir, stateFile } = setupReadyTask('HOK-1716', 716);
  const watchdogStatePath = path.join(stateDir, 'ready-watchdog-state.json');
  writeFileSync(watchdogStatePath, JSON.stringify({
    updatedAt: '2030-05-05T12:00:00.000Z',
    tasks: {
      'HOK-1716': {
        issueId: 'HOK-1716',
        slug: 'ready-watchdog-task',
        prNumber: 716,
        classification: 'auto-update',
        displayLabel: 'auto update',
        detail: 'older failure',
        action: 'auto-update-failed',
        updatedAt: '2030-05-05T12:00:00.000Z',
        idleMinutes: 30,
        lastProgressAt: '2030-05-05T11:30:00.000Z',
      },
    },
  }, null, 2));

  try {
    const baseDeps = {
      fetchGitHubTruth: async () => makeTruth({
        mergeStateStatus: 'BEHIND',
        baseRefName: 'auto/integration',
      }),
      getCurrentHead: async () => 'head',
    };

    const first = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: {
        enabled: true,
        thresholdMinutes: 10,
        autoRecover: true,
        timeoutSeconds: 30,
      },
      deps: {
        ...baseDeps,
        updateBehindBranch: async () => ({ status: 'push-failed', detail: 'remote rejected push' }),
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });
    assert.equal(first.findings.length, 1);
    assert.equal(first.findings[0].classification, 'auto-update');
    assert.equal(first.findings[0].autoUpdateAttempts, 1);

    const second = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: {
        enabled: true,
        thresholdMinutes: 10,
        autoRecover: true,
        timeoutSeconds: 30,
      },
      deps: {
        ...baseDeps,
        updateBehindBranch: async () => ({ status: 'push-failed', detail: 'remote rejected push' }),
        now: () => new Date('2030-05-05T12:31:00.000Z'),
      },
    });
    assert.equal(second.findings.length, 1);
    assert.equal(second.findings[0].autoUpdateAttempts, 2);

    const third = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: {
        enabled: true,
        thresholdMinutes: 10,
        autoRecover: true,
        timeoutSeconds: 30,
      },
      deps: {
        ...baseDeps,
        updateBehindBranch: async () => ({ status: 'push-failed', detail: 'remote rejected push' }),
        now: () => new Date('2030-05-05T12:32:00.000Z'),
      },
    });
    assert.equal(third.findings.length, 1);
    assert.equal(third.findings[0].classification, 'needs-user');
    assert.match(third.findings[0].detail, /exhausted after 3 attempts/);

    let calledAgain = false;
    const fourth = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: {
        enabled: true,
        thresholdMinutes: 10,
        autoRecover: true,
        timeoutSeconds: 30,
      },
      deps: {
        ...baseDeps,
        updateBehindBranch: async () => {
          calledAgain = true;
          return { status: 'push-failed', detail: 'remote rejected push' };
        },
        now: () => new Date('2030-05-05T12:33:00.000Z'),
      },
    });
    assert.equal(calledAgain, false);
    assert.equal(fourth.findings.length, 0);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick reaps prior actionable finding when task evaluates fresh', async () => {
  const { repoDir, stateDir, stateFile } = setupReadyTask('HOK-2857', 1206);

  try {
    const first = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: {
        enabled: true,
        thresholdMinutes: 10,
        autoRecover: false,
        timeoutSeconds: 30,
      },
      deps: {
        fetchGitHubTruth: async () => makeTruth({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
        getCurrentHead: async () => 'head',
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });
    assert.equal(first.findings.length, 1);
    assert.equal(first.findings[0].classification, 'needs-user');
    assert.match(first.findings[0].detail, /real merge conflicts/);

    const workflowState = JSON.parse(readFileSync(stateFile, 'utf-8')) as {
      tasks: Record<string, { updated?: string }>;
      jobs: Record<string, unknown>;
    };
    workflowState.tasks['HOK-2857'].updated = '2030-05-05T12:31:00.000Z';
    writeFileSync(stateFile, JSON.stringify(workflowState, null, 2));

    const second = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: {
        enabled: true,
        thresholdMinutes: 10,
        autoRecover: false,
        timeoutSeconds: 30,
      },
      deps: {
        fetchGitHubTruth: async () => makeTruth({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
        getCurrentHead: async () => 'head',
        now: () => new Date('2030-05-05T12:35:00.000Z'),
      },
    });
    assert.equal(second.findings.length, 0);
    assert.equal(second.reaped.length, 1);
    assert.equal(second.reaped[0].issueId, 'HOK-2857');
    assert.equal(second.reaped[0].reason, 'resolved');

    const watchdogState = JSON.parse(readFileSync(path.join(stateDir, 'ready-watchdog-state.json'), 'utf-8')) as {
      tasks: Record<string, unknown>;
    };
    assert.equal(watchdogState.tasks['HOK-2857'], undefined);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick prunes retained watchdog state when a task leaves ready', async () => {
  const { repoDir, stateDir, stateFile } = setupReadyTask('HOK-1716', 716);
  const watchdogStatePath = path.join(stateDir, 'ready-watchdog-state.json');
  writeFileSync(watchdogStatePath, JSON.stringify({
    updatedAt: '2030-05-05T12:00:00.000Z',
    tasks: {
      'HOK-1716': {
        issueId: 'HOK-1716',
        slug: 'ready-watchdog-task',
        prNumber: 716,
        classification: 'needs-user',
        displayLabel: 'needs user',
        detail: 'persisted finding',
        action: 'reported',
        updatedAt: '2030-05-05T12:00:00.000Z',
        idleMinutes: 30,
        lastProgressAt: '2030-05-05T11:30:00.000Z',
      },
    },
  }, null, 2));

  writeFileSync(stateFile, JSON.stringify({
    tasks: {
      'HOK-1716': {
        slug: 'ready-watchdog-task',
        branch: 'task/ready-watchdog-task',
        worktree: path.join(repoDir, 'worktrees', 'ready-watchdog-task'),
        pr: 716,
        phase: 'review',
        updated: '2026-05-05T12:00:00.000Z',
      },
    },
    jobs: {},
  }, null, 2));

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: {
        enabled: true,
        thresholdMinutes: 10,
        autoRecover: false,
        timeoutSeconds: 30,
      },
      deps: {
        fetchGitHubTruth: async () => makeTruth(),
        getCurrentHead: async () => 'head',
        now: () => new Date('2026-05-05T12:04:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 0);
    assert.equal(result.reaped.length, 1);
    assert.equal(result.reaped[0].reason, 'non-ready');
    const watchdogState = JSON.parse(readFileSync(watchdogStatePath, 'utf-8')) as {
      tasks: Record<string, unknown>;
    };
    assert.equal(watchdogState.tasks['HOK-1716'], undefined);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick prunes retained watchdog state when issue is absent from workflow state', async () => {
  const { repoDir, stateDir, stateFile } = setupReadyTask('HOK-1716', 716);
  const watchdogStatePath = path.join(stateDir, 'ready-watchdog-state.json');
  writeFileSync(watchdogStatePath, JSON.stringify({
    updatedAt: '2030-05-05T12:00:00.000Z',
    tasks: {
      'HOK-9999': {
        issueId: 'HOK-9999',
        slug: 'gone-task',
        prNumber: 9999,
        classification: 'stuck',
        displayLabel: 'Stuck',
        detail: 'persisted finding',
        action: 'reported',
        updatedAt: '2030-05-05T12:00:00.000Z',
        classificationSince: '2030-05-05T12:00:00.000Z',
        idleMinutes: 30,
        lastProgressAt: '2030-05-05T11:30:00.000Z',
      },
    },
  }, null, 2));

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth(),
        getCurrentHead: async () => 'head',
        now: () => new Date('2026-05-05T12:04:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 0);
    assert.equal(result.reaped.length, 1);
    assert.equal(result.reaped[0].issueId, 'HOK-9999');
    assert.equal(result.reaped[0].reason, 'absent-from-workflow');
    const watchdogState = JSON.parse(readFileSync(watchdogStatePath, 'utf-8')) as {
      tasks: Record<string, unknown>;
    };
    assert.equal(watchdogState.tasks['HOK-9999'], undefined);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('issue-filtered tick preserves unrelated retained watchdog state', async () => {
  const { repoDir, stateDir, stateFile } = setupReadyTask('HOK-1716', 716);
  const watchdogStatePath = path.join(stateDir, 'ready-watchdog-state.json');
  writeFileSync(watchdogStatePath, JSON.stringify({
    updatedAt: '2030-05-05T12:00:00.000Z',
    tasks: {
      'HOK-9999': {
        issueId: 'HOK-9999',
        slug: 'unrelated-task',
        prNumber: 9999,
        classification: 'needs-user',
        displayLabel: 'Needs user',
        detail: 'unrelated retained finding',
        action: 'reported',
        updatedAt: '2030-05-05T12:00:00.000Z',
        classificationSince: '2030-05-05T12:00:00.000Z',
        idleMinutes: 30,
        lastProgressAt: '2030-05-05T11:30:00.000Z',
      },
    },
  }, null, 2));

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      issueFilter: 'HOK-1716',
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth(),
        getCurrentHead: async () => 'head',
        now: () => new Date('2026-05-05T12:04:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 0);
    assert.equal(result.reaped.length, 0);
    const watchdogState = JSON.parse(readFileSync(watchdogStatePath, 'utf-8')) as {
      tasks: Record<string, unknown>;
    };
    assert.notEqual(watchdogState.tasks['HOK-9999'], undefined);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

// HOK-2300: stable merge-lane waiting fingerprint (idle minutes must not trigger re-emission)
test('tick suppresses repeated waiting-on-merge-lane findings when only idle minutes changed', async () => {
  // Use far-future now so file mtime (real current time) doesn't win the lastProgressAt MAX.
  // finishedAt is 13 minutes before now: qualifies as waiting-on-merge-lane (>=10m, <30m).
  const { repoDir, stateDir, stateFile, featureDir } = setupReadyTask('HOK-2298', 805);
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'completed',
    startedAt: '2030-06-23T12:00:00.000Z',
    finishedAt: '2030-06-23T12:10:00.000Z',
    agent: 'claude',
    model: 'claude-sonnet-4-6',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pass', prNumber: 805, queueState: 'ready-stale' },
  }, null, 2));

  try {
    const baseDeps = {
      fetchGitHubTruth: async () => makeTruth({ mergeStateStatus: 'CLEAN' }),
      getCurrentHead: async () => 'head-1',
      getWorktreeMergeState: async () => ({
        mergeHead: null, unmergedPaths: [], stagedPaths: [], unstagedPaths: [], untrackedPaths: [], rawStatus: [],
      }),
      isTaskPaneActive: async () => null,
      now: () => new Date('2030-06-23T12:23:00.000Z'),
    };

    const first = await tickReadyWatchdog({ repoDir, stateFile, config: WATCHDOG_CONFIG, deps: baseDeps });
    assert.equal(first.findings.length, 1, 'first tick must emit waiting-on-merge-lane');
    assert.equal(first.findings[0].classification, 'waiting-on-merge-lane');
    assert.match(first.findings[0].detail, /idle 13m/);

    // State file must reflect lastLoggedAt and current idle minutes.
    const stateAfterFirst = JSON.parse(readFileSync(path.join(stateDir, 'ready-watchdog-state.json'), 'utf-8')) as {
      tasks: Record<string, { idleMinutes: number; detail: string; lastLoggedAt?: string }>;
    };
    assert.ok(stateAfterFirst.tasks['HOK-2298'].lastLoggedAt, 'lastLoggedAt should be set after first emission');

    // Second tick: same conditions but a minute later — only idle minutes changed.
    const secondDeps = { ...baseDeps, now: () => new Date('2030-06-23T12:24:00.000Z') };
    const second = await tickReadyWatchdog({ repoDir, stateFile, config: WATCHDOG_CONFIG, deps: secondDeps });
    assert.equal(second.findings.length, 0, 'second tick must be suppressed — only idle minutes changed');

    // Dashboard fields must still be updated in state file despite suppression.
    const stateAfterSecond = JSON.parse(readFileSync(path.join(stateDir, 'ready-watchdog-state.json'), 'utf-8')) as {
      tasks: Record<string, { idleMinutes: number; detail: string; lastLoggedAt?: string }>;
    };
    assert.match(stateAfterSecond.tasks['HOK-2298'].detail, /idle 14m/, 'detail should reflect current idle minutes');
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

// HOK-2300: stable merge-lane stall (needs-user) fingerprint
test('tick suppresses repeated merge-lane stall needs-user when only waited minutes changed', async () => {
  // finishedAt is 83 minutes before now: >= escalateMinutes (30m) so classifies as needs-user stall.
  const { repoDir, stateFile, featureDir } = setupReadyTask('HOK-2298', 805);
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'completed',
    startedAt: '2030-06-23T10:00:00.000Z',
    finishedAt: '2030-06-23T11:00:00.000Z',
    agent: 'claude',
    model: 'claude-sonnet-4-6',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pass', prNumber: 805, queueState: 'merge-candidate' },
  }, null, 2));

  const escalateConfig = { ...WATCHDOG_CONFIG, thresholdMinutes: 10 };
  const baseDeps = {
    fetchGitHubTruth: async () => makeTruth({ mergeStateStatus: 'CLEAN' }),
    getCurrentHead: async () => 'head-1',
    getWorktreeMergeState: async () => ({
      mergeHead: null, unmergedPaths: [], stagedPaths: [], unstagedPaths: [], untrackedPaths: [], rawStatus: [],
    }),
    isTaskPaneActive: async () => null,
    now: () => new Date('2030-06-23T12:23:00.000Z'),
  };

  try {
    const first = await tickReadyWatchdog({ repoDir, stateFile, config: escalateConfig, deps: baseDeps });
    assert.equal(first.findings.length, 1, 'first tick must emit stall needs-user');
    assert.equal(first.findings[0].classification, 'needs-user');
    assert.match(first.findings[0].detail, /merge lane appears stalled/i);
    assert.match(first.findings[0].detail, /waited 83m/i);
    const stateAfterFirst = JSON.parse(readFileSync(path.join(repoDir, '.wavemill', 'ready-watchdog-state.json'), 'utf-8')) as {
      tasks: Record<string, { classificationSince?: string }>;
    };
    assert.equal(stateAfterFirst.tasks['HOK-2298'].classificationSince, '2030-06-23T12:23:00.000Z');

    const secondDeps = { ...baseDeps, now: () => new Date('2030-06-23T12:24:00.000Z') };
    const second = await tickReadyWatchdog({ repoDir, stateFile, config: escalateConfig, deps: secondDeps });
    assert.equal(second.findings.length, 0, 'second tick must be suppressed — only waited minutes changed');
    const stateAfterSecond = JSON.parse(readFileSync(path.join(repoDir, '.wavemill', 'ready-watchdog-state.json'), 'utf-8')) as {
      tasks: Record<string, { classificationSince?: string }>;
    };
    assert.equal(
      stateAfterSecond.tasks['HOK-2298'].classificationSince,
      '2030-06-23T12:23:00.000Z',
      'classificationSince should be preserved while classification and fingerprint are stable',
    );
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick preserves classificationSince when only detail fingerprint changes', async () => {
  const { repoDir, stateFile, featureDir } = setupReadyTask('HOK-2677', 2677);
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'completed',
    startedAt: '2030-06-23T10:00:00.000Z',
    finishedAt: '2030-06-23T11:00:00.000Z',
    agent: 'claude',
    model: 'claude-sonnet-4-6',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pass', prNumber: 2677, queueState: 'merge-candidate' },
  }, null, 2));
  writeFileSync(path.join(repoDir, '.wavemill', 'ready-watchdog-state.json'), JSON.stringify({
    updatedAt: '2030-06-23T12:00:00.000Z',
    tasks: {
      'HOK-2677': {
        issueId: 'HOK-2677',
        slug: 'ready-watchdog-task',
        prNumber: 2677,
        classification: 'needs-user',
        displayLabel: 'Needs user',
        detail: 'old detail',
        action: 'needs-user',
        updatedAt: '2030-06-23T12:00:00.000Z',
        classificationSince: '2030-06-23T12:00:00.000Z',
        idleMinutes: 83,
        lastProgressAt: null,
        detailFingerprint: 'old-fingerprint',
        lastReportedAction: 'needs-user',
      },
    },
  }, null, 2));

  const deps = {
    fetchGitHubTruth: async () => makeTruth({ mergeStateStatus: 'CLEAN' }),
    getCurrentHead: async () => 'head-1',
    getWorktreeMergeState: async () => ({
      mergeHead: null, unmergedPaths: [], stagedPaths: [], unstagedPaths: [], untrackedPaths: [], rawStatus: [],
    }),
    isTaskPaneActive: async () => null,
    now: () => new Date('2030-06-23T12:23:00.000Z'),
  };

  try {
    await tickReadyWatchdog({ repoDir, stateFile, config: { ...WATCHDOG_CONFIG, thresholdMinutes: 10 }, deps });
    const stateAfter = JSON.parse(readFileSync(path.join(repoDir, '.wavemill', 'ready-watchdog-state.json'), 'utf-8')) as {
      tasks: Record<string, { classificationSince?: string }>;
    };
    assert.equal(stateAfter.tasks['HOK-2677'].classificationSince, '2030-06-23T12:00:00.000Z');
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick resets classificationSince when classification changes', async () => {
  const { repoDir, stateFile, featureDir } = setupReadyTask('HOK-2678', 2678);
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'completed',
    startedAt: '2030-06-23T10:00:00.000Z',
    finishedAt: '2030-06-23T11:00:00.000Z',
    agent: 'claude',
    model: 'claude-sonnet-4-6',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pass', prNumber: 2678, queueState: 'merge-candidate' },
  }, null, 2));
  writeFileSync(path.join(repoDir, '.wavemill', 'ready-watchdog-state.json'), JSON.stringify({
    updatedAt: '2030-06-23T12:00:00.000Z',
    tasks: {
      'HOK-2678': {
        issueId: 'HOK-2678',
        slug: 'ready-watchdog-task',
        prNumber: 2678,
        classification: 'waiting-on-ci',
        displayLabel: 'Waiting on CI',
        detail: 'old detail',
        action: 'reported',
        updatedAt: '2030-06-23T12:00:00.000Z',
        classificationSince: '2030-06-23T12:00:00.000Z',
        idleMinutes: 83,
        lastProgressAt: null,
        detailFingerprint: 'old-fingerprint',
        lastReportedAction: 'reported',
      },
    },
  }, null, 2));

  const deps = {
    fetchGitHubTruth: async () => makeTruth({ mergeStateStatus: 'CLEAN' }),
    getCurrentHead: async () => 'head-1',
    getWorktreeMergeState: async () => ({
      mergeHead: null, unmergedPaths: [], stagedPaths: [], unstagedPaths: [], untrackedPaths: [], rawStatus: [],
    }),
    isTaskPaneActive: async () => null,
    now: () => new Date('2030-06-23T12:23:00.000Z'),
  };

  try {
    await tickReadyWatchdog({ repoDir, stateFile, config: { ...WATCHDOG_CONFIG, thresholdMinutes: 10 }, deps });
    const stateAfter = JSON.parse(readFileSync(path.join(repoDir, '.wavemill', 'ready-watchdog-state.json'), 'utf-8')) as {
      tasks: Record<string, { classification?: string; classificationSince?: string }>;
    };
    assert.equal(stateAfter.tasks['HOK-2678'].classification, 'needs-user');
    assert.equal(stateAfter.tasks['HOK-2678'].classificationSince, '2030-06-23T12:23:00.000Z');
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick reports missing tend loop instead of generic merge-lane stall', async () => {
  const { repoDir, stateFile, featureDir } = setupReadyTask('HOK-2375', 877);
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'completed',
    startedAt: '2030-06-23T10:00:00.000Z',
    finishedAt: '2030-06-23T11:00:00.000Z',
    agent: 'claude',
    model: 'claude-sonnet-4-6',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pass', prNumber: 877, queueState: 'merge-candidate' },
  }, null, 2));
  writeFileSync(path.join(repoDir, '.wavemill', 'backstage-health.json'), JSON.stringify({
    updatedAt: '2030-06-23T12:22:00.000Z',
    status: 'missing-tend-loop',
    detail: 'backstage window is missing the Wavemill Tend Loop executor pane while status panes remain',
    restartAttemptCount: 1,
    lastRestartAttemptAt: '2030-06-23T12:22:00.000Z',
    executorPaneId: null,
  }, null, 2));

  const baseDeps = {
    fetchGitHubTruth: async () => makeTruth({ mergeStateStatus: 'CLEAN' }),
    getCurrentHead: async () => 'head-1',
    getWorktreeMergeState: async () => ({
      mergeHead: null, unmergedPaths: [], stagedPaths: [], unstagedPaths: [], untrackedPaths: [], rawStatus: [],
    }),
    isTaskPaneActive: async () => null,
    now: () => new Date('2030-06-23T12:23:00.000Z'),
  };

  try {
    const result = await tickReadyWatchdog({ repoDir, stateFile, config: WATCHDOG_CONFIG, deps: baseDeps });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].classification, 'needs-user');
    assert.match(result.findings[0].detail, /missing tend loop/i);
    assert.doesNotMatch(result.findings[0].detail, /merge lane appears stalled/i);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick reports stalled tend heartbeat instead of generic merge-lane stall', async () => {
  const { repoDir, stateFile, featureDir } = setupReadyTask('HOK-2856', 1191);
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'completed',
    startedAt: '2030-06-23T10:00:00.000Z',
    finishedAt: '2030-06-23T11:00:00.000Z',
    agent: 'claude',
    model: 'claude-sonnet-4-6',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pass', prNumber: 1191, queueState: 'merge-candidate' },
  }, null, 2));
  writeFileSync(path.join(repoDir, '.wavemill', 'backstage-health.json'), JSON.stringify({
    updatedAt: '2030-06-23T12:22:00.000Z',
    status: 'stalled',
    detail: 'tend heartbeat is stale (420s old)',
    restartAttemptCount: 1,
    lastRestartAttemptAt: '2030-06-23T12:22:00.000Z',
    executorPaneId: '%9',
  }, null, 2));

  const baseDeps = {
    fetchGitHubTruth: async () => makeTruth({ mergeStateStatus: 'CLEAN' }),
    getCurrentHead: async () => 'head-1',
    getWorktreeMergeState: async () => ({
      mergeHead: null, unmergedPaths: [], stagedPaths: [], unstagedPaths: [], untrackedPaths: [], rawStatus: [],
    }),
    isTaskPaneActive: async () => null,
    now: () => new Date('2030-06-23T12:23:00.000Z'),
  };

  try {
    const result = await tickReadyWatchdog({ repoDir, stateFile, config: WATCHDOG_CONFIG, deps: baseDeps });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].classification, 'needs-user');
    assert.match(result.findings[0].detail, /stalled tend loop/i);
    assert.match(result.findings[0].detail, /heartbeat is stale/i);
    assert.doesNotMatch(result.findings[0].detail, /merge lane appears stalled/i);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

// HOK-2300: rate-limit repeated reported findings
test('rate-limits repeated reported findings using WAVEMILL_READY_WATCHDOG_REPORT_INTERVAL_SECONDS', async () => {
  const { repoDir, stateFile, featureDir } = setupReadyTask('HOK-2300', 900);
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-06-23T10:00:00.000Z',
    finishedAt: null,
    agent: 'claude',
    model: 'claude-sonnet-4-6',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pending', prNumber: 900 },
  }, null, 2));

  const savedEnv = process.env.WAVEMILL_READY_WATCHDOG_REPORT_INTERVAL_SECONDS;
  process.env.WAVEMILL_READY_WATCHDOG_REPORT_INTERVAL_SECONDS = '3600';

  try {
    const t0 = new Date('2030-06-23T10:00:00.000Z');
    const baseDeps = {
      fetchGitHubTruth: async () => makeTruth({ state: 'MERGED' }),
      getCurrentHead: async () => 'head-1',
      now: () => t0,
    };

    const first = await tickReadyWatchdog({ repoDir, stateFile, config: WATCHDOG_CONFIG, deps: baseDeps });
    assert.equal(first.findings.length, 1, 'first tick emits');
    assert.equal(first.findings[0].action, 'reported');

    // Within interval (1800s elapsed < 3600s): suppress
    const t1 = new Date(t0.getTime() + 1800 * 1000);
    const withinInterval = await tickReadyWatchdog({
      repoDir, stateFile, config: WATCHDOG_CONFIG,
      deps: { ...baseDeps, now: () => t1 },
    });
    assert.equal(withinInterval.findings.length, 0, 'within interval must be suppressed');

    // At interval boundary (3600s elapsed): emit
    const t2 = new Date(t0.getTime() + 3600 * 1000);
    const atInterval = await tickReadyWatchdog({
      repoDir, stateFile, config: WATCHDOG_CONFIG,
      deps: { ...baseDeps, now: () => t2 },
    });
    assert.equal(atInterval.findings.length, 1, 'at interval must emit');

    // Immediately after re-emission: suppress again
    const t3 = new Date(t2.getTime() + 1000);
    const afterReemit = await tickReadyWatchdog({
      repoDir, stateFile, config: WATCHDOG_CONFIG,
      deps: { ...baseDeps, now: () => t3 },
    });
    assert.equal(afterReemit.findings.length, 0, 'immediately after re-emission must be suppressed again');
  } finally {
    if (savedEnv === undefined) {
      delete process.env.WAVEMILL_READY_WATCHDOG_REPORT_INTERVAL_SECONDS;
    } else {
      process.env.WAVEMILL_READY_WATCHDOG_REPORT_INTERVAL_SECONDS = savedEnv;
    }
    await rm(repoDir, { recursive: true, force: true });
  }
});

// HOK-2300: classification/action changes bypass rate limit
test('classification or action change emits immediately regardless of report interval', async () => {
  const { repoDir, stateDir, stateFile, featureDir } = setupReadyTask('HOK-2300', 900);
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-06-23T10:00:00.000Z',
    finishedAt: null,
    agent: 'claude',
    model: 'claude-sonnet-4-6',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pending', prNumber: 900 },
  }, null, 2));

  // Seed prior state as if we logged a 'reported' finding 1 minute ago
  const t0 = new Date('2030-06-23T10:00:00.000Z');
  writeFileSync(path.join(stateDir, 'ready-watchdog-state.json'), JSON.stringify({
    updatedAt: t0.toISOString(),
    tasks: {
      'HOK-2300': {
        issueId: 'HOK-2300',
        slug: 'ready-watchdog-task',
        prNumber: 900,
        classification: 'needs-user',
        displayLabel: 'needs user',
        detail: 'PR #900 is merged, so ready cannot advance automatically.',
        action: 'reported',
        updatedAt: t0.toISOString(),
        idleMinutes: 200,
        lastProgressAt: '2026-06-23T10:00:00.000Z',
        detailFingerprint: 'PR #900 is merged, so ready cannot advance automatically.',
        lastLoggedAt: t0.toISOString(),
        lastLoggedFingerprint: 'PR #900 is merged, so ready cannot advance automatically.',
        lastLoggedClassification: 'needs-user',
        lastLoggedAction: 'reported',
      },
    },
  }, null, 2));

  try {
    // Now the state changes (PR closed instead of merged)
    const t1 = new Date(t0.getTime() + 60_000);
    const result = await tickReadyWatchdog({
      repoDir, stateFile, config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({ state: 'CLOSED' }),
        getCurrentHead: async () => 'head-1',
        now: () => t1,
      },
    });
    assert.equal(result.findings.length, 1, 'changed detail must emit immediately even within interval');
    assert.match(result.findings[0].detail, /closed/i);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

// HOK-2300: backward compatibility — old state files without lastLogged* fields
test('first tick on old state file without lastLogged* fields emits and backfills', async () => {
  const { repoDir, stateDir, stateFile, featureDir } = setupReadyTask('HOK-2300', 900);
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-06-23T10:00:00.000Z',
    finishedAt: null,
    agent: 'claude',
    model: 'claude-sonnet-4-6',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pending', prNumber: 900 },
  }, null, 2));

  // Old-format state file: has detailFingerprint and lastReportedAction but no lastLogged* fields
  writeFileSync(path.join(stateDir, 'ready-watchdog-state.json'), JSON.stringify({
    updatedAt: '2030-06-23T10:00:00.000Z',
    tasks: {
      'HOK-2300': {
        issueId: 'HOK-2300',
        slug: 'ready-watchdog-task',
        prNumber: 900,
        classification: 'needs-user',
        displayLabel: 'needs user',
        detail: 'PR #900 is merged, so ready cannot advance automatically.',
        action: 'reported',
        updatedAt: '2030-06-23T10:00:00.000Z',
        idleMinutes: 200,
        lastProgressAt: '2026-06-23T10:00:00.000Z',
        detailFingerprint: 'PR #900 is merged, so ready cannot advance automatically.',
        lastReportedAction: 'reported',
        // Intentionally NO lastLoggedAt / lastLoggedFingerprint / etc.
      },
    },
  }, null, 2));

  try {
    const result = await tickReadyWatchdog({
      repoDir, stateFile, config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({ state: 'MERGED' }),
        getCurrentHead: async () => 'head-1',
        now: () => new Date('2030-06-23T10:01:00.000Z'),
      },
    });
    assert.equal(result.findings.length, 1, 'old state without lastLogged* must emit on first tick');

    const stateAfter = JSON.parse(readFileSync(path.join(stateDir, 'ready-watchdog-state.json'), 'utf-8')) as {
      tasks: Record<string, { lastLoggedAt?: string; lastLoggedClassification?: string; lastLoggedAction?: string }>;
    };
    assert.ok(stateAfter.tasks['HOK-2300'].lastLoggedAt, 'lastLoggedAt should be backfilled');
    assert.equal(stateAfter.tasks['HOK-2300'].lastLoggedClassification, 'needs-user');
    assert.equal(stateAfter.tasks['HOK-2300'].lastLoggedAction, 'reported');
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

// HOK-2403: challenge pair gate — classifyReadyTask unit tests

test('classify challenge PR in merge lane with no comparison as waiting-on-eval-comparison', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 15,
      challengePairId: 'HOK-2358',
      readyArtifacts: { type: 'ready', verdict: 'pass', queueState: 'ready-stale' },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
    undefined,
    {
      kind: 'pair-unresolved',
      pairId: 'HOK-2358',
      otherPr: null,
      reason: 'pair-unresolved:no-comparison',
    },
  );

  assert.equal(classification.kind, 'waiting-on-eval-comparison');
  assert.match(classification.detail, /HOK-2358/);
  assert.match(classification.detail, /pair-unresolved:no-comparison/);
  assert.match(classification.detail, /merge controller will not select/i);
});

test('classify challenge PR in merge lane with no comparison includes other PR number when available', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 15,
      challengePairId: 'HOK-2358',
      readyArtifacts: { type: 'ready', verdict: 'pass', queueState: 'merge-candidate' },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
    undefined,
    {
      kind: 'pair-unresolved',
      pairId: 'HOK-2358',
      otherPr: 900,
      reason: 'pair-unresolved:no-comparison',
    },
  );

  assert.equal(classification.kind, 'waiting-on-eval-comparison');
  assert.match(classification.detail, /pair PR #900/);
});

test('classify orphaned challenge PR in merge lane as needs-user with recovery command', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 15,
      challengePairId: 'HOK-2358',
      readyArtifacts: { type: 'ready', verdict: 'pass', queueState: 'merge-candidate' },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
    undefined,
    {
      kind: 'pair-unresolvable',
      pairId: 'HOK-2358',
      otherPr: null,
      reason: 'orphan-sibling',
    },
  );

  assert.equal(classification.kind, 'needs-user');
  assert.match(classification.detail, /no discoverable sibling task\/PR\/branch/i);
  assert.match(classification.recoveryCommand ?? '', /resolve-orphan-challenge-pair\.ts/);
  assert.match(classification.recoveryCommand ?? '', /--reason 'orphan-sibling'/);
  assert.match(classification.recoveryCommand ?? '', /--dry-run/);
});

test('classify challenge PR with exhausted sibling eval as needs-user with recovery command', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 15,
      challengePairId: 'HOK-2358',
      readyArtifacts: { type: 'ready', verdict: 'pass', queueState: 'merge-candidate' },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
    undefined,
    {
      kind: 'pair-unresolvable',
      pairId: 'HOK-2358',
      otherPr: 900,
      reason: 'sibling-eval-hard-failed',
    },
  );

  assert.equal(classification.kind, 'needs-user');
  assert.match(classification.detail, /exhausted challenge eval hard-failure retries/i);
  assert.match(classification.detail, /pair PR #900/);
  assert.match(classification.recoveryCommand ?? '', /--reason 'sibling-eval-hard-failed'/);
});

test('classify challenge PR with aborted sibling as needs-user with recovery command', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 15,
      challengePairId: 'HOK-2358',
      readyArtifacts: { type: 'ready', verdict: 'pass', queueState: 'merge-candidate' },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
    undefined,
    {
      kind: 'pair-unresolvable',
      pairId: 'HOK-2358',
      otherPr: 900,
      reason: 'sibling-challenge-aborted',
    },
  );

  assert.equal(classification.kind, 'needs-user');
  assert.match(classification.detail, /terminal launch failure/i);
  assert.match(classification.detail, /quarantined/i);
  assert.match(classification.recoveryCommand ?? '', /--reason 'sibling-challenge-aborted'/);
});

test('classify challenge PR with both arms aborted as needs-user with recovery command', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 15,
      challengePairId: 'HOK-2358',
      readyArtifacts: { type: 'ready', verdict: 'pass', queueState: 'merge-candidate' },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
    undefined,
    {
      kind: 'pair-unresolvable',
      pairId: 'HOK-2358',
      otherPr: 900,
      reason: 'both-challenge-aborted',
    },
  );

  assert.equal(classification.kind, 'needs-user');
  assert.match(classification.detail, /both arms were quarantined/i);
  assert.match(classification.recoveryCommand ?? '', /--reason 'both-challenge-aborted'/);
});

test('classify running comparison gate as waiting-on-eval-comparison with specific detail', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 15,
      challengePairId: 'HOK-2358',
      readyArtifacts: { type: 'ready', verdict: 'pass', queueState: 'ready-stale' },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
    undefined,
    {
      kind: 'pair-unresolved',
      pairId: 'HOK-2358',
      otherPr: 900,
      reason: 'pair-unresolved:comparison-in-progress',
    },
  );

  assert.equal(classification.kind, 'waiting-on-eval-comparison');
  assert.match(classification.detail, /comparison job/i);
  assert.match(classification.detail, /pair PR #900/);
});

test('non-challenge PR in merge lane still classifies as waiting-on-merge-lane when no gate is provided', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 15,
      challengePairId: null,
      readyArtifacts: { type: 'ready', verdict: 'pass', queueState: 'ready-stale' },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
  );

  assert.equal(classification.kind, 'waiting-on-merge-lane');
});

test('challenge PR that is a winner in merge lane still classifies as waiting-on-merge-lane', () => {
  const classification = classifyReadyTask(
    makeSnapshot({
      idleMinutes: 15,
      challengePairId: 'HOK-2358',
      readyArtifacts: { type: 'ready', verdict: 'pass', queueState: 'ready-stale' },
    }),
    makeTruth(),
    new Date('2026-05-05T12:30:00.000Z'),
    WATCHDOG_CONFIG,
    undefined,
    {
      kind: 'winner',
      pairId: 'HOK-2358',
      loserPr: 900,
      autoMerge: true,
    },
  );

  assert.equal(classification.kind, 'waiting-on-merge-lane');
});

// HOK-2403: integration tests using tickReadyWatchdog

test('tick classifies challenge PR in merge lane as waiting-on-eval-comparison when comparison is missing', async () => {
  const { repoDir, stateDir, stateFile, featureDir } = setupReadyTask('HOK-2358', 893);

  // Override workflow state with challenge task metadata
  writeFileSync(stateFile, JSON.stringify({
    tasks: {
      'HOK-2358': {
        slug: 'ready-watchdog-task',
        branch: 'task/ready-watchdog-task',
        worktree: path.join(repoDir, 'worktrees', 'ready-watchdog-task'),
        pr: 893,
        phase: 'ready',
        updated: '2026-05-05T12:00:00.000Z',
        agent: 'claude',
        model: 'claude-sonnet-4-6',
        challengePairId: 'HOK-2358',
        challengeRole: 'primary',
      },
      'HOK-2358_c': {
        slug: 'ready-watchdog-task-challenger',
        branch: 'task/ready-watchdog-task-challenger',
        worktree: path.join(repoDir, 'worktrees', 'ready-watchdog-task-challenger'),
        pr: 894,
        phase: 'coding',
        updated: '2026-05-05T12:00:00.000Z',
        agent: 'claude',
        model: 'claude-opus-4-8',
        challengePairId: 'HOK-2358',
        challengeRole: 'challenger',
      },
    },
    jobs: {},
  }, null, 2));

  // Ready artifacts indicate the PR is in the merge lane
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'completed',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: '2026-05-05T12:00:00.000Z',
    agent: 'claude',
    model: 'claude-sonnet-4-6',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pass', prNumber: 893, queueState: 'ready-stale' },
  }, null, 2));

  // No challenge-records.jsonl — simulates missing comparison
  // (evals dir already exists from setupReadyTask via stateDir)

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({ mergeStateStatus: 'CLEAN' }),
        getCurrentHead: async () => 'head-1',
        getWorktreeMergeState: async () => ({
          mergeHead: null, unmergedPaths: [], stagedPaths: [], unstagedPaths: [], untrackedPaths: [], rawStatus: [],
        }),
        isTaskPaneActive: async () => null,
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].classification, 'waiting-on-eval-comparison',
      `expected waiting-on-eval-comparison, got ${result.findings[0].classification}: ${result.findings[0].detail}`);
    assert.notEqual(result.findings[0].classification, 'waiting-on-merge-lane');
    assert.match(result.findings[0].detail, /HOK-2358/);
    assert.match(result.findings[0].detail, /pair-unresolved:no-comparison/);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick uses hard-failure retry config for challenge classification', async () => {
  const { repoDir, stateFile, featureDir } = setupReadyTask('HOK-2358', 893);

  writeFileSync(path.join(repoDir, '.wavemill-config.json'), JSON.stringify({
    challenge: { eval: { hardFailureRetryMaxAttempts: 3 } },
  }, null, 2));

  writeFileSync(stateFile, JSON.stringify({
    tasks: {
      'HOK-2358': {
        slug: 'ready-watchdog-task',
        branch: 'task/ready-watchdog-task',
        worktree: path.join(repoDir, 'worktrees', 'ready-watchdog-task'),
        pr: 893,
        phase: 'ready',
        updated: '2026-05-05T12:00:00.000Z',
        agent: 'claude',
        model: 'claude-sonnet-4-6',
        challengePairId: 'HOK-2358',
        challengeRole: 'primary',
        evalCompleted: true,
      },
      'HOK-2358_c': {
        slug: 'ready-watchdog-task-challenger',
        branch: 'task/ready-watchdog-task-challenger',
        worktree: path.join(repoDir, 'worktrees', 'ready-watchdog-task-challenger'),
        pr: 894,
        phase: 'ready',
        updated: '2026-05-05T12:00:00.000Z',
        agent: 'claude',
        model: 'claude-opus-4-8',
        challengePairId: 'HOK-2358',
        challengeRole: 'challenger',
        evalFailed: true,
        evalHardFailureRetryCount: 2,
      },
    },
    jobs: {},
  }, null, 2));

  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'completed',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: '2026-05-05T12:00:00.000Z',
    agent: 'claude',
    model: 'claude-sonnet-4-6',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pass', prNumber: 893, queueState: 'ready-stale' },
  }, null, 2));

  const deps = {
    fetchGitHubTruth: async () => makeTruth({ mergeStateStatus: 'CLEAN' }),
    getCurrentHead: async () => 'head-1',
    getWorktreeMergeState: async () => ({
      mergeHead: null, unmergedPaths: [], stagedPaths: [], unstagedPaths: [], untrackedPaths: [], rawStatus: [],
    }),
    isTaskPaneActive: async () => null,
    now: () => new Date('2030-05-05T12:30:00.000Z'),
  };

  try {
    const pending = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps,
    });
    assert.equal(pending.findings[0].classification, 'waiting-on-eval-comparison');
    assert.match(pending.findings[0].detail, /pair-unresolved:no-comparison/);

    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    state.tasks['HOK-2358_c'].evalHardFailureRetryCount = 3;
    writeFileSync(stateFile, JSON.stringify(state, null, 2));

    const exhausted = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps,
    });
    assert.equal(exhausted.findings[0].classification, 'needs-user');
    assert.match(exhausted.findings[0].detail, /exhausted challenge eval hard-failure retries/i);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick classifies orphaned challenge PR in merge lane as needs-user with recovery command', async () => {
  const { repoDir, stateFile, featureDir } = setupReadyTask('HOK-2358', 893);

  writeFileSync(stateFile, JSON.stringify({
    tasks: {
      'HOK-2358': {
        slug: 'ready-watchdog-task',
        branch: 'task/ready-watchdog-task',
        worktree: path.join(repoDir, 'worktrees', 'ready-watchdog-task'),
        pr: 893,
        phase: 'ready',
        updated: '2026-05-05T12:00:00.000Z',
        agent: 'claude',
        model: 'claude-sonnet-4-6',
        challengePairId: 'HOK-2358',
        challengeRole: 'primary',
      },
    },
    jobs: {},
  }, null, 2));

  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'completed',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: '2026-05-05T12:00:00.000Z',
    agent: 'claude',
    model: 'claude-sonnet-4-6',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pass', prNumber: 893, queueState: 'ready-stale' },
  }, null, 2));

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({ mergeStateStatus: 'CLEAN' }),
        getCurrentHead: async () => 'head-1',
        getWorktreeMergeState: async () => ({
          mergeHead: null, unmergedPaths: [], stagedPaths: [], unstagedPaths: [], untrackedPaths: [], rawStatus: [],
        }),
        isTaskPaneActive: async () => null,
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(result.findings[0].classification, 'needs-user');
    assert.match(result.findings[0].detail, /no discoverable sibling task\/PR\/branch/i);
    assert.match(result.findings[0].recoveryCommand ?? '', /resolve-orphan-challenge-pair\.ts/);
    assert.match(result.findings[0].recoveryCommand ?? '', /--dry-run/);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick classifies running challenge comparison as waiting-on-eval-comparison', async () => {
  const { repoDir, stateFile, featureDir } = setupReadyTask('HOK-2358', 893);

  writeFileSync(stateFile, JSON.stringify({
    tasks: {
      'HOK-2358': {
        slug: 'ready-watchdog-task',
        branch: 'task/ready-watchdog-task',
        worktree: path.join(repoDir, 'worktrees', 'ready-watchdog-task'),
        pr: 893,
        phase: 'ready',
        updated: '2026-05-05T12:00:00.000Z',
        agent: 'claude',
        model: 'claude-sonnet-4-6',
        challengePairId: 'HOK-2358',
        challengeRole: 'primary',
      },
      'HOK-2358_c': {
        slug: 'ready-watchdog-task-challenger',
        branch: 'task/ready-watchdog-task-challenger',
        worktree: path.join(repoDir, 'worktrees', 'ready-watchdog-task-challenger'),
        pr: 894,
        phase: 'ready',
        updated: '2026-05-05T12:00:00.000Z',
        agent: 'claude',
        model: 'claude-opus-4-8',
        challengePairId: 'HOK-2358',
        challengeRole: 'challenger',
      },
    },
    jobs: {
      'comparison-HOK-2358-893-894': {
        id: 'comparison-HOK-2358-893-894',
        kind: 'comparison',
        pairId: 'HOK-2358',
        prNumbers: [893, 894],
        pid: 123,
        startedAt: '2026-05-05T12:05:00.000Z',
        timeoutSeconds: 240,
        logPath: '/tmp/comparison.log',
        resultPath: '/tmp/comparison.result.json',
        status: 'running',
        exitCode: null,
        finishedAt: null,
        reason: null,
        excerpt: null,
        settled: false,
      },
    },
  }, null, 2));

  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'completed',
    startedAt: '2026-05-05T11:55:00.000Z',
    finishedAt: '2026-05-05T12:00:00.000Z',
    agent: 'claude',
    model: 'claude-sonnet-4-6',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pass', prNumber: 893, queueState: 'merge-candidate' },
  }, null, 2));

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({ mergeStateStatus: 'CLEAN' }),
        getCurrentHead: async () => 'head-1',
        getWorktreeMergeState: async () => ({
          mergeHead: null, unmergedPaths: [], stagedPaths: [], unstagedPaths: [], untrackedPaths: [], rawStatus: [],
        }),
        isTaskPaneActive: async () => null,
        now: () => new Date('2030-05-05T12:30:00.000Z'),
      },
    });

    assert.equal(result.findings[0].classification, 'waiting-on-eval-comparison');
    assert.match(result.findings[0].detail, /comparison job/i);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick classifies non-challenge clean green PR in merge lane as waiting-on-merge-lane (no regression)', async () => {
  const { repoDir, stateFile, featureDir } = setupReadyTask('HOK-9999', 999);

  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'completed',
    startedAt: '2030-06-23T12:00:00.000Z',
    finishedAt: '2030-06-23T12:10:00.000Z',
    agent: 'claude',
    model: 'claude-sonnet-4-6',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pass', prNumber: 999, queueState: 'ready-stale' },
  }, null, 2));

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({ mergeStateStatus: 'CLEAN' }),
        getCurrentHead: async () => 'head-1',
        getWorktreeMergeState: async () => ({
          mergeHead: null, unmergedPaths: [], stagedPaths: [], unstagedPaths: [], untrackedPaths: [], rawStatus: [],
        }),
        isTaskPaneActive: async () => null,
        now: () => new Date('2030-06-23T12:23:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].classification, 'waiting-on-merge-lane');
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('tick classifies challenge PR in merge lane as waiting-on-merge-lane when comparison exists (winner)', async () => {
  const { repoDir, stateDir, stateFile, featureDir } = setupReadyTask('HOK-2358', 893);

  writeFileSync(stateFile, JSON.stringify({
    tasks: {
      'HOK-2358': {
        slug: 'ready-watchdog-task',
        branch: 'task/ready-watchdog-task',
        worktree: path.join(repoDir, 'worktrees', 'ready-watchdog-task'),
        pr: 893,
        phase: 'ready',
        updated: '2026-05-05T12:00:00.000Z',
        agent: 'claude',
        model: 'claude-sonnet-4-6',
        challengePairId: 'HOK-2358',
        challengeRole: 'primary',
      },
    },
    jobs: {},
  }, null, 2));

  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'completed',
    startedAt: '2030-06-23T12:00:00.000Z',
    finishedAt: '2030-06-23T12:10:00.000Z',
    agent: 'claude',
    model: 'claude-sonnet-4-6',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pass', prNumber: 893, queueState: 'ready-stale' },
  }, null, 2));

  // Write a comparison record that makes PR #893 the winner
  const evalsDir = path.join(stateDir, 'evals');
  mkdirSync(evalsDir, { recursive: true });
  writeFileSync(path.join(evalsDir, 'challenge-records.jsonl'), JSON.stringify({
    challengePairId: 'HOK-2358',
    primaryModel: 'claude-sonnet-4-6',
    challengerModel: 'claude-opus-4-5',
    primaryPrUrl: 'https://github.com/org/repo/pull/893',
    challengerPrUrl: 'https://github.com/org/repo/pull/894',
    primaryEvalScore: 0.9,
    challengerEvalScore: 0.7,
    winner: 'primary',
    winnerModel: 'claude-sonnet-4-6',
    rationale: 'primary was better',
    dimensions: {
      completeness: { primary: 0.9, challenger: 0.7 },
      correctness: { primary: 0.9, challenger: 0.7 },
      code_quality: { primary: 0.9, challenger: 0.7 },
      intervention_impact: { primary: 0.9, challenger: 0.7 },
      autonomy: { primary: 0.9, challenger: 0.7 },
    },
    timestamp: '2026-05-05T11:00:00.000Z',
  }) + '\n', 'utf-8');

  try {
    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      config: WATCHDOG_CONFIG,
      deps: {
        fetchGitHubTruth: async () => makeTruth({ mergeStateStatus: 'CLEAN' }),
        getCurrentHead: async () => 'head-1',
        getWorktreeMergeState: async () => ({
          mergeHead: null, unmergedPaths: [], stagedPaths: [], unstagedPaths: [], untrackedPaths: [], rawStatus: [],
        }),
        isTaskPaneActive: async () => null,
        now: () => new Date('2030-06-23T12:23:00.000Z'),
      },
    });

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].classification, 'waiting-on-merge-lane',
      `winner challenge PR should still be waiting-on-merge-lane, got: ${result.findings[0].classification}: ${result.findings[0].detail}`);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

// HOK-2300: env variable validation
test('WAVEMILL_READY_WATCHDOG_REPORT_INTERVAL_SECONDS validation falls back to 3600 for invalid values', async () => {
  const { repoDir, stateFile, featureDir } = setupReadyTask('HOK-2300', 900);
  writeFileSync(path.join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'running',
    startedAt: '2026-06-23T10:00:00.000Z',
    finishedAt: null,
    agent: 'claude',
    model: 'claude-sonnet-4-6',
    notes: null,
    artifacts: { type: 'ready', verdict: 'pending', prNumber: 900 },
  }, null, 2));

  const savedEnv = process.env.WAVEMILL_READY_WATCHDOG_REPORT_INTERVAL_SECONDS;
  const invalidValues = ['abc', '0', '-1', '12.5', ''];

  try {
    for (const invalidValue of invalidValues) {
      // Reset state for each sub-test by re-running with a fresh repo state
      const { repoDir: r, stateFile: sf, featureDir: fd } = setupReadyTask('HOK-2300', 900);
      writeFileSync(path.join(fd, '.ready-result.json'), JSON.stringify({
        stage: 'ready', status: 'running', startedAt: '2026-06-23T10:00:00.000Z', finishedAt: null,
        agent: 'claude', model: 'claude-sonnet-4-6', notes: null,
        artifacts: { type: 'ready', verdict: 'pending', prNumber: 900 },
      }, null, 2));

      if (invalidValue === '') {
        delete process.env.WAVEMILL_READY_WATCHDOG_REPORT_INTERVAL_SECONDS;
      } else {
        process.env.WAVEMILL_READY_WATCHDOG_REPORT_INTERVAL_SECONDS = invalidValue;
      }

      const t0 = new Date('2030-06-23T10:00:00.000Z');
      const baseDeps = {
        fetchGitHubTruth: async () => makeTruth({ state: 'MERGED' }),
        getCurrentHead: async () => 'head-1',
        now: () => t0,
      };

      // First tick must always emit
      const first = await tickReadyWatchdog({ repoDir: r, stateFile: sf, config: WATCHDOG_CONFIG, deps: baseDeps });
      assert.equal(first.findings.length, 1, `should emit on first tick with env="${invalidValue}"`);

      // One second later must be suppressed (defaults to 3600s interval)
      const second = await tickReadyWatchdog({
        repoDir: r, stateFile: sf, config: WATCHDOG_CONFIG,
        deps: { ...baseDeps, now: () => new Date(t0.getTime() + 1000) },
      });
      assert.equal(second.findings.length, 0, `should suppress within default interval for env="${invalidValue}"`);
      await rm(r, { recursive: true, force: true });
    }
  } finally {
    if (savedEnv === undefined) {
      delete process.env.WAVEMILL_READY_WATCHDOG_REPORT_INTERVAL_SECONDS;
    } else {
      process.env.WAVEMILL_READY_WATCHDOG_REPORT_INTERVAL_SECONDS = savedEnv;
    }
    await rm(repoDir, { recursive: true, force: true });
  }
});
