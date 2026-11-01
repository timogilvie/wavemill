import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  appendArmReliabilityRecord,
  buildArmReliabilityRecord,
  readArmReliabilityRecords,
  resolveReliabilityRecordsFile,
} from './arm-reliability.ts';

test('appends and reads arm reliability records from repo evals dir', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'arm-reliability-'));
  try {
    const record = appendArmReliabilityRecord({
      issueId: 'HOK-2764_c',
      challengePairId: 'HOK-2764',
      challengeRole: 'challenger',
      stage: 'coding',
      model: 'qwen-2.5-coder-32b',
      abortReason: 'terminal_stage_failure:tool-use-unsupported',
      detail: '404 No endpoints found that support tool use',
      nextAction: 'route this stage to a tool-capable model',
      id: 'fixed-id',
      timestamp: '2026-08-19T00:00:00.000Z',
    }, repoDir);

    assert.equal(record.failureKind, 'tool-use-unsupported');
    assert.equal(record.faultClass, 'selection-fault');
    assert.equal(record.qualitySignalEligible, false);
    assert.equal(resolveReliabilityRecordsFile(repoDir).endsWith('.wavemill/evals/reliability-records.jsonl'), true);

    const records = readArmReliabilityRecords(repoDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].id, 'fixed-id');
    assert.equal(records[0].completed, false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('skips malformed JSONL lines and duplicate retry records', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'arm-reliability-'));
  try {
    appendArmReliabilityRecord({
      issueId: 'HOK-2766_c',
      challengePairId: 'HOK-2766',
      challengeRole: 'challenger',
      stage: 'coding',
      model: 'glm-5.2',
      abortReason: 'terminal_stage_failure:native-provider-error',
      detail: 'Stream ended without finish_reason',
    }, repoDir);
    appendArmReliabilityRecord({
      issueId: 'HOK-2766_c',
      challengePairId: 'HOK-2766',
      challengeRole: 'challenger',
      stage: 'coding',
      model: 'glm-5.2',
      abortReason: 'terminal_stage_failure:native-provider-error',
      detail: 'Stream ended without finish_reason',
    }, repoDir);
    appendFileSync(resolveReliabilityRecordsFile(repoDir), 'not json\n', 'utf-8');

    const records = readArmReliabilityRecords(repoDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].faultClass, 'model-fault');
    assert.equal(records[0].qualitySignalEligible, true);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// protects: a budget-exhausted arm's reliability record losing the fact, or carrying a hardcoded class (HOK-3362)
test('derives the fault class from the budget fact and keeps the fact on the record', () => {
  const fact = {
    kind: 'wall_clock',
    stopReason: 'wall_clock_limit',
    limit: 3_600_000,
    used: 3_600_000,
    progress: { turnsCompleted: 145, toolCallsExecuted: 230, wallClockMs: 3_600_000, providerErrorRetries: 0 },
  } as const;
  const progressing = buildArmReliabilityRecord({
    issueId: 'HOK-3329_c',
    challengePairId: 'HOK-3329',
    challengeRole: 'challenger',
    stage: 'coding',
    model: 'glm-5.3-flash',
    abortReason: 'retry_exhausted:native-stage-timeout',
    budgetExhausted: JSON.stringify(fact),
  });
  assert.equal(progressing.failureKind, 'native-stage-timeout');
  assert.equal(progressing.faultClass, 'model-fault');
  assert.deepEqual(progressing.budgetExhausted, fact);

  const stalled = buildArmReliabilityRecord({
    issueId: 'HOK-3329_c',
    challengePairId: 'HOK-3329',
    challengeRole: 'challenger',
    stage: 'review',
    model: 'glm-5.3-flash',
    abortReason: 'retry_exhausted:native-review-timeout',
    budgetExhausted: {
      ...fact,
      progress: { turnsCompleted: 0, toolCallsExecuted: 0, wallClockMs: 300_000, providerWaitMs: 299_000 },
    },
  });
  assert.equal(stalled.faultClass, 'provider-fault');

  const historical = buildArmReliabilityRecord({
    issueId: 'HOK-3329_c',
    challengePairId: 'HOK-3329',
    challengeRole: 'challenger',
    stage: 'review',
    model: 'glm-5.3-flash',
    abortReason: 'retry_exhausted:native-review-timeout',
    budgetExhausted: '{"kind":"nope"}',
  });
  assert.equal(historical.faultClass, 'unknown-fault');
  assert.equal(historical.budgetExhausted, undefined);
});
