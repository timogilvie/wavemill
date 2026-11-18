import type { NativeProviderExecution } from '@hokusai/core';
import type { TaskCostSummaryV1 } from './sdk-task-cost/contract.ts';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendJsonlRecord, readJsonlFile } from './jsonl-utils.ts';
import {
  classifyArmFault,
  isModelQualitySignal,
  parseAbortFailureKind,
  type ArmFaultClass,
  type ArmFaultExitEvidence,
  type ChallengeArmSide,
} from './arm-failure-taxonomy.ts';
import { parseBudgetExhaustedFact, type BudgetExhaustedFact } from './native-agent/budget-exhaustion.ts';
import { resolveNativeStageTimeSplit, type NativeStageTimeSplit } from './native-agent/stage-time-split.ts';
import { readStageResultSync } from './stage-result.ts';
import { fleetCauseForAttempt, readFleetIncidents } from './fleet-incident-correlation.ts';

const DEFAULT_EVALS_DIR = '.wavemill/evals';
const RELIABILITY_RECORDS_FILENAME = 'reliability-records.jsonl';

export interface ArmReliabilityRecord {
  schemaVersion: '1.0.0';
  nativeProviderExecutions?: NativeProviderExecution[];
  taskCostSummary?: TaskCostSummaryV1[];
  id: string;
  timestamp: string;
  issueId: string;
  challengePairId: string;
  challengeRole: ChallengeArmSide;
  stage: string;
  model: string;
  completed: false;
  abortReason: string;
  failureKind: string | null;
  faultClass: ArmFaultClass;
  qualitySignalEligible: boolean;
  detail?: string;
  nextAction?: string;
  /**
   * The typed budget fact when the arm ran out of budget (HOK-3362).
   * `faultClass` is derived from it, never the other way round.
   */
  budgetExhausted?: BudgetExhaustedFact;
  /** HOK-3380: the transcript time split resolved from `budgetExhausted.sessionStream`, when found. */
  timeSplit?: NativeStageTimeSplit;
  /**
   * HOK-3509: when this failure joined a fleet incident, the fleet's
   * identity is recorded here so Hokusai sees the shared cause rather than
   * N task faults. Absent when the attempt was not correlated.
   */
  fleetIncident?: {
    fingerprint: string;
    causeKey: string;
    fleetFaultClass: 'harness-fault' | 'provider-fault';
  };
  /**
   * HOK-3358: the recorder that produced this row. `challenge_abort_pair`
   * remains the default (and the historical value for backfilled rows).
   * `operator-abort` and `pair-resolver` are added so the operator and
   * sibling-stalled paths both emit through the same recorder; readers that
   * only check `source === 'challenge_abort_pair'` continue to work, new
   * values are additive.
   */
  source: 'challenge_abort_pair' | 'operator-abort' | 'pair-resolver';
}

export interface BuildArmReliabilityRecordInput {
  nativeProviderExecutions?: NativeProviderExecution[];
  taskCostSummary?: TaskCostSummaryV1[];
  issueId: string;
  challengePairId: string;
  challengeRole: ChallengeArmSide;
  stage: string;
  model: string;
  abortReason: string;
  detail?: string;
  nextAction?: string;
  /** HOK-3362: the stage's budget fact (object or JSON); invalid input is dropped. */
  budgetExhausted?: BudgetExhaustedFact | string | null;
  /** HOK-3380: directory to resolve the fact's `sessionStream` transcript pointer against. */
  featureDir?: string;
  timestamp?: string;
  id?: string;
  /** HOK-3358: which recorder is writing this row. Defaults to `challenge_abort_pair`. */
  source?: ArmReliabilityRecord['source'];
  /**
   * HOK-3509: pass the fleet cause the correlator attached to this attempt,
   * when one exists. `classifyArmFault` reads it to override attribution,
   * and it is recorded under {@link ArmReliabilityRecord.fleetIncident}.
   */
  fleetCause?: { fingerprint: string; causeKey: string; fleetFaultClass: 'harness-fault' | 'provider-fault' } | null;
}

/**
 * Append-only reliability corpus for challenge arms that did not complete.
 *
 * These records are not EvalRecords and are not exported to Hokusai quality
 * submissions. They preserve failure evidence for reliability, eligibility, and
 * harness diagnostics while keeping harness/selection/unknown faults out of
 * model-quality routing feedback.
 */
/**
 * HOK-3382: the typed exit evidence a settled-without-result coding attempt
 * carries. Read from the coding attempt's own result, never guessed from the
 * detail text; absent/unreadable evidence leaves the historical model-fault
 * fallback intact.
 */
function codingExitEvidence(
  failureKind: string | null,
  featureDir: string | undefined,
): ArmFaultExitEvidence | null {
  if (!featureDir || failureKind !== 'coding-exited-without-result') return null;
  try {
    return readStageResultSync(featureDir, 'coding')?.artifacts?.exitEvidence ?? null;
  } catch {
    return null;
  }
}

