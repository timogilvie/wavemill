import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { LoopResult, LoopStopReason } from './loop.ts';
import type { CleanupReport } from './cleanup.ts';
import { isBudgetStopReason } from './budget-exhaustion.ts';
import { redactSecretsInValue } from './tools/redaction.ts';
import type { ToolPhase } from './tools/types.ts';

export type StallType =
  | 'repeated_tool_failure'
  | 'repeated_patch_rejection'
  | 'no_touched_artifacts'
  | 'no_new_information'
  | 'budget_exhaustion';

export interface ToolFailureSignal {
  tool: string;
  signature: string;
}

export interface PatchRejectionSignal {
  code: string;
  target: string;
}

export interface TurnObservation {
  turnIndex: number;
  readOnly: boolean;
  touchedArtifact: boolean;
  producedNewInformation: boolean;
  toolFailures: ToolFailureSignal[];
  patchRejections: PatchRejectionSignal[];
}

export interface RecoveryThresholds {
  maxRepeatedToolFailures: number;
  maxRepeatedPatchRejections: number;
  maxTurnsWithoutTouchedArtifact: number;
  maxReadOnlyTurnsWithoutNewInfo: number;
}

export interface RecoveryInput {
  phase: ToolPhase;
  observations: TurnObservation[];
  stopReason: LoopStopReason;
  loopResult?: Pick<LoopResult, 'turnsCompleted' | 'toolCallsExecuted' | 'totalCostUsd' | 'wallClockMs'>;
  thresholds?: Partial<RecoveryThresholds>;
}

export interface StallEvidence {
  description: string;
  turnIndices: number[];
  detail?: Record<string, unknown>;
}

export interface LastUsefulActivity {
  turnIndex: number;
  kind: 'touched_artifact' | 'new_information';
}

export type StallDetection =
  | { stalled: false; lastUsefulActivity: LastUsefulActivity | null }
  | {
      stalled: true;
      stallType: StallType;
      evidence: StallEvidence;
      lastUsefulActivity: LastUsefulActivity | null;
    };

export type RecoveryStageResult =
  | { status: 'progressing' }
  | {
      status: 'blocked';
      stallType: StallType;
      message: string;
      lastUsefulActivity: LastUsefulActivity | null;
      diagnostics: string[];
      nextActions: string[];
    };

export const RECOVERY_ARTIFACT_SCHEMA_VERSION = 2 as const;
export const RECOVERY_ARTIFACT_BASE_DIR = '.wavemill/native-agent/recovery';

export interface RecoveryArtifact {
  schemaVersion: typeof RECOVERY_ARTIFACT_SCHEMA_VERSION;
  stallType: StallType;
  phase: ToolPhase;
  createdAt: string;
  evidence: StallEvidence;
  lastUsefulActivity: LastUsefulActivity | null;
  turnSummary: {
    totalTurns: number;
    readOnlyTurns: number;
    turnsSinceUseful: number;
  };
  loopStats?: Pick<LoopResult, 'turnsCompleted' | 'toolCallsExecuted' | 'totalCostUsd' | 'wallClockMs'>;
  cleanupReport?: CleanupReport;
  nextActions: string[];
  redactionApplied: true;
}

export interface AnalyzeRecoveryOptions {
  createdAt?: string;
  cleanupReport?: CleanupReport;
}

export interface AnalyzeRecoveryResult {
  detection: StallDetection;
  stageResult: RecoveryStageResult;
  artifact?: RecoveryArtifact;
}

export const DEFAULT_RECOVERY_THRESHOLDS: RecoveryThresholds = {
  maxRepeatedToolFailures: 3,
  maxRepeatedPatchRejections: 3,
  maxTurnsWithoutTouchedArtifact: 5,
  maxReadOnlyTurnsWithoutNewInfo: 5,
};

const NON_STALL_STOP_REASONS = new Set<LoopStopReason>(['aborted', 'error']);

const STALL_METADATA: Record<
  StallType,
  { message: string; diagnostics: string[]; nextActions: string[] }
