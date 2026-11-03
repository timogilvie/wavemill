// allow-arm-termination: this file *is* the single arm-termination recorder;
// its body necessarily contains every challengeAborted assignment and the
// derivation that readers must consult. The guard excludes this file from
// its scan via `invariantPaths`; the marker above is defensive.
/**
 * The one arm-termination recorder (HOK-3358).
 *
 * "This arm is terminated: record it, whose fault was it?" is answered in
 * one place. The operator's `wavemill abort`, the monitor's
 * `challenge_abort_pair`, and the challenge-pair-resolver's
 * `stampStalledArm` all route through {@link recordArmTermination}:
 *
 * - `challengeAborted` is always stamped as `terminal_stage_failure:<kind>`,
 *   so every reader parses one format;
 * - `faultClass` is derived at read time by {@link classifyArmFault}, never
 *   stored as primary (HOK-3338 rule 3);
 * - a model-fault kind requires an evidence artifact (`--evidence`) for
 *   operator aborts, so an operator who stops work for an unrelated reason
 *   cannot forge a model-attributable record;
 * - the reliability record (`arm-reliability.ts`) and the failure eval
 *   record (`evals.jsonl`, non-reward-eligible, no score) are both written
 *   when a stage model ran, so the Hokusai contribution export has the row
 *   it needs for a model-fault outcome;
 * - the `.challenge-aborted.json` artifact under `featureDir` preserves the
 *   pair/role/stage/model/reason bytes for later eval replay.
 */
import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChallengeStage } from './challenge-scheduler.ts';
import {
  classifyArmFault,
  isModelQualitySignal,
  type ArmFailureKind,
  type ArmFaultClass,
  type ChallengeArmSide,
} from './arm-failure-taxonomy.ts';
import { parseBudgetExhaustedFact, type BudgetExhaustedFact } from './native-agent/budget-exhaustion.ts';
import { resolveNativeStageTimeSplit } from './native-agent/stage-time-split.ts';
import {
  appendArmReliabilityRecord,
  type ArmReliabilityRecord,
} from './arm-reliability.ts';
import { recordSelectionOutcome } from './challenge-selection-health.ts';
import { appendEvalRecord } from './eval-persistence.ts';
import { SCHEMA_VERSION, type EvalRecord } from './eval-schema.ts';
import { mutateWorkflowState } from './workflow-state.ts';
import { challengerTaskKey, isChallengerTaskId } from './task-identity.ts';

export type ArmTerminationActor = 'operator' | 'monitor' | 'pair-resolver';
export type ArmTerminationScope = 'pair' | 'single';

/**
 * The {@link ArmFailureKind} union with a two-level `planning-artifact-invalid:*`
 * suffix the shell classifier emits.
 */
export type ArmTerminationKind = ArmFailureKind | `planning-artifact-invalid:${string}`;

export interface RecordArmTerminationInput {
  /** Task id as it lives in workflow state (e.g. `HOK-3315` or `HOK-3315_c`). */
  issueId: string;
  /** Typed cause from the arm-failure taxonomy. */
  kind: ArmTerminationKind;
  /** Which site is terminating the arm. */
  actor: ArmTerminationActor;
  /** Free-text operator/monitor detail; carried as `challengeAbortedDetail`. */
  detail?: string;
  /** Path to a stage artifact (coding/review/ready result, planning rejection). Required when the kind is model-fault AND actor is `operator`. */
  evidencePath?: string;
  /** Phase string (`planning` / `coding` / `review` / `ready` / `eval`). */
  stage?: string;
  /** Executed model id as recorded in the stage result / ownership row. */
  model?: string;
  /** `pair` (default) stamps the sibling as well; `single` stamps only this arm. */
  scope?: ArmTerminationScope;
  /** Operator-facing hint recorded on the artifact and the row. */
  nextAction?: string;
  /** Feature directory for `.challenge-aborted.json`; defaults to the task's feature dir if the state row knows it. */
  featureDir?: string;
  /** Repository root; defaults to `process.cwd()`. */
  repoDir?: string;
  /** Workflow state file; defaults to `<repoDir>/.wavemill/workflow-state.json`. */
  stateFile?: string;
  /** Typed budget-exhaustion fact (object or JSON) — fault class derives from it (HOK-3362). */
  budgetExhausted?: BudgetExhaustedFact | string | null;
  /** Skip workflow-state mutation (backfill: the row was reaped long ago). */
  skipStateMutation?: boolean;
  /** Deterministic clock for tests. */
  now?: () => Date;
}

