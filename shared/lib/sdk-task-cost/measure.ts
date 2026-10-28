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
 *   (`exactGenerationCosts`) or a trustworthy provider-reported charge is the
 *   event's `providerCostUsd`.
 * - Rates: Wavemill's registry table as `priceOverrides`.
 *
 * Value-imports `@hokusai/costs`: reach it through `meter.ts`, which loads it
 * lazily so eval entrypoints still load under a stale install.
 *
 * @module sdk-task-cost/measure
 */

import { createHash } from 'node:crypto';
import { measureTask, type HostPriceOverride, type TaskCostReport, type TaskUsageRecord } from '@hokusai/costs';
import { extractCodexUsage } from '@hokusai/costs/sources/codex';
import { readSessionFiles } from '@hokusai/costs/sources/node-fs';
import { normalizeModelId, resolveModelPrice } from '@hokusai/core';
import type { NativeSessionUsageRecord } from '../session-adapters.ts';
import type { SessionOwnershipRow } from '../session-ownership.ts';
import type { WorkflowCostResult } from '../workflow-cost.ts';

// The SDK contract's id pattern (validators); ids that do not satisfy it are
// pseudonymized so a native session id with `_` or a path never reaches the
// ledger raw.
const SDK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Map a raw id onto the SDK contract's id alphabet (stable across runs). */
export function toSdkId(raw: string | null | undefined, fallback = 'unknown'): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return fallback;
  if (SDK_ID_PATTERN.test(value)) return value;
  if (!/[\\/]/.test(value)) {
    const slug = value.replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '');
    if (SDK_ID_PATTERN.test(slug)) return slug;
  }
  return `h-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

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
  /** OpenRouter billed charge per native response id. */
  exactGenerationCosts?: ReadonlyMap<string, number>;
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
): number | undefined {
  const exact = turn.responseId ? finiteNonNegative(input.exactGenerationCosts?.get(turn.responseId)) : null;
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
  for (const session of input.nativeSessions) {
    if (!measured.has(session.sessionId)) continue;
    const model = toSdkId(input.registryLookup?.(session.modelId) ?? session.modelId, 'unknown');
    const sessionId = toSdkId(session.sessionId);
    const observations = session.turns.length > 0 ? session.turns : [session];
    observations.forEach((turn, index) => {
      const usable = turn.usageAvailable && !turn.invalidUsage;
      const providerCostUsd = nativeProviderCost(turn, model, input);
      const responseId = 'responseId' in turn ? turn.responseId : undefined;
      records.push({
        harness: 'native',
        model,
        usage: usable
          ? {
            inputTokens: turn.inputTokens ?? null,
            outputTokens: turn.outputTokens ?? null,
            cacheReadTokens: turn.cacheReadTokens ?? null,
            cacheWriteTokens: turn.cacheCreationTokens ?? null,
            reasoningTokens: null,
          }
          : {},
        ...(providerCostUsd !== undefined ? { providerCostUsd } : {}),
        costBasis: 'per_token_api',
        sessionId,
        eventId: toSdkId(`${session.sessionId}:${session.provider}:${session.modelId}:${index}`),
        ...(responseId ? { turnId: toSdkId(responseId) } : {}),
      });
    });
  }
  return records;
}

function sessionIdsFor(rows: readonly SessionOwnershipRow[], harness: SessionOwnershipRow['harness']): string[] {
  return [...new Set(rows.filter((row) => row.harness === harness).map((row) => row.sessionRef))];
}

/** Codex rollouts for the owned thread ids, through the SDK's own Codex source. */
function codexInputs(taskId: string, sessionIds: readonly string[], input: MeasureOwnedSessionsInput): unknown[] {
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
