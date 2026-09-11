import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentContext, AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Message, TextContent } from '@earendil-works/pi-ai';
import type { ModelRegistry } from '../model-registry.ts';
import { registerScriptedPiProvider, type ScriptedProviderContext } from './provider.ts';
import { runWavemillLoop, HEARTBEAT_AGENT, type HeartbeatEvent, type WavemillLoopConfig } from './loop.ts';
import {
  ContextExhaustedError,
  ContextWindowExceededError,
  ContextWindowUnverifiableError,
} from './context-window-guard.ts';
import { ToolCompatError } from './tool-compat-validator.ts';
import type { ToolMetadata } from './tools/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let apiSeq = 0;
function uniqueApi(prefix = 'loop-test') {
  return `${prefix}-${++apiSeq}`;
}

/** Minimal Pi-compatible user message for context. */
function userMsg(text: string) {
  return { role: 'user' as const, content: text, timestamp: 0 };
}

function textForTokens(tokens: number): string {
  return 'x'.repeat(tokens * 4);
}

/** Minimal AgentContext for tests. */
function makeContext(tools: AgentTool<any, any>[] = []): AgentContext {
  return {
    systemPrompt: 'You are a test agent.',
    messages: [userMsg('Go.')],
    tools,
  };
}

/**
 * Identity convertToLlm for tests where context uses Pi's native message types.
 * Pi's own messages (user/assistant/toolResult) are already LLM-compatible; no conversion needed.
 */
const piIdentity = (messages: any[]): Message[] => messages as Message[];

/** Base loop config using identity convertToLlm. */
function baseConfig(api: string, tools: AgentTool<any, any>[] = []): WavemillLoopConfig {
  return {
    model: { id: 'test-model', api, provider: 'test-provider' },
    context: makeContext(tools),
    convertToLlm: piIdentity,
  };
}

