// protects: observer/worker revision drift, untracked or duplicate investigation
// launches, symptom-only filing, and a persisted result lost after restart.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {IncidentStore} from '../../../../shared/lib/wavemill-incident-store.ts';
import {createIncidentDraft} from '../../../../shared/lib/wavemill-incident-model.ts';
import {loadIncidentFixture} from '../../../../shared/lib/incident-fixture-converter.ts';
import {reconcileIncidentCycle} from '../../../../shared/lib/incident-reconcile-cycle.ts';
import {loadInvestigationOutcome} from '../../../../shared/lib/root-cause-escalation.ts';
import {syncIncident,DEFAULT_INCIDENT_LINEAR_CONFIG} from '../../../../shared/lib/incident-to-linear-synchronizer.ts';
import {parseArgs,queueRootCauseInvestigations} from '../../../../tools/observer.ts';
const [action,repoDir]=process.argv.slice(2);
const store=new IncidentStore(join(repoDir,'.wavemill/incidents'),{escalationThreshold:1});
const payloadDir=process.env.FAKE_INVESTIGATION_PAYLOAD_DIR!;
const fp=(n:number)=>String(n).repeat(64);
const snapshot={timestamp:new Date().toISOString(),sessions:[],panes:[],processes:[],repos:[{session:process.env.SESSION!,repoDir,tasks:[]}],findings:[]};
const options=parseArgs(['--file-incidents','--incidents-mode','live','--repo-dir',repoDir]);
const config={...DEFAULT_INCIDENT_LINEAR_CONFIG,enabled:true,mode:'live' as const,detectionOnly:false,team:'JRN',project:undefined,requestDelayMs:0,updateCooldownMinutes:0};
if(action==='seed') {
 mkdirSync(payloadDir,{recursive:true});
 const manifest:Record<number,string>={};
 // The first two classes come from the sanitized 2026-10-27 operator audit.
 // Their recorded evidence crosses the real IncidentStore cycle before dispatch.
 const fixtureDir=join(dirname(fileURLToPath(import.meta.url)),'../../../fixtures/incident-replay/real/defect-escalation');
 for(const [n,cls,owner] of [[1,'cleanup_dirty_worktree','JRN-3312'],[2,'stale_dependency_install','JRN-3315'],[3,'observer_crash',null],[4,'observer_crash',null]] as const) {
   const fixture=n<3?loadIncidentFixture(join(fixtureDir,`${cls}.json`)):null;
   const incident=createIncidentDraft({id:`audit-${n}`,fingerprint:fp(n),category:n<3?'stale_orphaned_state':'product_defect',severity:'high',confidence:'definite',lifecycle:'active',createdAt:'2026-10-27T12:00:00Z',lastObservedAt:'2026-10-27T12:00:00Z',occurrenceCount:1,rootCauseClass:cls,summary:fixture?.incident.summary??`Novel artifact parser defect ${n}`,operatorAction:'Investigate the shared owner',evidence:fixture?.observations[0]?.evidence??[{type:'log_excerpt',source:'fixture.log',timestamp:'2026-10-27T12:00:00Z',redactedData:'parser failed',key:`novel-${n}`}],metadata:{knownIssueIds:owner?[owner]:[],thresholdTriggered:true}});
   const cycle=await reconcileIncidentCycle({store,repoDir,candidates:[incident],cycleComplete:false});
   assert.equal(cycle.errors.length,0);
   const actualFingerprint=cycle.incidents[0].fingerprint;
   manifest[n]=actualFingerprint;
   const payload={incidentFingerprint:actualFingerprint,mode:owner?'append_to_owner':'new_consolidation',...(owner?{targetIssueId:owner}:{}),title:'One artifact reader: share validation and delete private parsing',sections:{why:'Recorded audit evidence identifies duplicated readers.\n| Site | Signal | Outcome |\n| reader A | raw JSON | throw |\n| reader B | schema | verdict |',change:'Use the existing shared reader; delete the private parser.',notInScope:'No new model or recovery policy.',acceptance:'Replay the incident through the shared reader.'},primitivesTable:'| Decision | Primitive |\n| Read evidence | schema validator |',modelId:'claude-sonnet-5',provider:'claude',generatedAt:new Date().toISOString()};
   writeFileSync(join(payloadDir,`${actualFingerprint}.json`),n===4?'invalid model output':JSON.stringify(payload));
 }
 writeFileSync(join(payloadDir,'manifest.json'),JSON.stringify(manifest));
 await queueRootCauseInvestigations(snapshot,options);
} else if(action==='sync') {
 for(const incident of await store.getIncidents()) {
   const investigation=loadInvestigationOutcome(incident,repoDir);
   assert.ok(investigation,'tracked worker result must be readable using the observer revision');
   const result=await syncIncident({incident,store,repoDir,config,investigation});
   assert.notEqual(result.action,'failed',result.reason);
 }
 // A fresh consumer process reuses the persisted result, never another LLM.
 await queueRootCauseInvestigations(snapshot,options);
} else if(action==='assert') {
 const truth=JSON.parse(readFileSync(process.env.FAKE_LINEAR_STATE!,'utf8'));
 assert.equal(truth.comments?.length,2,'one comment per existing owner, no repeat writes');
 assert.deepEqual(truth.comments.map((c:any)=>c.issueId).sort(),['issue-JRN-3312','issue-JRN-3315']);
 const novel=Object.values(truth.issues).filter((i:any)=>i.title.startsWith('One artifact reader')) as any[];
 assert.equal(novel.length,1,'one deduplicated consolidation');
 for(const section of ['## Why','## Change','## Not in scope','## Acceptance']) assert.ok(novel[0].description.includes(section));
 assert.ok(novel[0].labels.some((l:string)=>l.startsWith('incident:fingerprint:')),'fingerprint label');
 const draft=JSON.parse(readFileSync(join(repoDir,'.wavemill/incidents',JSON.parse(readFileSync(join(payloadDir,'manifest.json'),'utf8'))[4],'draft.json'),'utf8'));
 assert.equal(draft.mode,'draft');
 const jobs=Object.values(JSON.parse(readFileSync(join(repoDir,'.wavemill/workflow-state.json'),'utf8')).jobs) as any[];
 assert.equal(jobs.filter(j=>j.kind==='root-cause-investigation').length,4,'all investigations supervised by tracker');
 console.log('PASS audit owners, novel consolidation, draft, persisted dedup and tracked worker');
}
