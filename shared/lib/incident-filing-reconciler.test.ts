import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
  writeFileSync(join(dir, '.wavemill', 'workflow-state.json'), JSON.stringify({ jobs }));
  return dir;
}

function job(overrides: Record<string, unknown> = {}) {
  return { id: 'job-1', kind: 'eval', status: 'failed', issueId: 'HOK-1', finishedAt: '2026-09-01T10:00:00.000Z', resultPath: '.wavemill/results/job-1.json', ...overrides };
}

test('confirms a still-failed job with an absent result', () => {
  const dir = repo([job()]);
  try { assert.equal(reconcileIncidentForFiling(item(), dir).outcome, 'confirmed_active'); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recovers when the original job succeeds with a persisted result', () => {
  const dir = repo([job({ status: 'succeeded', finishedAt: '2026-09-01T11:00:00.000Z' })]);
  try {
    mkdirSync(join(dir, '.wavemill', 'results'), { recursive: true });
    writeFileSync(join(dir, '.wavemill', 'results', 'job-1.json'), '{}');
    assert.equal(reconcileIncidentForFiling(item(), dir).outcome, 'recovered');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('supersedes only a newer successful retry with the same task lineage', () => {
  const dir = repo([job(), job({ id: 'job-2', status: 'succeeded', finishedAt: '2026-09-01T11:00:00.000Z', resultPath: '.wavemill/results/job-2.json' })]);
  try {
    mkdirSync(join(dir, '.wavemill', 'results'), { recursive: true });
    writeFileSync(join(dir, '.wavemill', 'results', 'job-2.json'), '{}');
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
    writeFileSync(join(dir, '.wavemill', 'results', 'old.json'), '{}');
    writeFileSync(join(dir, '.wavemill', 'results', 'other.json'), '{}');
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