/** Create a simple AgentTool. The executor receives the abort signal. */
function makeTool(
  name: string,
  executionMode: 'parallel' | 'sequential',
  executor: (toolCallId: string, signal?: AbortSignal) => Promise<string | Error>,
): AgentTool<any, void> {
  return {
    name,
    description: `Test tool: ${name}`,
    parameters: { type: 'object', properties: {} } as any,
    label: name,
    executionMode,
    async execute(
      toolCallId: string,
      _params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<void>> {
      const result = await executor(toolCallId, signal);
      if (result instanceof Error) throw result;
      return { content: [{ type: 'text', text: result } satisfies TextContent], details: undefined as void };
    },
  } as unknown as AgentTool<any, void>;
}

function makeToolMetadata(
  name: string,
  toolClass: ToolMetadata['class'],
): ToolMetadata {
  return {
    name,
    description: `Test tool: ${name}`,
    class: toolClass,
    allowedPhases: ['planning', 'coding', 'review'],
    executionMode: 'sequential',
    outputCapPolicy: { strategy: 'none' },
  };
}

function makeCompatRegistry(
  modelId: string,
  readOnlyNative: 'certified' | 'partial' | 'unsupported',
  provider: 'openai' | 'openrouter',
  transport: 'openai-responses' | 'openai-completions',
  compatFlags?: Record<string, unknown>,
  contextWindowTokens = 128_000,
): ModelRegistry {
  return {
    models: {
      [modelId]: {
        vendor: 'test',
        class: 'strong_generalist',
        strengths: ['balanced'],
        weaknesses: ['none'],
        qualityScores: { routing: 0, planning: 0, coding: 0, review: 0, classify: 0 },
        defaultLadderEligible: true,
        contextWindowTokens,
        toolSupport: 'full',
        multimodal: { text: true, image: false },
        latencyTier: 'standard',
        reasoningTier: 'standard',
        costPerMillionInputTokensUsd: 0,
        costPerMillionOutputTokensUsd: 0,
        nativeCapability: {
          nativeProvider: provider,
          piTransportKind: transport,
          readOnlyNative,
          compatFlags,
          limitations: readOnlyNative === 'partial'
            ? ['missing thinkingFormat=openrouter compat flag']
            : undefined,
        },
      },
    },
    ladders: {},
  };
}

// ---------------------------------------------------------------------------
// Budget stop tests
// ---------------------------------------------------------------------------

describe('loop — budget stops', () => {
  it('returns error when the final assistant message is a provider error', async () => {
    const api = uniqueApi('provider-error');
    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [],
          usage: { input: 0, output: 0 },
          stopReason: 'error',
          errorMessage: 'HTTP 402 Payment Required: can only afford 100 tokens',
        },
      ],
    });

    const result = await runWavemillLoop(baseConfig(api));

    assert.equal(result.stopReason, 'error');
    assert.equal(result.providerError?.kind, 'provider-credit-exhausted');
  });

  it('retries a transient provider error and resumes with prior tool calls retained', async () => {
    const tool = makeTool('noop', 'sequential', async () => 'done');
    const api = uniqueApi('provider-retry');
    const contexts: ScriptedProviderContext[] = [];
    const sleeps: number[] = [];
    let turnIndex = 0;
    registerScriptedPiProvider({
      api,
      turns: (context) => {
        contexts.push(context);
        if (turnIndex < 8) {
          turnIndex += 1;
          return {
            content: [{ type: 'tool_call', id: `tc-${turnIndex}`, name: 'noop', arguments: {} }],
            usage: { input: 10, output: 1 },
            stopReason: 'tool_calls',
          };
        }
        if (turnIndex === 8) {
          turnIndex += 1;
          return {
            content: [{ type: 'text', text: 'Now I will add the tests.' }],
            usage: { input: 0, output: 0, totalTokens: 0 },
            stopReason: 'error',
            errorMessage: 'Provider finish_reason: error',
          };
        }
        return {
          content: [{ type: 'text', text: 'Recovered and completed.' }],
          usage: { input: 10, output: 1 },
          stopReason: 'stop',
        };
      },
    });
    const heartbeats: HeartbeatEvent[] = [];

    const result = await runWavemillLoop({
      ...baseConfig(api, [tool]),
      providerErrorRetry: {
        maxAttempts: 3,
        backoffDelaysMs: [5],
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      onHeartbeat: (event) => heartbeats.push(event),
    });

    assert.equal(result.stopReason, 'stop');
    assert.equal(result.toolCallsExecuted, 8);
    assert.equal(result.providerError, undefined);
    assert.equal(sleeps.length, 1);
    assert.equal(heartbeats.some((event) => event.event === 'provider_retry' && event.detail === 'provider-transient-error'), true);
    const retriedContext = contexts.at(-1);
    assert.ok(retriedContext);
    assert.equal(JSON.stringify(retriedContext.messages).includes('Provider finish_reason: error'), false);
    assert.equal(JSON.stringify(retriedContext.messages).includes('tc-8'), true);
  });

  it('reports providerError after retryable provider errors exhaust attempts', async () => {
    const api = uniqueApi('provider-retry-exhausted');
    registerScriptedPiProvider({
      api,
      turns: [{
        content: [{ type: 'text', text: 'temporary upstream failure' }],
        usage: { input: 0, output: 0, totalTokens: 0 },
        stopReason: 'error',
        errorMessage: 'Provider finish_reason: error',
      }],
    });
    const sleeps: number[] = [];

    const result = await runWavemillLoop({
      ...baseConfig(api),
      providerErrorRetry: {
        maxAttempts: 1,
        backoffDelaysMs: [1],
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    });

    assert.equal(result.stopReason, 'error');
    assert.equal(result.providerError?.kind, 'provider-transient-error');
    assert.equal(result.providerError?.attempts, 1);
    assert.equal(sleeps.length, 1);
  });

  it('stops after maxTurns is reached', async () => {
    // Two scripted turns; maxTurns: 1 should stop after the first.
    // First turn emits a tool call so the loop would otherwise continue.
    const tool = makeTool('noop', 'parallel', async () => 'done');
    const api = uniqueApi('budget-turns');
    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [{ type: 'tool_call', id: 'tc1', name: 'noop', arguments: {} }],
          usage: { input: 10, output: 5 },
          stopReason: 'tool_calls',
        },
        { content: [{ type: 'text', text: 'Second turn' }], stopReason: 'stop' },
      ],
    });

    const result = await runWavemillLoop({
      ...baseConfig(api, [tool]),
      budget: { maxTurns: 1 },
    });

    assert.equal(result.stopReason, 'turn_limit');
    assert.equal(result.turnsCompleted, 1);
  });

  it('does not report turn_limit when the final allowed turn stops normally', async () => {
    const tool = makeTool('noop', 'parallel', async () => 'done');
    const api = uniqueApi('budget-final-stop');
    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [{ type: 'tool_call', id: 'tc1', name: 'noop', arguments: {} }],
          usage: { input: 10, output: 5 },
          stopReason: 'tool_calls',
        },
        { content: [{ type: 'text', text: 'Final review JSON' }], stopReason: 'stop' },
      ],
    });

    const result = await runWavemillLoop({
      ...baseConfig(api, [tool]),
      budget: { maxTurns: 2 },
    });

    assert.equal(result.stopReason, 'stop');
    assert.equal(result.turnsCompleted, 2);
  });

  it('reserves a tool-free terminal synthesis turn at the turn boundary', async () => {
    const tool = makeTool('inspect', 'parallel', async () => 'evidence');
    const api = uniqueApi('budget-terminal-synthesis-turn');
    const seenContexts: ScriptedProviderContext[] = [];
    let turn = 0;
    registerScriptedPiProvider({
      api,
      turns: (providerContext) => {
        seenContexts.push(providerContext);
        turn += 1;
        if (turn < 3) {
          return {
            content: [{ type: 'tool_call', id: `tc${turn}`, name: 'inspect', arguments: {} }],
            stopReason: 'tool_calls',
          };
        }
        return { content: [{ type: 'text', text: '{"verdict":"ready"}' }], stopReason: 'stop' };
      },
    });

    const result = await runWavemillLoop({
      ...baseConfig(api, [tool]),
      budget: { maxTurns: 3, maxToolCalls: 10 },
      terminalSynthesis: { prompt: 'Return terminal JSON now.' },
    });

    assert.equal(result.stopReason, 'stop');
    assert.equal(result.turnsCompleted, 3);
    assert.equal(result.toolCallsExecuted, 2);
    assert.equal((seenContexts[2].rawContext as { tools?: unknown[] }).tools?.length ?? 0, 0);
    assert.equal(JSON.stringify(seenContexts[2].messages).includes('Return terminal JSON now.'), true);
  });

  it('can synthesize successfully after reaching the tool-call boundary', async () => {
    const tool = makeTool('inspect', 'parallel', async () => 'evidence');
    const api = uniqueApi('budget-terminal-synthesis-tools');
    let turn = 0;
    registerScriptedPiProvider({
      api,
      turns: () => {
        turn += 1;
        return turn === 1
          ? {
              content: [{ type: 'tool_call', id: 'tc1', name: 'inspect', arguments: {} }],
              stopReason: 'tool_calls',
            }
          : { content: [{ type: 'text', text: '{"verdict":"ready"}' }], stopReason: 'stop' };
      },
    });

    const result = await runWavemillLoop({
      ...baseConfig(api, [tool]),
      budget: { maxTurns: 10, maxToolCalls: 1 },
      terminalSynthesis: { prompt: 'Return terminal JSON now.' },
    });

    assert.equal(result.stopReason, 'stop');
    assert.equal(result.turnsCompleted, 2);
    assert.equal(result.toolCallsExecuted, 1);
  });

  it('stops when maxInputTokens is exceeded', async () => {
    // First (and only) turn uses 600 input tokens; budget is 500.
    // shouldStopAfterTurn fires after the turn and detects the excess.
    const api = uniqueApi('budget-input-tokens');
    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [{ type: 'text', text: 'Done' }],
          usage: { input: 600, output: 10 },
          stopReason: 'stop',
        },
      ],
    });

    const result = await runWavemillLoop({
      ...baseConfig(api),
      budget: { maxInputTokens: 500 },
    });

    assert.equal(result.stopReason, 'token_limit');
    assert.equal(result.turnsCompleted, 1);
    assert.equal(result.totalInputTokens, 600);
  });

  it('stops when maxOutputTokens is exceeded', async () => {
    const api = uniqueApi('budget-output-tokens');
    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [{ type: 'text', text: 'Big output' }],
          usage: { input: 10, output: 500 },
          stopReason: 'stop',
        },
      ],
    });

    const result = await runWavemillLoop({
      ...baseConfig(api),
      budget: { maxOutputTokens: 250 },
    });

    assert.equal(result.stopReason, 'token_limit');
    assert.equal(result.turnsCompleted, 1);
    assert.equal(result.totalOutputTokens, 500);
  });

  it('stops when maxTotalTokens is exceeded', async () => {
    const api = uniqueApi('budget-total-tokens');
    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [{ type: 'text', text: 'T1' }],
          usage: { input: 400, output: 400 },
          stopReason: 'stop',
        },
      ],
    });

    // Total = 800; budget = 700
    const result = await runWavemillLoop({
      ...baseConfig(api),
      budget: { maxTotalTokens: 700 },
    });

    assert.equal(result.stopReason, 'token_limit');
    assert.equal(result.totalInputTokens + result.totalOutputTokens, 800);
  });

  it('stops when maxToolCalls is reached after one tool execution', async () => {
    const executionLog: string[] = [];
    const tool = makeTool('read_notes', 'parallel', async (id) => {
      executionLog.push(id);
      return 'contents';
    });

    const api = uniqueApi('budget-tool-calls');
    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [{ type: 'tool_call', id: 'tc1', name: 'read_notes', arguments: {} }],
          stopReason: 'tool_calls',
        },
        {
          content: [{ type: 'tool_call', id: 'tc2', name: 'read_notes', arguments: {} }],
          stopReason: 'tool_calls',
        },
        { content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' },
      ],
    });

    const result = await runWavemillLoop({
      model: { id: 'test-model', api, provider: 'test-provider' },
      context: makeContext([tool]),
      convertToLlm: piIdentity,
      budget: { maxToolCalls: 1 },
    });

    assert.equal(result.stopReason, 'tool_call_limit');
    assert.equal(result.toolCallsExecuted, 1);
    assert.equal(executionLog.length, 1);
  });

  it('stops when maxCostUsd is exceeded', async () => {
    // Pricing: $1 per 1M input tokens.
    // Turn 1 uses 600 input tokens → 600/1e6 * 1 = $0.0006; budget is $0.0005.
    const api = uniqueApi('budget-cost');
    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [{ type: 'text', text: 'Expensive' }],
          usage: { input: 600, output: 0 },
          stopReason: 'stop',
        },
      ],
    });

    const result = await runWavemillLoop({
      ...baseConfig(api),
      modelPricing: { inputCostPerMTok: 1.0, outputCostPerMTok: 0 },
      budget: { maxCostUsd: 0.0005 },
    });

    assert.equal(result.stopReason, 'cost_limit');
    assert.equal(result.turnsCompleted, 1);
  });

  it('wall-clock budget fires abort signal', async () => {
    const api = uniqueApi('budget-wall-clock');
    const tool = makeTool('slow_tool', 'sequential', async (_id, signal) => {
      // Honor the abort signal; exit quickly when fired (check already-aborted too).
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) { reject(new Error('aborted')); return; }
        const timer = setTimeout(resolve, 10_000);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
      });
      return 'never';
    });

    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [{ type: 'tool_call', id: 'sl1', name: 'slow_tool', arguments: {} }],
          stopReason: 'tool_calls',
        },
      ],
    });

    const result = await runWavemillLoop({
      model: { id: 'test-model', api, provider: 'test-provider' },
      context: makeContext([tool]),
      convertToLlm: piIdentity,
      budget: { maxWallClockMs: 100 },
    });

    assert.equal(result.stopReason, 'wall_clock_limit');
    assert.ok(result.wallClockMs >= 100);
  });

  it('stops repeated normalized tool signatures with identical output as tool_stagnation', async () => {
    let executions = 0;
    const tool = makeTool('search_text', 'parallel', async () => {
      executions += 1;
      return 'same search result';
    });
    const api = uniqueApi('stagnant-search');
    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [{ type: 'tool_call', id: 's1', name: 'search_text', arguments: { q: 'TODO', path: 'src' } }],
          stopReason: 'tool_calls',
        },
        {
          content: [{ type: 'tool_call', id: 's2', name: 'search_text', arguments: { path: 'src', q: 'TODO' } }],
          stopReason: 'tool_calls',
        },
        {
          content: [{ type: 'tool_call', id: 's3', name: 'search_text', arguments: { q: 'TODO', path: 'src' } }],
          stopReason: 'tool_calls',
        },
        {
          content: [{ type: 'text', text: 'should not reach final text' }],
          stopReason: 'stop',
        },
      ],
    });

    const result = await runWavemillLoop({
      ...baseConfig(api, [tool]),
      budget: {
        stagnation: {
          maxRepeatedSignatureCalls: 3,
          maxNoNovelProgressCalls: 2,
        },
      },
    });

    assert.equal(result.stopReason, 'tool_stagnation');
    assert.equal(result.toolCallsExecuted, 3);
    assert.equal(executions, 3);
  });

  it('does not treat repeated calls with novel output as stagnation', async () => {
    let executions = 0;
    const tool = makeTool('search_text', 'parallel', async () => {
      executions += 1;
      return `search result page ${executions}`;
    });
    const api = uniqueApi('progressing-search');
    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [{ type: 'tool_call', id: 'p1', name: 'search_text', arguments: { q: 'TODO' } }],
          stopReason: 'tool_calls',
        },
        {
          content: [{ type: 'tool_call', id: 'p2', name: 'search_text', arguments: { q: 'TODO' } }],
          stopReason: 'tool_calls',
        },
        {
          content: [{ type: 'tool_call', id: 'p3', name: 'search_text', arguments: { q: 'TODO' } }],
          stopReason: 'tool_calls',
        },
        {
          content: [{ type: 'text', text: 'Done' }],
          stopReason: 'stop',
        },
      ],
    });

    const result = await runWavemillLoop({
      ...baseConfig(api, [tool]),
      budget: {
        stagnation: {
          maxRepeatedSignatureCalls: 3,
          maxNoNovelProgressCalls: 2,
        },
      },
    });

    assert.equal(result.stopReason, 'stop');
    assert.equal(result.toolCallsExecuted, 3);
    assert.equal(executions, 3);
  });
});

