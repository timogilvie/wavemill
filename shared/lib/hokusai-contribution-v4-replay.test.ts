/**
 * REQ-F3 replay fixtures — HOK-3415.
 *
 * Takes SDK-published `technical_task_router_row/v4` goldens from
 * `@hokusai/core`'s `contributionV4Fixtures` and asserts that
 * `sum(stage_executions[].task_cost.total_cost_usd) ≈ row.actual_cost_usd`
 * within 1e-6 whenever every stage's cost resolves. These goldens are
 * hand-written under the same invariants the SDK validates against (per-base
 * stage: last `executed_model` equals `selected_models[role]`; task-cost
 * task_id matches the row's task_id), so they double as end-to-end
 * replay inputs for the Wavemill side: if Hokusai ever reprices from the
 * stages and gets a different total than Wavemill's `actual_cost_usd`, these
 * assertions fail first.
 *
 * Incremental successor: pick 2–3 real recorded eval records from
 * `.wavemill/evals/` (2026-10-27+), produce the v4 projection from them via
 * `buildHokusaiV4Projection`, and store the sanitized `{ expectedRow, inputs }`
 * pairs under `tests/fixtures/contribution-v4-replay/`. This file is the
 * scaffolding every replay test uses.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  contributionV4Fixtures,
  type ContributionV4FixtureName,
} from '@hokusai/core';

function sumStageTotals(row: {
  stage_executions: Array<{ task_cost: { total_cost_usd: number | null } }>;
}): number | null {
  let sum = 0;
  for (const stage of row.stage_executions) {
    const total = stage.task_cost.total_cost_usd;
    if (total === null) return null;
    sum += total;
  }
  return Math.round(sum * 1e9) / 1e9;
}

describe('contribution-v4 replay', () => {
  for (const name of Object.keys(contributionV4Fixtures) as ContributionV4FixtureName[]) {
    it(`[REQ-F3] ${name}: stage totals sum to actual_cost_usd when every stage resolves`, () => {
      const row = contributionV4Fixtures[name];
      const sum = sumStageTotals(row);
      if (sum === null) {
        // At least one stage had `coverage: 'unavailable'` (ci-fix repair
        // stages typically). The v4 contract allows that; sum is unverifiable.
        assert.ok(true, 'stage cost unavailable — no sum to verify');
        return;
      }
      assert.ok(
        row.actual_cost_usd !== null && row.actual_cost_usd !== undefined,
        `${name}: actual_cost_usd must be set when every stage cost resolves`,
      );
      const delta = Math.abs(sum - (row.actual_cost_usd as number));
      assert.ok(
        delta < 1e-6,
        `${name}: sum(stage_executions[].task_cost.total_cost_usd)=${sum} ` +
          `!= actual_cost_usd=${String(row.actual_cost_usd)}`,
      );
    });
  }
});
