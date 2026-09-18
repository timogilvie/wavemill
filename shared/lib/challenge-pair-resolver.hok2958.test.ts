/**
 * HOK-2970 / HOK-2958 regression suite: when a challenge arm aborts with an
 * `invalidChallenge: true` eval, the resolver must NOT stamp a `forfeit` row
 * that hands the win to the surviving arm. It must emit `invalid_challenge`
 * with no winner and preserve `forkStage` on the terminal record.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readChallengeComparisons } from './challenge-comparison.ts';
import { resolveUnresolvablePair } from './challenge-pair-resolver.ts';
import { SCHEMA_VERSION, type EvalRecord } from './eval-schema.ts';

function setupRepoDir(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-hok2958-'));
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({ integration: { integrationBranch: 'auto/integration' } }),
  );
  return { repoDir, cleanup: () => rmSync(repoDir, { recursive: true, force: true }) };
}

function writeWorkflowState(repoDir: string, tasks: Record<string, unknown>): void {
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), JSON.stringify({ tasks, jobs: {} }));
}

function appendEvalJsonl(repoDir: string, record: EvalRecord): void {
  const path = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
  writeFileSync(path, JSON.stringify(record) + '\n', { flag: 'a' });
}

function makeEval(overrides: Partial<EvalRecord>): EvalRecord {
  return {
    id: overrides.id ?? '550e8400-e29b-41d4-a716-446655440601',
    schemaVersion: SCHEMA_VERSION,
    originalPrompt: 'Reviewer-stage challenge eval fixture.',
    modelId: overrides.modelId ?? 'gpt-5.5',
    modelVersion: overrides.modelId ?? 'gpt-5.5',
    score: 0,
    scoreBand: 'Blocked',
    timeSeconds: 0,
    timestamp: '2026-09-16T00:00:00Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'Invalid challenge fixture.',
    ...overrides,
  } as EvalRecord;
}

const REVIEW_INTENT = {
  schemaVersion: 1,
  pairId: 'HOK-2958',
  issueId: 'HOK-2958',
  challengeStage: 'review',
  forkStage: 'review',
  sharedPrefix: true,
  primary: { pairId: 'HOK-2958', side: 'primary', challengeStage: 'review', expectedStageModel: 'gpt-5.5', expectedRoute: { planner: '', coder: '', reviewer: 'gpt-5.5', planDepth: '', codeDepth: '', reviewMode: '' } },
  challenger: { pairId: 'HOK-2958', side: 'challenger', challengeStage: 'review', expectedStageModel: 'kimi-k3', expectedRoute: { planner: '', coder: '', reviewer: 'kimi-k3', planDepth: '', codeDepth: '', reviewMode: '' } },
} as const;

test('HOK-2958: sibling-aborted with invalidChallenge eval emits invalid_challenge, not forfeit', async () => {
  const { repoDir, cleanup } = setupRepoDir();
  try {
    writeWorkflowState(repoDir, {
      HOK_2958: {
        pr: 1500,
        branch: 'task/hok2958-primary',
        updated: '2026-09-16T00:00:00Z',
        challengePairId: 'HOK-2958',
        challengeRole: 'primary',
        challengeModel: 'gpt-5.5',
        evalCompleted: true,
        challengeExecutionIntent: REVIEW_INTENT,
      },
      HOK_2958_c: {
        pr: 1501,
        branch: 'task/hok2958-challenger',
        updated: '2026-09-16T00:00:00Z',
        challengePairId: 'HOK-2958',
        challengeRole: 'challenger',
        challengeModel: 'gemini-2.5-pro',
        challengeAborted: 'invalid_challenge:missing_challenge_intent',
        challengeAbortedStage: 'review',
      },
    });
    appendEvalJsonl(repoDir, makeEval({
      id: '550e8400-e29b-41d4-a716-446655440701',
      modelId: 'gemini-2.5-pro',
      challengePairId: 'HOK-2958',
      challengeSide: 'challenger',
      invalidChallenge: true,
      challengeDivergenceReason: 'missing_challenge_intent',
      nonRewardReason: { code: 'INVALID_CHALLENGE', message: 'missing_challenge_intent' },
    }));

    const result = await resolveUnresolvablePair({ pairId: 'HOK-2958', repoDir });
    assert.equal(result.status, 'resolved');
    assert.equal(result.reason, 'sibling-challenge-aborted');
    assert.equal(result.outcome, 'invalid_challenge');
    assert.equal(result.record.comparisonOutcome, 'invalid_challenge');
    assert.equal(result.record.invalidChallenge, true);
    assert.equal(result.record.winner, undefined);
    assert.equal(result.record.winnerModel, undefined);
    assert.equal(result.record.forkStage, 'review');
    assert.equal(result.record.sharedPrefix, true);
    assert.equal(result.record.terminalReason, 'challenger_challenge_aborted');
    assert.equal(result.record.noComparisonReason, 'missing_challenge_intent');
    assert.equal(readChallengeComparisons(join(repoDir, '.wavemill', 'evals')).length, 1);
  } finally {
    cleanup();
  }
});

test('HOK-2958: primary aborted with invalidChallenge eval → invalid_challenge (symmetric)', async () => {
  const { repoDir, cleanup } = setupRepoDir();
  try {
    writeWorkflowState(repoDir, {
      HOK_2958: {
        pr: 1500,
        branch: 'task/hok2958-primary',
        updated: '2026-09-16T00:00:00Z',
        challengePairId: 'HOK-2958',
        challengeRole: 'primary',
        challengeModel: 'gpt-5.5',
        challengeAborted: 'invalid_challenge:missing_challenge_intent',
        challengeAbortedStage: 'review',
        challengeExecutionIntent: REVIEW_INTENT,
      },
      HOK_2958_c: {
        pr: 1501,
        branch: 'task/hok2958-challenger',
        updated: '2026-09-16T00:00:00Z',
        challengePairId: 'HOK-2958',
        challengeRole: 'challenger',
        challengeModel: 'kimi-k3',
        evalCompleted: true,
      },
    });
    appendEvalJsonl(repoDir, makeEval({
      id: '550e8400-e29b-41d4-a716-446655440702',
      modelId: 'gpt-5.5',
      challengePairId: 'HOK-2958',
      challengeSide: 'primary',
      invalidChallenge: true,
      challengeDivergenceReason: 'missing_challenge_intent',
    }));

    const result = await resolveUnresolvablePair({ pairId: 'HOK-2958', repoDir });
    assert.equal(result.status, 'resolved');
    assert.equal(result.outcome, 'invalid_challenge');
    assert.equal(result.record.winner, undefined);
    assert.equal(result.record.terminalReason, 'primary_challenge_aborted');
    assert.equal(result.record.forkStage, 'review');
  } finally {
    cleanup();
  }
});

test('HOK-2958: legitimate abort (no invalidChallenge eval) still yields forfeit with winner', async () => {
  const { repoDir, cleanup } = setupRepoDir();
  try {
    writeWorkflowState(repoDir, {
      HOK_2958: {
        pr: 1500,
        branch: 'task/hok2958-primary',
        updated: '2026-09-16T00:00:00Z',
        challengePairId: 'HOK-2958-clean',
        challengeRole: 'primary',
        challengeModel: 'gpt-5.5',
        evalCompleted: true,
        challengeExecutionIntent: REVIEW_INTENT,
      },
      HOK_2958_c: {
        pr: 1501,
        branch: 'task/hok2958-challenger',
        updated: '2026-09-16T00:00:00Z',
        challengePairId: 'HOK-2958-clean',
        challengeRole: 'challenger',
        challengeModel: 'gemini-2.5-pro',
        challengeAborted: 'terminal_stage_failure:tool-use-unsupported',
        challengeAbortedStage: 'coding',
      },
    });
    appendEvalJsonl(repoDir, makeEval({
      id: '550e8400-e29b-41d4-a716-446655440703',
      modelId: 'gemini-2.5-pro',
      challengePairId: 'HOK-2958-clean',
      challengeSide: 'challenger',
      invalidChallenge: false,
    }));

    const result = await resolveUnresolvablePair({ pairId: 'HOK-2958-clean', repoDir });
    assert.equal(result.status, 'resolved');
    assert.equal(result.outcome, 'forfeit');
    assert.equal(result.record.comparisonOutcome, 'forfeit');
    assert.equal(result.record.winner, 'primary');
  } finally {
    cleanup();
  }
});
