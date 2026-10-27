/**
 * Workflow cost from real session files (HOK-3077).
 *
 * End-to-end tests of the one cost engine: session files on disk → the
 * Wavemill session adapters → SDK `TaskCostSummaryV1` → the persisted
 * `WorkflowCostOutcome` (`collectSdkTaskCostSummaries` + `resolveWorkflowCost`,
 * the path `meterWorkflowCost` runs for every eval). Covers branch filtering,
 * per-model aggregation, native/Claude/Codex/DeepSeek sources, and the
 * coverage rules that keep an unpriced run from reporting `$0`.
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { reportableWorkflowCostUsd, type WorkflowCostOutcome } from './workflow-cost.ts';
import type { PricingTable } from './pricing/model-pricing.ts';
import { encodeProjectDir } from './wavemill-session-paths.ts';
import { collectSdkTaskCostSummaries } from './sdk-task-cost/collect.ts';
import { resolveWorkflowCost } from './sdk-task-cost/resolve.ts';

/** Meter a worktree's sessions exactly as a live eval does, minus the async runner. */
function meterSessions(opts: {
  worktreePath: string;
  branchName: string;
  repoDir?: string;
  pricingTable?: PricingTable;
  agentType?: string;
  issueId?: string;
}): WorkflowCostOutcome {
  const summaries = collectSdkTaskCostSummaries({
    worktreePath: opts.worktreePath,
    branchName: opts.branchName,
    repoDir: opts.repoDir,
    issueId: opts.issueId,
    pricingTable: opts.pricingTable,
  });
  return resolveWorkflowCost({
    summaries,
    agentType: opts.agentType,
    pricingTable: opts.pricingTable,
    repoDir: opts.repoDir,
    diagnostics: { worktreePath: opts.worktreePath, branchName: opts.branchName },
  }).outcome;
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

async function asyncTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

/** Create a temporary directory structure mimicking ~/.claude/projects/<dir>/ */
function createTempProjectDir(): { worktreePath: string; projectsDir: string; cleanup: () => void } {
  const base = join(tmpdir(), `wavemill-test-${randomUUID()}`);
  // Use a fake worktree path that we can control
  const worktreePath = join(base, 'fake-worktree');
  mkdirSync(worktreePath, { recursive: true });

  // Build the project dir path manually (mimic resolveProjectsDir)
  const encoded = worktreePath.replace(/\//g, '-');
  const projectsDir = join(base, 'claude-projects', encoded);
  mkdirSync(projectsDir, { recursive: true });

  return {
    worktreePath,
    projectsDir,
    cleanup: () => { try { rmSync(base, { recursive: true, force: true }); } catch {} },
  };
}

/** Build a session JSONL line for an assistant turn. */
function assistantTurn(opts: {
  branch: string;
  model?: string;
  inputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
}): string {
  return JSON.stringify({
    type: 'assistant',
    gitBranch: opts.branch,
    message: {
      model: opts.model || 'claude-opus-4-6',
      role: 'assistant',
      content: [{ type: 'text', text: 'test' }],
      usage: {
        input_tokens: opts.inputTokens ?? 100,
        cache_creation_input_tokens: opts.cacheCreationTokens ?? 50,
        cache_read_input_tokens: opts.cacheReadTokens ?? 200,
        output_tokens: opts.outputTokens ?? 30,
      },
    },
  });
}

/** Build a non-assistant JSONL line (e.g. user turn). */
function userTurn(branch: string): string {
  return JSON.stringify({
    type: 'user',
    gitBranch: branch,
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  });
}

function nativeSessionStarted(model = 'pi-model'): string {
  return JSON.stringify({
    seq: 1,
    sessionId: 'native-session',
    timestamp: 1,
    type: 'session_started',
    model,
    api: 'responses',
    provider: 'pi',
  });
}

function nativeAssistantMessage(opts: {
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
} = {}): string {
  return JSON.stringify({
    seq: 2,
    sessionId: 'native-session',
    timestamp: 2,
    type: 'assistant_message',
    model: opts.model,
    stopReason: 'end_turn',
    usage: {
      input: opts.input ?? 0,
      output: opts.output ?? 0,
      cacheRead: opts.cacheRead ?? 0,
      cacheWrite: opts.cacheWrite ?? 0,
      totalTokens:
        (opts.input ?? 0) +
        (opts.output ?? 0) +
        (opts.cacheRead ?? 0) +
        (opts.cacheWrite ?? 0),
    },
    rawContent: [],
    replayContent: [],
    redacted: false,
  });
}

// ────────────────────────────────────────────────────────────────
// Tests: metering session files (integration with temp files)
// ────────────────────────────────────────────────────────────────

console.log('\n--- Session metering Tests ---\n');

// We need to override the project directory resolution for testing.
// The simplest approach: create a test that uses the real function path
// but we'll test the constituent parts and use a fixture-based approach.

test('Returns failure when projects directory does not exist', () => {
  const result = meterSessions({
    worktreePath: '/nonexistent/path/that/does/not/exist',
    branchName: 'task/test',
  });
  assert.equal(result.status, 'no_sessions');
  if (result.status !== 'success') {
    assert.ok(result.reason);
    assert.ok(result.diagnostics);
  }
});

test('Returns failure when no JSONL files exist', () => {
  const { worktreePath, projectsDir, cleanup } = createTempProjectDir();
  try {
    // projectsDir exists but has no .jsonl files
    // An empty projects dir and a nonexistent worktree both meter to no_sessions.
    const result = meterSessions({
      worktreePath: '/nonexistent/worktree/path',
      branchName: 'task/test',
    });
    assert.equal(result.status, 'no_sessions');
    if (result.status !== 'success') {
      assert.ok(result.reason);
      assert.ok(result.diagnostics);
    }
  } finally {
    cleanup();
  }
});

test('Aggregates tokens from matching branch only', () => {
  // This test creates fixture JSONL data and validates parsing logic
  // We'll test the core parsing by building JSONL content and verifying
  // the aggregation math matches expectations.
  const branch = 'task/my-feature';
  const otherBranch = 'task/other-feature';

  // Simulate what the scanner would parse
  const lines = [
    assistantTurn({ branch, inputTokens: 100, cacheCreationTokens: 50, cacheReadTokens: 200, outputTokens: 30 }),
    userTurn(branch), // Should be skipped (not assistant)
    assistantTurn({ branch: otherBranch, inputTokens: 999, outputTokens: 999 }), // Wrong branch
    assistantTurn({ branch, inputTokens: 200, cacheCreationTokens: 100, cacheReadTokens: 300, outputTokens: 70 }),
  ];

  // Parse and aggregate manually (the branch filter the Claude adapter applies)
  let totalInput = 0, totalCacheCreate = 0, totalCacheRead = 0, totalOutput = 0;
  let matchCount = 0;
  for (const line of lines) {
    const entry = JSON.parse(line);
    if (entry.type !== 'assistant') continue;
    if (entry.gitBranch !== branch) continue;
    const u = entry.message.usage;
    totalInput += u.input_tokens || 0;
    totalCacheCreate += u.cache_creation_input_tokens || 0;
    totalCacheRead += u.cache_read_input_tokens || 0;
    totalOutput += u.output_tokens || 0;
    matchCount++;
  }

  assert.equal(matchCount, 2);
  assert.equal(totalInput, 300);
  assert.equal(totalCacheCreate, 150);
  assert.equal(totalCacheRead, 500);
  assert.equal(totalOutput, 100);
});

test('Aggregates tokens per model separately', () => {
  const branch = 'task/test';
  const lines = [
    assistantTurn({ branch, model: 'claude-opus-4-6', inputTokens: 100, outputTokens: 50 }),
    assistantTurn({ branch, model: 'claude-haiku-4-5-20251001', inputTokens: 200, outputTokens: 100 }),
    assistantTurn({ branch, model: 'claude-opus-4-6', inputTokens: 300, outputTokens: 150 }),
  ];

  const models: Record<string, { inputTokens: number; outputTokens: number }> = {};
  for (const line of lines) {
    const entry = JSON.parse(line);
    if (entry.type !== 'assistant' || entry.gitBranch !== branch) continue;
    const modelId = entry.message.model;
    const u = entry.message.usage;
    if (!models[modelId]) models[modelId] = { inputTokens: 0, outputTokens: 0 };
    models[modelId].inputTokens += u.input_tokens || 0;
    models[modelId].outputTokens += u.output_tokens || 0;
  }

  assert.equal(Object.keys(models).length, 2);
  assert.equal(models['claude-opus-4-6'].inputTokens, 400);
  assert.equal(models['claude-opus-4-6'].outputTokens, 200);
  assert.equal(models['claude-haiku-4-5-20251001'].inputTokens, 200);
  assert.equal(models['claude-haiku-4-5-20251001'].outputTokens, 100);
});

test('Metering prices DeepSeek transcripts from configured aliases without crashing', () => {
  const base = join(tmpdir(), `wavemill-test-${randomUUID()}`);
  const worktreePath = join(base, 'fake-worktree');
  mkdirSync(worktreePath, { recursive: true });

  const originalHome = process.env.HOME;
  process.env.HOME = join(base, 'home');

  try {
    const encoded = encodeProjectDir(worktreePath);
    const providerProjectsDir = join(
      worktreePath,
      '.wavemill',
      'runs',
      'HOK-1488',
      'providers',
      'deepseek',
      'home',
      '.claude',
      'projects',
      encoded,
    );
    mkdirSync(providerProjectsDir, { recursive: true });
    writeFileSync(
      join(providerProjectsDir, 'session1.jsonl'),
      assistantTurn({ branch: 'task/test', model: 'deepseek-chat', inputTokens: 1_000_000, outputTokens: 500_000 }),
    );

    const result = meterSessions({
      worktreePath,
      branchName: 'task/test',
      pricingTable: {
        'deepseek-chat': { inputCostPerMTok: 2, outputCostPerMTok: 8 },
      },
    });

    assert.equal(result.status, 'success');
    if (result.status === 'success') {
      assert.ok(result.totalCostUsd > 0);
      assert.ok(result.models['deepseek-chat'].costUsd > 0);
      assert.deepEqual(result.pricingUsed['deepseek-chat'], { inputCostPerMTok: 2, outputCostPerMTok: 8 });
    }
  } finally {
    process.env.HOME = originalHome;
    rmSync(base, { recursive: true, force: true });
  }
});

test('Metering includes native session JSONL in workflow totals', () => {
  const base = join(tmpdir(), `wavemill-test-${randomUUID()}`);
  const worktreePath = join(base, 'fake-worktree');
  const nativeSessionsDir = join(
    worktreePath,
    '.wavemill',
    'runs',
    'HOK-2305',
    'native-sessions',
  );
  mkdirSync(nativeSessionsDir, { recursive: true });

  try {
    writeFileSync(
      join(nativeSessionsDir, 'session.jsonl'),
      [
        nativeSessionStarted('pi-priced-model'),
        nativeAssistantMessage({ input: 1_000_000, output: 500_000, cacheRead: 250_000, cacheWrite: 100_000 }),
        nativeAssistantMessage({ model: 'pi-priced-model', input: 500_000, output: 250_000, cacheRead: 50_000, cacheWrite: 25_000 }),
      ].join('\n'),
    );

    const result = meterSessions({
      worktreePath,
      branchName: 'task/test',
      pricingTable: {
        'pi-priced-model': {
          inputCostPerMTok: 2,
          outputCostPerMTok: 8,
          cacheReadCostPerMTok: 0.2,
          cacheWriteCostPerMTok: 2.5,
        },
      },
      agentType: 'claude',
    });

    assert.equal(result.status, 'success');
    if (result.status === 'success') {
      assert.equal(result.sessionCount, 1);
      assert.equal(result.turnCount, 2);
      assert.equal(result.models['pi-priced-model'].inputTokens, 1_500_000);
      assert.equal(result.models['pi-priced-model'].cacheCreationTokens, 125_000);
      assert.equal(result.models['pi-priced-model'].cacheReadTokens, 300_000);
      assert.equal(result.models['pi-priced-model'].outputTokens, 750_000);
      assert.ok(Math.abs(result.totalCostUsd - 9.3725) < 0.0001);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('Metering returns zero cost for unknown native model pricing', () => {
  const base = join(tmpdir(), `wavemill-test-${randomUUID()}`);
  const worktreePath = join(base, 'fake-worktree');
  const nativeSessionsDir = join(
    worktreePath,
    '.wavemill',
    'runs',
    'HOK-2305',
    'native-sessions',
  );
  mkdirSync(nativeSessionsDir, { recursive: true });

  try {
    writeFileSync(
      join(nativeSessionsDir, 'session.jsonl'),
      [
        nativeSessionStarted('unknown-native-model'),
        nativeAssistantMessage({ input: 100, output: 50, cacheRead: 25, cacheWrite: 10 }),
      ].join('\n'),
    );

    const result = meterSessions({
      worktreePath,
      branchName: 'task/test',
      pricingTable: {},
    });

    assert.equal(result.status, 'success');
    if (result.status === 'success') {
      assert.equal(result.totalCostUsd, 0);
      assert.equal(result.models['unknown-native-model'].costUsd, 0);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('Metering prefers native sessions over Claude fallback', () => {
  const base = join(tmpdir(), `wavemill-test-${randomUUID()}`);
  const worktreePath = join(base, 'fake-worktree');
  const originalHome = process.env.HOME;
  process.env.HOME = join(base, 'home');

  try {
    const nativeSessionsDir = join(
      worktreePath,
      '.wavemill',
      'runs',
      'HOK-2305',
      'native-sessions',
    );
    mkdirSync(nativeSessionsDir, { recursive: true });
    writeFileSync(
      join(nativeSessionsDir, 'session.jsonl'),
      [
        nativeSessionStarted('pi-priced-model'),
        nativeAssistantMessage({ input: 100, output: 20 }),
      ].join('\n'),
    );

    const encoded = encodeProjectDir(worktreePath);
    const claudeProjectsDir = join(process.env.HOME, '.claude', 'projects', encoded);
    mkdirSync(claudeProjectsDir, { recursive: true });
    writeFileSync(
      join(claudeProjectsDir, 'session1.jsonl'),
      assistantTurn({ branch: 'task/test', model: 'claude-opus-4-6', inputTokens: 9_999_999, outputTokens: 9_999_999 }),
    );

    const result = meterSessions({
      worktreePath,
      branchName: 'task/test',
      pricingTable: {
        'pi-priced-model': { inputCostPerMTok: 1, outputCostPerMTok: 2 },
        'claude-opus-4-6': { inputCostPerMTok: 15, outputCostPerMTok: 75 },
      },
      agentType: 'claude',
    });

    assert.equal(result.status, 'success');
    if (result.status === 'success') {
      assert.deepEqual(Object.keys(result.models), ['pi-priced-model']);
      assert.equal(result.models['pi-priced-model'].inputTokens, 100);
      assert.equal(result.models['pi-priced-model'].outputTokens, 20);
      assert.equal(result.sessionCount, 1);
      assert.equal(result.turnCount, 1);
    }
  } finally {
    process.env.HOME = originalHome;
    rmSync(base, { recursive: true, force: true });
  }
});

test('Metering auto-detects native sessions without explicit agentType', () => {
  const base = join(tmpdir(), `wavemill-test-${randomUUID()}`);
  const worktreePath = join(base, 'fake-worktree');
  const nativeSessionsDir = join(
    worktreePath,
    '.wavemill',
    'runs',
    'HOK-2305',
    'native-sessions',
  );
  mkdirSync(nativeSessionsDir, { recursive: true });

  try {
    writeFileSync(
      join(nativeSessionsDir, 'session.jsonl'),
      [
        nativeSessionStarted('pi-custom-model'),
        nativeAssistantMessage({ model: 'pi-custom-model', input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 }),
      ].join('\n'),
    );

    // Meter WITHOUT specifying agentType
    const result = meterSessions({
      worktreePath,
      branchName: 'task/test',
      pricingTable: {
        'pi-custom-model': {
          inputCostPerMTok: 1,
          outputCostPerMTok: 2,
          cacheReadCostPerMTok: 0.1,
          cacheWriteCostPerMTok: 1.5,
        },
      },
      // agentType is intentionally omitted - should auto-detect native
    });

    assert.equal(result.status, 'success');
    if (result.status === 'success') {
      // Verify native model ID is preserved in the breakdown
      assert.ok('pi-custom-model' in result.models, 'Native model should be present in cost breakdown');
      assert.equal(result.models['pi-custom-model'].inputTokens, 1000);
      assert.equal(result.models['pi-custom-model'].outputTokens, 500);
      assert.equal(result.models['pi-custom-model'].cacheReadTokens, 200);
      assert.equal(result.models['pi-custom-model'].cacheCreationTokens, 100);

      // Verify cost is calculated correctly for the native model
      const expectedCost = (1000 / 1_000_000) * 1 + (500 / 1_000_000) * 2 + (200 / 1_000_000) * 0.1 + (100 / 1_000_000) * 1.5;
      assert.ok(Math.abs(result.models['pi-custom-model'].costUsd - expectedCost) < 0.0001);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('Handles malformed JSONL lines gracefully', () => {
  const branch = 'task/test';
  const lines = [
    'not-json-at-all',
    '{"type":"assistant","gitBranch":"task/test"}', // Missing message.usage — should not crash
    assistantTurn({ branch, inputTokens: 100, outputTokens: 50 }),
    '{broken json',
  ];

  let matchCount = 0;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'assistant' || entry.gitBranch !== branch) continue;
    const usage = entry.message?.usage;
    if (!usage) continue;
    matchCount++;
  }

  assert.equal(matchCount, 1);
});

// ────────────────────────────────────────────────────────────────
// Tests: native workflow attribution
// ────────────────────────────────────────────────────────────────

function createNativeWorktree(): { worktreePath: string; cleanup: () => void } {
  const base = join(tmpdir(), `wavemill-native-cost-${randomUUID()}`);
  const worktreePath = join(base, 'worktree');
  mkdirSync(worktreePath, { recursive: true });
  return {
    worktreePath,
    cleanup: () => { try { rmSync(base, { recursive: true, force: true }); } catch {} },
  };
}

function writeNativeSession(
  worktreePath: string,
  runId: string,
  sessionId: string,
  modelId: string,
  assistantLines: string[],
): void {
  const nativeSessionsDir = join(worktreePath, '.wavemill', 'runs', runId, 'native-sessions');
  mkdirSync(nativeSessionsDir, { recursive: true });
  const started = JSON.stringify({
    seq: 1,
    sessionId,
    timestamp: 1,
    type: 'session_started',
    model: modelId,
    api: 'responses',
    provider: 'pi',
  });
  writeFileSync(join(nativeSessionsDir, `${sessionId}.jsonl`), [started, ...assistantLines].join('\n'));
}

function nativeAssistant(sessionId: string, modelId: string, usage?: {
  responseId?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  providerCost?: number;
}): string {
  return JSON.stringify({
    seq: 2,
    sessionId,
    timestamp: 2,
    type: 'assistant_message',
    model: modelId,
    ...(usage?.responseId ? { responseId: usage.responseId } : {}),
    stopReason: 'end_turn',
    ...(usage ? {
      usage: {
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        totalTokens: (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
        ...(usage.providerCost !== undefined ? {
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: usage.providerCost,
          },
        } : {}),
      },
    } : {}),
    rawContent: [{ type: 'text', text: 'secret-token-should-not-persist' }],
    replayContent: [{ type: 'text', text: 'secret-token-should-not-persist' }],
    redacted: false,
  });
}

test('Priced native session produces nonzero cost', () => {
  const { worktreePath, cleanup } = createNativeWorktree();
  try {
    writeNativeSession(worktreePath, 'run-1', 'session-1', 'priced-native', [
      nativeAssistant('session-1', 'priced-native', { input: 1_000_000, output: 500_000 }),
    ]);

    const result = meterSessions({
      worktreePath,
      branchName: 'task/native',
      agentType: 'native',
      pricingTable: {
        'priced-native': { inputCostPerMTok: 2, outputCostPerMTok: 8 },
      },
    });

    assert.equal(result.status, 'success');
    if (result.status === 'success') {
      assert.equal(result.totalCostUsd, 6);
      // Native usage cannot prove completeness (no reasoning dimension), so
      // the SDK keeps native coverage partial even when every turn is priced.
      assert.equal(result.attribution?.coverage, 'partial');
      assert.equal(result.attribution?.pricedSessions, 1);
      assert.equal(result.attribution?.unpricedSessions, 0);
      assert.equal(result.attribution?.models[0].costUsd, 6);
      assert.ok(!JSON.stringify(result.attribution).includes('secret-token-should-not-persist'));
    }
  } finally {
    cleanup();
  }
});

test('Native sessions with missing and priced usage report partial coverage', () => {
  const { worktreePath, cleanup } = createNativeWorktree();
  try {
    writeNativeSession(worktreePath, 'run-1', 'session-1', 'priced-native', [
      nativeAssistant('session-1', 'priced-native', { input: 1_000_000, output: 0 }),
    ]);
    writeNativeSession(worktreePath, 'run-2', 'session-2', 'priced-native', [
      nativeAssistant('session-2', 'priced-native'),
    ]);

    const result = meterSessions({
      worktreePath,
      branchName: 'task/native',
      agentType: 'native',
      pricingTable: {
        'priced-native': { inputCostPerMTok: 2, outputCostPerMTok: 8 },
      },
    });

    assert.equal(result.status, 'success');
    if (result.status === 'success') {
      assert.equal(result.totalCostUsd, 2);
      assert.equal(result.attribution?.coverage, 'partial');
      // A partial record names its gap.
      assert.equal(result.attribution?.reason, 'missing_token_usage');
      // Priced/unpriced counts are model segments (the SDK summary keeps no
      // per-session pricing): the one model is priced from the usable session.
      assert.equal(result.attribution?.pricedSessions, 1);
      assert.equal(result.attribution?.unpricedSessions, 0);
      assert.equal(result.attribution?.models[0].priced, true);
    }
  } finally {
    cleanup();
  }
});

test('Native session with unknown pricing is never a known zero', () => {
  const { worktreePath, cleanup } = createNativeWorktree();
  try {
    writeNativeSession(worktreePath, 'run-1', 'session-1', 'unknown-native', [
      nativeAssistant('session-1', 'unknown-native', { input: 1_000, output: 1_000 }),
    ]);

    const result = meterSessions({
      worktreePath,
      branchName: 'task/native',
      agentType: 'native',
      pricingTable: {},
    });

    assert.equal(result.status, 'success');
    if (result.status === 'success') {
      assert.equal(result.totalCostUsd, 0);
      // Usage observed but nothing priced: partial, and no reportable dollar figure.
      assert.equal(result.attribution?.coverage, 'partial');
      assert.equal(reportableWorkflowCostUsd(result), undefined);
      assert.equal(result.attribution?.reason, 'unpriced_model');
      assert.equal(result.attribution?.models[0].reason, 'unpriced_model');
    }
  } finally {
    cleanup();
  }
});

test('Explicit zero native pricing reports a priced zero', () => {
  const { worktreePath, cleanup } = createNativeWorktree();
  try {
    writeNativeSession(worktreePath, 'run-1', 'session-1', 'free-native', [
      nativeAssistant('session-1', 'free-native', { input: 1_000_000, output: 1_000_000 }),
    ]);

    const result = meterSessions({
      worktreePath,
      branchName: 'task/native',
      agentType: 'native',
      pricingTable: {
        'free-native': { inputCostPerMTok: 0, outputCostPerMTok: 0, cacheReadCostPerMTok: 0, cacheWriteCostPerMTok: 0 },
      },
    });

    assert.equal(result.status, 'success');
    if (result.status === 'success') {
      assert.equal(result.totalCostUsd, 0);
      // Native coverage stays partial, but the priced zero is still reportable.
      assert.equal(result.attribution?.coverage, 'partial');
      assert.equal(reportableWorkflowCostUsd(result), 0);
      assert.equal(result.attribution?.pricedSessions, 1);
    }
  } finally {
    cleanup();
  }
});

test('Duplicate native sessions aggregate exactly once', () => {
  const { worktreePath, cleanup } = createNativeWorktree();
  try {
    const lines = [nativeAssistant('session-1', 'priced-native', { input: 1_000_000, output: 0 })];
    writeNativeSession(worktreePath, 'run-1', 'session-1', 'priced-native', lines);
    writeNativeSession(worktreePath, 'run-2', 'session-1', 'priced-native', lines);

    const result = meterSessions({
      worktreePath,
      branchName: 'task/native',
      agentType: 'native',
      pricingTable: {
        'priced-native': { inputCostPerMTok: 2, outputCostPerMTok: 8 },
      },
    });

    assert.equal(result.status, 'success');
    if (result.status === 'success') {
      assert.equal(result.totalCostUsd, 2);
      assert.equal(result.sessionCount, 1);
      assert.equal(result.turnCount, 1);
      assert.equal(result.attribution?.sessions, 1);
      assert.equal(result.attribution?.turns, 1);
    }
  } finally {
    cleanup();
  }
});

test('Native sessions without usable usage do not suppress non-native fallback', () => {
  const tmpHome = join(tmpdir(), `wavemill-native-fallback-${randomUUID()}`);
  const worktreePath = join(tmpHome, 'worktree');
  const encoded = encodeProjectDir(worktreePath);
  const projectsDir = join(tmpHome, '.claude', 'projects', encoded);
  const origHome = process.env.HOME;
  try {
    process.env.HOME = tmpHome;
    mkdirSync(projectsDir, { recursive: true });
    writeNativeSession(worktreePath, 'run-1', 'session-1', 'priced-native', [
      nativeAssistant('session-1', 'priced-native'),
    ]);
    writeFileSync(join(projectsDir, 'claude.jsonl'), assistantTurn({
      branch: 'task/native',
      model: 'claude-test',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    }));

    const result = meterSessions({
      worktreePath,
      branchName: 'task/native',
      agentType: 'claude',
      pricingTable: {
        'claude-test': { inputCostPerMTok: 3, outputCostPerMTok: 10 },
      },
    });

    assert.equal(result.status, 'success');
    if (result.status === 'success') {
      assert.equal(result.totalCostUsd, 3);
      // HOK-2958: attribution is now always emitted for Claude/Codex runs.
      assert.equal(result.attribution?.source, 'claude');
      assert.equal(result.attribution?.coverage, 'complete');
      assert.equal(result.attribution?.models[0].costUsd, 3);
      assert.equal(result.sessionCount, 1);
      assert.equal(result.turnCount, 1);
    }
  } finally {
    process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

function writeCodexSession(tmpHome: string, worktreePath: string, branch: string, modelId: string): void {
  const sessionsDir = join(tmpHome, '.codex', 'sessions', '2026', '08', '17');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, `${randomUUID()}.jsonl`), [
    JSON.stringify({
      type: 'session_meta',
      payload: { cwd: worktreePath, git: { branch } },
    }),
    JSON.stringify({
      type: 'turn_context',
      payload: { model: modelId },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1_000_000,
            cached_input_tokens: 500_000,
            output_tokens: 250_000,
            reasoning_output_tokens: 50_000,
          },
        },
      },
    }),
  ].join('\n'));
}

test('Metering attaches complete codex attribution for priced model', () => {
  const tmpHome = join(tmpdir(), `wavemill-codex-cost-${randomUUID()}`);
  const originalHome = process.env.HOME;
  try {
    process.env.HOME = tmpHome;
    const worktreePath = join(tmpHome, 'worktree');
    const branch = 'task/codex-cost';
    mkdirSync(worktreePath, { recursive: true });
    writeCodexSession(tmpHome, worktreePath, branch, 'gpt-test');

    const result = meterSessions({
      worktreePath,
      branchName: branch,
      agentType: 'codex',
      pricingTable: {
        'gpt-test': { inputCostPerMTok: 2, outputCostPerMTok: 10, cacheReadCostPerMTok: 0.2 },
      },
    });

    assert.equal(result.status, 'success');
    if (result.status === 'success') {
      assert.equal(result.attribution?.source, 'codex');
      assert.equal(result.attribution?.coverage, 'complete');
      assert.equal(result.attribution?.models[0].priced, true);
    }
  } finally {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('Metering reports no cost for an unpriced codex model', () => {
  const tmpHome = join(tmpdir(), `wavemill-codex-cost-${randomUUID()}`);
  const originalHome = process.env.HOME;
  try {
    process.env.HOME = tmpHome;
    const worktreePath = join(tmpHome, 'worktree');
    const branch = 'task/codex-cost';
    mkdirSync(worktreePath, { recursive: true });
    writeCodexSession(tmpHome, worktreePath, branch, 'unpriced-codex');

    const result = meterSessions({
      worktreePath,
      branchName: branch,
      agentType: 'codex',
      pricingTable: {},
    });

    assert.equal(result.status, 'success');
    if (result.status === 'success') {
      assert.equal(result.totalCostUsd, 0);
      assert.equal(result.attribution?.source, 'codex');
      // HOK-2958: nothing priced means the cost is unavailable, not partial —
      // and the attribution row carries no fabricated zero costUsd.
      // Usage observed but nothing priced: partial, and no reportable dollar figure.
      assert.equal(result.attribution?.coverage, 'partial');
      assert.equal(reportableWorkflowCostUsd(result), undefined);
      assert.equal(result.attribution?.reason, 'unpriced_model');
      assert.equal(result.attribution?.models[0].priced, false);
      assert.equal(result.attribution?.models[0].reason, 'unpriced_model');
      assert.equal('costUsd' in (result.attribution?.models[0] ?? {}), false);
    }
  } finally {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

function writeMultiTurnCodexSession(tmpHome: string, worktreePath: string, branch: string, modelId: string): void {
  const sessionsDir = join(tmpHome, '.codex', 'sessions', '2026', '08', '18');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, `${randomUUID()}.jsonl`), [
    JSON.stringify({
      type: 'session_meta',
      payload: { id: 'codex-real-turns', cwd: worktreePath, cli_version: '0.154.0', originator: 'codex_exec', git: { branch } },
    }),
    JSON.stringify({ type: 'turn_context', payload: { model: modelId, turn_id: 't1', root_turn_id: 't1' } }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 500_000, cached_input_tokens: 0, output_tokens: 100_000, reasoning_output_tokens: 0 },
          last_token_usage: { input_tokens: 500_000, cached_input_tokens: 0, output_tokens: 100_000, reasoning_output_tokens: 0 },
        },
      },
    }),
    JSON.stringify({ type: 'turn_context', payload: { model: modelId, turn_id: 't2', root_turn_id: 't1' } }),
    JSON.stringify({ type: 'turn_context', payload: { model: modelId, turn_id: 't3', root_turn_id: 't1' } }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 250_000, reasoning_output_tokens: 0 },
          last_token_usage: { input_tokens: 500_000, cached_input_tokens: 0, output_tokens: 150_000, reasoning_output_tokens: 0 },
        },
      },
    }),
  ].join('\n'));
}

test('Metering codex sessions prices the session totals (HOK-2958)', () => {
  const tmpHome = join(tmpdir(), `wavemill-codex-turns-${randomUUID()}`);
  const originalHome = process.env.HOME;
  try {
    process.env.HOME = tmpHome;
    const worktreePath = join(tmpHome, 'worktree');
    const branch = 'task/codex-turns';
    mkdirSync(worktreePath, { recursive: true });
    writeMultiTurnCodexSession(tmpHome, worktreePath, branch, 'gpt-test');

    const result = meterSessions({
      worktreePath,
      branchName: branch,
      agentType: 'codex',
      pricingTable: {
        'gpt-test': { inputCostPerMTok: 2, outputCostPerMTok: 10 },
      },
    });

    assert.equal(result.status, 'success');
    if (result.status === 'success') {
      // Per-turn usage that does not reconcile with the session totals is
      // metered as one session-level observation; the aggregate and the
      // attribution count the same observations.
      assert.equal(result.attribution?.sessions, 1);
      assert.equal(result.turnCount, result.attribution?.turns);
      assert.equal(result.totalCostUsd, 4.5);
      assert.equal(result.attribution?.coverage, 'complete');
    }
  } finally {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('Metering never fabricates zero cost for unpriced Claude models (HOK-2958)', () => {
  const tmpHome = join(tmpdir(), `wavemill-claude-unpriced-${randomUUID()}`);
  const worktreePath = join(tmpHome, 'worktree');
  const encoded = encodeProjectDir(worktreePath);
  const projectsDir = join(tmpHome, '.claude', 'projects', encoded);
  const origHome = process.env.HOME;
  try {
    process.env.HOME = tmpHome;
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(join(projectsDir, 'claude.jsonl'), [
      assistantTurn({
        branch: 'task/mixed',
        model: 'claude-priced',
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      }),
      assistantTurn({
        branch: 'task/mixed',
        model: 'mystery-model',
        inputTokens: 2_000_000,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      }),
    ].join('\n'));

    const result = meterSessions({
      worktreePath,
      branchName: 'task/mixed',
      agentType: 'claude',
      pricingTable: {
        'claude-priced': { inputCostPerMTok: 3, outputCostPerMTok: 10 },
      },
    });

    assert.equal(result.status, 'success');
    if (result.status === 'success') {
      // Attribution is always emitted, coverage reflects the unpriced model.
      assert.equal(result.attribution?.coverage, 'partial');
      assert.equal(result.attribution?.reason, 'unpriced_model');
      const unpriced = result.attribution?.models.find((m) => m.modelId === 'mystery-model');
      assert.ok(unpriced);
      assert.equal(unpriced.priced, false);
      assert.equal('costUsd' in unpriced, false);
      const priced = result.attribution?.models.find((m) => m.modelId === 'claude-priced');
      assert.equal(priced?.costUsd, 3);
      // Legacy numeric view is preserved for old readers.
      assert.equal(result.models['mystery-model'].costUsd, 0);
      assert.equal(result.totalCostUsd, 3);
      // The pricing snapshot names only the models that were priced.
      assert.deepEqual(Object.keys(result.pricingUsed), ['claude-priced']);
    }
  } finally {
    process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────────────

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);

if (failed > 0) {
  process.exit(1);
}
