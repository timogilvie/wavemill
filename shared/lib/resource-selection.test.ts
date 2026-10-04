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

// HOK-3100: tests set WAVEMILL_DIR to the repoDir so the install resolver
// picks up the fake prompts/artifacts written here instead of the real
// install's. The milled repo (`repoDir`) and the install happen to be the
// same directory for the test's convenience; the production split is enforced
// in `tests/check-install-paths.test.sh`.
function makeRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'resource-selection-test-'));
  process.env.WAVEMILL_DIR = repoDir;
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

function tearDown(repoDir: string): void {
  rmSync(repoDir, { recursive: true, force: true });
  delete process.env.WAVEMILL_DIR;
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
    tearDown(repoDir);
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
    tearDown(repoDir);
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
    tearDown(repoDir);
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
    tearDown(repoDir);
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
    tearDown(repoDir);
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
    tearDown(repoDir);
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
    tearDown(repoDir);
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
      env: { ...process.env, WAVEMILL_DIR: repoDir },
    });
    const parsed = JSON.parse(raw);
    assert.equal(parsed.content, 'baseline planner prompt');
    assert.equal(parsed.selection.surface, 'planner');
    assert.equal(parsed.selection.variant, 'baseline');
  } finally {
    tearDown(repoDir);
  }
});

process.on('exit', () => {
  if (failed > 0) {
    process.exitCode = 1;
  }
});
