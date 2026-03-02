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
  {
    name: 'Scenario 5: Medium difficulty with stratum (HOK-777)',
    record: {
      id: '550e8400-e29b-41d4-a716-446655440005',
      schemaVersion: '1.0.0',
      originalPrompt:
        'Add user profile editing feature with form validation',
      modelId: 'claude-opus-4-6',
      modelVersion: 'claude-opus-4-6-20250514',
      score: 0.85,
      scoreBand: 'Minor Feedback',
      timeSeconds: 1200,
      timestamp: '2026-02-14T14:00:00Z',
      interventionRequired: true,
      interventionCount: 1,
      interventionDetails: ['Fixed validation regex pattern'],
      rationale:
        'Agent completed the feature with one minor correction to the validation logic.',
      issueId: 'HOK-777',
      prUrl: 'https://github.com/org/repo/pull/50',
      difficultyBand: 'medium',
      difficultySignals: {
        locTouched: 250,
        filesTouched: 7,
      },
      stratum: 'ts_nextjs_med',
    },
  },
  {
    name: 'Scenario 6: Trivial difficulty (HOK-777)',
    record: {
      id: '550e8400-e29b-41d4-a716-446655440006',
      schemaVersion: '1.0.0',
      originalPrompt: 'Fix typo in documentation',
      modelId: 'claude-haiku-4-5',
      modelVersion: 'claude-haiku-4-5-20251001',
      score: 1.0,
      scoreBand: 'Full Success',
      timeSeconds: 45,
      timestamp: '2026-02-14T15:00:00Z',
      interventionRequired: false,
      interventionCount: 0,
      interventionDetails: [],
      rationale: 'Typo fixed correctly, no issues.',
      issueId: 'HOK-778',
      prUrl: 'https://github.com/org/repo/pull/51',
      difficultyBand: 'trivial',
      difficultySignals: {
        locTouched: 2,
        filesTouched: 1,
      },
      stratum: 'unknown_small',
    },
  },
  {
    name: 'Scenario 7: Router decision with full candidate details (HOK-775)',
    record: {
      id: '550e8400-e29b-41d4-a716-446655440007',
      schemaVersion: '1.0.0',
      originalPrompt: 'Add search filtering to product catalog page',
      modelId: 'claude-sonnet-4-5-20250929',
      modelVersion: 'claude-sonnet-4-5-20250929',
      score: 0.9,
      scoreBand: 'Minor Feedback',
      timeSeconds: 600,
      timestamp: '2026-02-14T16:00:00Z',
      interventionRequired: true,
      interventionCount: 1,
      interventionDetails: ['Adjusted filter UI alignment'],
      rationale: 'Feature implemented correctly with minor UI adjustment needed.',
      issueId: 'HOK-775',
      prUrl: 'https://github.com/org/repo/pull/52',
      routingDecision: {
        candidates: [
          {
            agentType: 'claude',
            modelId: 'claude-haiku-4-5-20251001',
            modelVersion: 'claude-haiku-4-5-20251001',
            priceTier: 'low',
          },
          {
            agentType: 'claude',
            modelId: 'claude-sonnet-4-5-20250929',
            modelVersion: 'claude-sonnet-4-5-20250929',
            priceTier: 'medium',
          },
          {
            agentType: 'claude',
            modelId: 'claude-opus-4-6',
            modelVersion: 'claude-opus-4-6-20250514',
            priceTier: 'high',
          },
        ],
        chosen: 1, // chose sonnet (index 1)
        decisionPolicyVersion: 'router-v1.0',
        decisionRationale:
          'Medium complexity task with UI work. Balanced cost/quality tradeoff. Haiku insufficient for component design, Opus overkill.',
      },
    },
  },
  {
    name: 'Scenario 8: Router decision with chosen as object reference (HOK-775)',
    record: {
      id: '550e8400-e29b-41d4-a716-446655440008',
      schemaVersion: '1.0.0',
      originalPrompt: 'Implement Redis caching layer for API endpoints',
      modelId: 'claude-opus-4-6',
      modelVersion: 'claude-opus-4-6-20250514',
      score: 1.0,
      scoreBand: 'Full Success',
      timeSeconds: 1800,
      timestamp: '2026-02-14T17:00:00Z',
      interventionRequired: false,
      interventionCount: 0,
      interventionDetails: [],
      rationale: 'Complex infrastructure task completed autonomously with proper error handling and cache invalidation.',
      issueId: 'HOK-780',
      prUrl: 'https://github.com/org/repo/pull/53',
      routingDecision: {
        candidates: [
          {
            agentType: 'claude',
            modelId: 'claude-sonnet-4-5-20250929',
            priceTier: 'medium',
          },
          {
            agentType: 'claude',
            modelId: 'claude-opus-4-6',
            priceTier: 'high',
          },
          {
            agentType: 'codex',
            modelId: 'gpt-5.3-codex',
            priceTier: 'medium',
          },
        ],
        chosen: {
          agentType: 'claude',
          modelId: 'claude-opus-4-6',
          modelVersion: 'claude-opus-4-6-20250514',
          priceTier: 'high',
        },
        decisionPolicyVersion: 'router-v1.0',
        decisionRationale:
          'High complexity infrastructure task requiring deep reasoning about distributed systems and edge cases.',
      },
    },
  },
  {
    name: 'Scenario 9: Router decision minimal (no rationale) (HOK-775)',
    record: {
      id: '550e8400-e29b-41d4-a716-446655440009',
      schemaVersion: '1.0.0',
      originalPrompt: 'Update button color in theme config',
      modelId: 'claude-haiku-4-5',
      modelVersion: 'claude-haiku-4-5-20251001',
      score: 1.0,
      scoreBand: 'Full Success',
      timeSeconds: 30,
      timestamp: '2026-02-14T18:00:00Z',
      interventionRequired: false,
      interventionCount: 0,
      interventionDetails: [],
      rationale: 'Simple config change completed correctly.',
      issueId: 'HOK-781',
      prUrl: 'https://github.com/org/repo/pull/54',
      routingDecision: {
        candidates: [
          {
            agentType: 'claude',
            modelId: 'claude-haiku-4-5-20251001',
            priceTier: 'low',
          },
          {
            agentType: 'claude',
            modelId: 'claude-sonnet-4-5-20250929',
            priceTier: 'medium',
          },
        ],
        chosen: 0, // chose haiku (index 0)
        decisionPolicyVersion: 'baseline',
      },
    },
  },
  {
    name: 'Scenario 10: With task and repo context (HOK-774)',
    record: {
      id: '550e8400-e29b-41d4-a716-446655440010',
      schemaVersion: '1.0.0',
      originalPrompt: 'Fix authentication redirect loop on logout',
      modelId: 'claude-sonnet-4-5-20250929',
      modelVersion: 'claude-sonnet-4-5-20250929',
      score: 0.9,
      scoreBand: 'Minor Feedback',
      timeSeconds: 600,
      timestamp: '2026-02-24T15:00:00Z',
      interventionRequired: false,
      interventionCount: 0,
      interventionDetails: [],
      rationale: 'Agent correctly identified and fixed the redirect loop with minimal guidance.',
      issueId: 'HOK-774',
      prUrl: 'https://github.com/org/repo/pull/60',
      taskContext: {
        taskType: 'bugfix',
        changeKind: 'modify_existing',
        complexity: 's',
        filesTouchedEstimate: 2,
        expectedLoCChange: 15,
      },
      repoContext: {
        repoId: 'org/repo',
        repoVisibility: 'private',
        primaryLanguage: 'TypeScript',
        languages: { TypeScript: 75, JavaScript: 25 },
        frameworks: ['Next.js', 'React'],
        buildSystem: 'webpack',
        packageManager: 'npm',
        testFrameworks: ['jest'],
        ciProvider: 'github-actions',
        repoSize: {
          fileCount: 250,
          loc: 15000,
          dependencyCount: 45,
        },
        monorepo: false,
      },
    },
  },
  {
    name: 'Scenario 11: Complex task with constraints (HOK-774)',
    record: {
      id: '550e8400-e29b-41d4-a716-446655440011',
      schemaVersion: '1.0.0',
      originalPrompt: 'Add payment processing with strict PCI compliance',
      modelId: 'claude-opus-4-6',
      modelVersion: 'claude-opus-4-6-20250514',
      score: 0.7,
      scoreBand: 'Assisted Success',
      timeSeconds: 2400,
      timestamp: '2026-02-24T16:00:00Z',
      interventionRequired: true,
      interventionCount: 3,
      interventionDetails: [
        'Fixed PCI compliance issue',
        'Added missing error handling',
        'Updated security headers',
      ],
      rationale: 'Agent implemented the payment flow but required security guidance.',
      issueId: 'HOK-775',
      prUrl: 'https://github.com/org/repo/pull/61',
      taskContext: {
        taskType: 'feature',
        changeKind: 'create_new',
        complexity: 'xl',
        constraints: {
          hasStrictStyle: true,
          mustNotTouchX: false,
          timeboxed: false,
          noNetAccess: false,
        },
        filesTouchedEstimate: 10,
        expectedLoCChange: 500,
        requiresDomainKnowledge: 'payment',
      },
      repoContext: {
        repoId: 'org/repo',
        repoVisibility: 'oss',
        primaryLanguage: 'Python',
        languages: { Python: 90, JavaScript: 10 },
        frameworks: ['Django'],
        packageManager: 'pip',
        testFrameworks: ['pytest'],
        ciProvider: 'github-actions',
        repoSize: {
          fileCount: 500,
          loc: 50000,
          dependencyCount: 120,
        },
        monorepo: false,
      },
      difficultyBand: 'very_hard',
      difficultySignals: {
        locTouched: 520,
        filesTouched: 12,
      },
      stratum: 'py_django_med',
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

console.log('\n--- Workflow Cost Diagnostic Tests (HOK-883) ---\n');

test('Record with workflowCostStatus=success validates', () => {
  const record = {
    ...scenarios[0].record,
    workflowCost: 2.5432,
    workflowCostStatus: 'success',
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Record with workflowCostStatus=no_sessions and diagnostics validates', () => {
  const record = {
    ...scenarios[0].record,
    workflowCostStatus: 'no_sessions',
    workflowCostDiagnostics: {
      reason: 'No session files found in expected location',
      worktreePath: '/Users/test/worktree',
      branchName: 'task/test',
      agentType: 'claude',
      sessionFilesFound: 0,
      matchingTurns: 0,
    },
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Record with workflowCostStatus=skipped validates', () => {
  const record = {
    ...scenarios[0].record,
    workflowCostStatus: 'skipped',
    workflowCostDiagnostics: {
      reason: 'Required parameters missing: worktreePath',
      agentType: 'claude',
    },
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Record without diagnostic fields validates (backward compat)', () => {
  const record = scenarios[0].record as unknown as Record<string, unknown>;
  assert.ok(!('workflowCostStatus' in record), 'Should not have workflowCostStatus');
  assert.ok(!('workflowCostDiagnostics' in record), 'Should not have workflowCostDiagnostics');
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

console.log('\n--- Difficulty Field Tests (HOK-777) ---\n');

test('Record with all difficulty fields validates', () => {
  const record = scenarios[4].record as unknown as Record<string, unknown>; // Scenario 5
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
  assert.ok('difficultyBand' in record);
  assert.ok('difficultySignals' in record);
  assert.ok('stratum' in record);
});

test('Record without difficulty fields validates (backward compat)', () => {
  const record = scenarios[0].record as unknown as Record<string, unknown>;
  assert.ok(!('difficultyBand' in record), 'Scenario 1 should not have difficulty fields');
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Rejects invalid difficultyBand enum value', () => {
  const bad = {
    ...scenarios[4].record,
    difficultyBand: 'super_hard',
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(bad);
  assert.ok(!result.valid, 'Should be invalid');
  assert.ok(
    result.errors.some((e) => e.includes('difficultyBand')),
    'Should mention difficultyBand',
  );
});

test('DifficultySignals with optional fields validates', () => {
  const record = {
    ...scenarios[4].record,
    difficultySignals: {
      locTouched: 250,
      filesTouched: 7,
      dependencyDepth: 3,
      testRuntime: 5.2,
      moduleHotspotScore: 75.5,
    },
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('DifficultySignals structure is correct', () => {
  const record = scenarios[4].record as any;
  assert.ok(record.difficultySignals);
  assert.equal(typeof record.difficultySignals.locTouched, 'number');
  assert.equal(typeof record.difficultySignals.filesTouched, 'number');
  assert.ok(record.difficultySignals.locTouched >= 0);
  assert.ok(record.difficultySignals.filesTouched >= 0);
});

test('Stratum string validates', () => {
  const record = scenarios[4].record as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
  assert.equal((record as any).stratum, 'ts_nextjs_med');
});

test('Trivial difficulty record validates correctly', () => {
  const record = scenarios[5].record as unknown as Record<string, unknown>; // Scenario 6
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
  assert.equal((record as any).difficultyBand, 'trivial');
  assert.equal((record as any).stratum, 'unknown_small');
});

console.log('\n--- Routing Decision Field Tests (HOK-775) ---\n');

test('Record with full routing decision validates', () => {
  const record = scenarios[6].record as unknown as Record<string, unknown>; // Scenario 7
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
  assert.ok('routingDecision' in record);
});

test('Record with routing decision chosen as object validates', () => {
  const record = scenarios[7].record as unknown as Record<string, unknown>; // Scenario 8
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
  const routing = (record as any).routingDecision;
  assert.ok(typeof routing.chosen === 'object');
  assert.ok(routing.chosen.modelId);
});

test('Record with routing decision chosen as index validates', () => {
  const record = scenarios[6].record as unknown as Record<string, unknown>; // Scenario 7
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
  const routing = (record as any).routingDecision;
  assert.equal(typeof routing.chosen, 'number');
  assert.equal(routing.chosen, 1);
});

test('Record with routing decision but no rationale validates', () => {
  const record = scenarios[8].record as unknown as Record<string, unknown>; // Scenario 9
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
  const routing = (record as any).routingDecision;
  assert.ok(!routing.decisionRationale);
});

test('Record without routing decision validates (backward compat)', () => {
  const record = scenarios[0].record as unknown as Record<string, unknown>; // Scenario 1
  assert.ok(!('routingDecision' in record), 'Scenario 1 should not have routingDecision');
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('RoutingDecision structure is correct in scenario 7', () => {
  const record = scenarios[6].record as any;
  assert.ok(record.routingDecision);
  assert.ok(Array.isArray(record.routingDecision.candidates));
  assert.equal(record.routingDecision.candidates.length, 3);
  assert.equal(typeof record.routingDecision.chosen, 'number');
  assert.equal(typeof record.routingDecision.decisionPolicyVersion, 'string');
  assert.equal(typeof record.routingDecision.decisionRationale, 'string');
});

test('RoutingCandidate structure has all expected fields', () => {
  const record = scenarios[6].record as any;
  const candidate = record.routingDecision.candidates[0];
  assert.equal(typeof candidate.agentType, 'string');
  assert.equal(typeof candidate.modelId, 'string');
  assert.equal(typeof candidate.modelVersion, 'string');
  assert.equal(typeof candidate.priceTier, 'string');
});

console.log('\n--- Outcome Decomposition Tests (HOK-776) ---\n');

test('Record with outcomes field validates', () => {
  const record = {
    ...scenarios[0].record,
    outcomes: {
      success: true,
      ci: {
        ran: true,
        passed: true,
        checks: [
          { name: 'test', status: 'success', durationSeconds: 45 },
          { name: 'lint', status: 'success' },
        ],
      },
      tests: {
        added: true,
        passRate: 1.0,
        durationSeconds: 30,
      },
      staticAnalysis: {
        lintDelta: 0,
        typecheckPassed: true,
        securityFindingsDelta: 0,
      },
      review: {
        humanReviewRequired: false,
        rounds: 0,
        approvals: 1,
        changeRequests: 0,
      },
      rework: {
        agentIterations: 2,
        toolFailures: 0,
      },
      delivery: {
        prCreated: true,
        merged: true,
        timeToMergeSeconds: 3600,
      },
    },
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Record without outcomes field validates (backward compat)', () => {
  // Existing scenarios don't have outcomes - should still validate
  const record = scenarios[0].record as unknown as Record<string, unknown>;
  assert.ok(!('outcomes' in record), 'Scenario 1 should not have outcomes');
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Record with minimal outcomes (only required fields) validates', () => {
  const record = {
    ...scenarios[0].record,
    outcomes: {
      success: false,
      review: {
        humanReviewRequired: true,
        rounds: 2,
        approvals: 0,
        changeRequests: 1,
      },
      rework: {
        agentIterations: 5,
      },
      delivery: {
        prCreated: true,
        merged: false,
      },
    },
  } as unknown as Record<string, unknown>;
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
