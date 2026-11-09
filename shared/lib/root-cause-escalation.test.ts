import assert from 'node:assert/strict';
import { writeFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  investigateConfirmedIncident,
  investigationEvidenceRevision,
  loadInvestigationOutcome,
  preparePayloadForTransport,
  renderInvestigatedCommentBody,
  renderInvestigatedIssueBody,
  type InvestigationPayload,
} from './root-cause-escalation.ts';
import { createIncidentDraft, type IncidentRecord } from './wavemill-incident-model.ts';
import { DEFAULT_INCIDENT_LINEAR_CONFIG, type ObserverLinearConfig } from './incident-to-linear-synchronizer.ts';
import type { IncidentFilingReconciliation } from './incident-filing-reconciler.ts';
import type { LLMCallResult } from './llm-cli.ts';

function makeIncident(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return createIncidentDraft({
    id: 'incident-1',
    fingerprint: 'f'.repeat(64),
    taskId: 'HOK-1',
    session: 'wavemill',
    category: 'product_defect',
    severity: 'high',
    confidence: 'definite',
    lifecycle: 'active',
    createdAt: '2026-08-04T12:00:00.000Z',
    lastObservedAt: '2026-08-04T12:10:00.000Z',
    occurrenceCount: 3,
    rootCauseClass: 'observer_crash',
    summary: 'Observer crashed while reading artifact.',
    operatorAction: 'Fix artifact parsing and add a regression test.',
    evidence: [{
      type: 'log_excerpt',
      source: '/Users/timothy/project/.wavemill/logs/mill.log',
      timestamp: '2026-08-04T12:10:00.000Z',
      lineNumber: 42,
      redactedData: 'ERROR token=supersecret model=gpt-test user=person@example.com',
      key: 'crash',
    }],
    metadata: { thresholdTriggered: true, escalatedAt: '2026-08-04T12:10:00.000Z' },
    ...overrides,
  });
}

function confirmedActive(): IncidentFilingReconciliation {
  return { outcome: 'confirmed_active', evidence: { jobId: 'job-1', status: 'failed' } };
}

function recovered(): IncidentFilingReconciliation {
  return { outcome: 'recovered', evidence: { jobId: 'job-1', status: 'succeeded' } };
}

function makeRunner(payload: InvestigationPayload) {
  return async (): Promise<LLMCallResult> => ({
    text: JSON.stringify(payload),
    rawOutput: JSON.stringify(payload),
    model: 'gpt-test',
    provider: 'codex',
    costUsd: 0.001,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  });
}

function config(): ObserverLinearConfig {
  return { ...DEFAULT_INCIDENT_LINEAR_CONFIG, enabled: true, team: 'HOK', project: 'Wavemill' };
}

