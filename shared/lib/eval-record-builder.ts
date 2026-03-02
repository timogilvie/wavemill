/**
 * Eval record builder — attach metadata to eval records.
 *
 * Provides functions to enrich eval records with:
 * - Difficulty analysis results
 * - Task context analysis results
 * - Repo context analysis results
 * - Workflow cost computation results
 * - Agent type
 *
 * All functions mutate the record in place (following existing patterns).
 *
 * @module eval-record-builder
 */

import type { EvalRecord } from './eval-schema.ts';
import type { DifficultyAnalysis } from './difficulty-analyzer.ts';
import type { WorkflowCostOutcome, WorkflowCostResult, WorkflowCostFailure } from './workflow-cost.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** Task context analysis result (from task-context-analyzer.ts). */
export interface TaskContextAnalysis {
  taskType: string;
  changeKind: string;
  complexity: string;
  primaryFiles?: string[];
  testCoverage?: string;
}

/** Repo context analysis result (from repo-context-analyzer.ts). */
export interface RepoContextAnalysis {
  primaryLanguage: string;
  repoVisibility: string;
  repoSize?: {
    fileCount: number;
    locCount: number;
  };
  testingFrameworks?: string[];
}

/** All metadata to attach to an eval record. */
export interface EvalRecordMetadata {
  /** Agent type that ran the workflow */
  agentType?: string;
  /** Difficulty analysis results */
  difficulty?: DifficultyAnalysis | null;
  /** Task context analysis results */
  taskContext?: TaskContextAnalysis | null;
  /** Repo context analysis results */
  repoContext?: RepoContextAnalysis | null;
  /** Workflow cost computation results */
  workflowCost?: WorkflowCostOutcome | null;
}

// ────────────────────────────────────────────────────────────────
// Metadata Attachment Functions
// ────────────────────────────────────────────────────────────────

/**
 * Attach agent type to eval record.
 * Sets agentType field unconditionally (even if undefined, it becomes 'claude').
 */
export function attachAgentType(record: EvalRecord, agentType?: string): void {
  record.agentType = agentType || 'claude';
}

/**
 * Attach difficulty analysis metadata to eval record.
 * Only mutates record if difficultyData is non-null.
 */
export function attachDifficultyMetadata(
  record: EvalRecord,
  difficultyData: DifficultyAnalysis | null
): void {
  if (difficultyData) {
    record.difficultyBand = difficultyData.difficultyBand;
    record.difficultySignals = difficultyData.difficultySignals;
    record.stratum = difficultyData.stratum;
  }
}

/**
 * Attach task context analysis metadata to eval record.
 * Only mutates record if taskContextData is non-null.
 */
export function attachTaskContextMetadata(
  record: EvalRecord,
  taskContextData: TaskContextAnalysis | null
): void {
  if (taskContextData) {
    record.taskContext = taskContextData;
  }
}

/**
 * Attach repo context analysis metadata to eval record.
 * Only mutates record if repoContextData is non-null.
 */
export function attachRepoContextMetadata(
  record: EvalRecord,
  repoContextData: RepoContextAnalysis | null
): void {
  if (repoContextData) {
    record.repoContext = repoContextData;
  }
}

/**
 * Attach workflow cost computation metadata to eval record.
 *
 * Handles both success and failure cases:
 * - Success: sets workflowCost, workflowTokenUsage, workflowCostStatus
 * - Failure: sets workflowCostStatus, workflowCostDiagnostics
 */
export function attachWorkflowCostMetadata(
  record: EvalRecord,
  costOutcome: WorkflowCostOutcome | null
): void {
  if (!costOutcome) {
    return;
  }

  if (costOutcome.status === 'success') {
    const success = costOutcome as WorkflowCostResult;
    record.workflowCost = success.totalCostUsd;
    record.workflowTokenUsage = success.models;
    record.workflowCostStatus = 'success';
  } else {
    const failure = costOutcome as WorkflowCostFailure;
    record.workflowCostStatus = failure.status;
    record.workflowCostDiagnostics = {
      reason: failure.reason,
      ...failure.diagnostics,
    };
  }
}

// ────────────────────────────────────────────────────────────────
// Main Orchestrator
// ────────────────────────────────────────────────────────────────

/**
 * Enrich an eval record with all available metadata.
 *
 * Mutates the record in place by attaching:
 * - Agent type
 * - Difficulty analysis
 * - Task context analysis
 * - Repo context analysis
 * - Workflow cost computation
 *
 * @param record - Base eval record from evaluateTask()
 * @param metadata - All metadata to attach
 */
export function enrichEvalRecord(record: EvalRecord, metadata: EvalRecordMetadata): void {
  attachAgentType(record, metadata.agentType);
  attachDifficultyMetadata(record, metadata.difficulty || null);
  attachTaskContextMetadata(record, metadata.taskContext || null);
  attachRepoContextMetadata(record, metadata.repoContext || null);
  attachWorkflowCostMetadata(record, metadata.workflowCost || null);
}
