// protects: real job failure/retry/persisted success has one read-only incident truth.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWorkflowState } from '../../lib/task-builder.ts';
import { launchJob, writeJobResultFile } from '../../../shared/lib/job-tracker.ts';
import { reconcileIncidents, parseArgs } from '../../../tools/observer.ts';
import { IncidentStore } from '../../../shared/lib/wavemill-incident-store.ts';
const [mode, repoDir, gate] = process.argv.slice(2);
const controlId = 'eval-incident-currentness-control';
const controlReason = 'eval_not_persisted';
const controlIssueId = 'HOK-3458';
if (mode === 'init') {
  const statePath = join(repoDir,'.wavemill/workflow-state.json');
  if (!existsSync(statePath)) writeFileSync(statePath, JSON.stringify(buildWorkflowState({})));
  const resultPath = join(repoDir, '.wavemill/jobs/control.result.json');
  await launchJob({statePath:join(repoDir,'.wavemill/workflow-state.json'),job:{
    id:controlId, kind:'eval', issueId:controlIssueId, side:'challenger', prNumbers:[1414],
    pid:0, timeoutSeconds:900, startedAt:'2026-09-15T14:34:00Z',finishedAt:'2026-09-15T14:34:42Z',
    logPath:join(repoDir,'.wavemill/control.log'),resultPath,status:'failed',exitCode:1,reason:controlReason,excerpt:null,settled:true,
  }});
} else {
  const snapshot = {timestamp:new Date().toISOString(),sessions:['journey'],panes:[],processes:[],
    repos:[{session:'journey',repoDir,tasks:[]}],findings:[]};
  const projected = await reconcileIncidents(snapshot, parseArgs([]));
  const store = new IncidentStore(join(repoDir,'.wavemill/incidents'));
  const records = await store.getAllIncidents();
  const resultPath = join(repoDir, '.wavemill/jobs/control.result.json');
  if (!existsSync(resultPath)) writeJobResultFile(resultPath, {ok:false,persisted:false,exitCode:1,error:controlReason});
  if (records.some((record) => record.metadata.jobId && record.metadata.jobId !== controlId)) writeFileSync(gate,'observed authoritative failed job\n');
  if (mode === 'assert') {
    assert.ok(existsSync(gate), 'the real failing job was observed before retry success');
    const recovered = records.filter((record) => record.metadata.jobId && record.metadata.jobId !== controlId);
    assert.ok(recovered.length > 0);
    assert.ok(recovered.every((record) => record.lifecycle === 'resolved'), 'recovered attempts must leave the active alert projection');
    assert.ok(!projected.incidents?.some((record) => record.metadata.jobId && record.metadata.jobId !== controlId));
    const control = records.find((record) => record.metadata.jobId === controlId)!;
    assert.ok(control && control.lifecycle !== 'resolved', 'aborted control stays visible');
    assert.ok(existsSync(resultPath), 'the failed eval result artifact appears after its first observation');
    assert.equal(control.occurrenceCount,1,'re-polling is not another failure');
    assert.equal(records.filter((record) => record.metadata.jobId === controlId).length, 1, 'result appearance must update the existing attempt incident');
    const attemptFindings = projected.findings.filter((finding) => finding.evidence.includes(`incident=${control.fingerprint}`));
    assert.equal(attemptFindings.length, 1, 'the observer projects one attention finding for the attempt');
  }
}