test('investigateConfirmedIncident skips non-active reconciliations', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rce-'));
  try {
    const outcome = await investigateConfirmedIncident({
      incident: makeIncident(),
      repoDir: tmp,
      reconciliation: recovered(),
    });
    assert.equal(outcome.state, 'skipped');
    assert.equal(outcome.reason, 'reconciliation: recovered');
    assert.equal(outcome.payload, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('investigateConfirmedIncident returns ready for append_to_owner payload', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rce-'));
  try {
    const payload: InvestigationPayload = {
      incidentFingerprint: 'f'.repeat(64),
      mode: 'append_to_owner',
      targetIssueId: 'HOK-3315',
      title: 'Append evidence to dependency drift owner',
      sections: { why: 'why', change: 'change', notInScope: 'not in scope', acceptance: 'acceptance' },
      modelId: 'gpt-test',
      provider: 'codex',
      generatedAt: new Date().toISOString(),
    };
    const outcome = await investigateConfirmedIncident({
      incident: makeIncident(),
      repoDir: tmp,
      reconciliation: confirmedActive(),
      runInvestigation: makeRunner(payload),
    });
    assert.equal(outcome.state, 'ready');
    assert.equal(outcome.payload?.mode, 'append_to_owner');
    assert.equal(outcome.payload?.targetIssueId, 'HOK-3315');
    const incidentFiles = readdirSync(join(tmp, '.wavemill', 'incidents', 'f'.repeat(64)));
    assert.ok(incidentFiles.some((name) => name.startsWith('investigation-') && name.endsWith('.json')));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('investigateConfirmedIncident returns ready for new_consolidation payload', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rce-'));
  try {
    const payload: InvestigationPayload = {
      incidentFingerprint: 'f'.repeat(64),
      mode: 'new_consolidation',
      title: 'One observer crash decision',
      sections: { why: 'why', change: 'change', notInScope: 'not in scope', acceptance: 'acceptance' },
      primitivesTable: '| Decision | Primitive |\n| a | b |',
      modelId: 'gpt-test',
      provider: 'codex',
      generatedAt: new Date().toISOString(),
    };
    const outcome = await investigateConfirmedIncident({
      incident: makeIncident(),
      repoDir: tmp,
      reconciliation: confirmedActive(),
      runInvestigation: makeRunner(payload),
    });
    assert.equal(outcome.state, 'ready');
    assert.equal(outcome.payload?.mode, 'new_consolidation');
    assert.match(outcome.payload?.title ?? '', /^One /);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('investigateConfirmedIncident drafts missing sections and reuses artefact', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rce-'));
  try {
    let calls = 0;
    const runner = async (): Promise<LLMCallResult> => {
      calls += 1;
      return {
        rawOutput: '',
        text: JSON.stringify({
          incidentFingerprint: 'f'.repeat(64),
          mode: 'new_consolidation',
          title: 'Bad',
          sections: { why: 'why', change: 'change', notInScope: 'not in scope' },
          modelId: 'gpt-test',
          provider: 'codex',
          generatedAt: new Date().toISOString(),
        }),
        model: 'gpt-test',
        provider: 'codex',
            costUsd: 0.001,
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      };
    };
    const incident = makeIncident();
    const first = await investigateConfirmedIncident({
      incident,
      repoDir: tmp,
      reconciliation: confirmedActive(),
      runInvestigation: runner,
    });
    assert.equal(first.state, 'draft');
    assert.equal(calls, 1);
    const second = await investigateConfirmedIncident({
      incident,
      repoDir: tmp,
      reconciliation: confirmedActive(),
      runInvestigation: runner,
    });
    assert.equal(second.state, 'draft');
    assert.equal(calls, 1); // reused artefact
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('investigateConfirmedIncident drafts malformed model output', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rce-'));
  try {
    const outcome = await investigateConfirmedIncident({
      incident: makeIncident(),
      repoDir: tmp,
      reconciliation: confirmedActive(),
      runInvestigation: async () => ({
        rawOutput: '',
        text: 'not json',
        model: 'gpt-test',
        provider: 'codex',
            costUsd: 0.001,
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }),
    });
    assert.equal(outcome.state, 'draft');
    assert.equal(outcome.payload?.mode, 'draft');
    assert.deepEqual(outcome.payload?.missingEvidence, ['model_output_malformed']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('preparePayloadForTransport routes outcomes correctly', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rce-'));
  try {
    const incident = makeIncident();
    const skip = preparePayloadForTransport({
      incident,
      payload: null,
      reconciliation: confirmedActive(),
      state: 'pending',
    }, tmp);
    assert.equal(skip.kind, 'skip');
    assert.equal(skip.reason, 'investigation_pending');

    const recoveredOutcome = await investigateConfirmedIncident({
      incident,
      repoDir: tmp,
      reconciliation: recovered(),
    });
    const skip2 = preparePayloadForTransport(recoveredOutcome, tmp);
    assert.equal(skip2.kind, 'skip');

    const ready: InvestigationPayload = {
      incidentFingerprint: incident.fingerprint,
      mode: 'new_consolidation',
      title: 'One issue',
      sections: { why: 'w', change: 'c', notInScope: 'n', acceptance: 'a' },
      modelId: 'gpt-test',
      provider: 'codex',
      generatedAt: new Date().toISOString(),
    };
    const transport = preparePayloadForTransport({
      incident,
      payload: ready,
      reconciliation: confirmedActive(),
      state: 'ready',
    }, tmp);
    assert.equal(transport.kind, 'transport');
    assert.equal(transport.title, 'One issue');
    assert.match(transport.body, /## Why/);

    const draft: InvestigationPayload = {
      incidentFingerprint: incident.fingerprint,
      mode: 'draft',
      title: 'Draft',
      sections: { why: '', change: '', notInScope: '', acceptance: '' },
      missingEvidence: ['missing_change'],
      modelId: 'gpt-test',
      provider: 'codex',
      generatedAt: new Date().toISOString(),
    };
    const draftResult = preparePayloadForTransport({
      incident,
      payload: draft,
      reconciliation: confirmedActive(),
      state: 'draft',
    }, tmp);
    assert.equal(draftResult.kind, 'draft');
    assert.ok(existsSync(draftResult.draftPath));
    assert.ok(draftResult.draftPath.startsWith(tmp));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('renderInvestigatedIssueBody requires non-draft payload', () => {
  const payload: InvestigationPayload = {
    incidentFingerprint: 'f'.repeat(64),
    mode: 'draft',
    title: 'Draft',
    sections: { why: '', change: '', notInScope: '', acceptance: '' },
    missingEvidence: ['x'],
    modelId: 'gpt-test',
    provider: 'codex',
    generatedAt: new Date().toISOString(),
  };
  assert.throws(() => renderInvestigatedIssueBody(makeIncident(), payload), /draft/);
});

test('renderInvestigatedCommentBody renders append payload', () => {
  const payload: InvestigationPayload = {
    incidentFingerprint: 'f'.repeat(64),
    mode: 'append_to_owner',
    targetIssueId: 'HOK-3315',
    title: 'Append',
    sections: { why: 'w', change: 'c', notInScope: 'n', acceptance: 'a' },
    modelId: 'gpt-test',
    provider: 'codex',
    generatedAt: new Date().toISOString(),
  };
  const body = renderInvestigatedCommentBody(makeIncident(), payload, config(), 'rev-1', new Date('2026-08-04T12:15:00.000Z'));
  assert.match(body, /Root-Cause Evidence Update/);
  assert.doesNotMatch(body, /supersecret/);
});

// protects: three revision spellings caused Observer to re-launch completed
// investigations and the synchronizer to read an older, unrelated payload.
test('worker and observer share the store revision; a new revision requires fresh evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'investigation-revision-'));
  try {
    const incident = makeIncident();
    const { IncidentStore } = await import('./wavemill-incident-store.ts');
    const expected = new IncidentStore(join(dir, '.wavemill/incidents')).computeEvidenceRevision(incident);
    assert.equal(investigationEvidenceRevision(incident, dir), expected);
    let calls = 0;
    const payload: InvestigationPayload = {incidentFingerprint:incident.fingerprint,mode:'new_consolidation',title:'One reader: share validation',sections:{why:'why',change:'delete private reader',notInScope:'no policy',acceptance:'replay'},modelId:'gpt-test',provider:'codex',generatedAt:new Date().toISOString()};
    const runInvestigation = async () => { calls++; return makeRunner(payload)(); };
    const first = await investigateConfirmedIncident({incident,repoDir:dir,reconciliation:confirmedActive(),runInvestigation});
    assert.equal(first.state,'ready');
    assert.equal(loadInvestigationOutcome(incident,dir)?.state,'ready');
    await investigateConfirmedIncident({incident,repoDir:dir,reconciliation:confirmedActive(),runInvestigation});
    assert.equal(calls,1);
    const revised = {...incident,occurrenceCount:incident.occurrenceCount+1};
    assert.equal(loadInvestigationOutcome(revised,dir),null,'never reuse a result from another evidence revision');
    const artifact = join(dir,'.wavemill/incidents',incident.fingerprint,`investigation-${expected}.json`);
    writeFileSync(artifact,JSON.stringify({...payload,sections:{}}));
    assert.equal(loadInvestigationOutcome(incident,dir),null,'schema-invalid cached artifacts cannot authorize a write');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

// protects: the 2026-10-27 audit's known defects being filed as new symptom
// bugs instead of contributing evidence to their existing consolidation owner.
test('sanitized operator-audit fixtures replay and append once to their known owners', async () => {
  const { loadIncidentFixture } = await import('./incident-fixture-converter.ts');
  const { runRealFixture } = await import('./incident-replay-harness.ts');
  const { IncidentStore } = await import('./wavemill-incident-store.ts');
  const { syncIncident } = await import('./incident-to-linear-synchronizer.ts');
  for (const [rootCauseClass, owner] of [['cleanup_dirty_worktree','HOK-3312'],['stale_dependency_install','HOK-3315'],['failed_background_job','HOK-3255']] as const) {
    const path = new URL(`../../tests/fixtures/incident-replay/real/defect-escalation/${rootCauseClass}.json`, import.meta.url);
    const fixture = loadIncidentFixture(path.pathname);
    const replay = await runRealFixture(path.pathname);
    assert.equal(replay.ok,true,replay.reason);
    const dir = mkdtempSync(join(tmpdir(),'audit-escalation-'));
    try {
      const store = new IncidentStore(join(dir,'.wavemill/incidents'),{escalationThreshold:1});
      const observed = makeIncident({...fixture.incident,metadata:{knownIssueIds:[owner],thresholdTriggered:true},evidence:fixture.observations[0].evidence});
      const record = await store.upsert(observed);
      let comments = 0;
      const outcome = await investigateConfirmedIncident({incident:record,repoDir:dir,reconciliation:confirmedActive(),runInvestigation:async (prompt) => {
        assert.ok(prompt.includes(owner),'recorded owner evidence reaches investigation');
        return makeRunner({incidentFingerprint:record.fingerprint,mode:'append_to_owner',targetIssueId:owner,title:'Append audit evidence to the existing consolidation',sections:{why:'recorded audit',change:'shared primitive',notInScope:'new policy',acceptance:'replay'},modelId:'gpt-test',provider:'codex',generatedAt:new Date().toISOString()})();
      }});
      const client = {
        getTeams:async()=>[],getProjects:async()=>[],searchIssues:async()=>[],
        getIssue:async()=>({id:'existing-owner',identifier:owner,title:'Existing consolidation',url:`https://linear.app/fake/${owner}`,state:{name:'In Progress'},labels:{nodes:[]},completedAt:null,canceledAt:null}),
        createIssue:async()=>assert.fail('a known audit class must not create an issue'),
        createComment:async(id:string,body:string)=>{ assert.equal(id,'existing-owner');assert.ok(body.includes(rootCauseClass));comments++;return {id:'comment-1',url:'https://linear.app/fake/comment'}; },
        getOrCreateLabel:async(name:string)=>({id:name,name}),addLabelsToIssue:async()=>({success:true,issue:{id:'existing-owner',identifier:owner,title:'Existing consolidation',url:`https://linear.app/fake/${owner}`}}),
      };
      const opts={store,repoDir:dir,config:{...config(),requestDelayMs:0},client,reconciler:()=>confirmedActive(),investigation:outcome};
      const first=await syncIncident({...opts,incident:record});
      assert.equal(first.action,'update_comment',first.reason);
      const reloaded=await store.getIncident(record.fingerprint);
      assert.ok(reloaded);
      await syncIncident({...opts,incident:reloaded});
      assert.equal(comments,1,'persisted revision suppresses duplicate evidence after restart');
    } finally {rmSync(dir,{recursive:true,force:true});}
  }
});
