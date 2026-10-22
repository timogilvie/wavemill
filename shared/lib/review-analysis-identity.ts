/**
 * Review analysis identity hand-off (HOK-3247).
 *
 * The review pane's agent runs `tools/review-changes.ts`, which knows which
 * model performed the review's substantive analysis, but the pane agent — not
 * `review-changes` — writes `.review-result.json` (via `stage-result-cli.ts`),
 * and only the fields the prompt tells it to copy. Prompt prose is not a
 * reliable carrier for execution evidence, so `review-changes` records the
 * identity in a side file keyed to the head it reviewed, and the single
 * stage-result writer (`stage-result-cli.ts`, also used by the monitor's
 * `write_stage_result`) merges it into `artifacts.reviewExecutedIdentity`.
 *
 * The record also carries the native analysis loop's usage (HOK-3260), merged
 * into `artifacts.usage` so the stage result has the prompt-cache numbers.
 *
 * Staleness: the record carries the reviewed head SHA. It is merged only
 * while the worktree is still at that head; a record from an earlier head is
 * ignored, and an identity previously merged from it is stripped, so an old
 * review's identity can never be attributed to a later head.
 *
 * @module review-analysis-identity
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildExecutedIdentity,
  type ExecutedIdentity,
  type ReviewExecutedIdentitySet,
} from './challenge-execution-contract.ts';
import {
  readStageResult,
  writeStageResult,
  type ReviewArtifacts,
  type StageExecutionUsage,
  type StageResult,
} from './stage-result.ts';

export const REVIEW_ANALYSIS_IDENTITY_FILE = '.review-analysis-identity.json';
export const REVIEW_ANALYSIS_IDENTITY_SCHEMA_VERSION = 1;

export interface ReviewAnalysisIdentityRecord {
  schemaVersion: number;
  /** Head SHA the review analysed. The record is only valid at this head. */
  headSha: string;
  recordedAt: string;
  substantiveAnalysis: ExecutedIdentity;
  /** Native substantive-analysis loop usage (HOK-3260); absent for non-native reviewers. */
  usage?: StageExecutionUsage;
}

export function reviewAnalysisIdentityPath(featureDir: string): string {
  return join(featureDir, REVIEW_ANALYSIS_IDENTITY_FILE);
}

/** Remove any record from a previous run (called before each review run). */
export function clearReviewAnalysisIdentity(featureDir: string): void {
  rmSync(reviewAnalysisIdentityPath(featureDir), { force: true });
}

