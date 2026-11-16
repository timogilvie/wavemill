/**
 * The `@hokusai/costs` measurement call over a task's owned sessions
 * (HOK-3328). Capture, pricing and the cross-harness report are the SDK's;
 * this module only says *which* sessions to measure — exactly the ids the
 * launch rows in `.session-ownership.jsonl` name — and where their files are.
 *
 * - Claude Code: `sessionFiles` capture (explicit harness, session ids, roots,
 *   and the task's lifetime as the window).
 * - Codex: the SDK's own Codex source (`@hokusai/costs/sources/codex` over
 *   `sources/node-fs`) under the same explicit boundary, fed as events —
 *   `measureTask` takes one `sessionFiles` harness per run.
 * - Native: one `recordUsage` per transcript turn; OpenRouter's billed charge
 *   (`exactGenerations`) or a trustworthy provider-reported charge is the
 *   event's `providerCostUsd`.
 * - Rates: Wavemill's registry table as `priceOverrides`.
 *
 * Value-imports `@hokusai/costs`: reach it through `meter.ts`, which loads it
 * lazily so eval entrypoints still load under a stale install.
 *
 * @module sdk-task-cost/measure
 */

import { measureTask, type HostPriceOverride, type IngestUsageInput, type TaskCostReport, type TaskUsageRecord } from '@hokusai/costs';
import { extractClaudeCodeUsage } from '@hokusai/costs/sources/claude-code';
import { extractCodexUsage } from '@hokusai/costs/sources/codex';
import { readSessionFiles, type TaskCostSourceDiagnostics } from '@hokusai/costs/sources/node-fs';
import { normalizeModelId, resolveModelPrice } from '@hokusai/core';
import { nativeSessionObservations, nativeTurnUsage, type NativeSessionUsageRecord } from '../session-adapters.ts';
import type { OpenRouterGenerationCost } from '../pricing/openrouter-exact-pricing.ts';
import type { SessionOwnershipRow } from '../session-ownership.ts';
import type { WorkflowCostResult } from '../workflow-cost.ts';

export { toSdkId } from './ids.ts';
import { toSdkId } from './ids.ts';

export interface MeasureOwnedSessionsInput {
  /** Wavemill task / issue id (mapped onto the SDK id alphabet). */
  taskId: string;
  /** Exact owned rows to measure (pending Codex rows are the caller's to drop). */
  rows: readonly SessionOwnershipRow[];
  /** Directories holding Claude Code transcripts for the owned sessions. */
  claudeRoots: readonly string[];
  /** Directories holding Codex rollouts. */
  codexRoots: readonly string[];
  /** Native transcript telemetry; only sessions the rows name are measured. */
  nativeSessions: readonly NativeSessionUsageRecord[];
  priceOverrides: readonly HostPriceOverride[];
  /** Inclusive attribution window: the task's lifetime. */
  window: { startedAt: string; endedAt: string };
  /** OpenRouter observed metadata and billed charge per native response id. */
  exactGenerations?: ReadonlyMap<string, OpenRouterGenerationCost>;
  /** Canonical registry id for a native model id (identity when unknown). */
  registryLookup?: (modelId: string) => string;
}

function finiteNonNegative(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The charge a native turn reports, when it is evidence: an OpenRouter exact
 * charge always; a provider-reported figure when it is non-zero, or when the
 * SDK has no rate to estimate from (a provider that omits cost reports 0, so
 * a zero only counts when nothing better exists).
 */
function nativeProviderCost(
  turn: { responseId?: string; providerReportedCostUsd?: number; usageAvailable: boolean },
  model: string,
  input: MeasureOwnedSessionsInput,
  transport: string,
): number | undefined {
  const exact = transport === 'openrouter' && turn.responseId
    ? finiteNonNegative(input.exactGenerations?.get(turn.responseId)?.totalCostUsd) : null;
  if (exact !== null) return exact;
  const reported = finiteNonNegative(turn.providerReportedCostUsd);
  if (reported === null) return undefined;
  if (reported > 0 || !turn.usageAvailable) return reported;
  const normalized = normalizeModelId(model);
  const priceable = input.priceOverrides.some((override) => normalizeModelId(override.model) === normalized)
    || resolveModelPrice(model) !== undefined;
  return priceable ? undefined : reported;
}

/**
 * One `recordUsage` per native transcript turn (session totals when
 * turn-less), for the native sessions the measured rows name.
 */
export function nativeUsageRecords(input: MeasureOwnedSessionsInput): TaskUsageRecord[] {
  const measured = new Set(sessionIdsFor(input.rows, 'native'));
  const records: TaskUsageRecord[] = [];
  for (const { session, turn, observationId } of nativeSessionObservations(input.nativeSessions.filter(session => measured.has(session.sessionId)))) {
    const model = toSdkId(input.registryLookup?.(session.modelId) ?? session.modelId, 'unknown');
    const sessionId = toSdkId(session.sessionId);
    const responseId = turn.responseId;
    const usage = nativeTurnUsage(turn);
    const providerCostUsd = nativeProviderCost(turn, model, input, session.provider);
    records.push({
      harness: 'native',
      model,
      usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_tokens, cacheWriteTokens: usage.cache_write_tokens,
        reasoningTokens: usage.reasoning_tokens },
      ...(providerCostUsd !== undefined ? { providerCostUsd } : {}),
      costBasis: 'per_token_api',
      sessionId,
      eventId: observationId,
      ...(responseId ? { turnId: toSdkId(responseId) } : {}),
    });
  }
  return records;
}

