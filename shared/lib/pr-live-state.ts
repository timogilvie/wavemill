/**
 * PR live state prober - extracted from tend-controller.ts for reuse.
 * Probes GitHub for current PR state (mergeability, checks, etc.) to support
 * both blocked PR validation and merge label reconciliation.
 */

import { execShellCommand } from './shell-utils.ts';

const GH_COMMAND_TIMEOUT_MS = 120_000;
const FAILING_CHECK_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled']);
const PASSING_CHECK_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

/**
 * Live GitHub truth for a PR, read from `gh pr view`. `available: false` means
 * the probe failed — callers must treat that as "gate unverifiable", never as
 * evidence in either direction.
 */
export interface PrLiveState {
  available: boolean;
  mergeable?: string;
  mergeStateStatus?: string;
  failingChecks?: string[];
  pendingChecks?: string[];
  /**
   * Full statusCheckRollup array from GitHub, with conclusion/status/name fields.
   * Used by merge label derivation to distinguish pending vs failed checks.
   */
  statusCheckRollup?: Array<{ name: string; conclusion: string; status: string }>;
}

export async function probePrLiveState(prNumber: number, repoDir: string): Promise<PrLiveState> {
  try {
    const output = String(execShellCommand(
      `gh pr view ${prNumber} --json mergeable,mergeStateStatus,statusCheckRollup`,
      { encoding: 'utf-8', cwd: repoDir, timeout: GH_COMMAND_TIMEOUT_MS },
    ));
    const parsed = JSON.parse(output) as unknown;
    if (!isRecord(parsed)) {
      return { available: false };
    }

    const rollup = extractStatusCheckRollupEntries(parsed.statusCheckRollup);

    return {
      available: true,
      mergeable: typeof parsed.mergeable === 'string' ? parsed.mergeable : undefined,
      mergeStateStatus: typeof parsed.mergeStateStatus === 'string' ? parsed.mergeStateStatus : undefined,
      failingChecks: failingRollupCheckNames(rollup),
      pendingChecks: pendingRollupCheckNames(rollup),
      statusCheckRollup: rollup.map((entry) => ({
        name: stringField(entry, 'name') ?? stringField(entry, 'context') ?? 'check',
        conclusion: stringField(entry, 'conclusion') ?? '',
        status: stringField(entry, 'status') ?? '',
      })),
    };
  } catch {
    return { available: false };
  }
}

function failingRollupCheckNames(rollup: Array<Record<string, unknown>>): string[] {
  return rollup
    .filter((entry) => {
      const conclusion = (stringField(entry, 'conclusion') ?? '').toLowerCase();
      const status = (stringField(entry, 'status') ?? '').toLowerCase();
      return FAILING_CHECK_CONCLUSIONS.has(conclusion) || FAILING_CHECK_CONCLUSIONS.has(status);
    })
    .map((entry) => stringField(entry, 'name') ?? stringField(entry, 'context') ?? 'check');
}

function pendingRollupCheckNames(rollup: Array<Record<string, unknown>>): string[] {
  return rollup
    .filter((entry) => {
      const conclusion = (stringField(entry, 'conclusion') ?? '').toLowerCase();
      const status = (stringField(entry, 'status') ?? '').toLowerCase();
      if (FAILING_CHECK_CONCLUSIONS.has(conclusion) || FAILING_CHECK_CONCLUSIONS.has(status)) {
        return false;
      }
      if (PASSING_CHECK_CONCLUSIONS.has(conclusion) || PASSING_CHECK_CONCLUSIONS.has(status)) {
        return false;
      }
      return true;
    })
    .map((entry) => stringField(entry, 'name') ?? stringField(entry, 'context') ?? 'check');
}

function extractStatusCheckRollupEntries(rollup: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(rollup)) {
    return rollup.filter(isRecord);
  }
  if (!isRecord(rollup)) {
    return [];
  }
  if (Array.isArray(rollup.nodes)) {
    return rollup.nodes.filter(isRecord);
  }
  if (Array.isArray(rollup.contexts)) {
    return rollup.contexts.filter(isRecord);
  }
  if (isRecord(rollup.nodes) && Array.isArray(rollup.nodes.nodes)) {
    return rollup.nodes.nodes.filter(isRecord);
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}

export function isLiveStateCleanGreen(live: PrLiveState): boolean {
  return live.available
    && (live.mergeable ?? '').toUpperCase() === 'MERGEABLE'
    && (live.mergeStateStatus ?? '').toUpperCase() === 'CLEAN'
    && (live.failingChecks?.length ?? 0) === 0
    && (live.pendingChecks?.length ?? 0) === 0;
}
