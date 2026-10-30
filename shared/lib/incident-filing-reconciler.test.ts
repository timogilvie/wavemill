import assert from 'node:assert/strict';
import capturedReplay from '../../tests/fixtures/incidents/2026-10-27-job-truth.json' with { type: 'json' };
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildWorkflowState } from '../../tests/lib/task-builder.ts';
import type { MillJob } from './job-tracker.ts';
import { reconcileIncidentForFiling } from './incident-filing-reconciler.ts';
import { createIncidentDraft } from './wavemill-incident-model.ts';

function item(overrides: Record<string, unknown> = {}) {
  return createIncidentDraft({
    taskId: 'HOK-1', category: 'stale_orphaned_state', severity: 'medium', confidence: 'definite', lifecycle: 'active',
    rootCauseClass: 'failed_job_no_result', summary: 'eval failed', operatorAction: 'retry',
    evidence: [{ type: 'job_state', source: 'state', timestamp: '2026-09-01T10:00:00.000Z', redactedData: 'failed', key: 'failed' }],
    metadata: { jobId: 'job-1', jobKind: 'eval', resultPath: '.wavemill/results/job-1.json', authoritativeFailureAt: '2026-09-01T10:00:00.000Z' },
    ...overrides,
  });
}

function repo(jobs: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'filing-reconciler-'));
  mkdirSync(join(dir, '.wavemill'), { recursive: true });
  writeFileSync(join(dir, '.wavemill', 'workflow-state.json'), JSON.stringify(buildWorkflowState({}, { topLevel: { jobs: jobs as Record<string, MillJob> } })));
  return dir;
}

function job(overrides: Record<string, unknown> = {}) {
  return { prNumbers: [1437], pid: 1, timeoutSeconds: 900, logPath: 'eval.log', exitCode: 1, reason: 'eval_not_persisted', excerpt: null, settled: false, startedAt: '2026-09-01T09:59:00.000Z', id: 'job-1', kind: 'eval', status: 'failed', issueId: 'HOK-1', finishedAt: '2026-09-01T10:00:00.000Z', resultPath: '.wavemill/results/job-1.json', ...overrides };
}

