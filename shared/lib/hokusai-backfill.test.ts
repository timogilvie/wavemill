import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { clearConfigCache } from './config.ts';
import type { EvalRecord, RoutingDecision } from './eval-schema.ts';
import { backfillHokusaiSubmissions, selectBackfillRecords } from './hokusai-backfill.ts';
import { saveUserConfig } from './hokusai-consent.ts';
import { appendHokusaiLedgerEntry } from './hokusai-ledger.ts';
import { hokusaiSubmissionTriggerDeps } from './hokusai-submission-trigger.ts';
import type { MeteredWorkflowCost } from './sdk-task-cost/meter.ts';

const tempDirs: string[] = [];

/**
 * The promoted task's archived session-ownership evidence (HOK-3328): one owned
 * coding session. A v4 row needs at least one stage execution (HOK-3415), and
 * backfill meters it through the trigger's one cost engine by issue id. Returns
 * the issue ids metering was asked for.
 */
function stubOwnedTaskEvidence(sessions: 'one-coding-session' | 'none' = 'one-coding-session'): string[] {
  const meteredFor: string[] = [];
  mock.method(hokusaiSubmissionTriggerDeps, 'meterWorkflowCost', async (input: { issueId?: string }) => {
    meteredFor.push(input.issueId ?? '');
    return {
      outcome: { status: 'success' } as never,
      reason: 'measured' as never,
      summaries: [],
      owned: sessions === 'none' ? [] : [{
        sessionRef: 'promoted-coding-1',
        harness: 'claude-code',
        kind: 'coding',
        stage: 'coding',
        model: 'gpt-5.4',
        launchedAt: '2026-08-25T11:00:00.000Z',
        attemptId: 'coding@abc1234#1756119600',
      }],
      sessionCosts: new Map(),
      sessionUsageRows: new Map(),
      sessionHarness: new Map(),
      summariesByKind: new Map(),
    } satisfies MeteredWorkflowCost;
  });
  // Matches the record's routed coder so the v4 "last coding stage executed
  // model equals selected_models.coder" rule holds.
  mock.method(hokusaiSubmissionTriggerDeps, 'resolveStageExecutedModel', () => ({
    executedModel: 'gpt-5.4',
    evidenceStatus: 'direct' as const,
    evidenceSource: 'session-stream' as const,
  }));
  return meteredFor;
}

afterEach(() => {
  mock.restoreAll();
});

function rec(id: string, issueId: string, ts: string) {
  return { id, issueId, timestamp: ts } as never;
}

function makeRepo(records: unknown[], options: { submissionEnabled?: boolean; contributionsEnabled?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'hokusai-backfill-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, '.wavemill-config.json'), `${JSON.stringify({
    hokusai: {
      dataSubmission: {
        enabled: options.submissionEnabled ?? false,
        consentVersion: '1.0',
      },
      contributions: {
        enabled: options.contributionsEnabled ?? true,
        endpoint: null,
      },
    },
  }, null, 2)}\n`);
  mkdirSync(join(dir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(
    join(dir, '.wavemill', 'evals', 'evals.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  return dir;
}

function makeConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hokusai-backfill-config-'));
  tempDirs.push(dir);
  saveUserConfig({
    hokusai: {
      enabled: true,
      consentedAt: '2026-08-25T12:00:00.000Z',
      consentVersion: '1.0',
    },
  }, dir);
  return dir;
}

function makeRoutingDecision(): RoutingDecision {
  return {
    candidates: [{ agentType: 'codex', modelId: 'gpt-5.4' }],
    chosen: { agentType: 'codex', modelId: 'gpt-5.4' },
    decisionPolicyVersion: 'baseline',
    decisionRationale: 'Use the implementation model.',
  };
}

function promotedRecord(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    id: 'eval-promoted-1',
    issueId: 'HOK-2864',
    schemaVersion: '1.43.0',
    originalPrompt: 'Promoted model evidence',
    modelId: 'gpt-5.4',
    modelVersion: 'gpt-5.4',
    score: 0.9,
    scoreBand: 'Minor Feedback',
    timeSeconds: 42,
    timestamp: '2026-08-25T12:00:00.000Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'Looks good.',
    workflowCost: 1.25,
    outcomes: { success: true },
    routingDecision: makeRoutingDecision(),
    constraints: { maxCostUsd: 5 },
    modelIdentityAttribution: {
      observedAt: '2026-08-25T12:00:00.000Z',
      roles: {
        coder: {
          alias: 'gpt-5.4',
          identityStatus: 'verified',
          identityRevision: 2,
          fingerprint: 'a'.repeat(64),
          evidencePolicy: 'eligible',
        },
      },
      provisionalRoles: [],
      candidateOnlyProvisional: [],
      finalization: {
        promotedAt: '2026-08-25T12:00:00.000Z',
        manifestId: 'manifest-1',
        fromRevision: 1,
        toRevision: 2,
        observedAlias: 'provisional-coder',
        finalAlias: 'gpt-5.4',
      },
    },
    ...overrides,
  };
}

function writeManifest(repoDir: string, overrides: Record<string, unknown> = {}): string {
  const path = join(repoDir, 'promotion-manifest.json');
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 'model-promotion.v1',
    manifestId: 'manifest-1',
    reviewed: true,
    rows: [{
      evalId: 'eval-promoted-1',
      fromRevision: 1,
      toRevision: 2,
      oldIdentity: { alias: 'provisional-coder', revision: 1, fingerprint: 'b'.repeat(64) },
      finalIdentity: { alias: 'gpt-5.4', revision: 2, fingerprint: 'a'.repeat(64) },
    }],
    ...overrides,
  }, null, 2)}\n`);
  return path;
}

