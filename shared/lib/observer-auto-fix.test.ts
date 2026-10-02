import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  OBSERVER_AUTO_FIX_DEFAULTS,
  type ObserverAutoFixConfig,
} from './config.ts';
import {
  checkAutoFixPreconditions,
  runObserverAutoFixes,
  type AutoFixCandidateFinding,
  type AutoFixDeps,
  type AutoFixRepoContext,
  type AutoFixTask,
  type AutoFixActionRecord,
} from './observer-auto-fix.ts';
import type { TaskProgress } from './task-progress.ts';
import type { BranchBaseUpdateResult } from './promotion-controller.ts';

function mkRepoDir(): string {
  return mkdtempSync(join(tmpdir(), 'observer-auto-fix-'));
}

function makeConfig(overrides: Partial<ObserverAutoFixConfig> = {}): ObserverAutoFixConfig {
  return {
    enabled: true,
    quietMinutes: 0,
    updateBranchFromBase: { enabled: true, maxAttempts: 2 },
    resetReadyRecheckBudget: { enabled: true },
    forfeitStuckChallengeArm: { enabled: true, stuckHours: 2 },
    ...overrides,
    updateBranchFromBase: { ...OBSERVER_AUTO_FIX_DEFAULTS.updateBranchFromBase, enabled: true, maxAttempts: 2, ...overrides.updateBranchFromBase },
    resetReadyRecheckBudget: { enabled: true, ...overrides.resetReadyRecheckBudget },
    forfeitStuckChallengeArm: { enabled: true, stuckHours: 2, ...overrides.forfeitStuckChallengeArm },
  };
}

function activeProgress(ageMinutes = 60): TaskProgress {
  return {
    issue: 'HOK-X',
    computedAt: new Date().toISOString(),
    lastProgressAt: new Date(Date.now() - ageMinutes * 60_000).toISOString(),
    progressAgeMinutes: ageMinutes,
    sources: [],
    agentState: 'idle',
    agentRecord: null,
    controllerState: null,
    agentIdle: true,
    terminal: false,
    terminalIdle: false,
    agentProcessLive: false,
    agentBackgroundLive: null,
    backgroundProcesses: [],
    stalled: false,
    stallMinutes: 0,
  };
}

function workingProgress(): TaskProgress {
  return { ...activeProgress(), agentState: 'working', agentIdle: false };
}

function makeDeps(overrides: Partial<AutoFixDeps> = {}): AutoFixDeps {
  return {
    git: () => '',
    gh: () => ({ ok: true, stdout: '', stderr: '' }),
    updateBranchWithBase: () => ({ status: 'success', detail: 'ok' }),
    readWorktreeDirtyStatus: () => ({ state: 'clean', lines: [], raw: '' }),
    getProgress: () => activeProgress(),
    abortTaskInState: async () => undefined,
    ...overrides,
  };
}

function makeContext(repoDir: string): AutoFixRepoContext {
  const stateDir = join(repoDir, 'features', 'slug');
  mkdirSync(stateDir, { recursive: true });
  return {
    repoDir,
    session: 'test-session',
    workflowStatePath: join(repoDir, '.wavemill', 'workflow-state.json'),
    effectiveBaseBranch: () => 'main',
    resolveTaskStateDir: () => stateDir,
    incidentStoreDir: join(repoDir, '.wavemill', 'incidents'),
    journalPath: join(repoDir, '.wavemill', 'observer', 'auto-fix-state.json'),
  };
}

const BASE_TASK: AutoFixTask = {
  issue: 'HOK-9001',
  slug: 'slug',
  phase: 'ready',
  status: 'running',
  pr: '123',
  worktree: '/tmp/none',
  branch: 'task/x',
  baseBranch: 'main',
};

// ─── Preconditions ──────────────────────────────────────────────────────────

test('precondition: dirty tree skips with reason=dirty-tree', () => {
  const deps = makeDeps({
    readWorktreeDirtyStatus: () => ({
      state: 'dirty',
      lines: [' M src/foo.ts'],
      raw: ' M src/foo.ts',
    }),
  });
  const result = checkAutoFixPreconditions(BASE_TASK, deps, '/tmp/stateDir');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'dirty-tree');
  assert.ok(result.evidence.some((e) => e.startsWith('dirtyPath=')));
});

