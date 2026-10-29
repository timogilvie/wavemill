/**
 * Workflow cost metering for the eval entrypoints (HOK-3328): the one path
 * from a finished task's *owned* sessions to the `WorkflowCostOutcome` an eval
 * record persists.
 *
 * 1. Read the task's `.session-ownership.jsonl` (live or archived) — the only
 *    answer to "which sessions belong to this task". Pending Codex refs are
 *    resolved once from their rollouts' launch nonce.
 * 2. Optionally fetch OpenRouter exact charges for the owned native turns
 *    (`exactPricing`; the eval orchestrator opts in, the post-completion hook
 *    does not).
 * 3. Measure the owned session ids with `@hokusai/costs` (`measure.ts`):
 *    `workflowCost` is its cross-harness `totalUsd`, `byHarness` its slices,
 *    and the same report run over each kind group / each session gives the
 *    per-kind and per-session costs. Wavemill prices nothing and picks no
 *    harness.
 *
 * Never throws for a metering problem: a measurement failure is logged and
 * becomes an `adapter_error` outcome, a failed exact-pricing lookup is logged
 * and the turns keep their local estimates. No owned session is `no_sessions`,
 * never `$0`. Cost must never fail an eval.
 *
 * `@hokusai/costs` is imported lazily (`loadMeasure`), so eval entrypoints
 * still load under a stale install and the failure surfaces here instead.
 *
 * @module sdk-task-cost/meter
 */

import { dirname } from 'node:path';
import { resolveCodexLaunchNonces, codexSessionsRoot } from '../codex-rollout-resolver.ts';
import { errorMessage } from '../error-utils.ts';
import { getEffectiveRegistry, resolveModelRegistryKey } from '../model-registry.ts';
import {
  fetchOpenRouterExactCosts,
  isExactPricingEnabled,
  type ExactPricingOptions,
} from '../pricing/openrouter-exact-pricing.ts';
import type { PricingTable } from '../pricing/model-pricing.ts';
import { NativeSessionAdapter, type NativeSessionUsageRecord } from '../session-adapters.ts';
import {
  appendSessionRefResolution,
  exactRows,
  groupByKind,
  locateOwnershipRows,
  type SessionOwnershipRow,
} from '../session-ownership.ts';
import { resolveProjectsDirs } from '../wavemill-session-paths.ts';
import type { WorkflowCostFailure, WorkflowCostOutcome } from '../workflow-cost.ts';
import type { TaskCostSummaryV1 } from './contract.ts';
import type { MeasureOwnedSessionsInput } from './measure.ts';
import { projectReportToWorkflowCost, reportCostUsd } from './project.ts';

type MeasureModule = Pick<typeof import('./measure.ts'), 'measureOwnedSessions' | 'pricingUsedFor'>;
type PriceOverrideModule = Pick<typeof import('./price-overrides.ts'), 'buildHostPriceOverrides'>;

export type WorkflowCostMeterReason =
  /** The SDK measured the owned sessions: its report is the outcome. */
  | 'sdk_report'
  /** No launch row names a session, or the owned sessions left no usage. */
  | 'no_owned_sessions'
  /** Measurement threw (stale SDK, unreadable record, contract violation). */
  | 'collection_failed';

export interface MeterWorkflowCostInput {
  worktreePath: string;
  branchName: string;
  repoDir?: string;
  issueId?: string;
  /** Feature slug; locates the live ownership record (the archive is keyed by issue). */
  slug?: string | null;
  /** Owned sessions; read from the task's ownership record when omitted. */
  ownership?: readonly SessionOwnershipRow[];
  /** Rate table handed to the SDK as price overrides. */
  pricingTable?: PricingTable;
  /** Log prefix, e.g. `Post-completion eval`. */
  label: string;
  /** Opt in to OpenRouter exact charges for native turns. */
  exactPricing?: ExactPricingOptions;
  /** Transcript locations; derived from the rows' cwd / the worktree when omitted. */
  roots?: { claude?: readonly string[]; codex?: readonly string[] };
  /** Native transcript telemetry; scanned from the worktree/repo runs when omitted. */
  nativeSessions?: readonly NativeSessionUsageRecord[];
  /** End of the attribution window (defaults to now). */
  now?: () => Date;
  /** Loads `@hokusai/costs` lazily; injected by tests. */
  loadMeasure?: () => Promise<MeasureModule & PriceOverrideModule>;
  logger?: Pick<Console, 'log' | 'warn'>;
}

