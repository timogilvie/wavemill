/**
 * Tool-decision projector (HOK-2076).
 *
 * Projects canonical P0 session events into provider-independent
 * tool-decision rows. Correlates model_request, model_response,
 * tool_policy_decision, tool_call, tool_result, tool_menu, and
 * provider_tools events by callId and sequence.
 *
 * Tolerates partial/crashed sessions and duplicate call IDs by
 * never overwriting prior rows.
 *
 * @module tool-decision-projector
 */

import type {
  SessionEvent,
  ModelRequestEvent,
  ModelResponseEvent,
  ToolPolicyDecisionEvent,
  ToolCallEvent,
  ToolResultEvent,
  ToolMenuEvent,
  ProviderToolsEvent,
  MutationOutcomeEvent,
} from './native-agent/session-stream.schema.ts';
import type {
  ToolDecisionRow,
  MenuReference,
  MutationEvidence,
  StateFeatures,
  PropensityRecord,
  DecisionKind,
  PolicyOutcome,
  ResultStatus,
} from './tool-decision-schema.ts';
import { TOOL_DECISION_SCHEMA_VERSION } from './tool-decision-schema.ts';

// ---------------------------------------------------------------------------
// Internal correlation state
// ---------------------------------------------------------------------------

interface TurnState {
  request: ModelRequestEvent;
  response?: ModelResponseEvent;
  policyDecisions: Map<string, ToolPolicyDecisionEvent>;
  toolCalls: Map<string, ToolCallEvent>;
  toolResults: Map<string, ToolResultEvent>;
  mutations: MutationOutcomeEvent[];
  stepIndex: number;
  priorErrorInTurn: boolean;
}

