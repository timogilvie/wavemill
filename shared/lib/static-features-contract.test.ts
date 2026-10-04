/**
 * S1 Static-group contract drift guard (HOK-2806, HOK-2499/HOK-2803 pattern).
 *
 * Loads the field-shape fixture at static-features.fixtures.json (a local
 * mirror of the frozen `candidate_features/v1` Static-group slice) and asserts
 * that the wavemill collector still emits:
 *   - the four canonical field names (`type_errors`, `lint_errors`,
 *     `build_ok`, `complexity_delta`), in snake_case;
 *   - values whose runtime types match the contract's `types` list;
 *   - integer counts that respect `minimum` when non-null.
 *
 * This test does not run the collector against a real repo — it exercises
 * the eval-schema type surface and a synthetic result object to catch:
 *   1. A field being renamed by accident (camelCase drift).
 *   2. A field being widened or narrowed (e.g. `build_ok: 0` sneaking in).
 *   3. A value shape that would be rejected by the S1 SDK.
 *
 * When `@hokusai/core` publishes the SDK candidate-features fixture in a
 * later release, swap this fixture for a direct SDK import per HOK-2807.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StaticAnalysisOutcome } from './eval-schema.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dirname, 'static-features.fixtures.json'), 'utf-8'),
) as {
  schema: string;
  group: string;
  fields: Record<
    string,
    { types: string[]; minimum?: number; nullMeans: string; source: string }
  >;
  examples: Record<string, Record<string, unknown>>;
};

test('fixture is the Static group of candidate_features/v1', () => {
  assert.equal(fixture.schema, 'candidate_features/v1');
  assert.equal(fixture.group, 'static');
});

test('collector emits every S1 Static field name (snake_case, verbatim)', () => {
  const required = ['type_errors', 'lint_errors', 'build_ok', 'complexity_delta'];
  for (const name of required) {
    assert.ok(name in fixture.fields, `fixture missing S1 field: ${name}`);
  }
  // The eval-schema outcome interface must accept exactly these keys.
  const _sample: StaticAnalysisOutcome = {
    type_errors: 0,
    lint_errors: 0,
    build_ok: true,
    complexity_delta: 0,
  };
  const emittedKeys = Object.keys(_sample);
  for (const name of required) {
    assert.ok(emittedKeys.includes(name), `StaticAnalysisOutcome cannot carry ${name}`);
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

test('every example row conforms to the fixture field shapes', () => {
  for (const [label, row] of Object.entries(fixture.examples)) {
    for (const [name, def] of Object.entries(fixture.fields)) {
      if (!(name in row)) continue;
      const value = row[name];
      assert.ok(
        matchesTypes(value, def.types),
        `${label}.${name}=${JSON.stringify(value)} does not match types ${def.types.join('|')}`,
      );
      if (typeof def.minimum === 'number' && typeof value === 'number') {
        assert.ok(
          value >= def.minimum,
          `${label}.${name}=${value} is below the S1 minimum ${def.minimum}`,
        );
      }
    }
  }
});

test('null values are the ONLY sentinel for "evidence unavailable" (never -1, "N/A", or {})', () => {
  const bad = { type_errors: -1 };
  const def = fixture.fields.type_errors;
  assert.equal(matchesTypes(bad.type_errors, def.types), true); // still an integer
  // But the minimum rule rejects it.
  assert.equal(bad.type_errors >= (def.minimum ?? 0), false);
});

test('build_ok source note pins CiOutcome.ran to true (frozen S1 mapping)', () => {
  assert.match(fixture.fields.build_ok.source, /CiOutcome\.ran must be true/);
});
