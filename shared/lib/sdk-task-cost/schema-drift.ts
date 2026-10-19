/**
 * Drift guard between the SDK task-cost enums and the eval JSON Schema's
 * `$defs.TaskCostSummary` family (HOK-3075).
 *
 * `eval-schema.json` embeds the SDK enums as literal `enum` arrays so Ajv can
 * validate persisted `taskCostSummary` blocks without depending on the SDK at
 * validation time. This guard compares them with the SDK's runtime constants;
 * an SDK bump that adds or renames a value fails the eval-schema tests
 * instead of silently rejecting (or accepting) records in production.
 *
 * @module sdk-task-cost/schema-drift
 */

import {
  TASK_COST_BASES,
  TASK_COST_COVERAGES,
  TASK_COST_DIAGNOSTIC_CODES,
  TASK_COST_FIELD_AVAILABILITIES,
  TASK_COST_HARNESSES,
  TASK_COST_JOIN_CONFIDENCES,
  TASK_COST_PRICING_SOURCES,
  TASK_COST_SOURCES,
  TASK_COST_SUMMARY_SCHEMA_VERSION,
  TASK_COST_TOKEN_FIELDS,
} from './contract.ts';

type JsonNode = Record<string, unknown>;

function at(node: unknown, path: readonly string[]): unknown {
  let current: unknown = node;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as JsonNode)[key];
  }
  return current;
}

function sameMembers(actual: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(actual)) return false;
  return actual.length === expected.length && expected.every((value) => actual.includes(value));
}

/**
 * Return human-readable drift findings (empty when the schema matches the
 * SDK contract this build is pinned to).
 */
export function findTaskCostSchemaDrift(evalSchema: unknown): string[] {
  const defs = at(evalSchema, ['$defs']);
  const findings: string[] = [];
  const expectEnum = (path: readonly string[], expected: readonly string[]) => {
    const actual = at(defs, path);
    if (!sameMembers(actual, expected)) {
      findings.push(`$defs.${path.join('.')} is ${JSON.stringify(actual)}; SDK expects ${JSON.stringify(expected)}`);
    }
  };

  expectEnum(['TaskCostHarness', 'enum'], TASK_COST_HARNESSES);
  expectEnum(['TaskCostSource', 'enum'], TASK_COST_SOURCES);
  expectEnum(['TaskCostFieldAvailability', 'enum'], TASK_COST_FIELD_AVAILABILITIES);
  expectEnum(['TaskCostDiagnosticCode', 'enum'], TASK_COST_DIAGNOSTIC_CODES);
  expectEnum(['TaskCostSummary', 'properties', 'cost_basis', 'enum'], TASK_COST_BASES);
  expectEnum(['TaskCostSummary', 'properties', 'coverage', 'enum'], TASK_COST_COVERAGES);
  expectEnum(['TaskCostSummary', 'properties', 'pricing_source', 'enum'], TASK_COST_PRICING_SOURCES);
  expectEnum(['TaskCostSummary', 'properties', 'join_confidence', 'enum'], TASK_COST_JOIN_CONFIDENCES);
  expectEnum(['TaskCostTokenUsage', 'required'], TASK_COST_TOKEN_FIELDS);

  const schemaVersion = at(defs, ['TaskCostSummary', 'properties', 'schema_version', 'const']);
  if (schemaVersion !== TASK_COST_SUMMARY_SCHEMA_VERSION) {
    findings.push(
      `$defs.TaskCostSummary.properties.schema_version.const is ${JSON.stringify(schemaVersion)}; `
      + `SDK expects ${JSON.stringify(TASK_COST_SUMMARY_SCHEMA_VERSION)}`,
    );
  }
  return findings;
}
