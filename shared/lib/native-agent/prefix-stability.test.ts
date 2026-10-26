/**
 * Request-prefix stability (HOK-3261).
 *
 * Protects: provider prompt caching. A cached prefix is only reused when each
 * request starts with the previous request's exact bytes. If the harness puts
 * a timestamp in the system prompt, reorders the tools, or rewrites an old
 * message, nothing errors and every later turn silently pays full price
 * (HOK-3260 detects that at runtime; this stops it in CI).
 *
 * The native loop runs against a fake provider that records the request bytes
 * Pi's real openai-completions transport sends, through a scripted session
 * with a tool call, a reminder (the thinking-only continuation prompt) and a
 * compaction. Assertions are on those bytes, never on source text (HOK-3237).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { runWavemillLoop } from './loop.ts';
import { createRecordingProvider, type RecordingProviderTurn } from './fixtures/recording-provider.ts';

const SYSTEM_PROMPT = 'You are a test agent. Read the notes, then answer.';
const COMPACTION_MARKER = '[Compacted:';
// Large enough that a second result pushes the request past the compaction
// trigger (80% of the context window) while one result stays under it.
const TOOL_RESULT_TEXT = 'n'.repeat(32_000);
const CONTEXT_WINDOW_TOKENS = 20_000;

const SCRIPT: RecordingProviderTurn[] = [
  { toolCalls: [{ id: 'call_1', name: 'read_note', arguments: { id: 'a' } }] },
  { toolCalls: [{ id: 'call_2', name: 'list_notes', arguments: {} }] },
  // Thinking-only turn: the loop answers with its continuation reminder.
  { reasoning: 'Considering the notes.' },
  { text: 'Done.' },
];

function makeTool(name: string): AgentTool<any, void> {
  return {
    name,
    description: `Test tool: ${name}`,
    parameters: { type: 'object', properties: { id: { type: 'string' } } } as any,
    label: name,
    executionMode: 'sequential',
    async execute(): Promise<AgentToolResult<void>> {
      return { content: [{ type: 'text', text: TOOL_RESULT_TEXT }], details: undefined as void };
    },
  } as unknown as AgentTool<any, void>;
}

interface SessionVariant {
  /** Build the system prompt from the run's inputs (the timestamp variant stamps it). */
  systemPrompt?: () => string;
  /** Per-request body edit just before the wire (the shuffle variant reorders tools). */
  onPayload?: (payload: Record<string, unknown>, requestIndex: number) => Record<string, unknown> | undefined;
}

/** Run the scripted session and return the request bodies exactly as sent. */
async function runSession(variant: SessionVariant = {}): Promise<string[]> {
  const provider = createRecordingProvider(SCRIPT);
  let requestIndex = 0;
  const streamFn: StreamFn = variant.onPayload
    ? (model, context, options) => provider.streamFn(model, context, {
      ...options,
      onPayload: async (payload, payloadModel) => {
        const replaced = await options?.onPayload?.(payload, payloadModel);
        return variant.onPayload!((replaced ?? payload) as Record<string, unknown>, requestIndex++) ?? replaced;
      },
    })
    : provider.streamFn;

  const result = await runWavemillLoop({
    model: {
      id: 'prefix-model',
      api: 'openai-completions',
      provider: 'prefix-fake',
      contextWindow: CONTEXT_WINDOW_TOKENS,
      maxTokens: 1_024,
    },
    context: {
      systemPrompt: variant.systemPrompt?.() ?? SYSTEM_PROMPT,
      messages: [{ role: 'user', content: 'Summarise the notes.', timestamp: 0 }],
      tools: [makeTool('read_note'), makeTool('list_notes')],
    },
    convertToLlm: (messages) => messages as unknown as Message[],
    streamFn,
    contextManagement: { minRetainedToolResults: 1 },
  });
  assert.equal(result.stopReason, 'stop');
  return provider.requests.map((request) => request.body);
}

interface WireRequest {
  system: string;
  tools: string;
  /** Each non-system message, serialised in wire key order. */
  messages: string[];
}

function parseWire(body: string): WireRequest {
  const json = JSON.parse(body) as { messages: Array<Record<string, unknown>>; tools?: unknown[] };
  const [system, ...messages] = json.messages;
  assert.equal(system?.role, 'system', 'first wire message is the system prompt');
  return {
    system: JSON.stringify(system),
    tools: JSON.stringify(json.tools ?? []),
    messages: messages.map((message) => JSON.stringify(message)),
  };
}