test('precondition: unreadable tree fails closed', () => {
  const deps = makeDeps({
    readWorktreeDirtyStatus: () => ({ state: 'unreadable', lines: [], raw: '' }),
  });
  const result = checkAutoFixPreconditions(BASE_TASK, deps, '/tmp/stateDir');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'dirty-tree');
  assert.ok(result.evidence.includes('worktreeDirty=unreadable'));
});

test('precondition: working agent skips with reason=agent-working', () => {
  const deps = makeDeps({ getProgress: () => workingProgress() });
  const result = checkAutoFixPreconditions(BASE_TASK, deps, '/tmp/stateDir');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'agent-working');
});

test('precondition: background work live skips with reason=agent-working', () => {
  const deps = makeDeps({ getProgress: () => ({ ...activeProgress(), agentBackgroundLive: true }) });
  const result = checkAutoFixPreconditions(BASE_TASK, deps, '/tmp/stateDir');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'agent-working');
});

test('precondition: no progress available fails closed', () => {
  const deps = makeDeps({ getProgress: () => undefined });
  const result = checkAutoFixPreconditions(BASE_TASK, deps, '/tmp/stateDir');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'progress-unknown');
});

test('precondition: no worktree is not-applicable', () => {
  const deps = makeDeps();
  const result = checkAutoFixPreconditions({ ...BASE_TASK, worktree: undefined }, deps, undefined);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-applicable');
});

test('precondition: clean, idle, non-terminal passes', () => {
  const deps = makeDeps();
  const result = checkAutoFixPreconditions(BASE_TASK, deps, '/tmp/stateDir');
  assert.equal(result.ok, true);
});

// ─── Disabled no-ops ────────────────────────────────────────────────────────