> = {
  budget_exhaustion: {
    message: 'Runtime budgets were exhausted before the task reached a useful stopping point.',
    diagnostics: [
      'The loop stopped because one of the configured runtime budgets was reached.',
      'No additional recovery attempts should run until the relevant budget is adjusted.',
    ],
    nextActions: [
      'Raise the exhausted budget or split the task into a smaller unit of work.',
      'Resume from the recovery artifact so the next run starts with the latest context.',
    ],
  },
  repeated_tool_failure: {
    message: 'The same tool failure repeated across consecutive turns without recovery.',
    diagnostics: [
      'A single tool/signature pair failed on consecutive turns past the configured threshold.',
      'The runtime is likely retrying the same action instead of changing approach.',
    ],
    nextActions: [
      'Inspect the failing tool arguments and adjust the strategy before retrying.',
      'Switch to a different information source or narrow the tool request to break the loop.',
    ],
  },
  repeated_patch_rejection: {
    message: 'Patch application was rejected repeatedly for the same target.',
    diagnostics: [
      'The same rejection code and target path recurred on consecutive turns.',
      'This usually means the patch context drifted and needs a fresh read before mutation.',
    ],
    nextActions: [
      'Re-read the target region before attempting another patch.',
      'Update the patch to match the current file state instead of retrying the same hunk.',
    ],
  },
  no_touched_artifacts: {
    message: 'Recent turns did not touch any artifacts, so the runtime is no longer making changes.',
    diagnostics: [
      'The latest turn window completed without any successful artifact mutations.',
      'The agent may be circling through analysis without converting it into edits.',
    ],
    nextActions: [
      'Decide whether the task should stay read-only or make a concrete mutation next.',
      'Resume with a narrower change target so the next turn can produce an artifact.',
    ],
  },
  no_new_information: {
    message: 'Read-only turns stopped producing new information, so further reads are unlikely to help.',
    diagnostics: [
      'The recent read-only turn window produced no new information.',
      'Continuing to read the same material is unlikely to unblock progress.',
    ],
    nextActions: [
      'Switch from reading to a concrete action, or broaden the search scope.',
      'Resume from the artifact and start from the last useful activity instead of replaying the same reads.',
    ],
  },
};

export function detectStall(input: RecoveryInput): StallDetection {
  const observations = input.observations;
  const thresholds = resolveThresholds(input.thresholds);
  validateThresholds(thresholds);
  const lastUsefulActivity = findLastUsefulActivity(observations);

  if (NON_STALL_STOP_REASONS.has(input.stopReason)) {
    return { stalled: false, lastUsefulActivity };
  }

  const budgetEvidence = detectBudgetExhaustion(input.stopReason);
  if (budgetEvidence) {
    return {
      stalled: true,
      stallType: 'budget_exhaustion',
      evidence: budgetEvidence,
      lastUsefulActivity,
    };
  }

  const repeatedToolFailure = detectRepeatedToolFailure(observations, thresholds.maxRepeatedToolFailures);
  if (repeatedToolFailure) {
    return {
      stalled: true,
      stallType: 'repeated_tool_failure',
      evidence: repeatedToolFailure,
      lastUsefulActivity,
    };
  }

  const repeatedPatchRejection = detectRepeatedPatchRejection(
    observations,
    thresholds.maxRepeatedPatchRejections,
  );
  if (repeatedPatchRejection) {
    return {
      stalled: true,
      stallType: 'repeated_patch_rejection',
      evidence: repeatedPatchRejection,
      lastUsefulActivity,
    };
  }

  const noTouchedArtifacts = detectNoTouchedArtifacts(
    observations,
    thresholds.maxTurnsWithoutTouchedArtifact,
  );
  if (noTouchedArtifacts) {
    return {
      stalled: true,
      stallType: 'no_touched_artifacts',
      evidence: noTouchedArtifacts,
      lastUsefulActivity,
    };
  }

  const noNewInformation = detectNoNewInformation(
    observations,
    thresholds.maxReadOnlyTurnsWithoutNewInfo,
  );
  if (noNewInformation) {
    return {
      stalled: true,
      stallType: 'no_new_information',
      evidence: noNewInformation,
      lastUsefulActivity,
    };
  }

  return { stalled: false, lastUsefulActivity };
}