export interface RecordArmTerminationResult {
  /** The reliability record appended (or the pre-existing duplicate). */
  reliability: ArmReliabilityRecord;
  /** The failure eval record's id, or `null` when none was written. */
  evalRecordId: string | null;
  /** True when workflow state was mutated this call. */
  stateMutated: boolean;
  /** Path to `.challenge-aborted.json`, or `null` when `featureDir` was absent. */
  artifact: { path: string } | null;
  /** Derived at write time; never stored as the primary record. */
  faultClass: ArmFaultClass;
  /** Shortcut: `isModelQualitySignal(faultClass)`. */
  qualitySignalEligible: boolean;
  /** The stamped `terminal_stage_failure:<kind>` value. */
  abortReason: string;
}

/** Alias chain for the renamed `native-completion-protocol`. */
const KIND_ALIAS: Readonly<Record<string, ArmTerminationKind>> = {
  'native-completion-protocol': 'completion-protocol',
};

const TERMINAL_PREFIX = 'terminal_stage_failure:';

const VALID_KINDS: ReadonlySet<string> = new Set<string>([
  'context-exhausted',
  'context-window-exceeded',
  'invalid-model-id',
  'provider-rate-limited',
  'provider-quota-exhausted',
  'provider-transient-error',
  'provider-credit-exhausted',
  'provider-config-error',
  'tool-use-unsupported',
  'empty-model-turn',
  'native-provider-error',
  'completion-protocol',
  'native-stage-timeout',
  'policy-denied',
  'cancelled',
  'native-unclassified',
  'coding-dirty-handoff',
  'sibling-stalled',
  'ready-exhausted',
  'ready-transition-failed',
  'ready-unattributed',
  'review-malformed-response',
  'review-not-ready',
  'review-identity-mismatch',
  'review-unattributed',
  'route-drift',
  'multiple-varied-roles',
  'planning-artifact-invalid',
  'review-no-output',
  'coding-exited-without-result',
] as const);

export function normalizeArmTerminationKind(kind: string): ArmTerminationKind {
  const trimmed = kind.trim();
  if (!trimmed) {
    throw new Error('Arm-termination kind is required');
  }
  if (KIND_ALIAS[trimmed]) {
    return KIND_ALIAS[trimmed];
  }
  const base = trimmed.startsWith('planning-artifact-invalid') ? 'planning-artifact-invalid' : trimmed;
  if (!VALID_KINDS.has(base)) {
    throw new Error(
      `Unknown arm-termination kind: '${trimmed}'. See ArmFailureKind in shared/lib/arm-failure-taxonomy.ts for the full union.`,
    );
  }
  return trimmed as ArmTerminationKind;
}

/**
 * The single arm-termination recorder (HOK-3358). See the file header for
 * contract and precedence; see the plan in features/.../plan.md for rationale.
 */