function sessionIdsFor(rows: readonly SessionOwnershipRow[], harness: SessionOwnershipRow['harness']): string[] {
  return [...new Set(rows.filter((row) => row.harness === harness).map((row) => row.sessionRef))];
}

/** Codex rollouts for the owned thread ids, through the SDK's own Codex source. */
function codexInputs(taskId: string, sessionIds: readonly string[], input: MeasureOwnedSessionsInput): IngestUsageInput[] {
  if (sessionIds.length === 0 || input.codexRoots.length === 0) return [];
  const read = readSessionFiles({ roots: input.codexRoots, sessionIds });
  const extracted = extractCodexUsage({
    boundary: {
      boundaryVersion: 1,
      taskId,
      sessionIds,
      startedAt: input.window.startedAt,
      endedAt: input.window.endedAt,
    },
    files: read.files.map((file) => file.content),
  });
  return [...extracted.inputs];
}

/** Claude Code transcript rows for the owned session ids, through the SDK's own source. */
function claudeInputs(taskId: string, sessionIds: readonly string[], input: MeasureOwnedSessionsInput): IngestUsageInput[] {
  if (sessionIds.length === 0 || input.claudeRoots.length === 0) return [];
  const read = readSessionFiles({ roots: input.claudeRoots, sessionIds });
  const extracted = extractClaudeCodeUsage({
    boundary: {
      boundaryVersion: 1,
      taskId,
      sessionIds,
      startedAt: input.window.startedAt,
      endedAt: input.window.endedAt,
    },
    files: read.files.map((file) => file.content),
  });
  return [...extracted.inputs];
}

/**
 * Per-session SDK usage rows for one task's owned Claude Code and Codex
 * sessions (HOK-3407). The SDK's sources dedupe (`eventKey`) and normalize
 * Codex buckets (`normalizeCodexBuckets`); the rows returned here have the
 * correct, disjoint token counts by construction.
 *
 * Executes the same `readSessionFiles` + `extract*Usage` passes the metering
 * call makes under the hood, so downstream readers (execution-economics,
 * executed-model-resolver) never re-parse the transcript bytes.
 *
 * Returns empty maps when the owned sessions resolve to nothing on disk;
 * diagnostics are merged across harnesses.
 */
export interface OwnedSessionUsageRows {
  claude: Map<string, IngestUsageInput[]>;
  codex: Map<string, IngestUsageInput[]>;
  diagnostics: TaskCostSourceDiagnostics;
}

export function extractOwnedSessionUsageRows(input: MeasureOwnedSessionsInput): OwnedSessionUsageRows {
  const taskId = toSdkId(input.taskId, 'unknown-task');
  const claudeIds = sessionIdsFor(input.rows, 'claude-code');
  const codexIds = sessionIdsFor(input.rows, 'codex');
  const claudeRows = claudeInputs(taskId, claudeIds, input);
  const codexRows = codexInputs(taskId, codexIds, input);
  const claude = groupBySessionId(claudeRows);
  const codex = groupBySessionId(codexRows);
  // Diagnostics are not currently surfaced upstream — kept as an empty bag
  // so the return shape is complete for future plumbing without a schema
  // change.
  return { claude, codex, diagnostics: {} };
}

function groupBySessionId(rows: readonly IngestUsageInput[]): Map<string, IngestUsageInput[]> {
  const grouped = new Map<string, IngestUsageInput[]>();
  for (const row of rows) {
    const existing = grouped.get(row.sessionId);
    if (existing) existing.push(row);
    else grouped.set(row.sessionId, [row]);
  }
  return grouped;
}

/**
 * Measure the given owned sessions with `@hokusai/costs` and return its
 * report. `totalUsd` is the SDK's cross-harness total; `byHarness`,
 * `byModel` and `summaries` are its breakdowns.
 */
