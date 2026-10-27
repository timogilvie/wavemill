import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExternalSessionUsageRecord, NativeSessionUsageRecord } from '../session-adapters.ts';
import type { PricingTable } from '../pricing/model-pricing.ts';
import { validateTaskCostEventV1 } from './contract.ts';
import {
  eventsFromExternalSession,
  eventsFromNativeSessions,
  eventsFromScanResult,
  toTaskCostId,
  toTaskCostModel,
  toTaskCostTimestamp,
  turnsReconcileWithSession,
  usageCoverage,
  type TaskCostEventContext,
} from './events-from-session.ts';
import { listSdkTaskCostFixtures, loadSdkTaskCostFixture } from './fixtures.ts';

const NOW = '2026-10-01T00:00:00.000Z';

function ctx(pricingTable: PricingTable, overrides: Partial<TaskCostEventContext> = {}): TaskCostEventContext {
  return {
    taskId: 'HOK-3075',
    pricingTable,
    registryLookup: (modelId) => modelId,
    observedAtFallback: NOW,
    ...overrides,
  };
}

const OPUS: PricingTable = {
  'claude-opus-4': { inputCostPerMTok: 15, outputCostPerMTok: 75, cacheWriteCostPerMTok: 18.75, cacheReadCostPerMTok: 1.5 },
};

function usage(
  inputTokens: number | null,
  outputTokens: number | null,
  cacheReadTokens: number | null = 0,
  cacheWriteTokens: number | null = 0,
  reasoningTokens: number | null = 0,
) {
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens };
}

function externalSession(overrides: Partial<ExternalSessionUsageRecord> = {}): ExternalSessionUsageRecord {
  return {
    sessionId: 'session-1',
    harness: 'claude-code',
    harnessVersion: '2.1.270',
    triggerSource: null,
    triggerProvenance: null,
    startedAt: '2026-09-30T10:00:00Z',
    endedAt: '2026-09-30T10:05:00Z',
    turnCount: 2,
    turns: [
      {
        turnId: 't1', parentId: null, isSubagent: false, model: 'claude-opus-4',
        timestamp: '2026-09-30T10:00:00Z', usage: usage(1000, 100), usageAvailable: true, actualCostUsd: null,
      },
      {
        turnId: 't2', parentId: 't1', isSubagent: true, model: 'claude-opus-4',
        timestamp: '2026-09-30T10:05:00+02:00', usage: usage(2000, 200), usageAvailable: true, actualCostUsd: null,
      },
    ],
    usage: usage(3000, 300),
    actualCostUsd: null,
    diagnostics: [],
    ...overrides,
  };
}

function nativeSession(overrides: Partial<NativeSessionUsageRecord> = {}): NativeSessionUsageRecord {
  return {
    sessionId: 'native-1',
    filePath: '/repo/.wavemill/runs/run-1/native-sessions/HOK-3075.jsonl',
    provider: 'openrouter',
    modelId: 'deepseek/deepseek-chat',
    turnCount: 1,
    responseIds: ['gen-1'],
    turns: [{
      responseId: 'gen-1', inputTokens: 1000, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 100,
      usageAvailable: true, invalidUsage: false,
    }],
    inputTokens: 1000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 100,
    usageAvailable: true,
    invalidUsage: false,
    ...overrides,
  };
}

const DEEPSEEK: PricingTable = { 'deepseek/deepseek-chat': { inputCostPerMTok: 0.27, outputCostPerMTok: 1.1 } };

