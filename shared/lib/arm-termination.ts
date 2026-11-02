/**
 * The one arm-termination recorder (HOK-3358 D1): records a terminated arm with
 * typed cause, derives fault class, writes reliability record and failure eval
 * record when eligible, and triggers Hokusai submission.
 *
 * Entry point: recordArmTermination(input).
 * State mutation: stampTermination(task, input) (pure, called inside mutateWorkflowState).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import {
  classifyArmFault,
  formatTerminationReason,
  isModelQualitySignal,
  ARM_FAILURE_KINDS,
  type ArmFailureKind,
  type ArmFaultClass,
} from './arm-failure-taxonomy.ts';
import { canonicalFailureKind } from './failure-policy.ts';
import { appendArmReliabilityRecord, buildArmReliabilityRecord, type ArmReliabilityRecord } from './arm-reliability.ts';
import { mutateWorkflowState, type WorkflowState, type TaskRecord } from './workflow-state.ts';
import { buildUnscoredEvalRecord } from './eval.ts';
import { appendEvalRecord, readEvalRecords } from './eval-persistence.ts';
import { triggerHokusaiSubmission } from './hokusai-submission-trigger.ts';

const CHALLENGE_ABORTED_FILENAME = '.challenge-aborted.json';
const DEFAULT_EVALS_DIR = '.wavemill/evals';

/** Typed actor responsible for terminating an arm. */
export type TerminationActor = 'operator' | 'monitor' | 'observer' | 'resolver';

/** Result of recordArmTermination with attribution facts. */
export interface ArmTerminationResult {
  terminationId: string;
  reason: string;
  faultClass: ArmFaultClass;
  qualitySignalEligible: boolean;
  reliabilityRecordId: string;
  evalRecordId?: string;
  contribution?: { rowId: string; completionResult: 'failure' };
}

/** Input to recordArmTermination. */
export interface RecordArmTerminationInput {
  repoDir: string;
  stateFile?: string;
  issueId: string;
  featureDir?: string;
  stage?: string;
  model?: string;
  failureKind: ArmFailureKind;
  detail: string;
  nextAction?: string;
  actor: TerminationActor;
  evidencePath?: string;
  scope?: 'single' | 'pair';
  budgetExhausted?: BudgetExhaustedFact | null;
  now?: Date;
}

/** Validation error. */
export interface ValidationError {
  field: string;
  message: string;
}

/** Exported for test injection. */
export interface ArmTerminationDeps {
  readFile?: (path: string) => string;
  hashContent?: (data: string) => string;
  appendReliability?: (input: any, dir?: string) => ArmReliabilityRecord;
  appendEvalRecord?: (record: any, dir?: string) => void;
  triggerHokusaiSubmission?: (record: any, opts: any) => Promise<{ entryId?: string } | null>;
}

function terminationIdFor(input: RecordArmTerminationInput, evidence?: string): string {
  // The recorder can be retried after any downstream append fails. Keep the id
  // stable across those retries so every append-only sink can de-duplicate.
  return createHash('sha256').update(JSON.stringify({
    issueId: input.issueId,
    failureKind: canonicalFailureKind(input.failureKind) ?? input.failureKind,
    detail: input.detail,
    stage: input.stage ?? '',
    model: input.model ?? '',
    actor: input.actor,
    evidence: evidence ?? '',
  })).digest('hex');
}

function stageResultPath(featureDir: string, stage: string): string {
  const normalized = stage === 'implementation' ? 'coding' : stage;
  return `${featureDir}/.${normalized}-result.json`;
}

function hasExecutedModelEvidence(input: RecordArmTerminationInput): boolean {
  if (!input.featureDir || !input.stage || !input.model) return false;
  const resultPath = stageResultPath(input.featureDir, input.stage);
  if (!existsSync(resultPath)) return false;
  try {
    const result = JSON.parse(readFileSync(resultPath, 'utf-8')) as Record<string, unknown>;
    const artifacts = result.artifacts as Record<string, unknown> | undefined;
    const executed = typeof result.executedModel === 'string' ? result.executedModel
      : typeof result.model === 'string' ? result.model
        : typeof artifacts?.executedModel === 'string' ? artifacts.executedModel
          : typeof artifacts?.model === 'string' ? artifacts.model : undefined;
    return executed === input.model;
  } catch {
    return false;
  }
}

/**
 * Validate input and return errors, or empty array if valid.
 * The kind must be known, and model-fault kinds require evidence.
 */