function pendingLines(repoDir: string): unknown[] {
  const path = join(repoDir, '.wavemill', 'hokusai', 'queue', 'pending.jsonl');
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  clearConfigCache();
});

describe('hokusai backfill selection', () => {
  const records = [
    rec('a', 'HOK-1', '2026-08-16T10:00:00Z'),
    rec('b', 'HOK-2', '2026-08-17T10:00:00Z'),
    rec('c', 'HOK-3', '2026-08-18T10:00:00Z'),
    rec('d', 'HOK-4', '2026-08-19T10:00:00Z'),
  ];

  it('selects an inclusive date range', () => {
    const got = selectBackfillRecords(records, { since: '2026-08-17', until: '2026-08-18' });
    assert.deepEqual(got.map((r) => (r as { id: string }).id), ['b', 'c']);
  });

  it('explicit ids override the date range', () => {
    const got = selectBackfillRecords(records, { since: '2026-08-17', until: '2026-08-18', ids: ['a', 'd'] });
    assert.deepEqual(got.map((r) => (r as { id: string }).id), ['a', 'd']);
  });

  it('skips records with no timestamp rather than guessing', () => {
    const got = selectBackfillRecords([...records, { id: 'e', issueId: 'HOK-5' } as never], {
      since: '2026-08-01', until: '2026-08-31',
    });
    assert.ok(!got.some((r) => (r as { id: string }).id === 'e'));
  });
});