interface MenuState {
  policyMenu: MenuReference | null;
  providerMenu: MenuReference | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMenuRef(
  event: ToolMenuEvent | ProviderToolsEvent,
): MenuReference {
  if (event.type === 'tool_menu') {
    return {
      digest: event.digest,
      toolNames: event.toolNames,
      toolCount: event.toolNames.length,
      artifactRef: event.artifactRef
        ? { digest: event.artifactRef.digest, path: event.artifactRef.path }
        : undefined,
      availability: event.artifactRef ? 'available' : 'digest_only',
    };
  }
  return {
    digest: event.digest,
    toolCount: (event as ProviderToolsEvent).toolCount,
    artifactRef: event.artifactRef
      ? { digest: event.artifactRef.digest, path: event.artifactRef.path }
      : undefined,
    availability: event.artifactRef ? 'available' : 'digest_only',
  };
}

function computeLatencyMs(
  start: string | number,
  end: string | number,
): number | undefined {
  const s = typeof start === 'string' ? new Date(start).getTime() : start;
  const e = typeof end === 'string' ? new Date(end).getTime() : end;
  if (isNaN(s) || isNaN(e)) return undefined;
  const diff = e - s;
  return diff >= 0 ? diff : undefined;
}

const UNAVAILABLE_PROPENSITY: PropensityRecord = {
  source: 'unavailable',
};

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export interface ProjectionResult {
  rows: ToolDecisionRow[];
  warnings: string[];
}

/**
 * Project a sequence of session events into tool-decision rows.
 *
 * Events must be from a single session, ordered by seq.
 * The projector emits one row per agentic branch point.
 */
export function projectSessionEvents(events: SessionEvent[]): ProjectionResult {
  const rows: ToolDecisionRow[] = [];
  const warnings: string[] = [];
  const emittedCallIds = new Set<string>();

  let currentMenu: MenuState = { policyMenu: null, providerMenu: null };
  let currentTurn: TurnState | null = null;
  let sessionId = '';
  let traceId = '';

  for (const event of events) {
    if (!sessionId && event.sessionId) sessionId = event.sessionId;
    if (!traceId && event.traceId) traceId = event.traceId;

    switch (event.type) {
      case 'tool_menu':
        currentMenu.policyMenu = buildMenuRef(event);
        break;

      case 'provider_tools':
        currentMenu.providerMenu = buildMenuRef(event);
        break;

      case 'model_request': {
        // Flush any pending turn before starting a new one
        if (currentTurn) {
          const turnRows = flushTurn(
            currentTurn,
            currentMenu,
            sessionId,
            traceId,
            emittedCallIds,
            warnings,
          );
          rows.push(...turnRows);
        }
        currentTurn = {
          request: event,
          policyDecisions: new Map(),
          toolCalls: new Map(),
          toolResults: new Map(),
          mutations: [],
          stepIndex: 0,
          priorErrorInTurn: false,
        };
        break;
      }

      case 'model_response':
        if (currentTurn && event.callId === currentTurn.request.callId) {
          currentTurn.response = event;
        }
        break;

      case 'tool_policy_decision':
        if (currentTurn && !currentTurn.policyDecisions.has(event.callId)) {
          currentTurn.policyDecisions.set(event.callId, event);
        }
        break;

      case 'tool_call':
        if (currentTurn && !currentTurn.toolCalls.has(event.callId)) {
          currentTurn.toolCalls.set(event.callId, event);
        }
        break;

      case 'tool_result':
        if (currentTurn && !currentTurn.toolResults.has(event.callId)) {
          currentTurn.toolResults.set(event.callId, event);
          if (event.isError) {
            currentTurn.priorErrorInTurn = true;
          }
        }
        break;

      case 'mutation_outcome':
        if (currentTurn) {
          currentTurn.mutations.push(event);
        }
        break;

      default:
        break;
    }
  }

  // Flush final turn
  if (currentTurn) {
    const turnRows = flushTurn(
      currentTurn,
      currentMenu,
      sessionId,
      traceId,
      emittedCallIds,
      warnings,
    );
    rows.push(...turnRows);
  }

  return { rows, warnings };
}

function flushTurn(
  turn: TurnState,
  menu: MenuState,
  sessionId: string,
  traceId: string,
  emittedCallIds: Set<string>,
  warnings: string[],
): ToolDecisionRow[] {
  const rows: ToolDecisionRow[] = [];
  const req = turn.request;

  const turnUsage = turn.response?.usage
    ? {
        inputTokens: turn.response.usage.inputTokens,
        outputTokens: turn.response.usage.outputTokens,
        cacheReadTokens: turn.response.usage.cacheReadTokens,
        cacheWriteTokens: turn.response.usage.cacheWriteTokens,
      }
    : null;

  const mutationEvidence: MutationEvidence[] = turn.mutations.map((m) => ({
    commandType: m.commandType,
    commandSummary: m.commandSummary,
    isError: m.isError,
    outcomeSummary: m.outcomeSummary,
  }));

  // Emit rows for policy denials
  for (const [callId, policy] of turn.policyDecisions) {
    if (policy.decision === 'deny' && !emittedCallIds.has(callId)) {
      emittedCallIds.add(callId);
      const stateFeatures: StateFeatures = {
        phase: req.phase,
        turnIndex: req.turnIndex,
        stepIndex: turn.stepIndex++,
        toolCallsInTurn: turn.toolCalls.size,
        priorErrorInTurn: turn.priorErrorInTurn,
        contextTokens: req.contextTokens,
      };
      rows.push({
        schemaVersion: TOOL_DECISION_SCHEMA_VERSION,
        sessionId,
        traceId,
        phase: req.phase,
        turnIndex: req.turnIndex,
        stepIndex: stateFeatures.stepIndex,
        model: req.modelId,
        provider: req.provider,
        policyMenu: menu.policyMenu,
        providerMenu: menu.providerMenu,
        decisionKind: 'policy_denial',
        chosenTool: policy.toolName,
        chosenToolProvider: policy.toolName,
        policyOutcome: 'deny',
        denialReason: policy.denialReason,
        resultStatus: 'not_applicable',
        isError: false,
        turnUsage: turnUsage,
        requestEventId: req.eventId,
        responseEventId: turn.response?.eventId,
        toolCallEventId: undefined,
        toolResultEventId: undefined,
        causedByEventId: req.causedByEventId,
        stateFeatures,
        propensity: UNAVAILABLE_PROPENSITY,
        mutationEvidence: [],
        redacted: false,
        timestamp: policy.timestamp,
      });
    }
  }

  // Emit rows for executed tool calls
  for (const [callId, call] of turn.toolCalls) {
    if (emittedCallIds.has(callId)) continue;
    emittedCallIds.add(callId);

    const result = turn.toolResults.get(callId);
    const policy = turn.policyDecisions.get(callId);
    const isForcedSingle = turn.toolCalls.size === 1 &&
      (turn.response?.stopReason === 'tool_use' || turn.response?.stopReason === 'end_turn');

    const stateFeatures: StateFeatures = {
      phase: req.phase,
      turnIndex: req.turnIndex,
      stepIndex: turn.stepIndex++,
      toolCallsInTurn: turn.toolCalls.size,
      priorErrorInTurn: turn.priorErrorInTurn,
      contextTokens: req.contextTokens,
    };

    const latencyMs = result
      ? computeLatencyMs(call.timestamp, result.timestamp)
      : undefined;

    const redaction = result?.redaction;

    rows.push({
      schemaVersion: TOOL_DECISION_SCHEMA_VERSION,
      sessionId,
      traceId,
      phase: req.phase,
      turnIndex: req.turnIndex,
      stepIndex: stateFeatures.stepIndex,
      model: req.modelId,
      provider: req.provider,
      policyMenu: menu.policyMenu,
      providerMenu: menu.providerMenu,
      decisionKind: isForcedSingle ? 'forced_single_tool' : 'tool_call',
      chosenTool: call.toolName,
      chosenToolProvider: call.toolName,
      policyOutcome: policy ? (policy.decision as PolicyOutcome) : 'not_evaluated',
      argumentsDigest: call.argumentsDigest,
      resultStatus: result
        ? (result.isError ? 'error' : 'success')
        : 'pending' as ResultStatus,
      latencyMs,
      isError: result?.isError ?? false,
      turnUsage: turnUsage,
      requestEventId: req.eventId,
      responseEventId: turn.response?.eventId,
      toolCallEventId: call.eventId,
      toolResultEventId: result?.eventId,
      causedByEventId: req.causedByEventId,
      stateFeatures,
      propensity: UNAVAILABLE_PROPENSITY,
      mutationEvidence: call.toolName === 'Bash' || call.toolName === 'Edit' || call.toolName === 'Write'
        ? mutationEvidence
        : [],
      redacted: redaction?.redacted ?? false,
      redactionSummary: redaction?.redactionSummary,
      timestamp: call.timestamp,
      endTimestamp: result?.timestamp,
    });
  }

  // If no tool calls at all, emit a text_only/think row
  if (turn.toolCalls.size === 0 && turn.policyDecisions.size === 0) {
    const stateFeatures: StateFeatures = {
      phase: req.phase,
      turnIndex: req.turnIndex,
      stepIndex: turn.stepIndex++,
      toolCallsInTurn: 0,
      priorErrorInTurn: false,
      contextTokens: req.contextTokens,
    };

    const stopReason = turn.response?.stopReason ?? 'unknown';
    const kind: DecisionKind = stopReason === 'end_turn' ? 'text_only' : 'think';

    rows.push({
      schemaVersion: TOOL_DECISION_SCHEMA_VERSION,
      sessionId,
      traceId,
      phase: req.phase,
      turnIndex: req.turnIndex,
      stepIndex: stateFeatures.stepIndex,
      model: req.modelId,
      provider: req.provider,
      policyMenu: menu.policyMenu,
      providerMenu: menu.providerMenu,
      decisionKind: kind,
      chosenTool: null,
      chosenToolProvider: null,
      policyOutcome: 'not_evaluated',
      resultStatus: 'not_applicable',
      isError: false,
      turnUsage: turnUsage,
      requestEventId: req.eventId,
      responseEventId: turn.response?.eventId,
      causedByEventId: req.causedByEventId,
      stateFeatures,
      propensity: UNAVAILABLE_PROPENSITY,
      mutationEvidence: [],
      redacted: false,
      timestamp: req.timestamp,
      endTimestamp: turn.response?.timestamp,
    });
  }

  return rows;
}
