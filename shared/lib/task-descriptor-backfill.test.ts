// wavemill-test-suite: custom
import assert from 'node:assert/strict';
import type { EvalRecord, TaskDescriptor } from './eval-schema.ts';
import { backfillTaskDescriptorRecord } from './task-descriptor-backfill.ts';

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

function makeRecord(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    id: 'eval-1',
    schemaVersion: '1.4.0',
    originalPrompt: 'Add API tests for the authentication endpoint',
    modelId: 'claude-sonnet-4-5-20250929',
    modelVersion: 'claude-sonnet-4-5-20250929',
    score: 0.82,
    scoreBand: 'Minor Feedback',
    timeSeconds: 180,
    timestamp: '2026-04-06T12:00:00.000Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'Solid implementation.',
    ...overrides,
  };
}

console.log('\n--- task-descriptor-backfill Tests ---\n');

test('builds descriptors for records missing taskDescriptor', () => {
  const result = backfillTaskDescriptorRecord(makeRecord({
    repoContext: {
      repoId: 'repo',
      repoVisibility: 'private',
      primaryLanguage: 'TypeScript',
      languages: { TypeScript: 100 },
      frameworks: ['Express'],
      repoSize: { fileCount: 50, loc: 20_000, dependencyCount: 10 },
    },
    taskContext: {
      taskType: 'test',
      changeKind: 'modify_existing',
      complexity: 'm',
    },
    difficultySignals: {
      locTouched: 120,
      filesTouched: 4,
    },
  }));

  assert.equal(result.changed, true);
  assert.equal(result.record.taskDescriptor?.signals.heuristic.has_tests, true);
  assert.equal(result.record.taskDescriptor?.signals.learned.domain, 'backend');
  assert.equal(result.record.taskDescriptor?.outcome?.overall_score, 0.82);
});

test('preserves records that already have taskDescriptor', () => {
  const existingDescriptor: TaskDescriptor = {
    schema_version: '1.0',
    signals: {
      heuristic: {
        task_type: 'feature',
        languages: [],
        framework_tags: [],
        files_touched: 0,
        repo_size_loc: 0,
        description_tokens: 5,
        is_greenfield: false,
        has_migration: false,
        has_ui: false,
        has_tests: false,
        cross_service: false,
      },
      learned: {
        complexity: 3,
        domain: 'backend',
        risk_flags: [],
      },
    },
    constraints: {
      models_available: [],
      objective: 'balanced',
    },
    stages: {},
  };

  const record = makeRecord({ taskDescriptor: existingDescriptor });
  const result = backfillTaskDescriptorRecord(record);

  assert.equal(result.changed, false);
  assert.equal(result.skipReason, 'already_has_descriptor');
  assert.equal(result.record.taskDescriptor, existingDescriptor);
});

test('handles sparse legacy rows with only originalPrompt', () => {
  const result = backfillTaskDescriptorRecord(makeRecord({
    originalPrompt: 'Refactor CLI output formatting',
    repoContext: undefined,
    taskContext: undefined,
    difficultySignals: undefined,
  }));

  assert.equal(result.changed, true);
  assert.deepEqual(result.record.taskDescriptor?.signals.heuristic.languages, []);
  assert.equal(result.record.taskDescriptor?.signals.learned.complexity, 2);
  assert.equal(result.record.taskDescriptor?.outcome?.interventions, 0);
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);

if (failed > 0) {
  process.exit(1);
}
