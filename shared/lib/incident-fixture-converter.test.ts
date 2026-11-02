/**
 * HOK-3231 — unit tests for the incident fixture converter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clusterIncidents,
  compressObservations,
  deriveFailureEvidence,
  deriveExpectations,
  incidentToFixture,
  journeyFor,
  listClustersFromDir,
  loadIncidentByFingerprint,
  readEvidenceLog,
  readIncidentIndex,
  serializeFixture,
  validateIncidentFixture,
  type IncidentFixture,
  type IncidentIndex,
} from './incident-fixture-converter.ts';
import type { IncidentRecord } from './wavemill-incident-model.ts';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'incident-fixture-converter-test-'));
}

function makeRecord(fp: string, overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    schemaVersion: '1.1',
    id: `id-${fp.slice(0, 8)}`,
    fingerprint: fp,
    taskId: 'HOK-9001',
    session: 'test',
    category: 'stale_orphaned_state',
    severity: 'medium',
    confidence: 'high',
    lifecycle: 'resolved',
    createdAt: '2026-09-20T10:00:00.000Z',
    firstObservedAt: '2026-09-20T10:00:00.000Z',
    lastObservedAt: '2026-09-20T10:04:00.000Z',
    occurrenceCount: 3,
    rootCauseClass: 'cleanup_dirty_worktree',
    summary: 'HOK-9001 cleanup disposition is dirty-worktree.',
    operatorAction: 'Fix the dirty tree.',
    evidence: [],
    metadata: {
      resolution: { action: 'auto_resolved', at: '2026-09-20T11:00:00Z', reason: 'not re-observed' },
      // store-owned (should be stripped from fixture.incident.metadata)
      seenEventKeys: ['abc'],
      missedCycles: 6,
      recurrence: { count: 1, lastRecurredAt: '2026-09-20T10:00:00Z', reopenedFrom: 'resolved' as const },
      escalatedAt: '2026-09-20T10:02:00Z',
      lastEventAt: '2026-09-20T10:04:00Z',
    },
    ...overrides,
  };
}

function writeEvidenceLog(path: string, lines: unknown[]): void {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('event-key counting matches hand-computed values', () => {
  // protects: event-key counting drift turning re-polls into occurrences
  const dir = makeTempDir();
  try {
    const fp = 'a'.repeat(64);
    const index: IncidentIndex = { [fp]: makeRecord(fp) };
    writeFileSync(join(dir, 'index.json'), JSON.stringify(index));
    writeEvidenceLog(join(dir, `${fp}.evidence.jsonl`), [
      { observedAt: '2026-09-20T10:00:00Z', fingerprint: fp, evidence: { type: 'workflow_state', source: '/tmp/s1', timestamp: '2026-09-20T10:00:00Z', redactedData: 'd1', key: 'k1' } },
      { observedAt: '2026-09-20T10:02:00Z', fingerprint: fp, evidence: { type: 'workflow_state', source: '/tmp/s2', timestamp: '2026-09-20T10:02:00Z', redactedData: 'd2', key: 'k2' } },
      { observedAt: '2026-09-20T10:04:00Z', fingerprint: fp, evidence: { type: 'workflow_state', source: '/tmp/s3', timestamp: '2026-09-20T10:04:00Z', redactedData: 'd3', key: 'k3' } },
    ]);
    const { record, evidence } = loadIncidentByFingerprint(dir, fp);
    const fixture = incidentToFixture(record!, evidence, { fixtureIndex: 1 });
    assert.equal(fixture.observations.length, 3);
    assert.equal(fixture.expected.occurrenceCount, 3);
    assert.equal(fixture.expected.lifecycleWhilePresent, 'active');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compression ignores poll timestamps while retaining changed observations', () => {
  const entries = [
    { observedAt: '2026-09-20T10:00:00Z', fingerprint: 'a', evidence: { type: 'workflow_state' as const, source: '/x', timestamp: '2026-09-20T10:00:00Z', redactedData: 'same', key: 'k' } },
    { observedAt: '2026-09-20T10:02:00Z', fingerprint: 'a', evidence: { type: 'workflow_state' as const, source: '/x', timestamp: '2026-09-20T10:02:00Z', redactedData: 'same', key: 'k' } },
    { observedAt: '2026-09-20T10:04:00Z', fingerprint: 'a', evidence: { type: 'workflow_state' as const, source: '/x', timestamp: '2026-09-20T10:04:00Z', redactedData: 'changed', key: 'k' } },
  ];
  const compressed = compressObservations(entries);
  assert.equal(compressed.observations.length, 2);
  assert.equal(compressed.observations[1].evidence[0].redactedData, 'changed');
});

test('stage failure relaunch count comes from distinct evidence events', () => {
  const record = makeRecord('f'.repeat(64), { rootCauseClass: 'stage_marker_not_advanced' });
  const entries = [
    { observedAt: '2026-09-20T10:00:00Z', fingerprint: record.fingerprint, evidence: { type: 'workflow_state' as const, source: '/x', timestamp: '2026-09-20T10:00:00Z', redactedData: 'failed', key: 'k' } },
    { observedAt: '2026-09-20T10:02:00Z', fingerprint: record.fingerprint, evidence: { type: 'workflow_state' as const, source: '/x', timestamp: '2026-09-20T10:02:00Z', redactedData: 'failed', key: 'k' } },
  ];
  const failure = deriveFailureEvidence('stage_marker_not_advanced', record, entries, new Map(), '', '');
  assert.equal(failure?.survivesRelaunches, 1);
});

test('sanitisation leaves no /Users/ or original ids but keeps _c', () => {
  // protects: leaking operator paths or ids into the repo
  const dir = makeTempDir();
  try {
    const fp = 'b'.repeat(64);
    const rec = makeRecord(fp, {
      taskId: 'HOK-1234_c',
      summary: '/Users/timothyogilvie/Dropbox/wavemill/.wavemill/workflow-state.json for HOK-1234_c',
      operatorAction: 'See HOK-1234 primary and HOK-1234_c challenger.',
    });
    const index: IncidentIndex = { [fp]: rec };
    writeFileSync(join(dir, 'index.json'), JSON.stringify(index));
    writeEvidenceLog(join(dir, `${fp}.evidence.jsonl`), [
      { observedAt: '2026-09-20T10:00:00Z', fingerprint: fp, evidence: { type: 'workflow_state', source: '/Users/timothyogilvie/path', timestamp: '2026-09-20T10:00:00Z', redactedData: 'HOK-1234_c dirty', key: 'cleanup:HOK-1234_c' } },
    ]);
    const { record, evidence } = loadIncidentByFingerprint(dir, fp);
    const fixture = incidentToFixture(record!, evidence, { fixtureIndex: 1, homeDir: '/Users/timothyogilvie', repoDir: '/Users/timothyogilvie/Dropbox/wavemill' });
    const text = JSON.stringify(fixture);
    assert.doesNotMatch(text, /\/Users\//);
    assert.doesNotMatch(text, /HOK-1234/);
    assert.match(text, /HOK-FIXTURE-\d+_c/);
    assert.equal(fixture.initialState.task.issue, 'HOK-FIXTURE-1_c');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed lines yield a warning and a typed error, no throw', () => {
  // protects: one corrupt log aborting clustering
  const dir = makeTempDir();
  try {
    const fp = 'c'.repeat(64);
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ [fp]: makeRecord(fp) }));
    writeFileSync(join(dir, `${fp}.evidence.jsonl`), 'not json\n{"observedAt":"2026-09-20T10:00:00Z","fingerprint":"' + fp + '","evidence":{"type":"workflow_state","source":"/x","timestamp":"2026-09-20T10:00:00Z","redactedData":"d"}}\n');
    const log = readEvidenceLog(join(dir, `${fp}.evidence.jsonl`));
    assert.equal(log.entries.length, 1);
    assert.ok(log.warnings.length === 1 && log.warnings[0].includes('malformed'));

    const missing = readEvidenceLog(join(dir, 'nope.evidence.jsonl'));
    assert.equal(missing.entries.length, 0);
    assert.equal(missing.error?.code, 'ENOENT');
    assert.doesNotThrow(() => missing);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clusterIncidents ranks by count with deterministic tie-break', () => {
  // protects: non-deterministic representative choice between runs
  const dir = makeTempDir();
  try {
    const fp1 = 'd'.repeat(64);
    const fp2 = 'e'.repeat(64);
    const fp3 = 'f'.repeat(64);
    const idx: IncidentIndex = {
      [fp1]: makeRecord(fp1, { rootCauseClass: 'cleanup_dirty_worktree' }),
      [fp2]: makeRecord(fp2, { rootCauseClass: 'cleanup_dirty_worktree' }),
      [fp3]: makeRecord(fp3, { rootCauseClass: 'cleanup_retained_by_policy' }),
    };
    writeFileSync(join(dir, 'index.json'), JSON.stringify(idx));
    for (const fp of [fp1, fp2, fp3]) {
      writeEvidenceLog(join(dir, `${fp}.evidence.jsonl`), [
        { observedAt: '2026-09-20T10:00:00Z', fingerprint: fp, evidence: { type: 'workflow_state', source: '/x', timestamp: '2026-09-20T10:00:00Z', redactedData: 'd', key: 'k' } },
        { observedAt: '2026-09-20T10:02:00Z', fingerprint: fp, evidence: { type: 'workflow_state', source: '/x', timestamp: '2026-09-20T10:02:00Z', redactedData: 'd2', key: 'k2' } },
      ]);
    }
    const first = clusterIncidents(idx, dir, { top: 10 });
    const again = clusterIncidents(idx, dir, { top: 10 });
    assert.deepEqual(first.map((c) => [c.class, c.count]), again.map((c) => [c.class, c.count]));
    assert.equal(first[0].class, 'cleanup_dirty_worktree');
    assert.equal(first[0].count, 2);
    assert.equal(first[1].class, 'cleanup_retained_by_policy');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('empty incidents dir produces zero clusters, no throw', () => {
  const dir = makeTempDir();
  try {
    const { clusters, warnings } = listClustersFromDir(dir);
    assert.equal(clusters.length, 0);
    assert.ok(warnings.some((w) => /not found|unreadable/.test(w)) || warnings.length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deterministic: converting twice gives byte-identical output', () => {
  // protects: non-reproducible fixture bytes blocking diff review
  const dir = makeTempDir();
  try {
    const fp = '1'.repeat(64);
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ [fp]: makeRecord(fp) }));
    writeEvidenceLog(join(dir, `${fp}.evidence.jsonl`), [
      { observedAt: '2026-09-20T10:00:00Z', fingerprint: fp, evidence: { type: 'workflow_state', source: '/x', timestamp: '2026-09-20T10:00:00Z', redactedData: 'd', key: 'k' } },
      { observedAt: '2026-09-20T10:02:00Z', fingerprint: fp, evidence: { type: 'workflow_state', source: '/x', timestamp: '2026-09-20T10:02:00Z', redactedData: 'd2', key: 'k2' } },
    ]);
    const { record, evidence } = loadIncidentByFingerprint(dir, fp);
    const a = serializeFixture(incidentToFixture(record!, evidence, { fixtureIndex: 1 }));
    const b = serializeFixture(incidentToFixture(record!, evidence, { fixtureIndex: 1 }));
    assert.equal(a, b);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gap compression yields absentCyclesBefore=6 and recurrences=1 for long gap', () => {
  // protects: long absence collapsed into one gap, oracle counts the recurrence
  const dir = makeTempDir();
  try {
    const fp = '2'.repeat(64);
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ [fp]: makeRecord(fp) }));
    writeEvidenceLog(join(dir, `${fp}.evidence.jsonl`), [
      { observedAt: '2026-09-20T10:00:00Z', fingerprint: fp, evidence: { type: 'workflow_state', source: '/x', timestamp: '2026-09-20T10:00:00Z', redactedData: 'd1', key: 'k1' } },
      { observedAt: '2026-09-20T10:02:00Z', fingerprint: fp, evidence: { type: 'workflow_state', source: '/x', timestamp: '2026-09-20T10:02:00Z', redactedData: 'd2', key: 'k2' } },
      // 1h gap after a 2m cadence → >> 5 cycles
      { observedAt: '2026-09-20T11:02:00Z', fingerprint: fp, evidence: { type: 'workflow_state', source: '/x', timestamp: '2026-09-20T11:02:00Z', redactedData: 'd3', key: 'k3' } },
    ]);
    const { record, evidence } = loadIncidentByFingerprint(dir, fp);
    const fixture = incidentToFixture(record!, evidence, { fixtureIndex: 1 });
    const gap = fixture.observations[fixture.observations.length - 1].absentCyclesBefore;
    assert.equal(gap, 6, `expected absentCyclesBefore clamped to 6, got ${gap}`);
    assert.equal(fixture.expected.recurrences, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('job-backed eval fixture drives eval-stage recovery and stays open', async () => {
  // protects: job-backed records resolving by absence despite job filing semantics
  const dir = makeTempDir();
  try {
    const fp = '3'.repeat(64);
    const base = makeRecord(fp);
    // Explicitly drop store-owned escalation metadata so the oracle picks
    // `observed` for a single-observation record.
    const metadata = Object.fromEntries(Object.entries(base.metadata ?? {}).filter(([k]) => k !== 'escalatedAt'));
    const rec = makeRecord(fp, {
      rootCauseClass: 'failed_background_job',
      category: 'product_defect',
      metadata: { ...metadata, jobId: 'eval-HOK-9001-1' },
    });
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ [fp]: rec }));
    writeEvidenceLog(join(dir, `${fp}.evidence.jsonl`), [
      { observedAt: '2026-09-20T10:00:00Z', fingerprint: fp, evidence: { type: 'job_state', source: '/x', timestamp: '2026-09-20T10:00:00Z', redactedData: 'id=eval-HOK-9001-1 kind=eval status=failed reason=task_aborted', key: 'failed_background_job' } },
    ]);
    const { record, evidence } = loadIncidentByFingerprint(dir, fp);
    const fixture = incidentToFixture(record!, evidence, { fixtureIndex: 1 });
    assert.equal(fixture.failure?.stage, 'eval');
    assert.equal(fixture.expected.finalLifecycle, 'observed');
    assert.equal(fixture.expected.resolutionReasonPrefix, null);
    const fixturePath = join(dir, 'failed-background-job.json');
    writeFileSync(fixturePath, serializeFixture(fixture));
    const { runRealFixture } = await import('./incident-replay-harness.ts');
    const replay = await runRealFixture(fixturePath);
    if (!replay.ok) throw new Error(JSON.stringify(replay));
    assert.equal(replay.recovery?.failureStage, 'eval');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('job-backed successful retry writes result evidence in the replay sandbox', async () => {
  const dir = makeTempDir();
  try {
    const fp = '4'.repeat(64);
    const record = makeRecord(fp, {
      rootCauseClass: 'failed_background_job',
      category: 'product_defect',
      metadata: { jobId: 'eval-job-2', jobKind: 'eval', authoritativeFailureAt: '2026-09-20T10:00:00Z' },
    });
    const entries = [{ observedAt: '2026-09-20T10:00:00Z', fingerprint: fp, evidence: { type: 'job_state' as const, source: '/x', timestamp: '2026-09-20T10:00:00Z', redactedData: 'id=eval-job-2 kind=eval status=failed', key: 'failed' } }];
    const fixture = incidentToFixture(record, entries, { fixtureIndex: 1 });
    fixture.initialState.jobs = [{ id: 'eval-job-2', kind: 'eval', status: 'succeeded', resultPath: '.wavemill/results/eval-job-2.json' }];
    fixture.expected.lifecycleWhilePresent = 'resolved';
    fixture.expected.finalLifecycle = 'resolved';
    fixture.expected.resolutionReasonPrefix = 'current_disposition:';
    const fixturePath = join(dir, 'successful-retry.json');
    writeFileSync(fixturePath, serializeFixture(fixture));
    const { runRealFixture } = await import('./incident-replay-harness.ts');
    const replay = await runRealFixture(fixturePath);
    if (!replay.ok) throw new Error(JSON.stringify(replay));
    assert.equal(replay.cycle.finalLifecycle, 'resolved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateIncidentFixture rejects missing fields and bad failure block', () => {
  assert.ok(validateIncidentFixture({}).length > 0);
  assert.ok(validateIncidentFixture({
    schemaVersion: 'incident-fixture/1',
    chain: 'x',
    incidents: [],
    initialState: { task: {}, jobs: [] },
    observations: [],
    trailingAbsentCycles: 0,
    incident: {},
    convergence: {},
    expected: {},
    failure: { stage: 'other', detail: 'x', survivesRelaunches: 'maybe' },
  }).length > 0);
});

test('journeyFor returns a declared journey or a null reason', () => {
  assert.equal(journeyFor('failed_background_job').journey, 'incident-currentness');
  const nullCase = journeyFor('cleanup_retained_by_policy');
  assert.equal(nullCase.journey, null);
  assert.ok(typeof nullCase.reason === 'string' && nullCase.reason.length > 0);
});

test('readIncidentIndex handles missing/malformed files gracefully', () => {
  const dir = makeTempDir();
  try {
    const missing = readIncidentIndex(dir);
    assert.equal(Object.keys(missing.index).length, 0);
    assert.ok(missing.warnings.some((w) => w.includes('not found')));

    writeFileSync(join(dir, 'index.json'), '{broken json');
    const bad = readIncidentIndex(dir);
    assert.equal(Object.keys(bad.index).length, 0);
    assert.ok(bad.warnings.some((w) => w.includes('parse failed')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI accepts an explicit evidence path outside the default incidents directory', async () => {
  // protects: operator-only `--input /path/*.evidence.jsonl` reads that file and its co-located index
  const dir = makeTempDir();
  const outDir = join(dir, 'out');
  try {
    const fp = '5'.repeat(64);
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ [fp]: makeRecord(fp) }));
    writeEvidenceLog(join(dir, `${fp}.evidence.jsonl`), [
      { observedAt: '2026-09-20T10:00:00Z', fingerprint: fp, evidence: { type: 'workflow_state', source: '/x', timestamp: '2026-09-20T10:00:00Z', redactedData: 'd', key: 'k' } },
      { observedAt: '2026-09-20T10:02:00Z', fingerprint: fp, evidence: { type: 'workflow_state', source: '/x', timestamp: '2026-09-20T10:02:00Z', redactedData: 'd2', key: 'k2' } },
    ]);
    const { runIncidentToFixtureCommand } = await import('../../tools/incident-to-fixture.ts');
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    console.error = (...args: unknown[]) => { logs.push('err: ' + args.map(String).join(' ')); };
    try {
      const code = await runIncidentToFixtureCommand({
        input: join(dir, `${fp}.evidence.jsonl`),
        cluster: false,
        top: 15,
        incidentsDir: join(dir, 'missing-default-incidents-dir'),
        outDir,
        stateSnapshot: undefined,
        expect: undefined,
        maxObservations: 40,
        check: true,
        force: false,
        homeDir: '',
        repoDir: '',
      });
      assert.equal(code, 0);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    // --check must have written nothing to the out dir.
    assert.equal(existsSync(outDir), false, '--check must not create out dir');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tampered expectation fails every incident-cycle oracle assertion', async () => {
  // protects: the real-fixture harness reads store results rather than re-counting fixture input
  const dir = makeTempDir();
  try {
    const fp = '4'.repeat(64);
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ [fp]: makeRecord(fp) }));
    writeEvidenceLog(join(dir, `${fp}.evidence.jsonl`), [
      { observedAt: '2026-09-20T10:00:00Z', fingerprint: fp, evidence: { type: 'workflow_state', source: '/x', timestamp: '2026-09-20T10:00:00Z', redactedData: 'd', key: 'k' } },
      { observedAt: '2026-09-20T10:02:00Z', fingerprint: fp, evidence: { type: 'workflow_state', source: '/x', timestamp: '2026-09-20T10:02:00Z', redactedData: 'd2', key: 'k2' } },
    ]);
    const { record, evidence } = loadIncidentByFingerprint(dir, fp);
    const fixture: IncidentFixture = incidentToFixture(record!, evidence, { fixtureIndex: 1 });
    const tampered = {
      ...fixture,
      expected: {
        ...fixture.expected,
        rootCauseClass: 'cleanup_retained_by_policy' as const,
        category: 'product_defect' as const,
        occurrenceCount: fixture.expected.occurrenceCount + 1,
        lifecycleWhilePresent: 'active' as const,
        finalLifecycle: 'active' as const,
      },
    };
    const tamperedPath = join(dir, 'tampered.json');
    writeFileSync(tamperedPath, serializeFixture(tampered));
    const { runRealFixture } = await import('./incident-replay-harness.ts');
    const result = await runRealFixture(tamperedPath);
    assert.equal(result.ok, false);
    assert.ok(result.reason && /rootCauseClass/.test(result.reason));
    assert.ok(result.reason && /category/.test(result.reason));
    assert.ok(result.reason && /occurrenceCount/.test(result.reason));
    assert.ok(result.reason && /lifecycleWhilePresent/.test(result.reason));
    assert.ok(result.reason && /finalLifecycle/.test(result.reason));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
