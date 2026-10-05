/**
 * Unit tests for llm-router — artifact loading, prompt construction,
 * response parsing, and LLM-based recommendation.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SelectorArtifact, LLMRoutingResponse, CallFn } from './llm-router.ts';
import { clearConfigCache } from './config.ts';
import {
  loadArtifact,
  buildRoutingPrompt,
  parseRoutingResponse,
  recommendModelLLM,
} from './llm-router.ts';

// ────────────────────────────────────────────────────────────────
// Test Harness
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

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

function makeArtifact(overrides?: Partial<SelectorArtifact>): SelectorArtifact {
  return {
    version: '1.0.0',
    created_at: '2026-02-24T00:00:00Z',
    optimizer: 'MIPROv2',
    teacher_model: 'claude-sonnet-4-5-20250929',
    runtime_model: 'claude-haiku-4-5-20251001',
    system_prompt: 'You are a task router. Route tasks to the best model.',
    few_shot_examples: [
      {
        task_prompt: 'Add a logout button to the header',
        repo_name: 'hokusai-site',
        task_type_hint: 'feature',
        available_models: 'claude-sonnet-4-5-20250929,gpt-5.3-codex,gpt-5.4',
        recommended_model: 'gpt-5.3-codex',
        recommended_agent: 'codex',
        confidence: 'high',
        risk_flags: [],
        cost_estimate: 'low',
        reasoning: 'Greenfield component, codex is cheaper.',
      },
    ],
    model_candidates: ['claude-sonnet-4-5-20250929', 'gpt-5.3-codex', 'gpt-5.4'],
    metadata: { training_records: 70, val_score: 0.82 },
    ...overrides,
  };
}

// HOK-3100: tests exercise `loadArtifact` which now reads from the wavemill
// install (never a milled repo). Point WAVEMILL_DIR at the per-test temp dir
// so these fixtures continue to behave like a fake install.
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'llm-router-test-'));
  process.env.WAVEMILL_DIR = dir;
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.WAVEMILL_DIR;
}

function makeResponse(overrides?: Partial<LLMRoutingResponse>): LLMRoutingResponse {
  return {
    recommended_model: 'claude-sonnet-4-5-20250929',
    recommended_agent: 'claude',
    confidence: 'high',
    risk_flags: ['modifies-existing-runtime'],
    cost_estimate: 'medium',
    reasoning: 'Task modifies existing Prisma queries.',
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────
// Tests: loadArtifact
// ────────────────────────────────────────────────────────────────

console.log('\n── loadArtifact ──');

test('returns null when file does not exist', () => {
  // HOK-3100: the install resolver reads from WAVEMILL_DIR; point it at a
  // nonexistent dir so the artifact path cannot resolve.
  const originalEnv = process.env.WAVEMILL_DIR;
  process.env.WAVEMILL_DIR = '/nonexistent/path/' + Date.now();
  try {
    const result = loadArtifact('/nonexistent/path');
    assert.equal(result, null);
  } finally {
    if (originalEnv === undefined) delete process.env.WAVEMILL_DIR;
    else process.env.WAVEMILL_DIR = originalEnv;
  }
});

test('returns null when directory has no artifact', () => {
  const dir = makeTempDir();
  try {
    const result = loadArtifact(dir);
    assert.equal(result, null);
  } finally {
    cleanup(dir);
  }
});

test('parses valid artifact JSON', () => {
  const dir = makeTempDir();
  try {
    const artifactDir = join(dir, 'dspy', 'artifacts');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, 'optimized-selector.json'),
      JSON.stringify(makeArtifact()),
    );
    const result = loadArtifact(dir);
    assert.notEqual(result, null);
    assert.equal(result!.version, '1.0.0');
    assert.equal(result!.few_shot_examples.length, 1);
  } finally {
    cleanup(dir);
  }
});

test('returns null on malformed JSON', () => {
  const dir = makeTempDir();
  try {
    const artifactDir = join(dir, 'dspy', 'artifacts');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, 'optimized-selector.json'), '{invalid json}');
    const result = loadArtifact(dir);
    assert.equal(result, null);
  } finally {
    cleanup(dir);
  }
});

test('returns null when required fields are missing', () => {
  const dir = makeTempDir();
  try {
    const artifactDir = join(dir, 'dspy', 'artifacts');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, 'optimized-selector.json'),
      JSON.stringify({ version: '1.0.0' }),
    );
    const result = loadArtifact(dir);
    assert.equal(result, null);
  } finally {
    cleanup(dir);
  }
});

test('loads artifact from custom path', () => {
  const dir = makeTempDir();
  try {
    const customDir = join(dir, 'custom');
    mkdirSync(customDir, { recursive: true });
    writeFileSync(
      join(customDir, 'my-artifact.json'),
      JSON.stringify(makeArtifact()),
    );
    const result = loadArtifact(dir, 'custom/my-artifact.json');
    assert.notEqual(result, null);
    assert.equal(result!.version, '1.0.0');
  } finally {
    cleanup(dir);
  }
});

// ────────────────────────────────────────────────────────────────
// Tests: buildRoutingPrompt
// ────────────────────────────────────────────────────────────────

console.log('\n── buildRoutingPrompt ──');

test('includes system prompt from artifact', () => {
  const artifact = makeArtifact();
  const prompt = buildRoutingPrompt(
    artifact, 'Fix the login bug', 'my-repo', 'bugfix',
    ['claude-sonnet-4-5-20250929'],
  );
  assert.ok(prompt.includes('You are a task router'));
});

test('includes few-shot examples', () => {
  const artifact = makeArtifact();
  const prompt = buildRoutingPrompt(
    artifact, 'Add a feature', 'my-repo', 'feature',
    ['claude-sonnet-4-5-20250929'],
  );
  assert.ok(prompt.includes('Add a logout button to the header'));
  assert.ok(prompt.includes('"recommended_model":"gpt-5.3-codex"'));
});

test('includes current task details', () => {
  const artifact = makeArtifact();
  const prompt = buildRoutingPrompt(
    artifact, 'Fix the Prisma query', 'hokusai-site', 'bugfix',
    ['claude-sonnet-4-5-20250929', 'gpt-5.3-codex', 'gpt-5.4'],
  );
  assert.ok(prompt.includes('Fix the Prisma query'));
  assert.ok(prompt.includes('Repo: hokusai-site'));
  assert.ok(prompt.includes('Type: bugfix'));
  assert.ok(prompt.includes('claude-sonnet-4-5-20250929,gpt-5.3-codex,gpt-5.4'));
});

test('truncates long task prompts at 2000 chars', () => {
  const artifact = makeArtifact();
  const longPrompt = 'x'.repeat(5000);
  const prompt = buildRoutingPrompt(
    artifact, longPrompt, 'my-repo', 'feature',
    ['claude-sonnet-4-5-20250929'],
  );
  // Should not contain the full 5000 chars
  assert.ok(!prompt.includes('x'.repeat(3000)));
  // But should contain 2000 chars
  assert.ok(prompt.includes('x'.repeat(2000)));
});

// ────────────────────────────────────────────────────────────────
// Tests: parseRoutingResponse
// ────────────────────────────────────────────────────────────────

console.log('\n── parseRoutingResponse ──');

test('parses valid JSON response', () => {
  const response = makeResponse();
  const result = parseRoutingResponse(JSON.stringify(response));
  assert.notEqual(result, null);
  assert.equal(result!.recommended_model, 'claude-sonnet-4-5-20250929');
  assert.equal(result!.confidence, 'high');
  assert.deepEqual(result!.risk_flags, ['modifies-existing-runtime']);
});

test('handles markdown code fences', () => {
  const response = makeResponse();
  const wrapped = '```json\n' + JSON.stringify(response) + '\n```';
  const result = parseRoutingResponse(wrapped);
  assert.notEqual(result, null);
  assert.equal(result!.recommended_model, 'claude-sonnet-4-5-20250929');
});

test('returns null on invalid JSON', () => {
  const result = parseRoutingResponse('not json at all');
  assert.equal(result, null);
});

test('returns null when recommended_model is missing', () => {
  const result = parseRoutingResponse(JSON.stringify({ confidence: 'high' }));
  assert.equal(result, null);
});

test('defaults missing optional fields', () => {
  const result = parseRoutingResponse(JSON.stringify({
    recommended_model: 'claude-sonnet-4-5-20250929',
  }));
  assert.notEqual(result, null);
  assert.equal(result!.confidence, 'low');
  assert.deepEqual(result!.risk_flags, []);
  assert.equal(result!.cost_estimate, 'unknown');
});

// ────────────────────────────────────────────────────────────────
// Tests: recommendModelLLM
// ────────────────────────────────────────────────────────────────

console.log('\n── recommendModelLLM ──');

test('returns null when no artifact exists', () => {
  const result = recommendModelLLM(
    'Add a login page',
    { length: 'short', charCount: 20, complexityScore: 0, fileTypes: [], taskType: 'feature' },
    { repoDir: '/nonexistent' },
  );
  assert.equal(result, null);
});

test('returns recommendation on successful LLM call', () => {
  const dir = makeTempDir();
  try {
    clearConfigCache(dir);
    const artifactDir = join(dir, 'dspy', 'artifacts');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, 'optimized-selector.json'),
      JSON.stringify(makeArtifact()),
    );

    const mockCallFn: CallFn = () => JSON.stringify(makeResponse());

    const result = recommendModelLLM(
      'Fix the Prisma query in token metadata',
      { length: 'medium', charCount: 500, complexityScore: 1, fileTypes: ['.ts'], taskType: 'bugfix' },
      { repoDir: dir, repoName: 'hokusai-site' },
      mockCallFn,
    );

    assert.notEqual(result, null);
    assert.equal(result!.recommendedModel, 'claude-sonnet-4-5-20250929');
    assert.equal(result!.recommendedAgent, 'claude');
    assert.equal(result!.confidence, 'high');
    assert.deepEqual(result!.riskFlags, ['modifies-existing-runtime']);
    assert.equal(result!.costEstimate, 'medium');
    assert.equal(result!.routingMode, 'llm');
    assert.equal(result!.resourceSelections?.[0]?.surface, 'router');
    assert.equal(result!.resourceSelections?.[0]?.variant, 'baseline');
    assert.ok(result!.reasoning.startsWith('[LLM Router]'));
  } finally {
    cleanup(dir);
  }
});

test('returns null when LLM call throws', () => {
  const dir = makeTempDir();
  try {
    const artifactDir = join(dir, 'dspy', 'artifacts');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, 'optimized-selector.json'),
      JSON.stringify(makeArtifact()),
    );

    const throwingCallFn: CallFn = () => { throw new Error('timeout'); };

    const result = recommendModelLLM(
      'Some task',
      { length: 'short', charCount: 10, complexityScore: 0, fileTypes: [], taskType: 'feature' },
      { repoDir: dir },
      throwingCallFn,
    );

    assert.equal(result, null);
  } finally {
    cleanup(dir);
  }
});

test('returns null when LLM returns invalid model', () => {
  const dir = makeTempDir();
  try {
    const artifactDir = join(dir, 'dspy', 'artifacts');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, 'optimized-selector.json'),
      JSON.stringify(makeArtifact()),
    );

    const badModelCallFn: CallFn = () =>
      JSON.stringify(makeResponse({ recommended_model: 'nonexistent-model' }));

    const result = recommendModelLLM(
      'Some task',
      { length: 'short', charCount: 10, complexityScore: 0, fileTypes: [], taskType: 'feature' },
      { repoDir: dir },
      badModelCallFn,
    );

    assert.equal(result, null);
  } finally {
    cleanup(dir);
  }
});

test('returns null when LLM returns unparseable text', () => {
  const dir = makeTempDir();
  try {
    const artifactDir = join(dir, 'dspy', 'artifacts');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, 'optimized-selector.json'),
      JSON.stringify(makeArtifact()),
    );

    const garbageCallFn: CallFn = () => 'I cannot process this request.';

    const result = recommendModelLLM(
      'Some task',
      { length: 'short', charCount: 10, complexityScore: 0, fileTypes: [], taskType: 'feature' },
      { repoDir: dir },
      garbageCallFn,
    );

    assert.equal(result, null);
  } finally {
    cleanup(dir);
  }
});

test('uses models from options over artifact candidates', () => {
  const dir = makeTempDir();
  try {
    const artifactDir = join(dir, 'dspy', 'artifacts');
    mkdirSync(artifactDir, { recursive: true });

    const artifact = makeArtifact({
      model_candidates: ['claude-sonnet-4-5-20250929', 'gpt-5.3-codex', 'gpt-5.4'],
    });
    writeFileSync(
      join(artifactDir, 'optimized-selector.json'),
      JSON.stringify(artifact),
    );

    // LLM returns a model that's in options.models but not artifact.model_candidates
    const callFn: CallFn = () =>
      JSON.stringify(makeResponse({ recommended_model: 'claude-opus-4-6' }));

    const result = recommendModelLLM(
      'Complex task',
      { length: 'long', charCount: 2000, complexityScore: 5, fileTypes: ['.ts'], taskType: 'feature' },
      { repoDir: dir, models: ['claude-opus-4-6', 'claude-sonnet-4-5-20250929'] },
      callFn,
    );

    assert.notEqual(result, null);
    assert.equal(result!.recommendedModel, 'claude-opus-4-6');
  } finally {
    cleanup(dir);
  }
});

// ────────────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────────────

console.log(`\n── Summary: ${passed} passed, ${failed} failed ──\n`);
if (failed > 0) process.exit(1);