export function validateTerminationInput(input: RecordArmTerminationInput): ValidationError[] {
  const errors: ValidationError[] = [];

  const canonical = canonicalFailureKind(input.failureKind);
  if (!canonical || !isKnownFailureKind(canonical)) {
    errors.push({
      field: 'failureKind',
      message: `unknown failure kind "${input.failureKind}" (known kinds: ${ARM_FAILURE_KINDS.join(', ')})`,
    });
  }

  const faultClass = classifyArmFault({ failureKind: input.failureKind });
  if (isModelQualitySignal(faultClass) && input.actor === 'operator') {
    if (!input.evidencePath) {
      errors.push({
        field: 'evidencePath',
        message: `model-fault kind "${input.failureKind}" requires --evidence <path> from the operator`,
      });
    } else if (!existsSync(input.evidencePath)) {
      errors.push({
        field: 'evidencePath',
        message: `evidence file does not exist: "${input.evidencePath}"`,
      });
    }
    if (!hasExecutedModelEvidence(input)) {
      errors.push({
        field: 'model',
        message: 'model-fault termination requires matching executed-model evidence in the stage result',
      });
    }
  }

  return errors;
}

/**
 * Pure state mutation: stamp the arm with termination reason and details.
 * Called inside a mutateWorkflowState callback (D1).
 */
export function stampTermination(
  task: TaskRecord,
  input: RecordArmTerminationInput,
): { updated: boolean } {
  const reason = formatTerminationReason(input.failureKind);

  // Never overwrite an existing stamp (D1)
  if (task.challengeAborted?.trim()) {
    return { updated: false };
  }

  task.challengeAborted = reason;
  if (input.detail) {
    task.challengeAbortedDetail = input.detail;
  }
  if (input.stage) {
    task.challengeAbortedStage = input.stage;
  }
  if (input.nextAction) {
    task.challengeAbortedNextAction = input.nextAction;
  }

  return { updated: true };
}

/**
 * Record a terminated arm: state stamp, reliability record, optional failure eval record,
 * and optional Hokusai submission.
 *
 * The fault class is derived and never stored as primary (D2). The failure eval record
 * is written only for quality-signal-eligible kinds with attribution (D3).
 */
