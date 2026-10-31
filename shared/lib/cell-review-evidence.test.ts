/**
 * Review/challenge evidence normalization (HOK-3361).
 * protects: provenance/coverage flags, the never-infer-absent-evidence rule,
 * stale-head and unpinned-identity exclusions, and the disk reader.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  collectReviewEvidenceFromFeatureDir,
  normalizeReviewEvidence,
  type DurableStageResultRow,
} from './cell-review-evidence.ts';

const HEAD = 'a'.repeat(40);

function reviewRow(overrides: Partial<DurableStageResultRow> = {}): DurableStageResultRow {
  return {
    stage: 'review',
    status: 'completed',
    executedModel: 'claude-haiku-4-5-20251001',
    executionEvidence: { status: 'direct', source: 'provider-response' },
    headSha: HEAD,
    recordedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('review evidence normalization', () => {
  it('protects: missing artifacts are unavailable, never proof that no reviewer ran', () => {
    const unavailable = normalizeReviewEvidence({ stageRows: [], artifactsPresent: false });
    assert.equal(unavailable.coverage, 'unavailable');
    assert.deepEqual(unavailable.reason_codes, ['feature_dir_missing']);
    assert.deepEqual(unavailable.reviewer_runs, []);
    const emptyDir = normalizeReviewEvidence({ stageRows: [], artifactsPresent: true });
    assert.equal(emptyDir.coverage, 'unavailable');
    assert.deepEqual(emptyDir.reason_codes, ['no_stage_artifact']);
  });

  it('protects: a completed, pinned, head-matching review run is evidence-backed coverage', () => {
    const evidence = normalizeReviewEvidence({ stageRows: [reviewRow()], expectedHeadSha: HEAD, artifactsPresent: true });
    assert.equal(evidence.coverage, 'available');
    assert.equal(evidence.reviewer_runs.length, 1);
    assert.equal(evidence.reviewer_runs[0]?.evidence_backed, true);
    assert.equal(evidence.reviewer_runs[0]?.head_sha_match, 'match');
    assert.ok(evidence.reason_codes.includes('reviewer_run_evidence_backed'));
  });

  it('protects: stale head evidence never counts as positive reviewer coverage', () => {
    const evidence = normalizeReviewEvidence({
      stageRows: [reviewRow({ headSha: 'b'.repeat(40) })],
      expectedHeadSha: HEAD,
      artifactsPresent: true,
    });
    assert.equal(evidence.reviewer_runs[0]?.head_sha_match, 'mismatch');
    assert.equal(evidence.reviewer_runs[0]?.evidence_backed, false);
    assert.ok(evidence.reason_codes.includes('stale_head_evidence') === false || evidence.reviewer_runs[0]?.evidence_backed === false);
  });

  it('protects: an unverifiable head identity is not positive coverage either', () => {
    const evidence = normalizeReviewEvidence({
      stageRows: [reviewRow({ headSha: undefined })],
      expectedHeadSha: HEAD,
      artifactsPresent: true,
    });
    assert.equal(evidence.reviewer_runs[0]?.head_sha_match, 'unknown');
    assert.equal(evidence.reviewer_runs[0]?.evidence_backed, false);
  });

  it('protects: an unpinned execution identity (no direct evidence) is excluded', () => {
    const evidence = normalizeReviewEvidence({
      stageRows: [reviewRow({ executionEvidence: { status: 'missing' } })],
      expectedHeadSha: HEAD,
      artifactsPresent: true,
    });
    assert.equal(evidence.reviewer_runs[0]?.evidence_backed, false);
    assert.equal(evidence.reviewer_runs[0]?.executed_model, 'claude-haiku-4-5-20251001');
  });

  it('protects: an intended model without execution proof is not coverage', () => {
    const evidence = normalizeReviewEvidence({
      stageRows: [reviewRow({ executedModel: null, intendedModel: 'gpt-5.4' })],
      artifactsPresent: true,
    });
    assert.equal(evidence.reviewer_runs[0]?.evidence_backed, false);
  });

  it('protects: challenge-stage rows are routed to challenge_runs with their own provenance', () => {
    const evidence = normalizeReviewEvidence({
      stageRows: [
        reviewRow(),
        reviewRow({ stage: 'review-challenge', artifactName: '.challenge-review-result.json' }),
      ],
      expectedHeadSha: HEAD,
      artifactsPresent: true,
    });
    assert.equal(evidence.reviewer_runs.length, 1);
    assert.equal(evidence.challenge_runs.length, 1);
    assert.equal(evidence.challenge_runs[0]?.artifact, '.challenge-review-result.json');
    assert.ok(evidence.reason_codes.includes('challenge_run_evidence_backed'));
  });

  it('protects: the disk reader normalizes durable stage-result artifacts from the feature dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cell-review-evidence-'));
    writeFileSync(join(dir, '.review-result.json'), JSON.stringify(reviewRow()));
    writeFileSync(join(dir, '.challenge-coding-result.json'), JSON.stringify(reviewRow({ stage: 'coding', artifactName: '.challenge-coding-result.json' })));
    const evidence = collectReviewEvidenceFromFeatureDir(dir, HEAD);
    assert.equal(evidence.coverage, 'available');
    assert.equal(evidence.reviewer_runs.length, 1);
    assert.equal(evidence.challenge_runs.length, 1);
  });

  it('protects: a missing feature directory is feature_dir_missing, not zero reviewers', () => {
    const evidence = collectReviewEvidenceFromFeatureDir(join(mkdtempSync(join(tmpdir(), 'cell-review-evidence-')), 'absent'), HEAD);
    assert.equal(evidence.coverage, 'unavailable');
    assert.deepEqual(evidence.reason_codes, ['feature_dir_missing']);
  });

  it('protects: malformed artifact JSON is skipped without fabricating a run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cell-review-evidence-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.review-result.json'), '{not json');
    const evidence = collectReviewEvidenceFromFeatureDir(dir);
    assert.equal(evidence.coverage, 'unavailable');
    assert.deepEqual(evidence.reason_codes, ['no_stage_artifact']);
  });
});