/**
 * The one budget-exhaustion outcome (HOK-3362).
 *
 * "A native stage ran out of budget before finishing" used to reach the
 * records under four different causes depending on the stage and the budget
 * kind: the coding launcher read our own wall-clock abort (`"Request was
 * aborted"`) as `provider_error`, a coding `turn_limit` became
 * `no_completion_artifact`, review mapped four of the five budget reasons to
 * `native-review-timeout` → provider-fault, and planning passed `turn_limit`
 * through as a separate `planning-turn-limit` kind → model-fault.
 *
 * This module is the single definition. Every native stage (planning, coding,
 * review, and any future Ready remediation run) that stops on a budget reason
 * records the same typed {@link BudgetExhaustedFact} on its stage result,
 * failure envelope and (for coding) handoff. The fault class is never stored as
 * primary: `classifyArmFault` derives it from the fact's progress evidence
 * (`deriveBudgetExhaustionFaultClass` in `arm-failure-taxonomy.ts`, HOK-3338
 * rule 3).
 *
 * Two rules live here so no caller can re-derive them:
 *   1. {@link BUDGET_STOP_REASONS} is the one set of budget stop reasons.
 *   2. {@link finalProviderErrorMessage} is the one final-assistant
 *      `errorMessage` scan, and it returns `''` on a budget stop: a stop reason
 *      we caused wins over the abort message it leaves behind, so our own abort
 *      never reaches `classifyProviderError`.
 *
 * Enforced by `tools/check-failure-policy.ts` (patterns
 * `private-budget-stop-switch`, `private-final-error-scan`,
 * `budget-stop-provider-classification`).
 */
import type { LoopBudget, LoopResult, LoopStopReason } from './loop.ts';
import type { AgentMessage } from './messages.ts';

/** Which configured budget the run exhausted. */
export type BudgetKind = 'wall_clock' | 'turn' | 'tool_call' | 'token' | 'cost';

export const BUDGET_KINDS: readonly BudgetKind[] = Object.freeze(['wall_clock', 'turn', 'tool_call', 'token', 'cost']);

/** The loop stop reasons that mean "a configured runtime budget ran out". */
export type BudgetStopReason = Extract<
  LoopStopReason,
  'wall_clock_limit' | 'turn_limit' | 'tool_call_limit' | 'token_limit' | 'cost_limit'
>;

const KIND_BY_STOP_REASON: Readonly<Record<BudgetStopReason, BudgetKind>> = Object.freeze({
  wall_clock_limit: 'wall_clock',
  turn_limit: 'turn',
  tool_call_limit: 'tool_call',
  token_limit: 'token',
  cost_limit: 'cost',
});

/**
 * The one definition of a budget stop (moved here from `recovery.ts`, which
 * treated the five reasons as one fact first). `tool_stagnation`, `aborted`
 * and `error` are deliberately absent: stagnation is a behavioural stop, and
 * aborts/errors are not budgets.
 */
export const BUDGET_STOP_REASONS: ReadonlySet<LoopStopReason> = new Set<LoopStopReason>(
  Object.keys(KIND_BY_STOP_REASON) as BudgetStopReason[],
);

export function isBudgetStopReason(reason: string | null | undefined): reason is BudgetStopReason {
  return typeof reason === 'string' && BUDGET_STOP_REASONS.has(reason as LoopStopReason);
}

export function budgetKindForStopReason(reason: string | null | undefined): BudgetKind | null {
  return isBudgetStopReason(reason) ? KIND_BY_STOP_REASON[reason] : null;
}

/**
 * Progress the loop already measures. It is the evidence the fault rule reads:
 * an agent whose turns and tool calls kept advancing did not finish within its
 * budget, while a run that spent its budget waiting on a failing provider did
 * not get the chance to.
 */
export interface BudgetExhaustionProgress {
  turnsCompleted: number;
  toolCallsExecuted: number;
  wallClockMs: number;
  /** Coding only: failed mutation tool calls (`MutationFailureTracker.count`). */
  mutationFailures?: number;
  /** Time between each turn's request and its assistant response, in-flight request included. */
  providerWaitMs?: number;
  /** Provider-error retries the loop spent during the run. */
  providerErrorRetries?: number;
  /** The final assistant turn carried the abort message our own budget caused. */
  interruptedRequest?: boolean;
}

/** The typed fact every native stage writes when it stops on a budget reason. */
export interface BudgetExhaustedFact {
  kind: BudgetKind;
  /** Raw loop stop reason, kept for joins against session streams. */
  stopReason: BudgetStopReason;
  /** Configured budget (ms / turns / calls / tokens / USD); null when unbounded or unknown. */
  limit: number | null;
  /** How much of that budget the run consumed, in the same unit. */
  used: number;
  progress: BudgetExhaustionProgress;
}

