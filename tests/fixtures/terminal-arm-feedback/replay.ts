import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { meterWorkflowCost } from '../../../shared/lib/sdk-task-cost/meter.ts';

/** Retained incident facts in an isolated repo, with deterministic SDK-priced response charges. */
export async function createTerminalFeedbackReplay(repoDir: string) {
  const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'incident.json'), 'utf8'));
  const featureDir = join(repoDir, '.wavemill/evals/artifacts/REPLAY-1_c');
  mkdirSync(join(featureDir, 'native-sessions'), { recursive: true });
  writeFileSync(join(featureDir, '.challenge-aborted.json'), JSON.stringify(fixture.termination));
  writeFileSync(join(featureDir, '.routing-complete'), JSON.stringify(fixture.route));
  writeFileSync(join(featureDir, '.post-expansion-route.json'), JSON.stringify(fixture.expandedRoute));
  writeFileSync(join(featureDir, 'task-packet.md'), '# Task\n\n## Objective\nUnify observer attention projection and alerts.\n\n## Acceptance\nOne push matches one attention item.');
  writeFileSync(join(featureDir, '.planning-result.json'), JSON.stringify({ stage: 'planning', status: 'failed', agent: 'native', model: 'z-ai/glm-5.3', budgetExhausted: fixture.termination.budgetExhausted }));
  writeFileSync(join(featureDir, '.session-ownership.jsonl'), JSON.stringify({ schemaVersion: 1, type: 'launch', sessionRef: 'replay-planning', harness: 'native', kind: 'native-arm', stage: 'planning', model: 'z-ai/glm-5.3', launchedAt: '2026-11-08T23:04:40.989Z', attemptId: 'replay-plan', cwd: repoDir })+'\n');
  writeFileSync(join(featureDir, 'native-sessions/planning-REPLAY-1_c.jsonl'), fixture.events.map((e: object) => JSON.stringify(e)).join('\n')+'\n');
  const meteredCost = await meterWorkflowCost({ repoDir, worktreePath: repoDir, branchName: '', issueId: 'REPLAY-1_c', label: 'terminal-feedback-replay',
    exactPricing: { enabled: true, fetchGenerationCost: async () => ({ totalCostUsd: 0.01 }) } });
  return { record: fixture.record, featureDir, meteredCost };
}
