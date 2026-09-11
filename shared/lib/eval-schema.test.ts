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
  SCHEMA_VERSION,
  type EvalRecord,
  type TokenUsage,
  SCORE_BANDS,
  getScoreBand,
} from './eval-schema.ts';
import {
  buildChallengeExecutionIntent,
  INVALID_CHALLENGE_REASONS,
  isStageAttributionEligibleForCoverage,
  isStageAttributionEligibleForTraining,
  STAGE_ATTRIBUTION_REASON_CODES,
} from './challenge-execution-contract.ts';

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

/** Resolve a `$ref` against the loaded schema (supports `#/$defs/Name`). */
function resolveRef(ref: string): Record<string, unknown> | null {
  if (!ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let node: unknown = schema;
  for (const part of parts) {
    if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  return (node && typeof node === 'object') ? (node as Record<string, unknown>) : null;
}

/** Validate a value against a schema node; pushes errors with dotted paths. */
function validateNode(
  value: unknown,
  schemaNode: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (Array.isArray(schemaNode.anyOf)) {
    const branchErrors = schemaNode.anyOf.map((branch) => {
      const nestedErrors: string[] = [];
      validateNode(value, branch as Record<string, unknown>, path, nestedErrors);
      return nestedErrors;
    });
    if (branchErrors.every((items) => items.length > 0)) {
      errors.push(...branchErrors[0]);
    }
    return;
  }

  if (typeof schemaNode.$ref === 'string') {
    const resolved = resolveRef(schemaNode.$ref);
    if (resolved) {
      validateNode(value, resolved, path, errors);
      return;
    }
  }

  const expectedType = schemaNode.type as string | string[] | undefined;
  const expectedTypes = Array.isArray(expectedType) ? expectedType : expectedType ? [expectedType] : [];
  const matchesExpectedType = expectedTypes.length === 0 || expectedTypes.some((type) => {
    if (type === 'null') return value === null;
    if (type === 'string') return typeof value === 'string';
    if (type === 'number') return typeof value === 'number';
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (type === 'boolean') return typeof value === 'boolean';
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
    return false;
  });

  if (!matchesExpectedType && expectedTypes.length > 0) {
    errors.push(`${path}: expected ${expectedTypes.join(' or ')}, got ${value === null ? 'null' : typeof value}`);
    return;
  }

  if (expectedTypes.includes('integer')) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      errors.push(`${path}: expected integer, got ${value}`);
    }
  }

  if (typeof value === 'number') {
    if (schemaNode.minimum !== undefined && value < (schemaNode.minimum as number)) {
      errors.push(`${path}: ${value} < minimum ${schemaNode.minimum}`);
    }
    if (schemaNode.maximum !== undefined && value > (schemaNode.maximum as number)) {
      errors.push(`${path}: ${value} > maximum ${schemaNode.maximum}`);
    }
  }

  if (schemaNode.const !== undefined && value !== schemaNode.const) {
    errors.push(`${path}: "${value}" does not match const "${schemaNode.const}"`);
  }

  if (schemaNode.enum && !(schemaNode.enum as unknown[]).includes(value)) {
    errors.push(
      `${path}: "${value}" not in enum [${(schemaNode.enum as string[]).join(', ')}]`,
    );
  }

  if (schemaNode.pattern && typeof value === 'string') {
    if (!new RegExp(schemaNode.pattern as string).test(value)) {
      errors.push(`${path}: "${value}" does not match pattern ${schemaNode.pattern}`);
    }
  }

  if (expectedTypes.includes('array') && Array.isArray(value) && schemaNode.items) {
    const itemSchema = schemaNode.items as Record<string, unknown>;
    value.forEach((item, index) => {
      validateNode(item, itemSchema, `${path}[${index}]`, errors);
    });
  }

  if (
    expectedTypes.includes('object') &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const obj = value as Record<string, unknown>;
    const nestedProps = (schemaNode.properties || {}) as Record<string, Record<string, unknown>>;
    const required = (schemaNode.required as string[] | undefined) || [];

    for (const field of required) {
      if (!(field in obj)) {
        errors.push(`${path}.${field}: missing required field`);
      }
    }

    if (schemaNode.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in nestedProps)) {
          errors.push(`${path}.${key}: unexpected field`);
        }
      }
    }

    for (const [key, prop] of Object.entries(nestedProps)) {
      if (!(key in obj)) continue;
      validateNode(obj[key], prop, `${path}.${key}`, errors);
    }
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
    validateNode(record[key], prop, key, errors);
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
      challengePairId: 'HOK-500',
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

console.log('\n--- Prompt Size Diagnostic Field Tests (HOK-1706) ---\n');

function validPromptSizeDiagnostic() {
  return {
    totalBytes: 1200,
    limitBytes: 9437184,
    perComponentBytes: {
      taskPrompt: 100,
      prReviewOutput: 200,
      interventionMetadata: 50,
      taskPacket: 150,
      planContent: 120,
      selfReviewSummary: 80,
      templateScaffold: 500,
    },
    policy: 'fail',
    action: 'pass',
  };
}

test('SCHEMA_VERSION is bumped for eval schema updates', () => {
  assert.equal(SCHEMA_VERSION, '1.47.0');
});

