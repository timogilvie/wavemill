/**
 * Tests for the execution-economics normalization and join module (HOK-2958).
 *
 * Covers: both-harness normalization into one schema, stage labels read from
 * the session-ownership record (HOK-3328 replays: a post-reap coding session,
 * a helper inside the review window, a Ready remediation, an unowned operator
 * session), route/executed conflict emission, turn truncation, and per-session
 * cost copied from the `@hokusai/costs` report.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildExecutionEconomics,
  DEFAULT_TURN_CAP,
  PROVIDER_CONTRACT_VERSIONS,
} from './execution-economics.ts';
import { EXECUTION_ECONOMICS_SCHEMA_VERSION, type EvalRouting } from './eval-schema.ts';
import type {
  ExternalSessionTurn,
  ExternalSessionUsageRecord,
  SessionUsageResult,
} from './session-adapters.ts';
import { appendOwnershipRow, helperKind, locateOwnershipRows, type SessionOwnershipRow } from './session-ownership.ts';
import type { OwnedSessionCost } from './sdk-task-cost/meter.ts';

function makeTurn(overrides: Partial<ExternalSessionTurn> = {}): ExternalSessionTurn {
  return {
    turnId: 't1',
    parentId: null,
    isSubagent: false,
    model: 'claude-opus-4-6',
    timestamp: '2026-09-01T10:00:00Z',
    usage: {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    usageAvailable: true,
    actualCostUsd: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<ExternalSessionUsageRecord> = {}): ExternalSessionUsageRecord {
  const turns = overrides.turns ?? [makeTurn()];
  return {
    sessionId: 'session-1',
    harness: 'claude-code',
    harnessVersion: '2.1.270',
    triggerSource: 'sdk',
    triggerProvenance: 'claude_code.promptSource',
    startedAt: turns[0]?.timestamp ?? '2026-09-01T10:00:00Z',
    endedAt: turns[turns.length - 1]?.timestamp ?? '2026-09-01T10:30:00Z',
    turnCount: turns.length,
    turns,
    usage: {
      inputTokens: turns.reduce((sum, t) => sum + (t.usage.inputTokens ?? 0), 0),
      outputTokens: turns.reduce((sum, t) => sum + (t.usage.outputTokens ?? 0), 0),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    actualCostUsd: null,
    diagnostics: [],
    ...overrides,
  };
}

function scanResult(sessions: ExternalSessionUsageRecord[], source: 'claude' | 'codex' = 'claude'): SessionUsageResult {
  return {
    models: {},
    sessionCount: sessions.length,
    turnCount: sessions.reduce((sum, s) => sum + s.turnCount, 0),
    source,
    externalSessions: sessions,
  };
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
    const claudeSession = makeSession();
    const codexSession = makeSession({
      sessionId: 'codex-1',
      harness: 'codex',
      harnessVersion: '0.154.0',
      triggerSource: 'codex_exec',
      triggerProvenance: 'codex.session_meta.originator',
      turns: [makeTurn({ model: 'gpt-5.3-codex' })],
    });

    const blocks = buildExecutionEconomics({
      scanResults: [scanResult([claudeSession], 'claude'), scanResult([codexSession], 'codex')],
      issueId: 'HOK-2958',
      branch: 'task/slug',
    });

    assert.equal(blocks.length, 2);
    const [claudeBlock, codexBlock] = blocks;
    assert.equal(claudeBlock.harness, 'claude-code');
    assert.equal(claudeBlock.providerContractVersion, PROVIDER_CONTRACT_VERSIONS['claude-code']);
    assert.equal(codexBlock.harness, 'codex');
    assert.equal(codexBlock.providerContractVersion, 'codex/1');
    for (const block of blocks) {
      assert.equal(block.schemaVersion, EXECUTION_ECONOMICS_SCHEMA_VERSION);
      assert.deepEqual(block.joinEvidence, { issueId: 'HOK-2958', branch: 'task/slug' });
      assert.equal(block.sessionCount, 1);
      assert.equal(block.turnCount, 1);
      // Both harnesses produce the identical top-level key set.
      assert.deepEqual(Object.keys(block).sort(), Object.keys(blocks[0]).sort());
      assert.deepEqual(
        Object.keys(block.sessions[0]).sort(),
        Object.keys(blocks[0].sessions[0]).sort(),
      );
    }
  });

  // protects: stage labels guessed from timestamps instead of read from the launch row
  it('labels a session from its launch row and joins that stage\'s route intent', () => {
    const blocks = buildExecutionEconomics({
      scanResults: [scanResult([makeSession()])],
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
    // Live feature dir is gone after reap; only the archive remains.
    const { rows } = locateOwnershipRows({ repoDir: repo, issueId: 'HOK-3114', slug: 'task-identity', worktreePath: join(repo, 'reaped') });
    const blocks = buildExecutionEconomics({
      scanResults: [scanResult([makeSession({
        sessionId: 'hok-3114-coding',
        turns: [makeTurn({ timestamp: '2026-10-14T13:26:00Z' }), makeTurn({ turnId: 't2', timestamp: '2026-10-14T13:38:00Z' })],
      })])],
      ownership: rows,
    });
    assert.equal(blocks[0].sessions[0].stageRole.value, 'coding');
    assert.equal(blocks[0].sessions[0].stageRole.confidence, 'launch_record');
  });

  // protects: helper calls that ran while review was open being labelled review (858 sessions in Oct 2026)
  it('labels a helper inside the review window as its helper kind, with its own cost', () => {
    const blocks = buildExecutionEconomics({
      scanResults: [scanResult([
        makeSession({ sessionId: 'review-session' }),
        makeSession({ sessionId: 'helper-session', turns: [makeTurn({ model: 'claude-haiku-4-5' })] }),
      ])],
      routing,
      ownership: [owner('review-session', 'review'), owner('helper-session', helperKind('task-packet-validation'), 'claude-haiku-4-5')],
      sessionCosts: new Map([
        ['review-session', sdkCost()],
        ['helper-session', sdkCost({ totalUsd: 0.06, estimatedUsd: 0.06 })],
      ]),
    });
    const [review, helper] = blocks[0].sessions;
    assert.equal(review.stageRole.value, 'review');
    assert.deepEqual([helper.stageRole.value, helper.stageRole.kind], [null, 'helper:task-packet-validation']);
    // A helper has no stage, so no route intent is joined to it.
    assert.equal(helper.models.resolved, null);
    assert.equal(helper.estimatedCostUsd, 0.06);
  });

  // protects: Ready remediation spend ($387 in Oct 2026) staying unlabelled — it has no stage result
  it('labels a Ready remediation session ready-remediation', () => {
    const blocks = buildExecutionEconomics({
      scanResults: [scanResult([makeSession({ sessionId: 'ready-fix' })])],
      ownership: [owner('ready-fix', 'ready-remediation')],
    });
    assert.deepEqual(
      [blocks[0].sessions[0].stageRole.value, blocks[0].sessions[0].stageRole.kind, blocks[0].sessions[0].stageRole.confidence],
      [null, 'ready-remediation', 'launch_record'],
    );
  });

  // protects: an operator-typed session in the worktree silently charged to the task
  it('reports a session no launch recorded as operator/unowned with no cost', () => {
    const blocks = buildExecutionEconomics({
      scanResults: [scanResult([makeSession({ sessionId: 'typed-by-hand' })])],
      routing,
      ownership: [owner('some-other-session', 'coding')],
      sessionCosts: new Map([['typed-by-hand', sdkCost()]]),
    });
    const session = blocks[0].sessions[0];
    assert.deepEqual([session.stageRole.value, session.stageRole.kind, session.stageRole.confidence], [null, 'operator', 'unowned']);
    assert.equal(session.estimatedCostUsd, null);
    assert.equal(session.costSource, 'none');
    assert.equal(session.coverage, 'unavailable');
    assert.ok(session.diagnostics.includes('unowned session: excluded from task cost'));
    assert.equal(session.models.resolved, null);
  });

  // protects: a route/telemetry disagreement being coerced away
  it('emits a visible conflict when the resolved route model was never executed', () => {
    const blocks = buildExecutionEconomics({
      scanResults: [scanResult([
        makeSession({ turns: [makeTurn({ model: 'claude-sonnet-5' })] }),
      ])],
      routing,
      ownership: [owner('session-1', 'coding', 'claude-sonnet-5')],
    });

    const session = blocks[0].sessions[0];
    assert.equal(session.models.resolved, 'claude-opus-4-6');
    assert.equal(session.models.executed, 'claude-sonnet-5');
    assert.ok(session.models.conflict);
    assert.equal(session.models.conflict?.otherSource, 'session_telemetry');
    assert.equal(session.models.conflict?.otherResolvedModel, 'claude-sonnet-5');
    // Both values remain visible — nothing is coerced.
    assert.ok(session.models.conflict?.detail.includes('claude-opus-4-6'));
    assert.ok(session.models.conflict?.detail.includes('launch row agrees with telemetry'));
  });

  // protects: per-session cost diverging from the SDK report (HOK-3237: claude-code $43.71 from both)
  it('copies per-session cost from the @hokusai/costs report', () => {
    const now = () => new Date('2026-09-02T00:00:00Z');
    const blocks = buildExecutionEconomics({
      scanResults: [scanResult([makeSession()])],
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
    const blocks = buildExecutionEconomics({
      scanResults: [scanResult([makeSession({ turns: [makeTurn({ model: 'mystery-model' })] })])],
      ownership: [owner('session-1', 'coding')],
      sessionCosts: new Map([['session-1', sdkCost({ totalUsd: null, estimatedUsd: null, coverage: 'partial', costSource: 'none' })]]),
    });
    const session = blocks[0].sessions[0];
    assert.equal(session.estimatedCostUsd, null);
    assert.equal(session.costSource, 'none');
    assert.equal(session.coverage, 'partial');
  });

  it('caps per-turn detail while preserving model segments and real counts', () => {
    const manyTurns = Array.from({ length: 10 }, (_, i) =>
      makeTurn({
        turnId: `t${i}`,
        model: i < 6 ? 'claude-opus-4-6' : 'claude-sonnet-5',
        timestamp: `2026-09-01T10:0${Math.min(i, 9)}:00Z`,
      }));
    const blocks = buildExecutionEconomics({
      scanResults: [scanResult([makeSession({ turns: manyTurns })])],
      turnCap: 4,
    });

    const session = blocks[0].sessions[0];
    assert.equal(session.turnCount, 10);
    assert.equal(session.turns.length, 4);
    assert.equal(session.turnsTruncated, true);
    // Segments computed over the full pre-cap turn list, so the model switch survives.
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
    const blocks = buildExecutionEconomics({
      scanResults: [scanResult([
        makeSession({
          harnessVersion: null,
          triggerSource: null,
          triggerProvenance: null,
          turns: [
            makeTurn({ turnId: null, usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null }, usageAvailable: false }),
          ],
          usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null },
        }),
      ])],
    });

    const session = blocks[0].sessions[0];
    assert.equal(session.fieldAvailability.harnessVersion, 'unavailable');
    assert.equal(session.fieldAvailability.triggerSource, 'unavailable');
    assert.equal(session.fieldAvailability.turnLineage, 'unavailable');
    assert.equal(session.fieldAvailability.perTurnUsage, 'unavailable');
    assert.equal(session.fieldAvailability.reasoningTokens, 'unavailable');
    assert.equal(session.triggerSource.availability, 'unavailable');
  });

  it('skips scan results without external sessions', () => {
    const blocks = buildExecutionEconomics({
      scanResults: [null, undefined, { models: {}, sessionCount: 1, turnCount: 1, source: 'claude' }],
    });
    assert.deepEqual(blocks, []);
  });
});
