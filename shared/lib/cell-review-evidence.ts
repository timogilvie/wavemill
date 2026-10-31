/**
 * Historical review/challenge evidence enrichment for the ORIGINAL PR
 * (HOK-3361, phase 2).
 *
 * Reads durable route/stage-result/lifecycle artifacts and normalizes
 * recoverable reviewer and challenge-stage runs with provenance and coverage
 * flags. The enrichment is orthogonal to cell assignment: it never feeds the
 * classifier, only the report's cross-tabs.
 *
 * Coverage semantics (precision over recall):
 * - Missing historical data is `unavailable` (e.g. `no_stage_artifact`) —
 *   NEVER proof that no reviewer ran.
 * - A run counts as positive reviewer coverage only when it is a completed
 *   run with a pinned execution identity (`executionEvidence.status ===
 *   'direct'`) whose recorded head SHA matches (or predates head pinning and
 *   is therefore marked unverifiable, which is not positive either).
 * - Stale head evidence never counts; current state is never consulted.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CellEvidenceRun, CellReviewEvidence, CellReasonCode } from './cell-label-contract.ts';

/** The durable, landed stage-result artifact shape (subset we read). */
export interface DurableStageResultRow {
  stage?: string;
  status?: string;
  executedModel?: string | null;
  intendedModel?: string | null;
  executionEvidence?: { status?: string; source?: string } | null;
  /** Recorded worktree head SHA when the artifact carries one. */
  headSha?: string | null;
  recordedAt?: string | null;
  /** Set by the disk reader to the durable artifact's file name. */
  artifactName?: string;
}

/** Input rows may be pre-loaded (tests/fixtures) or read from a feature dir. */
export interface CollectReviewEvidenceInput {
  stageRows: DurableStageResultRow[];
  /** Expected head SHA of the original PR; enables stale-head detection. */
  expectedHeadSha?: string | null;
  /** True when any durable artifact directory/artifacts were found at all. */
  artifactsPresent: boolean;
}

/**
 * Normalize durable stage rows into provenance-flagged reviewer and
 * challenge-stage runs. Pure and deterministic.
 */
export function normalizeReviewEvidence(input: CollectReviewEvidenceInput): CellReviewEvidence {
  if (!input.artifactsPresent || input.stageRows.length === 0) {
    return {
      coverage: 'unavailable',
      reason_codes: input.artifactsPresent ? ['no_stage_artifact'] : ['feature_dir_missing'],
      reviewer_runs: [],
      challenge_runs: [],
    };
  }
  const reviewerRuns: CellEvidenceRun[] = [];
  const challengeRuns: CellEvidenceRun[] = [];
  for (const row of input.stageRows) {
    const stage = typeof row.stage === 'string' && row.stage ? row.stage : 'unknown';
    const challenge = /(^|[-_])challenge([-_]|$)|challenge/i.test(stage) || isChallengeArtifactName(row);
    const run: CellEvidenceRun = {
      stage,
      artifact: row.artifactName ?? 'unknown',
      status: typeof row.status === 'string' && row.status ? row.status : 'unknown',
      evidence_backed: isEvidenceBacked(row, input.expectedHeadSha ?? null),
      executed_model: typeof row.executedModel === 'string' && row.executedModel ? row.executedModel : null,
      evidence_status: row.executionEvidence?.status ?? null,
      head_sha_match: resolveHeadShaMatch(row, input.expectedHeadSha ?? null),
      recorded_at: typeof row.recordedAt === 'string' && row.recordedAt ? row.recordedAt : null,
    };
    if (challenge) {
      challengeRuns.push(run);
    } else {
      reviewerRuns.push(run);
    }
  }
  const reasonCodes: CellReasonCode[] = [];
  if (reviewerRuns.some((run) => run.evidence_backed)) reasonCodes.push('reviewer_run_evidence_backed');
  if (challengeRuns.some((run) => run.evidence_backed)) reasonCodes.push('challenge_run_evidence_backed');
  return {
    coverage: 'available',
    reason_codes: reasonCodes,
    reviewer_runs: reviewerRuns,
    challenge_runs: challengeRuns,
  };
}

/**
 * Read the original PR's feature directory for durable stage artifacts
 * (`.review-result.json`, `.ready-result.json`, and any
 * `.challenge-*-result.json` challenge arms). When HOK-3338's lifecycle
 * events land, this provider swaps to those events; the normalized row shape
 * is the merge surface.
 */
export function collectReviewEvidenceFromFeatureDir(
  featureDir: string,
  expectedHeadSha?: string | null,
): CellReviewEvidence {
  if (!existsSync(featureDir)) {
    return normalizeReviewEvidence({ stageRows: [], artifactsPresent: false });
  }
  const rows: Array<DurableStageResultRow & { artifactName: string }> = [];
  // The durable artifact location exists even when no stage rows survive;
  // that is 'no_stage_artifact', not a missing feature directory.
  let artifactsPresent = true;
  for (const name of ['review', 'ready']) {
    const path = join(featureDir, `.${name}-result.json`);
    if (!existsSync(path)) continue;
    artifactsPresent = true;
    const parsed = safeRead(path);
    if (parsed) rows.push({ ...parsed, artifactName: `.${name}-result.json` });
  }
  let challengeNames: string[] = [];
  try {
    challengeNames = readdirSync(featureDir)
      .filter((name) => /^\.challenge-.*-result\.json$/.test(name))
      .sort();
  } catch {
    challengeNames = [];
  }
  for (const name of challengeNames) {
    artifactsPresent = true;
    const parsed = safeRead(join(featureDir, name));
    if (parsed) rows.push({ ...parsed, artifactName: name });
  }
  return normalizeReviewEvidence({ stageRows: rows, expectedHeadSha, artifactsPresent });
}

function isChallengeArtifactName(row: DurableStageResultRow): boolean {
  const name = row.artifactName ?? '';
  return /^\.challenge-/.test(name);
}

function resolveHeadShaMatch(row: DurableStageResultRow, expectedHeadSha: string | null): 'match' | 'mismatch' | 'unknown' {
  if (!expectedHeadSha || typeof row.headSha !== 'string' || !row.headSha) {
    return 'unknown';
  }
  return row.headSha === expectedHeadSha ? 'match' : 'mismatch';
}

function isEvidenceBacked(row: DurableStageResultRow, expectedHeadSha: string | null): boolean {
  if (row.status !== 'completed') return false;
  const executed = typeof row.executedModel === 'string' && row.executedModel.length > 0;
  if (!executed) return false;
  if (row.executionEvidence?.status !== 'direct') return false;
  // Stale or unverifiable head identity is never positive coverage.
  if (expectedHeadSha) {
    if (typeof row.headSha !== 'string' || !row.headSha) return false;
    if (row.headSha !== expectedHeadSha) return false;
  }
  return true;
}

function safeRead(path: string): DurableStageResultRow | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as DurableStageResultRow;
    }
    return null;
  } catch {
    return null;
  }
}