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
 * The second block replays real recorded eval records (2026-11-03/04) through
 * Wavemill's own producer: `toHokusaiSubmission` → redaction →
 * `buildHokusaiV4Projection` → the v4 builder → the contribution-row
 * validator. Each fixture under `tests/fixtures/contribution-v4-replay/` holds
 * the record, the task's owned sessions and the per-execution-stage SDK
 * summaries re-metered from its archived ownership record; the stage costs
 * must sum to the record's `workflowCost` (HOK-3415 acceptance 2 and 3).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import type { EvalRecord } from './eval-schema.ts';
import { buildTechnicalTaskRouterRowV4 } from './hokusai-contribution-builder.ts';
import { validateContributionRow } from './hokusai-contribution-schema.ts';
import { redactHokusaiSubmission } from './hokusai-redaction.ts';
import { toHokusaiSubmission } from './hokusai-schema.ts';
import {
  buildHokusaiV4Projection,
  hokusaiSubmissionTriggerDeps,
} from './hokusai-submission-trigger.ts';
import type { MeteredWorkflowCost } from './sdk-task-cost/meter.ts';
import type { ExecutionStage, SessionOwnershipRow } from './session-ownership.ts';
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

interface RealReplayFixture {
  description: string;
  record: EvalRecord;
  metered: { owned: SessionOwnershipRow[]; summariesByStage: Record<string, unknown[]> };
  expected: { workflowCost: number };
}

const REAL_FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures', 'contribution-v4-replay');
const SALT = 'd'.repeat(64);

function meteredFromFixture(fixture: RealReplayFixture): MeteredWorkflowCost {
  return {
    outcome: { status: 'success' } as never,
    reason: 'sdk_report' as never,
    summaries: [],
    owned: fixture.metered.owned,
    sessionCosts: new Map(),
    sessionUsageRows: new Map(),
    sessionHarness: new Map(),
    summariesByStage: new Map(
      Object.entries(fixture.metered.summariesByStage) as Array<[ExecutionStage, never[]]>,
    ),
  };
}

describe('contribution-v4 replay from real eval records', () => {
  afterEach(() => mock.restoreAll());

  const files = readdirSync(REAL_FIXTURE_DIR).filter((name) => name.endsWith('.json')).sort();

  // protects: the fixture directory silently emptying, which would make this block vacuous.
  it('has at least three real records to replay', () => {
    assert.ok(files.length >= 3, `expected >= 3 fixtures, found ${files.length}`);
  });

  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(REAL_FIXTURE_DIR, file), 'utf-8')) as RealReplayFixture;
    const issueId = fixture.record.issueId ?? file;

    // protects: a v4 row whose stage costs drop or double-count sessions (helper
    // review calls, repair stages) so Hokusai's repricing disagrees with workflowCost.
    it(`[REQ-F2/F3] ${issueId}: stage costs sum to workflowCost and the row validates`, () => {
      const submissionResult = toHokusaiSubmission(fixture.record);
      assert.ok(submissionResult.ok, `${issueId} is a submittable record`);
      const submission = redactHokusaiSubmission(submissionResult.submission, { salt: SALT });
      // Executed models come from stage results the fixture does not carry; the
      // route the task took stands in so the v4 role check holds. Cost is what
      // this replay protects.
      const routed: Record<string, string | null | undefined> = {
        planning: submission.route_taken.planner_model,
        coding: submission.route_taken.coder_model,
        review: submission.route_taken.reviewer_model,
      };
      mock.method(hokusaiSubmissionTriggerDeps, 'resolveStageExecutedModel', (input: { stage: string }) => ({
        executedModel: routed[input.stage] ?? null,
        evidenceStatus: 'direct' as const,
        evidenceSource: 'session-stream' as const,
      }));

      const projection = buildHokusaiV4Projection(submission, fixture.record, meteredFromFixture(fixture), {
        repoDir: REAL_FIXTURE_DIR,
        redactionSalt: SALT,
      });
      assert.ok(projection, `${issueId} has stage executions`);
      const row = validateContributionRow(buildTechnicalTaskRouterRowV4(projection));
      const stages = (row as { stage_executions: Array<{ stage: string; task_cost: { total_cost_usd: number | null; task_id: string } }> }).stage_executions;

      const stageSum = sumStageTotals({ stage_executions: stages });
      assert.ok(stageSum !== null, `${issueId}: every stage cost resolved`);
      assert.ok(
        Math.abs(stageSum - fixture.expected.workflowCost) < 1e-6,
        `${issueId}: stage costs ${stageSum} != workflowCost ${fixture.expected.workflowCost}`,
      );
      // Repair stages are their own stages, never folded into the coder's.
      const repairKinds = new Set(fixture.metered.owned.map((owned) => owned.kind).filter((kind) => kind === 'ready-remediation' || kind === 'ci-fix' || kind === 'conflict-resolution'));
      for (const kind of repairKinds) {
        assert.equal(stages.filter((stage) => stage.stage === kind).length >= 1, true, `${issueId}: ${kind} reported as its own stage`);
      }
      // Egress carries no raw identifier: every task_cost is keyed on the row's
      // hashed task id, and the raw issue id appears nowhere in the row.
      for (const stage of stages) assert.equal(stage.task_cost.task_id, (row as { task_id: string }).task_id);
      assert.equal(JSON.stringify(row).includes(issueId), false, `${issueId}: raw issue id leaked into the row`);
      for (const owned of fixture.metered.owned) {
        assert.equal(JSON.stringify(row).includes(`"${owned.sessionRef}"`), false, `${issueId}: raw session id leaked`);
      }
    });
  }
});
