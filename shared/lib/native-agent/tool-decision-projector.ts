/**
 * Tool-decision projector (HOK-2076).
 *
 * Deterministic read-only projection of the canonical native session-event
 * stream into {@link ToolDecisionRow} records. The projector never writes
 * back into the source stream and never re-parses provider payloads: it
 * consumes only what the stream schema already exposes.
 *
 * The projector emits one row per agentic branch point:
 *   - each `tool_call` (paired with its policy decision + result when present),
 *   - each policy `deny` that was not followed by a call,
 *   - one row per model turn that produced text-only or think output.
 *
 * Rows for missing menus, unknown models/tools, missing propensity, and
 * unjoinable outcomes are kept and tagged; they are never dropped.
 */

import { createHash } from 'node:crypto';

import type {
  SessionEvent,
  ModelRequestEvent,
  ModelResponseEvent,
  ToolCallEvent,
  ToolResultEvent,
  ToolPolicyDecisionEvent,
  ToolMenuEvent,
  ProviderToolsEvent,
  MutationOutcomeEvent,
} from './session-stream.schema.ts';
import {
  TOOL_DECISION_SCHEMA_VERSION,
  type ToolDecisionRow,
  type DecisionKind,
  type MenuSnapshot,
  type ProviderMenuSnapshot,
  type PropensityEvidence,
  type StateFeatures,
} from './tool-decision-schema.ts';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface ProjectionInput {
  events: SessionEvent[];
  /** Provider identity; falls back to the first model_request. */
  provider?: string;
  /** Runtime tag ("native" by default). */
  runtime?: string;
}

