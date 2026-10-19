import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeCostStatistics } from '../eval-aggregator.ts';
import { attachTaskCostSummaries, attachWorkflowCostMetadata } from '../eval-record-builder.ts';
import { SCHEMA_VERSION, type EvalRecord } from '../eval-schema.ts';
import { formatCostDisplay, formatWorkflowCostOutcome } from '../eval-summary-printer.ts';
import { validateEvalRecord } from '../eval-validator.ts';
import { toHokusaiSubmission } from '../hokusai-schema.ts';
import { buildSdkTaskCostSummaries } from './collect.ts';
import type { TaskCostSummaryV1 } from './contract.ts';
import { loadSdkTaskCostFixture } from './fixtures.ts';
import { projectTaskCostSummaryToWorkflowCost, selectPrimaryTaskCostSummary } from './project.ts';

function summaries(name: string): TaskCostSummaryV1[] {
  const fixture = loadSdkTaskCostFixture(name);
  const result = buildSdkTaskCostSummaries({
    scanResults: fixture.scanResults,
    taskId: fixture.taskId,
    pricingTable: fixture.pricingTable,
    now: () => new Date(fixture.now),
  });
  assert.ok(result, `${name} produced no summaries`);
  return result;
}

function project(name: string) {
  const fixture = loadSdkTaskCostFixture(name);
  return projectTaskCostSummaryToWorkflowCost(summaries(name)[0], { pricingTable: fixture.pricingTable });
}

function baseRecord(): EvalRecord {
  return {
    id: 'eval-sdk-projection',
    schemaVersion: SCHEMA_VERSION,
    originalPrompt: 'Implement the change',
    modelId: 'claude-opus-4',
    modelVersion: 'claude-opus-4',
    score: 0.9,
    scoreBand: 'Minor Feedback',
    timeSeconds: 60,
    timestamp: '2026-10-01T00:00:00.000Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'ok',
  } as EvalRecord;
}

describe('projectTaskCostSummaryToWorkflowCost', () => {
  it('projects a complete Claude Code summary into the legacy shape', () => {
    const outcome = project('claude-success');
    assert.equal(outcome.status, 'success');
    assert.equal(outcome.totalCostUsd, 0.085125);
    assert.equal(outcome.sessionCount, 1);
    assert.equal(outcome.turnCount, 2);
    assert.deepEqual(outcome.models['claude-opus-4'], {
      inputTokens: 3000, cacheCreationTokens: 100, cacheReadTokens: 500, outputTokens: 500, costUsd: 0.085125,
    });
    assert.deepEqual(Object.keys(outcome.pricingUsed), ['claude-opus-4']);
    assert.equal(outcome.attribution?.source, 'claude');
    assert.equal(outcome.attribution?.coverage, 'complete');
    assert.equal(outcome.attribution?.reason, undefined);
    assert.equal(outcome.attribution?.models[0].pricingSource, 'local_estimate');
    assert.equal(outcome.attribution?.models[0].priced, true);
  });

  it('re-folds Codex reasoning into output tokens like the legacy models view', () => {
    const outcome = project('codex-reasoning-and-cache');
    assert.equal(outcome.models['gpt-5-codex'].outputTokens, 225);
    assert.equal(outcome.attribution?.source, 'codex');
    // Codex has no cache-write category: a structural 0, not a gap.
    assert.equal(outcome.attribution?.coverage, 'complete');
    assert.equal(outcome.attribution?.reason, undefined);
  });

  it('names the gap on a partial record instead of a bare mixed_coverage', () => {
    const outcome = project('native-unpriced-model');
    assert.equal(outcome.attribution?.coverage, 'partial');
    assert.equal(outcome.attribution?.reason, 'unpriced_model');
  });

  it('keeps provider-reported cost distinguishable from the estimate', () => {
    const outcome = project('native-provider-reported');
    const [model] = outcome.attribution!.models;
    assert.equal(outcome.totalCostUsd, 0.005);
    assert.equal(model.providerReportedCostUsd, 0.005);
    assert.equal(model.pricingSource, 'openrouter_api');
    assert.deepEqual(outcome.pricingUsed, {}, 'no estimate → no pricing snapshot');

    const mixed = project('native-untrusted-zero-cost');
    assert.equal(mixed.attribution!.models[0].pricingSource, 'mixed');
    assert.ok(Math.abs(mixed.totalCostUsd - 0.00238) < 1e-12);
  });

  it('reports unpriced work as a zero lower bound with truthful attribution', () => {
    const outcome = project('native-unpriced-model');
    assert.equal(outcome.totalCostUsd, 0);
    assert.equal(outcome.attribution?.models[0].priced, false);
    assert.equal(outcome.attribution?.models[0].reason, 'unpriced_model');
    assert.equal(outcome.attribution?.models[0].costUsd, undefined);
    assert.equal(outcome.attribution?.unpricedSessions, 1);
  });

  it('carries the legacy reason for unavailable and known-zero coverage', () => {
    const unavailable = project('native-missing-usage');
    assert.equal(unavailable.attribution?.coverage, 'unavailable');
    assert.equal(unavailable.attribution?.reason, 'invalid_token_usage');

    const knownZero = project('native-known-zero');
    assert.equal(knownZero.attribution?.coverage, 'known_zero');
    assert.equal(knownZero.attribution?.reason, undefined);
    assert.equal(knownZero.totalCostUsd, 0);
  });
});

