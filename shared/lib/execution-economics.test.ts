/**
 * Tests for the execution-economics normalization and join module (HOK-2958 /
 * HOK-3407).
 *
 * Covers: SDK-row input, stage labels read from the session-ownership record
 * (HOK-3328 replays: a post-reap coding session, a helper inside the review
 * window, a Ready remediation), owned-only enumeration (HOK-3407 drops the
 * historical unowned-session block), route/executed conflict emission, turn
 * truncation, and per-session cost copied from the `@hokusai/costs` report.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IngestUsageInput } from '@hokusai/costs';
import {
  buildExecutionEconomics,
  DEFAULT_TURN_CAP,
  PROVIDER_CONTRACT_VERSIONS,
} from './execution-economics.ts';
import { EXECUTION_ECONOMICS_SCHEMA_VERSION, type EvalRouting } from './eval-schema.ts';
import { appendOwnershipRow, helperKind, locateOwnershipRows, type SessionOwnershipRow } from './session-ownership.ts';
import type { OwnedSessionCost } from './sdk-task-cost/meter.ts';

function makeRow(overrides: Partial<IngestUsageInput> = {}): IngestUsageInput {
  return {
    eventId: 't1',
    taskId: 'test',
    sessionId: 'session-1',
    turnId: 't1',
    sequence: 1,
    harness: 'claude-code',
    harnessVersion: '2.1.270',
    providerContractVersion: 'claude-code/1',
    observedModel: 'claude-opus-4-6',
    usage: {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
    },
    usageKind: 'delta',
    observedAt: '2026-09-01T10:00:00Z',
    isSubagent: false,
    ...overrides,
  };
}

interface SessionBundle {
  sessionId: string;
  harness: 'claude-code' | 'codex';
  rows: IngestUsageInput[];
}

function buildMaps(
  bundles: SessionBundle[],
): { sessionUsageRows: Map<string, readonly IngestUsageInput[]>; sessionHarness: Map<string, 'claude-code' | 'codex'> } {
  const sessionUsageRows = new Map<string, readonly IngestUsageInput[]>();
  const sessionHarness = new Map<string, 'claude-code' | 'codex'>();
  for (const bundle of bundles) {
    sessionUsageRows.set(bundle.sessionId, bundle.rows);
    sessionHarness.set(bundle.sessionId, bundle.harness);
  }
  return { sessionUsageRows, sessionHarness };
}

function owner(sessionRef: string, kind: SessionOwnershipRow['kind'], model = 'claude-opus-4-6'): SessionOwnershipRow {
  const stage = kind === 'planning' || kind === 'coding' || kind === 'review' ? kind : undefined;
  return { sessionRef, harness: 'claude-code', kind, ...(stage ? { stage } : {}), model, launchedAt: '2026-09-01T09:55:00.000Z', attemptId: `${kind}@abc1234#1`, cwd: '/wt' };
}

function sdkCost(overrides: Partial<OwnedSessionCost> = {}): OwnedSessionCost {
  return { totalUsd: 22.5, actualUsd: null, estimatedUsd: 22.5, coverage: 'complete', costSource: 'local_estimate', pricingRevision: '2026-10-01', ...overrides };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const routing: EvalRouting = {
  coder: {
    role: 'coder',
    requestedSelector: { kind: 'alias', family: 'opus' },
    resolvedModelId: 'claude-opus-4-6',
    sourceLayer: 'config',
  },
};

describe('buildExecutionEconomics', () => {
  it('normalizes Claude and Codex sessions into the same versioned schema', () => {
    // protects: both harnesses produce the identical top-level key set
    const maps = buildMaps([
      { sessionId: 'session-1', harness: 'claude-code', rows: [makeRow()] },
      { sessionId: 'codex-1', harness: 'codex', rows: [makeRow({ sessionId: 'codex-1', harness: 'codex', providerContractVersion: 'codex/1', observedModel: 'gpt-5.3-codex' })] },
    ]);

    const blocks = buildExecutionEconomics({
      ...maps,
      issueId: 'HOK-2958',
      branch: 'task/slug',
      ownership: [owner('session-1', 'coding'), { sessionRef: 'codex-1', harness: 'codex', kind: 'coding', stage: 'coding', model: 'gpt-5.3-codex', launchedAt: '2026-09-01T09:55:00.000Z', attemptId: 'coding@abc1234#1', cwd: '/wt' }],
    });

    assert.equal(blocks.length, 2);
    const byHarness = new Map(blocks.map((b) => [b.harness, b] as const));
    const claudeBlock = byHarness.get('claude-code');
    const codexBlock = byHarness.get('codex');
    assert.ok(claudeBlock);
    assert.ok(codexBlock);
    assert.equal(claudeBlock.providerContractVersion, PROVIDER_CONTRACT_VERSIONS['claude-code']);
    assert.equal(codexBlock.providerContractVersion, 'codex/1');
    for (const block of blocks) {
      assert.equal(block.schemaVersion, EXECUTION_ECONOMICS_SCHEMA_VERSION);
      assert.deepEqual(block.joinEvidence, { issueId: 'HOK-2958', branch: 'task/slug' });
      assert.equal(block.sessionCount, 1);
      assert.equal(block.turnCount, 1);
      assert.deepEqual(Object.keys(block).sort(), Object.keys(blocks[0]).sort());
      assert.deepEqual(
        Object.keys(block.sessions[0]).sort(),
        Object.keys(blocks[0].sessions[0]).sort(),
      );
    }
  });

  // protects: stage labels guessed from timestamps instead of read from the launch row
  it('labels a session from its launch row and joins that stage\'s route intent', () => {
    const maps = buildMaps([{ sessionId: 'session-1', harness: 'claude-code', rows: [makeRow()] }]);
    const blocks = buildExecutionEconomics({
      ...maps,
      issueId: 'HOK-2958',
      branch: 'task/slug',
      routing,
      ownership: [owner('session-1', 'coding')],
    });

    const session = blocks[0].sessions[0];
    assert.deepEqual(session.stageRole, {
      value: 'coding',
      kind: 'coding',
      confidence: 'launch_record',
      evidence: 'launch coding@abc1234#1 at 2026-09-01T09:55:00.000Z',
    });
    assert.equal(session.models.requested, 'alias:opus');
    assert.equal(session.models.resolved, 'claude-opus-4-6');
    assert.equal(session.models.executed, 'claude-opus-4-6');
    assert.equal(session.models.provenance.resolved, 'routing.jsonl');
    assert.equal(session.models.provenance.executed, 'session_telemetry');
    assert.equal(session.models.conflict, undefined);
  });

  // protects: HOK-3114 — a reaped task's coding session reported unlabelled because no live stage result existed
  it('HOK-3114 replay: an archived ownership row labels the post-reap coding session', () => {
    const repo = mkdtempSync(join(tmpdir(), 'economics-archive-'));
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
    const archive = join(repo, '.wavemill', 'evals', 'artifacts', 'HOK-3114');
    mkdirSync(archive, { recursive: true });
    appendOwnershipRow(archive, {
      sessionRef: 'hok-3114-coding',
      harness: 'claude-code',
      kind: 'coding',
      model: 'claude-opus-4-6',
      launchedAt: '2026-10-14T13:25:39.000Z',
    });
    const { rows } = locateOwnershipRows({ repoDir: repo, issueId: 'HOK-3114', slug: 'task-identity', worktreePath: join(repo, 'reaped') });
    const maps = buildMaps([{
      sessionId: 'hok-3114-coding',
      harness: 'claude-code',
      rows: [
        makeRow({ sessionId: 'hok-3114-coding', eventId: 't1', turnId: 't1', observedAt: '2026-10-14T13:26:00Z' }),
        makeRow({ sessionId: 'hok-3114-coding', eventId: 't2', turnId: 't2', observedAt: '2026-10-14T13:38:00Z', sequence: 2 }),
      ],
    }]);
    const blocks = buildExecutionEconomics({ ...maps, ownership: rows });
    assert.equal(blocks[0].sessions[0].stageRole.value, 'coding');
    assert.equal(blocks[0].sessions[0].stageRole.confidence, 'launch_record');
  });

  // protects: helper calls that ran while review was open being labelled review (858 sessions in Oct 2026)
  it('labels a helper inside the review window as its helper kind, with its own cost', () => {
    const maps = buildMaps([
      { sessionId: 'review-session', harness: 'claude-code', rows: [makeRow({ sessionId: 'review-session' })] },
      { sessionId: 'helper-session', harness: 'claude-code', rows: [makeRow({ sessionId: 'helper-session', observedModel: 'claude-haiku-4-5' })] },
    ]);
    const blocks = buildExecutionEconomics({
      ...maps,
      routing,
      ownership: [owner('review-session', 'review'), owner('helper-session', helperKind('task-packet-validation'), 'claude-haiku-4-5')],
      sessionCosts: new Map([
        ['review-session', sdkCost()],
        ['helper-session', sdkCost({ totalUsd: 0.06, estimatedUsd: 0.06 })],
      ]),
    });
    const bySessionId = new Map(blocks[0].sessions.map((s) => [s.sessionId, s] as const));
    const review = bySessionId.get('review-session')!;
    const helper = bySessionId.get('helper-session')!;
    assert.equal(review.stageRole.value, 'review');
    assert.deepEqual([helper.stageRole.value, helper.stageRole.kind], [null, 'helper:task-packet-validation']);
    // A helper has no stage, so no route intent is joined to it.
    assert.equal(helper.models.resolved, null);
    assert.equal(helper.estimatedCostUsd, 0.06);
  });

  // protects: Ready remediation spend ($387 in Oct 2026) staying unlabelled — it has no stage result
  it('labels a Ready remediation session ready-remediation', () => {
    const maps = buildMaps([{ sessionId: 'ready-fix', harness: 'claude-code', rows: [makeRow({ sessionId: 'ready-fix' })] }]);
    const blocks = buildExecutionEconomics({
      ...maps,
      ownership: [owner('ready-fix', 'ready-remediation')],
    });
    assert.deepEqual(
      [blocks[0].sessions[0].stageRole.value, blocks[0].sessions[0].stageRole.kind, blocks[0].sessions[0].stageRole.confidence],
      [null, 'ready-remediation', 'launch_record'],
    );
  });

  // protects: HOK-3407 — an operator session the launch never recorded must not appear as a session block at all
  it('drops a session with no ownership row entirely (owned sessions only)', () => {
    const maps = buildMaps([{ sessionId: 'typed-by-hand', harness: 'claude-code', rows: [makeRow({ sessionId: 'typed-by-hand' })] }]);
    const blocks = buildExecutionEconomics({
      ...maps,
      routing,
      ownership: [owner('some-other-session', 'coding')],
    });
    assert.deepEqual(blocks, []);
  });

  // protects: a route/telemetry disagreement being coerced away
  it('emits a visible conflict when the resolved route model was never executed', () => {
    const maps = buildMaps([{ sessionId: 'session-1', harness: 'claude-code', rows: [makeRow({ observedModel: 'claude-sonnet-5' })] }]);
    const blocks = buildExecutionEconomics({
      ...maps,
      routing,
      ownership: [owner('session-1', 'coding', 'claude-sonnet-5')],
    });

    const session = blocks[0].sessions[0];
    assert.equal(session.models.resolved, 'claude-opus-4-6');
    assert.equal(session.models.executed, 'claude-sonnet-5');
    assert.ok(session.models.conflict);
    assert.equal(session.models.conflict?.otherSource, 'session_telemetry');
    assert.equal(session.models.conflict?.otherResolvedModel, 'claude-sonnet-5');
    assert.ok(session.models.conflict?.detail.includes('claude-opus-4-6'));
    assert.ok(session.models.conflict?.detail.includes('launch row agrees with telemetry'));
  });

  // protects: per-session cost diverging from the SDK report (HOK-3237: claude-code $43.71 from both)
  it('copies per-session cost from the @hokusai/costs report', () => {
    const now = () => new Date('2026-09-02T00:00:00Z');
    const maps = buildMaps([{ sessionId: 'session-1', harness: 'claude-code', rows: [makeRow()] }]);
    const blocks = buildExecutionEconomics({
      ...maps,
      ownership: [owner('session-1', 'coding')],
      sessionCosts: new Map([['session-1', sdkCost({ totalUsd: 43.71, estimatedUsd: 43.71 })]]),
      now,
    });

    const session = blocks[0].sessions[0];
    assert.equal(session.estimatedCostUsd, 43.71);
    assert.equal(session.actualCostUsd, null);
    assert.equal(session.costSource, 'local_estimate');
    assert.equal(session.coverage, 'complete');
    assert.equal(session.pricingRevision, '2026-10-01');
    assert.equal(session.pricingTimestamp, '2026-09-02T00:00:00.000Z');
    assert.equal(session.fieldAvailability.actualCost, 'unavailable');
    assert.equal(blocks[0].collectedAt, '2026-09-02T00:00:00.000Z');
  });

  // protects: an owned session the SDK could not cost being presented as $0
  it('never fabricates zero for an owned session the SDK report left unpriced', () => {
    const maps = buildMaps([{ sessionId: 'session-1', harness: 'claude-code', rows: [makeRow({ observedModel: 'mystery-model' })] }]);
    const blocks = buildExecutionEconomics({
      ...maps,
      ownership: [owner('session-1', 'coding')],
      sessionCosts: new Map([['session-1', sdkCost({ totalUsd: null, estimatedUsd: null, coverage: 'partial', costSource: 'none' })]]),
    });
    const session = blocks[0].sessions[0];
    assert.equal(session.estimatedCostUsd, null);
    assert.equal(session.costSource, 'none');
    assert.equal(session.coverage, 'partial');
  });

  it('caps per-turn detail while preserving model segments and real counts', () => {
    // protects: a long session still reports modelSegments against every turn before the cap
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeRow({
        eventId: `t${i}`,
        turnId: `t${i}`,
        sequence: i + 1,
        observedModel: i < 6 ? 'claude-opus-4-6' : 'claude-sonnet-5',
        observedAt: `2026-09-01T10:0${Math.min(i, 9)}:00Z`,
      }));
    const maps = buildMaps([{ sessionId: 'session-1', harness: 'claude-code', rows }]);
    const blocks = buildExecutionEconomics({
      ...maps,
      ownership: [owner('session-1', 'coding')],
      turnCap: 4,
    });

    const session = blocks[0].sessions[0];
    assert.equal(session.turnCount, 10);
    assert.equal(session.turns.length, 4);
    assert.equal(session.turnsTruncated, true);
    assert.deepEqual(session.modelSegments, [
      { model: 'claude-opus-4-6', turnCount: 6 },
      { model: 'claude-sonnet-5', turnCount: 4 },
    ]);
    assert.ok(session.diagnostics.some((d) => d.includes('truncated')));
    assert.equal(blocks[0].turnCount, 10);
  });

  it('defaults the turn cap to a bounded value', () => {
    assert.equal(DEFAULT_TURN_CAP, 400);
  });

  it('propagates degraded per-turn availability into fieldAvailability', () => {
    // protects: a turn with no identity or usage is marked unavailable, not fabricated
    const maps = buildMaps([{
      sessionId: 'session-1',
      harness: 'claude-code',
      rows: [makeRow({
        harnessVersion: undefined,
        turnId: null as unknown as string,
        usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, reasoning_tokens: null },
      })],
    }]);
    const blocks = buildExecutionEconomics({
      ...maps,
      ownership: [owner('session-1', 'coding')],
    });

    const session = blocks[0].sessions[0];
    assert.equal(session.fieldAvailability.harnessVersion, 'unavailable');
    assert.equal(session.fieldAvailability.triggerSource, 'unavailable');
    assert.equal(session.fieldAvailability.turnLineage, 'unavailable');
    assert.equal(session.fieldAvailability.perTurnUsage, 'unavailable');
    assert.equal(session.fieldAvailability.reasoningTokens, 'unavailable');
    assert.equal(session.triggerSource.availability, 'unavailable');
  });

  it('skips harnesses with no owned rows', () => {
    // protects: a stage with no session-usage rows produces no block
    const blocks = buildExecutionEconomics({
      sessionUsageRows: new Map(),
      sessionHarness: new Map(),
    });
    assert.deepEqual(blocks, []);
  });

  // HOK-3407 replay: streamed-duplicate Claude Code rows + Codex cached_input_tokens
  // both produce correct, deduplicated / disjoint token totals.
  it('deduplicates streamed Claude rows and does not double-count Codex cached input', () => {
    // protects: HOK-3407 — session usage inflated 2–2.5x by streamed duplicates
    // and Codex `input_tokens` already including cached. The SDK sources dedupe
    // on `eventKey` and emit disjoint buckets, so downstream sees one row per
    // real turn with `input_tokens = total - cached` for Codex.
    //
    // Here we simulate what the SDK's extractor emits: the Claude streamed
    // duplicates have been collapsed to one row (keyed on
    // message.id + requestId), and Codex rows carry disjoint buckets.
    const claudeRows: IngestUsageInput[] = [
      makeRow({ sessionId: 'claude-sess', eventId: 'msg-a.req-a', turnId: 'msg-a.req-a',
        usage: { input_tokens: 500, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 },
        observedAt: '2026-11-03T10:00:00Z' }),
      makeRow({ sessionId: 'claude-sess', eventId: 'msg-b.req-b', turnId: 'msg-b.req-b', sequence: 2,
        usage: { input_tokens: 600, output_tokens: 30, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 },
        observedAt: '2026-11-03T10:01:00Z' }),
    ];
    const codexRows: IngestUsageInput[] = [
      makeRow({ sessionId: 'codex-sess', harness: 'codex', providerContractVersion: 'codex/1',
        eventId: 'c1', turnId: 'c1', observedModel: 'gpt-5.3-codex',
        // Disjoint buckets: total input 1000 includes 400 cache → the SDK
        // normalizes that into input=600 + cache_read=400.
        usage: { input_tokens: 600, output_tokens: 100, cache_read_tokens: 400, cache_write_tokens: null, reasoning_tokens: 50 },
        observedAt: '2026-11-03T10:00:00Z' }),
    ];
    const maps = buildMaps([
      { sessionId: 'claude-sess', harness: 'claude-code', rows: claudeRows },
      { sessionId: 'codex-sess', harness: 'codex', rows: codexRows },
    ]);
    const blocks = buildExecutionEconomics({
      ...maps,
      ownership: [
        { ...owner('claude-sess', 'coding'), sessionRef: 'claude-sess' },
        { sessionRef: 'codex-sess', harness: 'codex', kind: 'planning', stage: 'planning', model: 'gpt-5.3-codex', launchedAt: '2026-09-01T09:55:00.000Z', attemptId: 'planning@abc1234#1', cwd: '/wt' },
      ],
    });

    const byHarness = new Map(blocks.map((b) => [b.harness, b] as const));
    const claudeSession = byHarness.get('claude-code')!.sessions[0];
    const codexSession = byHarness.get('codex')!.sessions[0];

    // Claude totals equal the per-turn sum (post-dedup), not 2–2.5x it.
    assert.equal(claudeSession.turnCount, 2);
    assert.equal(claudeSession.usage.inputTokens, 1100);
    assert.equal(claudeSession.usage.outputTokens, 50);

    // Codex totals do NOT double-count cache_read_tokens into inputTokens.
    assert.equal(codexSession.turnCount, 1);
    assert.equal(codexSession.usage.inputTokens, 600);
    assert.equal(codexSession.usage.cacheReadTokens, 400);
    assert.equal(codexSession.usage.outputTokens, 100);
    assert.equal(codexSession.usage.reasoningTokens, 50);
  });
});
