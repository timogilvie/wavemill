import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Message,
} from '@earendil-works/pi-ai';
import {
  BUDGET_STOP_REASONS,
  budgetExhaustionFromLoop,
  budgetKindForStopReason,
  describeBudgetExhaustion,
  finalProviderErrorMessage,
  isBudgetStopReason,
  parseBudgetExhaustedFact,
  validateBudgetExhaustedFact,
} from './budget-exhaustion.ts';
import { runWavemillLoop, type LoopResult } from './loop.ts';

function loopResult(overrides: Partial<LoopResult>): LoopResult {
  return {
    messages: [],
    stopReason: 'stop',
    turnsCompleted: 0,
    toolCallsExecuted: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    wallClockMs: 0,
    promptCache: { turns: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, hitRate: null } as never,
    ...overrides,
  };
}

const abortedTurn = {
  role: 'assistant',
  content: [],
  stopReason: 'aborted',
  errorMessage: 'Request was aborted',
  timestamp: 0,
} as never;

describe('budget stop reasons', () => {
  // protects: a sixth "budget" reason (or a missing one) silently diverging between stages
  it('is exactly the five configured-budget reasons, each with one kind', () => {
    assert.deepEqual(
      [...BUDGET_STOP_REASONS].sort(),
      ['cost_limit', 'token_limit', 'tool_call_limit', 'turn_limit', 'wall_clock_limit'],
    );
    assert.equal(budgetKindForStopReason('wall_clock_limit'), 'wall_clock');
    assert.equal(budgetKindForStopReason('turn_limit'), 'turn');
    assert.equal(budgetKindForStopReason('tool_call_limit'), 'tool_call');
    assert.equal(budgetKindForStopReason('token_limit'), 'token');
    assert.equal(budgetKindForStopReason('cost_limit'), 'cost');
  });

  // protects: stagnation, aborts and errors being recorded as budget exhaustion
  it('excludes behavioural stops, aborts and errors', () => {
    for (const reason of ['stop', 'tool_stagnation', 'aborted', 'error', '', null, undefined]) {
      assert.equal(isBudgetStopReason(reason as string), false, String(reason));
      assert.equal(budgetKindForStopReason(reason as string), null);
    }
  });
});

describe('finalProviderErrorMessage', () => {
  // protects: our own wall-clock abort ("Request was aborted") classified as provider-unknown-error (HOK-3329 attempt 2)
  it('returns empty on a budget stop even when the final turn carries an abort message', () => {
    assert.equal(finalProviderErrorMessage({ messages: [abortedTurn], stopReason: 'wall_clock_limit' }), '');
    assert.equal(finalProviderErrorMessage({ messages: [abortedTurn], stopReason: 'turn_limit' }), '');
  });

  // protects: a genuine upstream failure being swallowed by the budget rule
  it('returns the message on an error stop', () => {
    const failed = { role: 'assistant', content: [], stopReason: 'error', errorMessage: '  502 Bad Gateway ', timestamp: 0 } as never;
    assert.equal(finalProviderErrorMessage({ messages: [failed], stopReason: 'error' }), '502 Bad Gateway');
  });
});