export function buildBlockedStageResult(detection: StallDetection): RecoveryStageResult {
  if (!detection.stalled) {
    return { status: 'progressing' };
  }

  const metadata = STALL_METADATA[detection.stallType];
  return {
    status: 'blocked',
    stallType: detection.stallType,
    message: metadata.message,
    lastUsefulActivity: detection.lastUsefulActivity,
    diagnostics: [...metadata.diagnostics, detection.evidence.description],
    nextActions: [...metadata.nextActions],
  };
}

export function buildRecoveryArtifact(
  input: RecoveryInput,
  detection: Extract<StallDetection, { stalled: true }>,
  createdAt: string,
  cleanupReport?: CleanupReport,
): RecoveryArtifact {
  const nextActions = [...STALL_METADATA[detection.stallType].nextActions];
  const lastUsefulIndex = detection.lastUsefulActivity
    ? input.observations.findLastIndex(
      (observation) => observation.turnIndex === detection.lastUsefulActivity?.turnIndex,
    )
    : -1;

  const artifact: RecoveryArtifact = {
    schemaVersion: RECOVERY_ARTIFACT_SCHEMA_VERSION,
    stallType: detection.stallType,
    phase: input.phase,
    createdAt,
    evidence: detection.evidence,
    lastUsefulActivity: detection.lastUsefulActivity,
    turnSummary: {
      totalTurns: input.observations.length,
      readOnlyTurns: input.observations.filter((observation) => observation.readOnly).length,
      turnsSinceUseful: lastUsefulIndex >= 0
        ? input.observations.length - lastUsefulIndex - 1
        : input.observations.length,
    },
    nextActions,
    redactionApplied: true,
  };

  if (input.loopResult) {
    artifact.loopStats = { ...input.loopResult };
  }
  if (cleanupReport) {
    artifact.cleanupReport = cleanupReport;
  }

  return redactSecretsInValue(artifact).value as RecoveryArtifact;
}

export function analyzeRecovery(
  input: RecoveryInput,
  options: AnalyzeRecoveryOptions = {},
): AnalyzeRecoveryResult {
  const detection = detectStall(input);
  const stageResult = buildBlockedStageResult(detection);

  if (!detection.stalled || !options.createdAt) {
    return { detection, stageResult };
  }

  return {
    detection,
    stageResult,
    artifact: buildRecoveryArtifact(input, detection, options.createdAt, options.cleanupReport),
  };
}

export function getRecoveryArtifactPath(
  repoDir: string,
  artifact: Pick<RecoveryArtifact, 'phase' | 'createdAt'>,
): string {
  return join(repoDir, RECOVERY_ARTIFACT_BASE_DIR, `${artifact.phase}-${sanitizeTimestamp(artifact.createdAt)}.json`);
}

