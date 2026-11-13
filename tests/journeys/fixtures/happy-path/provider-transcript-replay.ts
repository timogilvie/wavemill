// Replay the HOK-3474 storage layout after the real journey has merged/reaped.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
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