describe('identifier hygiene', () => {
  it('passes valid ids through and slugs cosmetic problems', () => {
    assert.equal(toTaskCostId('HOK-3075'), 'HOK-3075');
    assert.equal(toTaskCostId('a2f5c9e1-0b9c-4f3e'), 'a2f5c9e1-0b9c-4f3e');
    assert.equal(toTaskCostId('task with spaces'), 'task-with-spaces');
  });

  it('pseudonymizes path-like ids with a stable hash', () => {
    const path = '/Users/someone/repo/.wavemill/runs/run-1/native-sessions/HOK-1.jsonl';
    const id = toTaskCostId(path);
    assert.match(id, /^h-[0-9a-f]{32}$/);
    assert.equal(toTaskCostId(path), id);
    assert.equal(id.includes('Users'), false);
  });

  it('falls back for empty ids', () => {
    assert.equal(toTaskCostId(null), 'unknown');
    assert.equal(toTaskCostId('  ', 'unknown-task'), 'unknown-task');
  });

  it('normalizes model ids and rejects path-like sequences', () => {
    assert.equal(toTaskCostModel('deepseek/deepseek-chat'), 'deepseek/deepseek-chat');
    assert.equal(toTaskCostModel(null), 'unknown');
    assert.equal(toTaskCostModel('vendor//model..x'), 'vendor/model.x');
    assert.equal(toTaskCostModel('model name (beta)'), 'model-name-beta-');
  });

  it('normalizes timestamps to strict UTC ISO-8601', () => {
    assert.equal(toTaskCostTimestamp('2026-09-30T10:05:00+02:00', NOW), '2026-09-30T08:05:00.000Z');
    assert.equal(toTaskCostTimestamp('not a date', NOW), NOW);
    assert.equal(toTaskCostTimestamp(null, NOW), NOW);
  });
});

describe('usageCoverage', () => {
  it('mirrors the SDK availability rule', () => {
    const all = (value: number | null) => ({
      input_tokens: value, output_tokens: value, cache_read_tokens: value, cache_write_tokens: value, reasoning_tokens: value,
    });
    assert.equal(usageCoverage(all(null)), 'unavailable');
    assert.equal(usageCoverage(all(0)), 'known_zero');
    assert.equal(usageCoverage(all(5)), 'available');
    assert.equal(usageCoverage({ ...all(5), reasoning_tokens: null }), 'partial');
  });
});

