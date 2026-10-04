/**
 * Tests for the execution-economics normalization and join module (HOK-2958).
 *
 * Covers: both-harness normalization into one schema, join-confidence tiers,
 * route/executed conflict emission, turn truncation, and the
 * null-vs-known_zero cost invariant.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
import type { StageResultMap } from './stage-result.ts';

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

const codingStageResults: StageResultMap = {
  coding: {
    stage: 'coding',
    status: 'completed',
    startedAt: '2026-09-01T09:55:00Z',
    finishedAt: '2026-09-01T11:00:00Z',
    agent: 'claude',
    model: 'claude-opus-4-6',
    notes: '',
  },
};

const routing: EvalRouting = {
  coder: {
    role: 'coder',
    requestedSelector: { kind: 'alias', family: 'opus' },
    resolvedModelId: 'claude-opus-4-6',
    sourceLayer: 'config',
  },
};

const PRICING = {
  'claude-opus-4-6': { inputCostPerMTok: 15, outputCostPerMTok: 75 },
  'free-model': { inputCostPerMTok: 0, outputCostPerMTok: 0 },
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
      pricingTable: PRICING,
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

  it('joins a session to its stage window with timestamp_window confidence and route intent', () => {
    const blocks = buildExecutionEconomics({
      scanResults: [scanResult([makeSession()])],
      issueId: 'HOK-2958',
      branch: 'task/slug',
      routing,
      stageResults: codingStageResults,
      pricingTable: PRICING,
    });

    const session = blocks[0].sessions[0];
    assert.equal(session.stageRole.value, 'coding');
    assert.equal(session.stageRole.confidence, 'timestamp_window');
    assert.ok(session.stageRole.evidence?.includes('.coding-result.json'));
    assert.equal(session.models.requested, 'alias:opus');
    assert.equal(session.models.resolved, 'claude-opus-4-6');
    assert.equal(session.models.executed, 'claude-opus-4-6');
    assert.equal(session.models.provenance.resolved, 'routing.jsonl');
    assert.equal(session.models.provenance.executed, 'session_telemetry');
    assert.equal(session.models.conflict, undefined);
  });

  it('leaves sessions unattributed when stage windows are missing, and still persists them', () => {
    const blocks = buildExecutionEconomics({
      scanResults: [scanResult([makeSession()])],
      routing,
      pricingTable: PRICING,
    });

    const session = blocks[0].sessions[0];
    assert.equal(session.stageRole.value, null);
    assert.equal(session.stageRole.confidence, 'unattributed');
    // Without a stage there is no role whose route applies — no coerced join.
    assert.equal(session.models.requested, null);
    assert.equal(session.models.resolved, null);
    assert.equal(session.models.executed, 'claude-opus-4-6');
  });

  it('marks ambiguous multi-stage overlap as unattributed with evidence', () => {
    const overlappingStages: StageResultMap = {
      ...codingStageResults,
      review: {
        stage: 'review',
        status: 'completed',
        startedAt: '2026-09-01T09:50:00Z',
        finishedAt: '2026-09-01T11:30:00Z',
        agent: 'claude',
        model: 'claude-opus-4-6',
        notes: '',
      },
    };
    const blocks = buildExecutionEconomics({
      scanResults: [scanResult([makeSession()])],
      stageResults: overlappingStages,
      pricingTable: PRICING,
    });

    const session = blocks[0].sessions[0];
    assert.equal(session.stageRole.value, null);
    assert.equal(session.stageRole.confidence, 'unattributed');
    assert.ok(session.stageRole.evidence?.includes('ambiguous'));
    assert.ok(session.diagnostics.some((d) => d.includes('ambiguous')));
  });

  it('emits a visible conflict when the resolved route model was never executed', () => {
    const blocks = buildExecutionEconomics({
      scanResults: [scanResult([
        makeSession({ turns: [makeTurn({ model: 'claude-sonnet-5' })] }),
      ])],
      routing,
      stageResults: codingStageResults,
      pricingTable: { ...PRICING, 'claude-sonnet-5': { inputCostPerMTok: 3, outputCostPerMTok: 15 } },
    });

    const session = blocks[0].sessions[0];
    assert.equal(session.models.resolved, 'claude-opus-4-6');
    assert.equal(session.models.executed, 'claude-sonnet-5');
    assert.ok(session.models.conflict);
    assert.equal(session.models.conflict?.otherSource, 'session_telemetry');
    assert.equal(session.models.conflict?.otherResolvedModel, 'claude-sonnet-5');
    // Both values remain visible — nothing is coerced.
    assert.ok(session.models.conflict?.detail.includes('claude-opus-4-6'));
  });

  it('estimates cost from the pricing table and stamps provenance', () => {
    const now = () => new Date('2026-09-02T00:00:00Z');
    const blocks = buildExecutionEconomics({
      scanResults: [scanResult([makeSession()])],
      pricingTable: PRICING,
      pricingRevision: 'registry-2026-09',
      now,
    });

    const session = blocks[0].sessions[0];
    // 1M input @ $15/MTok + 100K output @ $75/MTok = 15 + 7.5
    assert.equal(session.estimatedCostUsd, 22.5);
    assert.equal(session.actualCostUsd, null);
    assert.equal(session.costSource, 'local_estimate');
    assert.equal(session.pricingRevision, 'registry-2026-09');
    assert.equal(session.pricingTimestamp, '2026-09-02T00:00:00.000Z');
    assert.equal(session.fieldAvailability.actualCost, 'unavailable');
    assert.equal(blocks[0].collectedAt, '2026-09-02T00:00:00.000Z');
  });

  it('never fabricates zero for unpriced models, but allows known_zero with evidence', () => {
    const unpricedBlocks = buildExecutionEconomics({
      scanResults: [scanResult([
        makeSession({ turns: [makeTurn({ model: 'mystery-model' })] }),
      ])],
      pricingTable: PRICING,
    });
    const unpricedSession = unpricedBlocks[0].sessions[0];
    assert.equal(unpricedSession.estimatedCostUsd, null);
    assert.equal(unpricedSession.costSource, 'none');
    assert.equal(unpricedSession.coverage, 'partial');
    assert.ok(unpricedSession.diagnostics.some((d) => d.includes('unpriced')));

    const zeroBlocks = buildExecutionEconomics({
      scanResults: [scanResult([
        makeSession({ turns: [makeTurn({ model: 'free-model' })] }),
      ])],
      pricingTable: PRICING,
    });
    const zeroSession = zeroBlocks[0].sessions[0];
    assert.equal(zeroSession.estimatedCostUsd, 0);
    assert.equal(zeroSession.coverage, 'known_zero');
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
      pricingTable: { ...PRICING, 'claude-sonnet-5': { inputCostPerMTok: 3, outputCostPerMTok: 15 } },
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
      pricingTable: PRICING,
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
      pricingTable: PRICING,
    });
    assert.deepEqual(blocks, []);
  });
});
