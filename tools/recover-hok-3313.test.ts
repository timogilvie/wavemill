import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CORRECTION_REASON, recoverHok3313 } from './recover-hok-3313.ts';
import { validateEvalRecord } from '../shared/lib/eval-validator.ts';

const NOW = () => '2026-10-26T18:00:00.000Z';

interface ArmSpec {
  id: string;
  side: 'primary' | 'challenger';
  modelId: string;
  executedPlanningModel?: string;
  invalid?: boolean;
  divergenceReason?: string;
}

function makeEvalRecord(arm: ArmSpec): Record<string, unknown> {
  return {
    id: arm.id,
    schemaVersion: '1.0.0',
    originalPrompt: 'One-stage agent exit identity comes from the launch record.',
    modelId: arm.modelId,
    modelVersion: arm.modelId,
    score: arm.side === 'challenger' ? 0.93 : 0.9,
    scoreBand: 'Full Success',
    timeSeconds: 245,
    timestamp: '2026-10-26T15:00:00.000Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'Planning challenge arm completed.',
    issueId: 'HOK-3313',
    prUrl: arm.side === 'challenger' ? 'https://example.test/pull/2' : 'https://example.test/pull/1',
    agentType: 'codex',
    challengePairId: 'PAIR-3313',
    challengeSide: arm.side,
    challengeStage: 'plan',
    ...(arm.executedPlanningModel
      ? {
          executedPlanning: {
            agent: 'codex',
            model: arm.executedPlanningModel,
            status: 'completed',
            source: '.planning-result.json',
          },
        }
      : {}),
    ...(arm.invalid || arm.divergenceReason
      ? {
          invalidChallenge: arm.invalid === true,
          challengeDivergenceReason: arm.divergenceReason,
          nonRewardReason: { code: 'INVALID_CHALLENGE', message: `Invalid challenge: ${arm.divergenceReason}` },
        }
      : {}),
    challengeIntent: {
      pairId: 'PAIR-3313',
      issueId: 'HOK-3313',
      createdAt: '2026-10-26T14:10:00.000Z',
      selectedStage: 'plan',
      decisionSource: 'expanded',
      selectionPath: 'recommendation-driven',
      selectionReason: 'stage_coverage_gap',
      challengerSource: 'recommendation',
      primary: {
        pairId: 'PAIR-3313',
        side: 'primary',
        challengeStage: 'plan',
        expectedStageModel: 'claude-opus-4-6',
        expectedRoute: {
          planner: 'claude-opus-4-6',
          coder: 'claude-opus-4-6',
          reviewer: 'claude-opus-4-6',
          planDepth: '',
          codeDepth: '',
          reviewMode: '',
        },
      },
      challenger: {
        pairId: 'PAIR-3313',
        side: 'challenger',
        challengeStage: 'plan',
        expectedStageModel: 'qwen-3-coder',
        expectedRoute: {
          planner: 'qwen-3-coder',
          coder: 'claude-opus-4-6',
          reviewer: 'claude-opus-4-6',
          planDepth: '',
          codeDepth: '',
          reviewMode: '',
        },
      },
    },
    challengeExecutionRoute: {
      planner: 'qwen-3-coder',
      coder: 'claude-opus-4-6',
      reviewer: 'claude-opus-4-6',
      planDepth: '',
      codeDepth: '',
      reviewMode: '',
    },
    taskDescriptor: {
      schema_version: '1.0',
      signals: {
        heuristic: {
          task_type: 'feature',
          languages: ['typescript'],
          framework_tags: [],
          files_touched: 2,
          repo_size_loc: 1000,
          description_tokens: 20,
          is_greenfield: false,
          has_migration: false,
          has_ui: false,
          has_tests: true,
          cross_service: false,
        },
        learned: { complexity: 4, domain: 'eval', risk_flags: [] },
      },
      constraints: {
        models_available: ['qwen-3-coder', 'claude-opus-4-6'],
        objective: 'balanced',
      },
      stages: {
        planner: { model: 'qwen-3-coder' },
        coder: { model: 'claude-opus-4-6' },
        reviewer: { model: 'claude-opus-4-6' },
      },
    },
  };
}