describe('eventsFromExternalSession', () => {
  it('emits one valid delta event per turn when turns reconcile with the session', () => {
    const session = externalSession();
    assert.equal(turnsReconcileWithSession(session), true);
    const events = eventsFromExternalSession(session, ctx(OPUS));
    assert.equal(events.length, 2);
    for (const event of events) validateTaskCostEventV1(event);
    assert.deepEqual(events.map((event) => event.turn_id), ['t1', 't2']);
    assert.deepEqual(events.map((event) => event.sequence), [0, 1]);
    assert.equal(events[1].is_subagent, true);
    assert.equal(events[1].observed_at, '2026-09-30T08:05:00.000Z');
    assert.equal(events[0].provider_contract_version, 'claude-code/1');
    assert.equal(events[0].cost_basis, 'unknown');
    assert.equal(events[0].cost_source, 'local_estimate');
    // (1000 * 15 + 100 * 75) / 1e6
    assert.equal(events[0].estimated_cost_usd, 0.0225);
  });

  it('produces stable, unique event ids across re-runs', () => {
    const first = eventsFromExternalSession(externalSession(), ctx(OPUS));
    const second = eventsFromExternalSession(externalSession(), ctx(OPUS));
    assert.deepEqual(first.map((event) => event.event_id), second.map((event) => event.event_id));
    assert.equal(new Set(first.map((event) => event.event_id)).size, first.length);
  });

  it('keeps distinct turns distinct even when the source repeats a turn id', () => {
    const session = externalSession();
    session.turns[1].turnId = 't1';
    const events = eventsFromExternalSession(session, ctx(OPUS));
    assert.equal(new Set(events.map((event) => event.event_id)).size, 2);
  });

  it('falls back to one session-level event when turns disagree with the session totals', () => {
    const session = externalSession({ usage: usage(5000, 300) });
    assert.equal(turnsReconcileWithSession(session), false);
    const events = eventsFromExternalSession(session, ctx(OPUS));
    assert.equal(events.length, 1);
    validateTaskCostEventV1(events[0]);
    assert.equal(events[0].turn_id, 'session-total');
    assert.equal(events[0].usage.input_tokens, 5000);
    assert.equal(events[0].observed_model, 'claude-opus-4');
    // Session totals are authoritative: (5000 * 15 + 300 * 75) / 1e6
    assert.equal(events[0].estimated_cost_usd, 0.0975);
  });

  it('refuses to price a multi-model session from its totals', () => {
    const session = externalSession({ usage: usage(9999, 300) });
    session.turns[1].model = 'claude-sonnet-5';
    const events = eventsFromExternalSession(session, ctx(OPUS));
    assert.equal(events.length, 1);
    assert.equal(events[0].estimated_cost_usd, null);
    assert.equal(events[0].cost_source, 'none');
    assert.deepEqual(events[0].diagnostics, ['missing_token_usage']);
  });

  it('attributes a turn-less session to the fallback model', () => {
    const session = externalSession({ harness: 'codex', turns: [], turnCount: 0 });
    const [event] = eventsFromExternalSession(session, ctx({ 'gpt-5-codex': { inputCostPerMTok: 1, outputCostPerMTok: 10 } }), 'gpt-5-codex');
    validateTaskCostEventV1(event);
    assert.equal(event.observed_model, 'gpt-5-codex');
    assert.equal(event.provider_contract_version, 'codex/1');
    assert.notEqual(event.estimated_cost_usd, null);
  });

  it('bills Codex reasoning tokens as output in the local estimate', () => {
    const pricing: PricingTable = { 'gpt-5-codex': { inputCostPerMTok: 0, outputCostPerMTok: 10 } };
    const codex = externalSession({
      harness: 'codex',
      turns: [{
        turnId: 'c1', parentId: null, isSubagent: null, model: 'gpt-5-codex', timestamp: null,
        usage: usage(0, 100, 0, null, 50), usageAvailable: true, actualCostUsd: null,
      }],
      usage: usage(0, 100, 0, null, 50),
    });
    const [event] = eventsFromExternalSession(codex, ctx(pricing));
    assert.equal(event.estimated_cost_usd, 0.0015);
    assert.equal(event.usage.output_tokens, 100);
    assert.equal(event.usage.reasoning_tokens, 50);
    assert.equal(event.observed_at, '2026-09-30T10:05:00.000Z');
  });

  it('marks unpriced and usage-less observations without inventing a cost', () => {
    const [unpriced] = eventsFromExternalSession(externalSession({ turns: [] }), ctx({}), 'mystery-model');
    assert.equal(unpriced.estimated_cost_usd, null);
    assert.equal(unpriced.pricing_source, 'none');
    assert.deepEqual(unpriced.diagnostics, ['unpriced_model']);

    const [noUsage] = eventsFromExternalSession(
      externalSession({ turns: [], usage: usage(100, null, null, null, null) }),
      ctx(OPUS),
      'claude-opus-4',
    );
    assert.equal(noUsage.estimated_cost_usd, null);
    assert.deepEqual(noUsage.diagnostics, ['missing_token_usage']);
  });

  it('treats dimensions a harness never reports as structural zeros, not gaps (HOK-3076)', () => {
    const [claude] = eventsFromExternalSession(
      externalSession({ turns: [], usage: usage(3000, 300, 0, 0, null) }),
      ctx(OPUS),
      'claude-opus-4',
    );
    assert.equal(claude.usage.reasoning_tokens, 0);
    assert.equal(claude.usage_coverage, 'available');

    const [codex] = eventsFromExternalSession(
      externalSession({ harness: 'codex', turns: [], usage: usage(3000, 300, 0, null, 10) }),
      ctx({}),
      'gpt-5-codex',
    );
    assert.equal(codex.usage.cache_write_tokens, 0);
    assert.equal(codex.usage_coverage, 'available');

    // A dimension the harness does report stays a gap when it is missing...
    const [missingInput] = eventsFromExternalSession(
      externalSession({ turns: [], usage: usage(null, 300, 0, 0, null) }),
      ctx(OPUS),
      'claude-opus-4',
    );
    assert.equal(missingInput.usage.input_tokens, null);
    assert.equal(missingInput.usage_coverage, 'partial');

    // ...and a turn that reported nothing is never zero-filled.
    const [nothing] = eventsFromExternalSession(
      externalSession({ turns: [], usage: usage(null, null, null, null, null) }),
      ctx(OPUS),
      'claude-opus-4',
    );
    assert.equal(nothing.usage.reasoning_tokens, null);
    assert.equal(nothing.usage_coverage, 'unavailable');
  });

  it('attaches a valid pricing revision only to priced events', () => {
    const events = eventsFromExternalSession(externalSession(), ctx(OPUS, { pricingRevision: '2026-09-01' }));
    assert.equal(events[0].pricing_revision, '2026-09-01');
    const [unpriced] = eventsFromExternalSession(externalSession({ turns: [] }), ctx({}, { pricingRevision: '2026-09-01' }), 'x');
    assert.equal(unpriced.pricing_revision, undefined);
    const [bad] = eventsFromExternalSession(externalSession(), ctx(OPUS, { pricingRevision: 'not a revision!' }));
    assert.equal(bad.pricing_revision, undefined);
  });
});

