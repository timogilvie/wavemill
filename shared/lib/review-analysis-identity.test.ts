import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildExecutedIdentity } from './challenge-execution-contract.ts';
import {
  applyReviewAnalysisIdentity,
  clearReviewAnalysisIdentity,
  mergeReviewAnalysisIdentity,
  readReviewAnalysisIdentity,
  reviewAnalysisIdentityDeps,
  reviewAnalysisIdentityPath,
  writeReviewAnalysisIdentity,
} from './review-analysis-identity.ts';
import { writeStageResult, type StageResult } from './stage-result.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

const analysis = buildExecutedIdentity({
  role: 'substantive_analysis',
  requestedModel: 'claude-opus-5-5',
  resolvedModel: 'claude-opus-5-5',
  agent: 'claude-cli',
  source: 'artifact',
});

function reviewResult(overrides: Partial<StageResult> = {}): StageResult {
  return {
    stage: 'review',
    status: 'completed',
    startedAt: '2026-10-15T00:00:00.000Z',
    finishedAt: '2026-10-15T00:05:00.000Z',
    agent: 'claude',
    model: 'claude-opus-5-5',
    intendedModel: 'claude-opus-5-5',
    executedModel: 'claude-opus-5-5',
    executionEvidence: { status: 'direct', source: 'claude-session', recordedAt: '2026-10-15T00:05:00.000Z' },
    notes: 'PR #1 created',
    artifacts: { type: 'review', exitCode: 0, verdict: 'ready', iterations: 1, blockerCount: 0, warningCount: 0 },
    ...overrides,
  } as StageResult;
}

function tempFeatureDir(): string {
  return mkdtempSync(join(tmpdir(), 'review-analysis-identity-'));
}

