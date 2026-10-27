import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { backfillChallengeAttestation } from './challenge-attestation-backfill.ts';
import { SCHEMA_VERSION, type EvalRecord } from './eval-schema.ts';

function makeRecord(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    id: 'record-1',
    schemaVersion: SCHEMA_VERSION,
    originalPrompt: 'Implement a feature.',
    modelId: 'gpt-5.4',
    modelVersion: 'gpt-5.4',
    score: 1,
    scoreBand: 'Full Success',
    timeSeconds: 60,
    timestamp: '2026-08-14T10:00:00Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'Done.',
    issueId: 'HOK-1',
    agentType: 'codex',
    routingDecision: {
      candidates: [{ agentType: 'codex', modelId: 'gpt-5.4' }],
      chosen: 0,
    },
    taskDescriptor: {
      schema_version: '1.0',
      signals: {
        heuristic: {
          task_type: 'feature',
          languages: ['typescript'],
          framework_tags: [],
          files_touched: 1,
          repo_size_loc: 1000,
          description_tokens: 10,
          is_greenfield: false,
          has_migration: false,
          has_ui: false,
          has_tests: true,
          cross_service: false,
        },
      },
      constraints: {
        models_available: ['gpt-5.4', 'glm-5.2'],
      },
      stages: {
        coder: { model: 'gpt-5.4' },
      },
    },
    workflowCost: 0.5,
    outcomes: {
      success: true,
    },
    challengePairId: 'HOK-1',
    challengeSide: 'challenger',
    challengeIntent: {
      pairId: 'HOK-1',
      challengeStage: 'implementation',
      primary: {
        pairId: 'HOK-1',
        side: 'primary',
        challengeStage: 'implementation',
        expectedStageModel: 'gpt-5.4',
        expectedRoute: {
          planner: 'claude-opus-4-7',
          coder: 'gpt-5.4',
          reviewer: 'claude-opus-4-7',
        },
      },
      challenger: {
        pairId: 'HOK-1',
        side: 'challenger',
        challengeStage: 'implementation',
        expectedStageModel: 'glm-5.2',
        expectedRoute: {
          planner: 'claude-opus-4-7',
          coder: 'glm-5.2',
          reviewer: 'claude-opus-4-7',
        },
      },
    },
    challengeExecutionRoute: {
      planner: 'claude-opus-4-7',
      coder: 'gpt-5.4',
      reviewer: 'claude-opus-4-7',
    },
    ...overrides,
  } as EvalRecord;
}

function withTempFile(content: string, fn: (file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'challenge-attestation-'));
  try {
    const file = join(dir, 'evals.jsonl');
    writeFileSync(file, content, 'utf-8');
    fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('backfill quarantines records whose route disagrees with challenge intent', () => {
  withTempFile(`${JSON.stringify(makeRecord())}\n`, (file) => {
    const summary = backfillChallengeAttestation({ file, apply: true });
    const record = JSON.parse(readFileSync(file, 'utf-8').trim()) as EvalRecord;

    assert.equal(summary.quarantined, 1);
    assert.equal(record.invalidChallenge, true);
    assert.equal(record.trainingEligible, false);
    assert.equal(record.challengeDivergenceReason, 'stage_override_lost');
    assert.equal(record.nonRewardReason?.code, 'INVALID_CHALLENGE');
  });
});

test('backfill leaves consistent records byte-for-byte unchanged', () => {
  const line = JSON.stringify(makeRecord({
    modelId: 'glm-5.2',
    modelVersion: 'glm-5.2',
    challengeExecutionRoute: {
      planner: 'claude-opus-4-7',
      coder: 'glm-5.2',
      reviewer: 'claude-opus-4-7',
    },
  }));

  withTempFile(`${line}\n`, (file) => {
    const before = readFileSync(file, 'utf-8');
    const summary = backfillChallengeAttestation({ file, apply: true });
    const after = readFileSync(file, 'utf-8');

    assert.equal(summary.unchanged, 1);
    assert.equal(after, before);
  });
});

test('backfill accepts a repoDir for scoped registry lookups (HOK-3321) and behaves identically on the default registry', () => {
  const line = JSON.stringify(makeRecord({
    modelId: 'glm-5.2',
    modelVersion: 'glm-5.2',
    challengeExecutionRoute: {
      planner: 'claude-opus-4-7',
      coder: 'glm-5.2',
      reviewer: 'claude-opus-4-7',
    },
  }));

  withTempFile(`${line}\n`, (file) => {
    const summary = backfillChallengeAttestation({ file, apply: true, repoDir: tmpdir() });
    const record = JSON.parse(readFileSync(file, 'utf-8').trim()) as EvalRecord;

    assert.equal(summary.unchanged, 1);
    assert.equal(record.invalidChallenge, undefined);
  });
});

test('backfill clears stale divergence when evidence now agrees', () => {
  const record = makeRecord({
    modelId: 'glm-5.2',
    modelVersion: 'glm-5.2',
    invalidChallenge: true,
    challengeDivergenceReason: 'native_launch_fallback',
    nonRewardReason: {
      code: 'INVALID_CHALLENGE',
      message: 'Invalid challenge: native_launch_fallback',
    },
    challengeExecutionRoute: {
      planner: 'claude-opus-4-7',
      coder: 'glm-5.2',
      reviewer: 'claude-opus-4-7',
    },
  });

  withTempFile(`${JSON.stringify(record)}\n`, (file) => {
    const summary = backfillChallengeAttestation({ file, apply: true });
    const updated = JSON.parse(readFileSync(file, 'utf-8').trim()) as EvalRecord;

    assert.equal(summary.reDerived, 1);
    assert.equal(updated.invalidChallenge, undefined);
    assert.equal(updated.challengeDivergenceReason, undefined);
    assert.notEqual(updated.nonRewardReason?.code, 'INVALID_CHALLENGE');
  });
});

test('backfill fails closed for challenge records without intent', () => {
  const record = makeRecord({ challengeIntent: undefined });

  withTempFile(`${JSON.stringify(record)}\n`, (file) => {
    const summary = backfillChallengeAttestation({ file, apply: true });
    const updated = JSON.parse(readFileSync(file, 'utf-8').trim()) as EvalRecord;

    assert.equal(summary.missingIntent, 1);
    assert.equal(updated.invalidChallenge, true);
    assert.equal(updated.challengeDivergenceReason, 'missing_challenge_intent');
    assert.equal(updated.nonRewardReason?.code, 'INVALID_CHALLENGE');
  });
});

test('backfill dry-run leaves file untouched and malformed lines pass through', () => {
  const malformed = '{not json';
  const record = makeRecord();
  const content = `${malformed}\n\n${JSON.stringify(record)}\n`;

  withTempFile(content, (file) => {
    const summary = backfillChallengeAttestation({ file, apply: false });
    const after = readFileSync(file, 'utf-8');

    assert.equal(summary.malformed, 1);
    assert.equal(summary.quarantined, 1);
    assert.equal(after, content);
  });
});