function firstDifference(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index++) {
    if (left[index] !== right[index]) return index;
  }
  return limit;
}

/**
 * Every way a session breaks its cached prefix. Empty means each request
 * extends the previous one, except one reset at a compaction.
 */
function findPrefixViolations(bodies: string[]): string[] {
  const violations: string[] = [];
  let resets = 0;
  const requests = bodies.map(parseWire);
  for (let index = 1; index < requests.length; index++) {
    const previous = requests[index - 1];
    const current = requests[index];
    if (current.system !== previous.system) {
      violations.push(`request ${index}: system prompt diverged at byte ${firstDifference(previous.system, current.system)}`);
    }
    if (current.tools !== previous.tools) {
      violations.push(`request ${index}: tool list order diverged at byte ${firstDifference(previous.tools, current.tools)}`);
    }
    const divergence = previous.messages.findIndex((message, position) => current.messages[position] !== message);
    if (divergence === -1) continue;
    resets += 1;
    const replacement = current.messages[divergence] ?? '';
    if (!replacement.includes(COMPACTION_MARKER)) {
      violations.push(`request ${index}: message ${divergence} rewritten outside a compaction`);
    } else if (resets > 1) {
      violations.push(`request ${index}: prefix reset more than once (compaction ${resets})`);
    }
  }
  return violations;
}

/** Same inputs → byte-identical system prompt and tools in every request. */
function findDeterminismViolations(runA: string[], runB: string[]): string[] {
  const violations: string[] = [];
  if (runA.length !== runB.length) {
    violations.push(`request count differs: ${runA.length} vs ${runB.length}`);
  }
  for (let index = 0; index < Math.min(runA.length, runB.length); index++) {
    const left = parseWire(runA[index]);
    const right = parseWire(runB[index]);
    if (left.system !== right.system) {
      violations.push(`request ${index}: system prompt diverged across runs at byte ${firstDifference(left.system, right.system)}`);
    }
    if (left.tools !== right.tools) {
      violations.push(`request ${index}: tool list diverged across runs at byte ${firstDifference(left.tools, right.tools)}`);
    }
  }
  return violations;
}

describe('native request prefix stability', () => {
  it('each request extends the previous one, with one reset at the compaction', async () => {
    const bodies = await runSession();

    assert.equal(bodies.length, SCRIPT.length, 'one request per scripted turn');
    assert.deepEqual(findPrefixViolations(bodies), []);

    // The scenario really exercised what it claims: a compaction happened, the
    // reminder was sent, and the initial instruction survived both.
    const last = parseWire(bodies.at(-1)!);
    assert.ok(last.messages.some((message) => message.includes(COMPACTION_MARKER)), 'a tool result was compacted');
    assert.match(last.messages.at(-1)!, /internal reasoning only/, 'the continuation reminder is the last message');
    assert.match(last.messages[0], /Summarise the notes\./, 'the initial instruction is still in the last request');
  });

  it('the same inputs give byte-identical system prompt and tools', async () => {
    const [runA, runB] = [await runSession(), await runSession()];
    assert.deepEqual(findDeterminismViolations(runA, runB), []);
  });

  it('keeps the tools in one order', async () => {
    const bodies = await runSession();
    const names = bodies.map((body) => (JSON.parse(body).tools as Array<{ function: { name: string } }>)
      .map((tool) => tool.function.name)
      .join(','));
    assert.deepEqual(new Set(names), new Set(['read_note,list_notes']));
  });

  it('fails when a timestamp is injected into the system prompt', async () => {
    let clock = Date.UTC(2026, 9, 26, 12, 0, 0);
    const stamped = () => `${SYSTEM_PROMPT}\nCurrent time: ${new Date(clock += 1_000).toISOString()}`;
    const [runA, runB] = [
      await runSession({ systemPrompt: stamped }),
      await runSession({ systemPrompt: stamped }),
    ];

    const violations = findDeterminismViolations(runA, runB);
    assert.ok(violations.length > 0, 'a stamped system prompt must break determinism');
    assert.match(violations[0], /request 0: system prompt diverged across runs at byte \d+/);
  });

  it('fails when the tool list order is shuffled between turns', async () => {
    const bodies = await runSession({
      onPayload: (payload, requestIndex) => requestIndex % 2 === 1
        ? { ...payload, tools: [...(payload.tools as unknown[])].reverse() }
        : undefined,
    });

    const violations = findPrefixViolations(bodies);
    assert.ok(violations.some((violation) => /request 1: tool list order diverged at byte \d+/.test(violation)), violations.join('\n'));
  });
});