test('directReviewEvidence validates while prior challenge fields remain additive', () => {
  const record: EvalRecord = {
    ...scenarios[0].record,
    schemaVersion: '1.47.0',
    directReviewEvidence: {
      schemaVersion: '1.0.0',
      evidenceMode: 'direct',
      findingCount: 2,
      blockingFindings: 0,
      dismissedFindings: 1,
      passedIterations: 1,
      executedIdentities: {
        orchestrator: { requested: 'glm-5.3', resolved: 'gpt-5.5', status: 'fallback' },
        analysis: { requested: 'glm-5.3', resolved: 'glm-5.3', status: 'pinned' },
        remediation: null,
      },
      contentDigest: 'a'.repeat(64),
    },
    deliveryVerdict: {
      outcome: 'primary',
      source: 'final-pr-arbiter',
    },
    reviewExecutedIdentity: validReviewIdentitySet(),
  };

  const result = validateAgainstSchema(record as unknown as Record<string, unknown>);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

function validReviewIdentitySet() {
  return {
    orchestrator: {
      role: 'review_orchestrator',
      requestedModel: 'claude-opus-4-6',
      resolvedModel: 'claude-opus-4-6',
      source: 'route',
      pinned: true,
    },
    substantiveAnalysis: {
      role: 'substantive_analysis',
      requestedModel: 'claude-opus-4-6',
      resolvedModel: 'claude-opus-4-6',
      source: 'artifact',
      pinned: true,
    },
    remediation: {
      role: 'remediation',
      requestedModel: 'gpt-5.4',
      resolvedModel: 'gpt-5.4',
      source: 'artifact',
      pinned: true,
    },
  };
}

function validForkIdentity() {
  return {
    stage: 'review',
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    taskPacketHash: 'c'.repeat(64),
    planHash: 'd'.repeat(64),
    promptHash: 'e'.repeat(64),
    toolConfigHash: 'f'.repeat(64),
    sharedPrefix: true,
    primaryInheritedStages: ['plan'],
    challengerInheritedStages: ['plan'],
    producer: 'challenge.fork/v1',
    producerVersion: '1.0.0',
  };
}

test('Challenge validity contract fields validate and remain optional', () => {
  const current = {
    ...scenarios[0].record,
    schemaVersion: SCHEMA_VERSION,
    deliveryVerdict: {
      outcome: 'primary',
      prUrl: 'https://github.com/org/repo/pull/42',
      primaryMerged: true,
      source: 'final-pr-arbiter',
      rationale: 'Primary PR was accepted.',
    },
    stageAttribution: {
      status: 'valid',
      outcome: 'primary',
      stage: 'review',
      reasonCodes: [],
      winningStageModel: 'claude-opus-4-6',
      losingStageModel: 'gpt-5.4',
      evidenceProvenance: 'direct',
      decidedAt: '2026-09-10T12:00:00Z',
      producer: 'reviewer-stage-adjudicator/v1',
    },
    forkIdentity: validForkIdentity(),
    reviewExecutedIdentity: validReviewIdentitySet(),
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(current);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);

  const legacy = { ...current };
  delete legacy.deliveryVerdict;
  delete legacy.stageAttribution;
  delete legacy.forkIdentity;
  delete legacy.reviewExecutedIdentity;
  const legacyResult = validateAgainstSchema(legacy);
  assert.ok(legacyResult.valid, `Legacy record should validate: ${legacyResult.errors.join('; ')}`);
});

test('Challenge validity contract enum definitions match TypeScript constants', () => {
  assert.deepEqual(
    [...STAGE_ATTRIBUTION_REASON_CODES].sort(),
    [...(schema.$defs.StageAttributionReasonCode.enum as string[])].sort(),
  );
  assert.deepEqual(
    [...INVALID_CHALLENGE_REASONS].sort(),
    [...(schema.$defs.InvalidChallengeReason.enum as string[])].sort(),
  );
  assert.deepEqual(schema.$defs.DeliveryVerdictOutcome.enum, ['primary', 'challenger', 'tie', null]);
  assert.deepEqual(schema.$defs.StageAttributionStatus.enum, ['valid', 'invalid', 'insufficient_evidence']);
  assert.deepEqual(schema.$defs.StageAttributionOutcome.enum, ['primary', 'challenger', 'tie', null]);
  assert.deepEqual(schema.$defs.ExecutedIdentityRole.enum, [
    'review_orchestrator',
    'substantive_analysis',
    'remediation',
  ]);
  for (const reason of INVALID_CHALLENGE_REASONS) {
    assert.ok(STAGE_ATTRIBUTION_REASON_CODES.includes(reason));
  }
});

test('Stage attribution eligibility fails closed for invalid or insufficient evidence', () => {
  const valid = {
    status: 'valid',
    outcome: 'primary',
    stage: 'review',
    reasonCodes: [],
    evidenceProvenance: 'direct',
  } as const;
  assert.equal(isStageAttributionEligibleForCoverage(undefined), false);
  assert.equal(isStageAttributionEligibleForTraining(undefined), false);
  assert.equal(isStageAttributionEligibleForCoverage(valid), true);
  assert.equal(isStageAttributionEligibleForTraining(valid), true);
  assert.equal(isStageAttributionEligibleForCoverage({ ...valid, outcome: null }), false);
  assert.equal(isStageAttributionEligibleForTraining({ ...valid, evidenceProvenance: 'inferred' }), false);
  assert.equal(isStageAttributionEligibleForCoverage({
    status: 'invalid',
    outcome: null,
    stage: 'review',
    reasonCodes: ['plan_hash_mismatch'],
    evidenceProvenance: 'direct',
    divergentInputsSuppressedDirectEvidence: true,
  }), false);
  assert.equal(isStageAttributionEligibleForCoverage({
    status: 'insufficient_evidence',
    outcome: null,
    stage: 'review',
    reasonCodes: ['missing_direct_review_evidence'],
    evidenceProvenance: 'insufficient',
  }), false);
});

test('Delivery verdict remains usable when stage attribution is invalid', () => {
  const record = {
    ...scenarios[0].record,
    deliveryVerdict: {
      outcome: 'primary',
      source: 'final-pr-arbiter',
      prUrl: 'https://github.com/org/repo/pull/42',
    },
    stageAttribution: {
      status: 'invalid',
      outcome: null,
      stage: 'review',
      reasonCodes: ['plan_hash_mismatch', 'divergent_pre_stage_inputs'],
      evidenceProvenance: 'direct',
      divergentInputsSuppressedDirectEvidence: true,
    },
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
  assert.equal((record.deliveryVerdict as { outcome: string }).outcome, 'primary');
  assert.equal(isStageAttributionEligibleForTraining(record.stageAttribution as never), false);
});

test('ChallengeComparison contract fields round-trip through JSON', () => {
  const comparison = {
    challengePairId: 'pair-2968',
    primaryModel: 'claude-opus-4-6',
    challengerModel: 'gpt-5.4',
    primaryPrUrl: 'https://github.com/org/repo/pull/1',
    challengerPrUrl: 'https://github.com/org/repo/pull/2',
    primaryEvalScore: 0.9,
    challengerEvalScore: 0.8,
    rationale: 'Primary delivered the accepted PR.',
    dimensions: {
      completeness: { primary: 1, challenger: 0.8 },
      correctness: { primary: 1, challenger: 0.8 },
      code_quality: { primary: 0.9, challenger: 0.8 },
      intervention_impact: { primary: 1, challenger: 1 },
      autonomy: { primary: 1, challenger: 1 },
    },
    timestamp: '2026-09-10T12:00:00Z',
    deliveryVerdict: {
      outcome: 'primary',
      source: 'derived-from-comparison',
      prUrl: 'https://github.com/org/repo/pull/1',
    },
    stageAttribution: {
      status: 'valid',
      outcome: 'primary',
      stage: 'review',
      reasonCodes: [],
      evidenceProvenance: 'direct',
    },
    forkIdentity: validForkIdentity(),
    primaryReviewExecutedIdentity: validReviewIdentitySet(),
    challengerReviewExecutedIdentity: validReviewIdentitySet(),
  };
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(comparison))), JSON.stringify(comparison));
});