export interface ProjectionResult {
  rows: ToolDecisionRow[];
  /** Non-fatal warnings the projector emitted while walking the stream. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Turn state
// ---------------------------------------------------------------------------

interface TurnState {
  requestEvent: ModelRequestEvent;
  responseEvent?: ModelResponseEvent;
  menuEvent?: ToolMenuEvent;
  providerMenuEvent?: ProviderToolsEvent;
  policyDecisions: Map<string, ToolPolicyDecisionEvent>;
  toolCalls: Map<string, ToolCallEvent>;
  toolResults: Map<string, ToolResultEvent>;
  mutationOutcomesByCallId: Map<string, MutationOutcomeEvent[]>;
}

// ---------------------------------------------------------------------------
// Projector
// ---------------------------------------------------------------------------

export function projectSessionEventsToDecisions(input: ProjectionInput): ProjectionResult {
  const runtime = input.runtime ?? 'native';
  const warnings: string[] = [];
  const rows: ToolDecisionRow[] = [];

  // Group events by turn. A turn is scoped by (traceId, turnIndex).
  const turns = groupIntoTurns(input.events, warnings);
  if (turns.length === 0) {
    return { rows, warnings };
  }

  // Running state across turns for controllable features.
  let priorToolCallCount = 0;
  let priorErrorCount = 0;
  let priorPolicyDenials = 0;
  let priorErrorFlag = false;

  for (const turn of turns) {
    const provider = input.provider ?? turn.requestEvent.provider;
    const modelId = turn.requestEvent.modelId;

    const toolMenu = snapshotMenu(turn.menuEvent);
    const providerMenu = snapshotProviderMenu(turn.providerMenuEvent);
    const availableTools = toolMenu?.toolNames?.slice();

    const terminalSynthesis = isTerminalSynthesis(providerMenu, toolMenu);

    // Order calls/denials by seq for stable stepIndex.
    const orderedCalls = [...turn.toolCalls.values()].sort((a, b) => a.seq - b.seq);
    const explicitlyExecutedCallIds = new Set(orderedCalls.map((c) => c.callId));
    const orphanedDenials = [...turn.policyDecisions.values()]
      .filter((d) => d.decision === 'deny' && !explicitlyExecutedCallIds.has(d.callId))
      .sort((a, b) => a.seq - b.seq);

    let stepIndex = 0;
    const emittedThisTurn: ToolDecisionRow[] = [];

    // 1) Tool-call rows (allowed by policy, executed by the runtime).
    for (const call of orderedCalls) {
      const decision = turn.policyDecisions.get(call.callId);
      const result = turn.toolResults.get(call.callId);
      const mutationOutcomes = turn.mutationOutcomesByCallId.get(call.callId) ?? [];

      const kind: DecisionKind = deriveExecutedKind(
        call,
        decision,
        providerMenu,
        toolMenu,
      );

      const state: StateFeatures = {
        priorToolCallCount,
        priorErrorFlag,
        priorErrorCount,
        terminalSynthesis,
        priorPolicyDenials,
      };

      const propensity = derivePropensity({
        chosenTool: call.toolName,
        toolMenu,
        providerMenu,
      });

      const row = buildRow({
        sessionId: turn.requestEvent.sessionId,
        traceId: turn.requestEvent.traceId,
        phase: turn.requestEvent.phase,
        turnIndex: turn.requestEvent.turnIndex,
        stepIndex: stepIndex++,
        sourceEventIds: dedupe([
          turn.requestEvent.eventId,
          call.eventId,
          decision?.eventId,
          result?.eventId,
          ...mutationOutcomes.map((m) => m.eventId),
        ]),
        provider,
        model: modelId,
        runtime,
        toolMenu,
        providerMenu,
        availableTools,
        kind,
        chosenTool: call.toolName,
        policyDecision: decision
          ? {
              decision: decision.decision,
              ...(decision.denialReason ? { reason: decision.denialReason } : {}),
              ...(decision.policyConfigDigest
                ? { policyConfigDigest: decision.policyConfigDigest }
                : {}),
            }
          : undefined,
        arguments: call.argumentsDigest || call.argumentsSummary
          ? {
              ...(call.argumentsDigest ? { digest: call.argumentsDigest } : {}),
              ...(call.argumentsSummary ? { summary: call.argumentsSummary } : {}),
            }
          : undefined,
        result: result
          ? {
              status: result.isError ? 'error' : 'success',
              ...(result.byteSize !== undefined ? { byteSize: result.byteSize } : {}),
              ...(result.artifactRef?.digest
                ? { artifactDigest: result.artifactRef.digest }
                : {}),
              ...(result.contentSummary
                ? { contentSummary: result.contentSummary }
                : {}),
            }
          : { status: 'skipped' },
        cost: deriveCost(turn.responseEvent),
        state,
        propensity,
        mutationEvidence: mutationOutcomes.length
          ? {
              commandToolCallIds: [call.callId],
              hasTestEvidence: mutationOutcomes.some(
                (m) => m.commandType === 'test' || (m.commandSummary ?? '').startsWith('test'),
              ),
            }
          : undefined,
        timestamp: turn.requestEvent.timestamp,
        causalEventIds: dedupe([
          turn.requestEvent.eventId,
          turn.menuEvent?.eventId,
          turn.providerMenuEvent?.eventId,
          call.eventId,
          decision?.eventId,
          result?.eventId,
          ...mutationOutcomes.map((m) => m.eventId),
        ]),
      });
      emittedThisTurn.push(row);

      // Advance running counters.
      priorToolCallCount += 1;
      if (result?.isError) {
        priorErrorCount += 1;
        priorErrorFlag = true;
      } else {
        priorErrorFlag = false;
      }
    }

    // 2) Denials that never surfaced as executed tool calls.
    for (const decision of orphanedDenials) {
      const row = buildRow({
        sessionId: turn.requestEvent.sessionId,
        traceId: turn.requestEvent.traceId,
        phase: turn.requestEvent.phase,
        turnIndex: turn.requestEvent.turnIndex,
        stepIndex: stepIndex++,
        sourceEventIds: dedupe([turn.requestEvent.eventId, decision.eventId]),
        provider,
        model: modelId,
        runtime,
        toolMenu,
        providerMenu,
        availableTools,
        kind: 'policy_denied',
        chosenTool: decision.toolName,
        policyDecision: {
          decision: 'deny',
          ...(decision.denialReason ? { reason: decision.denialReason } : {}),
          ...(decision.policyConfigDigest
            ? { policyConfigDigest: decision.policyConfigDigest }
            : {}),
        },
        result: { status: 'n/a' },
        cost: deriveCost(turn.responseEvent),
        state: {
          priorToolCallCount,
          priorErrorFlag,
          priorErrorCount,
          terminalSynthesis,
          priorPolicyDenials,
        },
        propensity: derivePropensity({
          chosenTool: decision.toolName,
          toolMenu,
          providerMenu,
        }),
        timestamp: turn.requestEvent.timestamp,
        causalEventIds: dedupe([
          turn.requestEvent.eventId,
          turn.menuEvent?.eventId,
          turn.providerMenuEvent?.eventId,
          decision.eventId,
        ]),
      });
      emittedThisTurn.push(row);
      priorPolicyDenials += 1;
    }

    // 3) Text-only or think — emitted when a turn produced no executed tool
    //    calls and no orphan denials. `respond` when the stop reason was
    //    end_turn / stop / final text; `think` when the response summary
    //    reports zero tool calls and zero text length.
    if (emittedThisTurn.length === 0) {
      const kind = deriveTextOnlyKind(turn.responseEvent);
      const row = buildRow({
        sessionId: turn.requestEvent.sessionId,
        traceId: turn.requestEvent.traceId,
        phase: turn.requestEvent.phase,
        turnIndex: turn.requestEvent.turnIndex,
        stepIndex: 0,
        sourceEventIds: dedupe([
          turn.requestEvent.eventId,
          turn.responseEvent?.eventId,
        ]),
        provider,
        model: modelId,
        runtime,
        toolMenu,
        providerMenu,
        availableTools,
        kind,
        result: { status: 'n/a' },
        cost: deriveCost(turn.responseEvent),
        state: {
          priorToolCallCount,
          priorErrorFlag,
          priorErrorCount,
          terminalSynthesis,
          priorPolicyDenials,
        },
        propensity: derivePropensity({ toolMenu, providerMenu }),
        timestamp: turn.requestEvent.timestamp,
        causalEventIds: dedupe([
          turn.requestEvent.eventId,
          turn.menuEvent?.eventId,
          turn.providerMenuEvent?.eventId,
          turn.responseEvent?.eventId,
        ]),
      });
      emittedThisTurn.push(row);
    }

    rows.push(...emittedThisTurn);
  }

  return { rows, warnings };
}

// ---------------------------------------------------------------------------
// Turn grouping
// ---------------------------------------------------------------------------

function groupIntoTurns(events: SessionEvent[], warnings: string[]): TurnState[] {
  const modelRequests = events.filter((e): e is ModelRequestEvent => e.type === 'model_request');
  if (modelRequests.length === 0) {
    return [];
  }
  const turns: TurnState[] = [];
  const byRequest = new Map<string, TurnState>();

  // Sort requests by turnIndex then seq for determinism.
  modelRequests.sort((a, b) => a.turnIndex - b.turnIndex || a.seq - b.seq);
  for (const req of modelRequests) {
    const turn: TurnState = {
      requestEvent: req,
      policyDecisions: new Map(),
      toolCalls: new Map(),
      toolResults: new Map(),
      mutationOutcomesByCallId: new Map(),
    };
    turns.push(turn);
    byRequest.set(req.eventId, turn);
  }

  // Sort turns by turnIndex, seq to produce stable ranges.
  const sortedTurns = [...turns].sort(
    (a, b) => a.requestEvent.turnIndex - b.requestEvent.turnIndex,
  );

  const findTurnForSeq = (seq: number): TurnState | undefined => {
    let target: TurnState | undefined;
    for (const turn of sortedTurns) {
      if (turn.requestEvent.seq <= seq) {
        target = turn;
      } else {
        break;
      }
    }
    return target;
  };

  /**
   * Menu / provider_tools events precede the model_request they inform.
   * Attach each to the FIRST turn whose request seq is greater-or-equal.
   */
  const findTurnForPrecedingSeq = (seq: number): TurnState | undefined => {
    for (const turn of sortedTurns) {
      if (turn.requestEvent.seq >= seq) return turn;
    }
    return undefined;
  };