/** The SDK's figures for one owned session (copied, never computed). */
export interface OwnedSessionCost {
  totalUsd: number | null;
  actualUsd: number | null;
  estimatedUsd: number | null;
  coverage: 'complete' | 'partial' | 'unavailable' | 'known_zero';
  costSource: 'provider_reported' | 'local_estimate' | 'mixed' | 'none';
  pricingRevision: string | null;
}

export interface MeteredWorkflowCost {
  outcome: WorkflowCostOutcome;
  reason: WorkflowCostMeterReason;
  /** Raw SDK summaries, persisted as `taskCostSummary` evidence. */
  summaries: TaskCostSummaryV1[] | null;
  /** Every owned row (pending Codex refs resolved where possible). */
  owned: SessionOwnershipRow[];
  /** SDK report per owned sessionRef, for `executionEconomics`. */
  sessionCosts: Map<string, OwnedSessionCost>;
}

const defaultLoadMeasure = async (): Promise<MeasureModule & PriceOverrideModule> => {
  const [measure, overrides] = await Promise.all([import('./measure.ts'), import('./price-overrides.ts')]);
  return { ...measure, ...overrides };
};

/** Claude Code project dirs for every cwd an owned claude session ran in. */
function claudeRoots(rows: readonly SessionOwnershipRow[], worktreePath: string): string[] {
  const cwds = new Set(rows.filter((row) => row.harness === 'claude-code').map((row) => row.cwd || worktreePath));
  return [...new Set([...cwds].flatMap((cwd) => resolveProjectsDirs(cwd)))];
}

/**
 * Resolve pending Codex refs from their rollouts and record each resolution
 * once in the record it was read from.
 */
function resolvePendingRefs(
  rows: SessionOwnershipRow[],
  recordFile: string | undefined,
  codexRoots: readonly string[],
  logger: Pick<Console, 'warn'>,
): SessionOwnershipRow[] {
  const resolved = resolveCodexLaunchNonces(rows, codexRoots);
  if (resolved.size === 0) return rows;
  if (recordFile) {
    for (const [pendingRef, threadId] of resolved) {
      try {
        appendSessionRefResolution(dirname(recordFile), pendingRef, threadId);
      } catch (error) {
        logger.warn(`session ownership: codex resolution not recorded — ${errorMessage(error)}`);
      }
    }
  }
  return rows.map((row) => resolved.has(row.sessionRef) ? { ...row, sessionRef: resolved.get(row.sessionRef)! } : row);
}

function ownedNativeSessions(input: MeterWorkflowCostInput, rows: readonly SessionOwnershipRow[]): NativeSessionUsageRecord[] {
  const refs = new Set(rows.filter((row) => row.harness === 'native').map((row) => row.sessionRef));
  if (refs.size === 0) return [];
  const sessions = input.nativeSessions ?? new NativeSessionAdapter().scan({
    worktreePath: input.worktreePath,
    branchName: input.branchName,
    repoDir: input.repoDir,
    issueId: input.issueId,
  })?.nativeSessions ?? [];
  return sessions.filter((session) => refs.has(session.sessionId));
}

async function resolveExactGenerationCosts(
  nativeSessions: readonly NativeSessionUsageRecord[],
  options: ExactPricingOptions | undefined,
  label: string,
  logger: Pick<Console, 'log' | 'warn'>,
): Promise<Map<string, number> | undefined> {
  if (!options || !isExactPricingEnabled(options) || nativeSessions.length === 0) return undefined;
  try {
    return await fetchOpenRouterExactCosts(nativeSessions.flatMap((session) => session.responseIds), { logger, ...options });
  } catch (error) {
    logger.warn(`${label}: OpenRouter exact pricing skipped — ${errorMessage(error)}`);
    return undefined;
  }
}

function failure(
  status: WorkflowCostFailure['status'],
  reason: string,
  input: MeterWorkflowCostInput,
  extra: Partial<WorkflowCostFailure['diagnostics']> = {},
): WorkflowCostFailure {
  return {
    status,
    reason,
    diagnostics: { worktreePath: input.worktreePath, branchName: input.branchName, ...extra },
  };
}