export async function recordArmTermination(
  input: RecordArmTerminationInput,
  deps?: Partial<ArmTerminationDeps>,
): Promise<ArmTerminationResult | { error: string; validationErrors: ValidationError[] }> {
  const errors = validateTerminationInput(input);
  if (errors.length > 0) {
    return { error: 'validation failed', validationErrors: errors };
  }

  const faultClass = classifyArmFault({ failureKind: input.failureKind });
  const qualitySignalEligible = isModelQualitySignal(faultClass);
  const readFile = deps?.readFile ?? ((p: string) => readFileSync(p, 'utf-8'));
  const hashFn = deps?.hashContent ?? ((d: string) => createHash('sha256').update(d).digest('hex'));

  // Prepare evidence path (repo-relative or content hash for out-of-repo)
  let evidencePath: string | undefined;
  if (input.evidencePath) {
    const resolved = resolve(input.evidencePath);
    const repoDir = resolve(input.repoDir);
    if (resolved.startsWith(repoDir)) {
      evidencePath = resolved.slice(repoDir.length + 1);
    } else {
      // Out-of-repo: store content hash
      const content = readFile(resolved);
      evidencePath = `hash:${hashFn(content)}`;
    }
  }
  const terminationId = terminationIdFor(input, evidencePath);

  let taskSnapshot: TaskRecord | undefined;
  // Step 1: Stamp state (if stateFile provided)
  if (input.stateFile) {
    try {
      await mutateWorkflowState(input.stateFile, (state: WorkflowState) => {
        const task = state.tasks[input.issueId];
        if (task) {
          taskSnapshot = { ...task };
          stampTermination(task, input);
          // If pair scope, also stamp the peer
          if (input.scope === 'pair' && task.challengePairId) {
            const peer = state.tasks[task.challengePairId];
            if (peer) {
              stampTermination(peer, input);
              // Record pair abortions (D1)
              if (!state.challengePairAbortions) state.challengePairAbortions = {};
              if (!state.challengePairAbortions[task.challengePairId]) {
                state.challengePairAbortions[task.challengePairId] = {};
              }
              const role = (task.challengeRole || 'primary') as string;
              state.challengePairAbortions[task.challengePairId][role] = input.actor;
            }
          }
        }
        return state;
      });
    } catch (err) {
      // State stamp is critical; if it fails, do not continue
      return { error: `state stamp failed: ${String(err)}`, validationErrors: [] };
    }
  }

  // Step 2: Write challenge-aborted.json artifact (D1)
  let artifactPath: string | undefined;
  if (input.featureDir) {
    artifactPath = `${input.featureDir}/${CHALLENGE_ABORTED_FILENAME}`;
    const artifact = {
      // Preserve the monitor artifact contract used by archive/restore.
      pairId: taskSnapshot?.challengePairId ?? input.issueId,
      role: taskSnapshot?.challengeRole,
      model: input.model,
      abortedAt: input.now?.toISOString() ?? new Date().toISOString(),
      budgetExhausted: input.budgetExhausted ?? undefined,
      reason: formatTerminationReason(input.failureKind),
      actor: input.actor,
      detail: input.detail,
      nextAction: input.nextAction,
      stage: input.stage,
      terminationId,
      failureKind: input.failureKind,
      evidence: evidencePath,
      timestamp: input.now?.toISOString() ?? new Date().toISOString(),
    };
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  }

  // Step 3: Append reliability record (D1)
  const appendReliability = deps?.appendReliability ?? appendArmReliabilityRecord;
  const reliabilityInput = {
    issueId: input.issueId,
    challengePairId: taskSnapshot?.challengePairId,
    challengeRole: taskSnapshot?.challengeRole === 'primary' || taskSnapshot?.challengeRole === 'challenger'
      ? taskSnapshot.challengeRole
      : undefined,
    stage: input.stage || 'unknown',
    model: input.model || 'unknown',
    abortReason: formatTerminationReason(input.failureKind),
    detail: input.detail,
    nextAction: input.nextAction,
    actor: input.actor,
    evidence: evidencePath,
    terminationId,
  };
  const reliabilityRecord = appendReliability(reliabilityInput, input.repoDir);
  const reliabilityRecordId = reliabilityRecord.id;

  // Step 4: Write failure eval record (if eligible and best-effort) (D3, D4)
  let evalRecordId: string | undefined;
  try {
    if (qualitySignalEligible && input.model && input.stage) {
      const existing = readEvalRecords({ repoDir: input.repoDir }).find((record) =>
        (record.metadata as Record<string, unknown> | undefined)?.terminationId === terminationId,
      );
      if (existing) {
        evalRecordId = existing.id;
        return { terminationId, reason: formatTerminationReason(input.failureKind), faultClass, qualitySignalEligible, reliabilityRecordId, evalRecordId };
      }
      const evalRecord = await buildUnscoredEvalRecord({
        taskPrompt: input.detail || `Arm termination for ${input.issueId}`,
        prReviewOutput: '',
        issueId: input.issueId,
        metadata: {
          terminationId,
          failureKind: input.failureKind,
          faultClass,
          actor: input.actor,
          evidence: evidencePath,
          stage: input.stage,
        },
      }, {
        failureReason: 'pr_diff_unavailable',
        rationale: input.detail || `Terminal ${input.failureKind} recorded by ${input.actor}`,
        diagnostic: { terminationId, failureKind: input.failureKind },
      }, { success: false });
      // The evaluated model is the stage model, not the judge used to create an
      // unscored record.  This is the value contribution export learns from.
      evalRecord.modelId = input.model;
      evalRecord.modelVersion = input.model;
      evalRecord.challengePairId = taskSnapshot?.challengePairId;
      evalRecord.challengeStage = input.stage as any;
      const appendEval = deps?.appendEvalRecord ?? ((record) => appendEvalRecord(record, { repoDir: input.repoDir }));
      appendEval(evalRecord, input.repoDir);
      evalRecordId = evalRecord.id;
      const submit = deps?.triggerHokusaiSubmission ?? triggerHokusaiSubmission;
      const queued = await submit(evalRecord, { repoDir: input.repoDir });
      if (queued?.entryId) {
        return {
          terminationId,
          reason: formatTerminationReason(input.failureKind),
          faultClass,
          qualitySignalEligible,
          reliabilityRecordId,
          evalRecordId,
          contribution: { rowId: queued.entryId, completionResult: 'failure' },
        };
      }
    }
  } catch (err) {
    // Eval step is best-effort (D1); errors are logged but don't undo earlier steps
    console.warn(`eval record step failed: ${String(err)}`);
  }

  return {
    terminationId,
    reason: formatTerminationReason(input.failureKind),
    faultClass,
    qualitySignalEligible,
    reliabilityRecordId,
    evalRecordId,
  };
}

/** Check if a kind is known (in ARM_FAILURE_KINDS after canonicalization). */
function isKnownFailureKind(kind: string): boolean {
  return ARM_FAILURE_KINDS.includes(kind);
}

// Placeholder types for dependencies
interface BudgetExhaustedFact {
  kind?: string;
  progress?: any;
}
