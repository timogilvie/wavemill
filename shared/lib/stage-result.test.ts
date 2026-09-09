/**
 * Tests for stage-result module (HOK-1192)
 *
 * Covers read/write/update helpers, atomic writes, malformed input handling,
 * artifact round-trips, and backward compatibility.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  writeStageResult,
  writeStageResultWithHistory,
  readStageResult,
  readAllStageResults,
  updateStageResult,
  extractReviewOutcome,
  getResultFilePath,
  isInfrastructureReviewFailure,
  isValidBlockerDismissal,
  isValidStage,
  isValidStatus,
  reviewEffectiveBlockerCount,
  reviewOutcomePassesReadyGate,
  reviewResultPassed,
  NATIVE_CONTEXT_WINDOW_EXCEEDED_CATEGORY,
  PROVIDER_CREDIT_EXHAUSTED_CATEGORY,
} from './stage-result.ts';
import type {
  StageResult,
  PlanningArtifacts,
  CodingArtifacts,
  ReviewArtifacts,
  ReadyArtifacts,
} from './stage-result.ts';

let testDir: string;

async function createTestDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'stage-result-test-'));
}

function makeResult(overrides: Partial<StageResult> = {}): StageResult {
  return {
    stage: 'planning',
    status: 'running',
    startedAt: '2026-04-09T10:00:00Z',
    finishedAt: null,
    agent: 'claude',
    model: 'claude-opus-4-6',
    notes: '',
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────
// getResultFilePath
// ────────────────────────────────────────────────────────────────

describe('getResultFilePath', () => {
  it('returns correct path for each stage', () => {
    assert.equal(getResultFilePath('/tmp/feat', 'planning'), '/tmp/feat/.planning-result.json');
    assert.equal(getResultFilePath('/tmp/feat', 'coding'), '/tmp/feat/.coding-result.json');
    assert.equal(getResultFilePath('/tmp/feat', 'review'), '/tmp/feat/.review-result.json');
    assert.equal(getResultFilePath('/tmp/feat', 'ready'), '/tmp/feat/.ready-result.json');
  });
});

// ────────────────────────────────────────────────────────────────
// writeStageResult + readStageResult round-trip
// ────────────────────────────────────────────────────────────────

describe('writeStageResult and readStageResult', () => {
  beforeEach(async () => { testDir = await createTestDir(); });
  afterEach(async () => { await fs.rm(testDir, { recursive: true, force: true }); });

  it('round-trips a basic result', async () => {
    const result = makeResult();
    await writeStageResult(testDir, result);

    const read = await readStageResult(testDir, 'planning');
    assert.deepEqual(read, result);
  });

  it('round-trips native agent and model fields', async () => {
    const result = makeResult({
      agent: 'native',
      model: 'pi-standard-20260101',
    });
    await writeStageResult(testDir, result);

    const read = await readStageResult(testDir, 'planning');
    assert.equal(read?.agent, 'native');
    assert.equal(read?.model, 'pi-standard-20260101');
  });

  it('round-trips cleanup fields', async () => {
    const result = makeResult({
      stage: 'coding',
      finalTreeState: 'dirty-unrecoverable',
      cleanupDecision: 'left-in-place',
      cleanupReport: {
        reason: 'aborted',
        terminatedCommands: [],
        partialMutations: [{ tool: 'write_artifact', status: 'completed', path: 'features/demo/out.txt' }],
        finalTreeState: 'dirty-unrecoverable',
        cleanupDecision: 'left-in-place',
        runTouchedPaths: ['features/demo/out.txt'],
        rollbackResults: [],
        notes: ['reported'],
      },
    });
    await writeStageResult(testDir, result);

    const read = await readStageResult(testDir, 'coding');
    assert.equal(read?.finalTreeState, 'dirty-unrecoverable');
    assert.equal(read?.cleanupDecision, 'left-in-place');
    assert.equal(read?.cleanupReport?.reason, 'aborted');
  });

  it('overwrites existing file completely', async () => {
    const first = makeResult({ notes: 'first' });
    await writeStageResult(testDir, first);

    const second = makeResult({ notes: 'second', status: 'completed', finishedAt: '2026-04-09T11:00:00Z' });
    await writeStageResult(testDir, second);

    const read = await readStageResult(testDir, 'planning');
    assert.equal(read?.notes, 'second');
    assert.equal(read?.status, 'completed');
  });

  it('creates feature directory if missing', async () => {
    const nestedDir = path.join(testDir, 'sub', 'dir');
    await writeStageResult(nestedDir, makeResult());

    const read = await readStageResult(nestedDir, 'planning');
    assert.equal(read?.status, 'running');
  });

  it('writes pretty-printed JSON', async () => {
    await writeStageResult(testDir, makeResult());
    const raw = await fs.readFile(getResultFilePath(testDir, 'planning'), 'utf-8');
    assert.ok(raw.includes('\n  "stage"'), 'Expected 2-space indented JSON');
  });

  it('cleans up temp file after atomic write', async () => {
    await writeStageResult(testDir, makeResult());
    const files = await fs.readdir(testDir);
    const tmpFiles = files.filter(f => f.startsWith('.tmp-'));
    assert.equal(tmpFiles.length, 0, 'No temp files should remain');
  });

  it('stage-result-cli write preserves history after write-with-history', async () => {
    const failed = makeResult({
      stage: 'coding',
      status: 'failed',
      finishedAt: '2026-04-09T11:00:00Z',
      notes: 'invalid artifact',
    });
    await writeStageResult(testDir, failed);

    execFileSync('npx', ['tsx', 'tools/stage-result-cli.ts', 'write-with-history', testDir, 'coding', 'running', '--agent', 'native', '--model', 'glm-5.2'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });
    execFileSync('npx', ['tsx', 'tools/stage-result-cli.ts', 'write', testDir, 'coding', 'completed', '--agent', 'native', '--model', 'glm-5.2'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    const read = await readStageResult(testDir, 'coding');
    assert.equal(read?.status, 'completed');
    assert.equal(read?.history?.length, 1);
    assert.equal(read?.history?.[0].status, 'failed');
  });
});

// ────────────────────────────────────────────────────────────────
// readStageResult error cases
// ────────────────────────────────────────────────────────────────

describe('readStageResult error handling', () => {
  beforeEach(async () => { testDir = await createTestDir(); });
  afterEach(async () => { await fs.rm(testDir, { recursive: true, force: true }); });

  it('returns null for missing file', async () => {
    const result = await readStageResult(testDir, 'coding');
    assert.equal(result, null);
  });

  it('returns null for empty file', async () => {
    await fs.writeFile(path.join(testDir, '.coding-result.json'), '');
    const result = await readStageResult(testDir, 'coding');
    assert.equal(result, null);
  });

  it('returns null for malformed JSON', async () => {
    await fs.writeFile(path.join(testDir, '.coding-result.json'), '{broken json');
    const result = await readStageResult(testDir, 'coding');
    assert.equal(result, null);
  });

  it('returns null when stage field mismatches filename', async () => {
    const result = makeResult({ stage: 'review' });
    await fs.writeFile(
      path.join(testDir, '.coding-result.json'),
      JSON.stringify(result),
    );
    const read = await readStageResult(testDir, 'coding');
    assert.equal(read, null);
  });

  it('returns null when status field is missing', async () => {
    await fs.writeFile(
      path.join(testDir, '.coding-result.json'),
      JSON.stringify({ stage: 'coding', startedAt: '2026-01-01T00:00:00Z' }),
    );
    const read = await readStageResult(testDir, 'coding');
    assert.equal(read, null);
  });

  it('returns null for nonexistent directory', async () => {
    const result = await readStageResult('/nonexistent/path', 'planning');
    assert.equal(result, null);
  });
});

// ────────────────────────────────────────────────────────────────
// readAllStageResults
// ────────────────────────────────────────────────────────────────

describe('readAllStageResults', () => {
  beforeEach(async () => { testDir = await createTestDir(); });
  afterEach(async () => { await fs.rm(testDir, { recursive: true, force: true }); });

  it('returns empty map when no files exist', async () => {
    const results = await readAllStageResults(testDir);
    assert.deepEqual(results, {});
  });

  it('reads multiple stage files', async () => {
    await writeStageResult(testDir, makeResult({ stage: 'planning', status: 'completed' }));
    await writeStageResult(testDir, makeResult({ stage: 'coding', status: 'running' }));

    const results = await readAllStageResults(testDir);
    assert.equal(results.planning?.status, 'completed');
    assert.equal(results.coding?.status, 'running');
    assert.equal(results.review, undefined);
    assert.equal(results.ready, undefined);
  });

  it('skips invalid files', async () => {
    await writeStageResult(testDir, makeResult({ stage: 'planning', status: 'completed' }));
    await fs.writeFile(path.join(testDir, '.coding-result.json'), 'not json');

    const results = await readAllStageResults(testDir);
    assert.equal(results.planning?.status, 'completed');
    assert.equal(results.coding, undefined);
  });
});

// ────────────────────────────────────────────────────────────────
// updateStageResult
// ────────────────────────────────────────────────────────────────

describe('updateStageResult', () => {
  beforeEach(async () => { testDir = await createTestDir(); });
  afterEach(async () => { await fs.rm(testDir, { recursive: true, force: true }); });

  it('merges patch into existing result', async () => {
    await writeStageResult(testDir, makeResult({
      stage: 'review',
      status: 'running',
      startedAt: '2026-04-09T10:00:00Z',
      agent: 'claude',
      model: 'opus-4-6',
    }));

    await updateStageResult(testDir, 'review', {
      status: 'completed',
      finishedAt: '2026-04-09T10:30:00Z',
      artifacts: { type: 'review', findingsCount: 2 },
    });

    const read = await readStageResult(testDir, 'review');
    assert.equal(read?.status, 'completed');
    assert.equal(read?.startedAt, '2026-04-09T10:00:00Z'); // preserved
    assert.equal(read?.finishedAt, '2026-04-09T10:30:00Z');
    assert.equal(read?.agent, 'claude'); // preserved
    assert.deepEqual(read?.artifacts, { type: 'review', findingsCount: 2 });
  });

  it('creates new file when none exists', async () => {
    await updateStageResult(testDir, 'coding', {
      status: 'running',
      agent: 'codex',
      model: 'gpt-5',
    });

    const read = await readStageResult(testDir, 'coding');
    assert.equal(read?.status, 'running');
    assert.equal(read?.stage, 'coding');
    assert.equal(read?.agent, 'codex');
    assert.ok(read?.startedAt); // auto-set
  });

  it('preserves startedAt from existing result', async () => {
    const originalStart = '2026-04-09T08:00:00Z';
    await writeStageResult(testDir, makeResult({
      stage: 'coding',
      startedAt: originalStart,
    }));

    await updateStageResult(testDir, 'coding', { status: 'completed' });

    const read = await readStageResult(testDir, 'coding');
    assert.equal(read?.startedAt, originalStart);
  });

  it('allows explicit startedAt override in patch', async () => {
    await writeStageResult(testDir, makeResult({
      stage: 'coding',
      startedAt: '2026-04-09T08:00:00Z',
    }));

    const override = '2026-04-09T09:00:00Z';
    await updateStageResult(testDir, 'coding', { startedAt: override });

    const read = await readStageResult(testDir, 'coding');
    assert.equal(read?.startedAt, override);
  });

  it('enforces stage from argument, not patch', async () => {
    await updateStageResult(testDir, 'ready', {
      stage: 'planning' as any, // try to override
      status: 'running',
    });

    const read = await readStageResult(testDir, 'ready');
    assert.equal(read?.stage, 'ready');
  });

  it('sets null failureReason explicitly', async () => {
    await updateStageResult(testDir, 'coding', {
      status: 'running',
      failureReason: null,
    });

    const read = await readStageResult(testDir, 'coding');
    assert.equal(read?.failureReason, null);
  });

  it('updates stage with native agent and model', async () => {
    await writeStageResult(testDir, makeResult({
      stage: 'coding',
      status: 'running',
      agent: 'claude',
      model: 'opus-4-6',
    }));

    await updateStageResult(testDir, 'coding', {
      status: 'completed',
      agent: 'native',
      model: 'pi-reasoning-20260201',
    });

    const read = await readStageResult(testDir, 'coding');
    assert.equal(read?.status, 'completed');
    assert.equal(read?.agent, 'native');
    assert.equal(read?.model, 'pi-reasoning-20260201');
  });
});

// ────────────────────────────────────────────────────────────────
// writeStageResultWithHistory
// ────────────────────────────────────────────────────────────────

describe('writeStageResultWithHistory', () => {
  beforeEach(async () => { testDir = await createTestDir(); });
  afterEach(async () => { await fs.rm(testDir, { recursive: true, force: true }); });

  it('archives a failed current result and writes running top-level state', async () => {
    await writeStageResult(testDir, makeResult({
      stage: 'coding',
      status: 'failed',
      finishedAt: '2026-04-09T11:00:00Z',
      agent: 'native-openrouter',
      model: 'kimi-k2.7-code',
      notes: 'provider error',
    }));

    await writeStageResultWithHistory(testDir, 'coding', {
      status: 'running',
      agent: 'native-openrouter',
      model: 'kimi-k2.7-code',
      notes: 'recovered',
    });

    const read = await readStageResult(testDir, 'coding');
    assert.equal(read?.status, 'running');
    assert.equal(read?.finishedAt, null);
    assert.equal(read?.history?.length, 1);
    assert.equal(read?.history?.[0]?.status, 'failed');
    assert.equal(read?.history?.[0]?.model, 'kimi-k2.7-code');
  });

  it('archives an aborted result and appends to existing history', async () => {
    await writeStageResult(testDir, {
      ...makeResult({
        stage: 'review',
        status: 'aborted',
        finishedAt: '2026-04-09T11:00:00Z',
        agent: 'claude',
        model: 'claude-sonnet-5',
        notes: 'stopped',
      }),
      history: [{
        status: 'failed',
        agent: 'claude',
        model: 'claude-sonnet-5',
        startedAt: '2026-04-09T08:00:00Z',
        finishedAt: '2026-04-09T09:00:00Z',
        notes: 'first failure',
      }],
    });

    await writeStageResultWithHistory(testDir, 'review', {
      status: 'running',
      agent: 'claude',
      model: 'claude-sonnet-5',
    });

    const read = await readStageResult(testDir, 'review');
    assert.equal(read?.status, 'running');
    assert.equal(read?.history?.length, 2);
    assert.equal(read?.history?.[0]?.notes, 'first failure');
    assert.equal(read?.history?.[1]?.status, 'aborted');
  });
});

// ────────────────────────────────────────────────────────────────
// Artifacts round-trip
// ────────────────────────────────────────────────────────────────

describe('artifacts round-trip', () => {
  beforeEach(async () => { testDir = await createTestDir(); });
  afterEach(async () => { await fs.rm(testDir, { recursive: true, force: true }); });

  it('round-trips PlanningArtifacts', async () => {
    const artifacts: PlanningArtifacts = {
      type: 'planning',
      planFile: 'plan.md',
      taskPacketFile: 'task-packet.md',
      bounds: {
        maxTurns: 40,
        maxToolCalls: 120,
        maxWallClockMs: 1200000,
      },
      usage: {
        turnsCompleted: 12,
        toolCallsExecuted: 31,
        wallClockMs: 300000,
        totalInputTokens: 10000,
        totalOutputTokens: 2000,
        totalCostUsd: 0.25,
      },
      planArtifactValid: true,
      approvalReady: true,
      promptRef: {
        id: 'native-planning',
        version: 'sha256:abc',
      },
    };
    await writeStageResult(testDir, makeResult({ stage: 'planning', artifacts }));

    const read = await readStageResult(testDir, 'planning');
    assert.deepEqual(read?.artifacts, artifacts);
  });

  it('round-trips CodingArtifacts', async () => {
    const artifacts: CodingArtifacts = { type: 'coding', filesChanged: 5, linesAdded: 200, linesRemoved: 50, commitCount: 3 };
    await writeStageResult(testDir, makeResult({ stage: 'coding', artifacts }));

    const read = await readStageResult(testDir, 'coding');
    assert.deepEqual(read?.artifacts, artifacts);
  });

  it('round-trips ReviewArtifacts', async () => {
    const artifacts: ReviewArtifacts = {
      type: 'review',
      prNumber: 42,
      prUrl: 'https://github.com/org/repo/pull/42',
      findingsCount: 3,
      blockingIssues: 1,
      exitCode: 1,
      verdict: 'not_ready',
      iterations: 2,
      blockerCount: 1,
      warningCount: 2,
    };
    await writeStageResult(testDir, makeResult({ stage: 'review', artifacts }));

    const read = await readStageResult(testDir, 'review');
    assert.deepEqual(read?.artifacts, artifacts);
  });

  it('round-trips ReadyArtifacts', async () => {
    const artifacts: ReadyArtifacts = { type: 'ready', verdict: 'pass', checksRun: 4, checksPassed: 4, mergeConflict: 'CLEAN' };
    await writeStageResult(testDir, makeResult({ stage: 'ready', artifacts }));

    const read = await readStageResult(testDir, 'ready');
    assert.deepEqual(read?.artifacts, artifacts);
  });

  it('handles result without artifacts (backward compat)', async () => {
    // Write a result without artifacts (simulating old format)
    const result = makeResult();
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(
      path.join(testDir, '.planning-result.json'),
      JSON.stringify(result, null, 2),
    );

    const read = await readStageResult(testDir, 'planning');
    assert.equal(read?.artifacts, undefined);
    assert.equal(read?.status, 'running');
  });
});

// ────────────────────────────────────────────────────────────────
// review outcome helpers
// ────────────────────────────────────────────────────────────────

describe('review outcome helpers', () => {
  it('passes only with explicit final successful self-review evidence', () => {
    const result = makeResult({
      stage: 'review',
      status: 'completed',
      artifacts: {
        type: 'review',
        prNumber: 42,
        exitCode: 0,
        verdict: 'ready',
        iterations: 1,
        blockerCount: 0,
        warningCount: 1,
      },
    });

    assert.equal(reviewResultPassed(result), true);
    assert.deepEqual(extractReviewOutcome(result), {
      exitCode: 0,
      verdict: 'ready',
      iterations: 1,
      blockerCount: 0,
      warningCount: 1,
      dismissedBlockers: undefined,
      reviewToolError: undefined,
      failureCategory: undefined,
      diagnostics: undefined,
    });
  });

  it('fails closed when review evidence is missing or non-passing', () => {
    const cases: StageResult[] = [
      makeResult({ stage: 'review', status: 'completed' }),
      makeResult({ stage: 'review', status: 'completed', artifacts: { type: 'review', blockerCount: 0 } }),
      makeResult({ stage: 'review', status: 'completed', artifacts: { type: 'review', exitCode: 1, verdict: 'not_ready', iterations: 1, blockerCount: 0 } }),
      makeResult({ stage: 'review', status: 'completed', artifacts: { type: 'review', exitCode: 2, verdict: 'error', iterations: 1, blockerCount: 0 } }),
      makeResult({ stage: 'review', status: 'completed', artifacts: { type: 'review', exitCode: 0, verdict: 'ready', iterations: 1, blockerCount: 1 } }),
      makeResult({ stage: 'review', status: 'completed', artifacts: { type: 'review', exitCode: 0, verdict: 'ready', blockerCount: 0 } }),
    ];

    for (const testCase of cases) {
      assert.equal(reviewResultPassed(testCase), false);
    }
  });

  it('passes a completed not_ready artifact whose every blocker is validly dismissed (HOK-2932)', () => {
    const result = makeResult({
      stage: 'review',
      status: 'completed',
      artifacts: {
        type: 'review',
        prNumber: 1282,
        exitCode: 1,
        verdict: 'not_ready',
        iterations: 2,
        blockerCount: 1,
        warningCount: 0,
        dismissedBlockers: [
          {
            location: 'scope-guard',
            category: 'plan_compliance',
            description: 'Diff includes files from three already-merged PRs',
            justification: 'False positive: auto/integration is behind main; the PR diff is five in-scope files.',
            evidence: 'git log auto/integration..HEAD -- shared/lib/model-promotion.ts tools/promote-provisional-model.ts',
          },
        ],
      },
    });

    assert.equal(reviewResultPassed(result), true);
    const outcome = extractReviewOutcome(result);
    assert.equal(outcome?.blockerCount, 1);
    assert.equal(outcome?.dismissedBlockers?.length, 1);
    assert.equal(reviewEffectiveBlockerCount(outcome), 0);
  });

  it('keeps raw blockerCount while gating on the effective count', () => {
    const outcome = extractReviewOutcome(makeResult({
      stage: 'review',
      status: 'completed',
      artifacts: {
        type: 'review',
        exitCode: 1,
        verdict: 'not_ready',
        iterations: 1,
        blockerCount: 2,
        dismissedBlockers: [{ justification: 'disproved with a repro attempt' }],
      },
    }));
    assert.equal(outcome?.blockerCount, 2);
    assert.equal(reviewEffectiveBlockerCount(outcome), 1);
    assert.equal(reviewOutcomePassesReadyGate(outcome), false);
  });

  it('fails closed on invalid or mismatched dismissals', () => {
    const base = {
      stage: 'review' as const,
      status: 'completed' as const,
    };
    const cases: StageResult[] = [
      // Dismissal without justification is rejected.
      makeResult({ ...base, artifacts: { type: 'review', exitCode: 1, verdict: 'not_ready', iterations: 1, blockerCount: 1, dismissedBlockers: [{ description: 'x' }] } }),
      // Blank justification is rejected.
      makeResult({ ...base, artifacts: { type: 'review', exitCode: 1, verdict: 'not_ready', iterations: 1, blockerCount: 1, dismissedBlockers: [{ justification: '   ' }] } }),
      // One valid dismissal, one undismissed blocker remaining.
      makeResult({ ...base, artifacts: { type: 'review', exitCode: 1, verdict: 'not_ready', iterations: 1, blockerCount: 2, dismissedBlockers: [{ justification: 'valid' }] } }),
      // More dismissals than raw blockers is a count mismatch.
      makeResult({ ...base, artifacts: { type: 'review', exitCode: 1, verdict: 'not_ready', iterations: 1, blockerCount: 1, dismissedBlockers: [{ justification: 'a' }, { justification: 'b' }] } }),
      // Non-object entries never count.
      makeResult({ ...base, artifacts: { type: 'review', exitCode: 1, verdict: 'not_ready', iterations: 1, blockerCount: 1, dismissedBlockers: ['all fine'] } as never }),
      // Error verdicts never pass through dismissals.
      makeResult({ ...base, artifacts: { type: 'review', exitCode: 2, verdict: 'error', iterations: 1, blockerCount: 1, dismissedBlockers: [{ justification: 'valid' }] } }),
    ];

    for (const testCase of cases) {
      assert.equal(reviewResultPassed(testCase), false);
    }
  });

  it('validates dismissal justifications', () => {
    assert.equal(isValidBlockerDismissal({ justification: 'diff verified clean' }), true);
    assert.equal(isValidBlockerDismissal({ justification: '  ' }), false);
    assert.equal(isValidBlockerDismissal({}), false);
    assert.equal(isValidBlockerDismissal(undefined), false);
  });

  it('extracts nested native review artifacts during transition', () => {
    const result = makeResult({
      stage: 'review',
      status: 'completed',
      artifacts: {
        review: {
          exitCode: 0,
          verdict: 'ready',
          iterations: 2,
          blockingCount: 0,
          warningCount: 3,
        },
      } as StageResult['artifacts'],
    });

    assert.equal(reviewResultPassed(result), true);
    assert.deepEqual(extractReviewOutcome(result), {
      exitCode: 0,
      verdict: 'ready',
      iterations: 2,
      blockerCount: 0,
      warningCount: 3,
      dismissedBlockers: undefined,
      reviewToolError: undefined,
      failureCategory: undefined,
      diagnostics: undefined,
    });
  });

  it('extracts failureCategory from flat and nested review artifacts', () => {
    const flat = makeResult({
      stage: 'review',
      status: 'completed',
      artifacts: {
        type: 'review',
        exitCode: 0,
        verdict: 'not_ready',
        iterations: 1,
        blockerCount: 1,
        failureCategory: 'native-runtime-unavailable',
      },
    });
    assert.equal(extractReviewOutcome(flat)?.failureCategory, 'native-runtime-unavailable');
    assert.equal(isInfrastructureReviewFailure(flat), true);

    const nested = makeResult({
      stage: 'review',
      status: 'completed',
      artifacts: {
        review: {
          exitCode: 0,
          verdict: 'not_ready',
          iterations: 1,
          blockerCount: 1,
          failureCategory: 'native-review-prompt-missing',
        },
      } as StageResult['artifacts'],
    });
    assert.equal(extractReviewOutcome(nested)?.failureCategory, 'native-review-prompt-missing');
    assert.equal(isInfrastructureReviewFailure(nested), true);
  });

  it('classifies review-scope-unverifiable as retryable infrastructure in both artifact shapes', () => {
    const flat = makeResult({
      stage: 'review',
      status: 'completed',
      artifacts: {
        type: 'review',
        exitCode: 1,
        verdict: 'not_ready',
        iterations: 1,
        blockerCount: 1,
        failureCategory: 'review-scope-unverifiable',
      },
    });
    assert.equal(extractReviewOutcome(flat)?.failureCategory, 'review-scope-unverifiable');
    assert.equal(isInfrastructureReviewFailure(flat), true);

    const nested = makeResult({
      stage: 'review',
      status: 'completed',
      artifacts: {
        review: {
          exitCode: 1,
          verdict: 'not_ready',
          iterations: 1,
          blockerCount: 1,
          failureCategory: 'review-scope-unverifiable',
        },
      } as StageResult['artifacts'],
    });
    assert.equal(extractReviewOutcome(nested)?.failureCategory, 'review-scope-unverifiable');
    assert.equal(isInfrastructureReviewFailure(nested), true);
  });

  it('classifies native-context-window-exceeded as retryable infrastructure regardless of verdict (HOK-2964 REQ-F1)', () => {
    const flat = makeResult({
      stage: 'review',
      status: 'completed',
      artifacts: {
        type: 'review',
        exitCode: 1,
        verdict: 'not_ready',
        iterations: 1,
        blockerCount: 1,
        failureCategory: NATIVE_CONTEXT_WINDOW_EXCEEDED_CATEGORY,
      },
    });
    assert.equal(extractReviewOutcome(flat)?.failureCategory, 'native-context-window-exceeded');
    assert.equal(isInfrastructureReviewFailure(flat), true);

    const nested = makeResult({
      stage: 'review',
      status: 'completed',
      artifacts: {
        review: {
          exitCode: 1,
          verdict: 'not_ready',
          iterations: 1,
          blockerCount: 1,
          failureCategory: NATIVE_CONTEXT_WINDOW_EXCEEDED_CATEGORY,
        },
      } as StageResult['artifacts'],
    });
    assert.equal(isInfrastructureReviewFailure(nested), true);
  });

  it('classifies provider-credit-exhausted as retryable infrastructure (HOK-2964 REQ-F5)', () => {
    const flat = makeResult({
      stage: 'review',
      status: 'completed',
      artifacts: {
        type: 'review',
        exitCode: 1,
        verdict: 'not_ready',
        iterations: 1,
        blockerCount: 1,
        failureCategory: PROVIDER_CREDIT_EXHAUSTED_CATEGORY,
      },
    });
    assert.equal(extractReviewOutcome(flat)?.failureCategory, 'provider-credit-exhausted');
    assert.equal(isInfrastructureReviewFailure(flat), true);
  });

  it('never classifies a genuine code-blocker not_ready as infrastructure (HOK-2964 REQ-F7)', () => {
    const flat = makeResult({
      stage: 'review',
      status: 'completed',
      artifacts: {
        type: 'review',
        exitCode: 1,
        verdict: 'not_ready',
        iterations: 1,
        blockerCount: 1,
      },
    });
    assert.equal(extractReviewOutcome(flat)?.failureCategory, undefined);
    assert.equal(isInfrastructureReviewFailure(flat), false);
  });

  it('classifies only retryable infrastructure review failures', () => {
    assert.equal(isInfrastructureReviewFailure({
      type: 'review',
      verdict: 'not_ready',
      failureCategory: 'native-runtime-unavailable',
    }), true);
    assert.equal(isInfrastructureReviewFailure({
      verdict: 'error',
      reviewToolError: 'spawnSync /bin/bash ETIMEDOUT',
    }), true);
    assert.equal(isInfrastructureReviewFailure({
      type: 'review',
      verdict: 'not_ready',
      failureCategory: 'review-scope-unverifiable',
    }), true);
    assert.equal(isInfrastructureReviewFailure({
      type: 'review',
      verdict: 'not_ready',
      blockerCount: 1,
    }), false);
    assert.equal(isInfrastructureReviewFailure({
      type: 'review',
      verdict: 'not_ready',
      failureCategory: 'native-review-malformed-response',
    }), false);
  });
});

// ────────────────────────────────────────────────────────────────
// failureReason round-trip
// ────────────────────────────────────────────────────────────────

describe('failureReason round-trip', () => {
  beforeEach(async () => { testDir = await createTestDir(); });
  afterEach(async () => { await fs.rm(testDir, { recursive: true, force: true }); });

  it('round-trips failureReason string', async () => {
    const result = makeResult({
      stage: 'coding',
      status: 'failed',
      failureReason: 'Tests failed: 3 assertions failed',
      finishedAt: '2026-04-09T11:00:00Z',
    });
    await writeStageResult(testDir, result);

    const read = await readStageResult(testDir, 'coding');
    assert.equal(read?.failureReason, 'Tests failed: 3 assertions failed');
  });

  it('round-trips null failureReason', async () => {
    const result = makeResult({ stage: 'coding', failureReason: null });
    await writeStageResult(testDir, result);

    const read = await readStageResult(testDir, 'coding');
    assert.equal(read?.failureReason, null);
  });

  it('handles result without failureReason (backward compat)', async () => {
    // Write without failureReason field at all
    const result = makeResult();
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(
      path.join(testDir, '.planning-result.json'),
      JSON.stringify(result, null, 2),
    );

    const read = await readStageResult(testDir, 'planning');
    assert.equal(read?.failureReason, undefined);
  });
});

// ────────────────────────────────────────────────────────────────
// Validation helpers
// ────────────────────────────────────────────────────────────────

describe('isValidStage', () => {
  it('accepts valid stages', () => {
    assert.ok(isValidStage('planning'));
    assert.ok(isValidStage('coding'));
    assert.ok(isValidStage('review'));
    assert.ok(isValidStage('ready'));
  });

  it('rejects invalid stages', () => {
    assert.ok(!isValidStage('routing'));
    assert.ok(!isValidStage(''));
    assert.ok(!isValidStage('PLANNING'));
  });
});

describe('isValidStatus', () => {
  it('accepts valid statuses', () => {
    assert.ok(isValidStatus('running'));
    assert.ok(isValidStatus('awaiting_user'));
    assert.ok(isValidStatus('completed'));
    assert.ok(isValidStatus('aborted'));
    assert.ok(isValidStatus('failed'));
  });

  it('rejects invalid statuses', () => {
    assert.ok(!isValidStatus('pending'));
    assert.ok(!isValidStatus(''));
    assert.ok(!isValidStatus('RUNNING'));
  });
});