export function buildArmReliabilityRecord(input: BuildArmReliabilityRecordInput): ArmReliabilityRecord {
  const failureKind = parseAbortFailureKind(input.abortReason);
  const budgetExhausted = parseBudgetExhaustedFact(input.budgetExhausted ?? null);
  const timeSplit = resolveNativeStageTimeSplit(budgetExhausted, { featureDir: input.featureDir }) ?? undefined;
  const exitEvidence = codingExitEvidence(failureKind, input.featureDir);
  const fleetCause = input.fleetCause ?? null;
  const faultClass = classifyArmFault({
    failureKind,
    detail: input.detail,
    budgetExhausted,
    timeSplit,
    exitEvidence,
    ...(fleetCause ? { fleetCause: { fleetFaultClass: fleetCause.fleetFaultClass } } : {}),
  });
  return {
    schemaVersion: '1.0.0',
    ...(input.nativeProviderExecutions?.length ? { nativeProviderExecutions: structuredClone(input.nativeProviderExecutions) } : {}),
    ...(input.taskCostSummary?.length ? { taskCostSummary: structuredClone(input.taskCostSummary) } : {}),
    id: input.id ?? randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    issueId: input.issueId,
    challengePairId: input.challengePairId,
    challengeRole: input.challengeRole,
    stage: input.stage,
    model: input.model,
    completed: false,
    abortReason: input.abortReason,
    failureKind,
    faultClass,
    qualitySignalEligible: isModelQualitySignal(faultClass),
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.nextAction ? { nextAction: input.nextAction } : {}),
    ...(budgetExhausted ? { budgetExhausted } : {}),
    ...(timeSplit ? { timeSplit } : {}),
    ...(fleetCause ? {
      fleetIncident: {
        fingerprint: fleetCause.fingerprint,
        causeKey: fleetCause.causeKey,
        fleetFaultClass: fleetCause.fleetFaultClass,
      },
    } : {}),
    source: input.source ?? 'challenge_abort_pair',
  };
}

export function appendArmReliabilityRecord(
  input: BuildArmReliabilityRecordInput,
  dirOrRepo?: string,
): ArmReliabilityRecord {
  const repoDir = dirOrRepo ? resolve(dirOrRepo) : resolve(process.cwd());
  const settledAttempt = input.featureDir ? readStageResultSync(input.featureDir, input.stage) : null;
  const settledAt = input.timestamp ? Date.parse(input.timestamp) : NaN;
  const stageAt = typeof settledAttempt?.finishedAt === 'string'
    ? Date.parse(settledAttempt.finishedAt)
    : (typeof settledAttempt?.startedAt === 'string' ? Date.parse(settledAttempt.startedAt) : NaN);
  // The incident path alone decides correlation. Row creation merely consumes
  // that decision from the active incident store so Hokusai receives the
  // endpoint/harness attribution rather than N task faults.
  const fleetCause = input.fleetCause ?? fleetCauseForAttempt({
    incidents: readFleetIncidents(join(repoDir, '.wavemill')),
    taskId: input.issueId,
    stage: input.stage,
    attemptId: typeof settledAttempt?.runId === 'string' ? settledAttempt.runId : undefined,
    at: Number.isFinite(stageAt) ? stageAt : (Number.isFinite(settledAt) ? settledAt : undefined),
  });
  const record = buildArmReliabilityRecord({ ...input, ...(fleetCause ? { fleetCause } : {}) });
  const filePath = resolveReliabilityRecordsFile(dirOrRepo);
  const existing = existsSync(filePath) ? readArmReliabilityRecords(dirOrRepo) : [];
  const duplicate = existing.find((candidate) =>
    candidate.issueId === record.issueId
    && candidate.challengePairId === record.challengePairId
    && candidate.challengeRole === record.challengeRole
    && candidate.abortReason === record.abortReason
    && candidate.stage === record.stage
  );
  if (duplicate) return duplicate;
  appendJsonlRecord(filePath, record);
  return record;
}

export function readArmReliabilityRecords(dirOrRepo?: string): ArmReliabilityRecord[] {
  const filePath = resolveReliabilityRecordsFile(dirOrRepo);
  if (!existsSync(filePath)) {
    return [];
  }
  return readJsonlFile<ArmReliabilityRecord>(filePath);
}

export function resolveReliabilityRecordsFile(dirOrRepo?: string): string {
  const base = dirOrRepo ? resolve(dirOrRepo) : resolve(DEFAULT_EVALS_DIR);
  const evalsDir = base.endsWith(`${DEFAULT_EVALS_DIR}`) || base.endsWith('/.wavemill/evals')
    ? base
    : join(base, DEFAULT_EVALS_DIR);
  return join(evalsDir, RELIABILITY_RECORDS_FILENAME);
}