type LoopEvidence = Pick<
  LoopResult,
  | 'messages'
  | 'stopReason'
  | 'turnsCompleted'
  | 'toolCallsExecuted'
  | 'totalInputTokens'
  | 'totalOutputTokens'
  | 'totalCostUsd'
  | 'wallClockMs'
> & Partial<Pick<LoopResult, 'providerWaitMs' | 'providerErrorRetries'>>;

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Limit/used for the token budget the loop actually tripped (same order as `loop.ts`). */
function tokenLimitAndUsed(result: LoopEvidence, budget: LoopBudget | undefined): { limit: number | null; used: number } {
  const input = result.totalInputTokens;
  const output = result.totalOutputTokens;
  if (budget?.maxInputTokens !== undefined && input >= budget.maxInputTokens) {
    return { limit: budget.maxInputTokens, used: input };
  }
  if (budget?.maxOutputTokens !== undefined && output >= budget.maxOutputTokens) {
    return { limit: budget.maxOutputTokens, used: output };
  }
  return { limit: finiteOrNull(budget?.maxTotalTokens), used: input + output };
}

function limitAndUsed(
  kind: BudgetKind,
  result: LoopEvidence,
  budget: LoopBudget | undefined,
): { limit: number | null; used: number } {
  switch (kind) {
    case 'wall_clock':
      return { limit: finiteOrNull(budget?.maxWallClockMs), used: result.wallClockMs };
    case 'turn':
      return { limit: finiteOrNull(budget?.maxTurns), used: result.turnsCompleted };
    case 'tool_call':
      return { limit: finiteOrNull(budget?.maxToolCalls), used: result.toolCallsExecuted };
    case 'token':
      return tokenLimitAndUsed(result, budget);
    case 'cost':
      return { limit: finiteOrNull(budget?.maxCostUsd), used: result.totalCostUsd };
  }
}

/**
 * Trimmed `errorMessage` of one assistant message (`''` when absent). The loop's
 * provider-retry path reads a single turn through this; everything that asks
 * "did the run end on a provider error?" goes through
 * {@link finalProviderErrorMessage} instead.
 */
export function assistantErrorText(message: unknown): string {
  const candidate = message as { role?: string; errorMessage?: unknown } | null | undefined;
  if (!candidate || candidate.role !== 'assistant') return '';
  return typeof candidate.errorMessage === 'string' ? candidate.errorMessage.trim() : '';
}

/** Last assistant `errorMessage`, ignoring the stop reason. Internal: callers use {@link finalProviderErrorMessage}. */
function lastAssistantErrorMessage(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = assistantErrorText(messages[index]);
    if (text) return text;
  }
  return '';
}

/**
 * Build the fact for a loop run, or `null` when the run did not stop on a
 * budget reason. `budget` is the {@link LoopBudget} the launcher passed to the
 * loop, so `limit` names the configured ceiling, not a guess.
 */
export function budgetExhaustionFromLoop(
  result: LoopEvidence,
  budget: LoopBudget | undefined,
  extra: { mutationFailures?: number } = {},
): BudgetExhaustedFact | null {
  const kind = budgetKindForStopReason(result.stopReason);
  if (!kind) return null;
  const { limit, used } = limitAndUsed(kind, result, budget);
  const interruptedRequest = lastAssistantErrorMessage(result.messages) !== '';
  return {
    kind,
    stopReason: result.stopReason as BudgetStopReason,
    limit,
    used,
    progress: {
      turnsCompleted: result.turnsCompleted,
      toolCallsExecuted: result.toolCallsExecuted,
      wallClockMs: result.wallClockMs,
      ...(typeof extra.mutationFailures === 'number' ? { mutationFailures: extra.mutationFailures } : {}),
      ...(typeof result.providerWaitMs === 'number' ? { providerWaitMs: result.providerWaitMs } : {}),
      ...(typeof result.providerErrorRetries === 'number' ? { providerErrorRetries: result.providerErrorRetries } : {}),
      ...(interruptedRequest ? { interruptedRequest: true } : {}),
    },
  };
}

/**
 * The one final-assistant `errorMessage` scan (HOK-3362). Returns `''` when the
 * run stopped on a budget reason: the abort message our own budget leaves on
 * the in-flight turn (`"Request was aborted"`) is evidence of the budget stop,
 * not of a provider failure, so it must never reach `classifyProviderError`.
 */
export function finalProviderErrorMessage(result: Pick<LoopResult, 'messages' | 'stopReason'>): string {
  if (isBudgetStopReason(result.stopReason)) return '';
  return lastAssistantErrorMessage(result.messages);
}

