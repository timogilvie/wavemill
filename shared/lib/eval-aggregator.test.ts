// wavemill-test-suite: custom
import assert from 'node:assert/strict';
import type { EvalRecord, RubricEval } from './eval-schema.ts';
import { deduplicateByHash, meetsMintEligibility } from './eval-aggregator.ts';

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

function makeRubricEval(): RubricEval {
  return {
    schema_version: '1.0',
    rubric_version: '1.0',
    criteria: {
      completeness: { score: 0.9, rationale: 'Complete.' },
      correctness: { score: 0.85, rationale: 'Correct.' },
      code_quality: { score: 0.88, rationale: 'Clean.' },
      intervention_impact: { score: 1, rationale: 'No intervention.' },
      autonomy: { score: 0.92, rationale: 'Autonomous.' },
    },
    determinative_boundary: 'no_interventions',
  };
}

function makeRecord(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    id: 'record-1',
    schemaVersion: '1.12.0',
    originalPrompt: 'prompt',
    modelId: 'claude-opus-4-6',
    modelVersion: 'version',
    score: 1,
    scoreBand: 'Full Success',
    timeSeconds: 1,
    timestamp: '2026-03-01T00:00:00Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'ok',
    issueId: 'HOK-1',
    prUrl: 'https://x/pull/1',
    ...overrides,
  };
}

console.log('\n--- eval-aggregator tests ---\n');

test('deduplicateByHash preserves rubric-aware records when hashes are unique', () => {
  const rubricEval = makeRubricEval();
  const result = deduplicateByHash([
    makeRecord({
      id: 'a',
      rubric_provenance: 'judge',
      rubricEval,
    }),
  ]);

  assert.equal(result.deduplicatedRecords.length, 1);
  assert.equal(result.deduplicatedRecords[0]?.rubric_provenance, 'judge');
  assert.deepEqual(result.deduplicatedRecords[0]?.rubricEval, rubricEval);
});

test('deduplicateByHash prefers judge provenance over earlier legacy record', () => {
  const result = deduplicateByHash([
    makeRecord({
      id: 'legacy',
      timestamp: '2026-03-01T00:00:00Z',
      rubric_provenance: 'legacy_absent',
    }),
    makeRecord({
      id: 'judge',
      timestamp: '2026-03-01T00:00:00Z',
      rubric_provenance: 'judge',
      rubricEval: makeRubricEval(),
    }),
  ]);

  assert.equal(result.duplicatesRemoved, 1);
  assert.equal(result.deduplicatedRecords[0]?.id, 'judge');
});

test('meetsMintEligibility blocks low coverage by default', () => {
  const result = meetsMintEligibility({
    scoreable_coverage: 0.79,
    invalid_route_rate: 0.01,
  });

  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'scoreable coverage below threshold');
  assert.equal(result.threshold, 0.8);
});

test('meetsMintEligibility blocks excessive invalid routes', () => {
  const result = meetsMintEligibility({
    scoreable_coverage: 0.95,
    invalid_route_rate: 0.3,
  });

  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'invalid route rate above threshold');
  assert.equal(result.maxInvalidRouteRate, 0.2);
});

test('meetsMintEligibility can be disabled explicitly', () => {
  const result = meetsMintEligibility(
    {
      scoreable_coverage: 0.1,
      invalid_route_rate: 0.9,
    },
    { enabled: false },
  );

  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'mint gating disabled');
});

process.on('exit', () => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
});
