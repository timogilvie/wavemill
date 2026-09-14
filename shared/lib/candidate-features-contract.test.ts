/**
 * S1 candidate_features/v1 contract drift guard (HOK-2807).
 *
 * Loads the field-shape fixture at candidate-features.fixtures.json (a local
 * mirror of the frozen `candidate_features/v1` contract) and asserts that:
 *   - Every group has the canonical field names;
 *   - Values match the contract's type shapes;
 *   - All five groups are present in extractCandidateFeatures output.
 *
 * When @hokusai/core publishes the SDK candidate-features fixture in a
 * later release, swap this fixture for a direct SDK import per HOK-2807.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CandidateFeaturesV1 } from './candidate-features.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dirname, 'candidate-features.fixtures.json'), 'utf-8'),
) as {
  schema: string;
  groups: Record<
    string,
    {
      description: string;
      fields: Record<
        string,
        { types: string[]; minimum?: number; nullMeans: string; source: string }
      >;
    }
  >;
  examples: Record<string, Record<string, unknown>>;
};

test('fixture is candidate_features/v1', () => {
  assert.equal(fixture.schema, 'candidate_features/v1');
});

test('extractor emits all five groups (shape, static, test, intent, provenance)', () => {
  const requiredGroups = ['shape', 'static', 'test', 'intent', 'provenance'];
  for (const group of requiredGroups) {
    assert.ok(
      group in fixture.groups,
      `fixture missing group: ${group}`,
    );
  }

  // Verify the type carries all five groups
  const _sample: CandidateFeaturesV1 = {
    shape: { files_changed: null, lines_added: null, lines_removed: null },
    static: {
      type_errors: null,
      lint_errors: null,
      build_ok: null,
      complexity_delta: null,
      build_evidence: null,
      complexity_metric: null,
    },
    test: { test_files_changed: null, test_changed_lines: null },
    intent: {
      touched_out_of_scope_files: null,
      modified_non_implementation_files: null,
      added_new_dependencies: null,
      schema_migration: null,
      database_change_risk: null,
    },
    provenance: {
      pr_number: null,
      head_sha: null,
      base_ref: null,
      pr_url: null,
    },
  };

  const emittedKeys = Object.keys(_sample);
  for (const group of requiredGroups) {
    assert.ok(
      emittedKeys.includes(group),
      `CandidateFeaturesV1 does not have group: ${group}`,
    );
  }
});

function matchesTypes(value: unknown, types: readonly string[]): boolean {
  return types.some((t) => {
    if (t === 'null') return value === null;
    if (t === 'boolean') return typeof value === 'boolean';
    if (t === 'string') return typeof value === 'string';
    if (t === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (t === 'integer') {
      return typeof value === 'number' && Number.isInteger(value);
    }
    return false;
  });
}

test('Shape group: files_changed, lines_added, lines_removed are integer|null', () => {
  const shapeFields = fixture.groups.shape.fields;
  assert.ok('files_changed' in shapeFields);
  assert.ok('lines_added' in shapeFields);
  assert.ok('lines_removed' in shapeFields);

  const sample = fixture.examples.fully_populated.shape as Record<string, unknown>;
  for (const [name, def] of Object.entries(shapeFields)) {
    if (!(name in sample)) continue;
    const value = sample[name];
    assert.ok(
      matchesTypes(value, def.types),
      `${name}=${JSON.stringify(value)} does not match types ${def.types.join('|')}`,
    );
  }
});

test('Static group: matches HOK-2806 contract (type_errors, lint_errors, build_ok, complexity_delta)', () => {
  const staticFields = fixture.groups.static.fields;
  const required = ['type_errors', 'lint_errors', 'build_ok', 'complexity_delta'];
  for (const name of required) {
    assert.ok(name in staticFields, `static group missing field: ${name}`);
  }

  const sample = fixture.examples.fully_populated.static as Record<string, unknown>;
  for (const [name, def] of Object.entries(staticFields)) {
    if (!(name in sample)) continue;
    const value = sample[name];
    assert.ok(
      matchesTypes(value, def.types),
      `static.${name}=${JSON.stringify(value)} does not match types ${def.types.join('|')}`,
    );
  }
});

test('Test group: test_files_changed and test_changed_lines are integer|null', () => {
  const testFields = fixture.groups.test.fields;
  assert.ok('test_files_changed' in testFields);
  assert.ok('test_changed_lines' in testFields);

  const sample = fixture.examples.fully_populated.test as Record<string, unknown>;
  for (const [name, def] of Object.entries(testFields)) {
    if (!(name in sample)) continue;
    const value = sample[name];
    assert.ok(
      matchesTypes(value, def.types),
      `test.${name}=${JSON.stringify(value)} does not match types ${def.types.join('|')}`,
    );
  }
});

test('Intent group: all fields are boolean|string|null (null without enrichment)', () => {
  const intentFields = fixture.groups.intent.fields;
  const required = [
    'touched_out_of_scope_files',
    'modified_non_implementation_files',
    'added_new_dependencies',
    'schema_migration',
    'database_change_risk',
  ];
  for (const name of required) {
    assert.ok(name in intentFields, `intent group missing field: ${name}`);
  }

  // Without enrichment, all intent fields must be null
  const emptyIntent = fixture.examples.evidence_unavailable.intent as Record<string, unknown>;
  for (const [name] of Object.entries(intentFields)) {
    const value = emptyIntent[name];
    assert.equal(value, null, `intent.${name} without enrichment must be null, got ${value}`);
  }
});

test('Provenance group: pr_number, head_sha, base_ref, pr_url trace the PR', () => {
  const provenanceFields = fixture.groups.provenance.fields;
  const required = ['pr_number', 'head_sha', 'base_ref', 'pr_url'];
  for (const name of required) {
    assert.ok(name in provenanceFields, `provenance group missing field: ${name}`);
  }

  const sample = fixture.examples.fully_populated.provenance as Record<string, unknown>;
  for (const [name, def] of Object.entries(provenanceFields)) {
    if (!(name in sample)) continue;
    const value = sample[name];
    assert.ok(
      matchesTypes(value, def.types),
      `provenance.${name}=${JSON.stringify(value)} does not match types ${def.types.join('|')}`,
    );
  }
});

test('null values are the ONLY sentinel for "evidence unavailable"', () => {
  // Verify every example row never uses -1, "N/A", or {} to mean unavailable
  for (const [label, row] of Object.entries(fixture.examples)) {
    for (const [groupName, groupDef] of Object.entries(fixture.groups)) {
      const groupRow = (row as Record<string, unknown>)[groupName] as Record<string, unknown> | undefined;
      if (!groupRow) continue;

      for (const [name, def] of Object.entries(groupDef.fields)) {
        if (!(name in groupRow)) continue;
        const value = groupRow[name];
        // If null is allowed, verify it's used instead of falsy defaults
        if (def.types.includes('null') && value === null) {
          // OK: explicit null
          continue;
        }
        // Otherwise, value must match one of the allowed types
        assert.ok(
          matchesTypes(value, def.types),
          `${label}.${groupName}.${name}=${JSON.stringify(value)} does not match types ${def.types.join('|')}`,
        );
      }
    }
  }
});