test('confirms a still-failed job with an absent result', () => {
  const dir = repo([job()]);
  try { assert.equal(reconcileIncidentForFiling(item(), dir).outcome, 'confirmed_active'); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recovers when the original job succeeds with a persisted result', () => {
  const dir = repo([job({ status: 'succeeded', finishedAt: '2026-09-01T11:00:00.000Z' })]);
  try {
    mkdirSync(join(dir, '.wavemill', 'results'), { recursive: true });
    writeFileSync(join(dir, '.wavemill', 'results', 'job-1.json'), JSON.stringify({ ok: true, persisted: true, exitCode: 0 }));
    assert.equal(reconcileIncidentForFiling(item(), dir).outcome, 'recovered');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('supersedes only a newer successful retry with the same task lineage', () => {
  const dir = repo([job(), job({ id: 'job-2', startedAt: '2026-09-01T10:05:00.000Z', status: 'succeeded', finishedAt: '2026-09-01T11:00:00.000Z', resultPath: '.wavemill/results/job-2.json' })]);
  try {
    mkdirSync(join(dir, '.wavemill', 'results'), { recursive: true });
    writeFileSync(join(dir, '.wavemill', 'results', 'job-2.json'), JSON.stringify({ ok: true, persisted: true, exitCode: 0 }));
    assert.equal(reconcileIncidentForFiling(item(), dir).outcome, 'superseded');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('does not suppress for an older or another task success', () => {
  const dir = repo([
    job(),
    job({ id: 'old', status: 'succeeded', finishedAt: '2026-09-01T09:00:00.000Z', resultPath: '.wavemill/results/old.json' }),
    job({ id: 'other-task', status: 'succeeded', issueId: 'HOK-2', finishedAt: '2026-09-01T11:00:00.000Z', resultPath: '.wavemill/results/other.json' }),
  ]);
  try {
    mkdirSync(join(dir, '.wavemill', 'results'), { recursive: true });
    writeFileSync(join(dir, '.wavemill', 'results', 'old.json'), JSON.stringify({ ok: true, persisted: true, exitCode: 0 }));
    writeFileSync(join(dir, '.wavemill', 'results', 'other.json'), JSON.stringify({ ok: true, persisted: true, exitCode: 0 }));
    assert.equal(reconcileIncidentForFiling(item(), dir).outcome, 'confirmed_active');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fails closed for missing or malformed current truth', () => {
  const missing = mkdtempSync(join(tmpdir(), 'filing-reconciler-missing-'));
  const malformed = repo([]);
  try {
    writeFileSync(join(malformed, '.wavemill', 'workflow-state.json'), '{bad');
    assert.equal(reconcileIncidentForFiling(item(), missing).outcome, 'needs_inspection');
    assert.equal(reconcileIncidentForFiling(item(), malformed).outcome, 'needs_inspection');
  } finally { rmSync(missing, { recursive: true, force: true }); rmSync(malformed, { recursive: true, force: true }); }
});

for (const [name, payload, expected] of [
  ['aborted', {ok:false,persisted:false,exitCode:1,error:'task_aborted'}, 'confirmed_active'],
  ['malformed', {unexpected:true}, 'needs_inspection'],
  ['contradictory success', {ok:true,persisted:false,exitCode:0}, 'needs_inspection'],
] as const) {
  test(`existing ${name} result never proves recovery`, () => {
    const dir = repo([job()]);
    try {
      mkdirSync(join(dir, '.wavemill/results'), {recursive:true});
      writeFileSync(join(dir, '.wavemill/results/job-1.json'), JSON.stringify(payload));
      assert.equal(reconcileIncidentForFiling(item(), dir).outcome, expected);
    } finally { rmSync(dir, {recursive:true,force:true}); }
  });
}

test('a recovery filename without authoritative retry lineage cannot supersede a failure', () => {
  const dir = repo([job()]);
  try {
    mkdirSync(join(dir, '.wavemill/results'), {recursive:true});
    writeFileSync(join(dir, '.wavemill/results/job-1-recovery.json'), JSON.stringify({ok:true,persisted:true,exitCode:0}));
    assert.equal(reconcileIncidentForFiling(item(), dir).outcome, 'confirmed_active');
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('a later success for another side or PR cannot clear this failure', () => {
  for (const override of [{side:'challenger'}, {prNumbers:[1438]}]) {
    const dir = repo([job(), job({id:'job-2',status:'succeeded',startedAt:'2026-09-01T10:05:00Z',finishedAt:'2026-09-01T11:00:00Z',resultPath:'.wavemill/results/job-2.json',...override})]);
    try {
      mkdirSync(join(dir,'.wavemill/results'), {recursive:true});
      writeFileSync(join(dir,'.wavemill/results/job-2.json'), JSON.stringify({ok:true,persisted:true,exitCode:0}));
      assert.equal(reconcileIncidentForFiling(item(),dir).outcome,'confirmed_active');
    } finally {rmSync(dir,{recursive:true,force:true});}
  }
});

test('replays the captured October incident through schema-validated workflow jobs', () => {
  const fixture = capturedReplay;
  for (const replay of fixture.cases) {
    const original = job({issueId:replay.issueId,side:replay.side,prNumbers:[replay.pr],finishedAt:replay.finishedAt,
      startedAt:new Date(Date.parse(replay.finishedAt)-60000).toISOString(),status:replay.settledSuccess?'succeeded':'failed'});
    const dir = repo([original]);
    try {
      mkdirSync(join(dir,'.wavemill/results'),{recursive:true});
      if (replay.result) writeFileSync(join(dir,'.wavemill/results/job-1.json'),JSON.stringify(replay.result));
      if (replay.orphanRecovery) writeFileSync(join(dir,'.wavemill/results/job-1-recovery.json'),JSON.stringify(replay.orphanRecovery));
      const incident = item({taskId:replay.issueId,metadata:{jobId:'job-1',jobKind:'eval',side:replay.side,authoritativeFailureAt:replay.finishedAt}});
      assert.equal(reconcileIncidentForFiling(incident,dir).outcome,replay.expected,replay.name);
    } finally {rmSync(dir,{recursive:true,force:true});}
  }
});

test('stale or contradictory successful result contents remain needs_inspection', () => {
  for (const contradiction of [{jobId:'other-attempt'}, {taskId:'HOK-2'}, {side:'challenger'}, null]) {
    const dir = repo([job({status:'succeeded'})]);
    try {
      mkdirSync(join(dir,'.wavemill/results'),{recursive:true});
      const path = join(dir,'.wavemill/results/job-1.json');
      writeFileSync(path,JSON.stringify({ok:true,persisted:true,exitCode:0,...contradiction}));
      if (contradiction === null) utimesSync(path,new Date('2026-01-01'),new Date('2026-01-01'));
      assert.equal(reconcileIncidentForFiling(item(),dir).outcome,'needs_inspection');
    } finally {rmSync(dir,{recursive:true,force:true});}
  }
});
