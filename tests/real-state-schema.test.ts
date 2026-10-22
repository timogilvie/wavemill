/**
 * Real-state fixtures must validate against the workflow-task schema (HOK-3225).
 *
 * Every file in `tests/fixtures/real-state/` is a sanitised snapshot captured
 * from a live `.wavemill/workflow-state.json`. If the writers emit a shape the
 * schema no longer admits, this test fails before the drift lands anywhere
 * else. The guard is intentionally lax about *new* fields
 * (`additionalProperties: true`) and tight about *typed* fields — HOK-3220's
 * reason for the schema to exist.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import {
  validateWorkflowState,
  type WorkflowState,
} from '../shared/lib/workflow-state.ts';
import { FIXTURE_PHASES, type FixturePhase } from '../shared/lib/fixture-capturer.ts';

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'real-state',
);

interface FixtureFile {
  $fixture: { phase: FixturePhase; capturedAt: string };
  workflowState: WorkflowState;
  hooks?: Record<string, unknown>;
  stageResults?: Record<string, unknown>;
}

function listFixtures(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

test('real-state fixture directory holds >= 8 fixtures', () => {
  const files = listFixtures();
  assert.ok(
    files.length >= 8,
    `expected at least 8 real-state fixtures in ${FIXTURE_DIR}, found ${files.length}: ${files.join(', ')}`,
  );
});

test('every real-state fixture carries a known phase label', () => {
  const files = listFixtures();
  const seenPhases = new Set<FixturePhase>();
  for (const file of files) {
    const parsed = JSON.parse(
      readFileSync(join(FIXTURE_DIR, file), 'utf-8'),
    ) as FixtureFile;
    assert.ok(parsed.$fixture, `${file}: missing $fixture metadata`);
    assert.ok(
      (FIXTURE_PHASES as readonly string[]).includes(parsed.$fixture.phase),
      `${file}: $fixture.phase=${JSON.stringify(parsed.$fixture.phase)} is not one of ${FIXTURE_PHASES.join(', ')}`,
    );
    seenPhases.add(parsed.$fixture.phase);
  }
  // Confirm the capture set covers each required phase at least once.
  for (const phase of FIXTURE_PHASES) {
    assert.ok(
      seenPhases.has(phase),
      `no real-state fixture covers phase=${phase}; add one via tools/capture-state-fixture.ts`,
    );
  }
});

test('every real-state fixture validates against the A1 schema', () => {
  const files = listFixtures();
  const violations: string[] = [];
  for (const file of files) {
    const parsed = JSON.parse(
      readFileSync(join(FIXTURE_DIR, file), 'utf-8'),
    ) as FixtureFile;
    const { valid, issues } = validateWorkflowState(parsed.workflowState);
    if (!valid) {
      for (const issue of issues) {
        violations.push(`${file}${issue.path} ${issue.message}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `real-state fixtures violated workflow-task.schema.json:\n  ${violations.join('\n  ')}`,
  );
});