describe('loop — context-window pre-flight', () => {
  it('rejects before reaching the provider when reserved output exceeds the usable window', async () => {
    const api = uniqueApi('context-window-small');
    const seen: ScriptedProviderContext[] = [];
    registerScriptedPiProvider({
      api,
      turns: (context) => {
        seen.push(context);
        return { content: [{ type: 'text', text: 'unreachable' }], stopReason: 'stop' };
      },
    });

    await assert.rejects(
      () => runWavemillLoop({
        ...baseConfig(api),
        model: { id: 'tiny', api, provider: 'test-provider', contextWindow: 1_000 },
      }),
      ContextWindowExceededError,
    );
    assert.equal(seen.length, 0);
  });

  it('uses compatRegistry limits instead of model placeholder limits', async () => {
    const api = uniqueApi('context-window-registry');
    const seen: ScriptedProviderContext[] = [];
    registerScriptedPiProvider({
      api,
      turns: (context) => {
        seen.push(context);
        return { content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' };
      },
    });
    const context: AgentContext = {
      systemPrompt: 'You are a test agent.',
      messages: [userMsg('x'.repeat(10_000))],
      tools: [],
    };
    const model = {
      id: 'openrouter:openai/gpt-4o-mini',
      name: 'openai/gpt-4o-mini',
      api,
      provider: 'openrouter',
      contextWindow: 200_000,
    };

    await assert.rejects(
      () => runWavemillLoop({
        model,
        context,
        convertToLlm: piIdentity,
        compatRegistry: makeCompatRegistry(
          'openai/gpt-4o-mini',
          'certified',
          'openrouter',
          'openai-completions',
          { thinkingFormat: 'openrouter' },
          2_000,
        ),
      }),
      ContextWindowExceededError,
    );
    assert.equal(seen.length, 0);

    const result = await runWavemillLoop({
      model,
      context,
      convertToLlm: piIdentity,
      compatRegistry: makeCompatRegistry(
        'openai/gpt-4o-mini',
        'certified',
        'openrouter',
        'openai-completions',
        { thinkingFormat: 'openrouter' },
        200_000,
      ),
    });
    assert.equal(result.stopReason, 'stop');
    assert.equal(seen.length, 1);
  });

  it('fails closed for native providers without a resolvable context-window limit', async () => {
    const api = uniqueApi('context-window-unverifiable');
    const seen: ScriptedProviderContext[] = [];
    registerScriptedPiProvider({
      api,
      turns: (context) => {
        seen.push(context);
        return { content: [{ type: 'text', text: 'unreachable' }], stopReason: 'stop' };
      },
    });

    await assert.rejects(
      () => runWavemillLoop({
        ...baseConfig(api),
        model: { id: 'openrouter:unknown-model', api, provider: 'openrouter' },
        compatRegistry: { models: {}, ladders: {} },
      }),
      ContextWindowUnverifiableError,
    );
    assert.equal(seen.length, 0);
  });

  it('still validates tool transport compatibility before context-window verification', async () => {
    const api = uniqueApi('context-window-transport-order');
    const tool = makeTool('noop', 'parallel', async () => 'done');

    await assert.rejects(
      () => runWavemillLoop({
        model: { id: 'openai:gpt-future', api: 'unknown-transport', provider: 'openai' },
        context: makeContext([tool]),
        convertToLlm: piIdentity,
        toolPolicy: {
          phase: 'coding',
          worktreePath: process.cwd(),
          registry: [makeToolMetadata('noop', 'read')],
        },
        compatRegistry: { models: {}, ladders: {} },
      }),
      /Unknown provider transport/,
    );
    assert.equal(api.length > 0, true);
  });

  it('proceeds normally when the prompt fits the model context window', async () => {
    const api = uniqueApi('context-window-fits');
    registerScriptedPiProvider({
      api,
      turns: [{ content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' }],
    });

    const result = await runWavemillLoop({
      ...baseConfig(api),
      model: { id: 'fits', api, provider: 'test-provider', contextWindow: 50_000 },
    });

    assert.equal(result.stopReason, 'stop');
  });
});

describe('loop — tool compat gate', () => {
  it('passes the full tool set through unchanged for supported models', async () => {
    const recordedToolNames: string[][] = [];

    registerScriptedPiProvider({
      api: 'openai-completions',
      turns: (context: ScriptedProviderContext) => {
        const rawContext = context.rawContext as { tools?: Array<{ name: string }> };
        recordedToolNames.push((rawContext.tools ?? []).map((tool) => tool.name));
        return {
          content: [{ type: 'text', text: 'Done' }],
          stopReason: 'stop',
        };
      },
    });

    const tools = [
      makeTool('read_file', 'parallel', async () => 'unused'),
      makeTool('list_files', 'parallel', async () => 'unused'),
      makeTool('search_text', 'parallel', async () => 'unused'),
    ];

    const result = await runWavemillLoop({
      model: {
        id: 'openrouter:openai/gpt-4o-mini',
        name: 'openai/gpt-4o-mini',
        api: 'openai-completions',
        provider: 'openrouter',
        compat: { thinkingFormat: 'openrouter' },
      },
      context: makeContext(tools),
      convertToLlm: piIdentity,
      compatRegistry: makeCompatRegistry(
        'openai/gpt-4o-mini',
        'certified',
        'openrouter',
        'openai-completions',
        { thinkingFormat: 'openrouter' },
      ),
      toolPolicy: {
        phase: 'coding',
        worktreePath: '/tmp/wavemill-loop-test',
        registry: [
          makeToolMetadata('read_file', 'read-only'),
          makeToolMetadata('list_files', 'read-only'),
          makeToolMetadata('search_text', 'read-only'),
        ],
      },
    });

    assert.equal(result.stopReason, 'stop');
    assert.deepEqual(recordedToolNames, [['read_file', 'list_files', 'search_text']]);
  });

  it('throws when a native provider is paired with an unknown transport', async () => {
    let invocationCount = 0;

    registerScriptedPiProvider({
      api: 'experimental-transport',
      turns: () => {
        invocationCount++;
        return {
          content: [{ type: 'text', text: 'unexpected' }],
          stopReason: 'stop',
        };
      },
    });

    await assert.rejects(
      () => runWavemillLoop({
        model: {
          id: 'openai:gpt-future',
          name: 'gpt-future',
          api: 'experimental-transport',
          provider: 'openai',
        },
        context: makeContext([
          makeTool('read_file', 'parallel', async () => 'unused'),
        ]),
        convertToLlm: piIdentity,
        toolPolicy: {
          phase: 'coding',
          worktreePath: '/tmp/wavemill-loop-test',
          registry: [makeToolMetadata('read_file', 'read-only')],
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(invocationCount, 0);
        assert.match(error.message, /Unknown provider transport "experimental-transport"/);
        return true;
      },
    );
  });

  it('fails before any provider call for unsupported tool compatibility', async () => {
    let invocationCount = 0;

    registerScriptedPiProvider({
      api: 'openai-completions',
      turns: () => {
        invocationCount++;
        return {
          content: [{ type: 'text', text: 'unexpected' }],
          stopReason: 'stop',
        };
      },
    });

    await assert.rejects(
      () => runWavemillLoop({
        model: {
          id: 'openrouter:openai/gpt-4o-mini',
          name: 'openai/gpt-4o-mini',
          api: 'openai-completions',
          provider: 'openrouter',
        },
        context: makeContext([
          makeTool('read_file', 'parallel', async () => 'unused'),
          makeTool('list_files', 'parallel', async () => 'unused'),
          makeTool('search_text', 'parallel', async () => 'unused'),
        ]),
        convertToLlm: piIdentity,
        compatRegistry: makeCompatRegistry(
          'openai/gpt-4o-mini',
          'partial',
          'openrouter',
          'openai-completions',
        ),
        toolPolicy: {
          phase: 'coding',
          worktreePath: '/tmp/wavemill-loop-test',
          registry: [
            makeToolMetadata('read_file', 'read-only'),
            makeToolMetadata('list_files', 'read-only'),
            makeToolMetadata('search_text', 'read-only'),
          ],
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ToolCompatError);
        assert.equal(invocationCount, 0);
        assert.match(error.message, /model=openai\/gpt-4o-mini/);
        assert.match(error.message, /provider=openrouter/);
        assert.match(error.message, /transport=openai-completions/);
        assert.match(error.message, /tool=read_file/);
        assert.match(error.message, /capability=read_only_native/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Blocked / abort stops
// ---------------------------------------------------------------------------

describe('loop — blocked stops', () => {
  it('blocks mutation tools in planning before execution', async () => {
    let executed = false;
    const tool = makeTool('patch_file', 'sequential', async () => {
      executed = true;
      return 'patched';
    });

    const api = uniqueApi('phase-denied');
    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [{ type: 'tool_call', id: 'pd1', name: 'patch_file', arguments: { path: 'notes.md' } }],
          stopReason: 'tool_calls',
        },
        { content: [{ type: 'text', text: 'Denied' }], stopReason: 'stop' },
      ],
    });

    const result = await runWavemillLoop({
      model: { id: 'test-model', api, provider: 'test-provider' },
      context: makeContext([tool]),
      convertToLlm: piIdentity,
      toolPolicy: {
        phase: 'planning',
        worktreePath: '/repo',
        registry: [makeToolMetadata('patch_file', 'mutation')],
      },
    });

    assert.equal(executed, false);
    assert.equal(result.toolCallsExecuted, 0);
    const toolResult = result.messages.find(
      (message: any) => message.role === 'toolResult' && message.toolName === 'patch_file',
    ) as any;
    assert.ok(toolResult);
    assert.equal(
      toolResult.content?.[0]?.text,
      'phase_denied: tool "patch_file" is not allowed in planning',
    );
  });

  it('blocks worktree-escaping paths before execution', async () => {
    let executed = false;
    const tool = makeTool('read_file', 'sequential', async () => {
      executed = true;
      return 'contents';
    });

    const api = uniqueApi('path-denied');
    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [{ type: 'tool_call', id: 'wd1', name: 'read_file', arguments: { path: '../secret.txt' } }],
          stopReason: 'tool_calls',
        },
        { content: [{ type: 'text', text: 'Denied' }], stopReason: 'stop' },
      ],
    });

    const result = await runWavemillLoop({
      model: { id: 'test-model', api, provider: 'test-provider' },
      context: makeContext([tool]),
      convertToLlm: piIdentity,
      toolPolicy: {
        phase: 'coding',
        worktreePath: '/repo',
        registry: [makeToolMetadata('read_file', 'read-only')],
        config: { pathFieldsByTool: { read_file: ['path'] } },
      },
    });

    assert.equal(executed, false);
    assert.equal(result.toolCallsExecuted, 0);
    const toolResult = result.messages.find(
      (message: any) => message.role === 'toolResult' && message.toolName === 'read_file',
    ) as any;
    assert.ok(toolResult);
    assert.equal(
      toolResult.content?.[0]?.text,
      "path_denied: '../secret.txt' resolves outside the worktree",
    );
  });

  it('returns aborted immediately when signal is already aborted', async () => {
    const api = uniqueApi('blocked-pre-abort');
    registerScriptedPiProvider({
      api,
      turns: [{ content: [{ type: 'text', text: 'Should not run' }], stopReason: 'stop' }],
    });

    const controller = new AbortController();
    controller.abort();

    const result = await runWavemillLoop({
      ...baseConfig(api),
      signal: controller.signal,
    });

    assert.equal(result.stopReason, 'aborted');
    assert.equal(result.turnsCompleted, 0);
    assert.equal(result.wallClockMs, 0);
  });

  it('returns aborted when signal fires during tool execution in turn 1', async () => {
    const controller = new AbortController();

    const api = uniqueApi('blocked-between-turns');
    // The tool fires the caller abort signal during execution. Pi then detects the
    // aborted signal before starting turn 2 and exits the loop.
    const tool = makeTool('quick_read', 'parallel', async () => {
      controller.abort();
      return 'data';
    });

    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [{ type: 'tool_call', id: 'qr1', name: 'quick_read', arguments: {} }],
          stopReason: 'tool_calls',
        },
        { content: [{ type: 'text', text: 'Turn 2 — should not run' }], stopReason: 'stop' },
      ],
    });

    const result = await runWavemillLoop({
      model: { id: 'test-model', api, provider: 'test-provider' },
      context: makeContext([tool]),
      convertToLlm: piIdentity,
      signal: controller.signal,
    });

    assert.equal(result.stopReason, 'aborted');
  });
});

// ---------------------------------------------------------------------------
// Continuation: turn N+1 replays prior-turn signatures
// ---------------------------------------------------------------------------

describe('loop — continuation', () => {
  it('continues after a reasoning-only stop and preserves thinking in the next request', async () => {
    const api = uniqueApi('reasoning-only-continue');
    const seen: ScriptedProviderContext[] = [];

    registerScriptedPiProvider({
      api,
      turns: (ctx: ScriptedProviderContext) => {
        seen.push(ctx);
        if (seen.length === 1) {
          return {
            content: [{
              type: 'thinking',
              thinking: '**Implementing Blind Challenge Judge**...',
              thinkingSignature: 'hok-2793-sig',
            }],
            usage: { input: 10871, output: 423 },
            stopReason: 'stop',
          };
        }
        return { content: [{ type: 'text', text: 'I will continue with the implementation.' }], stopReason: 'stop' };
      },
    });

    const events: Array<{ type: string; messages?: unknown[] }> = [];
    const result = await runWavemillLoop({
      ...baseConfig(api),
      onEvent: (event) => events.push(event as { type: string; messages?: unknown[] }),
    });

    assert.equal(result.stopReason, 'stop');
    assert.equal(result.turnsCompleted, 2);
    assert.equal(seen.length, 2);
    const secondMessages = seen[1].messages as any[];
    const assistant = secondMessages.find((message) => message.role === 'assistant');
    assert.ok(assistant, 'reasoning-only assistant turn is replayed');
    const thinking = assistant.content?.find((block: any) => block.type === 'thinking');
    assert.ok(thinking, 'thinking block is preserved in continuation context');
    assert.equal(thinking.thinkingSignature, 'hok-2793-sig');
    const continuationPrompt = secondMessages.at(-1);
    assert.equal(continuationPrompt.role, 'user');
    assert.match(String(continuationPrompt.content), /internal reasoning only/);

    const agentEndEvents = events.filter((event) => event.type === 'agent_end');
    assert.equal(agentEndEvents.length, 1);
    assert.notEqual(agentEndEvents[0].messages?.length, 1);
  });

  it('bounds repeated reasoning-only stops with an empty-model-turn diagnostic', async () => {
    const api = uniqueApi('reasoning-only-exhausted');

    registerScriptedPiProvider({
      api,
      turns: () => ({
        content: [{ type: 'thinking', thinking: 'still planning' }],
        stopReason: 'stop',
      }),
    });

    const result = await runWavemillLoop(baseConfig(api));
    const finalAssistant = result.messages.at(-1) as any;

    assert.equal(result.stopReason, 'error');
    assert.equal(result.turnsCompleted, 2);
    assert.match(finalAssistant.errorMessage, /empty-model-turn/);
  });

  it('preserves thinkingSignature and responseId across turns', async () => {
    const api = uniqueApi('continuation');
    let capturedMessages: unknown[] | undefined;

    registerScriptedPiProvider({
      api,
      turns: (ctx: ScriptedProviderContext) => {
        capturedMessages = ctx.messages as unknown[];
        return { content: [{ type: 'text', text: 'OK' }], stopReason: 'stop' };
      },
    });

    // Context includes a prior-turn assistant message carrying continuation metadata.
    const priorAssistant = {
      role: 'assistant' as const,
      content: [
        { type: 'thinking' as const, thinking: 'reasoning...', thinkingSignature: 'sig-abc' },
        { type: 'text' as const, text: 'Prior answer.' },
      ],
      api,
      provider: 'test-provider',
      model: 'test-model',
      responseId: 'resp-xyz',
      usage: {
        input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop' as const,
      timestamp: 0,
    };

    await runWavemillLoop({
      model: { id: 'test-model', api, provider: 'test-provider' },
      context: {
        systemPrompt: 'Test agent.',
        messages: [userMsg('Original question.'), priorAssistant, userMsg('Follow-up.')],
        tools: [],
      },
      // Identity convertToLlm: Pi messages pass through to the scripted provider.
      convertToLlm: piIdentity,
    });

    assert.ok(capturedMessages, 'convertToLlm/ScriptedProvider must have seen messages');

    const assistantInLlm = capturedMessages!.find((m: any) => m.role === 'assistant') as any;
    assert.ok(assistantInLlm, 'prior assistant message must appear in LLM input');

    const thinkingBlock = assistantInLlm.content?.find((c: any) => c.type === 'thinking');
    assert.ok(thinkingBlock, 'thinking block must be in assistant content');
    assert.equal(thinkingBlock.thinkingSignature, 'sig-abc');
    assert.equal(assistantInLlm.responseId, 'resp-xyz');
  });
});

// ---------------------------------------------------------------------------
// Replay compaction
// ---------------------------------------------------------------------------

describe('loop — replay compaction', () => {
  it('sends compacted tool results to the provider while final messages retain raw content', async () => {
    const rawToolOutput = 'raw-file-content-'.repeat(20);
    const tool = makeTool('read_file', 'parallel', async () => rawToolOutput);
    const api = uniqueApi('compaction');
    let secondTurnMessages: unknown[] | undefined;

    registerScriptedPiProvider({
      api,
      turns: (ctx: ScriptedProviderContext) => {
        if (ctx.sawToolResults) {
          secondTurnMessages = ctx.messages as unknown[];
          return { content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' };
        }
        return {
          content: [{ type: 'tool_call', id: 'read-1', name: 'read_file', arguments: {} }],
          stopReason: 'tool_calls',
        };
      },
    });

    const compactionEvents: unknown[] = [];
    const result = await runWavemillLoop({
      model: { id: 'test-model', api, provider: 'test-provider' },
      context: makeContext([tool]),
      convertToLlm: piIdentity,
      compaction: { maxOutputBytes: 24 },
      onCompactionEvents: (events) => compactionEvents.push(...events),
    });

    assert.ok(secondTurnMessages, 'second provider turn must have received replay messages');
    const replayToolResult = secondTurnMessages!.find((m: any) => m.role === 'tool_result') as any;
    assert.ok(replayToolResult, 'tool result must be in provider replay context');
    const replayText = replayToolResult.content[0].content[0].text;
    assert.notEqual(replayText, rawToolOutput);
    assert.ok(replayText.includes('[Replay compaction:'));

    const canonicalToolResult = result.messages.find((m: any) => m.role === 'toolResult') as any;
    assert.ok(canonicalToolResult, 'canonical final messages must retain tool result');
    assert.equal(canonicalToolResult.content[0].text, rawToolOutput);

    assert.equal(compactionEvents.length, 1);
    assert.equal((compactionEvents[0] as any).toolName, 'read_file');
  });

  it('leaves provider replay context unchanged when compaction is omitted', async () => {
    const rawToolOutput = 'small raw output';
    const tool = makeTool('read_file', 'parallel', async () => rawToolOutput);
    const api = uniqueApi('no-compaction');
    let secondTurnMessages: unknown[] | undefined;

    registerScriptedPiProvider({
      api,
      turns: (ctx: ScriptedProviderContext) => {
        if (ctx.sawToolResults) {
          secondTurnMessages = ctx.messages as unknown[];
          return { content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' };
        }
        return {
          content: [{ type: 'tool_call', id: 'read-2', name: 'read_file', arguments: {} }],
          stopReason: 'tool_calls',
        };
      },
    });

    await runWavemillLoop({
      model: { id: 'test-model', api, provider: 'test-provider' },
      context: makeContext([tool]),
      convertToLlm: piIdentity,
    });

    const replayToolResult = secondTurnMessages!.find((m: any) => m.role === 'tool_result') as any;
    assert.equal(replayToolResult.content[0].content[0].text, rawToolOutput);
  });
});

describe('loop — in-session context management', () => {
  it('shrinks maxTokens for the initial request as input approaches the window', async () => {
    const api = uniqueApi('dynamic-output');
    const seen: ScriptedProviderContext[] = [];
    registerScriptedPiProvider({
      api,
      turns: (ctx) => {
        seen.push(ctx);
        return { content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' };
      },
    });

    const result = await runWavemillLoop({
      ...baseConfig(api),
      model: { id: 'windowed', api, provider: 'test-provider', contextWindow: 100_000 },
      context: {
        systemPrompt: '',
        messages: [userMsg(textForTokens(85_000))],
        tools: [],
      },
      maxTokens: 32_768,
      contextManagement: {
        safetyMarginPct: 5,
        minOutputTokens: 1_024,
      },
    });

    assert.equal(result.stopReason, 'stop');
    assert.equal(seen[0]?.options?.maxTokens, 9_996);
  });

  it('compacts accumulated tool results before the provider request and continues', async () => {
    const rawToolOutput = 'raw-context-growth-'.repeat(500);
    const tool = makeTool('read_file', 'parallel', async () => rawToolOutput);
    const api = uniqueApi('context-compact-continues');
    let secondTurnMessages: unknown[] | undefined;

    registerScriptedPiProvider({
      api,
      turns: (ctx: ScriptedProviderContext) => {
        if (ctx.sawToolResults) {
          secondTurnMessages = ctx.messages as unknown[];
          return { content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' };
        }
        return {
          content: [{ type: 'tool_call', id: 'read-big', name: 'read_file', arguments: {} }],
          stopReason: 'tool_calls',
        };
      },
    });

    const result = await runWavemillLoop({
      model: { id: 'windowed', api, provider: 'test-provider', contextWindow: 3_000 },
      context: makeContext([tool]),
      convertToLlm: piIdentity,
      maxTokens: 256,
      contextManagement: {
        compactionThreshold: 0.8,
        safetyMarginPct: 0,
        minRetainedToolResults: 0,
        minOutputTokens: 64,
      },
    });

    assert.equal(result.stopReason, 'stop');
    assert.ok(secondTurnMessages, 'second provider turn must receive compacted replay messages');
    const replayToolResult = secondTurnMessages!.find((m: any) => m.role === 'tool_result') as any;
    assert.match(replayToolResult.content[0].content[0].text, /^\[Compacted: read_file result dropped;/);
    const canonicalToolResult = result.messages.find((m: any) => m.role === 'toolResult') as any;
    assert.equal(canonicalToolResult.content[0].text, rawToolOutput);
  });

  it('throws ContextExhaustedError when retained context still cannot fit', async () => {
    const tool = makeTool('read_file', 'parallel', async () => 'oversize-'.repeat(1_500));
    const api = uniqueApi('context-exhausted');

    registerScriptedPiProvider({
      api,
      turns: (ctx: ScriptedProviderContext) => {
        if (ctx.sawToolResults) {
          return { content: [{ type: 'text', text: 'unreachable' }], stopReason: 'stop' };
        }
        return {
          content: [{ type: 'tool_call', id: 'read-retained', name: 'read_file', arguments: {} }],
          stopReason: 'tool_calls',
        };
      },
    });

    await assert.rejects(
      () => runWavemillLoop({
        model: { id: 'windowed', api, provider: 'test-provider', contextWindow: 2_200 },
        context: makeContext([tool]),
        convertToLlm: piIdentity,
        maxTokens: 256,
        contextManagement: {
          compactionThreshold: 0.8,
          safetyMarginPct: 0,
          minRetainedToolResults: 1,
          minOutputTokens: 128,
        },
      }),
      (error) => {
        assert.ok(error instanceof ContextExhaustedError);
        assert.equal(error.diagnostic.droppedCount, 0);
        assert.equal(error.diagnostic.handoff.stopAfterTurn, 1);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Heartbeat events
// ---------------------------------------------------------------------------

describe('loop — heartbeat events', () => {
  it('emits working heartbeats on turn_start and message_update', async () => {
    const api = uniqueApi('heartbeat');
    registerScriptedPiProvider({
      api,
      turns: [{ content: [{ type: 'text', text: 'Hello' }], stopReason: 'stop' }],
    });

    const heartbeats: HeartbeatEvent[] = [];
    await runWavemillLoop({
      ...baseConfig(api),
      onHeartbeat: (evt) => heartbeats.push(evt),
    });

    assert.ok(heartbeats.length > 0, 'at least one heartbeat should be emitted');
    for (const h of heartbeats) {
      assert.equal(h.state, 'working');
      assert.equal(h.agent, HEARTBEAT_AGENT);
      assert.equal(typeof h.event, 'string');
    }

    assert.ok(heartbeats.some((h) => h.event === 'turn_start'), 'turn_start heartbeat expected');
  });

  it('emits tool_execution_start heartbeats with tool name as detail', async () => {
    const api = uniqueApi('heartbeat-tool');
    const tool = makeTool('fetch_data', 'parallel', async () => 'data');

    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [{ type: 'tool_call', id: 'tc-hb1', name: 'fetch_data', arguments: {} }],
          stopReason: 'tool_calls',
        },
        { content: [{ type: 'text', text: 'Done.' }], stopReason: 'stop' },
      ],
    });

    const heartbeats: HeartbeatEvent[] = [];
    await runWavemillLoop({
      model: { id: 'test-model', api, provider: 'test-provider' },
      context: makeContext([tool]),
      convertToLlm: piIdentity,
      onHeartbeat: (evt) => heartbeats.push(evt),
    });

    const toolHb = heartbeats.find(
      (h) => h.event === 'tool_execution_start' && h.detail === 'fetch_data',
    );
    assert.ok(toolHb, 'tool_execution_start heartbeat with tool name expected');
  });
});

// ---------------------------------------------------------------------------
// Tool-call batch semantics
// ---------------------------------------------------------------------------

describe('loop — batch semantics', () => {
  it('all-read batch: both tools execute and results are collected', async () => {
    const ranTools: string[] = [];

    const readA = makeTool('read_a', 'parallel', async () => {
      ranTools.push('A');
      return 'A-result';
    });
    const readB = makeTool('read_b', 'parallel', async () => {
      ranTools.push('B');
      return 'B-result';
    });

    const api = uniqueApi('batch-reads');
    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [
            { type: 'tool_call', id: 'ra1', name: 'read_a', arguments: {} },
            { type: 'tool_call', id: 'rb1', name: 'read_b', arguments: {} },
          ],
          stopReason: 'tool_calls',
        },
        { content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' },
      ],
    });

    const result = await runWavemillLoop({
      model: { id: 'test-model', api, provider: 'test-provider' },
      context: makeContext([readA, readB]),
      convertToLlm: piIdentity,
    });

    assert.equal(result.stopReason, 'stop');
    assert.equal(result.toolCallsExecuted, 2);
    assert.ok(ranTools.includes('A') && ranTools.includes('B'), 'both reads should execute');
  });

  it('mutation tools execute one at a time in provider order', async () => {
    const executionOrder: string[] = [];

    const patchA = makeTool('patch_a', 'sequential', async () => {
      executionOrder.push('A-start');
      await new Promise<void>((r) => setTimeout(r, 5));
      executionOrder.push('A-end');
      return 'patched-A';
    });

    const patchB = makeTool('patch_b', 'sequential', async () => {
      executionOrder.push('B-start');
      await new Promise<void>((r) => setTimeout(r, 5));
      executionOrder.push('B-end');
      return 'patched-B';
    });

    const api = uniqueApi('batch-mutations');
    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [
            { type: 'tool_call', id: 'pa1', name: 'patch_a', arguments: {} },
            { type: 'tool_call', id: 'pb1', name: 'patch_b', arguments: {} },
          ],
          stopReason: 'tool_calls',
        },
        { content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' },
      ],
    });

    const result = await runWavemillLoop({
      model: { id: 'test-model', api, provider: 'test-provider' },
      context: makeContext([patchA, patchB]),
      convertToLlm: piIdentity,
    });

    assert.equal(result.stopReason, 'stop');
    assert.equal(result.toolCallsExecuted, 2);
    // A must fully finish before B starts (sequential ordering).
    assert.deepEqual(executionOrder, ['A-start', 'A-end', 'B-start', 'B-end']);
  });

  it('mixed batch: read executes before mutation in provider order', async () => {
    const executionOrder: string[] = [];

    const readTool = makeTool('read_file', 'parallel', async () => {
      executionOrder.push('read');
      return 'contents';
    });

    const mutTool = makeTool('patch_file', 'sequential', async () => {
      executionOrder.push('mutation');
      return 'patched';
    });

    const api = uniqueApi('batch-mixed');
    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [
            { type: 'tool_call', id: 'r1', name: 'read_file', arguments: {} },
            { type: 'tool_call', id: 'm1', name: 'patch_file', arguments: {} },
          ],
          stopReason: 'tool_calls',
        },
        { content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' },
      ],
    });

    const result = await runWavemillLoop({
      model: { id: 'test-model', api, provider: 'test-provider' },
      context: makeContext([readTool, mutTool]),
      convertToLlm: piIdentity,
    });

    assert.equal(result.stopReason, 'stop');
    assert.equal(result.toolCallsExecuted, 2);
    // Read must execute before mutation (provider order preserved).
    assert.ok(
      executionOrder.indexOf('read') < executionOrder.indexOf('mutation'),
      'read should precede mutation in provider order',
    );
  });

  it('fail-fast: a tool failure skips subsequent calls in the same batch', async () => {
    const executionLog: string[] = [];

    const failTool = makeTool('fail_tool', 'sequential', async () => {
      executionLog.push('fail');
      return new Error('Intentional failure');
    });

    // next_tool records if it ran; Pi catches throws so we use a flag instead of throw.
    let nextExecuted = false;
    const nextTool = makeTool('next_tool', 'sequential', async () => {
      nextExecuted = true;
      return 'should-not-run';
    });

    const api = uniqueApi('batch-fail-fast');
    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [
            { type: 'tool_call', id: 'f1', name: 'fail_tool', arguments: {} },
            { type: 'tool_call', id: 'n1', name: 'next_tool', arguments: {} },
          ],
          stopReason: 'tool_calls',
        },
        { content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' },
      ],
    });

    const afterCallLog: Array<{ name: string; isError: boolean }> = [];
    const result = await runWavemillLoop({
      model: { id: 'test-model', api, provider: 'test-provider' },
      context: makeContext([failTool, nextTool]),
      convertToLlm: piIdentity,
      afterToolCall: async (ctx) => {
        afterCallLog.push({ name: ctx.toolCall.name, isError: ctx.isError });
        return undefined;
      },
    });

    assert.ok(executionLog.includes('fail'), 'failing tool should have executed');
    assert.ok(!nextExecuted, 'next tool must NOT execute (fail-fast)');
    assert.ok(
      afterCallLog.some((e) => e.name === 'fail_tool' && e.isError),
      'failed tool reported as error via afterToolCall',
    );
    // Pi does NOT call afterToolCall for blocked tools (only for executed tools).
    assert.ok(
      afterCallLog.every((e) => e.name !== 'next_tool'),
      'blocked tool must not appear in afterToolCall (Pi skips it)',
    );
    // The skipped tool result IS in the final messages with 'skipped_after_failure' content.
    const skippedMsg = result.messages.find(
      (m: any) => m.role === 'toolResult' && m.toolName === 'next_tool',
    ) as any;
    assert.ok(skippedMsg, 'skipped tool result must appear in final messages');
    assert.equal(
      skippedMsg.content?.[0]?.text,
      'skipped_after_failure',
      'skipped tool result content must be "skipped_after_failure"',
    );
  });

  it('skipped_after_failure: all subsequent calls are blocked and routed as errors', async () => {
    // Use flags instead of throws since Pi catches tool errors gracefully.
    let skipAExecuted = false;
    let skipBExecuted = false;

    const failFirst = makeTool('fail_first', 'sequential', async () => new Error('First failed'));
    const skipA = makeTool('skip_a', 'sequential', async () => {
      skipAExecuted = true;
      return 'should-not-run';
    });
    const skipB = makeTool('skip_b', 'sequential', async () => {
      skipBExecuted = true;
      return 'should-not-run';
    });

    const api = uniqueApi('batch-skipped');
    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [
            { type: 'tool_call', id: 'ff1', name: 'fail_first', arguments: {} },
            { type: 'tool_call', id: 'sa1', name: 'skip_a', arguments: {} },
            { type: 'tool_call', id: 'sb1', name: 'skip_b', arguments: {} },
          ],
          stopReason: 'tool_calls',
        },
        { content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' },
      ],
    });

    const result = await runWavemillLoop({
      model: { id: 'test-model', api, provider: 'test-provider' },
      context: makeContext([failFirst, skipA, skipB]),
      convertToLlm: piIdentity,
    });

    assert.ok(!skipAExecuted, 'skip_a must not have executed');
    assert.ok(!skipBExecuted, 'skip_b must not have executed');

    // Both skipped tool results appear in final messages with 'skipped_after_failure' content.
    const skipAMsg = result.messages.find(
      (m: any) => m.role === 'toolResult' && m.toolName === 'skip_a',
    ) as any;
    const skipBMsg = result.messages.find(
      (m: any) => m.role === 'toolResult' && m.toolName === 'skip_b',
    ) as any;
    assert.ok(skipAMsg, 'skip_a tool result must appear in final messages');
    assert.ok(skipBMsg, 'skip_b tool result must appear in final messages');
    assert.equal(skipAMsg.content?.[0]?.text, 'skipped_after_failure');
    assert.equal(skipBMsg.content?.[0]?.text, 'skipped_after_failure');
  });
});
