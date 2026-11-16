/**
 * HOK-3499: the planning gate and the ready-stage consumer read Release
 * Readiness through one parser. The replay fixture is the HOK-3406 planning
 * attempt-4 repair output (`.wavemill/incidents/2026-11-16-HOK-3406-planning-
 * unattributed/planning-HOK-3406.jsonl`, seq 274), whose bullets spelled the
 * colon inside the bold (`- **database_change_risk:** none`) and were rejected
 * by the gate's old `**field**:`-only grammar.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractReleaseReadiness } from '../task-packet-utils.ts';
import { validateFinalPlanningArtifact } from './planning-guards.ts';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'hok3406-plan-attempt-4.md',
);

test('HOK-3406 attempt-4 repair passes the planning gate', () => {
  assert.deepEqual(validateFinalPlanningArtifact(readFileSync(FIXTURE, 'utf-8')), { valid: true });
});

test('HOK-3406 attempt-4 repair parses in the ready-stage consumer', () => {
  const readiness = extractReleaseReadiness(readFileSync(FIXTURE, 'utf-8'));
  assert.ok(readiness, 'the gate-accepted plan must parse');
  assert.equal(readiness.databaseChangeRisk, 'none');
  assert.deepEqual(readiness.envChanges, []);
  assert.equal(readiness.configChanges.length, 1);
  assert.deepEqual(readiness.manualSteps, []);
  assert.deepEqual(readiness.missingFields, []);
});

function plan(body: string[]): string {
  return [
    '# Implementation Plan',
    '',
    '## Phase 1',
    '- Make the change.',
    '- Verify it.',
    '',
    ...body,
  ].join('\n');
}

test('the gate reports the shared parser missing-field reasons', () => {
  assert.equal(
    validateFinalPlanningArtifact(plan([
      '## Release Readiness',
      '- **env_changes**: none',
      '- **config_changes**: none',
      '- **manual_steps**: none',
    ])).reason,
    'missing_release_readiness_database_change_risk',
  );
  assert.equal(
    validateFinalPlanningArtifact(plan([
      '## Unrelated',
      '',
      'A section long enough that the plan clears the minimum-length check and reaches the Release Readiness rule.',
    ])).reason,
    'missing_release_readiness',
  );
});

test('a missing database_change_risk is reported, not defaulted to none', () => {
  const readiness = extractReleaseReadiness([
    '## Release Readiness',
    '- **env_changes**: none',
    '- **config_changes**: none',
    '- **manual_steps**: none',
  ].join('\n'));
  assert.equal(readiness?.databaseChangeRisk, undefined);
  assert.deepEqual(readiness?.missingFields, ['database_change_risk']);
});
