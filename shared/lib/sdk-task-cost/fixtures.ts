/**
 * Loader for the task-cost fixtures in `tests/fixtures/sdk-task-cost/`
 * (HOK-3075, re-based on `@hokusai/costs` in HOK-3328). Test helper only:
 * each fixture holds `@hokusai/costs` usage records and a rate table, and
 * {@link fixtureTaskCostSummaries} turns them into contract summaries with the
 * SDK's own tracker — the same engine live metering uses.
 *
 * @module sdk-task-cost/fixtures
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTaskCostTracker, type TaskUsageRecord } from '@hokusai/costs';
import type { PricingTable } from '../pricing/model-pricing.ts';
import type { TaskCostSummaryV1 } from './contract.ts';
import { buildHostPriceOverrides } from './price-overrides.ts';

export const SDK_TASK_COST_FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'tests', 'fixtures', 'sdk-task-cost',
);

export interface SdkTaskCostFixture {
  name: string;
  description: string;
  taskId: string;
  /** Fixed tracker clock so summaries are deterministic. */
  now: string;
  pricingTable: PricingTable;
  records: TaskUsageRecord[];
}

export function loadSdkTaskCostFixture(name: string): SdkTaskCostFixture {
  const raw = JSON.parse(readFileSync(join(SDK_TASK_COST_FIXTURES_DIR, `${name}.json`), 'utf-8'));
  return { name, ...raw } as SdkTaskCostFixture;
}

export function listSdkTaskCostFixtures(): string[] {
  return readdirSync(SDK_TASK_COST_FIXTURES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''))
    .sort();
}

/** The fixture's contract summaries as `@hokusai/costs` reports them; null when it has no usage. */
export function fixtureTaskCostSummaries(name: string): TaskCostSummaryV1[] | null {
  const fixture = loadSdkTaskCostFixture(name);
  const tracker = createTaskCostTracker({
    taskId: fixture.taskId,
    priceOverrides: buildHostPriceOverrides(fixture.pricingTable),
    now: () => new Date(fixture.now),
  });
  for (const record of fixture.records) tracker.recordUsage(record);
  const summaries = tracker.summary().summaries;
  return summaries.length > 0 ? [...summaries] : null;
}