export async function recordArmTermination(input: RecordArmTerminationInput): Promise<RecordArmTerminationResult> {
  if (!input.issueId.trim()) {
    throw new Error('recordArmTermination: issueId is required');
  }
  const kind = normalizeArmTerminationKind(input.kind);
  const nowFn = input.now ?? (() => new Date());
  const timestamp = nowFn().toISOString();
  const budgetExhausted = parseBudgetExhaustedFact(input.budgetExhausted ?? null);
  const featureDir = input.featureDir;
  const timeSplit = resolveNativeStageTimeSplit(budgetExhausted, { featureDir }) ?? undefined;
  const faultClass = classifyArmFault({
    failureKind: kind,
    detail: input.detail,
    budgetExhausted,
    timeSplit,
  });
  const qualitySignalEligible = isModelQualitySignal(faultClass);

  // Evidence enforcement: only the operator path is required to show an
  // artifact — monitor-/resolver-side kinds already have `.coding-result.json`,
  // `.review-result.json`, or similar by construction and setting
  // `evidencePath` is a convenience there.
  if (input.actor === 'operator' && qualitySignalEligible) {
    if (!input.evidencePath) {
      throw new Error(
        `Evidence artifact required for model-fault kind '${kind}': pass --evidence <path> pointing at a stage artifact (.coding-complete, .review-result.json, .planning-result.json, …).`,
      );
    }
    const absPath = isAbsolute(input.evidencePath) ? input.evidencePath : resolve(process.cwd(), input.evidencePath);
    if (!existsSync(absPath)) {
      throw new Error(
        `Evidence artifact not found: ${input.evidencePath} (resolved to ${absPath}). The operator must point at an existing stage artifact.`,
      );
    }
  }

  const abortReason = `${TERMINAL_PREFIX}${kind}`;

  const repoDir = input.repoDir ?? process.cwd();
  const stateFile = input.stateFile ?? join(repoDir, '.wavemill', 'workflow-state.json');
  const stage = (input.stage ?? '').trim();
  const scope: ArmTerminationScope = input.scope === 'single' ? 'single' : 'pair';

  const peer = resolvePeerKey(input.issueId);

  // ── 1. Mutate workflow state (unless skipped for backfill) ────────────────
  let stateMutated = false;
  if (!input.skipStateMutation && existsSync(stateFile)) {
    const detail = input.detail;
    const nextAction = input.nextAction?.trim() || '';
    const actor = input.actor;
    const stampResult = { mutated: false };
    try {
      await mutateWorkflowState(stateFile, (current) => {
        const stamp = (key: string) => {
          const task = current.tasks?.[key];
          if (!task) return;
          task.challengeAborted = abortReason;
          if (detail) task.challengeAbortedDetail = detail;
          else delete task.challengeAbortedDetail;
          if (stage) task.challengeAbortedStage = stage;
          if (nextAction) task.challengeAbortedNextAction = nextAction;
          task.updated = timestamp;
          stampResult.mutated = true;
        };
        stamp(input.issueId);
        if (scope === 'pair' && peer) stamp(peer);

        // Operator-abort also flips the task row to terminal `aborted`. The
        // monitor/resolver paths already own phase/status + lifecycle writes
        // (`set_window_attention_state`, stage result writes, etc.).
        if (actor === 'operator') {
          const task = current.tasks?.[input.issueId];
          if (task) {
            task.phase = 'aborted';
            task.status = 'aborted';
            task.abortedReason = detail || abortReason;
            task.abortedAt = timestamp;
            const existingLifecycle = (task.lifecycle && typeof task.lifecycle === 'object' && !Array.isArray(task.lifecycle))
              ? task.lifecycle
              : {};
            task.lifecycle = { ...existingLifecycle, schemaVersion: 1, workflowOutcome: 'aborted' };
          }
        }
        return current;
      });
      stateMutated = stampResult.mutated;
    } catch {
      stateMutated = false;
    }
  }

  // ── 2. Write .challenge-aborted.json ─────────────────────────────────────
  let artifact: { path: string } | null = null;
  if (featureDir) {
    const role: ChallengeArmSide | 'single' = isChallengerTaskId(input.issueId) ? 'challenger' : 'primary';
    const pairId = resolvePairId(input.issueId);
    const artifactPath = join(featureDir, '.challenge-aborted.json');
    try {
      mkdirSync(dirname(artifactPath), { recursive: true });
      const payload = {
        pairId,
        role,
        stage,
        model: input.model || '',
        reason: abortReason,
        abortedAt: timestamp,
        detail: input.detail || '',
        ...(input.nextAction ? { nextAction: input.nextAction } : {}),
        ...(budgetExhausted ? { budgetExhausted } : {}),
        actor: input.actor,
      };
      const tmp = `${artifactPath}.tmp.${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
      renameSync(tmp, artifactPath);
      artifact = { path: artifactPath };
    } catch {
      // Non-fatal: the artifact is for diagnostics; the row and reliability
      // record are the authoritative termination record.
    }
  }

  // ── 3. Append reliability record ─────────────────────────────────────────
  const pairId = resolvePairId(input.issueId);
  const challengeRole: ChallengeArmSide = isChallengerTaskId(input.issueId) ? 'challenger' : 'primary';
  const reliability = appendArmReliabilityRecord(
    {
      issueId: input.issueId,
      challengePairId: pairId,
      challengeRole,
      stage: stage || 'coding',
      model: input.model || 'unknown',
      abortReason,
      detail: input.detail,
      nextAction: input.nextAction,
      budgetExhausted: input.budgetExhausted ?? null,
      featureDir,
      timestamp,
      source: actorToSource(input.actor),
    },
    repoDir,
  );

  // ── 4. Append failure eval record ─────────────────────────────────────────
  //
  // One failure eval row per `(issueId, modelId, abortReason)`; the record is
  // non-reward-eligible by construction (`score: 0`, `nonRewardReason`,
  // `trainingEligible: false`). Readers that need "the model was aborted on
  // this task" (Hokusai contribution builder → `completion_result: failure`)
  // see this row; readers that walk evals for rewards keep ignoring it.
  const evalRecordId = await maybeAppendFailureEvalRecord({
    input,
    kind,
    abortReason,
    faultClass,
    qualitySignalEligible,
    timestamp,
    repoDir,
    reliabilityId: reliability.id,
  });

  // ── 5. Trip provider circuit (model-fault / provider-fault only) ─────────
  const stageForOutcome = normalizeChallengeStage(stage);
  if (input.model && input.actor !== 'operator') {
    await recordSelectionOutcome({
      repoDir,
      owner: { issueId: pairId, pairId },
      stage: stageForOutcome,
      model: input.model,
      terminalStatus: 'failure',
      failureKind: kind,
      faultClass,
    });
  } else if (input.model && qualitySignalEligible) {
    // An operator abort that explicitly asserts a model-fault kind with
    // evidence does trip the circuit — the operator's claim is "this model
    // failed on this task", same shape as the monitor's claim.
    await recordSelectionOutcome({
      repoDir,
      owner: { issueId: pairId, pairId },
      stage: stageForOutcome,
      model: input.model,
      terminalStatus: 'failure',
      failureKind: kind,
      faultClass,
    });
  }

  return {
    reliability,
    evalRecordId,
    stateMutated,
    artifact,
    faultClass,
    qualitySignalEligible,
    abortReason,
  };
}

function actorToSource(actor: ArmTerminationActor): ArmReliabilityRecord['source'] {
  switch (actor) {
    case 'operator':
      return 'operator-abort';
    case 'pair-resolver':
      return 'pair-resolver';
    case 'monitor':
    default:
      return 'challenge_abort_pair';
  }
}

function resolvePeerKey(issueId: string): string | null {
  if (isChallengerTaskId(issueId)) {
    return issueId.replace(/_c$/, '');
  }
  return challengerTaskKey(issueId);
}

function resolvePairId(issueId: string): string {
  return isChallengerTaskId(issueId) ? issueId.replace(/_c$/, '') : issueId;
}

function normalizeChallengeStage(value: string): ChallengeStage {
  const raw = value.trim().toLowerCase();
  if (raw === 'plan' || raw === 'planning' || raw === 'planner') return 'plan';
  if (raw === 'review' || raw === 'reviewer') return 'review';
  return 'implementation';
}

interface AppendEvalInput {
  input: RecordArmTerminationInput;
  kind: ArmTerminationKind;
  abortReason: string;
  faultClass: ArmFaultClass;
  qualitySignalEligible: boolean;
  timestamp: string;
  repoDir: string;
  reliabilityId: string;
}

async function maybeAppendFailureEvalRecord(args: AppendEvalInput): Promise<string | null> {
  const { input, kind, abortReason, faultClass, qualitySignalEligible, timestamp, repoDir, reliabilityId } = args;

  // No model → nothing to attribute. (The reliability record still lands.)
  if (!input.model || !input.model.trim()) return null;

  const id = randomUUID();
  const detailLine = input.detail ? `— ${input.detail}` : '';
  const rationale = `Arm terminated: ${kind} (${faultClass}) ${detailLine}`.trim();
  const record: EvalRecord = {
    id,
    schemaVersion: SCHEMA_VERSION,
    originalPrompt: `${input.actor} abort: ${input.issueId}`,
    modelId: input.model,
    modelVersion: input.model,
    attempted_model: input.model,
    score: 0,
    scoreBand: 'Failure',
    timeSeconds: null,
    timestamp,
    interventionRequired: input.actor === 'operator',
    interventionCount: input.actor === 'operator' ? 1 : 0,
    interventionDetails: input.actor === 'operator'
      ? [`operator abort: ${input.detail || abortReason}`]
      : [],
    rationale,
    issueId: input.issueId,
    challengePairId: resolvePairId(input.issueId),
    challengeSide: isChallengerTaskId(input.issueId) ? 'challenger' : 'primary',
    nonRewardReason: {
      code: 'arm-terminated',
      message: `Arm terminated by ${input.actor} with kind ${kind} (${faultClass}); not reward eligible.`,
    },
    trainingEligible: false,
    budgetEvalEligible: false,
    outcomes: {
      success: false,
      review: {
        humanReviewRequired: false,
        rounds: 0,
        approvals: 0,
        changeRequests: 0,
      },
      rework: {
        agentIterations: 0,
      },
      delivery: {
        prCreated: false,
        merged: false,
      },
    },
    // Minimum valid taskDescriptor — the only consumer at write-time is the
    // JSON schema validator. Values are the executed model so the row still
    // joins to the model-match / contribution export.
    taskDescriptor: {
      schema_version: '1.0',
      signals: {
        heuristic: {
          files_touched: 0,
          repo_size_loc: 0,
        },
        learned: {},
      },
      constraints: {
        models_available: [input.model],
      },
      stages: {},
    },
    metadata: {
      arm_termination: {
        actor: input.actor,
        kind,
        faultClass,
        qualitySignalEligible,
        reliabilityId,
        ...(input.stage ? { stage: input.stage } : {}),
        ...(input.evidencePath ? { evidencePath: input.evidencePath } : {}),
      },
      ...(input.evidencePath ? { arm_termination_evidence: input.evidencePath } : {}),
    },
  };

  try {
    appendEvalRecord(record, { repoDir, dir: join(repoDir, '.wavemill', 'evals') });
  } catch {
    // Validation refused the record. Reliability record remains the
    // authoritative termination row.
    return null;
  }
  return id;
}