test('evaluatedPrHeadSha validates and remains optional for historical rows', () => {
  const current = {
    ...scenarios[0].record,
    evaluatedPrHeadSha: 'a'.repeat(40),
  } as unknown as Record<string, unknown>;
  assert.ok(validateAgainstSchema(current).valid);
  const legacy = { ...current };
  delete legacy.evaluatedPrHeadSha;
  assert.ok(validateAgainstSchema(legacy).valid);
});

test('Record with harnessId validates and legacy records without it still validate', () => {
  const legacyResult = validateAgainstSchema(scenarios[0].record as unknown as Record<string, unknown>);
  assert.ok(legacyResult.valid, `Legacy record should validate: ${legacyResult.errors.join('; ')}`);

  const record = {
    ...scenarios[0].record,
    harnessId: 'a'.repeat(64),
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Rejects malformed harnessId', () => {
  const record = {
    ...scenarios[0].record,
    harnessId: 'not-a-hash',
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(!result.valid, 'Should be invalid');
});

test('Record with top-level challengeStage validates', () => {
  const record = {
    ...scenarios[0].record,
    challengeStage: 'plan',
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Record with unrecoverable top-level challengeStage validates', () => {
  const record = {
    ...scenarios[0].record,
    challengeStage: 'unrecoverable',
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Rejects invalid top-level challengeStage', () => {
  const record = {
    ...scenarios[0].record,
    challengeStage: 'coding',
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(!result.valid, 'Should be invalid');
  assert.ok(result.errors.some((error) => error.includes('challengeStage')));
});

test('missing_challenge_stage eligibility error validates', () => {
  const record = {
    ...scenarios[0].record,
    eligibilityErrors: ['missing_challenge_stage'],
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Record with native workflow cost attribution validates', () => {
  const record = {
    ...scenarios[0].record,
    workflowCost: 0,
    workflowCostStatus: 'success',
    workflowCostAttribution: {
      source: 'native',
      coverage: 'unavailable',
      reason: 'missing_token_usage',
      sessions: 1,
      turns: 1,
      pricedSessions: 0,
      unpricedSessions: 1,
      models: [{
        provider: 'pi',
        modelId: 'native-model',
        priced: false,
        reason: 'missing_token_usage',
      }],
    },
  } as unknown as Record<string, unknown>;

  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Record with codex workflow cost attribution validates', () => {
  const record = {
    ...scenarios[0].record,
    workflowCost: 0,
    workflowCostStatus: 'success',
    workflowCostAttribution: {
      source: 'codex',
      coverage: 'partial',
      reason: 'unpriced_model',
      sessions: 1,
      turns: 1,
      pricedSessions: 0,
      unpricedSessions: 1,
      models: [{
        provider: 'codex',
        modelId: 'gpt-5.5',
        priced: false,
        reason: 'unpriced_model',
        pricingSource: 'local_estimate',
      }],
    },
  } as unknown as Record<string, unknown>;

  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Challenge execution contract fields validate as emitted', () => {
  const intent = buildChallengeExecutionIntent({
    pairId: 'pair-schema',
    challengeStage: 'implementation',
    primary: {
      model: 'claude-opus-4-6',
      planner: 'claude-opus-4-6',
      reviewer: 'claude-opus-4-6',
      planDepth: 'standard',
      codeDepth: 'standard',
      reviewMode: 'standard',
    },
    challenger: {
      model: 'gpt-5.4',
      planner: 'claude-opus-4-6',
      reviewer: 'claude-opus-4-6',
      planDepth: 'standard',
      codeDepth: 'deep',
      reviewMode: 'standard',
    },
    routeContext: { source: 'unit-test' },
    selectionReason: 'schema parity',
  });
  const record: EvalRecord = {
    ...scenarios[0].record,
    schemaVersion: '1.34.0',
    challengePairId: 'pair-schema',
    challengeSide: 'challenger',
    challengeIntent: intent,
    challengeExecutionRoute: intent.challenger.expectedRoute,
    challengeExecutionEvidence: {
      pairId: 'pair-schema',
      side: 'challenger',
      validity: 'valid',
      challengeStage: 'implementation',
      expectedStageModel: 'gpt-5.4',
      effectiveRoute: intent.challenger.expectedRoute,
      evidence: [
        {
          stage: 'implementation',
          model: 'gpt-5.4',
          source: 'eval.modelId',
        },
      ],
    },
  };

  const result = validateAgainstSchema(record as unknown as Record<string, unknown>);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Invalid challenge markers validate without requiring challenge execution fields', () => {
  const record: EvalRecord = {
    ...scenarios[0].record,
    schemaVersion: '1.34.0',
    challengePairId: 'pair-schema',
    challengeDivergenceReason: 'state_vs_derived_side_mismatch',
    invalidChallenge: true,
  };

  const result = validateAgainstSchema(record as unknown as Record<string, unknown>);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Record without prompt size fields still validates', () => {
  const record = scenarios[0].record as unknown as Record<string, unknown>;
  assert.ok(!('failureReason' in record));
  assert.ok(!('promptSizeDiagnostic' in record));
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Record with eval_prompt_too_large failureReason validates', () => {
  const record = {
    ...scenarios[0].record,
    failureReason: 'eval_prompt_too_large',
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Record with pr_diff_unavailable failureReason validates', () => {
  const record = {
    ...scenarios[0].record,
    failureReason: 'pr_diff_unavailable',
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Record with promptSizeDiagnostic validates', () => {
  const record = {
    ...scenarios[0].record,
    promptSizeDiagnostic: {
      ...validPromptSizeDiagnostic(),
      policy: 'truncate',
      action: 'truncated',
      truncatedComponents: [
        {
          name: 'prReviewOutput',
          originalBytes: 5000,
          finalBytes: 1000,
          removedBytes: 4000,
        },
      ],
    },
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Rejects invalid failureReason', () => {
  const bad = {
    ...scenarios[0].record,
    failureReason: 'eval_not_persisted',
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(bad);
  assert.ok(!result.valid, 'Should be invalid');
  assert.ok(result.errors.some((e) => e.includes('failureReason')));
});

test('Rejects malformed promptSizeDiagnostic', () => {
  const bad = {
    ...scenarios[0].record,
    promptSizeDiagnostic: {
      ...validPromptSizeDiagnostic(),
      totalBytes: -1,
      action: 'compressed',
    },
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(bad);
  assert.ok(!result.valid, 'Should be invalid');
  assert.ok(result.errors.some((e) => e.includes('promptSizeDiagnostic')));
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

test('Record with structured router metadata validates', () => {
  const record = structuredClone(scenarios[6].record) as any;
  record.routingDecision.routeMode = 'stage-aware';
  record.routingDecision.routeArtifactSchemaVersion = '1.0';
  record.routingDecision.policyResolverVersion = '1.0.0';
  record.routingDecision.operatingModeDependency = 'survival';

  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Record without routing decision validates (backward compat)', () => {
  const record = scenarios[0].record as unknown as Record<string, unknown>; // Scenario 1
  assert.ok(!('routingDecision' in record), 'Scenario 1 should not have routingDecision');
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Record with challengePairId validates', () => {
  const record = scenarios[0].record as unknown as Record<string, unknown>;
  assert.equal((record as any).challengePairId, 'HOK-500');
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Record with attempted_model and model_alias validates', () => {
  const record = {
    ...scenarios[0].record,
    attempted_model: 'qwen/qwen3-coder',
    model_alias: 'qwen-3-coder',
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Rejects attempted_model with the wrong type', () => {
  const record = {
    ...scenarios[0].record,
    attempted_model: 42,
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(!result.valid, 'Should be invalid');
  assert.ok(result.errors.some((e) => e.includes('attempted_model')));
});

test('Record with challengeStageEval validates', () => {
  const record = structuredClone(scenarios[0].record) as Record<string, unknown> & { challengeStageEval?: unknown };
  record.challengeStageEval = {
    stage: 'review',
    provenance: 'direct',
    summary: 'Direct review evidence captured from self-review output and review result artifacts.',
    evidence: [
      {
        label: 'self_review_summary',
        summary: 'Raised one blocker and two warnings.',
        source: 'review-log',
      },
    ],
  };
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

test('Record with negative CI durationSeconds fails schema', () => {
  const record = {
    ...scenarios[0].record,
    outcomes: {
      success: true,
      ci: {
        ran: true,
        passed: false,
        checks: [
          { name: 'build', status: 'pending', durationSeconds: -1 },
        ],
      },
    },
  } as unknown as Record<string, unknown>;

  const result = validateAgainstSchema(record);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((error) => error.includes('outcomes.ci.checks[0].durationSeconds')),
    `Expected durationSeconds schema error, got: ${result.errors.join('; ')}`,
  );
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

test('Record with fallbackEvent validates and round-trips through JSON serialization', () => {
  const record: EvalRecord = {
    ...scenarios[0].record,
    schemaVersion: '1.9.0',
    fallbackEvent: {
      schema_version: '1.0',
      preferred_model: 'model-a',
      fallback_model: 'model-b',
      task_type: 'coding',
      difficulty: 'hard',
      quota_snapshot: {
        snapshotAt: '2026-04-18T12:00:00Z',
        models: {
          'model-a': {
            status: 'exhausted',
            resetAt: null,
            remainingEstimate: null,
            confidence: 0.9,
          },
        },
      },
      human_intervention: false,
      outcome: 'success',
      latency_ms: 3210,
      cost_usd: 0.45,
      fallback_chain: [{ model: 'model-a', reason: 'quota' }],
    },
  };

  const serialized = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  const result = validateAgainstSchema(serialized);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
  assert.deepEqual(serialized, record);
});

test('Record without fallbackEvent still validates and parses unchanged', () => {
  const record = JSON.parse(JSON.stringify(scenarios[0].record)) as Record<string, unknown>;
  assert.ok(!('fallbackEvent' in record));
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('TaskDescriptor constraints accept capability_constraints', () => {
  const record = {
    ...scenarios[0].record,
    taskDescriptor: {
      schema_version: '1.0',
      signals: {
        heuristic: {
          task_type: 'feature',
          languages: ['typescript'],
          framework_tags: [],
          files_touched: 3,
          repo_size_loc: 1000,
          description_tokens: 120,
          is_greenfield: false,
          has_migration: false,
          has_ui: false,
          has_tests: true,
          cross_service: false,
        },
        learned: {
          complexity: 3,
          domain: 'backend',
          risk_flags: [],
        },
      },
      constraints: {
        models_available: ['gpt-5.3-codex'],
        objective: 'balanced',
        capability_constraints: {
          minContextWindow: 200000,
          requiresTools: true,
          maxLatencyTier: 'standard',
        },
      },
      stages: {},
    },
  } as unknown as Record<string, unknown>;

  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

console.log('\n--- RubricEval Field Tests (HOK-1406) ---\n');

const validRubricEval = {
  schema_version: '1.0',
  rubric_version: '1.0',
  criteria: {
    completeness: { score: 0.9, rationale: 'All requirements addressed.' },
    correctness: { score: 0.95, rationale: 'No bugs found in PR review.' },
    code_quality: { score: 0.85, rationale: 'Clean and idiomatic code.' },
    intervention_impact: { score: 0.7, rationale: 'One functional fix required.' },
    autonomy: { score: 0.75, rationale: 'Core work autonomous, one directional note.' },
  },
  determinative_boundary: 'functional_bug',
};

test('Record with valid rubricEval validates (HOK-1406)', () => {
  const record = {
    ...scenarios[0].record,
    schemaVersion: '1.10.0',
    rubricEval: validRubricEval,
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Record without rubricEval still validates (backward compat, HOK-1406)', () => {
  const record = scenarios[0].record as unknown as Record<string, unknown>;
  assert.ok(!('rubricEval' in record), 'Scenario 1 should not have rubricEval');
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('rubricEval structure has all expected criteria keys', () => {
  const re = validRubricEval;
  assert.equal(re.schema_version, '1.0');
  assert.equal(re.rubric_version, '1.0');
  const criteriaKeys = ['completeness', 'correctness', 'code_quality', 'intervention_impact', 'autonomy'];
  for (const key of criteriaKeys) {
    assert.ok(key in re.criteria, `Missing criterion: ${key}`);
    assert.equal(typeof (re.criteria as any)[key].score, 'number');
    assert.equal(typeof (re.criteria as any)[key].rationale, 'string');
  }
});

test('rubricEval determinative_boundary can be omitted (optional field)', () => {
  const record = {
    ...scenarios[0].record,
    schemaVersion: '1.10.0',
    rubricEval: {
      schema_version: '1.0',
      rubric_version: '1.0',
      criteria: validRubricEval.criteria,
      // no determinative_boundary
    },
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('rubricEval round-trips through JSON serialization', () => {
  const record: EvalRecord = {
    ...scenarios[0].record,
    schemaVersion: '1.10.0',
    rubricEval: validRubricEval as import('./eval-schema.ts').RubricEval,
  };
  const serialized = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  const result = validateAgainstSchema(serialized);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
  assert.deepEqual((serialized as any).rubricEval, validRubricEval);
});

test('Rejects rubricEval with invalid determinative_boundary enum value', () => {
  const bad = {
    ...scenarios[0].record,
    schemaVersion: '1.10.0',
    rubricEval: {
      schema_version: '1.0',
      rubric_version: '1.0',
      criteria: validRubricEval.criteria,
      determinative_boundary: 'invalid_boundary',
    },
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(bad);
  assert.ok(!result.valid, 'Should be invalid');
  assert.ok(
    result.errors.some((e) => e.includes('determinative_boundary')),
    'Should mention determinative_boundary in error',
  );
});

console.log('\n--- StageOutcomes RubricCriteria Tests (HOK-1407) ---\n');

test('Record with stageOutcomes including rubricCriteria validates', () => {
  const record = {
    ...scenarios[0].record,
    schemaVersion: '1.11.0',
    stageOutcomes: {
      expansion: {
        score: 0.9,
        rationale: 'Expansion covered requirements and validation.',
        rubricCriteria: [
          {
            criterion: 'requirement_coverage',
            score: 0.92,
            notes: 'All core requirements were identified.',
          },
          {
            criterion: 'validation_readiness',
            score: 0.86,
          },
        ],
      },
      plan: {
        score: 0.84,
        rationale: 'Plan covered component boundaries.',
        planCritique: {
          component_boundaries: {
            score: 0.9,
            rationale: 'The right modules were named.',
          },
        },
      },
    },
  } as unknown as Record<string, unknown>;

  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Old record without stageOutcomes still validates (backward compat, HOK-1407)', () => {
  const record = scenarios[0].record as unknown as Record<string, unknown>;
  assert.ok(!('stageOutcomes' in record), 'Scenario 1 should not have stageOutcomes');
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

console.log('\n--- Rubric Provenance Tests (HOK-1408) ---\n');

test('Record with valid rubric_provenance validates and round-trips', () => {
  const record: EvalRecord = {
    ...scenarios[0].record,
    schemaVersion: '1.12.0',
    rubric_provenance: 'judge',
    rubricEval: validRubricEval as import('./eval-schema.ts').RubricEval,
  };
  const serialized = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  const result = validateAgainstSchema(serialized);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
  assert.equal((serialized as any).rubric_provenance, 'judge');
});

test('Record with legacy_absent rubric_provenance validates without rubricEval', () => {
  const record = {
    ...scenarios[0].record,
    schemaVersion: '1.12.0',
    rubric_provenance: 'legacy_absent',
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Rejects rubric_provenance with invalid enum value', () => {
  const bad = {
    ...scenarios[0].record,
    schemaVersion: '1.12.0',
    rubric_provenance: 'unknown_source',
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(bad);
  assert.ok(!result.valid, 'Should be invalid');
  assert.ok(
    result.errors.some((e) => e.includes('rubric_provenance')),
    'Should mention rubric_provenance in error',
  );
});

test('Record with provider metadata validates', () => {
  const record = {
    ...scenarios[0].record,
    schemaVersion: '1.14.0',
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com/anthropic',
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Eligibility fields validate and schema stays in parity', () => {
  const record: EvalRecord = {
    ...scenarios[0].record,
    schemaVersion: '1.14.0',
    trainingEligible: false,
    budgetEvalEligible: true,
    budgetEvalEligibilityError: 'missing_budget',
    eligibilityErrors: ['missing_budget', 'missing_model_identity', 'missing_routing'],
  };

  const result = validateAgainstSchema(record as unknown as Record<string, unknown>);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);

  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.trainingEligible?.type, 'boolean');
  assert.equal(properties.budgetEvalEligible?.type, 'boolean');
  assert.equal(properties.budgetEvalEligibilityError?.type, 'string');
  assert.deepEqual(properties.eligibilityErrors?.items?.enum, [
    'missing_routing',
    'missing_cost',
    'missing_budget',
    'missing_budget_snapshot',
    'missing_outcome',
    'missing_task_descriptor',
    'missing_model_identity',
    'missing_feature_outcome',
    'invalid_feature_outcome',
    'failed_feature_outcome',
    'missing_challenge_stage',
    'eval_fast_failed',
    'provisional_model_identity',
  ]);
  assert.equal(properties.enrichmentDiagnostics?.type, 'array');
  assert.equal(properties.enrichmentDiagnostics?.items?.type, 'string');
});

test('challengeRouteContext remains optional for legacy records', () => {
  const record = scenarios[0].record as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('challengeRouteContext validates when present', () => {
  const record: EvalRecord = {
    ...scenarios[0].record,
    schemaVersion: '1.16.0',
    challengeRouteContext: {
      decisionSource: 'expanded',
      bootstrapRoute: {
        coder: 'claude-sonnet-5',
        codeDepth: 'medium',
        reviewer: 'claude-opus-4-6',
        reviewMode: 'llm',
        harnessId: 'a'.repeat(64),
      },
      expandedRoute: {
        coder: 'gpt-5.4',
        codeDepth: 'deep',
        reviewer: 'claude-opus-4-6',
        reviewMode: 'static',
      },
      refreshRationale: 'expanded route changed coder class',
    },
  };

  const result = validateAgainstSchema(record as unknown as Record<string, unknown>);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);

  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.challengeRouteContext?.type, 'object');
});

test('routeProvenance remains optional for legacy records', () => {
  const record = scenarios[0].record as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('routeProvenance validates when present', () => {
  const record: EvalRecord = {
    ...scenarios[0].record,
    schemaVersion: '1.18.0',
    routeProvenance: {
      decisionSource: 'expanded',
      bootstrapRoute: {
        coder: 'claude-sonnet-5',
        codeDepth: 'medium',
        reviewer: 'claude-opus-4-6',
        reviewMode: 'llm',
      },
      expandedRoute: {
        coder: 'gpt-5.4',
        codeDepth: 'deep',
        reviewer: 'claude-sonnet-5',
        reviewMode: 'static',
      },
      activeRoute: {
        coder: 'gpt-5.4',
        codeDepth: 'deep',
        reviewer: 'claude-sonnet-5',
        reviewMode: 'static',
      },
      routeChanged: true,
      expandedCacheHit: true,
      packetHash: 'a'.repeat(64),
      routeSource: 'cache',
    },
  };

  const result = validateAgainstSchema(record as unknown as Record<string, unknown>);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);

  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.routeProvenance?.type, 'object');
});

test('routeProvenance with full route artifact fields validates', () => {
  const record: EvalRecord = {
    ...scenarios[0].record,
    schemaVersion: SCHEMA_VERSION,
    routeProvenance: {
      decisionSource: 'expanded',
      bootstrapRoute: {
        coder: 'claude-sonnet-5',
        codeDepth: 'medium',
        reviewer: 'claude-opus-4-6',
        reviewMode: 'llm',
        harnessId: 'b'.repeat(64),
        planner: 'claude-sonnet-5',
        planDepth: 'deep',
        artifactPath: 'features/HOK-2071/.initial-route.json',
        artifactHash: 'a'.repeat(64),
        inputHash: 'b'.repeat(64),
        source: 'bootstrap',
        cacheHit: false,
        routeSource: 'batch',
        routerMode: 'normal',
        routingMode: 'stage-aware',
        expectedMetrics: {
          expectedSuccess: 0.93,
          expectedCostUsd: 0.41,
        },
      },
      expandedRoute: {
        coder: 'gpt-5.4',
        codeDepth: 'deep',
        reviewer: 'claude-sonnet-5',
        reviewMode: 'static',
        planner: 'gpt-5.4',
        planDepth: 'deep',
        artifactPath: 'features/HOK-2071/.post-expansion-route.json',
        artifactHash: 'c'.repeat(64),
        inputHash: 'd'.repeat(64),
        source: 'expanded',
        cacheHit: true,
        routeSource: 'cache',
        routerMode: 'survival',
        routingMode: 'stage-aware',
        expectedMetrics: {
          expectedSuccess: 0.97,
          expectedCostUsd: 0.55,
        },
      },
      activeRoute: {
        coder: 'gpt-5.4',
        codeDepth: 'deep',
        reviewer: 'claude-sonnet-5',
        reviewMode: 'static',
        planner: 'gpt-5.4',
        planDepth: 'deep',
        artifactPath: 'features/HOK-2071/.routing-complete.json',
        artifactHash: 'e'.repeat(64),
        inputHash: 'f'.repeat(64),
        source: 'active',
        cacheHit: true,
        routeSource: 'single',
        routerMode: 'constrained',
        routingMode: 'stage-aware',
        expectedMetrics: {
          expectedSuccess: 0.95,
          expectedCostUsd: 0.48,
        },
      },
      routeChanged: true,
      expandedCacheHit: true,
      packetHash: '1'.repeat(64),
      routeSource: 'cache',
      routerMode: 'survival',
      routingMode: 'stage-aware',
      artifactPath: 'features/HOK-2071',
      artifactHash: '2'.repeat(64),
    },
  };

  const result = validateAgainstSchema(record as unknown as Record<string, unknown>);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('executedPlanning remains optional for legacy records', () => {
  const record = scenarios[0].record as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('executedPlanning validates when present', () => {
  const record: EvalRecord = {
    ...scenarios[0].record,
    schemaVersion: '1.25.0',
    executedPlanning: {
      agent: 'codex',
      model: 'claude-sonnet-5',
      status: 'completed',
      source: '.planning-result.json',
    },
  };

  const result = validateAgainstSchema(record as unknown as Record<string, unknown>);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);

  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.executedPlanning?.type, 'object');
});

test('planningExecutionOutcome remains optional for legacy records', () => {
  const record = scenarios[0].record as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('planningExecutionOutcome validates when present', () => {
  const record: EvalRecord = {
    ...scenarios[0].record,
    schemaVersion: '1.36.0',
    planningExecutionOutcome: {
      agent: 'native',
      model: 'moonshotai/kimi-k2.7-code',
      status: 'failed',
      failureReason: 'turn_limit',
      planArtifactValid: false,
      approvalReady: false,
      bounds: {
        maxTurns: 40,
        maxToolCalls: 120,
        maxWallClockMs: 1200000,
      },
      usage: {
        turnsCompleted: 40,
        toolCallsExecuted: 72,
        wallClockMs: 900000,
        totalInputTokens: 120000,
        totalOutputTokens: 24000,
        totalCostUsd: 0.42,
      },
      promptRef: {
        id: 'native-planning',
        version: 'sha256:abc123',
      },
      source: '.planning-result.json',
    },
  };

  const result = validateAgainstSchema(record as unknown as Record<string, unknown>);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('planningExecutionOutcome failureReason enum values validate', () => {
  const reasons = [
    'turn_limit',
    'tool_call_limit',
    'wall_clock_limit',
    'tool_stagnation',
    'invalid_final_plan',
    'empty_final_plan',
    'aborted',
    'error',
  ] as const;

  for (const failureReason of reasons) {
    const record: EvalRecord = {
      ...scenarios[0].record,
      schemaVersion: '1.36.0',
      planningExecutionOutcome: {
        status: failureReason === 'aborted' ? 'aborted' : 'failed',
        failureReason,
        planArtifactValid: false,
        approvalReady: false,
        source: '.planning-result.json',
      },
    };

    const result = validateAgainstSchema(record as unknown as Record<string, unknown>);
    assert.ok(result.valid, `${failureReason} should validate: ${result.errors.join('; ')}`);
  }
});

test('planningExecutionOutcome rejects unknown failureReason', () => {
  const record = {
    ...scenarios[0].record,
    schemaVersion: '1.36.0',
    planningExecutionOutcome: {
      status: 'failed',
      failureReason: 'budget_gone',
      source: '.planning-result.json',
    },
  };

  const result = validateAgainstSchema(record as unknown as Record<string, unknown>);
  assert.ok(!result.valid, 'unknown failureReason should fail validation');
});

test('verificationTelemetry remains optional for legacy records', () => {
  const record = scenarios[0].record as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('verificationTelemetry validates full first-green lifecycle fields', () => {
  const record: EvalRecord = {
    ...scenarios[0].record,
    schemaVersion: '1.36.0',
    verificationTelemetry: {
      schema_version: '1.0',
      contract: {
        source: 'explicit',
        version: '1.0',
      },
      checked_shas: {
        head: 'a'.repeat(40),
        base: 'b'.repeat(40),
      },
      local_verification: {
        ran: true,
        passed: true,
        command_count: 3,
        total_duration_ms: 5000,
        command_durations_ms: [1000, 2000, 2000],
        timed_out: false,
      },
      remote_ci_verdict: {
        ran: true,
        passed: true,
        passed_before_merge: true,
        check_count: 5,
        remote_only_failure: false,
      },
      remediation: {
        local_attempt_count: 1,
        local_remediation_outcome: 'none',
        remote_fix_required: false,
        remote_fix_commits: 0,
      },
      operator_override: {
        applied: false,
      },
      timeline: {
        local_start: '2026-08-03T12:00:00.000Z',
        local_end: '2026-08-03T12:05:00.000Z',
        pr_created: '2026-08-03T12:06:00.000Z',
        remote_ci_start: '2026-08-03T12:07:00.000Z',
        remote_ci_first_green: '2026-08-03T12:15:00.000Z',
        pr_merged: '2026-08-03T12:30:00.000Z',
      },
    },
  };

  const result = validateAgainstSchema(record as unknown as Record<string, unknown>);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);

  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.verificationTelemetry?.type, 'object');
});

test('verificationTelemetry rejects unknown categories and raw extra fields', () => {
  const record = {
    ...scenarios[0].record,
    schemaVersion: '1.36.0',
    verificationTelemetry: {
      local_verification: {
        ran: true,
        passed: false,
        first_failure_category: 'security',
        raw_log: 'must not be accepted',
      },
    },
  };

  const result = validateAgainstSchema(record as unknown as Record<string, unknown>);
  assert.ok(!result.valid, 'unknown telemetry category and raw log field should fail validation');
  assert.ok(result.errors.some((error) => error.includes('first_failure_category')));
  assert.ok(result.errors.some((error) => error.includes('raw_log')));
});

test('phaseDurationsSeconds remains optional for legacy records', () => {
  const record = scenarios[0].record as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('phaseDurationsSeconds validates when present', () => {
  const record: EvalRecord = {
    ...scenarios[0].record,
    schemaVersion: '1.26.0',
    phaseDurationsSeconds: {
      planning: 120,
      coding: 480,
      review: 60,
      total: 660,
    },
  };

  const result = validateAgainstSchema(record as unknown as Record<string, unknown>);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);

  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.phaseDurationsSeconds?.type, 'object');
});

test('timeSeconds accepts null for unknown duration', () => {
  const record: EvalRecord = {
    ...scenarios[0].record,
    schemaVersion: '1.28.0',
    timeSeconds: null,
  };

  const result = validateAgainstSchema(record as unknown as Record<string, unknown>);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);

  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(properties.timeSeconds?.type, ['number', 'null']);
});

test('Wavemill router fields validate and schema stays in parity', () => {
  const record: EvalRecord = {
    ...scenarios[0].record,
    schemaVersion: '1.15.0',
    workflow_success_rate_under_budget: 0.75,
    wavemill_router_diagnostics: {
      scoreable_coverage: 0.8,
      invalid_route_rate: 0.1,
      budget_compliance_rate: 0.9,
      completion_success_rate: 0.85,
      total_cost_usd: 12.34,
      timing_p50_ms: 450,
      timing_p95_ms: 1200,
      intervention_rate: 0.25,
      intervention_count: 2,
      total_records: 10,
      scoreable_records: 8,
      invalid_route_records: 1,
    },
    wavemill_router_scoring: {
      scorer_id: 'hokusai.scorers.wavemill.success_rate_under_budget:v1',
      measurement_policy: 'replay_exact_match',
    },
  };

  const result = validateAgainstSchema(record as unknown as Record<string, unknown>);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);

  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.workflow_success_rate_under_budget?.type, 'number');
  assert.equal(properties.wavemill_router_diagnostics?.$ref, '#/$defs/WavemillRouterDiagnostics');
  assert.equal(properties.wavemill_router_scoring?.$ref, '#/$defs/WavemillRouterScoringMetadata');
});

test('Schema version constant is 1.47.0', () => {
  assert.equal(SCHEMA_VERSION, '1.47.0');
});

test('Record with an unknown_attribution intervention validates (HOK-2894)', () => {
  const record = {
    ...scenarios[0].record,
    interventions: [
      {
        timestamp: '2026-08-27T12:00:00Z',
        type: 'unknown_attribution',
        severity: 'low',
        note: '[manual_edit] 192f095: chore: commit agent output (by timogilvie) — no stage-result attribution data available',
      },
    ],
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Record with resolved-model routing validates', () => {
  const record: EvalRecord = {
    ...scenarios[0].record,
    schemaVersion: '1.24.0',
    routing: {
      planner: {
        role: 'planner',
        requestedSelector: { kind: 'pinned', modelId: 'gpt-5.5' },
        resolvedModelId: 'gpt-5.5',
        sourceLayer: 'user',
      },
    },
  };
  const result = validateAgainstSchema(record as unknown as Record<string, unknown>);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Record with invalid resolved-model routing is rejected', () => {
  const record = {
    ...scenarios[0].record,
    schemaVersion: '1.24.0',
    routing: {
      coder: {
        role: 'coder',
        requestedSelector: { kind: 'pinned', modelId: 'gpt-5.4' },
        sourceLayer: 'policy',
      },
    },
  } as unknown as Record<string, unknown>;
  const result = validateAgainstSchema(record);
  assert.ok(!result.valid, 'Should be invalid');
});

test('Legacy rows still validate without nonRewardReason', () => {
  const result = validateAgainstSchema(scenarios[0].record as unknown as Record<string, unknown>);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Records validate with a complete nonRewardReason', () => {
  const record: EvalRecord = {
    ...scenarios[0].record,
    schemaVersion: '1.18.0',
    nonRewardReason: {
      code: 'INELIGIBLE_REWARD_NO_JUDGE',
      message: 'Reward not paid: record has no judge evaluation result.',
    },
  };

  const result = validateAgainstSchema(record as unknown as Record<string, unknown>);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('Records reject nonRewardReason when message is missing', () => {
  const bad = {
    ...scenarios[0].record,
    schemaVersion: '1.18.0',
    nonRewardReason: {
      code: 'INELIGIBLE_REWARD_NO_JUDGE',
    },
  } as unknown as Record<string, unknown>;

  const result = validateAgainstSchema(bad);
  assert.ok(!result.valid, 'Should be invalid');
  assert.ok(
    result.errors.some((error) => error.includes('nonRewardReason.message')),
    'Should mention nonRewardReason.message in error',
  );
});

// ────────────────────────────────────────────────────────────────
// featureOutcomeDiagnostics tests (HOK-2262)
// ────────────────────────────────────────────────────────────────

test('featureOutcomeDiagnostics optional field validates when present', () => {
  const record: EvalRecord = {
    ...scenarios[0].record,
    schemaVersion: '1.30.0',
    featureOutcomeDiagnostics: {
      present: true,
      valid: true,
      used: true,
      sourceFile: 'feature-state.json',
      sourceHash: 'a'.repeat(64),
      schemaVersion: '1.0',
      reason: 'loaded',
      eligibilityDiagnostic: 'eligible',
      missingFields: [],
      invalidFields: [],
      conflictsWithReconstruction: false,
      conflictingFields: [],
    },
  };

  const result = validateAgainstSchema(record as unknown as Record<string, unknown>);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('featureOutcomeDiagnostics validates when absent (optional field)', () => {
  const record: EvalRecord = {
    ...scenarios[0].record,
    schemaVersion: '1.30.0',
  };
  delete (record as Record<string, unknown>).featureOutcomeDiagnostics;

  const result = validateAgainstSchema(record as unknown as Record<string, unknown>);
  assert.ok(result.valid, `Should validate: ${result.errors.join('; ')}`);
});

test('featureOutcomeDiagnostics rejects unknown eligibilityDiagnostic enum value', () => {
  const bad = {
    ...scenarios[0].record,
    schemaVersion: '1.30.0',
    featureOutcomeDiagnostics: {
      present: true,
      valid: false,
      used: false,
      reason: 'artifact_absent',
      eligibilityDiagnostic: 'bad_value_not_in_enum',
    },
  } as unknown as Record<string, unknown>;

  const result = validateAgainstSchema(bad);
  assert.ok(!result.valid, 'Should fail with unknown eligibilityDiagnostic enum value');
});

test('featureOutcomeDiagnostics rejects missing required fields (present, valid, used)', () => {
  const bad = {
    ...scenarios[0].record,
    schemaVersion: '1.30.0',
    featureOutcomeDiagnostics: {
      // missing: present, valid, used
      reason: 'artifact_absent',
      eligibilityDiagnostic: 'unknown',
    },
  } as unknown as Record<string, unknown>;

  const result = validateAgainstSchema(bad);
  assert.ok(!result.valid, 'Should fail when required sub-fields missing');
});

test('featureOutcomeDiagnostics: new eligibility error codes validate', () => {
  const record: EvalRecord = {
    ...scenarios[0].record,
    schemaVersion: '1.30.0',
    budgetEvalEligibilityError: 'missing_feature_outcome',
    eligibilityErrors: ['missing_feature_outcome', 'invalid_feature_outcome', 'failed_feature_outcome'],
  };

  const result = validateAgainstSchema(record as unknown as Record<string, unknown>);
  assert.ok(result.valid, `New eligibility codes should validate: ${result.errors.join('; ')}`);
});

// ────────────────────────────────────────────────────────────────
// P0.5 Phase 0 Fork Descriptor Fields Tests (HOK-2794)
// ────────────────────────────────────────────────────────────────

test('challengeIntent with fork descriptor fields validates', () => {
  const record = {
    ...scenarios[0].record,
    challengeIntent: {
      pairId: 'HOK-2794',
      primary: {
        pairId: 'HOK-2794',
        side: 'primary',
        challengeStage: 'implementation',
        expectedStageModel: 'claude-opus-4-6',
        expectedRoute: { planner: '', coder: 'claude-opus-4-6', reviewer: '', planDepth: 'medium', codeDepth: 'medium', reviewMode: 'default' },
      },
      challenger: {
        pairId: 'HOK-2794',
        side: 'challenger',
        challengeStage: 'implementation',
        expectedStageModel: 'claude-sonnet-4-5-20250929',
        expectedRoute: { planner: '', coder: 'claude-sonnet-4-5-20250929', reviewer: '', planDepth: 'medium', codeDepth: 'medium', reviewMode: 'default' },
      },
      forkStage: null,
      forkCommit: null,
      sharedPrefix: false,
    },
  } as unknown as Record<string, unknown>;

  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `challengeIntent with fork fields should validate: ${result.errors.join('; ')}`);
});

test('challengeIntent without fork descriptor fields still validates', () => {
  const record = {
    ...scenarios[0].record,
    challengeIntent: {
      pairId: 'HOK-2794',
      primary: {
        pairId: 'HOK-2794',
        side: 'primary',
        challengeStage: 'implementation',
        expectedStageModel: 'claude-opus-4-6',
        expectedRoute: { planner: '', coder: 'claude-opus-4-6', reviewer: '', planDepth: 'medium', codeDepth: 'medium', reviewMode: 'default' },
      },
      challenger: {
        pairId: 'HOK-2794',
        side: 'challenger',
        challengeStage: 'implementation',
        expectedStageModel: 'claude-sonnet-4-5-20250929',
        expectedRoute: { planner: '', coder: 'claude-sonnet-4-5-20250929', reviewer: '', planDepth: 'medium', codeDepth: 'medium', reviewMode: 'default' },
      },
      // fork fields intentionally omitted (backward compatibility)
    },
  } as unknown as Record<string, unknown>;

  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `challengeIntent without fork fields should still validate: ${result.errors.join('; ')}`);
});

test('challengeIntent side with inheritedStages validates', () => {
  const record = {
    ...scenarios[0].record,
    challengeIntent: {
      pairId: 'HOK-2794',
      primary: {
        pairId: 'HOK-2794',
        side: 'primary',
        challengeStage: 'implementation',
        expectedStageModel: 'claude-opus-4-6',
        expectedRoute: { planner: '', coder: 'claude-opus-4-6', reviewer: '', planDepth: 'medium', codeDepth: 'medium', reviewMode: 'default' },
        inheritedStages: ['plan'],
      },
      challenger: {
        pairId: 'HOK-2794',
        side: 'challenger',
        challengeStage: 'implementation',
        expectedStageModel: 'claude-sonnet-4-5-20250929',
        expectedRoute: { planner: '', coder: 'claude-sonnet-4-5-20250929', reviewer: '', planDepth: 'medium', codeDepth: 'medium', reviewMode: 'default' },
        inheritedStages: [],
      },
    },
  } as unknown as Record<string, unknown>;

  const result = validateAgainstSchema(record);
  assert.ok(result.valid, `challengeIntent with inheritedStages should validate: ${result.errors.join('; ')}`);
});

// ────────────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────────────

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);

if (failed > 0) {
  process.exit(1);
}