describe('eventsFromNativeSessions', () => {
  it('pseudonymizes path-shaped native session ids', () => {
    const [event] = eventsFromNativeSessions([nativeSession({ sessionId: '/repo/.wavemill/runs/run-1/native-sessions/x.jsonl' })], ctx(DEEPSEEK));
    validateTaskCostEventV1(event);
    assert.match(event.session_id, /^h-/);
    assert.equal(JSON.stringify(event).includes('.wavemill'), false);
    assert.equal(event.turn_id, 'gen-1');
    assert.equal(event.provider_contract_version, 'native/1');
    assert.equal(event.cost_basis, 'per_token_api');
    assert.equal(event.usage.reasoning_tokens, null);
  });

  it('prefers a positive provider-reported cost over the local estimate', () => {
    const session = nativeSession();
    session.turns[0].providerReportedCostUsd = 0.004;
    const [event] = eventsFromNativeSessions([session], ctx(DEEPSEEK));
    assert.equal(event.actual_cost_usd, 0.004);
    assert.equal(event.estimated_cost_usd, null);
    assert.equal(event.cost_source, 'provider_reported');
  });

  it('distrusts a reported zero on a priced model with usage and estimates instead', () => {
    const session = nativeSession();
    session.turns[0].providerReportedCostUsd = 0;
    const [event] = eventsFromNativeSessions([session], ctx(DEEPSEEK));
    assert.equal(event.actual_cost_usd, null);
    assert.equal(event.estimated_cost_usd, (1000 * 0.27 + 100 * 1.1) / 1_000_000);
  });

  it('trusts a reported zero when nothing better exists (unpriced or explicit-zero model)', () => {
    const session = nativeSession();
    session.turns[0].providerReportedCostUsd = 0;
    assert.equal(eventsFromNativeSessions([session], ctx({}))[0].actual_cost_usd, 0);
    const free: PricingTable = { 'deepseek/deepseek-chat': { inputCostPerMTok: 0, outputCostPerMTok: 0 } };
    assert.equal(eventsFromNativeSessions([session], ctx(free))[0].actual_cost_usd, 0);
  });

  it('records invalid and missing usage as null usage with the legacy reason', () => {
    const session = nativeSession({
      turns: [
        { usageAvailable: false, invalidUsage: true, inputTokens: 5, outputTokens: 5 },
        { usageAvailable: false, invalidUsage: false },
      ],
    });
    const events = eventsFromNativeSessions([session], ctx(DEEPSEEK));
    assert.deepEqual(events.map((event) => event.diagnostics), [['invalid_token_usage'], ['missing_token_usage']]);
    assert.equal(events[0].usage_coverage, 'unavailable');
    assert.equal(events[0].usage.input_tokens, null);
  });

  it('keeps sequences monotonic across per-model records of one session', () => {
    const events = eventsFromNativeSessions([
      nativeSession(),
      nativeSession({ modelId: 'other/model' }),
    ], ctx(DEEPSEEK));
    assert.deepEqual(events.map((event) => event.sequence), [0, 1]);
    assert.equal(new Set(events.map((event) => event.event_id)).size, 2);
  });

  it('gives id-less turns from per-model records of one session distinct turn ids (HOK-3076)', () => {
    const idless = (modelId: string) => nativeSession({
      modelId,
      responseIds: [],
      turns: [{
        inputTokens: 1000, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 100,
        usageAvailable: true, invalidUsage: false,
      }],
    });
    const events = eventsFromNativeSessions([idless('deepseek/deepseek-chat'), idless('other/model')], ctx(DEEPSEEK));
    assert.equal(new Set(events.map((event) => event.turn_id)).size, 2);
  });

  it('keeps the native reasoning dimension unobserved: the Pi parser cannot prove it', () => {
    const [event] = eventsFromNativeSessions([nativeSession()], ctx(DEEPSEEK));
    assert.equal(event.usage.reasoning_tokens, null);
    assert.equal(event.usage_coverage, 'partial');
  });

  it('emits a session-level event for a transcript without turns', () => {
    const [event] = eventsFromNativeSessions([nativeSession({ turns: [], providerReportedCostUsd: 0.01 })], ctx(DEEPSEEK));
    assert.equal(event.turn_id, 'session-total');
    assert.equal(event.actual_cost_usd, 0.01);
  });

  it('observes the canonical registry model id', () => {
    const [event] = eventsFromNativeSessions([nativeSession()], ctx(DEEPSEEK, {
      registryLookup: (model) => (model === 'deepseek/deepseek-chat' ? 'deepseek-chat' : model),
    }));
    assert.equal(event.observed_model, 'deepseek-chat');
    // Pricing still resolves through the raw id fallback.
    assert.notEqual(event.estimated_cost_usd, null);
  });

  describe('OpenRouter exact generation costs (HOK-3077)', () => {
    const twoTurns = () => nativeSession({
      responseIds: ['gen-1', 'gen-2'],
      turns: ['gen-1', 'gen-2'].map((responseId) => ({
        responseId, inputTokens: 1000, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 100,
        usageAvailable: true, invalidUsage: false, providerReportedCostUsd: 0.5,
      })),
    });

    it('emits a fetched charge as the provider-reported cost, over transcript cost and local estimate', () => {
      const events = eventsFromNativeSessions([twoTurns()], ctx(DEEPSEEK, {
        exactGenerationCosts: new Map([['gen-1', 0.0123]]),
      }));
      for (const event of events) validateTaskCostEventV1(event);
      assert.equal(events[0].actual_cost_usd, 0.0123);
      assert.equal(events[0].estimated_cost_usd, null);
      assert.equal(events[0].cost_source, 'provider_reported');
      // Usage is still recorded from the transcript.
      assert.equal(events[0].usage.input_tokens, 1000);
      // A turn whose charge was not fetched keeps its own precedence.
      assert.equal(events[1].actual_cost_usd, 0.5);
    });

    it('accepts a fetched zero even when a local price exists', () => {
      const [event] = eventsFromNativeSessions([nativeSession()], ctx(DEEPSEEK, {
        exactGenerationCosts: new Map([['gen-1', 0]]),
      }));
      assert.equal(event.actual_cost_usd, 0);
      assert.equal(event.estimated_cost_usd, null);
    });

    it('ignores non-finite or negative charges', () => {
      for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
        const [event] = eventsFromNativeSessions([nativeSession()], ctx(DEEPSEEK, {
          exactGenerationCosts: new Map([['gen-1', bad]]),
        }));
        assert.equal(event.actual_cost_usd, null, String(bad));
        assert.notEqual(event.estimated_cost_usd, null, String(bad));
      }
    });
  });
});

describe('fixtures', () => {
  for (const name of listSdkTaskCostFixtures()) {
    it(`${name}: every emitted event satisfies the SDK event validator`, () => {
      const fixture = loadSdkTaskCostFixture(name);
      const eventCtx = ctx(fixture.pricingTable, { taskId: fixture.taskId, observedAtFallback: fixture.now });
      for (const scan of fixture.scanResults) {
        if (!scan) continue;
        for (const event of eventsFromScanResult(scan, eventCtx)) {
          validateTaskCostEventV1(event);
        }
      }
    });
  }
});