export async function measureOwnedSessions(input: MeasureOwnedSessionsInput): Promise<TaskCostReport> {
  const taskId = toSdkId(input.taskId, 'unknown-task');
  const claudeIds = sessionIdsFor(input.rows, 'claude-code');
  const codexIds = sessionIdsFor(input.rows, 'codex');
  // Claude Code takes the one `sessionFiles` slot; when there is none, Codex does.
  const fileHarness = claudeIds.length > 0 && input.claudeRoots.length > 0
    ? { harness: 'claude-code' as const, sessionIds: claudeIds, roots: input.claudeRoots }
    : codexIds.length > 0 && input.codexRoots.length > 0
      ? { harness: 'codex' as const, sessionIds: codexIds, roots: input.codexRoots }
      : null;
  const events: unknown[] = [
    ...(fileHarness?.harness === 'claude-code' ? codexInputs(taskId, codexIds, input) : []),
    ...nativeUsageRecords(input),
  ];

  const { cost } = await measureTask({
    taskId,
    priceOverrides: input.priceOverrides,
    ...(fileHarness ? { sessionFiles: { ...fileHarness, window: input.window } } : {}),
    ...(events.length > 0 ? { events } : {}),
  }, async () => undefined);
  return cost;
}

/**
 * The rate entries the report's locally-estimated models were priced from:
 * the caller's table rows whose ids normalize to those models. A lookup for
 * the persisted `pricingSnapshot`, never a re-pricing.
 */
export function pricingUsedFor(
  report: TaskCostReport,
  pricingTable: WorkflowCostResult['pricingUsed'] | null | undefined,
): WorkflowCostResult['pricingUsed'] {
  const used: WorkflowCostResult['pricingUsed'] = {};
  if (!pricingTable) return used;
  const byNormalized = new Map(Object.entries(pricingTable).map(([model, pricing]) => [normalizeModelId(model), pricing]));
  for (const [model, breakdown] of Object.entries(report.byModel)) {
    if (breakdown.estimatedUsd === null) continue;
    const pricing = pricingTable[model] ?? byNormalized.get(normalizeModelId(model));
    if (pricing) used[model] = pricing;
  }
  return used;
}

/** Reprice retained provider facts through the same SDK bridge, never a private cost reducer. */
export async function measureProviderExecutionEvidence(input: {
  taskId: string;
  observations: readonly import('@hokusai/core').NativeProviderExecution[];
  collectedAt?: string;
  priceOverrides: readonly HostPriceOverride[];
  registryLookup?: (model: string) => string | undefined;
}) {
  const collectedAt = input.collectedAt ?? new Date().toISOString();
  const groups = new Map<string, NativeSessionUsageRecord>();
  const rows: SessionOwnershipRow[] = [];
  const exactGenerations = new Map<string, OpenRouterGenerationCost>();
  for (const observation of input.observations) {
    const model = observation.responseModel ?? observation.requestedModel ?? 'unknown';
    const key = JSON.stringify([observation.sessionRef, observation.transport, model]);
    let session = groups.get(key);
    if (!session) {
      session = { sessionId: observation.sessionRef, filePath: 'retained-provider-evidence.jsonl', provider: observation.transport,
        modelId: model, requestedModel: observation.requestedModel ?? undefined, turns: [], responseIds: [], turnCount: 0,
        usageAvailable: false, invalidUsage: false };
      groups.set(key, session);
      rows.push({ sessionRef: observation.sessionRef, model, harness: 'native', kind: 'coding', stage: 'coding', attemptId: observation.ownershipAttemptIds[0] ?? observation.sessionRef, launchedAt: collectedAt });
    }
    const usage = observation.usage;
    const usageAvailable = usage?.input_tokens != null && usage?.output_tokens != null;
    session.turns.push({ responseId: observation.responseId ?? undefined, responseModel: observation.responseModel ?? undefined,
      inputTokens: usage?.input_tokens ?? undefined, outputTokens: usage?.output_tokens ?? undefined,
      cacheReadTokens: usage?.cache_read_tokens ?? undefined, cacheCreationTokens: usage?.cache_write_tokens ?? undefined,
      usageAvailable, invalidUsage: false });
    session.usageAvailable ||= usageAvailable;
    session.turnCount++;
    if (observation.responseId) {
      session.responseIds.push(observation.responseId);
      if (observation.generation) exactGenerations.set(observation.responseId, observation.generation);
    }
  }
  return measureOwnedSessions({ taskId: input.taskId, rows, nativeSessions: [...groups.values()], claudeRoots: [], codexRoots: [],
    priceOverrides: input.priceOverrides, registryLookup: input.registryLookup, exactGenerations,
    window: { startedAt: collectedAt, endedAt: collectedAt } });
}
