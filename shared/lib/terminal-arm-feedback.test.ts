import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, mock } from 'node:test';
import { createTerminalFeedbackReplay } from '../../tests/fixtures/terminal-arm-feedback/replay.ts';
import { prepareTerminalArmFeedback } from './terminal-arm-feedback.ts';
import { toHokusaiSubmission } from './hokusai-schema.ts';
import { buildHokusaiV4Projection, triggerHokusaiSubmission, hokusaiSubmissionTriggerDeps } from './hokusai-submission-trigger.ts';
import { buildTechnicalTaskRouterRowV4 } from './hokusai-contribution-builder.ts';

// protects: terminal planning failures were persisted locally but excluded from every Hokusai contribution.
test('retained 160-turn failed planning incident becomes a verified, costed v4 completion failure', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'terminal-feedback-'));
  try {
    const world = await createTerminalFeedbackReplay(repoDir);
    const original = JSON.stringify(world.record);
    const options = { repoDir, meteredCost: world.meteredCost };
    assert.equal(toHokusaiSubmission(world.record).ok, false);
    const prepared = await prepareTerminalArmFeedback(world.record, options);
    const converted = toHokusaiSubmission(prepared.record);
    assert.equal(converted.ok, true);
    if (!converted.ok) return;
    const projection = buildHokusaiV4Projection(converted.submission, prepared.record, world.meteredCost, { repoDir, redactionSalt: 'test' });
    assert.ok(projection);
    const row = buildTechnicalTaskRouterRowV4(projection);
    assert.equal(row.completion_result, 'failure');
    assert.equal(row.actual_cost_usd, 1.6);
    assert.equal(row.stage_executions.length, 1);
    assert.equal(row.stage_executions[0].stage, 'planning');
    assert.equal(row.stage_executions[0].executed_model, 'z-ai/glm-5.3');
    assert.equal(row.stage_executions[0].model_evidence, 'provider_response');
    assert.equal(row.stage_executions[0].task_cost.turn_count, 160);
    assert.equal(row.inference_log_id, 'replay-routing-decision');
    assert.ok(row.overrides.some((o) => o.source === 'challenge' && o.role === 'planner' && o.to === 'z-ai/glm-5.3'));
    assert.equal(JSON.stringify(world.record), original, 'completion projection must not change output-quality/reward eligibility');
    const queued: unknown[] = [];
    mock.method(hokusaiSubmissionTriggerDeps, 'getHokusaiSubmissionConfig', () => ({ enabled: true }));
    mock.method(hokusaiSubmissionTriggerDeps, 'enqueueContribution', async (row: unknown) => { queued.push(row); return { status: 'duplicate' }; });
    try {
      const submitted = await triggerHokusaiSubmission(world.record, { ...options, redactionSalt: 'test' });
      assert.equal(submitted.status, 'duplicate');
      assert.equal(queued.length, 1, 'the normal trigger reaches its existing idempotent queue');
      assert.equal((queued[0] as { completion_result: string }).completion_result, 'failure');
    } finally { mock.restoreAll(); }

  } finally { rmSync(repoDir, { recursive: true, force: true }); }
});

// protects: completing the failure-feedback path must not turn infrastructure failures or intent into model observations.
for (const scenario of ['harness-fault', 'unknown-fault', 'missing-identity', 'wrong-model', 'missing-cost'] as const) {
  test(`terminal feedback retains the hold for ${scenario}`, async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'terminal-feedback-hold-'));
    try {
      const world = await createTerminalFeedbackReplay(repoDir);
      const path = join(world.featureDir, '.challenge-aborted.json');
      const termination = JSON.parse(readFileSync(path, 'utf8'));
      if (scenario === 'harness-fault') termination.reason = 'terminal_stage_failure:cancelled';
      if (scenario === 'unknown-fault') { termination.reason = 'terminal_stage_failure:native-stage-timeout'; delete termination.budgetExhausted; }
      writeFileSync(path, JSON.stringify(termination));
      if (scenario === 'missing-identity') rmSync(join(world.featureDir, 'native-sessions'), { recursive: true });
      if (scenario === 'wrong-model') world.record.modelId = 'deepseek-v4-pro';
      if (scenario === 'missing-cost') world.meteredCost.outcome = { status: 'adapter_error', reason: 'fixture measurement failure', diagnostics: { worktreePath: repoDir, branchName: '' } };
      const prepared = await prepareTerminalArmFeedback(world.record, { repoDir, meteredCost: world.meteredCost });
      assert.equal(prepared.record, world.record);
      assert.equal(toHokusaiSubmission(prepared.record).ok, false);
    } finally { rmSync(repoDir, { recursive: true, force: true }); }
  });
}

// protects: the recorder submits before cleanup has created the artifact archive.
test('live terminal feedback resolves the supplied feature directory before reap', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'terminal-feedback-live-'));
  try {
    const world = await createTerminalFeedbackReplay(repoDir);
    const featureDir = join(repoDir, 'features', 'a-live-task');
    mkdirSync(join(repoDir, 'features'));
    renameSync(world.featureDir, featureDir);
    const prepared = await prepareTerminalArmFeedback(world.record, { repoDir, featureDir, meteredCost: world.meteredCost });
    assert.equal(toHokusaiSubmission(prepared.record).ok, true);
    assert.equal(prepared.featureDir, featureDir);
  } finally { rmSync(repoDir, { recursive: true, force: true }); }
});
