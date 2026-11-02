import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendJsonlRecord, readJsonlFile } from './jsonl-utils.ts';
import {
  classifyArmFault,
  isModelQualitySignal,
  parseAbortFailureKind,
  ARM_FAULT_CLASSIFIER_VERSION,
  type ArmFaultClass,
  type ChallengeArmSide,
} from './arm-failure-taxonomy.ts';
import { parseBudgetExhaustedFact, type BudgetExhaustedFact } from './native-agent/budget-exhaustion.ts';

const DEFAULT_EVALS_DIR = '.wavemill/evals';
const RELIABILITY_RECORDS_FILENAME = 'reliability-records.jsonl';

/** Arm reliability record with derived fault class (read-time re-derivation, HOK-3358 D2). */
export interface ArmReliabilityRecord {
  schemaVersion: '1.0.0' | '1.1.0';
  id: string;
  timestamp: string;
  issueId: string;
  /** Nullable for non-challenge tasks (HOK-3358). */
  challengePairId?: string | null;
  /** Nullable for non-challenge tasks (HOK-3358). */
  challengeRole?: ChallengeArmSide | null;
  stage: string;
  model: string;
  completed: false;
  abortReason: string;
  failureKind: string | null;
  /** Derived at read time from failureKind + budgetExhausted (HOK-3358 D2). */
  faultClass?: ArmFaultClass;
  qualitySignalEligible?: boolean;
  detail?: string;
  nextAction?: string;
  /**
   * The typed budget fact when the arm ran out of budget (HOK-3362).
   * `faultClass` is derived from it, never the other way round.
   */
  budgetExhausted?: BudgetExhaustedFact;
  source: 'challenge_abort_pair' | 'arm_termination';
  // v1.1.0 fields (HOK-3358)
  actor?: 'operator' | 'monitor' | 'observer' | 'resolver';
  evidence?: string;
  terminationId?: string;
  /** The classifier version that derived faultClass/qualitySignalEligible. */
  classifierVersion?: number;
}

export interface BuildArmReliabilityRecordInput {
  issueId: string;
  challengePairId?: string | null;
  challengeRole?: ChallengeArmSide | null;
  stage: string;
  model: string;
  abortReason: string;
  detail?: string;
  nextAction?: string;
  /** HOK-3362: the stage's budget fact (object or JSON); invalid input is dropped. */
  budgetExhausted?: BudgetExhaustedFact | string | null;
  timestamp?: string;
  id?: string;
  // v1.1.0 fields (HOK-3358)
  actor?: 'operator' | 'monitor' | 'observer' | 'resolver';
  evidence?: string;
  terminationId?: string;
}

/**
 * Append-only reliability corpus for arms that did not complete.
 *
 * These records are not EvalRecords and are not exported to Hokusai quality
 * submissions. They preserve failure evidence for reliability, eligibility, and
 * harness diagnostics while keeping harness/selection/unknown faults out of
 * model-quality routing feedback.
 *
 * v1.1.0 (HOK-3358): faultClass and qualitySignalEligible are derived at read time
 * from the failureKind + budgetExhausted + detail. New fields: actor, evidence,
 * terminationId, classifierVersion. challengePairId/challengeRole become nullable.
 */
export function buildArmReliabilityRecord(input: BuildArmReliabilityRecordInput): ArmReliabilityRecord {
  const failureKind = parseAbortFailureKind(input.abortReason);
  const budgetExhausted = parseBudgetExhaustedFact(input.budgetExhausted ?? null);
  const faultClass = classifyArmFault({ failureKind, detail: input.detail, budgetExhausted });
  const result: ArmReliabilityRecord = {
    schemaVersion: '1.1.0',
    id: input.id ?? randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    issueId: input.issueId,
    stage: input.stage,
    model: input.model,
    completed: false,
    abortReason: input.abortReason,
    failureKind,
    source: input.actor === 'monitor' ? 'challenge_abort_pair' : 'arm_termination',
    // Derived fields, stored for back-compat readers (marked derived in plan D2)
    faultClass,
    qualitySignalEligible: isModelQualitySignal(faultClass),
    classifierVersion: ARM_FAULT_CLASSIFIER_VERSION,
  };

  // Optional fields
  if (input.challengePairId !== undefined && input.challengePairId !== null) {
    result.challengePairId = input.challengePairId;
  }
  if (input.challengeRole !== undefined && input.challengeRole !== null) {
    result.challengeRole = input.challengeRole;
  }
  if (input.detail) {
    result.detail = input.detail;
  }
  if (input.nextAction) {
    result.nextAction = input.nextAction;
  }
  if (budgetExhausted) {
    result.budgetExhausted = budgetExhausted;
  }
  if (input.actor) {
    result.actor = input.actor;
  }
  if (input.evidence) {
    result.evidence = input.evidence;
  }
  if (input.terminationId) {
    result.terminationId = input.terminationId;
  }

  return result;
}

export function appendArmReliabilityRecord(
  input: BuildArmReliabilityRecordInput,
  dirOrRepo?: string,
): ArmReliabilityRecord {
  const record = buildArmReliabilityRecord(input);
  const filePath = resolveReliabilityRecordsFile(dirOrRepo);
  const existing = existsSync(filePath) ? readArmReliabilityRecords(dirOrRepo) : [];
  // Idempotent: same terminationId never writes twice. Legacy duplicate key (no terminationId)
  // checks the old shape for back-compat (plan D2, idempotent).
  const duplicate = existing.some((candidate) => {
    if (input.terminationId) {
      return candidate.issueId === record.issueId && candidate.terminationId === input.terminationId;
    }
    // Legacy key (v1.0.0 and early v1.1.0 rows without terminationId)
    return candidate.issueId === record.issueId
      && candidate.challengePairId === record.challengePairId
      && candidate.challengeRole === record.challengeRole
      && candidate.abortReason === record.abortReason
      && candidate.stage === record.stage;
  });
  if (!duplicate) {
    appendJsonlRecord(filePath, record);
  }
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
