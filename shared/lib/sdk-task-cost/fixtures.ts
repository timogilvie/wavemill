/**
 * Loader for the SDK task-cost bridge fixtures in
 * `tests/fixtures/sdk-task-cost/` (HOK-3075). Test helper only: each fixture
 * holds adapter scan results (what the session adapters would have returned)
 * plus the expected subset of every emitted `TaskCostSummaryV1`.
 *
 * @module sdk-task-cost/fixtures
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionUsageResult } from '../session-adapters.ts';
import type { PricingTable } from '../workflow-cost.ts';
import type { TaskCostSummaryV1 } from './contract.ts';

export const SDK_TASK_COST_FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'tests', 'fixtures', 'sdk-task-cost',
);

export interface SdkTaskCostFixture {
  name: string;
  description: string;
  taskId: string;
  /** Fixed collection clock so summaries are deterministic. */
  now: string;
  pricingTable: PricingTable;
  scanResults: Array<SessionUsageResult | null>;
  /** Expected subset of each summary, in emission order; null = no summaries. */
  expected: Array<Partial<TaskCostSummaryV1>> | null;
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
