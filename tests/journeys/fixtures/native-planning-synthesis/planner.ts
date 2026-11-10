// protects: a real native planner's budget-bound synthesis survives the monitor-to-merge chain.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchNativePlanning } from '../../../../shared/lib/native-agent/launch-planning.ts';
import { registerScriptedPiProvider } from '../../../../shared/lib/native-agent/provider.ts';

const [wtDir, slug, model] = process.argv.slice(2);
const featureDir = join(wtDir, 'features', slug);
const replay = JSON.parse(readFileSync(new URL('../../../fixtures/native-planning/hok3447-synthesis.json', import.meta.url), 'utf8')).replay;
const api = 'journey-planning-synthesis';
let turns = 0;
registerScriptedPiProvider({ api, turns: ctx => {
  turns++;
  if (turns < replay.maxTurns) return {
    content: [{ type: 'tool_call', id: `read-${turns}`, name: 'read_file', arguments: { path: `features/${slug}/task-packet.md` } }],
    stopReason: 'tool_calls', usage: { input: 10, output: 5 },
  };
  assert.equal((ctx.rawContext as { tools?: unknown[] }).tools?.length ?? 0, 0);
  assert.match(JSON.stringify(ctx.messages), /reserved terminal synthesis/);
  assert.match(JSON.stringify(ctx.messages), /Add journey-output.txt/);
  return { content: [{ type: 'text', text: [
    '# Implementation Plan', '## Phase 1',
    '- Add journey-output.txt containing the issue identifier.',
    '## Validation', '- Verify the file is committed and merged into the integration branch.',
    '## Release Readiness', '- **database_change_risk**: none', '- **env_changes**: none',
    '- **config_changes**: none', '- **manual_steps**: none',
  ].join('\n') }], stopReason: 'stop', usage: { input: 20, output: 10 } };
} });
await launchNativePlanning({
  wtDir, slug, repoDir: process.env.REPO_DIR!, issue: process.env.WAVEMILL_ISSUE!, session: process.env.WAVEMILL_SESSION!,
  loopModelOverride: { id: model, api, provider: 'scripted' },
  runTsxCommand: args => {
    // Routing is the scripted external edge; retain the already-selected stage contract.
    assert.equal(args[0].endsWith('route-task.ts'), true);
    const phase = JSON.parse(readFileSync(join(featureDir, '.phase-config.json'), 'utf8'));
    writeFileSync(args[args.indexOf('--output') + 1], JSON.stringify({ planner: phase.planning.model, coder: phase.coding.model, reviewer: phase.review.model, planDepth: 'medium', codeDepth: 'medium', reviewMode: 'llm' }));
    return '';
  },
});
assert.equal(turns, replay.maxTurns);
writeFileSync(join(featureDir, '.synthesis-assertions.json'), JSON.stringify({ turns, terminalTools: 0, retainedEvidence: true, planningResult: JSON.parse(readFileSync(join(featureDir, '.planning-result.json'), 'utf8')) }));