describe('budgetExhaustionFromLoop', () => {
  // protects: the HOK-3329 attempt-2 handoff losing turns/tool calls or the configured limit
  it('records wall_clock with limit, used and progress for the HOK-3329 attempt-2 shape', () => {
    const fact = budgetExhaustionFromLoop(
      loopResult({
        stopReason: 'wall_clock_limit',
        turnsCompleted: 145,
        toolCallsExecuted: 230,
        wallClockMs: 3_600_000,
        providerWaitMs: 1_200_000,
        providerErrorRetries: 0,
        messages: [abortedTurn],
      }),
      { maxTurns: 200, maxToolCalls: 1200, maxWallClockMs: 3_600_000 },
      { mutationFailures: 3 },
    );
    assert.deepEqual(fact, {
      kind: 'wall_clock',
      stopReason: 'wall_clock_limit',
      limit: 3_600_000,
      used: 3_600_000,
      progress: {
        turnsCompleted: 145,
        toolCallsExecuted: 230,
        wallClockMs: 3_600_000,
        mutationFailures: 3,
        providerWaitMs: 1_200_000,
        providerErrorRetries: 0,
        interruptedRequest: true,
      },
    });
    assert.equal(validateBudgetExhaustedFact(fact).ok, true);
  });

  // protects: limit/used naming the wrong budget for each kind
  it('fills limit/used from the budget that tripped', () => {
    const budget = { maxTurns: 200, maxToolCalls: 1200, maxWallClockMs: 60_000, maxOutputTokens: 500, maxCostUsd: 2 };
    const turn = budgetExhaustionFromLoop(loopResult({ stopReason: 'turn_limit', turnsCompleted: 200 }), budget);
    assert.deepEqual([turn?.kind, turn?.limit, turn?.used], ['turn', 200, 200]);
    const tools = budgetExhaustionFromLoop(loopResult({ stopReason: 'tool_call_limit', toolCallsExecuted: 1190 }), budget);
    assert.deepEqual([tools?.kind, tools?.limit, tools?.used], ['tool_call', 1200, 1190]);
    const tokens = budgetExhaustionFromLoop(
      loopResult({ stopReason: 'token_limit', totalInputTokens: 10, totalOutputTokens: 600 }),
      budget,
    );
    assert.deepEqual([tokens?.kind, tokens?.limit, tokens?.used], ['token', 500, 600]);
    const cost = budgetExhaustionFromLoop(loopResult({ stopReason: 'cost_limit', totalCostUsd: 2.5 }), budget);
    assert.deepEqual([cost?.kind, cost?.limit, cost?.used], ['cost', 2, 2.5]);
    const unbounded = budgetExhaustionFromLoop(loopResult({ stopReason: 'turn_limit', turnsCompleted: 5 }), undefined);
    assert.equal(unbounded?.limit, null);
  });

  // protects: a non-budget stop producing a budget fact
  it('is null for non-budget stops', () => {
    for (const stopReason of ['stop', 'error', 'aborted', 'tool_stagnation'] as const) {
      assert.equal(budgetExhaustionFromLoop(loopResult({ stopReason }), { maxTurns: 1 }), null);
    }
  });

  // protects: the notes/hook detail not naming the one kind
  it('describes the fact with the native-stage-timeout prefix', () => {
    const fact = budgetExhaustionFromLoop(
      loopResult({ stopReason: 'turn_limit', turnsCompleted: 200, toolCallsExecuted: 88 }),
      { maxTurns: 200 },
      { mutationFailures: 44 },
    )!;
    assert.equal(
      describeBudgetExhaustion('coding', fact),
      'native-stage-timeout: native coding exhausted its turn budget (200 of 200) after 200 turn(s), 88 tool call(s), 44 mutation failure(s)',
    );
  });
});