function seedRepo(records: Array<Record<string, unknown>>, challengeRows: Array<Record<string, unknown>> = []): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'recover-hok-3313-'));
  const evalsDir = join(repoDir, '.wavemill', 'evals');
  mkdirSync(evalsDir, { recursive: true });
  writeFileSync(join(evalsDir, 'evals.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  writeFileSync(join(evalsDir, 'challenge-records.jsonl'), challengeRows.map((r) => JSON.stringify(r)).join('\n') + (challengeRows.length ? '\n' : ''));
  return repoDir;
}

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const INVALID_ROW = {
  challengePairId: 'PAIR-3313',
  comparisonOutcome: 'invalid_challenge',
  invalidChallenge: true,
  invalidChallengeReason: 'stage_override_lost',
  timestamp: '2026-10-26T15:30:00.000Z',
  primaryModel: 'claude-opus-4-6',
  challengerModel: 'qwen-3-coder',
};

describe('recover-hok-3313', () => {
  it('dry-run re-attests the alias false-positive without touching any file', () => {
    const primary = makeEvalRecord({ id: 'eval-primary', side: 'primary', modelId: 'claude-opus-4-6' });
    const challenger = makeEvalRecord({
      id: 'eval-challenger',
      side: 'challenger',
      modelId: 'qwen-3-coder',
      executedPlanningModel: 'qwen/qwen3-coder',
      invalid: true,
      divergenceReason: 'stage_override_lost',
    });
    const repoDir = seedRepo([primary, challenger], [INVALID_ROW]);
    try {
      const before = readFileSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl'), 'utf-8');
      const summary = recoverHok3313({ repoDir, evalIds: ['eval-challenger'], now: NOW });

      assert.equal(summary.write, false);
      assert.equal(summary.entries[0]?.disposition, 're-attested');
      assert.equal(summary.entries[0]?.after?.validity, 'valid');
      assert.equal(summary.entries[0]?.after?.invalidChallenge, false);
      assert.equal(summary.evalsToAppend, 1);
      assert.equal(summary.comparisonsToAppend, 1);
      assert.equal(summary.evalsAppended, 0);
      assert.equal(summary.comparisonsAppended, 0);
      assert.equal(readFileSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl'), 'utf-8'), before);
      assert.equal(existsSync(join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl')), true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('--write appends the corrected eval record and the superseding comparison, originals intact', () => {
    const primary = makeEvalRecord({ id: 'eval-primary', side: 'primary', modelId: 'claude-opus-4-6' });
    const challenger = makeEvalRecord({
      id: 'eval-challenger',
      side: 'challenger',
      modelId: 'qwen-3-coder',
      executedPlanningModel: 'qwen/qwen3-coder',
      invalid: true,
      divergenceReason: 'stage_override_lost',
    });
    const repoDir = seedRepo([primary, challenger], [INVALID_ROW]);
    try {
      const summary = recoverHok3313({ repoDir, evalIds: ['eval-challenger'], write: true, now: NOW });

      assert.equal(summary.evalsAppended, 1);
      assert.equal(summary.comparisonsAppended, 1);

      const evals = readJsonl(join(repoDir, '.wavemill', 'evals', 'evals.jsonl'));
      assert.equal(evals.length, 3);
      assert.equal(evals[0]?.id, 'eval-primary');
      assert.equal(evals[1]?.id, 'eval-challenger');
      assert.equal(evals[1]?.invalidChallenge, true, 'original invalid row is never rewritten');
      const corrected = evals[2]!;
      assert.notEqual(corrected.id, 'eval-challenger');
      assert.equal(corrected.invalidChallenge, undefined);
      assert.equal(corrected.challengeDivergenceReason, undefined);
      assert.equal(corrected.executedPlanning && (corrected.executedPlanning as { model?: string }).model, 'qwen/qwen3-coder', 'provider identity is untouched');
      const provenance = corrected.correctionProvenance as { supersedes: { evalId: string; reason: string } } | undefined;
      assert.equal(provenance?.supersedes.evalId, 'eval-challenger');
      assert.equal(provenance?.supersedes.reason, CORRECTION_REASON);
      assert.equal((corrected.challengeExecutionEvidence as { validity?: string } | undefined)?.validity, 'valid');
      assert.deepEqual(
        validateEvalRecord(corrected, { file: '<test>', line: 0 }).filter((issue) => issue.code === 'SCHEMA_VIOLATION'),
        [],
      );

      const rows = readJsonl(join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl'));
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.invalidChallenge, true, 'original comparison row is never rewritten');
      const superseding = rows[1]!;
      assert.equal(superseding.comparisonOutcome, 'compared');
      assert.equal(superseding.invalidChallenge, false);
      assert.equal(superseding.winner, 'challenger');
      assert.equal(superseding.primaryModel, 'claude-opus-4-6');
      assert.equal(superseding.challengerModel, 'qwen/qwen3-coder');
      assert.equal((superseding.recoveryProvenance as { tool?: string } | undefined)?.tool, 'recover-hok-3313');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('refuses to recover a genuinely different executed model', () => {
    const challenger = makeEvalRecord({
      id: 'eval-substituted',
      side: 'challenger',
      modelId: 'qwen-3-coder',
      executedPlanningModel: 'claude-haiku-4-5',
      invalid: true,
      divergenceReason: 'stage_override_lost',
    });
    const repoDir = seedRepo([challenger], [INVALID_ROW]);
    try {
      const before = readFileSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl'), 'utf-8');
      const summary = recoverHok3313({ repoDir, evalIds: ['eval-substituted'], write: true, now: NOW });

      assert.equal(summary.entries[0]?.disposition, 'ineligible-genuinely-invalid');
      assert.equal(summary.entries[0]?.reason, 'stage_override_lost');
      assert.equal(summary.evalsAppended, 0);
      assert.equal(summary.comparisonsAppended, 0);
      assert.equal(readFileSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl'), 'utf-8'), before);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('is idempotent: an already-recovered eval id is skipped', () => {
    const challenger = makeEvalRecord({
      id: 'eval-challenger',
      side: 'challenger',
      modelId: 'qwen-3-coder',
      executedPlanningModel: 'qwen/qwen3-coder',
      invalid: true,
      divergenceReason: 'stage_override_lost',
    });
    const recovered = {
      ...makeEvalRecord({
        id: 'eval-challenger-corrected',
        side: 'challenger',
        modelId: 'qwen-3-coder',
        executedPlanningModel: 'qwen/qwen3-coder',
      }),
      correctionProvenance: { supersedes: { evalId: 'eval-challenger', reason: CORRECTION_REASON } },
    };
    const repoDir = seedRepo([challenger, recovered], [INVALID_ROW]);
    try {
      const summary = recoverHok3313({ repoDir, evalIds: ['eval-challenger'], write: true, now: NOW });

      assert.equal(summary.entries[0]?.disposition, 'already-recovered');
      assert.equal(summary.evalsAppended, 0);
      assert.equal(summary.comparisonsAppended, 0);
      assert.equal(readJsonl(join(repoDir, '.wavemill', 'evals', 'evals.jsonl')).length, 2);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('fails closed on unknown eval ids and refuses to run without ids', () => {
    const repoDir = seedRepo([]);
    try {
      const summary = recoverHok3313({ repoDir, evalIds: ['nope'], now: NOW });
      assert.equal(summary.entries[0]?.disposition, 'not-found');

      assert.throws(() => recoverHok3313({ repoDir, evalIds: [], now: NOW }), /requires at least one eval ID/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
