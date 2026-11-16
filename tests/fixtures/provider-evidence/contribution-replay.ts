/** Reconstructed, deterministic two-turn failure from retained execution facts. */
import { createTerminalFeedbackReplay } from '../terminal-arm-feedback/replay.ts';
import { prepareTerminalArmFeedback } from '../../../shared/lib/terminal-arm-feedback.ts';
import { toHokusaiSubmission } from '../../../shared/lib/hokusai-schema.ts';
import { buildHokusaiV4Projection } from '../../../shared/lib/hokusai-submission-trigger.ts';
import { buildTechnicalTaskRouterRowV4 } from '../../../shared/lib/hokusai-contribution-builder.ts';

export async function createProviderContributionReplay(repoDir: string) {
  const world = await createTerminalFeedbackReplay(repoDir, 2);
  const prepared = await prepareTerminalArmFeedback(world.record, { repoDir, meteredCost: world.meteredCost });
  const converted = toHokusaiSubmission(prepared.record);
  if (!converted.ok) throw new Error('Replay failed contribution conversion');
  const projection = buildHokusaiV4Projection(converted.submission, prepared.record, world.meteredCost, { repoDir, redactionSalt: 'provider-evidence-replay' });
  if (!projection) throw new Error('Replay has no stage executions');
  const row = buildTechnicalTaskRouterRowV4(projection);
  // The SDK owns collection time; pin it only in this reconstructed replay.
  for (const stage of row.stage_executions) stage.task_cost.collected_at = world.record.timestamp;
  return row;
}
