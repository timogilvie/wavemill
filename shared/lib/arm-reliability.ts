import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendJsonlRecord, readJsonlFile } from './jsonl-utils.ts';
import {
  classifyArmFault,
  isModelQualitySignal,
  parseAbortFailureKind,
  type ArmFaultClass,
  type ChallengeArmSide,
} from './arm-failure-taxonomy.ts';
import { parseBudgetExhaustedFact, type BudgetExhaustedFact } from './native-agent/budget-exhaustion.ts';
import { resolveNativeStageTimeSplit, type NativeStageTimeSplit } from './native-agent/stage-time-split.ts';
import { readStageResultSync, type StageName } from './stage-result.ts';

const DEFAULT_EVALS_DIR = '.wavemill/evals';
const RELIABILITY_RECORDS_FILENAME = 'reliability-records.jsonl';

export interface ArmReliabilityRecord {
  schemaVersion: '1.0.0';
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
 * HOK-3382: the settled-without-result stamp's typed exit evidence for the
 * stage's latest attempt - the current result's `artifacts.exitEvidence`,
 * falling back to the newest archived history entry that carried one.
 * Fail-soft: absent or unreadable evidence yields `undefined`, which
 * `classifyArmFault` reads as the unchanged model-fault fallback.
 */
export function readStageExitEvidence(
  featureDir: string,
  stage: StageName,
): { reason?: string | null; harnessHold?: unknown } | undefined {
  const result = readStageResultSync(featureDir, stage);
  if (!result) return undefined;
  const current = result.artifacts && typeof result.artifacts === 'object'
    ? (result.artifacts as { exitEvidence?: unknown }).exitEvidence
    : undefined;
  if (current && typeof current === 'object') {
    return current as { reason?: string | null; harnessHold?: unknown };
  }
  const history = Array.isArray(result.history) ? result.history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index]?.exitEvidence;
    if (entry && typeof entry === 'object') {
      return entry as { reason?: string | null; harnessHold?: unknown };
    }
  }
  return undefined;
}

export function buildArmReliabilityRecord(input: BuildArmReliabilityRecordInput): ArmReliabilityRecord {
  const failureKind = parseAbortFailureKind(input.abortReason);
  const budgetExhausted = parseBudgetExhaustedFact(input.budgetExhausted ?? null);
  const timeSplit = resolveNativeStageTimeSplit(budgetExhausted, { featureDir: input.featureDir }) ?? undefined;
  // HOK-3382: a hung-harness settle is the harness's fault, not the model's.
  const exitEvidence = input.featureDir && failureKind === 'coding-exited-without-result'
    ? readStageExitEvidence(input.featureDir, 'coding')
    : undefined;
  const faultClass = classifyArmFault({ failureKind, detail: input.detail, budgetExhausted, timeSplit, exitEvidence });
  return {
    schemaVersion: '1.0.0',
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
    source: input.source ?? 'challenge_abort_pair',
  };
}

export function appendArmReliabilityRecord(
  input: BuildArmReliabilityRecordInput,
  dirOrRepo?: string,
): ArmReliabilityRecord {
  const record = buildArmReliabilityRecord(input);
  const filePath = resolveReliabilityRecordsFile(dirOrRepo);
  const existing = existsSync(filePath) ? readArmReliabilityRecords(dirOrRepo) : [];
  const duplicate = existing.some((candidate) =>
    candidate.issueId === record.issueId
    && candidate.challengePairId === record.challengePairId
    && candidate.challengeRole === record.challengeRole
    && candidate.abortReason === record.abortReason
    && candidate.stage === record.stage
  );
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
