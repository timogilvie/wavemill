/**
 * SDK task-cost collection (HOK-3075): scan a workflow's sessions with the
 * existing Wavemill adapters, convert them to `TaskCostEventV1` events, and
 * reduce each harness's events with the SDK's `aggregateTaskCost`.
 *
 * Wavemill-specific joins stay local: sessions are joined to the task by the
 * adapters (branch/worktree, plus issue id for native transcripts), and the
 * stage-window / route / PR joins remain on `executionEconomics` and the eval
 * record itself. The SDK summary carries no branch, path, or route data.
 *
 * This is the only workflow/eval cost engine (HOK-3076 made it authoritative,
 * HOK-3077 retired the legacy one); eval entrypoints reach it through
 * `meter.ts`.
 *
 * @module sdk-task-cost/collect
 */

import { getEffectiveRegistry, resolveModelRegistryKey } from '../model-registry.ts';
import {
  ClaudeSessionAdapter,
  CodexSessionAdapter,
  NativeSessionAdapter,
  type SessionScanOptions,
  type SessionUsageResult,
} from '../session-adapters.ts';
import { loadPricingTable, type PricingTable } from '../pricing/model-pricing.ts';
import {
  aggregateTaskCost,
  validateTaskCostSummaryV1,
  type TaskCostEventV1,
  type TaskCostSummaryV1,
} from './contract.ts';
import { eventsFromScanResult, scanResultHarness, toTaskCostId } from './events-from-session.ts';

/** Summary order: native first, as `selectPrimaryTaskCostSummary` prefers it. */
const HARNESS_ORDER = ['native', 'claude-code', 'codex'] as const;

export interface BuildSdkTaskCostSummariesInput {
  /** Adapter scan results (native, Claude Code, Codex); null entries are skipped. */
  scanResults: Array<SessionUsageResult | null | undefined>;
  /** Wavemill task / issue id the sessions were joined to. */
  taskId: string | null | undefined;
  /** Pricing table; loaded from `repoDir` when omitted or empty. */
  pricingTable?: PricingTable;
  repoDir?: string;
  /** Price-table revision label for priced events, when the caller has one. */
  pricingRevision?: string | null;
  /** OpenRouter billed charge per native response id; see `TaskCostEventContext`. */
  exactGenerationCosts?: ReadonlyMap<string, number>;
  now?: () => Date;
}

export interface CollectSdkTaskCostSummariesInput {
  worktreePath: string;
  branchName: string;
  repoDir?: string;
  issueId?: string;
  pricingTable?: PricingTable;
  pricingRevision?: string | null;
  exactGenerationCosts?: ReadonlyMap<string, number>;
  now?: () => Date;
}

/**
 * Build one SDK `TaskCostSummaryV1` per harness that produced sessions.
 *
 * Returns `null` when no session produced an event, so callers can treat
 * "no evidence" as "attach nothing". Throws `TaskCostValidationError` when an
 * event or summary violates the SDK contract — that is a bridge bug; the
 * metering runner logs it and records the cost as `adapter_error`.
 */
export function buildSdkTaskCostSummaries(input: BuildSdkTaskCostSummariesInput): TaskCostSummaryV1[] | null {
  const pricingTable = input.pricingTable && Object.keys(input.pricingTable).length > 0
    ? input.pricingTable
    : loadPricingTable(input.repoDir);
  const registry = getEffectiveRegistry(input.repoDir);
  const collectedAt = (input.now?.() ?? new Date()).toISOString();
  const ctx = {
    taskId: toTaskCostId(input.taskId, 'unknown-task'),
    pricingTable,
    registryLookup: (modelId: string) => resolveModelRegistryKey(registry, modelId),
    pricingRevision: input.pricingRevision,
    observedAtFallback: collectedAt,
    exactGenerationCosts: input.exactGenerationCosts,
  };

  const eventsByHarness = new Map<string, TaskCostEventV1[]>();
  for (const scan of input.scanResults) {
    if (!scan) continue;
    const harness = scanResultHarness(scan);
    if (!harness) continue;
    const events = eventsFromScanResult(scan, ctx);
    if (events.length === 0) continue;
    eventsByHarness.set(harness, [...(eventsByHarness.get(harness) ?? []), ...events]);
  }

  const summaries: TaskCostSummaryV1[] = [];
  for (const harness of HARNESS_ORDER) {
    const events = eventsByHarness.get(harness);
    if (!events) continue;
    const summary = aggregateTaskCost(events, {
      taskId: ctx.taskId,
      collectedAt,
      joinConfidence: 'branch_worktree',
    });
    // Defensive: the reducer's output is the wire record we persist.
    validateTaskCostSummaryV1(summary);
    summaries.push(summary);
  }
  return summaries.length > 0 ? summaries : null;
}

/**
 * Scan native, Claude Code and Codex sessions for a completed workflow and
 * summarize them with the SDK. Every harness is scanned; the projection
 * picks the primary one (`selectPrimaryTaskCostSummary`).
 */
export function collectSdkTaskCostSummaries(input: CollectSdkTaskCostSummariesInput): TaskCostSummaryV1[] | null {
  const scanOpts: SessionScanOptions = {
    worktreePath: input.worktreePath,
    branchName: input.branchName,
    repoDir: input.repoDir,
    issueId: input.issueId,
  };
  return buildSdkTaskCostSummaries({
    scanResults: [
      new NativeSessionAdapter().scan(scanOpts),
      new ClaudeSessionAdapter().scan(scanOpts),
      new CodexSessionAdapter().scan(scanOpts),
    ],
    taskId: input.issueId,
    pricingTable: input.pricingTable,
    repoDir: input.repoDir,
    pricingRevision: input.pricingRevision,
    exactGenerationCosts: input.exactGenerationCosts,
    now: input.now,
  });
}