describe('review analysis identity hand-off (HOK-3247)', () => {
  const originalGitHeadSha = reviewAnalysisIdentityDeps.gitHeadSha;
  afterEach(() => {
    reviewAnalysisIdentityDeps.gitHeadSha = originalGitHeadSha;
  });

  it('writes, reads and clears a head-keyed record', () => {
    const featureDir = tempFeatureDir();
    try {
      assert.equal(readReviewAnalysisIdentity(featureDir), null);
      writeReviewAnalysisIdentity(featureDir, { headSha: HEAD_A, substantiveAnalysis: analysis });
      const record = readReviewAnalysisIdentity(featureDir);
      assert.equal(record?.headSha, HEAD_A);
      assert.deepEqual(record?.substantiveAnalysis, analysis);
      clearReviewAnalysisIdentity(featureDir);
      assert.equal(existsSync(reviewAnalysisIdentityPath(featureDir)), false);

      writeFileSync(reviewAnalysisIdentityPath(featureDir), '{"schemaVersion":1,"headSha":"x"}');
      assert.equal(readReviewAnalysisIdentity(featureDir), null, 'malformed records are ignored');
    } finally {
      rmSync(featureDir, { recursive: true, force: true });
    }
  });

  it('merges a fresh record with the pane orchestrator and tags the reviewed head', () => {
    const record = { schemaVersion: 1, headSha: HEAD_A, recordedAt: 'now', substantiveAnalysis: analysis };
    const merged = mergeReviewAnalysisIdentity(
      reviewResult({ executedModel: 'claude-sonnet-5' }),
      record,
      HEAD_A,
    );
    const artifacts = merged.artifacts as Record<string, any>;
    assert.equal(artifacts.reviewHeadSha, HEAD_A);
    assert.deepEqual(artifacts.reviewExecutedIdentity.substantiveAnalysis, analysis);
    assert.equal(artifacts.reviewExecutedIdentity.remediation, null);
    // The pane ran a different model than intended: orchestrator is not pinned.
    assert.equal(artifacts.reviewExecutedIdentity.orchestrator.role, 'review_orchestrator');
    assert.equal(artifacts.reviewExecutedIdentity.orchestrator.resolvedModel, 'claude-sonnet-5');
    assert.equal(artifacts.reviewExecutedIdentity.orchestrator.pinned, false);
    assert.equal(artifacts.verdict, 'ready', 'existing review artifacts are preserved');

    const paneUnresolved = mergeReviewAnalysisIdentity(
      reviewResult({ executedModel: null, executionEvidence: { status: 'missing', source: 'x', recordedAt: 'now' } }),
      record,
      HEAD_A,
    );
    const orchestrator = (paneUnresolved.artifacts as Record<string, any>).reviewExecutedIdentity.orchestrator;
    assert.equal(orchestrator.source, 'derived');
    assert.equal(orchestrator.pinned, false);
  });

  it('ignores a stale-head record and strips an identity merged from it', () => {
    const record = { schemaVersion: 1, headSha: HEAD_A, recordedAt: 'now', substantiveAnalysis: analysis };
    const plain = reviewResult();
    assert.equal(mergeReviewAnalysisIdentity(plain, record, HEAD_B), plain);
    assert.equal(mergeReviewAnalysisIdentity(plain, record, null), plain);

    const mergedAtA = mergeReviewAnalysisIdentity(plain, record, HEAD_A);
    const afterNewCommit = mergeReviewAnalysisIdentity(mergedAtA, record, HEAD_B);
    assert.equal((afterNewCommit.artifacts as Record<string, any>).reviewExecutedIdentity, undefined);

    // A native review's own identity (not tagged with this record's head) is kept.
    const native = reviewResult({
      artifacts: {
        type: 'review',
        reviewExecutedIdentity: { orchestrator: analysis, substantiveAnalysis: analysis, remediation: null },
      } as StageResult['artifacts'],
    });
    assert.equal(mergeReviewAnalysisIdentity(native, record, HEAD_B), native);
  });

  it('never merges into a launch-time running result', () => {
    const record = { schemaVersion: 1, headSha: HEAD_A, recordedAt: 'now', substantiveAnalysis: analysis };
    const running = reviewResult({ status: 'running' });
    assert.equal(mergeReviewAnalysisIdentity(running, record, HEAD_A), running);
  });

  it('applies the record to the review stage result file', async () => {
    const featureDir = tempFeatureDir();
    try {
      await writeStageResult(featureDir, reviewResult());
      writeReviewAnalysisIdentity(featureDir, { headSha: HEAD_A, substantiveAnalysis: analysis });

      reviewAnalysisIdentityDeps.gitHeadSha = () => HEAD_B;
      assert.equal(await applyReviewAnalysisIdentity(featureDir), false, 'stale head is not merged');

      reviewAnalysisIdentityDeps.gitHeadSha = () => HEAD_A;
      assert.equal(await applyReviewAnalysisIdentity(featureDir), true);
      const written = JSON.parse(readFileSync(join(featureDir, '.review-result.json'), 'utf-8'));
      assert.equal(written.artifacts.reviewHeadSha, HEAD_A);
      assert.equal(written.artifacts.reviewExecutedIdentity.substantiveAnalysis.resolvedModel, 'claude-opus-5-5');
      assert.equal(written.artifacts.reviewExecutedIdentity.substantiveAnalysis.pinned, true);
    } finally {
      rmSync(featureDir, { recursive: true, force: true });
    }
  });

  it('stage-result-cli merges the identity on the pane agent\'s review update', () => {
    const repo = mkdtempSync(join(tmpdir(), 'review-analysis-identity-repo-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
      git('init', '-q');
      git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
      const head = git('rev-parse', 'HEAD');
      const featureDir = join(repo, 'features', 'slug');
      mkdirSync(featureDir, { recursive: true });

      const cli = (artifacts: string) => execFileSync(
        process.execPath,
        [join(REPO_ROOT, 'tools', 'stage-result-cli.ts'), 'update', featureDir, 'review',
          '--status', 'completed', '--notes', 'PR #1 created', '--artifacts', artifacts],
        { cwd: REPO_ROOT, encoding: 'utf-8' },
      );
      const artifacts = JSON.stringify({ type: 'review', prNumber: 1, exitCode: 0, verdict: 'ready', iterations: 1, blockerCount: 0, warningCount: 0 });

      // A record from an earlier head is never merged.
      writeReviewAnalysisIdentity(featureDir, { headSha: 'c'.repeat(40), substantiveAnalysis: analysis });
      cli(artifacts);
      let written = JSON.parse(readFileSync(join(featureDir, '.review-result.json'), 'utf-8'));
      assert.equal(written.artifacts.reviewExecutedIdentity, undefined);

      writeReviewAnalysisIdentity(featureDir, { headSha: head, substantiveAnalysis: analysis });
      cli(artifacts);
      written = JSON.parse(readFileSync(join(featureDir, '.review-result.json'), 'utf-8'));
      assert.equal(written.artifacts.verdict, 'ready');
      assert.equal(written.artifacts.reviewHeadSha, head);
      assert.equal(written.artifacts.reviewExecutedIdentity.substantiveAnalysis.resolvedModel, 'claude-opus-5-5');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// HOK-3260: the hand-off also carries the native analysis loop usage so the
// review stage result keeps its prompt-cache numbers.
describe('review analysis identity hand-off — usage (HOK-3260)', () => {
  const usage = { turnsCompleted: 6, cacheReadTokens: 9000, cacheWriteTokens: 1200, cacheHitRate: 0.81, providerRoute: 'anthropic' };
  const record = { schemaVersion: 1, headSha: HEAD_A, recordedAt: 'now', substantiveAnalysis: analysis, usage };

  it('round-trips usage through the side file', () => {
    const featureDir = tempFeatureDir();
    try {
      writeReviewAnalysisIdentity(featureDir, { headSha: HEAD_A, substantiveAnalysis: analysis, usage });
      assert.deepEqual(readReviewAnalysisIdentity(featureDir)?.usage, usage);
    } finally {
      rmSync(featureDir, { recursive: true, force: true });
    }
  });

  it('merges usage at the reviewed head and strips it once the head moves', () => {
    const merged = mergeReviewAnalysisIdentity(reviewResult(), record, HEAD_A);
    assert.deepEqual((merged.artifacts as Record<string, any>).usage, usage);

    const afterNewCommit = mergeReviewAnalysisIdentity(merged, record, HEAD_B);
    assert.equal((afterNewCommit.artifacts as Record<string, any>).usage, undefined);
  });

  it('leaves usage absent for a record without it', () => {
    const { usage: _usage, ...withoutUsage } = record;
    const merged = mergeReviewAnalysisIdentity(reviewResult(), withoutUsage, HEAD_A);
    assert.equal('usage' in (merged.artifacts as Record<string, unknown>), false);
  });
});