describe('validateBudgetExhaustedFact', () => {
  const valid = {
    kind: 'turn',
    stopReason: 'turn_limit',
    limit: 200,
    used: 200,
    progress: { turnsCompleted: 200, toolCallsExecuted: 88, wallClockMs: 1000 },
  };

  // protects: half-written facts reaching the fault rule
  it('rejects malformed facts with the offending field', () => {
    assert.equal(validateBudgetExhaustedFact(valid).ok, true);
    const cases: Array<[unknown, string]> = [
      [null, 'budgetExhausted'],
      [{ ...valid, kind: 'nope' }, 'budgetExhausted.kind'],
      [{ ...valid, kind: 'wall_clock' }, 'budgetExhausted.kind'],
      [{ ...valid, stopReason: 'error' }, 'budgetExhausted.stopReason'],
      [{ ...valid, limit: -1 }, 'budgetExhausted.limit'],
      [{ ...valid, used: 'x' }, 'budgetExhausted.used'],
      [{ ...valid, progress: { ...valid.progress, turnsCompleted: 1.5 } }, 'budgetExhausted.progress.turnsCompleted'],
      [{ ...valid, progress: { ...valid.progress, providerWaitMs: -5 } }, 'budgetExhausted.progress.providerWaitMs'],
    ];
    for (const [value, field] of cases) {
      const result = validateBudgetExhaustedFact(value);
      assert.equal(result.ok, false, JSON.stringify(value));
      if (!result.ok) assert.equal(result.field, field);
    }
  });

  // protects: CLI/abort-artifact parsing accepting garbage
  it('parses JSON strings and rejects invalid input', () => {
    assert.deepEqual(parseBudgetExhaustedFact(JSON.stringify(valid)), valid);
    assert.equal(parseBudgetExhaustedFact(''), null);
    assert.equal(parseBudgetExhaustedFact('{not json'), null);
    assert.equal(parseBudgetExhaustedFact({ kind: 'turn' }), null);
  });
});

describe('runWavemillLoop budget stop (HOK-3329 attempt-2 replay)', () => {
  for (const abortStopReason of ['aborted', 'error'] as const) {
  // protects: LoopResult.providerError carrying our own wall-clock abort as provider-unknown-error
  it(`stops on wall_clock_limit with no providerError when the budget aborts an in-flight request (transport stopReason=${abortStopReason})`, async () => {
    let calls = 0;
    const tool = {
      name: 'probe',
      label: 'probe',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      executionMode: 'sequential',
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }], details: {} };
      },
    } as unknown as AgentTool<any, any>;
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const streamFn = ((model: { api: string; id: string; provider: string }, _context: unknown, options?: { signal?: AbortSignal }) => {
      calls += 1;
      const stream = createAssistantMessageEventStream();
      const base = { role: 'assistant' as const, api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now() };
      if (calls === 1) {
        const message = {
          ...base,
          content: [{ type: 'toolCall', id: 'c1', name: 'probe', arguments: {} }],
          stopReason: 'toolUse',
        } as AssistantMessage;
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: 'toolUse', message } as AssistantMessageEvent);
        return stream;
      }
      // The second request is still in flight when the wall clock fires; the
      // provider transport reports the abort exactly as it did on HOK-3329.
      const aborted = { ...base, content: [], stopReason: abortStopReason, errorMessage: 'Request was aborted' } as AssistantMessage;
      stream.push({ type: 'start', partial: aborted });
      const finish = () => stream.push({ type: 'error', reason: abortStopReason, error: aborted } as AssistantMessageEvent);
      if (options?.signal?.aborted) finish();
      else options?.signal?.addEventListener('abort', finish, { once: true });
      return stream;
    }) as never;

    const result = await runWavemillLoop({
      model: { id: 'budget-model', api: 'budget-exhaustion-test', provider: 'test-provider' },
      context: { systemPrompt: 'test', messages: [{ role: 'user', content: 'Go.', timestamp: 0 }], tools: [tool] },
      convertToLlm: (messages) => messages as unknown as Message[],
      streamFn,
      budget: { maxWallClockMs: 150, maxTurns: 200 },
      providerErrorRetry: { maxAttempts: 0 },
    });

    assert.equal(result.stopReason, 'wall_clock_limit');
    assert.equal(result.providerError, undefined);
    assert.equal(finalProviderErrorMessage(result), '');
    assert.ok((result.providerWaitMs ?? 0) > 0, 'in-flight request counts as provider wait');
    assert.equal(result.providerErrorRetries, 0);
    const fact = budgetExhaustionFromLoop(result, { maxWallClockMs: 150, maxTurns: 200 });
    assert.equal(fact?.kind, 'wall_clock');
    assert.equal(fact?.limit, 150);
    assert.equal(fact?.progress.toolCallsExecuted, 1);
  });
  }
});
