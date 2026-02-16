/**
 * Scenario validation tests for the eval scoring rubric and data schema.
 *
 * Validates that:
 * - Score values map to the correct rubric band
 * - All required EvalRecord fields are present
 * - The JSON Schema validates correct records and rejects malformed ones
 * - 4 hypothetical scenarios cover the full rubric range
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type EvalRecord,
  type TokenUsage,
  SCORE_BANDS,
  getScoreBand,
} from './eval-schema.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(join(__dirname, 'eval-schema.json'), 'utf-8'),
);

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

/** Minimal JSON Schema validator for the subset of features we use. */
function validateAgainstSchema(
  record: Record<string, unknown>,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check required fields
  for (const field of schema.required) {
    if (!(field in record)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Check additionalProperties
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(record)) {
      if (!(key in schema.properties)) {
        errors.push(`Unexpected field: ${key}`);
      }
    }
  }

  // Check types and constraints for present fields
  for (const [key, prop] of Object.entries(
    schema.properties as Record<string, Record<string, unknown>>,
  )) {
    if (!(key in record)) continue;
    const value = record[key];

    // Type check
    const expectedType = prop.type as string;
    if (expectedType === 'string' && typeof value !== 'string') {
      errors.push(`${key}: expected string, got ${typeof value}`);
    } else if (expectedType === 'number' && typeof value !== 'number') {
      errors.push(`${key}: expected number, got ${typeof value}`);
    } else if (expectedType === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        errors.push(`${key}: expected integer, got ${value}`);
      }
    } else if (expectedType === 'boolean' && typeof value !== 'boolean') {
      errors.push(`${key}: expected boolean, got ${typeof value}`);
    } else if (expectedType === 'array' && !Array.isArray(value)) {
      errors.push(`${key}: expected array, got ${typeof value}`);
    } else if (expectedType === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value))) {
      errors.push(`${key}: expected object, got ${typeof value}`);
    }

    // Numeric range checks
    if (typeof value === 'number') {
      if (prop.minimum !== undefined && value < (prop.minimum as number)) {
        errors.push(`${key}: ${value} < minimum ${prop.minimum}`);
      }
      if (prop.maximum !== undefined && value > (prop.maximum as number)) {
        errors.push(`${key}: ${value} > maximum ${prop.maximum}`);
      }
    }

    // Enum check
    if (prop.enum && !(prop.enum as unknown[]).includes(value)) {
      errors.push(
        `${key}: "${value}" not in enum [${(prop.enum as string[]).join(', ')}]`,
      );
    }

    // Pattern check
    if (prop.pattern && typeof value === 'string') {
      if (!new RegExp(prop.pattern as string).test(value)) {
        errors.push(`${key}: "${value}" does not match pattern ${prop.pattern}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ────────────────────────────────────────────────────────────────
// Test Fixtures — 4 Hypothetical Scenarios
// ────────────────────────────────────────────────────────────────

const scenarios: { name: string; record: EvalRecord }[] = [
  {
    name: 'Scenario 1: Full autonomous success (score 1.0)',
    record: {
      id: '550e8400-e29b-41d4-a716-446655440001',
      schemaVersion: '1.0.0',
      originalPrompt:
        'Add a logout button to the user settings page that clears the session and redirects to login',
      modelId: 'claude-opus-4-6',
      modelVersion: 'claude-opus-4-6-20250514',
      score: 1.0,
      scoreBand: 'Full Success',
      timeSeconds: 245,
      timestamp: '2026-02-14T10:30:00Z',
      interventionRequired: false,
      interventionCount: 0,
      interventionDetails: [],
      rationale:
        'Agent completed the task fully autonomously. Created the logout button component, wired up session clearing logic, added redirect, and all tests pass. No human intervention was needed.',
      issueId: 'HOK-500',
      prUrl: 'https://github.com/org/repo/pull/42',
      tokenUsage: {
        inputTokens: 1500,
        outputTokens: 350,
        totalTokens: 1850,
      },
      estimatedCost: 0.00456,
    },
  },
  {
    name: 'Scenario 2: Assisted success with guidance (score 0.6)',
    record: {
      id: '550e8400-e29b-41d4-a716-446655440002',
      schemaVersion: '1.0.0',
      originalPrompt:
        'Implement OAuth2 login flow with Google provider',
      modelId: 'claude-opus-4-6',
      modelVersion: 'claude-opus-4-6-20250514',
      score: 0.6,
      scoreBand: 'Assisted Success',
      timeSeconds: 1820,
      timestamp: '2026-02-14T11:00:00Z',
      interventionRequired: true,
      interventionCount: 3,
      interventionDetails: [
        'Corrected the OAuth callback URL configuration',
        'Pointed agent to the correct env var for client secret',
        'Fixed token refresh logic that agent implemented incorrectly',
      ],
      rationale:
        'Agent built the core OAuth flow but required 3 interventions for configuration and token handling. The final result works but needed notable human guidance.',
      issueId: 'HOK-501',
      prUrl: 'https://github.com/org/repo/pull/43',
    },
  },
  {
    name: 'Scenario 3: Partial completion with major gaps (score 0.3)',
    record: {
      id: '550e8400-e29b-41d4-a716-446655440003',
      schemaVersion: '1.0.0',
      originalPrompt:
        'Migrate the database schema from PostgreSQL to support multi-tenant isolation',
      modelId: 'claude-sonnet-4-5',
      modelVersion: 'claude-sonnet-4-5-20250929',
      score: 0.3,
      scoreBand: 'Partial',
      timeSeconds: 3600,
      timestamp: '2026-02-14T12:00:00Z',
      interventionRequired: true,
      interventionCount: 5,
      interventionDetails: [
        'Agent created migration files but with incorrect foreign key constraints',
        'Tenant isolation logic was missing from 3 of 7 tables',
        'Had to manually write the RLS policy definitions',
        'Agent broke existing seed data script',
        'Rollback migration was incomplete',
      ],
      rationale:
        'Agent made partial progress on the migration but left major gaps. The foreign key constraints were wrong, RLS policies were missing, and the rollback path was broken. Significant rework required.',
    },
  },
  {
    name: 'Scenario 4: Complete failure (score 0.0)',
    record: {
      id: '550e8400-e29b-41d4-a716-446655440004',
      schemaVersion: '1.0.0',
      originalPrompt:
        'Implement real-time WebSocket notifications for order status changes',
      modelId: 'claude-haiku-4-5',
      modelVersion: 'claude-haiku-4-5-20251001',
      score: 0.0,
      scoreBand: 'Failure',
      timeSeconds: 900,
      timestamp: '2026-02-14T13:00:00Z',
      interventionRequired: true,
      interventionCount: 0,
      interventionDetails: [],
      rationale:
        'Agent produced no usable output. It repeatedly attempted to install incompatible WebSocket libraries, generated code that did not compile, and failed to address the core requirement. The task had to be restarted from scratch with a different approach.',
      metadata: {
        retryOf: '550e8400-e29b-41d4-a716-446655440000',
        failureCategory: 'no-output',
      },
    },
  },
];

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- Rubric Band Tests ---\n');

test('SCORE_BANDS covers 5 distinct bands', () => {
  assert.equal(SCORE_BANDS.length, 5);
  const labels = SCORE_BANDS.map((b) => b.label);
  assert.deepEqual(labels, [
    'Failure',
    'Partial',
    'Assisted Success',
    'Minor Feedback',
    'Full Success',
  ]);
});

test('Score bands have no overlapping ranges', () => {
  for (let i = 0; i < SCORE_BANDS.length - 1; i++) {
    assert.ok(
      SCORE_BANDS[i].max < SCORE_BANDS[i + 1].min,
      `Band "${SCORE_BANDS[i].label}" max (${SCORE_BANDS[i].max}) must be less than band "${SCORE_BANDS[i + 1].label}" min (${SCORE_BANDS[i + 1].min})`,
    );
  }
});

test('Score bands cover full 0–1 range (endpoints)', () => {
  assert.equal(SCORE_BANDS[0].min, 0.0);
  assert.equal(SCORE_BANDS[SCORE_BANDS.length - 1].max, 1.0);
});

test('getScoreBand maps scores to correct bands', () => {
  assert.equal(getScoreBand(0.0).label, 'Failure');
  assert.equal(getScoreBand(0.1).label, 'Failure');
  assert.equal(getScoreBand(0.2).label, 'Partial');
  assert.equal(getScoreBand(0.3).label, 'Partial');
  assert.equal(getScoreBand(0.4).label, 'Partial');
  assert.equal(getScoreBand(0.5).label, 'Assisted Success');
  assert.equal(getScoreBand(0.6).label, 'Assisted Success');
  assert.equal(getScoreBand(0.7).label, 'Assisted Success');
  assert.equal(getScoreBand(0.8).label, 'Minor Feedback');
  assert.equal(getScoreBand(0.9).label, 'Minor Feedback');
  assert.equal(getScoreBand(1.0).label, 'Full Success');
});

test('getScoreBand handles gap values by rounding to nearest band', () => {
  // 0.18 is between Failure (max 0.1) and Partial (min 0.2) — closer to Partial (0.02 vs 0.08)
  assert.equal(getScoreBand(0.18).label, 'Partial');
  // 0.12 is between Failure (max 0.1) and Partial (min 0.2) — closer to Failure (0.02 vs 0.08)
  assert.equal(getScoreBand(0.12).label, 'Failure');
  // 0.43 is between Partial (max 0.4) and Assisted Success (min 0.5) — closer to Partial
  assert.equal(getScoreBand(0.43).label, 'Partial');
  // 0.73 is between Assisted Success (max 0.7) and Minor Feedback (min 0.8) — closer to Assisted Success
  assert.equal(getScoreBand(0.73).label, 'Assisted Success');
  // 0.93 is between Minor Feedback (max 0.9) and Full Success (min 1.0) — closer to Minor Feedback
  assert.equal(getScoreBand(0.93).label, 'Minor Feedback');
});

test('getScoreBand throws RangeError for out-of-range scores', () => {
  assert.throws(() => getScoreBand(-0.1), RangeError);
  assert.throws(() => getScoreBand(1.1), RangeError);
  assert.throws(() => getScoreBand(-1), RangeError);
  assert.throws(() => getScoreBand(2), RangeError);
});

console.log('\n--- Scenario Validation Tests ---\n');

for (const scenario of scenarios) {
  test(`${scenario.name} — validates against JSON Schema`, () => {
    const result = validateAgainstSchema(
      scenario.record as unknown as Record<string, unknown>,
    );
    assert.ok(
      result.valid,
      `Schema validation failed: ${result.errors.join('; ')}`,
    );
  });

  test(`${scenario.name} — scoreBand matches score`, () => {
    const expectedBand = getScoreBand(scenario.record.score);
    assert.equal(
      scenario.record.scoreBand,
      expectedBand.label,
      `Score ${scenario.record.score} should map to "${expectedBand.label}" but record has "${scenario.record.scoreBand}"`,
    );
  });
}

console.log('\n--- Schema Rejection Tests ---\n');

test('Rejects record missing required field (score)', () => {
  const { score, ...incomplete } = scenarios[0].record;
  const result = validateAgainstSchema(
    incomplete as unknown as Record<string, unknown>,
  );
  assert.ok(!result.valid, 'Should be invalid');
  assert.ok(
    result.errors.some((e) => e.includes('score')),
    'Should mention missing score field',
  );
});

test('Rejects record with invalid scoreBand enum value', () => {
  const bad = { ...scenarios[0].record, scoreBand: 'Amazing' };
  const result = validateAgainstSchema(
    bad as unknown as Record<string, unknown>,
  );
  assert.ok(!result.valid, 'Should be invalid');
  assert.ok(
    result.errors.some((e) => e.includes('scoreBand')),
    'Should mention scoreBand',
  );
});

test('Rejects record with score out of range', () => {
  const bad = { ...scenarios[0].record, score: 1.5 };
  const result = validateAgainstSchema(
    bad as unknown as Record<string, unknown>,
  );
  assert.ok(!result.valid, 'Should be invalid');
  assert.ok(
    result.errors.some((e) => e.includes('score')),
    'Should mention score',
  );
});

test('Rejects record with unexpected additional field', () => {
  const bad = {
    ...scenarios[0].record,
    unexpectedField: 'oops',
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(bad);
  assert.ok(!result.valid, 'Should be invalid');
  assert.ok(
    result.errors.some((e) => e.includes('unexpectedField')),
    'Should mention unexpected field',
  );
});

test('Rejects record with invalid schemaVersion format', () => {
  const bad = { ...scenarios[0].record, schemaVersion: 'v1' };
  const result = validateAgainstSchema(
    bad as unknown as Record<string, unknown>,
  );
  assert.ok(!result.valid, 'Should be invalid');
  assert.ok(
    result.errors.some((e) => e.includes('schemaVersion')),
    'Should mention schemaVersion pattern',
  );
});

console.log('\n--- Cost Field Tests ---\n');

test('Record with tokenUsage and estimatedCost validates', () => {
  const record = {
    ...scenarios[0].record,
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Record without tokenUsage and estimatedCost validates (backward compat)', () => {
  // Scenario 3 has no tokenUsage or estimatedCost
  const record = scenarios[2].record as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('TokenUsage fields are correct types in scenario 1', () => {
  const tu = scenarios[0].record.tokenUsage!;
  assert.equal(typeof tu.inputTokens, 'number');
  assert.equal(typeof tu.outputTokens, 'number');
  assert.equal(typeof tu.totalTokens, 'number');
  assert.equal(tu.totalTokens, tu.inputTokens + tu.outputTokens);
});

console.log('\n--- Workflow Cost Field Tests ---\n');

test('Record with workflowCost validates', () => {
  const record = {
    ...scenarios[0].record,
    workflowCost: 2.5432,
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Record with workflowTokenUsage validates', () => {
  const record = {
    ...scenarios[0].record,
    workflowCost: 3.14,
    workflowTokenUsage: {
      'claude-opus-4-6': {
        inputTokens: 1000,
        cacheCreationTokens: 500,
        cacheReadTokens: 2000,
        outputTokens: 300,
        costUsd: 3.14,
      },
    },
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Record without workflowCost validates (backward compat)', () => {
  const record = scenarios[1].record as unknown as Record<string, unknown>;
  assert.ok(!('workflowCost' in record), 'Scenario 2 should not have workflowCost');
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

// ────────────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────────────

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);

if (failed > 0) {
  process.exit(1);
}
