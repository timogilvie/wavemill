/**
 * Cross-provider-shaped native fixtures for the tool-decision corpus tests
 * (HOK-2076). Builds canonical SessionEvent[] arrays that cover:
 *   - normal tool call (planning),
 *   - forced single-tool call,
 *   - policy denial,
 *   - text-only response,
 *   - empty provider menu (terminal synthesis),
 *   - redacted arguments,
 *   - tool error,
 *   - mutation/test evidence,
 *   - unavailable propensity.
 *
 * Fixtures are constructed programmatically so they stay in lock-step with
 * the SessionEvent schema. Timestamps are pinned so decisionIds are stable.
 */

import { SESSION_STREAM_SCHEMA_VERSION, type SessionEvent } from '../../session-stream.schema.ts';

const FIXED_TIME = 1_759_000_000_000;
const RUNTIME = 'native';

interface BuildOpts {
  sessionId: string;
  traceId: string;
  phase: string;
  provider?: string;
  model?: string;
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function resetFixtureCounter(): void {
  counter = 0;
}

function base(opts: BuildOpts & { seq: number; type: SessionEvent['type']; eventId?: string }) {
  return {
    eventId: opts.eventId ?? nextId(String(opts.type)),
    seq: opts.seq,
    timestamp: FIXED_TIME + opts.seq,
    sessionId: opts.sessionId,
    traceId: opts.traceId,
    phase: opts.phase,
    schemaVersion: SESSION_STREAM_SCHEMA_VERSION,
    type: opts.type,
  } as const;
}

/**
 * A planning session: session_started → tool_menu → provider_tools →
 * model_request → tool_policy_decision(allow) → tool_call →
 * tool_result(success) → mutation_outcome → model_response → session_ended.
 */
export function buildPlanningWithToolCall(): SessionEvent[] {
  resetFixtureCounter();
  const opts: BuildOpts = {
    sessionId: 'sess-planning-happy',
    traceId: 'trace-1',
    phase: 'planning',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
  };
  const events: SessionEvent[] = [];
  let seq = 0;
  events.push({
    ...base({ ...opts, seq: seq++, type: 'session_started' }),
    sessionId: opts.sessionId,
    initialConfigDigest: 'digest-init',
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'tool_menu' }),
    toolNames: ['read', 'edit'],
    digest: 'menu-digest-1',
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'provider_tools' }),
    toolCount: 2,
    digest: 'provider-digest-1',
  } as SessionEvent);
  const reqId = nextId('req');
  events.push({
    ...base({ ...opts, seq: seq++, type: 'model_request', eventId: reqId }),
    callId: 'req-call-1',
    turnIndex: 0,
    provider: opts.provider!,
    modelId: opts.model!,
    config: { temperature: 0, maxTokens: 4096 },
    contextDigest: 'ctx-digest-1',
    promptRefs: [{ resourceId: 'planning-prompt', contentHash: 'ph1' }],
    toolMenuDigest: 'menu-digest-1',
    providerToolsDigest: 'provider-digest-1',
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'tool_policy_decision' }),
    callId: 'call-1',
    toolName: 'read',
    decision: 'allow',
    policyConfigDigest: 'policy-digest-1',
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'tool_call' }),
    callId: 'call-1',
    toolName: 'read',
    argumentsDigest: 'args-digest-1',
    argumentsSummary: "read('src/index.ts')",
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'tool_result' }),
    callId: 'call-1',
    toolName: 'read',
    isError: false,
    byteSize: 128,
    contentSummary: 'export function main() {}',
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'mutation_outcome' }),
    commandType: 'read',
    commandSummary: 'read src/index.ts',
    isError: false,
    outcomeSummary: '128 bytes',
    toolCallId: 'call-1',
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'model_response' }),
    requestEventId: reqId,
    callId: 'req-call-1',
    stopReason: 'tool_use',
    contentSummary: { toolCallCount: 1, textLength: 0 },
    usage: { inputTokens: 800, outputTokens: 40 },
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'session_ended' }),
    stopReason: 'end',
    totalTurns: 1,
    totalToolCalls: 1,
  } as SessionEvent);
  return events;
}

/**
 * Coding session with a policy denial (blocked tool) followed by a text-only
 * response — text-only turn covers respond kind.
 */