export function writeReviewAnalysisIdentity(
  featureDir: string,
  input: { headSha: string; substantiveAnalysis: ExecutedIdentity; usage?: StageExecutionUsage; now?: Date },
): ReviewAnalysisIdentityRecord {
  const record: ReviewAnalysisIdentityRecord = {
    schemaVersion: REVIEW_ANALYSIS_IDENTITY_SCHEMA_VERSION,
    headSha: input.headSha,
    recordedAt: (input.now ?? new Date()).toISOString(),
    substantiveAnalysis: input.substantiveAnalysis,
    ...(input.usage ? { usage: input.usage } : {}),
  };
  const path = reviewAnalysisIdentityPath(featureDir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
  return record;
}

function isExecutedIdentity(value: unknown): value is ExecutedIdentity {
  const record = value as Record<string, unknown> | null;
  return Boolean(record)
    && typeof record === 'object'
    && typeof record!.role === 'string'
    && typeof record!.requestedModel === 'string'
    && typeof record!.resolvedModel === 'string'
    && typeof record!.source === 'string'
    && typeof record!.pinned === 'boolean';
}

/** Read the record, or null when missing or malformed (never throws). */
export function readReviewAnalysisIdentity(featureDir: string): ReviewAnalysisIdentityRecord | null {
  const path = reviewAnalysisIdentityPath(featureDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ReviewAnalysisIdentityRecord>;
    if (
      parsed?.schemaVersion !== REVIEW_ANALYSIS_IDENTITY_SCHEMA_VERSION
      || typeof parsed.headSha !== 'string'
      || !parsed.headSha.trim()
      || !isExecutedIdentity(parsed.substantiveAnalysis)
    ) {
      return null;
    }
    return parsed as ReviewAnalysisIdentityRecord;
  } catch {
    return null;
  }
}

/**
 * The pane agent that ran the review (the orchestrator), from the stage
 * result's own execution-truth fields: pinned only when the monitor resolved
 * an executed model from the agent's session evidence and it matches the
 * intended model.
 */
function paneOrchestratorIdentity(result: StageResult): ExecutedIdentity {
  const intended = (result.intendedModel ?? result.model ?? '').trim();
  const executed = (result.executedModel ?? '').trim();
  const evidenceDirect = result.executionEvidence?.status === 'direct';
  if (executed && evidenceDirect) {
    return buildExecutedIdentity({
      role: 'review_orchestrator',
      requestedModel: intended || undefined,
      resolvedModel: executed,
      ...(result.agent ? { agent: result.agent } : {}),
      source: 'artifact',
    });
  }
  return buildExecutedIdentity({
    role: 'review_orchestrator',
    requestedModel: intended || undefined,
    resolvedModel: executed || intended || 'unknown',
    ...(result.agent ? { agent: result.agent } : {}),
    source: 'derived',
    verified: false,
  });
}

function reviewArtifactsOf(result: StageResult): ReviewArtifacts | null {
  const artifacts = result.artifacts as ReviewArtifacts | undefined;
  return artifacts && typeof artifacts === 'object' && artifacts.type === 'review' ? artifacts : null;
}

/**
 * Pure merge: fold a fresh record into a review stage result, or strip an
 * identity merged from a record that is now stale. Returns the input object
 * unchanged when there is nothing to do.
 */
export function mergeReviewAnalysisIdentity(
  result: StageResult,
  record: ReviewAnalysisIdentityRecord | null,
  currentHeadSha: string | null,
): StageResult {
  // A launch-time `running` write must not pick up the previous run's record.
  if (result.stage !== 'review' || !record || result.status === 'running') return result;
  const artifacts = reviewArtifactsOf(result);
  if (!artifacts) return result;

  const fresh = Boolean(currentHeadSha) && record.headSha === currentHeadSha;
  if (!fresh) {
    // Only an identity this hand-off merged (tagged by reviewHeadSha = the
    // record's head) is stripped; a native review's own identity is untouched.
    if (artifacts.reviewExecutedIdentity && artifacts.reviewHeadSha === record.headSha) {
      const { reviewExecutedIdentity: _stale, usage: _staleUsage, ...rest } = artifacts;
      return { ...result, artifacts: rest as ReviewArtifacts };
    }
    return result;
  }

  const identity: ReviewExecutedIdentitySet = {
    orchestrator: paneOrchestratorIdentity(result),
    substantiveAnalysis: record.substantiveAnalysis,
    remediation: null,
  };
  return {
    ...result,
    artifacts: {
      ...artifacts,
      reviewHeadSha: record.headSha,
      reviewExecutedIdentity: identity,
      ...(record.usage ? { usage: record.usage } : {}),
    },
  };
}

function gitHeadSha(dir: string): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return sha || null;
  } catch {
    return null;
  }
}

export const reviewAnalysisIdentityDeps = {
  gitHeadSha,
};

/**
 * Merge the side-file identity into `<featureDir>/.review-result.json` when it
 * applies. Best-effort: any failure leaves the stage result as it was (the
 * identity then stays absent, which downstream readers treat as unpinned).
 */
export async function applyReviewAnalysisIdentity(featureDir: string): Promise<boolean> {
  const record = readReviewAnalysisIdentity(featureDir);
  if (!record) return false;
  const result = await readStageResult({ featureDir, stage: 'review' });
  if (!result) return false;
  const merged = mergeReviewAnalysisIdentity(
    result,
    record,
    reviewAnalysisIdentityDeps.gitHeadSha(featureDir),
  );
  if (merged === result) return false;
  await writeStageResult(featureDir, merged);
  return true;
}
