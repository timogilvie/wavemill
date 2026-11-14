// Replay the HOK-3474 storage layout after the real journey has merged/reaped.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readOwnershipRows } from '../../../../shared/lib/session-ownership.ts';
import { resolveClaudeProjectsDirsFor } from '../../../../shared/lib/session-adapters.ts';
import { encodeProjectDir } from '../../../../shared/lib/wavemill-session-paths.ts';
import { meterWorkflowCost } from '../../../../shared/lib/sdk-task-cost/meter.ts';
import { resolveStageExecutedModel } from '../../../../shared/lib/executed-model-resolver.ts';
import { detectSessionRedirects } from '../../../../shared/lib/intervention-detector.ts';

const [repoDir, issue] = process.argv.slice(2);
const archive = join(repoDir, '.wavemill', 'evals', 'artifacts', issue);
const ownership = readOwnershipRows(archive);
const coding = ownership.find(row => row.kind === 'coding');
assert.ok(coding?.cwd);
assert.equal(existsSync(coding.cwd), false, 'the real monitor must have reaped the worktree');
const branchName = JSON.parse(readFileSync(join(archive, 'terminal-record.json'), 'utf8')).branch;
const pricingTable = Object.fromEntries(ownership.map(row => [row.model, { inputCostPerMTok: 15, outputCostPerMTok: 75 }]));
const input = { repoDir, worktreePath: coding.cwd, branchName, issueId: issue, pricingTable,
  label: 'provider-replay', logger: { log() {}, warn() {} } };
const before = await meterWorkflowCost(input);
assert.equal(before.outcome.status, 'success');
const source = resolveClaudeProjectsDirsFor([coding.cwd], repoDir)
  .map(dir => join(dir, `${coding.sessionRef}.jsonl`)).find(existsSync);
assert.ok(source);
const providerDir = join(repoDir, '.wavemill', 'runs', issue, 'providers', 'deepseek', 'home', '.claude', 'projects', encodeProjectDir(coding.cwd));
mkdirSync(providerDir, { recursive: true });
renameSync(source, join(providerDir, `${coding.sessionRef}.jsonl`));
const after = await meterWorkflowCost(input);
assert.deepEqual(after.outcome, before.outcome, 'moving an owned transcript into its provider home cannot erase coding cost');
const identity = resolveStageExecutedModel({ repoDir, worktreePath: coding.cwd, branchName,
  featureDir: archive, stage: 'coding', existing: null });
assert.equal(identity.executedModel, coding.model);
assert.equal(identity.evidenceStatus, 'direct');
assert.equal(detectSessionRedirects(coding.cwd, branchName, issue, repoDir).transcriptsRead, true);
console.log('PASS: reaped provider transcript feeds SDK cost, executed identity and intervention scanning');

// HOK-3475: the canonical archive, rather than a surviving provider home,
// must supply the same facts after every original owned transcript is gone.
const redirects = detectSessionRedirects(coding.cwd, branchName, issue, repoDir);
for (const row of ownership.filter(row => row.harness === 'claude-code')) {
  for (const dir of resolveClaudeProjectsDirsFor([row.cwd || coding.cwd], repoDir)) {
    const file = join(dir, `${row.sessionRef}.jsonl`);
    if (existsSync(file)) rmSync(file);
  }
}
rmSync(join(repoDir, '.wavemill', 'runs'), { recursive: true, force: true });
assert.deepEqual((await meterWorkflowCost(input)).outcome, before.outcome, 'reaping original sources preserves SDK cost');
const retainedIdentity = resolveStageExecutedModel({ repoDir, worktreePath: coding.cwd, branchName,
  featureDir: archive, stage: 'coding', existing: null });
assert.equal(retainedIdentity.executedModel, coding.model);
assert.equal(retainedIdentity.evidenceStatus, 'direct');
const retainedRedirects = detectSessionRedirects(coding.cwd, branchName, issue, repoDir);
assert.equal(retainedRedirects.transcriptsRead, redirects.transcriptsRead);
assert.equal(retainedRedirects.count, redirects.count);
assert.deepEqual(retainedRedirects.details, redirects.details);
assert.deepEqual(retainedRedirects.timestamps, redirects.timestamps);
console.log('PASS: archive alone preserves SDK cost, executed identity and intervention facts');