describe('hokusai backfill safety', () => {
  it('refuses to resubmit the entire corpus with no selector', async () => {
    const dir = makeRepo([rec('a', 'HOK-1', '2026-08-17T10:00:00Z')]);
    await assert.rejects(
      () => backfillHokusaiSubmissions({ repoDir: dir }),
      /requires --since\/--until or --ids/,
    );
  });

  it('dry run reports per-record outcomes without enqueuing', async () => {
    const dir = makeRepo([rec('a', 'HOK-1', '2026-08-17T10:00:00Z')]);
    const summary = await backfillHokusaiSubmissions({
      repoDir: dir, since: '2026-08-17', until: '2026-08-17',
    });
    assert.equal(summary.applied, false);
    assert.equal(summary.selected, 1);
    // The preview runs the real gates, so it reports a skip reason rather
    // than optimistically claiming every selected record would land.
    assert.ok(summary.results[0].status.startsWith('would-'));
  });

  it('tolerates malformed lines in the eval log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hokusai-backfill-'));
    mkdirSync(join(dir, '.wavemill', 'evals'), { recursive: true });
    writeFileSync(
      join(dir, '.wavemill', 'evals', 'evals.jsonl'),
      `${JSON.stringify(rec('a', 'HOK-1', '2026-08-17T10:00:00Z'))}\n{not json\n`,
    );
    tempDirs.push(dir);
    const summary = await backfillHokusaiSubmissions({
      repoDir: dir, since: '2026-08-17', until: '2026-08-17',
    });
    assert.equal(summary.selected, 1);
  });

  it('enqueues a promoted never-submitted eval once and no-ops on repeat', async () => {
    const meteredFor = stubOwnedTaskEvidence();
    const record = promotedRecord();
    const repoDir = makeRepo([record], { submissionEnabled: true });
    const configDir = makeConfigDir();
    const manifestPath = writeManifest(repoDir);

    const dryRun = await backfillHokusaiSubmissions({ repoDir, configDir, promotionManifestPath: manifestPath });
    assert.equal(dryRun.results[0].status, 'would-submit: promoted never-submitted');
    assert.equal(existsSync(join(repoDir, '.wavemill', 'hokusai', 'reconciliation')), false);

    const first = await backfillHokusaiSubmissions({
      repoDir,
      configDir,
      promotionManifestPath: manifestPath,
      apply: true,
    });
    assert.equal(first.results[0].action, 'enqueue_final');
    assert.match(first.results[0].status, /^enqueued entry=/);
    assert.ok(first.reconciliationReportPath);
    assert.equal(pendingLines(repoDir).length, 1);
    const [entry] = pendingLines(repoDir) as Array<{ provenance?: Record<string, unknown>; row?: Record<string, unknown> }>;
    assert.equal(entry.provenance?.evalId, 'eval-promoted-1');
    assert.equal(entry.provenance?.source, 'promoted_backfill');
    assert.equal(entry.provenance?.promotionToRevision, 2);
    assert.equal(entry.provenance?.reconciliationReportHash, first.reconciliationReportHash);
    assert.equal(entry.row?.run_id, undefined);

    const second = await backfillHokusaiSubmissions({
      repoDir,
      configDir,
      promotionManifestPath: manifestPath,
      apply: true,
    });
    assert.equal(second.results[0].status, 'no-op: already_pending');
    assert.equal(pendingLines(repoDir).length, 1);
    // Backfill metered the task's own owned sessions by issue id (HOK-3415).
    assert.ok(meteredFor.includes('HOK-2864'));
    assert.deepEqual(
      (entry.row?.stage_executions as Array<{ stage?: string; executed_model?: string }> | undefined)
        ?.map((e) => [e.stage, e.executed_model]),
      [['coding', 'gpt-5.4']],
    );
  });

  // protects: a backfilled eval whose task has no owned session being sent as a
  // v4 row with invented stage facts, instead of being refused.
  it('refuses a promoted eval whose task has no owned sessions', async () => {
    stubOwnedTaskEvidence('none');
    const repoDir = makeRepo([promotedRecord()], { submissionEnabled: true });
    const configDir = makeConfigDir();
    const manifestPath = writeManifest(repoDir);

    const applied = await backfillHokusaiSubmissions({
      repoDir,
      configDir,
      promotionManifestPath: manifestPath,
      apply: true,
    });
    assert.match(applied.results[0].status, /no_stage_executions/);
    assert.equal(pendingLines(repoDir).length, 0);
  });

  it('reconciles a zero-evidence promotion manifest as zero rows instead of refusing', async () => {
    const repoDir = makeRepo([], { submissionEnabled: true });
    const configDir = makeConfigDir();
    // Shape produced by shared/lib/model-promotion.ts for a promotion whose
    // evidence stayed held: no row arrays, conservation proves eval IDs intact.
    const manifestPath = join(repoDir, 'zero-evidence-manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify({
      schemaVersion: '1',
      manifestId: 'zero-evidence-1',
      promotionId: 'zero-evidence-1',
      status: 'applied',
      conservation: { evalIdsConserved: true, oldReferencesBefore: 0, oldReferencesAfter: 0 },
    }, null, 2)}\n`);

    const summary = await backfillHokusaiSubmissions({ repoDir, configDir, promotionManifestPath: manifestPath });
    assert.equal(summary.selected, 0);
    assert.equal(summary.results.length, 0);
    assert.ok(summary.reconciliationReportHash);

    // A hand-written rows manifest with no rows still refuses.
    const emptyRowsPath = join(repoDir, 'empty-rows-manifest.json');
    writeFileSync(emptyRowsPath, `${JSON.stringify({
      schemaVersion: 'model-promotion.v1',
      manifestId: 'manifest-empty',
      reviewed: true,
      rows: [],
    }, null, 2)}\n`);
    await assert.rejects(
      backfillHokusaiSubmissions({ repoDir, configDir, promotionManifestPath: emptyRowsPath }),
      /explicit promoted eval rows/,
    );
  });

  it('refuses accepted provisional evidence without correction/tombstone support', async () => {
    const record = promotedRecord();
    const repoDir = makeRepo([record], { submissionEnabled: true });
    const configDir = makeConfigDir();
    const manifestPath = writeManifest(repoDir);
    appendHokusaiLedgerEntry({
      schemaVersion: 1,
      eventType: 'accepted',
      timestamp: '2026-08-25T12:10:00.000Z',
      modelId: '30',
      idempotencyKey: 'idem-accepted',
      batchId: 'batch-accepted',
      jobId: 'job-accepted',
      rowCount: 1,
      acceptedAt: '2026-08-25T12:10:00.000Z',
      rewardStatus: 'pending',
      queueProvenance: [{
        evalId: 'eval-promoted-1',
        source: 'live',
        identityRevision: 1,
        promotionManifestId: 'manifest-1',
      }],
    }, { repoDir, configDir });

    const summary = await backfillHokusaiSubmissions({
      repoDir,
      configDir,
      promotionManifestPath: manifestPath,
      apply: true,
    });

    assert.equal(summary.results[0].action, 'refuse');
    assert.match(summary.results[0].status, /accepted_requires_correction_tombstone/);
    assert.equal(pendingLines(repoDir).length, 0);
    assert.ok(summary.reconciliationReportPath);
  });
});
