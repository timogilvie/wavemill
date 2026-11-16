/**
 * HOK-3499 property: a plan the planning gate accepts always parses in the
 * ready-stage consumer, for every accepted Release Readiness spelling
 * (heading level, numeric prefix, heading suffix, bullet marker, colon inside
 * or outside the bold, field order, and field values).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { assertProperty } from '../fast-check-utils.ts';
import { extractReleaseReadiness } from '../task-packet-utils.ts';
import { validateFinalPlanningArtifact } from './planning-guards.ts';

const DB_RISKS = ['none', 'possible', 'required'] as const;
type DbRisk = (typeof DB_RISKS)[number];

type FieldName = 'database_change_risk' | 'env_changes' | 'config_changes' | 'manual_steps';
const FIELDS: readonly FieldName[] = [
  'database_change_risk',
  'env_changes',
  'config_changes',
  'manual_steps',
];

interface Spelling {
  heading: string;
  bullet: string;
  colonInside: boolean;
  order: readonly FieldName[];
  dbRisk: DbRisk;
  listValues: Record<Exclude<FieldName, 'database_change_risk'>, string[]>;
}

function fieldValue(spelling: Spelling, field: FieldName): string {
  if (field === 'database_change_risk') return spelling.dbRisk;
  const values = spelling.listValues[field];
  return values.length === 0 ? 'none' : values.join(', ');
}

function bullet(spelling: Spelling, field: FieldName): string {
  const name = spelling.colonInside ? `**${field}:**` : `**${field}**:`;
  return `${spelling.bullet}${name} ${fieldValue(spelling, field)}`;
}

function renderPlan(spelling: Spelling): string {
  return [
    '# Implementation Plan',
    '',
    '## Phase 1',
    '- Make the change.',
    '- Verify it.',
    '',
    spelling.heading,
    '',
    ...spelling.order.map((field) => bullet(spelling, field)),
  ].join('\n');
}

const arbitrarySpelling: fc.Arbitrary<Spelling> = fc.record({
  heading: fc.constantFrom(
    '## Release Readiness',
    '### Release Readiness',
    '## 7. Release Readiness',
    '## Release Readiness (v2)',
  ),
  bullet: fc.constantFrom('- ', '* ', ''),
  colonInside: fc.boolean(),
  order: fc.shuffledSubarray([...FIELDS], { minLength: FIELDS.length, maxLength: FIELDS.length }),
  dbRisk: fc.constantFrom(...DB_RISKS),
  listValues: fc.record({
    env_changes: fc.array(fc.constantFrom('API_KEY', 'FEATURE_FLAG'), { maxLength: 2 }),
    config_changes: fc.array(fc.constantFrom('config/app.json', 'config/db.json'), { maxLength: 2 }),
    manual_steps: fc.array(fc.constantFrom('Run migration', 'Restart workers'), { maxLength: 2 }),
  }),
});

test('every accepted Release Readiness spelling passes the gate and parses in the consumer', () => {
  assertProperty(
    fc.property(arbitrarySpelling, (spelling) => {
      const text = renderPlan(spelling);

      const validation = validateFinalPlanningArtifact(text);
      assert.deepEqual(validation, { valid: true }, `gate rejected:\n${text}`);

      const readiness = extractReleaseReadiness(text);
      assert.ok(readiness, `gate-accepted plan failed to parse:\n${text}`);
      assert.deepEqual(readiness.missingFields, [], `missing fields for:\n${text}`);
      assert.equal(readiness.databaseChangeRisk, spelling.dbRisk);
      assert.deepEqual(readiness.envChanges, spelling.listValues.env_changes);
      assert.deepEqual(readiness.configChanges, spelling.listValues.config_changes);
      assert.deepEqual(readiness.manualSteps, spelling.listValues.manual_steps);
      return true;
    }),
    { name: 'gate-accepted plans parse in the consumer' },
  );
});