test('disabled: master switch off → no deps called, no records, no findings', async () => {
  const repoDir = mkRepoDir();
  try {
    const context = makeContext(repoDir);
    let gitCalls = 0;
    const deps = makeDeps({
      git: () => {
        gitCalls += 1;
        return '';
      },
    });
    const result = await runObserverAutoFixes({
      repo: context,
      tasks: [BASE_TASK],
      findings: [],
      config: { ...OBSERVER_AUTO_FIX_DEFAULTS },
      deps,
      now: new Date(),
    });
    assert.equal(result.records.length, 0);
    assert.equal(result.findings.length, 0);
    assert.equal(gitCalls, 0, 'no deps called when disabled');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ─── Update-branch-from-base ────────────────────────────────────────────────

test('update-branch: dirty tree → skipped record with reason=dirty-tree and medium finding', async () => {
  const repoDir = mkRepoDir();
  try {
    const context = makeContext(repoDir);
    const deps = makeDeps({
      readWorktreeDirtyStatus: () => ({ state: 'dirty', lines: [' M src/x.ts'], raw: ' M src/x.ts' }),
    });
    const findings: AutoFixCandidateFinding[] = [{ id: 'branch-behind-base-s1-HOK-9001', issue: 'HOK-9001', severity: 'medium' }];
    const result = await runObserverAutoFixes({
      repo: context,
      tasks: [BASE_TASK],
      findings,
      config: makeConfig(),
      deps,
      now: new Date(),
    });
    const skip = result.records.find((r) => r.outcome === 'skipped' && r.fix === 'update-branch-from-base');
    assert.ok(skip, 'skipped record present');
    assert.equal(skip!.reason, 'dirty-tree');
    assert.ok(result.findings.some((f) => f.id === 'observer-auto-fix-skipped-update-branch-from-base-HOK-9001'));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('update-branch: working agent skips with reason=agent-working', async () => {
  const repoDir = mkRepoDir();
  try {
    const context = makeContext(repoDir);
    const deps = makeDeps({ getProgress: () => workingProgress() });
    const findings: AutoFixCandidateFinding[] = [{ id: 'branch-behind-base-s1-HOK-9001', issue: 'HOK-9001', severity: 'medium' }];
    const result = await runObserverAutoFixes({
      repo: context,
      tasks: [BASE_TASK],
      findings,
      config: makeConfig(),
      deps,
      now: new Date(),
    });
    const skip = result.records.find((r) => r.outcome === 'skipped' && r.fix === 'update-branch-from-base');
    assert.ok(skip);
    assert.equal(skip!.reason, 'agent-working');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('update-branch: dry-run plans without mutating', async () => {
  const repoDir = mkRepoDir();
  try {
    const context = makeContext(repoDir);
    let updates = 0;
    const deps = makeDeps({
      git: (args) => {
        if (args.includes('rev-parse') && args.at(-1) === 'HEAD') return 'aaaaaaa';
        if (args.includes('rev-parse') && args.at(-1)?.startsWith('origin/')) return 'bbbbbbb';
        if (args.includes('--is-ancestor')) throw new Error('no');
        if (args.includes('rev-list')) return '3';
        return '';
      },
      updateBranchWithBase: () => {
        updates += 1;
        return { status: 'success', detail: 'ok' };
      },
    });
    const findings: AutoFixCandidateFinding[] = [{ id: 'branch-behind-base-s1-HOK-9001', issue: 'HOK-9001', severity: 'medium' }];
    const result = await runObserverAutoFixes({
      repo: context,
      tasks: [BASE_TASK],
      findings,
      config: makeConfig(),
      deps,
      now: new Date(),
      dryRun: true,
    });
    assert.ok(result.records.some((r) => r.outcome === 'planned' && r.fix === 'update-branch-from-base'));
    assert.equal(updates, 0, 'no mutation in dry-run');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('update-branch: merge conflict → failed record + high finding + exhausted bucket', async () => {
  const repoDir = mkRepoDir();
  try {
    const context = makeContext(repoDir);
    const deps = makeDeps({
      git: (args) => {
        if (args.includes('rev-parse') && args.at(-1) === 'HEAD') return 'aaaaaaa';
        if (args.includes('rev-parse') && args.at(-1)?.startsWith('origin/')) return 'bbbbbbb';
        if (args.includes('--is-ancestor')) throw new Error('no');
        if (args.includes('rev-list')) return '3';
        return '';
      },
      updateBranchWithBase: (): BranchBaseUpdateResult => ({
        status: 'conflict',
        detail: 'conflict in src/foo.ts',
        conflictingFiles: ['src/foo.ts'],
      }),
    });
    const findings: AutoFixCandidateFinding[] = [{ id: 'branch-behind-base-s1-HOK-9001', issue: 'HOK-9001', severity: 'medium' }];
    const result = await runObserverAutoFixes({
      repo: context,
      tasks: [BASE_TASK],
      findings,
      config: makeConfig(),
      deps,
      now: new Date(),
    });
    const failed = result.records.find((r) => r.outcome === 'failed' && r.fix === 'update-branch-from-base');
    assert.ok(failed);
    assert.deepEqual(failed!.conflictingFiles, ['src/foo.ts']);
    const finding = result.findings.find((f) => f.id === 'observer-auto-fix-failed-update-branch-from-base-HOK-9001');
    assert.ok(finding, 'high finding emitted');
    assert.equal(finding!.severity, 'high');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ─── Reset-ready-budget ─────────────────────────────────────────────────────

test('reset-budget: unchanged key does not reset', async () => {
  const repoDir = mkRepoDir();
  try {
    const context = makeContext(repoDir);
    const stateDir = context.resolveTaskStateDir(BASE_TASK)!;
    // Create a sentinel keyed to aaaaaaa.
    writeFileSync(join(stateDir, '.failed-ready-recheck-count'), '3');
    writeFileSync(join(stateDir, '.failed-ready-recheck-head'), 'aaaaaaa\n');
    writeFileSync(join(stateDir, '.failed-ready-recheck-exhausted'), 'test');
    const deps = makeDeps({
      git: (args) => {
        if (args.at(-1) === 'HEAD') return 'aaaaaaa';
        if (args.at(-1) === 'origin/main') return 'cccccccc';
        return '';
      },
    });
    const result = await runObserverAutoFixes({
      repo: context,
      tasks: [BASE_TASK],
      findings: [],
      config: makeConfig({ updateBranchFromBase: { enabled: false, maxAttempts: 2 } as ObserverAutoFixConfig['updateBranchFromBase'] }),
      deps,
      now: new Date(),
    });
    assert.equal(result.records.length, 0, 'unchanged key → no action');
    assert.ok(existsSync(join(stateDir, '.failed-ready-recheck-exhausted')));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('reset-budget: head change clears the bucket', async () => {
  const repoDir = mkRepoDir();
  try {
    const context = makeContext(repoDir);
    const stateDir = context.resolveTaskStateDir(BASE_TASK)!;
    writeFileSync(join(stateDir, '.failed-ready-recheck-count'), '3');
    writeFileSync(join(stateDir, '.failed-ready-recheck-head'), 'aaaaaaa\n');
    writeFileSync(join(stateDir, '.failed-ready-recheck-exhausted'), 'test');
    const deps = makeDeps({
      git: (args) => {
        if (args.at(-1) === 'HEAD') return 'bbbbbbb';
        if (args.at(-1) === 'origin/main') return 'ddddddd';
        return '';
      },
    });
    const result = await runObserverAutoFixes({
      repo: context,
      tasks: [BASE_TASK],
      findings: [],
      config: makeConfig({ updateBranchFromBase: { enabled: false, maxAttempts: 2 } as ObserverAutoFixConfig['updateBranchFromBase'] }),
      deps,
      now: new Date(),
    });
    const applied = result.records.find((r) => r.outcome === 'applied' && r.fix === 'reset-ready-budget');
    assert.ok(applied, 'reset applied');
    assert.ok(!existsSync(join(stateDir, '.failed-ready-recheck-exhausted')), 'sentinel removed');
    assert.ok(!existsSync(join(stateDir, '.failed-ready-recheck-count')), 'counter removed');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ─── Forfeit stuck arm ──────────────────────────────────────────────────────

test('forfeit: both arms stuck → finding only, no abort, no PR close', async () => {
  const repoDir = mkRepoDir();
  try {
    const context = makeContext(repoDir);
    const stateDirPrimary = join(repoDir, 'features', 'primary');
    const stateDirChallenger = join(repoDir, 'features', 'challenger');
    mkdirSync(stateDirPrimary, { recursive: true });
    mkdirSync(stateDirChallenger, { recursive: true });
    const oldMtime = Date.now() - 3 * 60 * 60 * 1000;
    writeFileSync(join(stateDirPrimary, '.retry-ready-remediation-exhausted'), 'test');
    writeFileSync(join(stateDirChallenger, '.retry-ready-remediation-exhausted'), 'test');
    // Backdate the mtime so the stuck-hours threshold is crossed.
    const { utimesSync } = await import('node:fs');
    utimesSync(join(stateDirPrimary, '.retry-ready-remediation-exhausted'), new Date(oldMtime), new Date(oldMtime));
    utimesSync(join(stateDirChallenger, '.retry-ready-remediation-exhausted'), new Date(oldMtime), new Date(oldMtime));

    const tasks: AutoFixTask[] = [
      {
        issue: 'HOK-7000',
        slug: 'primary',
        phase: 'ready',
        pr: '200',
        worktree: '/tmp/none',
        branch: 'task/primary',
        baseBranch: 'main',
        challengePairId: 'HOK-7000',
        evalCompleted: true,
      },
      {
        issue: 'HOK-7000_c',
        slug: 'challenger',
        phase: 'ready',
        pr: '201',
        worktree: '/tmp/none',
        branch: 'task/challenger',
        baseBranch: 'main',
        challengePairId: 'HOK-7000',
        evalCompleted: true,
      },
    ];
    const ctx: AutoFixRepoContext = {
      ...context,
      resolveTaskStateDir: (t) => t.slug === 'primary' ? stateDirPrimary : stateDirChallenger,
    };
    let aborts = 0;
    const deps = makeDeps({
      abortTaskInState: async () => {
        aborts += 1;
      },
      gh: () => ({ ok: true, stdout: '', stderr: '' }),
      getProgress: () => activeProgress(240),
    });
    const result = await runObserverAutoFixes({
      repo: ctx,
      tasks,
      findings: [],
      config: makeConfig({ updateBranchFromBase: { enabled: false, maxAttempts: 2 } as ObserverAutoFixConfig['updateBranchFromBase'], resetReadyRecheckBudget: { enabled: false } }),
      deps,
      now: new Date(),
    });
    assert.equal(aborts, 0, 'no abort on both-stuck');
    assert.ok(result.findings.some((f) => f.id.startsWith('challenge-pair-both-stuck-')));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('forfeit: challenger stuck, sibling evalCompleted → abort + gh pr close + applied record', async () => {
  const repoDir = mkRepoDir();
  try {
    const context = makeContext(repoDir);
    const stateDirPrimary = join(repoDir, 'features', 'primary');
    const stateDirChallenger = join(repoDir, 'features', 'challenger');
    mkdirSync(stateDirPrimary, { recursive: true });
    mkdirSync(stateDirChallenger, { recursive: true });
    const oldMtime = Date.now() - 3 * 60 * 60 * 1000;
    writeFileSync(join(stateDirChallenger, '.retry-ready-remediation-exhausted'), 'test');
    const { utimesSync } = await import('node:fs');
    utimesSync(join(stateDirChallenger, '.retry-ready-remediation-exhausted'), new Date(oldMtime), new Date(oldMtime));

    // Prepare workflow-state so abortTaskInState can mutate it. The injected
    // dep stubs this out, so we just need the file to exist.
    mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
    writeFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), JSON.stringify({ tasks: {} }));

    const tasks: AutoFixTask[] = [
      {
        issue: 'HOK-7001',
        slug: 'primary',
        phase: 'ready',
        pr: '202',
        worktree: '/tmp/none',
        branch: 'task/primary',
        baseBranch: 'main',
        challengePairId: 'HOK-7001',
        evalCompleted: true,
      },
      {
        issue: 'HOK-7001_c',
        slug: 'challenger',
        phase: 'ready',
        pr: '203',
        worktree: '/tmp/none',
        branch: 'task/challenger',
        baseBranch: 'main',
        challengePairId: 'HOK-7001',
        evalCompleted: false,
      },
    ];
    const ctx: AutoFixRepoContext = {
      ...context,
      resolveTaskStateDir: (t) => t.slug === 'primary' ? stateDirPrimary : stateDirChallenger,
    };
    let aborts = 0;
    const ghCalls: string[][] = [];
    const deps = makeDeps({
      abortTaskInState: async (_file, issue, reason) => {
        aborts += 1;
        assert.equal(issue, 'HOK-7001_c');
        assert.match(reason, /observer-auto-forfeit/);
      },
      gh: (args) => {
        ghCalls.push(args);
        return { ok: true, stdout: '', stderr: '' };
      },
      getProgress: () => activeProgress(240),
    });
    const result = await runObserverAutoFixes({
      repo: ctx,
      tasks,
      findings: [],
      config: makeConfig({ updateBranchFromBase: { enabled: false, maxAttempts: 2 } as ObserverAutoFixConfig['updateBranchFromBase'], resetReadyRecheckBudget: { enabled: false } }),
      deps,
      now: new Date(),
    });
    assert.equal(aborts, 1, 'abort called once');
    const closeArgs = ghCalls.find((a) => a[0] === 'pr' && a[1] === 'close');
    assert.ok(closeArgs, 'gh pr close called');
    assert.ok(!closeArgs!.includes('--delete-branch'), '--delete-branch never passed');
    const applied = result.records.find((r) => r.outcome === 'applied' && r.fix === 'forfeit-stuck-challenge-arm');
    assert.ok(applied);
    assert.equal(applied!.prClosed, true);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('forfeit: gh pr close fails → applied record with prClosed:false + medium finding', async () => {
  const repoDir = mkRepoDir();
  try {
    const context = makeContext(repoDir);
    const stateDirChallenger = join(repoDir, 'features', 'challenger');
    mkdirSync(stateDirChallenger, { recursive: true });
    const oldMtime = Date.now() - 3 * 60 * 60 * 1000;
    writeFileSync(join(stateDirChallenger, '.retry-ready-remediation-exhausted'), 'test');
    const { utimesSync } = await import('node:fs');
    utimesSync(join(stateDirChallenger, '.retry-ready-remediation-exhausted'), new Date(oldMtime), new Date(oldMtime));
    mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
    writeFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), JSON.stringify({ tasks: {} }));

    const tasks: AutoFixTask[] = [
      { issue: 'HOK-7002', slug: 'primary', phase: 'ready', pr: '204', worktree: '/tmp/none', branch: 'task/primary', baseBranch: 'main', challengePairId: 'HOK-7002', evalCompleted: true },
      { issue: 'HOK-7002_c', slug: 'challenger', phase: 'ready', pr: '205', worktree: '/tmp/none', branch: 'task/challenger', baseBranch: 'main', challengePairId: 'HOK-7002', evalCompleted: false },
    ];
    const ctx: AutoFixRepoContext = {
      ...context,
      resolveTaskStateDir: (t) => join(repoDir, 'features', t.slug ?? ''),
    };
    const deps = makeDeps({
      abortTaskInState: async () => undefined,
      gh: () => ({ ok: false, stdout: '', stderr: 'auth error' }),
      getProgress: () => activeProgress(240),
    });
    const result = await runObserverAutoFixes({
      repo: ctx,
      tasks,
      findings: [],
      config: makeConfig({ updateBranchFromBase: { enabled: false, maxAttempts: 2 } as ObserverAutoFixConfig['updateBranchFromBase'], resetReadyRecheckBudget: { enabled: false } }),
      deps,
      now: new Date(),
    });
    const applied = result.records.find((r) => r.outcome === 'applied' && r.fix === 'forfeit-stuck-challenge-arm');
    assert.ok(applied);
    assert.equal(applied!.prClosed, false);
    const finding = result.findings.find((f) => f.id === 'observer-auto-fix-applied-forfeit-stuck-challenge-arm-HOK-7002_c');
    assert.ok(finding);
    assert.equal(finding!.severity, 'medium');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ─── Action records ─────────────────────────────────────────────────────────

test('action records parse as JSON lines with kind=observer-auto-fix', async () => {
  const repoDir = mkRepoDir();
  try {
    const context = makeContext(repoDir);
    const stateDir = context.resolveTaskStateDir(BASE_TASK)!;
    writeFileSync(join(stateDir, '.failed-ready-recheck-count'), '3');
    writeFileSync(join(stateDir, '.failed-ready-recheck-head'), 'aaaaaaa\n');
    writeFileSync(join(stateDir, '.failed-ready-recheck-exhausted'), 'test');
    const deps = makeDeps({
      git: (args) => {
        if (args.at(-1) === 'HEAD') return 'bbbbbbb';
        if (args.at(-1) === 'origin/main') return 'ddddddd';
        return '';
      },
    });
    const result = await runObserverAutoFixes({
      repo: context,
      tasks: [BASE_TASK],
      findings: [],
      config: makeConfig({ updateBranchFromBase: { enabled: false, maxAttempts: 2 } as ObserverAutoFixConfig['updateBranchFromBase'] }),
      deps,
      now: new Date(),
    });
    assert.ok(result.records.length > 0);
    const { appendAutoFixActionRecords } = await import('./observer-auto-fix.ts');
    appendAutoFixActionRecords(context.incidentStoreDir, result.records);
    const logPath = join(context.incidentStoreDir, 'actions.jsonl');
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    for (const line of lines) {
      const parsed = JSON.parse(line) as AutoFixActionRecord;
      assert.equal(parsed.kind, 'observer-auto-fix');
      assert.ok(parsed.fix);
      assert.ok(parsed.issue);
      assert.ok(parsed.outcome);
      assert.ok(parsed.at);
    }
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
