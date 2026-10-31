import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(__dirname, '..');
const planQueueTool = resolve(__dirname, 'plan-queue.ts');
const fixture = resolve(repoDir, 'fixtures/plan-queue/backlog-basic.json');
// plan-queue runs from an empty temp dir so tests don't follow the repo's own config.
const legacyCwd = mkdtempSync(join(tmpdir(), 'plan-queue-test-'));
writeFileSync(join(legacyCwd, '.wavemill-config.json'), '{}\n', 'utf8');
// No-op ordering judge mock: basic tests don't seed canned verdicts, so return
// an empty list so the grounded planner runs deterministically without the real CLI.
const legacyCwdMockCmd = join(legacyCwd, 'mock-judge.mjs');
writeFileSync(legacyCwdMockCmd, `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on('end', () => { process.stdout.write(JSON.stringify({result:'{"predictions":[],"verdicts":[]}'})); });\n`, 'utf8');
chmodSync(legacyCwdMockCmd, 0o755);
after(() => rmSync(legacyCwd, { recursive: true, force: true }));

function runPlanQueue(args: string[], input?: string, cwd = legacyCwd, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [planQueueTool, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_CMD: legacyCwdMockCmd, ...env },
    input,
  });
}

function parseJson(stdout: string) {
  return JSON.parse(stdout) as {
    availableNow: string[];
    queuedAfterDependencies: Array<{ taskId: string; ancestors: string[] }>;
    avoidRunningTogether: string[][];
    sharedSurfaceConflicts: Array<{ a: string; b: string; files: string[]; evidence?: string; source?: string }>;
    needsTriage: Array<{ reason: string; edge: { type: string; from: string; to: string; source: string } }>;
  };
}

type MockClassifierAction = { text: string } | { fail: string } | { sleepMs: number };

/**
 * Write a mock `claude` CLI that logs each `--model` it is invoked with and
 * answers per model (falling back to `default`) with the CLI's JSON envelope.
 */