const KIND_LABEL: Readonly<Record<BudgetKind, string>> = Object.freeze({
  wall_clock: 'wall-clock',
  turn: 'turn',
  tool_call: 'tool-call',
  token: 'token',
  cost: 'cost',
});

function formatAmount(kind: BudgetKind, value: number): string {
  if (kind === 'wall_clock') return `${Math.round(value / 1000)}s`;
  if (kind === 'cost') return `$${value.toFixed(2)}`;
  return String(value);
}

/**
 * One-line, stage-prefixed description of the fact. Starts with
 * `native-stage-timeout:` so a hook/notes reader sees the one kind.
 */
export function describeBudgetExhaustion(stage: string, fact: BudgetExhaustedFact): string {
  const limit = fact.limit === null ? 'unbounded' : formatAmount(fact.kind, fact.limit);
  const progress = fact.progress;
  const parts = [
    `${progress.turnsCompleted} turn(s)`,
    `${progress.toolCallsExecuted} tool call(s)`,
    ...(typeof progress.mutationFailures === 'number' ? [`${progress.mutationFailures} mutation failure(s)`] : []),
    ...(typeof progress.providerWaitMs === 'number'
      ? [`${Math.round(progress.providerWaitMs / 1000)}s provider wait`]
      : []),
    ...(progress.providerErrorRetries ? [`${progress.providerErrorRetries} provider retry(ies)`] : []),
  ];
  return `native-stage-timeout: native ${stage} exhausted its ${KIND_LABEL[fact.kind]} budget `
    + `(${formatAmount(fact.kind, fact.used)} of ${limit}) after ${parts.join(', ')}`;
}

// ── Validation (shared by the handoff, envelope and stage-result readers) ──

export type BudgetExhaustedFactValidation =
  | { ok: true; value: BudgetExhaustedFact }
  | { ok: false; field: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isInteger(value);
}

/**
 * Validate a fact read from disk. `prefix` names the containing field in the
 * error (`budgetExhausted` by default).
 */
export function validateBudgetExhaustedFact(value: unknown, prefix = 'budgetExhausted'): BudgetExhaustedFactValidation {
  const fail = (field: string, message: string): BudgetExhaustedFactValidation => ({
    ok: false,
    field: field ? `${prefix}.${field}` : prefix,
    message: `${field ? `${prefix}.${field}` : prefix} ${message}`,
  });
  if (!isRecord(value)) return fail('', 'must be an object.');
  if (typeof value.kind !== 'string' || !BUDGET_KINDS.includes(value.kind as BudgetKind)) {
    return fail('kind', `must be one of: ${BUDGET_KINDS.join(', ')}.`);
  }
  if (!isBudgetStopReason(value.stopReason as string)) {
    return fail('stopReason', `must be one of: ${[...BUDGET_STOP_REASONS].join(', ')}.`);
  }
  if (KIND_BY_STOP_REASON[value.stopReason as BudgetStopReason] !== value.kind) {
    return fail('kind', `does not match stopReason "${String(value.stopReason)}".`);
  }
  if (value.limit !== null && !isNonNegativeNumber(value.limit)) {
    return fail('limit', 'must be a non-negative number or null.');
  }
  if (!isNonNegativeNumber(value.used)) return fail('used', 'must be a non-negative number.');
  const progress = value.progress;
  if (!isRecord(progress)) return fail('progress', 'must be an object.');
  for (const field of ['turnsCompleted', 'toolCallsExecuted'] as const) {
    if (!isNonNegativeInteger(progress[field])) return fail(`progress.${field}`, 'must be a non-negative integer.');
  }
  if (!isNonNegativeNumber(progress.wallClockMs)) return fail('progress.wallClockMs', 'must be a non-negative number.');
  for (const field of ['mutationFailures', 'providerErrorRetries'] as const) {
    if (progress[field] !== undefined && !isNonNegativeInteger(progress[field])) {
      return fail(`progress.${field}`, 'must be a non-negative integer when present.');
    }
  }
  if (progress.providerWaitMs !== undefined && !isNonNegativeNumber(progress.providerWaitMs)) {
    return fail('progress.providerWaitMs', 'must be a non-negative number when present.');
  }
  if (progress.interruptedRequest !== undefined && typeof progress.interruptedRequest !== 'boolean') {
    return fail('progress.interruptedRequest', 'must be a boolean when present.');
  }
  return { ok: true, value: value as unknown as BudgetExhaustedFact };
}

/** Parse a fact from untrusted input (CLI flag, abort artifact); `null` when absent or invalid. */
export function parseBudgetExhaustedFact(value: unknown): BudgetExhaustedFact | null {
  let candidate = value;
  if (typeof candidate === 'string') {
    if (!candidate.trim()) return null;
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  const validation = validateBudgetExhaustedFact(candidate);
  return validation.ok ? validation.value : null;
}