export function writeRecoveryArtifact(repoDir: string, artifact: RecoveryArtifact): string {
  const artifactPath = getRecoveryArtifactPath(repoDir, artifact);
  mkdirSync(dirname(artifactPath), { recursive: true });

  const tmpPath = `${artifactPath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');
    renameSync(tmpPath, artifactPath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Preserve the original write/rename failure for callers.
      }
    }
    throw error;
  }

  return artifactPath;
}

function resolveThresholds(overrides: RecoveryInput['thresholds']): RecoveryThresholds {
  return { ...DEFAULT_RECOVERY_THRESHOLDS, ...overrides };
}

function validateThresholds(thresholds: RecoveryThresholds): void {
  for (const [key, value] of Object.entries(thresholds) as Array<[keyof RecoveryThresholds, number]>) {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
      throw new RangeError(
        `Recovery threshold '${key}' must be a positive integer (received ${String(value)}).`,
      );
    }
  }
}

function detectBudgetExhaustion(stopReason: LoopStopReason): StallEvidence | null {
  if (!isBudgetStopReason(stopReason)) {
    return null;
  }

  return {
    description: `Loop stopped because the ${stopReason} budget was exhausted.`,
    turnIndices: [],
    detail: { stopReason },
  };
}

function detectRepeatedToolFailure(
  observations: readonly TurnObservation[],
  threshold: number,
): StallEvidence | null {
  if (observations.length === 0 || threshold <= 0) {
    return null;
  }

  const lastTurn = observations.at(-1);
  if (!lastTurn || lastTurn.toolFailures.length === 0) {
    return null;
  }

  const candidates = uniqueSortedStrings(
    lastTurn.toolFailures.map((failure) => toolFailureKey(failure)),
  );
  for (const candidate of candidates) {
    const matchingTurns = collectConsecutiveMatchingTurnIndices(
      observations,
      (observation) => observation.toolFailures.some((failure) => toolFailureKey(failure) === candidate),
    );
    if (matchingTurns.length >= threshold) {
      const [tool, signature] = candidate.split('\u0000');
      return {
        description: `Tool ${tool} failed with the same signature on ${matchingTurns.length} consecutive turns.`,
        turnIndices: matchingTurns,
        detail: { tool, signature },
      };
    }
  }

  return null;
}

function detectRepeatedPatchRejection(
  observations: readonly TurnObservation[],
  threshold: number,
): StallEvidence | null {
  if (observations.length === 0 || threshold <= 0) {
    return null;
  }

  const lastTurn = observations.at(-1);
  if (!lastTurn || lastTurn.patchRejections.length === 0) {
    return null;
  }

  const candidates = uniqueSortedStrings(
    lastTurn.patchRejections.map((rejection) => patchRejectionKey(rejection)),
  );
  for (const candidate of candidates) {
    const matchingTurns = collectConsecutiveMatchingTurnIndices(
      observations,
      (observation) => observation.patchRejections.some((rejection) => patchRejectionKey(rejection) === candidate),
    );
    if (matchingTurns.length >= threshold) {
      const [code, target] = candidate.split('\u0000');
      return {
        description: `Patch rejection ${code} repeated for ${target} on ${matchingTurns.length} consecutive turns.`,
        turnIndices: matchingTurns,
        detail: { code, target },
      };
    }
  }

  return null;
}

function detectNoTouchedArtifacts(
  observations: readonly TurnObservation[],
  threshold: number,
): StallEvidence | null {
  if (observations.length < threshold || threshold <= 0) {
    return null;
  }

  const window = observations.slice(-threshold);
  if (window.some((observation) => observation.touchedArtifact)) {
    return null;
  }

  return {
    description: `No artifacts were touched in the last ${threshold} turns.`,
    turnIndices: window.map((observation) => observation.turnIndex),
  };
}

function detectNoNewInformation(
  observations: readonly TurnObservation[],
  threshold: number,
): StallEvidence | null {
  if (observations.length < threshold || threshold <= 0) {
    return null;
  }

  const window = observations.slice(-threshold);
  if (window.some((observation) => !observation.readOnly || observation.producedNewInformation)) {
    return null;
  }

  return {
    description: `The last ${threshold} read-only turns produced no new information.`,
    turnIndices: window.map((observation) => observation.turnIndex),
  };
}

function findLastUsefulActivity(
  observations: readonly TurnObservation[],
): LastUsefulActivity | null {
  for (let index = observations.length - 1; index >= 0; index--) {
    const observation = observations[index]!;
    if (observation.touchedArtifact) {
      return { turnIndex: observation.turnIndex, kind: 'touched_artifact' };
    }
    if (observation.producedNewInformation) {
      return { turnIndex: observation.turnIndex, kind: 'new_information' };
    }
  }

  return null;
}

function collectConsecutiveMatchingTurnIndices(
  observations: readonly TurnObservation[],
  predicate: (observation: TurnObservation) => boolean,
): number[] {
  const turnIndices: number[] = [];
  for (let index = observations.length - 1; index >= 0; index--) {
    const observation = observations[index]!;
    if (!predicate(observation)) {
      break;
    }
    turnIndices.push(observation.turnIndex);
  }
  return turnIndices.reverse();
}

function toolFailureKey(signal: ToolFailureSignal): string {
  return `${signal.tool}\u0000${signal.signature}`;
}

function patchRejectionKey(signal: PatchRejectionSignal): string {
  return `${signal.code}\u0000${signal.target}`;
}

function uniqueSortedStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sanitizeTimestamp(value: string): string {
  return value.replace(/[^0-9A-Za-z_-]+/g, '-');
}