export async function meterWorkflowCost(input: MeterWorkflowCostInput): Promise<MeteredWorkflowCost> {
  const logger = input.logger ?? console;
  const empty = { summaries: null, sessionCosts: new Map<string, OwnedSessionCost>() };

  let owned: SessionOwnershipRow[];
  let recordFile: string | undefined;
  const codexRoots = [...(input.roots?.codex ?? [codexSessionsRoot()])];
  try {
    if (input.ownership) {
      owned = [...input.ownership];
    } else {
      const located = locateOwnershipRows({
        repoDir: input.repoDir,
        issueId: input.issueId,
        slug: input.slug,
        worktreePath: input.worktreePath,
      });
      owned = located.rows;
      recordFile = located.files[0];
      if (located.malformedLines > 0) {
        logger.warn(`${input.label}: session ownership — skipped ${located.malformedLines} malformed line(s)`);
      }
    }
    owned = resolvePendingRefs(owned, recordFile, codexRoots, logger);
  } catch (error) {
    const message = errorMessage(error);
    logger.warn(`${input.label}: session ownership unreadable — ${message}`);
    return { ...empty, owned: [], outcome: failure('adapter_error', `Session ownership unreadable: ${message}`, input), reason: 'collection_failed' };
  }

  const measured = exactRows(owned);
  const pending = owned.length - measured.length;
  if (pending > 0) {
    logger.warn(`${input.label}: ${pending} owned Codex session(s) never resolved to a thread id; not costed`);
  }
  if (measured.length === 0) {
    return {
      ...empty,
      owned,
      outcome: failure('no_sessions', 'No session-ownership row names a session for this task', input, {
        sessionFilesFound: 0,
        matchingTurns: 0,
      }),
      reason: 'no_owned_sessions',
    };
  }

  try {
    const sdk = await (input.loadMeasure ?? defaultLoadMeasure)();
    const nativeSessions = ownedNativeSessions(input, measured);
    const exactGenerationCosts = await resolveExactGenerationCosts(nativeSessions, input.exactPricing, input.label, logger);
    const registry = getEffectiveRegistry(input.repoDir);
    const endedAt = (input.now?.() ?? new Date()).toISOString();
    const startedAt = measured.map((row) => row.launchedAt).sort()[0];
    const base: Omit<MeasureOwnedSessionsInput, 'rows'> = {
      taskId: input.issueId ?? 'unknown-task',
      claudeRoots: [...(input.roots?.claude ?? claudeRoots(measured, input.worktreePath))],
      codexRoots,
      nativeSessions,
      priceOverrides: sdk.buildHostPriceOverrides(input.pricingTable),
      window: { startedAt, endedAt },
      ...(exactGenerationCosts && exactGenerationCosts.size > 0 ? { exactGenerationCosts } : {}),
      registryLookup: (modelId) => resolveModelRegistryKey(registry, modelId),
    };

    const report = await sdk.measureOwnedSessions({ ...base, rows: measured });
    if (report.eventCount === 0) {
      return {
        ...empty,
        owned,
        outcome: failure('no_sessions', `${measured.length} owned session(s) left no usage on disk`, input, {
          sessionFilesFound: report.source.sessionFileCount,
          matchingTurns: 0,
        }),
        reason: 'no_owned_sessions',
      };
    }

    const byKind: Record<string, number | null> = {};
    for (const [kind, rows] of groupByKind(measured)) {
      byKind[kind] = (await sdk.measureOwnedSessions({ ...base, rows })).totalUsd;
    }
    const sessionCosts = new Map<string, OwnedSessionCost>();
    for (const row of measured) {
      const session = await sdk.measureOwnedSessions({ ...base, rows: [row] });
      if (session.eventCount === 0) continue;
      sessionCosts.set(row.sessionRef, {
        totalUsd: session.totalUsd,
        actualUsd: session.actualUsd,
        estimatedUsd: session.estimatedUsd,
        coverage: session.coverage.status,
        costSource: session.source.cost,
        pricingRevision: session.pricing.revision,
      });
    }

    const outcome = { ...projectReportToWorkflowCost(report, sdk.pricingUsedFor(report, input.pricingTable)), byKind };
    const harnesses = Object.entries(outcome.byHarness ?? {})
      .map(([harness, usd]) => `${harness}: ${usd === null ? 'unresolved' : `$${usd.toFixed(4)}`}`)
      .join('; ');
    logger.log(`${input.label}: @hokusai/costs total $${reportCostUsd(report).toFixed(4)} over ${measured.length} owned session(s) (${harnesses}; coverage ${report.coverage.status})`);
    return { outcome, reason: 'sdk_report', summaries: [...report.summaries], owned, sessionCosts };
  } catch (error) {
    const message = errorMessage(error);
    logger.warn(`${input.label}: @hokusai/costs measurement failed — ${message}`);
    return {
      ...empty,
      owned,
      outcome: failure('adapter_error', `@hokusai/costs measurement failed: ${message}`, input),
      reason: 'collection_failed',
    };
  }
}
