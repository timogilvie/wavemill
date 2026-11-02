// protects: real job failure/retry/persisted success has one read-only incident truth.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkflowState } from '../../lib/task-builder.ts';
import { launchJob, writeJobResultFile } from '../../../shared/lib/job-tracker.ts';
import { reconcileIncidents, parseArgs } from '../../../tools/observer.ts';
import { IncidentStore } from '../../../shared/lib/wavemill-incident-store.ts';
import { loadIncidentFixture } from '../../../shared/lib/incident-fixture-converter.ts';
const [mode, repoDir, gate] = process.argv.slice(2);
// HOK-3231: load the control job lineage from the converted real incident
// fixture instead of hand-writing it. If the fixture is missing or malformed
// the error names the file so an operator knows exactly where to look.
const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(__dirname, '../../fixtures/incident-replay/real/failed_background_job.json');
const incidentFixture = loadIncidentFixture(fixturePath);
const fixtureJob = incidentFixture.initialState.jobs[0];
assert.ok(fixtureJob && fixtureJob.kind === 'eval', `failed_background_job fixture must carry an eval job (got ${fixtureJob?.kind ?? 'none'})`);
const controlId = fixtureJob.id;
const controlReason = fixtureJob.reason ?? 'eval_not_persisted';
const controlIssueId = incidentFixture.initialState.task.issue;
if (mode === 'init') {
  const statePath = join(repoDir,'.wavemill/workflow-state.json');
  if (!existsSync(statePath)) writeFileSync(statePath, JSON.stringify(buildWorkflowState({})));
  const resultPath = join(repoDir, '.wavemill/jobs/control.result.json');
  writeJobResultFile(resultPath, {ok:false,persisted:false,exitCode:1,error:controlReason});
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
  if (records.some((record) => record.metadata.jobId && record.metadata.jobId !== controlId)) writeFileSync(gate,'observed authoritative failed job\n');
  if (mode === 'assert') {
    assert.ok(existsSync(gate), 'the real failing job was observed before retry success');
    const recovered = records.filter((record) => record.metadata.jobId && record.metadata.jobId !== controlId);
    assert.ok(recovered.length > 0);
    assert.ok(recovered.every((record) => record.lifecycle === 'resolved'), 'recovered attempts must leave the active alert projection');
    assert.ok(!projected.incidents?.some((record) => record.metadata.jobId && record.metadata.jobId !== controlId));
    const control = records.find((record) => record.metadata.jobId === controlId)!;
    assert.ok(control && control.lifecycle !== 'resolved', 'aborted control stays visible');
    assert.equal(control.occurrenceCount,1,'re-polling is not another failure');
  }
}