export function buildCodingWithDenialAndRespond(): SessionEvent[] {
  resetFixtureCounter();
  const opts: BuildOpts = {
    sessionId: 'sess-coding-denial',
    traceId: 'trace-2',
    phase: 'coding',
    provider: 'openrouter',
    model: 'anthropic/claude-3-5-sonnet',
  };
  const events: SessionEvent[] = [];
  let seq = 0;
  events.push({
    ...base({ ...opts, seq: seq++, type: 'session_started' }),
    sessionId: opts.sessionId,
    initialConfigDigest: 'digest-init',
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'tool_menu' }),
    toolNames: ['read', 'edit', 'bash'],
    digest: 'menu-digest-2',
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'provider_tools' }),
    toolCount: 3,
    digest: 'provider-digest-2',
  } as SessionEvent);
  const req = nextId('req');
  events.push({
    ...base({ ...opts, seq: seq++, type: 'model_request', eventId: req }),
    callId: 'req-call-2',
    turnIndex: 0,
    provider: opts.provider!,
    modelId: opts.model!,
    config: {},
    contextDigest: 'ctx-digest-2',
    promptRefs: [],
    toolMenuDigest: 'menu-digest-2',
    providerToolsDigest: 'provider-digest-2',
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'tool_policy_decision' }),
    callId: 'call-deny-1',
    toolName: 'bash',
    decision: 'deny',
    denialReason: 'mutation_blocked',
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'model_response' }),
    requestEventId: req,
    callId: 'req-call-2',
    stopReason: 'tool_use',
    contentSummary: { toolCallCount: 1, textLength: 40 },
    usage: { inputTokens: 500, outputTokens: 25 },
  } as SessionEvent);
  // Second turn: text-only response.
  const req2 = nextId('req');
  events.push({
    ...base({ ...opts, seq: seq++, type: 'tool_menu' }),
    toolNames: ['read', 'edit', 'bash'],
    digest: 'menu-digest-2',
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'provider_tools' }),
    toolCount: 3,
    digest: 'provider-digest-2',
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'model_request', eventId: req2 }),
    callId: 'req-call-3',
    turnIndex: 1,
    provider: opts.provider!,
    modelId: opts.model!,
    config: {},
    contextDigest: 'ctx-digest-3',
    promptRefs: [],
    toolMenuDigest: 'menu-digest-2',
    providerToolsDigest: 'provider-digest-2',
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'model_response' }),
    requestEventId: req2,
    callId: 'req-call-3',
    stopReason: 'end_turn',
    contentSummary: { toolCallCount: 0, textLength: 220 },
    usage: { inputTokens: 300, outputTokens: 55 },
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'session_ended' }),
    stopReason: 'end',
    totalTurns: 2,
    totalToolCalls: 0,
  } as SessionEvent);
  return events;
}

/**
 * Review session with a forced single-tool call, terminal-synthesis turn,
 * and a tool result carrying redaction metadata.
 */
export function buildReviewWithForcedAndRedaction(): SessionEvent[] {
  resetFixtureCounter();
  const opts: BuildOpts = {
    sessionId: 'sess-review-forced',
    traceId: 'trace-3',
    phase: 'review',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
  };
  const events: SessionEvent[] = [];
  let seq = 0;
  events.push({
    ...base({ ...opts, seq: seq++, type: 'session_started' }),
    sessionId: opts.sessionId,
    initialConfigDigest: 'digest-init',
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'tool_menu' }),
    toolNames: ['review_report'],
    digest: 'menu-forced-1',
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'provider_tools' }),
    toolCount: 1,
    digest: 'provider-forced-1',
  } as SessionEvent);
  const req = nextId('req');
  events.push({
    ...base({ ...opts, seq: seq++, type: 'model_request', eventId: req }),
    callId: 'req-call-r1',
    turnIndex: 0,
    provider: opts.provider!,
    modelId: opts.model!,
    config: { temperature: 0 },
    contextDigest: 'ctx-review-1',
    promptRefs: [],
    toolMenuDigest: 'menu-forced-1',
    providerToolsDigest: 'provider-forced-1',
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'tool_policy_decision' }),
    callId: 'call-r1',
    toolName: 'review_report',
    decision: 'allow',
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'tool_call' }),
    callId: 'call-r1',
    toolName: 'review_report',
    argumentsDigest: 'args-r1',
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'tool_result' }),
    callId: 'call-r1',
    toolName: 'review_report',
    isError: true,
    contentSummary: 'error while reading',
    redaction: { redacted: true, redactionSummary: 'api_key' },
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'model_response' }),
    requestEventId: req,
    callId: 'req-call-r1',
    stopReason: 'tool_use',
    contentSummary: { toolCallCount: 1, textLength: 0 },
    usage: {},
  } as SessionEvent);
  // Terminal synthesis turn — empty menus.
  events.push({
    ...base({ ...opts, seq: seq++, type: 'tool_menu' }),
    toolNames: [],
    digest: 'menu-empty',
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'provider_tools' }),
    toolCount: 0,
    digest: 'provider-empty',
  } as SessionEvent);
  const req2 = nextId('req');
  events.push({
    ...base({ ...opts, seq: seq++, type: 'model_request', eventId: req2 }),
    callId: 'req-call-r2',
    turnIndex: 1,
    provider: opts.provider!,
    modelId: opts.model!,
    config: {},
    contextDigest: 'ctx-review-2',
    promptRefs: [],
    toolMenuDigest: 'menu-empty',
    providerToolsDigest: 'provider-empty',
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'model_response' }),
    requestEventId: req2,
    callId: 'req-call-r2',
    stopReason: 'end_turn',
    contentSummary: { toolCallCount: 0, textLength: 512 },
    usage: {},
  } as SessionEvent);
  events.push({
    ...base({ ...opts, seq: seq++, type: 'session_ended' }),
    stopReason: 'end',
    totalTurns: 2,
    totalToolCalls: 1,
  } as SessionEvent);
  // Runtime tag applied by projector, kept via provider override; not embedded here.
  void RUNTIME;
  return events;
}