function writeMockClassifier(
  tempDir: string,
  actions: Record<string, MockClassifierAction>,
): { cliPath: string; logPath: string } {
  const cliPath = join(tempDir, 'mock-classifier.mjs');
  const logPath = join(tempDir, 'classifier.log');
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const actions = ${JSON.stringify(actions)};
const args = process.argv.slice(2);
const modelIndex = args.indexOf('--model');
const model = modelIndex >= 0 ? args[modelIndex + 1] : '(default)';
appendFileSync(${JSON.stringify(logPath)}, model + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  const action = actions[model] ?? actions.default ?? { fail: 'no mock action' };
  if ('sleepMs' in action) {
    setTimeout(() => { process.stderr.write('too slow\\n'); process.exit(1); }, action.sleepMs);
    return;
  }
  if ('fail' in action) {
    process.stderr.write(action.fail + '\\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ result: action.text }));
});
`,
    'utf8',
  );
  chmodSync(cliPath, 0o755);
  return { cliPath, logPath };
}

function readInvokedModels(logPath: string): string[] {
  return existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : [];
}

function readCache(tempDir: string, cacheKey: string) {
  return JSON.parse(
    readFileSync(join(tempDir, '.wavemill', 'cache', 'task-dependency-plans', `${cacheKey}.json`), 'utf8'),
  ) as {
    fingerprints?: Record<string, string>;
    edges?: Array<{ from: string; to: string }>;
    groundedVerdicts?: Array<{ a: string; b: string; verdict: string }>;
    touchSets?: Record<string, unknown>;
    inference?: {
      lastAttemptAt: string | null;
      lastSuccessAt: string | null;
      lastOutcome: 'ok' | 'failed' | null;
      lastModel: string | null;
      consecutiveFailures: number;
    };
  };
}

function readReport(path: string) {
  return JSON.parse(readFileSync(path, 'utf8')) as {
    inferenceStatus: string;
    inferredEdgeCount: number;
    attempted: boolean;
    refreshKind: string;
    skipReason: string | null;
    model: string | null;
    error: string | null;
  };
}

/** An obvious producer/consumer pair with no explicit Linear relation.
 * HOK-2 mentions HOK-1 by ID so the pair earns a cross_reference signal
 * (score > 0) without needing file-path touch sets or a git repo. */
const obviousPairBacklog = [
  { id: 'HOK-1', title: 'Add queue API', state: 'Todo', labels: ['queue'], blocks: [] },
  { id: 'HOK-2', title: 'Consume queue API in dashboard', description: 'Builds on HOK-1 queue API.', state: 'Todo', labels: ['queue'], blocks: [] },
];

const MILL_ENV = { ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: '' };

function millPlanArgs(backlogPath: string, cacheKey: string, reportPath: string, budgetMs = 30_000): string[] {
  return [
    '--backlog-file', backlogPath,
    '--cache-key', cacheKey,
    '--refresh-missing-cache',
    '--queue-classifier-budget-ms', String(budgetMs),
    '--inference-report-file', reportPath,
    '--json',
  ];
}

describe('plan-queue CLI', () => {
  it('emits queuePlan JSON from a backlog file', () => {
    const stdout = execFileSync(process.execPath, [planQueueTool, '--backlog-file', fixture, '--json'], {
      cwd: legacyCwd,
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_CMD: legacyCwdMockCmd },
    });

    const result = parseJson(stdout);
    assert.deepEqual(Object.keys(result), [
      'availableNow',
      'queuedAfterDependencies',
      'avoidRunningTogether',
      'sharedSurfaceConflicts',
      'needsTriage',
      'touchSetStatus',
    ]);
    assert.deepEqual(result.availableNow, ['HOK-10', 'HOK-13']);
    assert.deepEqual(result.queuedAfterDependencies, [
      { taskId: 'HOK-11', ancestors: ['HOK-10'] },
      { taskId: 'HOK-12', ancestors: ['HOK-10'] },
      { taskId: 'HOK-14', ancestors: ['HOK-99'] },
    ]);
    assert.deepEqual(result.avoidRunningTogether, [['HOK-11', 'HOK-13']]);
    assert.deepEqual(result.needsTriage, []);
  });

  it('renders preview sections to stdout', () => {
    const result = runPlanQueue(['--backlog-file', fixture, '--preview']);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Available Now/);
    assert.match(result.stdout, /Queued After Dependencies/);
    assert.match(result.stdout, /Avoid Running Together/);
    assert.match(result.stdout, /Needs Triage/);
    assert.match(result.stdout, /\(none\)/);
  });

  it('keeps externally blocked known tasks out of needsTriage', () => {
    const backlog = JSON.stringify([
      { id: 'HOK-1509', title: 'Blocked by external issue', dependsOn: ['HOK-9999'] },
      { id: 'HOK-1588', title: 'Ready task' },
    ]);
    const result = parseJson(runPlanQueue(['--stdin', '--json'], backlog).stdout);

    assert.deepEqual(result.availableNow, ['HOK-1588']);
    assert.deepEqual(result.queuedAfterDependencies, [{ taskId: 'HOK-1509', ancestors: ['HOK-9999'] }]);
    assert.deepEqual(result.needsTriage, []);
  });

  it('suppresses duplicate-edge triage from needsTriage while keeping queue output', () => {
    const backlog = JSON.stringify([
      { id: 'HOK-100', title: 'Dependency root' },
      { id: 'HOK-200', title: 'Depends twice', dependsOn: ['HOK-100', 'HOK-100'] },
    ]);
    const result = parseJson(runPlanQueue(['--stdin', '--json'], backlog).stdout);

    assert.deepEqual(result.availableNow, ['HOK-100']);
    assert.deepEqual(result.queuedAfterDependencies, [{ taskId: 'HOK-200', ancestors: ['HOK-100'] }]);
    assert.deepEqual(result.needsTriage, []);
  });

  it('reads stdin and matches file-mode JSON', () => {
    const fixtureContent = readFileSync(fixture, 'utf8');
    const fileMode = parseJson(runPlanQueue(['--backlog-file', fixture, '--json']).stdout);
    const stdinMode = parseJson(runPlanQueue(['--stdin', '--json'], fixtureContent).stdout);

    assert.deepEqual(stdinMode, fileMode);
  });

  it('fails clearly for empty or whitespace-only stdin', () => {
    for (const input of ['', '   \n\t']) {
      const result = runPlanQueue(['--stdin', '--json'], input);

      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /planner_input_missing: stdin was empty/);
      assert.doesNotMatch(result.stderr, /parse backlog JSON/);
    }
  });

  it('fails clearly when stdin cannot be read', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'plan-queue-unreadable-stdin-test-'));
    try {
      const result = spawnSync(
        'bash',
        ['-c', 'exec 0< "$1"; "$3" "$2" --stdin --json', 'bash', tempDir, planQueueTool, process.execPath],
        {
          cwd: repoDir,
          encoding: 'utf-8',
          env: { ...process.env },
        },
      );

      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /planner_input_missing: failed to read stdin/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails clearly for a missing backlog file', () => {
    const result = runPlanQueue(['--backlog-file', '/nonexistent/plan-queue.json', '--json']);

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Failed to read backlog file/);
  });

  it('fails clearly for malformed JSON', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'plan-queue-test-'));
    try {
      const malformed = join(tempDir, 'malformed.json');
      writeFileSync(malformed, '[{"id": "HOK-1"');

      const result = runPlanQueue(['--backlog-file', malformed, '--json']);

      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /parse backlog JSON/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('emits empty arrays and preview placeholders for an empty backlog', () => {
    const emptyJson = '[]';
    const jsonResult = parseJson(runPlanQueue(['--stdin', '--json'], emptyJson).stdout);
    assert.deepEqual(jsonResult, {
      availableNow: [],
      queuedAfterDependencies: [],
      avoidRunningTogether: [],
      sharedSurfaceConflicts: [],
      needsTriage: [],
      touchSetStatus: {},
    });

    const previewResult = runPlanQueue(['--stdin', '--preview'], emptyJson);
    assert.equal(previewResult.status, 0);
    assert.equal((previewResult.stdout.match(/\(none\)/g) ?? []).length, 6);
  });

  it('fails with a usage hint when no input source is provided', () => {
    const result = runPlanQueue(['--json']);

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /provide exactly one input source/);
  });

  it('writes JSON to stdout and preview to stderr when both are requested', () => {
    const result = runPlanQueue(['--backlog-file', fixture, '--json', '--preview']);

    assert.equal(result.status, 0);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    assert.match(result.stderr, /Available Now/);
    assert.match(result.stderr, /Queued After Dependencies/);
    assert.match(result.stderr, /Avoid Running Together/);
    assert.match(result.stderr, /Needs Triage/);
  });

  it('creates a cache file for file mode and reports cache stats in preview mode', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'plan-queue-cache-test-'));
    try {
      const first = runPlanQueue(['--backlog-file', fixture, '--cache-key', 'smoke-test', '--preview'], undefined, tempDir);
      const cachePath = join(tempDir, '.wavemill', 'cache', 'task-dependency-plans', 'smoke-test.json');

      assert.equal(first.status, 0);
      assert.equal(existsSync(cachePath), true);
      assert.match(first.stderr, /grounded planner:/);

      const second = runPlanQueue(['--backlog-file', fixture, '--cache-key', 'smoke-test', '--preview'], undefined, tempDir);
      assert.equal(second.status, 0);
      assert.match(second.stderr, /grounded planner:/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('skips cache writes when --no-cache is provided', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'plan-queue-cache-disabled-test-'));
    try {
      const result = runPlanQueue(
        ['--backlog-file', fixture, '--cache-key', 'disabled-test', '--no-cache', '--preview'],
        undefined,
        tempDir,
      );

      assert.equal(result.status, 0);
      assert.equal(existsSync(join(tempDir, '.wavemill', 'cache', 'task-dependency-plans', 'disabled-test.json')), false);
      assert.doesNotMatch(result.stderr, /cache: hits=/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('loads queue-analysis prompt from wavemill root when cwd is a target repo', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'plan-queue-prompt-root-test-'));
    try {
      const backlogPath = join(tempDir, 'backlog.json');
      writeFileSync(
        backlogPath,
        `${JSON.stringify(
          [
            { id: 'HOK-1', title: 'First', state: 'Todo', labels: [], blocks: [] },
            { id: 'HOK-2', title: 'Second', state: 'Todo', labels: [], blocks: [] },
          ],
          null,
          2,
        )}\n`,
        'utf8',
      );

      const result = runPlanQueue(
        ['--backlog-file', backlogPath, '--cache-key', 'prompt-root', '--refresh-missing-cache', '--json'],
        undefined,
        tempDir,
        { CLAUDE_CMD: '/definitely/missing/claude' },
      );

      assert.equal(result.status, 0);
      assert.doesNotThrow(() => parseJson(result.stdout));
      assert.doesNotMatch(result.stderr, /ENOENT: no such file or directory, open 'tools\/prompts\/queue-analysis\.md'/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('falls back to explicit edges when a cache-refresh classifier exceeds its budget', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'plan-queue-classifier-budget-test-'));
    try {
      const backlog = [
        { id: 'HOK-1', title: 'Root', state: 'Todo', labels: [], blocks: ['HOK-2'] },
        { id: 'HOK-2', title: 'Dependent', state: 'Todo', labels: [], blocks: [], dependsOn: ['HOK-1'] },
      ];
      const backlogPath = join(tempDir, 'backlog.json');
      const reportPath = join(tempDir, 'report.json');
      writeFileSync(backlogPath, `${JSON.stringify(backlog, null, 2)}\n`, 'utf8');
      const { cliPath, logPath } = writeMockClassifier(tempDir, { default: { sleepMs: 20_000 } });

      const result = runPlanQueue(
        // Wide enough that tsx startup under a loaded CI host still leaves a
        // real attempt; the 20s mock sleep outlasts it either way.
        millPlanArgs(backlogPath, 'classifier-budget', reportPath, 15_000),
        undefined,
        tempDir,
        { ...MILL_ENV, CLAUDE_CMD: cliPath, DEEPSEEK_API_KEY: 'test-deepseek-key' },
      );

      assert.equal(result.status, 0);
      assert.deepEqual(parseJson(result.stdout), {
        availableNow: ['HOK-1'],
        queuedAfterDependencies: [{ taskId: 'HOK-2', ancestors: ['HOK-1'] }],
        avoidRunningTogether: [],
        sharedSurfaceConflicts: [],
        needsTriage: [],
        touchSetStatus: { 'HOK-1': 'unknown', 'HOK-2': 'unknown' },
      });
      assert.match(result.stderr, /touch-set.*failed|LLM.*failed|grounded planner:/);
      assert.match(result.stderr, /unavailable \(timeout\)|deadline exhausted before claude-/);
      assert.doesNotMatch(result.stderr, /missing ANTHROPIC_API_KEY/);
      const invoked = readInvokedModels(logPath);
      assert.ok(invoked.length >= 1);
      assert.ok(invoked.every((model) => model.startsWith('claude-')), `unexpected invocations: ${invoked.join(',')}`);
      assert.ok(!invoked.includes('deepseek-v4-flash'));

      // With the grounded planner, the explicit HOK-1→HOK-2 edge means the
      // ordering judge is never called (pair has an explicit_dependency signal).
      // The touch-set LLM failure is recorded but doesn't affect ordering status.
      const report = readReport(reportPath);
      assert.equal(report.inferredEdgeCount, 0);
      assert.notEqual(readCache(tempDir, 'classifier-budget').inference?.lastOutcome, 'failed');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('infers an obvious dependency pair under mill conditions without ANTHROPIC_API_KEY (HOK-3130)', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'plan-queue-obvious-pair-test-'));
    try {
      const backlogPath = join(tempDir, 'backlog.json');
      const reportPath = join(tempDir, 'report.json');
      writeFileSync(backlogPath, `${JSON.stringify(obviousPairBacklog, null, 2)}\n`, 'utf8');
      const { cliPath, logPath } = writeMockClassifier(tempDir, {
        default: {
          text: JSON.stringify({
            verdicts: [{ a: 'HOK-1', b: 'HOK-2', verdict: 'must_precede', evidence: 'dashboard consumes the new queue API' }],
            predictions: [],
          }),
        },
      });

      const result = runPlanQueue(
        millPlanArgs(backlogPath, 'obvious-pair', reportPath),
        undefined,
        tempDir,
        { ...MILL_ENV, CLAUDE_CMD: cliPath },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(parseJson(result.stdout).queuedAfterDependencies, [{ taskId: 'HOK-2', ancestors: ['HOK-1'] }]);
      assert.ok(readInvokedModels(logPath).length >= 1, 'classifier was invoked');

      const cache = readCache(tempDir, 'obvious-pair');
      assert.equal((cache.groundedVerdicts ?? []).length, 1);
      assert.equal(cache.inference?.lastOutcome, 'ok');
      assert.equal(cache.inference?.lastModel, 'claude-haiku-4-5-20251001');
      assert.ok(!cache.fingerprints || Object.keys(cache.fingerprints).length === 0, 'grounded planner does not save legacy fingerprints');

      const report = readReport(reportPath);
      assert.equal(report.inferenceStatus, 'ok');
      assert.equal(report.inferredEdgeCount, 1);
      assert.equal(report.model, 'claude-haiku-4-5-20251001');
      assert.equal(report.refreshKind, 'full');
      assert.equal(report.error, null);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('treats an explicit empty edge list as a successful inference', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'plan-queue-empty-edges-test-'));
    try {
      const backlogPath = join(tempDir, 'backlog.json');
      const reportPath = join(tempDir, 'report.json');
      writeFileSync(backlogPath, `${JSON.stringify(obviousPairBacklog, null, 2)}\n`, 'utf8');
      const { cliPath } = writeMockClassifier(tempDir, { default: { text: '{"verdicts":[],"predictions":[]}' } });

      const result = runPlanQueue(
        millPlanArgs(backlogPath, 'empty-edges', reportPath),
        undefined,
        tempDir,
        { ...MILL_ENV, CLAUDE_CMD: cliPath },
      );

      assert.equal(result.status, 0, result.stderr);
      const report = readReport(reportPath);
      assert.equal(report.inferenceStatus, 'ok');
      assert.equal(report.inferredEdgeCount, 0);
      assert.equal(report.attempted, true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not advance fingerprints for tasks a failed refresh never classified, and retries after cooldown', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'plan-queue-failed-partial-test-'));
    try {
      const { computeTaskFingerprint } = await import('../shared/lib/task-dependency-plan-cache.ts');
      const backlog = [
        ...obviousPairBacklog,
        { id: 'HOK-3', title: 'Unrelated docs', state: 'Todo', labels: ['docs'], blocks: [] },
      ];
      const previousFingerprints = Object.fromEntries(backlog.map((task) => [task.id, computeTaskFingerprint(task)]));
      const changedBacklog = backlog.map((task) => (
        task.id === 'HOK-2' ? { ...task, title: 'Consume queue API in dashboard and CLI' } : task
      ));
      const backlogPath = join(tempDir, 'backlog.json');
      const reportPath = join(tempDir, 'report.json');
      writeFileSync(backlogPath, `${JSON.stringify(changedBacklog, null, 2)}\n`, 'utf8');

      const cacheDir = join(tempDir, '.wavemill', 'cache', 'task-dependency-plans');
      mkdirSync(cacheDir, { recursive: true });
      const recentSuccess = new Date(Date.now() - 60_000).toISOString();
      writeFileSync(join(cacheDir, 'failed-partial.json'), `${JSON.stringify({
        schemaVersion: 1,
        projectSlug: 'failed-partial',
        updatedAt: recentSuccess,
        fingerprints: previousFingerprints,
        edges: [],
        inference: {
          lastAttemptAt: recentSuccess,
          lastSuccessAt: recentSuccess,
          lastOutcome: 'ok',
          lastModel: 'claude-haiku-4-5-20251001',
          lastError: null,
          consecutiveFailures: 0,
        },
      })}\n`, 'utf8');

      const failing = writeMockClassifier(tempDir, { default: { fail: '500 server_error overloaded' } });
      const failed = runPlanQueue(
        millPlanArgs(backlogPath, 'failed-partial', reportPath),
        undefined,
        tempDir,
        { ...MILL_ENV, CLAUDE_CMD: failing.cliPath },
      );
      assert.equal(failed.status, 0, failed.stderr);
      assert.match(failed.stderr, /ordering judge failed/);

      const afterFailure = readCache(tempDir, 'failed-partial');
      assert.ok(!afterFailure.fingerprints?.['HOK-2'], 'grounded planner does not save legacy fingerprints');
      assert.equal(afterFailure.inference?.lastOutcome, 'failed');
      assert.equal(afterFailure.inference?.consecutiveFailures, 1);
      assert.equal(readReport(reportPath).inferenceStatus, 'failed');
      assert.equal(readReport(reportPath).refreshKind, 'full');

      // Within the cooldown: no classifier call, fingerprints still held back.
      rmSync(failing.logPath, { force: true });
      const cooling = runPlanQueue(
        millPlanArgs(backlogPath, 'failed-partial', reportPath),
        undefined,
        tempDir,
        { ...MILL_ENV, CLAUDE_CMD: failing.cliPath },
      );
      assert.equal(cooling.status, 0, cooling.stderr);
      assert.deepEqual(readInvokedModels(failing.logPath), []);
      const coolingReport = readReport(reportPath);
      assert.equal(coolingReport.inferenceStatus, 'failed');
      assert.equal(coolingReport.skipReason, 'cooldown');
      assert.equal(coolingReport.attempted, false);
      assert.ok(!readCache(tempDir, 'failed-partial').fingerprints?.['HOK-2'], 'grounded planner does not save legacy fingerprints');

      // Backdate the failed attempt past the cooldown, then succeed.
      const cachePath = join(cacheDir, 'failed-partial.json');
      const stored = JSON.parse(readFileSync(cachePath, 'utf8'));
      stored.inference.lastAttemptAt = new Date(Date.now() - 11 * 60_000).toISOString();
      writeFileSync(cachePath, `${JSON.stringify(stored)}\n`, 'utf8');

      const succeeding = writeMockClassifier(tempDir, {
        default: { text: JSON.stringify({ verdicts: [{ a: 'HOK-1', b: 'HOK-2', verdict: 'must_precede', evidence: 'HOK-1 must precede HOK-2' }], predictions: [] }) },
      });
      const retried = runPlanQueue(
        millPlanArgs(backlogPath, 'failed-partial', reportPath),
        undefined,
        tempDir,
        { ...MILL_ENV, CLAUDE_CMD: succeeding.cliPath },
      );
      assert.equal(retried.status, 0, retried.stderr);
      assert.deepEqual(readInvokedModels(succeeding.logPath), ['claude-haiku-4-5-20251001']);
      const afterRetry = readCache(tempDir, 'failed-partial');
      assert.ok(!afterRetry.fingerprints?.['HOK-2'], 'grounded planner does not save legacy fingerprints');
      assert.equal(afterRetry.inference?.lastOutcome, 'ok');
      assert.equal(afterRetry.inference?.consecutiveFailures, 0);
      assert.deepEqual(parseJson(retried.stdout).queuedAfterDependencies, [{ taskId: 'HOK-2', ancestors: ['HOK-1'] }]);
      assert.equal(readReport(reportPath).inferenceStatus, 'ok');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('self-heals a cache whose fingerprints advanced without inference ever succeeding', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'plan-queue-poisoned-cache-test-'));
    try {
      const { computeTaskFingerprint } = await import('../shared/lib/task-dependency-plan-cache.ts');
      const backlogPath = join(tempDir, 'backlog.json');
      const reportPath = join(tempDir, 'report.json');
      writeFileSync(backlogPath, `${JSON.stringify(obviousPairBacklog, null, 2)}\n`, 'utf8');
      const cacheDir = join(tempDir, '.wavemill', 'cache', 'task-dependency-plans');
      mkdirSync(cacheDir, { recursive: true });
      // Shape of the pre-HOK-3130 poisoned cache: every task fingerprinted, no edges, no inference block.
      writeFileSync(join(cacheDir, 'poisoned.json'), `${JSON.stringify({
        schemaVersion: 1,
        projectSlug: 'poisoned',
        updatedAt: '2026-09-30T00:00:00.000Z',
        fingerprints: Object.fromEntries(obviousPairBacklog.map((task) => [task.id, computeTaskFingerprint(task)])),
        edges: [],
      })}\n`, 'utf8');
      const { cliPath, logPath } = writeMockClassifier(tempDir, {
        default: { text: JSON.stringify({ verdicts: [{ a: 'HOK-1', b: 'HOK-2', verdict: 'must_precede', evidence: 'HOK-1 must precede HOK-2' }], predictions: [] }) },
      });

      const result = runPlanQueue(
        millPlanArgs(backlogPath, 'poisoned', reportPath),
        undefined,
        tempDir,
        { ...MILL_ENV, CLAUDE_CMD: cliPath },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.ok(readInvokedModels(logPath).length >= 1, 'classifier was invoked');
      const report = readReport(reportPath);
      assert.equal(report.refreshKind, 'full');
      assert.equal(report.inferenceStatus, 'ok');
      assert.equal(report.inferredEdgeCount, 1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('persists an initial-refresh failure so the next poll is held by the cooldown', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'plan-queue-initial-failure-test-'));
    try {
      const backlogPath = join(tempDir, 'backlog.json');
      const reportPath = join(tempDir, 'report.json');
      writeFileSync(backlogPath, `${JSON.stringify(obviousPairBacklog, null, 2)}\n`, 'utf8');
      const { cliPath, logPath } = writeMockClassifier(tempDir, { default: { fail: '500 server_error overloaded' } });
      const env = { ...MILL_ENV, CLAUDE_CMD: cliPath };

      const first = runPlanQueue(millPlanArgs(backlogPath, 'initial-failure', reportPath), undefined, tempDir, env);
      assert.equal(first.status, 0, first.stderr);
      assert.ok(readInvokedModels(logPath).length > 0);
      const cache = readCache(tempDir, 'initial-failure');
      assert.ok(!cache.fingerprints || Object.keys(cache.fingerprints).length === 0, 'grounded planner does not save legacy fingerprints');
      assert.equal(cache.inference?.lastOutcome, 'failed');

      rmSync(logPath, { force: true });
      const second = runPlanQueue(millPlanArgs(backlogPath, 'initial-failure', reportPath), undefined, tempDir, env);
      assert.equal(second.status, 0, second.stderr);
      assert.deepEqual(readInvokedModels(logPath), []);
      assert.equal(readReport(reportPath).skipReason, 'cooldown');
      assert.equal(readReport(reportPath).inferenceStatus, 'failed');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('--no-infer renders quickly from cache without calling the classifier (HOK-3179)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'plan-queue-no-infer-test-'));
    try {
      const { computeTaskFingerprint } = await import('../shared/lib/task-dependency-plan-cache.ts');
      // HOK-2 mentions HOK-1 so the pair earns a cross_reference signal
      // (score > 0) and lookupGroundedVerdict is reached under --no-infer.
      const backlog = [
        { id: 'HOK-1', title: 'Add queue API', state: 'Todo', labels: ['queue'], blocks: [] },
        { id: 'HOK-2', title: 'Consume queue API', description: 'Builds on HOK-1.', state: 'Todo', labels: ['queue'], blocks: [] },
      ];
      const backlogPath = join(tempDir, 'backlog.json');
      writeFileSync(backlogPath, `${JSON.stringify(backlog, null, 2)}\n`, 'utf8');

      const cacheDir = join(tempDir, '.wavemill', 'cache', 'task-dependency-plans');
      mkdirSync(cacheDir, { recursive: true });
      const fingerprints = Object.fromEntries(backlog.map((task) => [task.id, computeTaskFingerprint(task)]));
      writeFileSync(join(cacheDir, 'no-infer.json'), `${JSON.stringify({
        schemaVersion: 1,
        projectSlug: 'no-infer',
        updatedAt: '2026-10-01T00:00:00.000Z',
        groundedVerdicts: [{
          a: 'HOK-1',
          b: 'HOK-2',
          aFingerprint: fingerprints['HOK-1'],
          bFingerprint: fingerprints['HOK-2'],
          verdict: 'must_precede',
          evidence: 'cached ordering verdict',
          classifiedAt: '2026-10-01T00:00:00.000Z',
        }],
      })}\n`, 'utf8');

      // Classifier would hang for 60s if invoked, but --no-infer must never
      // call it. Picker-synchronous path should return in <2s.
      const { cliPath, logPath } = writeMockClassifier(tempDir, { default: { sleepMs: 60_000 } });
      const startedAt = Date.now();
      const result = runPlanQueue(
        ['--backlog-file', backlogPath, '--cache-key', 'no-infer', '--no-infer', '--json'],
        undefined,
        tempDir,
        { ...MILL_ENV, CLAUDE_CMD: cliPath },
      );
      const elapsedMs = Date.now() - startedAt;

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(parseJson(result.stdout), {
        availableNow: ['HOK-1'],
        queuedAfterDependencies: [{ taskId: 'HOK-2', ancestors: ['HOK-1'] }],
        avoidRunningTogether: [],
        sharedSurfaceConflicts: [],
        needsTriage: [],
        touchSetStatus: { 'HOK-1': 'unknown', 'HOK-2': 'unknown' },
      });
      assert.deepEqual(readInvokedModels(logPath), [], 'classifier must not be invoked');
      assert.ok(elapsedMs < 10_000, `expected <10s under --no-infer, took ${elapsedMs}ms`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('drops a cached inferred edge contradicted by a reversed explicit relation (HOK-3179)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'plan-queue-reverse-explicit-test-'));
    try {
      const { computeTaskFingerprint } = await import('../shared/lib/task-dependency-plan-cache.ts');
      // Current explicit: HOK-1 depends on HOK-2 (HOK-2 blocks HOK-1).
      const backlog = [
        { id: 'HOK-1', title: 'Depends on 2', state: 'Todo', labels: [], blocks: [], dependsOn: ['HOK-2'] },
        { id: 'HOK-2', title: 'Blocks 1', state: 'Todo', labels: [], blocks: ['HOK-1'] },
      ];
      const backlogPath = join(tempDir, 'backlog.json');
      writeFileSync(backlogPath, `${JSON.stringify(backlog, null, 2)}\n`, 'utf8');

      const cacheDir = join(tempDir, '.wavemill', 'cache', 'task-dependency-plans');
      mkdirSync(cacheDir, { recursive: true });
      const fingerprints = Object.fromEntries(backlog.map((task) => [task.id, computeTaskFingerprint(task)]));
      // Stale cached inference: HOK-2 depends on HOK-1 (reversed direction).
      writeFileSync(join(cacheDir, 'reverse-explicit.json'), `${JSON.stringify({
        schemaVersion: 1,
        projectSlug: 'reverse-explicit',
        updatedAt: '2026-10-01T00:00:00.000Z',
        fingerprints,
        edges: [{
          from: 'HOK-2',
          to: 'HOK-1',
          fromFingerprint: fingerprints['HOK-2'],
          toFingerprint: fingerprints['HOK-1'],
          kind: 'inferred',
          type: 'depends_on',
          classifiedAt: '2026-10-01T00:00:00.000Z',
        }],
      })}\n`, 'utf8');

      const result = runPlanQueue(
        ['--backlog-file', backlogPath, '--cache-key', 'reverse-explicit', '--no-infer', '--json'],
        undefined,
        tempDir,
      );

      assert.equal(result.status, 0, result.stderr);
      // Explicit direction wins; cached reverse must not create a cycle or
      // push HOK-1 into needsTriage.
      const plan = parseJson(result.stdout);
      assert.deepEqual(plan.availableNow, ['HOK-2']);
      assert.deepEqual(plan.queuedAfterDependencies, [{ taskId: 'HOK-1', ancestors: ['HOK-2'] }]);
      assert.deepEqual(plan.needsTriage, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('merges retained cached edges into planning when backlog fingerprints are unchanged', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'plan-queue-cache-edges-test-'));
    try {
      const backlogPath = join(tempDir, 'backlog.json');
      // HOK-2 mentions HOK-1 so the pair earns a cross_reference signal
      // (score > 0) and lookupGroundedVerdict is reached from the cache.
      const backlog = [
        { id: 'HOK-1', title: 'First', state: 'Todo', labels: [], blocks: [] },
        { id: 'HOK-2', title: 'Second', description: 'Builds on HOK-1.', state: 'Todo', labels: [], blocks: [] },
      ];
      writeFileSync(backlogPath, `${JSON.stringify(backlog, null, 2)}\n`, 'utf8');

      const cacheDir = join(tempDir, '.wavemill', 'cache', 'task-dependency-plans');
      const cachePath = join(cacheDir, 'cached-edges.json');
      mkdirSync(cacheDir, { recursive: true });
      const { computeTaskFingerprint } = await import('../shared/lib/task-dependency-plan-cache.ts');
      const fingerprints = Object.fromEntries(backlog.map((task) => [task.id, computeTaskFingerprint(task)]));
      writeFileSync(
        cachePath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            projectSlug: 'cached-edges',
            updatedAt: '2026-01-01T00:00:00.000Z',
            groundedVerdicts: [
              {
                a: 'HOK-1',
                b: 'HOK-2',
                aFingerprint: fingerprints['HOK-1'],
                bFingerprint: fingerprints['HOK-2'],
                verdict: 'must_precede',
                evidence: 'First must precede Second',
                classifiedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
          null,
          2,
        )}\n`,
        'utf8',
      );

      const result = runPlanQueue(['--backlog-file', backlogPath, '--cache-key', 'cached-edges', '--json'], undefined, tempDir);

      assert.equal(result.status, 0);
      assert.deepEqual(parseJson(result.stdout), {
        availableNow: ['HOK-1'],
        queuedAfterDependencies: [{ taskId: 'HOK-2', ancestors: ['HOK-1'] }],
        avoidRunningTogether: [],
        sharedSurfaceConflicts: [],
        needsTriage: [],
        touchSetStatus: { 'HOK-1': 'empty-confirmed', 'HOK-2': 'empty-confirmed' },
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('grounded mode (HOK-3131)', () => {
    const groundedBacklog = [
      { id: 'HOK-1', title: 'Monitor reap loop', description: 'Edit `shared/lib/wavemill-monitor.sh` reap loop.', state: 'Todo', priority: 1, blocks: [] },
      { id: 'HOK-2', title: 'Monitor merge lane', description: 'Edit `shared/lib/wavemill-monitor.sh` merge lane.', state: 'Todo', priority: 2, blocks: [] },
      { id: 'HOK-3', title: 'Observer docs', description: 'Document `docs/observer.md`. Builds on HOK-1.', state: 'Todo', priority: 3, blocks: [] },
    ];
    // HOK-3304: HOK-1/HOK-2 is a deterministic conflict (shared hot file) and
    // never reaches the judge; the judge only ever sees ordering pairs such as
    // the HOK-1 → HOK-3 cross-reference pair.
    const orderingVerdicts = JSON.stringify({
      verdicts: [{ a: 'HOK-1', b: 'HOK-3', verdict: 'must_precede', evidence: 'HOK-3 documents the monitor merge lane that HOK-1 adds.' }],
    });

    function setupGroundedRepo(): { tempDir: string; backlogPath: string; reportPath: string } {
      const tempDir = mkdtempSync(join(tmpdir(), 'plan-queue-grounded-test-'));
      mkdirSync(join(tempDir, 'shared', 'lib'), { recursive: true });
      mkdirSync(join(tempDir, 'docs'), { recursive: true });
      writeFileSync(join(tempDir, 'shared', 'lib', 'wavemill-monitor.sh'), '#!/bin/bash\n', 'utf8');
      writeFileSync(join(tempDir, 'docs', 'observer.md'), '# Observer\n', 'utf8');
      writeFileSync(join(tempDir, '.wavemill-config.json'), '{}\n', 'utf8');
      const backlogPath = join(tempDir, 'backlog.json');
      writeFileSync(backlogPath, `${JSON.stringify(groundedBacklog, null, 2)}\n`, 'utf8');
      return { tempDir, backlogPath, reportPath: join(tempDir, 'report.json') };
    }

    function readGroundedCache(tempDir: string, cacheKey: string) {
      return JSON.parse(
        readFileSync(join(tempDir, '.wavemill', 'cache', 'task-dependency-plans', `${cacheKey}.json`), 'utf8'),
      ) as {
        fingerprints: Record<string, string>;
        edges: unknown[];
        touchSets?: Record<string, { entries: Array<{ path: string; source: string }> }>;
        groundedVerdicts?: Array<{ a: string; b: string; verdict: string; evidence?: string }>;
        inference?: { lastOutcome: string | null };
      };
    }

    it('plans from touch sets and the ordering judge, then serves the next run from cache', () => {
      const { tempDir, backlogPath, reportPath } = setupGroundedRepo();
      try {
        const { cliPath, logPath } = writeMockClassifier(tempDir, { default: { text: orderingVerdicts } });
        const env = { ...MILL_ENV, CLAUDE_CMD: cliPath };

        const first = runPlanQueue([...millPlanArgs(backlogPath, 'grounded', reportPath), '--preview'], undefined, tempDir, env);

        assert.equal(first.status, 0, first.stderr);
        assert.deepEqual(parseJson(first.stdout), {
          availableNow: ['HOK-1', 'HOK-2'],
          queuedAfterDependencies: [{ taskId: 'HOK-3', ancestors: ['HOK-1'] }],
          avoidRunningTogether: [['HOK-1', 'HOK-2']],
          sharedSurfaceConflicts: [
            {
              a: 'HOK-1',
              b: 'HOK-2',
              files: ['shared/lib/wavemill-monitor.sh'],
              evidence: 'grounded:deterministic shared files: shared/lib/wavemill-monitor.sh',
              source: 'inferred',
            },
          ],
          needsTriage: [],
          touchSetStatus: { 'HOK-1': 'predicted', 'HOK-2': 'predicted', 'HOK-3': 'predicted' },
        });
        assert.match(first.stderr, /plan-queue: grounded planner: tasks=3 pairsScored=2 pairsSentToLlm=1 edges=2 waves=2/);
        assert.match(first.stderr, /Grounded Waves\n- wave 0: HOK-1\n- wave 1: HOK-2, HOK-3/);
        assert.match(first.stderr, /- HOK-2 → wave 1 \(conflicts with HOK-1 \(shared: shared\/lib\/wavemill-monitor\.sh\)\)/);
        assert.equal(readInvokedModels(logPath).length, 1, 'one ordering call, no touch-set prediction call');

        const cache = readGroundedCache(tempDir, 'grounded');
        assert.deepEqual(cache.touchSets?.['HOK-1'].entries, [{ path: 'shared/lib/wavemill-monitor.sh', source: 'explicit' }]);
        assert.deepEqual(cache.groundedVerdicts?.map((v) => [v.a, v.b, v.verdict]), [['HOK-1', 'HOK-3', 'must_precede']]);
        assert.ok(!cache.fingerprints, 'legacy fingerprints are not advanced by grounded runs');
        assert.ok(!cache.edges, 'grounded planner does not save legacy edges');
        assert.equal(cache.inference?.lastOutcome, 'ok');

        const report = readReport(reportPath);
        assert.equal(report.inferenceStatus, 'ok');
        assert.equal(report.inferredEdgeCount, 2);
        assert.equal(report.refreshKind, 'full');

        const second = runPlanQueue(millPlanArgs(backlogPath, 'grounded', reportPath), undefined, tempDir, env);
        assert.equal(second.status, 0, second.stderr);
        assert.deepEqual(parseJson(second.stdout).avoidRunningTogether, [['HOK-1', 'HOK-2']]);
        assert.equal(readInvokedModels(logPath).length, 1, 'second run is served from cache');
        assert.equal(readReport(reportPath).refreshKind, 'none');
        assert.equal(readReport(reportPath).inferenceStatus, 'ok');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('treats malformed judge output as independent and reports the failure', () => {
      const { tempDir, backlogPath, reportPath } = setupGroundedRepo();
      try {
        const { cliPath } = writeMockClassifier(tempDir, { default: { text: 'I think they conflict.' } });

        const result = runPlanQueue(millPlanArgs(backlogPath, 'grounded', reportPath), undefined, tempDir, { ...MILL_ENV, CLAUDE_CMD: cliPath });

        assert.equal(result.status, 0, result.stderr);
        // The deterministic HOK-1/HOK-2 conflict holds regardless of the judge;
        // only the ordering pair is affected by the malformed judge output.
        assert.deepEqual(parseJson(result.stdout).avoidRunningTogether, [['HOK-1', 'HOK-2']]);
        assert.match(result.stderr, /ordering judge failed/);
        const cache = readGroundedCache(tempDir, 'grounded');
        assert.deepEqual(cache.groundedVerdicts, [], 'failed verdicts are not cached');
        assert.equal(cache.inference?.lastOutcome, 'failed');
        assert.equal(readReport(reportPath).inferenceStatus, 'failed');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

  });
});
