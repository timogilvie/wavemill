import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache } from './config.ts';
import {
  resolveRuntimeResource,
  resolveRuntimeResourceContent,
} from './resource-selection.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(error as Error).message}`);
  }
}

function makeRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'resource-selection-test-'));
  mkdirSync(join(repoDir, 'tools', 'prompts'), { recursive: true });
  mkdirSync(join(repoDir, 'dspy', 'artifacts'), { recursive: true });
  writeFileSync(join(repoDir, 'tools', 'prompts', 'planning-phase.md'), 'baseline planner prompt', 'utf-8');
  writeFileSync(join(repoDir, 'tools', 'prompts', 'review-phase.md'), 'baseline reviewer prompt', 'utf-8');
  writeFileSync(join(repoDir, 'dspy', 'artifacts', 'optimized-selector.json'), JSON.stringify({
    version: '1.0.0',
    created_at: '2026-04-01T00:00:00Z',
    optimizer: 'MIPROv2',
    teacher_model: 'gpt-5.6-terra',
    runtime_model: 'gpt-4o-mini',
    system_prompt: 'route well',
    few_shot_examples: [],
    model_candidates: ['gpt-5.4'],
    metadata: {},
  }), 'utf-8');
  writeFileSync(join(repoDir, 'dspy', 'artifacts', 'optimized-selector-20260404.json'), JSON.stringify({
    version: '1.1.0-canary',
    created_at: '2026-04-04T00:00:00Z',
    optimizer: 'MIPROv2',
    teacher_model: 'gpt-5.6-terra',
    runtime_model: 'gpt-4o-mini',
    system_prompt: 'canary route',
    few_shot_examples: [],
    model_candidates: ['gpt-5.4'],
    metadata: {},
  }), 'utf-8');
  writeFileSync(join(repoDir, 'dspy', 'artifacts', 'optimized-planner.json'), JSON.stringify({
    version: '2.0.0',
    stage: 'planner',
    created_at: '2026-04-01T00:00:00Z',
    optimizer: 'DSPy',
    teacher_model: 'gpt-5.6-terra',
    optimized_instruction: 'optimized planner prompt',
    metadata: {},
  }), 'utf-8');
  writeFileSync(join(repoDir, 'dspy', 'artifacts', 'optimized-reviewer.json'), JSON.stringify({
    version: '2.0.0',
    stage: 'reviewer',
    created_at: '2026-04-01T00:00:00Z',
    optimizer: 'DSPy',
    teacher_model: 'gpt-5.6-terra',
    optimized_instruction: 'optimized reviewer prompt',
    metadata: {},
  }), 'utf-8');
  return repoDir;
}

function writeConfig(repoDir: string, config: unknown): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config, null, 2), 'utf-8');
  clearConfigCache(repoDir);
}

console.log('\n--- Resource Selection Tests ---\n');

test('disabled runtime selection returns baseline prompt content', () => {
  const repoDir = makeRepo();
  try {
    writeConfig(repoDir, {});
    const result = resolveRuntimeResourceContent('planner', { repoDir });
    assert.equal(result.selection.variant, 'baseline');
    assert.equal(result.selection.resourceRef?.id.startsWith('prompt:'), true);
    assert.equal(result.content, 'baseline planner prompt');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('enabled surface selects optimized planner prompt', () => {
  const repoDir = makeRepo();
  try {
    writeConfig(repoDir, {
      resources: {
        runtimeSelection: {
          enabled: true,
          surfaces: {
            planner: {
              enabled: true,
              variant: 'optimized',
            },
          },
        },
      },
    });
    const result = resolveRuntimeResourceContent('planner', { repoDir });
    assert.equal(result.selection.variant, 'optimized');
    assert.equal(result.content, 'optimized planner prompt');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('surface disabled falls back to baseline even when optimized is default', () => {
  const repoDir = makeRepo();
  try {
    writeConfig(repoDir, {
      resources: {
        runtimeSelection: {
          enabled: true,
          defaultVariant: 'optimized',
          surfaces: {
            planner: {
              enabled: false,
            },
          },
        },
      },
    });
    const selection = resolveRuntimeResource('planner', { repoDir });
    assert.equal(selection.variant, 'baseline');
    assert.equal(selection.fallbackApplied, true);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('missing candidate falls back with rejection reason', () => {
  const repoDir = makeRepo();
  try {
    writeConfig(repoDir, {
      resources: {
        runtimeSelection: {
          enabled: true,
          canaryRate: 1,
          surfaces: {
            reviewer: {
              enabled: true,
              variant: 'canary',
              path: 'dspy/artifacts/missing-reviewer.json',
            },
          },
        },
      },
    });
    const result = resolveRuntimeResourceContent('reviewer', { repoDir, sessionId: 'sess-1' });
    assert.equal(result.selection.variant, 'baseline');
    assert.equal(result.selection.fallbackApplied, true);
    assert.match(result.selection.rejectionReason || '', /candidate file not found/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('canary bucketing is deterministic by session id', () => {
  const repoDir = makeRepo();
  try {
    writeConfig(repoDir, {
      resources: {
        runtimeSelection: {
          enabled: true,
          canaryRate: 1,
          surfaces: {
            router: {
              enabled: true,
              variant: 'canary',
            },
          },
        },
      },
    });
    const first = resolveRuntimeResource('router', { repoDir, sessionId: 'sess-1' });
    const second = resolveRuntimeResource('router', { repoDir, sessionId: 'sess-1' });
    assert.deepEqual(first, second);
    assert.equal(first.variant, 'canary');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('registry disabled does not throw', () => {
  const repoDir = makeRepo();
  try {
    writeConfig(repoDir, {
      registry: { enabled: false },
      resources: {
        runtimeSelection: {
          enabled: true,
          surfaces: {
            planner: {
              enabled: true,
              variant: 'optimized',
            },
          },
        },
      },
    });
    const result = resolveRuntimeResourceContent('planner', { repoDir });
    assert.equal(result.selection.resourceRef, null);
    assert.equal(result.content, 'optimized planner prompt');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('fallback disabled returns unresolved error result', () => {
  const repoDir = makeRepo();
  try {
    writeConfig(repoDir, {
      resources: {
        runtimeSelection: {
          enabled: true,
          canaryRate: 1,
          fallbackToBaseline: false,
          surfaces: {
            reviewer: {
              enabled: true,
              variant: 'canary',
              path: 'dspy/artifacts/missing-reviewer.json',
            },
          },
        },
      },
    });
    const result = resolveRuntimeResourceContent('reviewer', { repoDir, sessionId: 'sess-1' });
    assert.equal(result.content, null);
    assert.match(result.error || '', /candidate file not found/);
    assert.equal(result.selection.fallbackApplied, false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('resolver CLI emits parseable JSON with content and selection metadata', () => {
  const repoDir = makeRepo();
  try {
    writeConfig(repoDir, {});
    const raw = execFileSync('npx', [
      'tsx',
      'tools/resolve-runtime-resource.ts',
      '--surface',
      'planner',
      '--repo-dir',
      repoDir,
      '--json',
    ], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });
    const parsed = JSON.parse(raw);
    assert.equal(parsed.content, 'baseline planner prompt');
    assert.equal(parsed.selection.surface, 'planner');
    assert.equal(parsed.selection.variant, 'baseline');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

process.on('exit', () => {
  if (failed > 0) {
    process.exitCode = 1;
  }
});