describe('selectPrimaryTaskCostSummary', () => {
  it('prefers native, then the agent type harness, then the first summary', () => {
    const multi = summaries('multi-harness');
    const native = summaries('native-provider-reported');
    assert.equal(selectPrimaryTaskCostSummary([...multi, ...native], 'claude')?.harness, 'native');
    assert.equal(selectPrimaryTaskCostSummary(multi, 'codex')?.harness, 'codex');
    assert.equal(selectPrimaryTaskCostSummary(multi, 'claude-deepseek')?.harness, 'claude-code');
    assert.equal(selectPrimaryTaskCostSummary(multi, undefined)?.harness, 'claude-code');
    assert.equal(selectPrimaryTaskCostSummary(null), null);
    assert.equal(selectPrimaryTaskCostSummary([]), null);
  });
});

describe('SDK-backed eval records through existing readers', () => {
  it('validates, renders, aggregates, and never reaches the Hokusai submission', () => {
    const fixture = loadSdkTaskCostFixture('claude-success');
    const taskCostSummary = summaries('claude-success');
    const record = baseRecord();
    attachWorkflowCostMetadata(record, projectTaskCostSummaryToWorkflowCost(taskCostSummary[0], {
      pricingTable: fixture.pricingTable,
    }));
    attachTaskCostSummaries(record, taskCostSummary);

    const schemaIssues = validateEvalRecord(record, { file: 'test', line: 1 })
      .filter((issue) => issue.code === 'SCHEMA_VIOLATION');
    assert.deepEqual(schemaIssues, []);

    // Claude Code runs on a subscription: the dollars are an estimate (HOK-3076).
    assert.equal(formatCostDisplay(record.workflowCost, record.workflowCostAttribution), ', workflow cost: ~$0.0851 (estimate)');
    assert.equal(
      formatWorkflowCostOutcome(record.workflowCost!, 2, 1, record.workflowCostAttribution),
      'workflow cost ~$0.0851 (estimate) (2 turns across 1 session(s))',
    );
    const stats = computeCostStatistics([record, baseRecord()]);
    assert.equal(stats.recordsWithCost, 1);
    assert.equal(stats.workflowCostStatusDistribution.success, 1);

    const submission = toHokusaiSubmission(record);
    const serialized = JSON.stringify(submission);
    assert.equal(serialized.includes('taskCostSummary'), false);
    assert.equal(serialized.includes('task_cost_summary/v1'), false);
    assert.equal(serialized.includes(taskCostSummary[0].event_ids[0]), false);
  });
});
