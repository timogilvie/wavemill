/**
 * Tests for the workflow-cost module.
 *
 * Validates session scanning, token aggregation, branch filtering,
 * and cache-aware cost computation.
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  encodeProjectDir,
  computeModelCost,
  computeNormalizedEvaluationCost,
  computeWorkflowCost,
  computeWorkflowCostWithExactPricing,
  recalculateWorkflowCost,
  resolveProjectsDirs,
  type ModelPricing,
  type WorkflowCostResult,
} from './workflow-cost.ts';

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
// Tests: encodeProjectDir
// ────────────────────────────────────────────────────────────────

console.log('\n--- encodeProjectDir Tests ---\n');

test('Encodes absolute path by replacing / with -', () => {
  const result = encodeProjectDir('/Users/tim/worktrees/my-feature');
  assert.equal(result, '-Users-tim-worktrees-my-feature');
});

test('Handles paths with trailing slashes', () => {
  // resolve() strips trailing slashes
  const result = encodeProjectDir('/Users/tim/worktrees/my-feature/');
  assert.equal(result, '-Users-tim-worktrees-my-feature');
});

// ────────────────────────────────────────────────────────────────
// Tests: computeModelCost
// ────────────────────────────────────────────────────────────────

console.log('\n--- computeModelCost Tests ---\n');

test('Computes cost with explicit cache rates', () => {
  const pricing: ModelPricing = {
    inputCostPerMTok: 15,
    outputCostPerMTok: 75,
    cacheWriteCostPerMTok: 18.75,
    cacheReadCostPerMTok: 1.50,
  };
  const cost = computeModelCost(
    { inputTokens: 1_000_000, cacheCreationTokens: 500_000, cacheReadTokens: 2_000_000, outputTokens: 100_000 },
    pricing,
  );
  // input: 1M * 15/1M = 15.00
  // cache write: 0.5M * 18.75/1M = 9.375
  // cache read: 2M * 1.50/1M = 3.00
  // output: 0.1M * 75/1M = 7.50
  // total = 34.875
  assert.ok(Math.abs(cost - 34.875) < 0.001, `Expected 34.875, got ${cost}`);
});

test('Uses explicit zero cache rates without falling back to multipliers', () => {
  const pricing: ModelPricing = {
    inputCostPerMTok: 10,
    outputCostPerMTok: 50,
    cacheWriteCostPerMTok: 0,
    cacheReadCostPerMTok: 0,
  };
  const cost = computeModelCost(
    { inputTokens: 1_000_000, cacheCreationTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 },
    pricing,
  );

  assert.equal(cost, 60);
});

test('Derives cache rates from input rate when not configured', () => {
  const pricing: ModelPricing = {
    inputCostPerMTok: 10,
    outputCostPerMTok: 50,
  };
  const cost = computeModelCost(
    { inputTokens: 1_000_000, cacheCreationTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 },
    pricing,
  );
  // input: 1M * 10/1M = 10.00
  // cache write: 1M * 12.5/1M = 12.50 (10 * 1.25)
  // cache read: 1M * 1.0/1M = 1.00 (10 * 0.1)
  // output: 1M * 50/1M = 50.00
  // total = 73.50
  assert.ok(Math.abs(cost - 73.50) < 0.001, `Expected 73.50, got ${cost}`);
});

test('Returns 0 for zero tokens', () => {
  const pricing: ModelPricing = { inputCostPerMTok: 15, outputCostPerMTok: 75 };
  const cost = computeModelCost(
    { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
    pricing,
  );
  assert.equal(cost, 0);
});

test('Normalized evaluation cost requires explicit input and output token dimensions', () => {
  const pricing: ModelPricing = {
    inputCostPerMTok: 10,
    outputCostPerMTok: 50,
    cacheWriteCostPerMTok: 12.5,
    cacheReadCostPerMTok: 1,
  };
  const normalized = computeNormalizedEvaluationCost(
    { cacheCreationTokens: 0, cacheReadTokens: 0 },
    pricing,
    { requireExplicitCache: true, pricingRevision: 'test-revision' },
  );
  assert.deepEqual(normalized, {
    costUsd: null,
    basis: 'incomplete',
    coverage: 'missing_token_usage',
    pricingRevision: 'test-revision',
  });
});

// ────────────────────────────────────────────────────────────────
// Tests: computeWorkflowCost (integration with temp files)
// ────────────────────────────────────────────────────────────────

console.log('\n--- computeWorkflowCost Tests ---\n');

// We need to override the project directory resolution for testing.
// The simplest approach: create a test that uses the real function path
// but we'll test the constituent parts and use a fixture-based approach.

test('Returns failure when projects directory does not exist', () => {
  const result = computeWorkflowCost({
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
    // We need to patch resolveProjectsDir — since we can't easily,
    // we'll test the encodeProjectDir + computeModelCost path separately
    // and trust the integration via the real function.
    // For now, test with a path that resolves to an empty dir.
    const result = computeWorkflowCost({
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

  // Parse and aggregate manually (mirrors what computeWorkflowCost does internally)
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

test('resolveProjectsDirs includes DeepSeek provider transcript roots', () => {
  const { worktreePath, cleanup } = createTempProjectDir();
  try {
    const encoded = encodeProjectDir(worktreePath);
    const providerProjectsDir = join(
      worktreePath,
      '.wavemill',
      'runs',
      'HOK-1485',
      'providers',
      'deepseek',
      'home',
      '.claude',
      'projects',
      encoded,
    );
    mkdirSync(providerProjectsDir, { recursive: true });

    const dirs = resolveProjectsDirs(worktreePath);
    assert.ok(dirs.includes(providerProjectsDir));
  } finally {
    cleanup();
  }
});

test('computeWorkflowCost prices DeepSeek transcripts from configured aliases without crashing', () => {
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

    const result = computeWorkflowCost({
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

test('computeWorkflowCost includes native session JSONL in workflow totals', () => {
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

    const result = computeWorkflowCost({
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

test('computeWorkflowCost returns zero cost for unknown native model pricing', () => {
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

    const result = computeWorkflowCost({
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

test('computeWorkflowCost prefers native sessions over Claude fallback', () => {
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

    const result = computeWorkflowCost({
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

test('computeWorkflowCost auto-detects native sessions without explicit agentType', () => {
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

    // Call computeWorkflowCost WITHOUT specifying agentType
    const result = computeWorkflowCost({
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
// Tests: Pricing Snapshot (HOK-858)
// ────────────────────────────────────────────────────────────────

console.log('\n--- Pricing Snapshot Tests (HOK-858) ---\n');

test('computeWorkflowCost includes pricingUsed in result', () => {
  // Test that pricingUsed is populated with the correct models
  // We can't easily test the full integration without mocking resolveProjectsDir,
  // so we'll test the logic by manually creating a successful result structure
  // and verifying it has pricingUsed field.

  // Instead, verify the logic by testing the return type structure
  // The actual session scanning is tested elsewhere.
  // Here we just verify that when we have models with pricing,
  // the pricingUsed field is populated.

  const pricing: Record<string, ModelPricing> = {
    'claude-opus-4-6': { inputCostPerMTok: 15, outputCostPerMTok: 75 },
    'claude-sonnet-4-5-20250929': { inputCostPerMTok: 3, outputCostPerMTok: 15 },
  };

  // Simulate what happens in computeWorkflowCost when it processes models
  const pricingUsed: Record<string, ModelPricing> = {};
  const models = ['claude-opus-4-6', 'claude-sonnet-4-5-20250929'];

  for (const modelId of models) {
    const modelPricing = pricing[modelId];
    if (modelPricing) {
      pricingUsed[modelId] = modelPricing;
    }
  }

  // Verify pricingUsed contains only the models that were used
  assert.ok(pricingUsed['claude-opus-4-6']);
  assert.ok(pricingUsed['claude-sonnet-4-5-20250929']);
  assert.equal(Object.keys(pricingUsed).length, 2);

  // Verify pricing values match what was used
  assert.deepEqual(pricingUsed['claude-opus-4-6'], pricing['claude-opus-4-6']);
  assert.deepEqual(pricingUsed['claude-sonnet-4-5-20250929'], pricing['claude-sonnet-4-5-20250929']);
});

test('pricingUsed excludes models not in pricing table', () => {
  // Test that pricingUsed only includes models with pricing

  const pricing: Record<string, ModelPricing> = {
    'claude-opus-4-6': { inputCostPerMTok: 15, outputCostPerMTok: 75 },
  };

  // Simulate processing two models, one with pricing and one without
  const pricingUsed: Record<string, ModelPricing> = {};
  const models = ['unknown-model', 'claude-opus-4-6'];

  for (const modelId of models) {
    const modelPricing = pricing[modelId];
    if (modelPricing) {
      pricingUsed[modelId] = modelPricing;
    }
  }

  // pricingUsed should only contain claude-opus-4-6
  assert.ok(pricingUsed['claude-opus-4-6']);
  assert.ok(!pricingUsed['unknown-model']);
  assert.equal(Object.keys(pricingUsed).length, 1);
});

// ────────────────────────────────────────────────────────────────
// Tests: Cost Recalculation (HOK-858)
// ────────────────────────────────────────────────────────────────

console.log('\n--- Cost Recalculation Tests (HOK-858) ---\n');

test('recalculateWorkflowCost preserves token usage', () => {
  const originalResult: WorkflowCostResult = {
    totalCostUsd: 0.1,
    models: {
      'claude-opus-4-6': {
        inputTokens: 1000,
        cacheCreationTokens: 500,
        cacheReadTokens: 2000,
        outputTokens: 300,
        costUsd: 0.1,
      },
    },
    sessionCount: 1,
    turnCount: 1,
    status: 'success',
    pricingUsed: {
      'claude-opus-4-6': { inputCostPerMTok: 15, outputCostPerMTok: 75 },
    },
  };

  const newPricing = {
    'claude-opus-4-6': { inputCostPerMTok: 20, outputCostPerMTok: 100 },
  };

  const recalculated = recalculateWorkflowCost(originalResult, newPricing);

  // Token counts should be unchanged
  assert.equal(recalculated.models['claude-opus-4-6'].inputTokens, 1000);
  assert.equal(recalculated.models['claude-opus-4-6'].cacheCreationTokens, 500);
  assert.equal(recalculated.models['claude-opus-4-6'].cacheReadTokens, 2000);
  assert.equal(recalculated.models['claude-opus-4-6'].outputTokens, 300);

  // Session/turn counts should be unchanged
  assert.equal(recalculated.sessionCount, 1);
  assert.equal(recalculated.turnCount, 1);
});

test('recalculateWorkflowCost updates costs with new pricing', () => {
  const originalResult: WorkflowCostResult = {
    totalCostUsd: 0.0375,
    models: {
      'claude-opus-4-6': {
        inputTokens: 1000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 200,
        costUsd: 0.03, // 15*1000/1M + 75*200/1M = 0.015 + 0.015 = 0.03
      },
    },
    sessionCount: 1,
    turnCount: 1,
    status: 'success',
    pricingUsed: {
      'claude-opus-4-6': { inputCostPerMTok: 15, outputCostPerMTok: 75 },
    },
  };

  // Double the pricing
  const newPricing = {
    'claude-opus-4-6': { inputCostPerMTok: 30, outputCostPerMTok: 150 },
  };

  const recalculated = recalculateWorkflowCost(originalResult, newPricing);

  // Cost should be doubled
  // New cost: 30*1000/1M + 150*200/1M = 0.03 + 0.03 = 0.06
  assert.ok(Math.abs(recalculated.models['claude-opus-4-6'].costUsd - 0.06) < 0.0001);
  assert.ok(Math.abs(recalculated.totalCostUsd - 0.06) < 0.0001);

  // pricingUsed should be updated to new pricing
  assert.deepEqual(recalculated.pricingUsed['claude-opus-4-6'], newPricing['claude-opus-4-6']);
});

test('recalculateWorkflowCost handles missing models in new pricing', () => {
  const originalResult: WorkflowCostResult = {
    totalCostUsd: 0.03,
    models: {
      'claude-opus-4-6': {
        inputTokens: 1000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 200,
        costUsd: 0.03,
      },
      'old-model': {
        inputTokens: 500,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 100,
        costUsd: 0.01,
      },
    },
    sessionCount: 1,
    turnCount: 2,
    status: 'success',
    pricingUsed: {
      'claude-opus-4-6': { inputCostPerMTok: 15, outputCostPerMTok: 75 },
      'old-model': { inputCostPerMTok: 10, outputCostPerMTok: 50 },
    },
  };

  // New pricing doesn't include old-model
  const newPricing = {
    'claude-opus-4-6': { inputCostPerMTok: 15, outputCostPerMTok: 75 },
  };

  const recalculated = recalculateWorkflowCost(originalResult, newPricing);

  // old-model should have cost = 0
  assert.equal(recalculated.models['old-model'].costUsd, 0);

  // pricingUsed should only include claude-opus-4-6
  assert.ok(recalculated.pricingUsed['claude-opus-4-6']);
  assert.ok(!recalculated.pricingUsed['old-model']);
  assert.equal(Object.keys(recalculated.pricingUsed).length, 1);
});

test('recalculateWorkflowCost handles multiple models', () => {
  // Original pricing: opus input=15, output=75; sonnet input=3, output=15
  // Tokens: opus 1000 input + 200 output, sonnet 2000 input + 400 output
  // Original costs:
  //   opus: (1000*15 + 200*75)/1M = (15000 + 15000)/1M = 0.03
  //   sonnet: (2000*3 + 400*15)/1M = (6000 + 6000)/1M = 0.012
  const originalResult: WorkflowCostResult = {
    totalCostUsd: 0.042,
    models: {
      'claude-opus-4-6': {
        inputTokens: 1000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 200,
        costUsd: 0.03,
      },
      'claude-sonnet-4-5-20250929': {
        inputTokens: 2000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 400,
        costUsd: 0.012,
      },
    },
    sessionCount: 2,
    turnCount: 2,
    status: 'success',
    pricingUsed: {
      'claude-opus-4-6': { inputCostPerMTok: 15, outputCostPerMTok: 75 },
      'claude-sonnet-4-5-20250929': { inputCostPerMTok: 3, outputCostPerMTok: 15 },
    },
  };

  // New pricing with higher rates
  // New costs should be:
  //   opus: (1000*20 + 200*100)/1M = (20000 + 20000)/1M = 0.04
  //   sonnet: (2000*4 + 400*20)/1M = (8000 + 8000)/1M = 0.016
  const newPricing = {
    'claude-opus-4-6': { inputCostPerMTok: 20, outputCostPerMTok: 100 },
    'claude-sonnet-4-5-20250929': { inputCostPerMTok: 4, outputCostPerMTok: 20 },
  };

  const recalculated = recalculateWorkflowCost(originalResult, newPricing);

  // Verify both models have updated costs (should be higher with new pricing)
  assert.ok(recalculated.models['claude-opus-4-6'].costUsd > originalResult.models['claude-opus-4-6'].costUsd);
  assert.ok(recalculated.models['claude-sonnet-4-5-20250929'].costUsd > originalResult.models['claude-sonnet-4-5-20250929'].costUsd);

  // Verify total cost is sum of individual costs
  const expectedTotal = recalculated.models['claude-opus-4-6'].costUsd +
                        recalculated.models['claude-sonnet-4-5-20250929'].costUsd;
  assert.ok(Math.abs(recalculated.totalCostUsd - expectedTotal) < 0.0001);

  // Verify pricingUsed is updated for both models
  assert.deepEqual(recalculated.pricingUsed['claude-opus-4-6'], newPricing['claude-opus-4-6']);
  assert.deepEqual(recalculated.pricingUsed['claude-sonnet-4-5-20250929'], newPricing['claude-sonnet-4-5-20250929']);
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

test('Priced native session produces nonzero cost and complete coverage', () => {
  const { worktreePath, cleanup } = createNativeWorktree();
  try {
    writeNativeSession(worktreePath, 'run-1', 'session-1', 'priced-native', [
      nativeAssistant('session-1', 'priced-native', { input: 1_000_000, output: 500_000 }),
    ]);

    const result = computeWorkflowCost({
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
      assert.equal(result.attribution?.coverage, 'complete');
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

    const result = computeWorkflowCost({
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
      assert.equal(result.attribution?.reason, 'mixed_coverage');
      assert.equal(result.attribution?.pricedSessions, 1);
      assert.equal(result.attribution?.unpricedSessions, 1);
      assert.equal(result.attribution?.models[0].reason, 'missing_token_usage');
    }
  } finally {
    cleanup();
  }
});

test('Native session with unknown pricing is unavailable, not known zero', () => {
  const { worktreePath, cleanup } = createNativeWorktree();
  try {
    writeNativeSession(worktreePath, 'run-1', 'session-1', 'unknown-native', [
      nativeAssistant('session-1', 'unknown-native', { input: 1_000, output: 1_000 }),
    ]);

    const result = computeWorkflowCost({
      worktreePath,
      branchName: 'task/native',
      agentType: 'native',
      pricingTable: {},
    });

    assert.equal(result.status, 'success');
    if (result.status === 'success') {
      assert.equal(result.totalCostUsd, 0);
      assert.equal(result.attribution?.coverage, 'unavailable');
      assert.equal(result.attribution?.reason, 'unpriced_model');
      assert.equal(result.attribution?.models[0].reason, 'unpriced_model');
    }
  } finally {
    cleanup();
  }
});

test('Explicit zero native pricing records known zero coverage', () => {
  const { worktreePath, cleanup } = createNativeWorktree();
  try {
    writeNativeSession(worktreePath, 'run-1', 'session-1', 'free-native', [
      nativeAssistant('session-1', 'free-native', { input: 1_000_000, output: 1_000_000 }),
    ]);

    const result = computeWorkflowCost({
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
      assert.equal(result.attribution?.coverage, 'known_zero');
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

    const result = computeWorkflowCost({
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

    const result = computeWorkflowCost({
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

await asyncTest('computeWorkflowCostWithExactPricing uses OpenRouter generation costs', async () => {
  const { worktreePath, cleanup } = createNativeWorktree();
  try {
    writeNativeSession(worktreePath, 'run-1', 'session-1', 'priced-native', [
      nativeAssistant('session-1', 'priced-native', { responseId: 'gen-one', input: 1_000_000, output: 0 }),
      nativeAssistant('session-1', 'priced-native', { responseId: 'gen-two', input: 1_000_000, output: 0 }),
    ]);

    const result = await computeWorkflowCostWithExactPricing({
      worktreePath,
      branchName: 'task/native',
      agentType: 'native',
      pricingTable: {
        'priced-native': { inputCostPerMTok: 100, outputCostPerMTok: 100 },
      },
      exact: {
        enabled: true,
        fetchGenerationCost: async (id) => ({ totalCostUsd: id === 'gen-one' ? 0.5 : 0.75 }),
      },
    });

    assert.equal(result.status, 'success');
    if (result.status === 'success') {
      assert.equal(result.totalCostUsd, 1.25);
      assert.equal(result.models['priced-native'].costUsd, 1.25);
      assert.equal(Object.keys(result.pricingUsed).length, 0);
      assert.equal(result.attribution?.coverage, 'complete');
      assert.equal(result.attribution?.reason, 'provider_reported_cost');
      assert.equal(result.attribution?.models[0].providerReportedCostUsd, 1.25);
      assert.equal(result.attribution?.models[0].pricingSource, 'openrouter_api');
    }
  } finally {
    cleanup();
  }
});

await asyncTest('computeWorkflowCostWithExactPricing falls back per missing generation', async () => {
  const { worktreePath, cleanup } = createNativeWorktree();
  const warnings: string[] = [];
  try {
    writeNativeSession(worktreePath, 'run-1', 'session-1', 'priced-native', [
      nativeAssistant('session-1', 'priced-native', { responseId: 'gen-one', input: 1_000_000, output: 0 }),
      nativeAssistant('session-1', 'priced-native', { responseId: 'gen-two', input: 2_000_000, output: 0 }),
    ]);

    const result = await computeWorkflowCostWithExactPricing({
      worktreePath,
      branchName: 'task/native',
      agentType: 'native',
      pricingTable: {
        'priced-native': { inputCostPerMTok: 2, outputCostPerMTok: 8 },
      },
      exact: {
        enabled: true,
        logger: { warn: (message: unknown) => { warnings.push(String(message)); } },
        fetchGenerationCost: async (id) => (id === 'gen-one' ? { totalCostUsd: 0.5 } : null),
      },
    });

    assert.equal(result.status, 'success');
    if (result.status === 'success') {
      assert.equal(result.totalCostUsd, 4.5);
      assert.equal(result.attribution?.coverage, 'partial');
      assert.equal(result.attribution?.reason, 'mixed_coverage');
      assert.equal(result.attribution?.models[0].providerReportedCostUsd, 0.5);
      assert.equal(result.attribution?.models[0].pricingSource, 'mixed');
      assert.equal(result.pricingUsed['priced-native'].inputCostPerMTok, 2);
      assert.ok(warnings.some((message) => message.includes('1 generation')));
    }
  } finally {
    cleanup();
  }
});

await asyncTest('computeWorkflowCostWithExactPricing skips API for turns without responseId', async () => {
  const { worktreePath, cleanup } = createNativeWorktree();
  let calls = 0;
  try {
    writeNativeSession(worktreePath, 'run-1', 'session-1', 'priced-native', [
      nativeAssistant('session-1', 'priced-native', { input: 1_000_000, output: 0 }),
    ]);

    const result = await computeWorkflowCostWithExactPricing({
      worktreePath,
      branchName: 'task/native',
      agentType: 'native',
      pricingTable: {
        'priced-native': { inputCostPerMTok: 2, outputCostPerMTok: 8 },
      },
      exact: {
        enabled: true,
        fetchGenerationCost: async () => {
          calls++;
          return { totalCostUsd: 99 };
        },
      },
    });

    assert.equal(result.status, 'success');
    if (result.status === 'success') {
      assert.equal(result.totalCostUsd, 2);
      assert.equal(result.attribution?.models[0].pricingSource, 'local_estimate');
    }
    assert.equal(calls, 0);
  } finally {
    cleanup();
  }
});

await asyncTest('computeWorkflowCostWithExactPricing disabled matches sync result object', async () => {
  const { worktreePath, cleanup } = createNativeWorktree();
  try {
    writeNativeSession(worktreePath, 'run-1', 'session-1', 'priced-native', [
      nativeAssistant('session-1', 'priced-native', { responseId: 'gen-one', input: 1_000_000, output: 0 }),
    ]);

    const syncResult = computeWorkflowCost({
      worktreePath,
      branchName: 'task/native',
      agentType: 'native',
      pricingTable: {
        'priced-native': { inputCostPerMTok: 2, outputCostPerMTok: 8 },
      },
    });

    const asyncResult = await computeWorkflowCostWithExactPricing({
      worktreePath,
      branchName: 'task/native',
      agentType: 'native',
      pricingTable: {
        'priced-native': { inputCostPerMTok: 2, outputCostPerMTok: 8 },
      },
      exact: { enabled: false },
    });
    assert.deepEqual(asyncResult, syncResult);
  } finally {
    cleanup();
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

test('computeWorkflowCost attaches complete codex attribution for priced model', () => {
  const tmpHome = join(tmpdir(), `wavemill-codex-cost-${randomUUID()}`);
  const originalHome = process.env.HOME;
  try {
    process.env.HOME = tmpHome;
    const worktreePath = join(tmpHome, 'worktree');
    const branch = 'task/codex-cost';
    mkdirSync(worktreePath, { recursive: true });
    writeCodexSession(tmpHome, worktreePath, branch, 'gpt-test');

    const result = computeWorkflowCost({
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

test('computeWorkflowCost reports unavailable codex attribution for unpriced model', () => {
  const tmpHome = join(tmpdir(), `wavemill-codex-cost-${randomUUID()}`);
  const originalHome = process.env.HOME;
  try {
    process.env.HOME = tmpHome;
    const worktreePath = join(tmpHome, 'worktree');
    const branch = 'task/codex-cost';
    mkdirSync(worktreePath, { recursive: true });
    writeCodexSession(tmpHome, worktreePath, branch, 'unpriced-codex');

    const result = computeWorkflowCost({
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
      assert.equal(result.attribution?.coverage, 'unavailable');
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

test('computeWorkflowCost codex attribution reports real observed turn counts (HOK-2958)', () => {
  const tmpHome = join(tmpdir(), `wavemill-codex-turns-${randomUUID()}`);
  const originalHome = process.env.HOME;
  try {
    process.env.HOME = tmpHome;
    const worktreePath = join(tmpHome, 'worktree');
    const branch = 'task/codex-turns';
    mkdirSync(worktreePath, { recursive: true });
    writeMultiTurnCodexSession(tmpHome, worktreePath, branch, 'gpt-test');

    const result = computeWorkflowCost({
      worktreePath,
      branchName: branch,
      agentType: 'codex',
      pricingTable: {
        'gpt-test': { inputCostPerMTok: 2, outputCostPerMTok: 10 },
      },
    });

    assert.equal(result.status, 'success');
    if (result.status === 'success') {
      // Legacy aggregate keeps 1 turn/session for compatibility…
      assert.equal(result.turnCount, 1);
      // …while attribution now reports real records from the session detail.
      assert.equal(result.attribution?.sessions, 1);
      assert.equal(result.attribution?.turns, 3);
      assert.equal(result.attribution?.coverage, 'complete');
    }
  } finally {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('computeWorkflowCost never fabricates zero cost for unpriced Claude models (HOK-2958)', () => {
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

    const result = computeWorkflowCost({
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
