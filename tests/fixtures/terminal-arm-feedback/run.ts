import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTerminalFeedbackReplay } from './replay.ts';
import { recordArmTermination } from '../../../shared/lib/arm-termination.ts';
import { prepareTerminalArmFeedback } from '../../../shared/lib/terminal-arm-feedback.ts';
import { toHokusaiSubmission } from '../../../shared/lib/hokusai-schema.ts';
import { buildHokusaiV4Projection } from '../../../shared/lib/hokusai-submission-trigger.ts';
import { buildTechnicalTaskRouterRowV4 } from '../../../shared/lib/hokusai-contribution-builder.ts';

const repoDir = mkdtempSync(join(tmpdir(), 'terminal-feedback-journey-'));
try {
  const world = await createTerminalFeedbackReplay(repoDir);
  const termination = JSON.parse(readFileSync(join(world.featureDir, '.challenge-aborted.json'), 'utf8'));
  const result = await recordArmTermination({ actor: 'monitor', issueId: 'REPLAY-1_c', kind: 'native-stage-timeout',
    stage: 'plan', model: 'z-ai/glm-5.3', featureDir: world.featureDir, repoDir, skipStateMutation: true,
    detail: termination.detail, budgetExhausted: termination.budgetExhausted });
  assert.equal(result.faultClass, 'model-fault');
  const record = readFileSync(join(repoDir, '.wavemill/evals/evals.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.id === result.evalRecordId);
  assert.ok(record);
  const prepared = await prepareTerminalArmFeedback(record, { repoDir, meteredCost: world.meteredCost });
  const converted = toHokusaiSubmission(prepared.record);
  assert.equal(converted.ok, true);
  if (!converted.ok) throw new Error('missing completion submission');
  const projection = buildHokusaiV4Projection(converted.submission, prepared.record, prepared.meteredCost!, { repoDir, redactionSalt: 'journey' });
  assert.ok(projection);
  const row = buildTechnicalTaskRouterRowV4(projection);
  assert.equal(row.completion_result, 'failure');
  assert.equal(row.actual_cost_usd, 1.6);
  assert.equal(row.stage_executions[0].executed_model, 'z-ai/glm-5.3');
  assert.equal(row.stage_executions[0].model_evidence, 'provider_response');
  console.log('terminal planning failure → recorder → retained evidence → eligible costed v4 failure: PASS');
} finally { rmSync(repoDir, { recursive: true, force: true }); }