  const findTurnForCallId = (callId: string | undefined): TurnState | undefined => {
    if (!callId) return undefined;
    for (const turn of sortedTurns) {
      if (turn.toolCalls.has(callId) || turn.policyDecisions.has(callId)) {
        return turn;
      }
    }
    return undefined;
  };

  for (const event of events) {
    switch (event.type) {
      case 'tool_menu': {
        const t = findTurnForPrecedingSeq(event.seq);
        if (t) t.menuEvent = event as ToolMenuEvent;
        break;
      }
      case 'provider_tools': {
        const t = findTurnForPrecedingSeq(event.seq);
        if (t) t.providerMenuEvent = event as ProviderToolsEvent;
        break;
      }
      case 'model_response': {
        const resp = event as ModelResponseEvent;
        const t = byRequest.get(resp.requestEventId) ?? findTurnForSeq(event.seq);
        if (t) t.responseEvent = resp;
        break;
      }
      case 'tool_policy_decision': {
        const dec = event as ToolPolicyDecisionEvent;
        const t = findTurnForSeq(event.seq);
        if (t) t.policyDecisions.set(dec.callId, dec);
        else warnings.push(`orphan_policy_decision:${dec.callId}`);
        break;
      }
      case 'tool_call': {
        const call = event as ToolCallEvent;
        const t = findTurnForSeq(event.seq);
        if (t) t.toolCalls.set(call.callId, call);
        else warnings.push(`orphan_tool_call:${call.callId}`);
        break;
      }
      case 'tool_result': {
        const result = event as ToolResultEvent;
        const t = findTurnForCallId(result.callId) ?? findTurnForSeq(event.seq);
        if (t) t.toolResults.set(result.callId, result);
        else warnings.push(`orphan_tool_result:${result.callId}`);
        break;
      }
      case 'mutation_outcome': {
        const mut = event as MutationOutcomeEvent;
        const t = findTurnForCallId(mut.toolCallId) ?? findTurnForSeq(event.seq);
        if (t && mut.toolCallId) {
          const bucket = t.mutationOutcomesByCallId.get(mut.toolCallId) ?? [];
          bucket.push(mut);
          t.mutationOutcomesByCallId.set(mut.toolCallId, bucket);
        }
        break;
      }
      default:
        break;
    }
  }

