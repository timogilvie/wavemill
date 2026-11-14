/** Process-boundary checks run inside the killed-stage golden journey's fake world. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildWorkflowState } from '../../../lib/task-builder.ts';
import { createStateDirRetry } from '../../../../shared/lib/bounded-retry.ts';
import { classifyFailure } from '../../../../shared/lib/failure-policy.ts';
import type { RecoverySnapshot } from '../../../../shared/lib/task-recovery-controller.ts';

const root = resolve(import.meta.dirname, '../../../..');
const dir = process.argv[2];
mkdirSync(dir, { recursive: true });
const stateFile = join(dir, 'workflow-state.json');
writeFileSync(stateFile, JSON.stringify(buildWorkflowState({'JRN-1':{runId:'recovery-run',phase:'coding'}})));
const snapshotFile = join(dir, 'snapshot.json');
const failed: RecoverySnapshot = {
  issue:'JRN-1',stage:'coding',attempt:{currentRunId:'recovery-run',controlRunId:'recovery-run'},
  stageResult:{kind:'failed'},disposition:null,contractAvailable:true,outstandingEffect:null,wait:null,
  failure:{decision:classifyFailure({stage:'coding',detail:'unclassified exited agent'}),retry:'proceed'},
};
function invoke(snapshot: RecoverySnapshot, evidence: string) {
  writeFileSync(snapshotFile, JSON.stringify(snapshot));
  return JSON.parse(execFileSync(process.execPath, ['--import','tsx',join(root,'tools/task-recovery-controller.ts'),
    '--state-dir',dir,'--state-file',stateFile,'--snapshot',snapshotFile,'--evidence-id',evidence,'--owner-pid',String(process.pid)],
    {encoding:'utf8',cwd:root}));
}
function ack(token: string) {
  return JSON.parse(execFileSync(process.execPath, ['--import','tsx',join(root,'tools/task-recovery-controller.ts'),
    '--state-dir',dir,'--ack',token], {encoding:'utf8',cwd:root}));
}
// A fresh CLI process must preserve the same durable human hold.
const held = {...failed,wait:{owner:'human' as const,wake:'operator-release'}};
assert.equal(invoke(held,'hold-before-restart').decision.action,'wait');
assert.equal(invoke(held,'hold-after-restart').claim.claimed,false);
// Observer is disabled in this journey. Background activity must still wait.
assert.equal(JSON.parse(process.env.WAVEMILL_SESSION_CAPABILITIES_JSON!).observer,false);
assert.equal(invoke({...failed,failure:null,stageResult:{kind:'running'},disposition:{kind:'in-flight',reason:'background-work',
  evidenceConfidence:'high',waitingOn:{kind:'background'},blockingPrompt:null}},'background').decision.action,'wait');
// Effect succeeded but the old notifier never acknowledged: the restarted
// CLI consumes the authoritative completion and cannot claim a second retry.
const first = invoke(failed,'pre-effect');
assert.equal(first.claim.claimed,true);
writeFileSync(join(dir,'.coding-result.json'),JSON.stringify({stage:'coding',status:'completed',agent:'claude',
  startedAt:new Date().toISOString(),finishedAt:new Date(Date.now()+1000).toISOString()}));
const recovered = invoke(failed,'post-effect');
assert.equal(recovered.decision.action,'consume-advance');
assert.equal(recovered.claim.claimed,true);
assert.equal(ack(recovered.claim.claim.claimId).acknowledged,true);
assert.equal(invoke(failed,'post-effect').claim.claimed,false);
// The next failure remains recoverable, and a genuinely spent shared bucket
// escalates once instead of launching another model attempt.
writeFileSync(join(dir,'.coding-result.json'),JSON.stringify({stage:'coding',status:'failed',agent:'claude'}));
const retry = createStateDirRetry('stage-failure-coding',{maxAttempts:3,backoff:{baseSeconds:0,capSeconds:0}});
for(let i=0;i<3;i++) retry.increment(dir,'abcdef12');
const exhausted = {...failed,failure:{...failed.failure!,retry:retry.gate(dir,'abcdef12')}};
assert.equal(exhausted.failure.retry,'exhausted');
const escalation=invoke(exhausted,'spent-budget');
assert.equal(escalation.decision.action,'escalate');
assert.equal(escalation.claim.claimed,true);
assert.equal(ack(escalation.claim.claim.claimId).acknowledged,true);
assert.equal(invoke(exhausted,'spent-budget').claim.claimed,false);
console.log('PASS recovery across restarted CLI processes: human hold, background work, Observer off, applied effect, true exhaustion');
