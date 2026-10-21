/**
 * Repair for eval records costed with the cross-task native session pool
 * (HOK-3256).
 *
 * From 2026-08-14 until HOK-3256, `matchesIssue` could not attribute
 * `expansion-expansion-<ISSUE>-<timestamp>.jsonl` transcripts, so every task's
 * native scan absorbed every other task's expansion session. The stored
 * `workflowCost` is the size of that growing pool (20 → 200+ sessions), not
 * the task's own spend. Before the bug no task exceeded 8 native sessions.
 */

import type { EvalRecord } from './eval-schema.ts';

/** Native session count from which a stored cost is the shared pool, not one task's. */
export const POOLED_COST_MIN_SESSIONS = 20;

/** A successful recomputation of a record's workflow cost. */
export interface RecomputedWorkflowCost {
  cost: number;
  tokenUsage: EvalRecord['workflowTokenUsage'];
  attribution?: EvalRecord['workflowCostAttribution'];
}

/**
 * Whether the record's stored workflow cost came from the cross-task native
 * session pool. Records already repaired or marked never match, so the
 * backfill is idempotent.
 */
export function isPooledWorkflowCost(
  record: EvalRecord,
  minSessions: number = POOLED_COST_MIN_SESSIONS,
): boolean {
  const attribution = record.workflowCostAttribution;
  return record.workflowCostStatus === 'success'
    && attribution?.source === 'native'
    && attribution.sessions >= minSessions;
}

/**
 * Replace a pooled cost with its recomputation, or — when the record lacks the
 * worktree/branch needed to recompute — mark it `unreliable` and drop the
 * cost fields so no consumer (router training, dashboards, challenge
 * analysis) keeps reading the pool total. The dropped figure is kept in the
 * diagnostics reason for audit.
 */
export function repairPooledWorkflowCost(
  record: EvalRecord,
  recomputed: RecomputedWorkflowCost | null,
  unrecoverableReason: string,
): EvalRecord {
  if (recomputed) {
    const repaired: EvalRecord = {
      ...record,
      workflowCost: recomputed.cost,
      workflowTokenUsage: recomputed.tokenUsage,
      workflowCostStatus: 'success',
    };
    if (recomputed.attribution) {
      repaired.workflowCostAttribution = recomputed.attribution;
    } else {
      delete repaired.workflowCostAttribution;
    }
    return repaired;
  }

  const attribution = record.workflowCostAttribution;
  const pooledCost = typeof record.workflowCost === 'number' ? `$${record.workflowCost.toFixed(4)}` : 'unknown cost';
  const {
    workflowCost: _cost,
    workflowTokenUsage: _usage,
    workflowCostAttribution: _attribution,
    ...rest
  } = record;
  return {
    ...rest,
    workflowCostStatus: 'unreliable',
    workflowCostDiagnostics: {
      reason: `HOK-3256 cross-task session pool (${pooledCost} across ${attribution?.sessions ?? '?'} native sessions); `
        + `not recomputable: ${unrecoverableReason}`,
      ...(record.agentType ? { agentType: record.agentType } : {}),
      ...(attribution ? { sessionFilesFound: attribution.sessions } : {}),
    },
  };
}