  return sortedTurns;
}

// ---------------------------------------------------------------------------
// Field derivation
// ---------------------------------------------------------------------------

function snapshotMenu(event?: ToolMenuEvent): MenuSnapshot | undefined {
  if (!event) return undefined;
  return {
    digest: event.digest,
    toolNames: [...event.toolNames],
    ...(event.artifactRef?.byteSize !== undefined
      ? { byteSize: event.artifactRef.byteSize }
      : {}),
    ...(event.artifactRef?.digest ? { artifactDigest: event.artifactRef.digest } : {}),
  };
}

function snapshotProviderMenu(event?: ProviderToolsEvent): ProviderMenuSnapshot | undefined {
  if (!event) return undefined;
  return {
    digest: event.digest,
    toolCount: event.toolCount,
    ...(event.artifactRef?.digest ? { artifactDigest: event.artifactRef.digest } : {}),
  };
}

function isTerminalSynthesis(
  providerMenu?: ProviderMenuSnapshot,
  toolMenu?: MenuSnapshot,
): boolean {
  if (providerMenu && providerMenu.toolCount === 0) return true;
  if (toolMenu && toolMenu.toolNames.length === 0) return true;
  return false;
}

function deriveExecutedKind(
  _call: ToolCallEvent,
  decision: ToolPolicyDecisionEvent | undefined,
  providerMenu?: ProviderMenuSnapshot,
  toolMenu?: MenuSnapshot,
): DecisionKind {
  if (decision?.decision === 'deny') return 'policy_denied';
  const menuSize = toolMenu?.toolNames.length ?? providerMenu?.toolCount ?? undefined;
  if (menuSize === 1) return 'forced_tool_call';
  return 'tool_call';
}

function deriveTextOnlyKind(response?: ModelResponseEvent): DecisionKind {
  if (!response) return 'respond';
  const summary = response.contentSummary;
  const textLen = summary?.textLength ?? 0;
  const toolCalls = summary?.toolCallCount ?? 0;
  if (textLen === 0 && toolCalls === 0) return 'think';
  return 'respond';
}

function derivePropensity(opts: {
  chosenTool?: string;
  toolMenu?: MenuSnapshot;
  providerMenu?: ProviderMenuSnapshot;
}): PropensityEvidence {
  const menuNames = opts.toolMenu?.toolNames;
  if (!menuNames || menuNames.length === 0) {
    return { provenance: 'unavailable' };
  }
  const alternatives = opts.chosenTool
    ? menuNames.filter((n) => n !== opts.chosenTool)
    : [...menuNames];
  return { provenance: 'surrogate', alternatives };
}

function deriveCost(response?: ModelResponseEvent) {
  if (!response?.usage) return undefined;
  const u = response.usage;
  return {
    ...(u.inputTokens !== undefined ? { inputTokens: u.inputTokens } : {}),
    ...(u.outputTokens !== undefined ? { outputTokens: u.outputTokens } : {}),
    ...(u.cacheReadTokens !== undefined ? { cacheReadTokens: u.cacheReadTokens } : {}),
    ...(u.cacheWriteTokens !== undefined ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
  };
}

// ---------------------------------------------------------------------------
// Row assembly
// ---------------------------------------------------------------------------

function buildRow(partial: Omit<ToolDecisionRow, 'schemaVersion' | 'decisionId'>): ToolDecisionRow {
  const decisionId = deterministicDecisionId(partial);
  return {
    schemaVersion: TOOL_DECISION_SCHEMA_VERSION,
    decisionId,
    ...partial,
  };
}

function deterministicDecisionId(
  partial: Omit<ToolDecisionRow, 'schemaVersion' | 'decisionId'>,
): string {
  const seed = JSON.stringify({
    session: partial.sessionId,
    trace: partial.traceId,
    phase: partial.phase,
    turn: partial.turnIndex,
    step: partial.stepIndex,
    kind: partial.kind,
    chosen: partial.chosenTool ?? '',
    sources: partial.sourceEventIds,
  });
  return createHash('sha256').update(seed).digest('hex').slice(0, 24);
}

function dedupe(values: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}
