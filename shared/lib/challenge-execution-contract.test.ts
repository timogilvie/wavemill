import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { SCHEMA_VERSION, type EvalRecord } from './eval-schema.ts';
import {
  foldAttestationsIntoStageAttribution,
  INVALID_CHALLENGE_REASONS,
  isStageAttributionEligibleForCoverage,
  STAGE_ATTRIBUTION_REASON_CODES,
  resolveChallengeSide,
  buildChallengeExecutionIntent,
  enforceChallengeIntentPresence,
  projectChallengeIntentForPersistence,
  type ChallengeExecutionAttestation,
  type ChallengeExecutionIntent,
  type ForkIdentity,
  type InvalidChallengeReason,
  type ReviewExecutedIdentitySet,
} from './challenge-execution-contract.ts';
import { attachChallengeExecutionMetadata } from './eval-record-builder.ts';
import { appendEvalRecord, readEvalRecords } from './eval-persistence.ts';
import { validateEvalRecord } from './eval-validator.ts';
import { toHokusaiSubmission } from './hokusai-schema.ts';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default || require('ajv/dist/2020');
const __dirname = dirname(fileURLToPath(import.meta.url));
const evalSchema = JSON.parse(readFileSync(join(__dirname, 'eval-schema.json'), 'utf-8'));
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const validateChallengeIntent = ajv.compile({
  ...evalSchema.$defs.ChallengeExecutionIntent,
  $defs: evalSchema.$defs,
});

function makeRuntimeIntent(overrides: Partial<ChallengeExecutionIntent> = {}): ChallengeExecutionIntent {
  return {
    schemaVersion: 1,
    pairId: 'pair-2604',
    issueId: 'HOK-2604',
    createdAt: '2026-08-03T11:46:50Z',
    selectedStage: 'implementation',
    decisionSource: 'expanded',
    selectionPath: 'recommendation-driven',
    selectionReason: 'stage_coverage_gap',
    challengerSource: 'recommendation',
    routeContext: {
      decisionSource: 'expanded',
      bootstrapRoute: {
        planner: 'claude-opus-4-6',
        coder: 'claude-opus-4-6',
        reviewer: 'claude-opus-4-6',
      },
    },
    challengeRecommendation: {
      shouldChallenge: true,
      score: 0.93,
      reason: 'low-data-stage',
      challengerModel: 'gpt-5.4',
      defaultModel: 'claude-opus-4-6',
      stage: 'implementation',
    },
    nativeCertificationRejections: [{
      modelId: 'native-openrouter/example',
      role: 'coder',
      requestedLaunchPhase: 'coding',
      requestedPhase: 'patch',
      nativeCapability: 'workflow',
      requiredSuiteVersion: '1',
      reason: 'missing-artifact',
      artifactPath: '/tmp/native-cert.json',
    }],
    modelExclusions: [{
      modelId: 'slow-model',
      stage: 'coding',
      source: 'repo',
      reason: 'disabled for this repo',
    }],
    fallbackReason: 'recommended_stage_plan_fell_back_to_implementation',
    primary: {
      key: 'HOK-2604',
      role: 'primary',
      planner: { model: 'claude-opus-4-6', agent: 'claude' },
      coder: { model: 'claude-opus-4-6', agent: 'claude' },
      reviewer: { model: 'claude-opus-4-6', agent: 'claude' },
    },
    challenger: {
      key: 'HOK-2604_c',
      role: 'challenger',
      planner: { model: 'claude-opus-4-6', agent: 'claude' },
      coder: { model: 'gpt-5.4', agent: 'codex' },
      reviewer: { model: 'claude-opus-4-6', agent: 'claude' },
    },
    ...overrides,
  };
}

function makeRecord(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    id: '550e8400-e29b-41d4-a716-446655440610',
    schemaVersion: SCHEMA_VERSION,
    originalPrompt: 'Harden post PR CI handling.',
    modelId: 'claude-opus-4-6',
    modelVersion: 'claude-opus-4-6',
    score: 1,
    scoreBand: 'Full Success',
    timeSeconds: 245,
    timestamp: '2026-08-03T11:46:50Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'Task completed autonomously.',
    issueId: 'HOK-2604',
    prUrl: 'https://github.com/org/repo/pull/1037',
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
        learned: {
          complexity: 4,
          domain: 'eval',
          risk_flags: [],
        },
      },
      constraints: {
        models_available: ['claude-opus-4-6', 'gpt-5.4'],
        objective: 'balanced',
      },
      stages: {
        planner: { model: 'claude-opus-4-6' },
        coder: { model: 'claude-opus-4-6' },
        reviewer: { model: 'claude-opus-4-6' },
      },
    },
    ...overrides,
  };
}

function makeAttestation(
  side: 'primary' | 'challenger',
  overrides: Partial<ChallengeExecutionAttestation> = {},
): ChallengeExecutionAttestation {
  return {
    pairId: 'pair-2968',
    side,
    validity: 'valid',
    challengeStage: 'review',
    expectedStageModel: side === 'primary' ? 'claude-opus-4-6' : 'gpt-5.4',
    evidence: [{
      stage: 'review',
      model: side === 'primary' ? 'claude-opus-4-6' : 'gpt-5.4',
      source: 'review-result',
    }],
    ...overrides,
  };
}

function makeForkIdentity(overrides: Partial<ForkIdentity> = {}): ForkIdentity {
  return {
    stage: 'review',
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    taskPacketHash: 'c'.repeat(64),
    planHash: 'd'.repeat(64),
    promptHash: 'e'.repeat(64),
    toolConfigHash: 'f'.repeat(64),
    ...overrides,
  };
}

function makeReviewIdentitySet(): ReviewExecutedIdentitySet {
  return {
    orchestrator: {
      role: 'review_orchestrator',
      requestedModel: 'claude-opus-4-6',
      resolvedModel: 'claude-opus-4-6',
      source: 'route',
      pinned: true,
    },
    substantiveAnalysis: {
      role: 'substantive_analysis',
      requestedModel: 'claude-opus-4-6',
      resolvedModel: 'claude-opus-4-6',
      source: 'artifact',
      pinned: true,
    },
    remediation: null,
  };
}

test('stage attribution reason codes inherit invalid challenge reasons', () => {
  for (const reason of INVALID_CHALLENGE_REASONS) {
    assert.ok(STAGE_ATTRIBUTION_REASON_CODES.includes(reason));
  }
});

test('foldAttestationsIntoStageAttribution emits valid attribution for matched inputs', () => {
  const attribution = foldAttestationsIntoStageAttribution({
    pairId: 'pair-2968',
    stage: 'review',
    primary: makeAttestation('primary'),
    challenger: makeAttestation('challenger'),
    evidenceProvenance: 'direct',
    forkIdentity: makeForkIdentity(),
    primaryReviewIdentity: makeReviewIdentitySet(),
    challengerReviewIdentity: makeReviewIdentitySet(),
    judgeWinner: 'primary',
  });
  assert.equal(attribution.status, 'valid');
  assert.equal(attribution.outcome, 'primary');
  assert.deepEqual(attribution.reasonCodes, []);
  assert.equal(attribution.winningStageModel, 'claude-opus-4-6');
  assert.equal(isStageAttributionEligibleForCoverage(attribution), true);
});

test('foldAttestationsIntoStageAttribution marks incomplete review iteration evidence insufficient (HOK-2969)', () => {
  const attribution = foldAttestationsIntoStageAttribution({
    pairId: 'pair-2968',
    stage: 'review',
    primary: makeAttestation('primary'),
    challenger: makeAttestation('challenger'),
    evidenceProvenance: 'direct',
    forkIdentity: makeForkIdentity(),
    primaryReviewIdentity: makeReviewIdentitySet(),
    challengerReviewIdentity: makeReviewIdentitySet(),
    reviewIterationsComplete: false,
    judgeWinner: 'primary',
  });
  assert.equal(attribution.status, 'insufficient_evidence');
  assert.ok(attribution.reasonCodes.includes('insufficient_review_iterations'));
  assert.equal(attribution.outcome, null);
});

test('foldAttestationsIntoStageAttribution lifts invalid attestation reasons', () => {
  const attribution = foldAttestationsIntoStageAttribution({
    pairId: 'pair-2968',
    stage: 'implementation',
    primary: makeAttestation('primary', {
      challengeStage: 'implementation',
      validity: 'invalid_challenge',
      invalidReason: 'native_launch_fallback',
      invalidDetails: 'Expected model fell back at launch.',
      evidence: [{ stage: 'implementation', model: 'fallback-model' }],
    }),
    challenger: makeAttestation('challenger', {
      challengeStage: 'implementation',
      expectedStageModel: 'gpt-5.4',
      evidence: [{ stage: 'implementation', model: 'gpt-5.4' }],
    }),
    evidenceProvenance: 'direct',
    forkIdentity: makeForkIdentity({ stage: 'implementation' }),
    judgeWinner: 'challenger',
  });
  assert.equal(attribution.status, 'invalid');
  assert.equal(attribution.outcome, null);
  assert.ok(attribution.reasonCodes.includes('native_launch_fallback'));
  assert.match(attribution.reasonDetails ?? '', /fell back/);
});

test('foldAttestationsIntoStageAttribution marks missing reviewer evidence insufficient', () => {
  const attribution = foldAttestationsIntoStageAttribution({
    pairId: 'pair-2968',
    stage: 'review',
    primary: makeAttestation('primary'),
    challenger: makeAttestation('challenger'),
    forkIdentity: makeForkIdentity(),
    primaryReviewIdentity: makeReviewIdentitySet(),
    challengerReviewIdentity: makeReviewIdentitySet(),
    judgeWinner: 'primary',
  });
  assert.equal(attribution.status, 'insufficient_evidence');
  assert.deepEqual(attribution.reasonCodes, ['missing_direct_review_evidence']);
  assert.equal(attribution.evidenceProvenance, 'insufficient');
});

test('foldAttestationsIntoStageAttribution suppresses direct evidence on divergent hashes', () => {
  const attribution = foldAttestationsIntoStageAttribution({
    pairId: 'pair-2968',
    stage: 'review',
    primary: makeAttestation('primary'),
    challenger: makeAttestation('challenger'),
    evidenceProvenance: 'direct',
    forkIdentity: makeForkIdentity({ planHash: null }),
    primaryReviewIdentity: makeReviewIdentitySet(),
    challengerReviewIdentity: makeReviewIdentitySet(),
    judgeWinner: 'primary',
  });
  assert.equal(attribution.status, 'invalid');
  assert.ok(attribution.reasonCodes.includes('plan_hash_mismatch'));
  assert.ok(attribution.reasonCodes.includes('divergent_pre_stage_inputs'));
  assert.equal(attribution.divergentInputsSuppressedDirectEvidence, true);
  assert.equal(isStageAttributionEligibleForCoverage(attribution), false);
});

test('runtime ChallengeExecutionIntent satisfies the JSON schema contract', () => {
  const intent = makeRuntimeIntent();
  assert.equal(validateChallengeIntent(intent), true, JSON.stringify(validateChallengeIntent.errors));
});

test('projectChallengeIntentForPersistence preserves eval fields and omits runtime-only diagnostics', () => {
  const projected = projectChallengeIntentForPersistence(makeRuntimeIntent());
  assert.ok(projected);
  assert.equal(projected.pairId, 'pair-2604');
  assert.equal(projected.challengeStage, 'implementation');
  assert.equal(projected.decisionSource, 'expanded');
  assert.equal(projected.selectedStage, 'implementation');
  assert.equal(projected.primary.expectedStageModel, 'claude-opus-4-6');
  assert.equal(projected.challenger.expectedStageModel, 'gpt-5.4');
  assert.equal(projected.challenger.expectedRoute.coder, 'gpt-5.4');

  const raw = projected as unknown as Record<string, unknown>;
  assert.equal('selectionPath' in raw, false);
  assert.equal('challengeRecommendation' in raw, false);
  assert.equal('nativeCertificationRejections' in raw, false);
  assert.equal('modelExclusions' in raw, false);
  assert.equal(validateChallengeIntent(projected), true, JSON.stringify(validateChallengeIntent.errors));
});

test('projection accepts the legacy compact intent emitted before HOK-2610', () => {
  const legacy = buildChallengeExecutionIntent({
    pairId: 'pair-legacy',
    challengeStage: 'implementation',
    primary: {
      model: 'claude-opus-4-6',
      planner: 'claude-opus-4-6',
      reviewer: 'claude-opus-4-6',
      planDepth: 'standard',
      codeDepth: 'standard',
      reviewMode: 'standard',
    },
    challenger: {
      model: 'gpt-5.4',
      planner: 'claude-opus-4-6',
      reviewer: 'claude-opus-4-6',
      planDepth: 'standard',
      codeDepth: 'deep',
      reviewMode: 'standard',
    },
  });
  const projected = projectChallengeIntentForPersistence(legacy);
  assert.deepEqual(projected, {
    pairId: 'pair-legacy',
    challengeStage: 'implementation',
    primary: legacy.primary,
    challenger: legacy.challenger,
  });
});

test('builder to AJV validation to JSONL persistence works for primary and challenger', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'challenge-contract-'));
  try {
    const intent = makeRuntimeIntent();
    const primary = makeRecord({
      id: 'primary-record',
      challengePairId: 'pair-2604',
      challengeSide: 'primary',
    });
    primary.challengePairId = 'pair-2604';
    attachChallengeExecutionMetadata(primary, {
      side: 'primary',
      intent,
    });
    assert.equal(validateEvalRecord(primary, { file: '<test>', line: 0 }).filter((issue) => issue.code === 'SCHEMA_VIOLATION').length, 0);
    appendEvalRecord(primary, { dir: tmp });

    const challenger = makeRecord({
      id: 'challenger-record',
      issueId: 'HOK-2604_c',
      prUrl: 'https://github.com/org/repo/pull/1038',
      modelId: 'gpt-5.4',
      modelVersion: 'gpt-5.4',
    });
    challenger.challengePairId = 'pair-2604';
    attachChallengeExecutionMetadata(challenger, {
      side: 'challenger',
      intent,
    });
    assert.equal(validateEvalRecord(challenger, { file: '<test>', line: 0 }).filter((issue) => issue.code === 'SCHEMA_VIOLATION').length, 0);
    appendEvalRecord(challenger, { dir: tmp });

    const records = readEvalRecords({ dir: tmp });
    assert.equal(records.length, 2);
    assert.equal(records[0].challengeIntent?.primary.expectedRoute.coder, 'claude-opus-4-6');
    assert.equal(records[1].challengeIntent?.challenger.expectedRoute.coder, 'gpt-5.4');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('schema remains strict for unmodeled runtime fields', () => {
  const intent = {
    ...makeRuntimeIntent(),
    unmodeledRuntimeField: true,
  };
  assert.equal(validateChallengeIntent(intent), false);
  assert.ok(validateChallengeIntent.errors?.some((error: { keyword: string }) => error.keyword === 'additionalProperties'));
});

test('historical eval record with challenge intent remains valid', () => {
  const legacy = buildChallengeExecutionIntent({
    pairId: 'pair-history',
    challengeStage: 'review',
    primary: {
      model: 'claude-opus-4-6',
      planner: 'claude-opus-4-6',
      reviewer: 'claude-opus-4-6',
      planDepth: 'standard',
      codeDepth: 'standard',
      reviewMode: 'standard',
    },
    challenger: {
      model: 'claude-opus-4-6',
      planner: 'claude-opus-4-6',
      reviewer: 'gpt-5.4',
      planDepth: 'standard',
      codeDepth: 'standard',
      reviewMode: 'deep',
    },
  });
  const record = makeRecord({
    schemaVersion: '1.34.0',
    challengePairId: 'pair-history',
    challengeSide: 'challenger',
    challengeIntent: legacy,
    challengeExecutionRoute: legacy.challenger.expectedRoute,
  });
  assert.equal(validateEvalRecord(record, { file: '<test>', line: 0 }).filter((issue) => issue.code === 'SCHEMA_VIOLATION').length, 0);
});

test('Hokusai submission boundary omits local challenge contract keys', () => {
  const record = makeRecord();
  const challengeIntent = projectChallengeIntentForPersistence(makeRuntimeIntent());
  assert.ok(challengeIntent);
  record.challengePairId = 'pair-2604';
  record.challengeSide = 'primary';
  record.challengeIntent = challengeIntent;
  record.challengeExecutionRoute = challengeIntent.primary.expectedRoute;
  const submission = toHokusaiSubmission(record);
  assert.equal(submission.ok, true);
  const payload = submission.ok ? submission.submission as unknown as Record<string, unknown> : {};
  assert.equal('challengePairId' in payload, false);
  assert.equal('challengeSide' in payload, false);
  assert.equal('challengeIntent' in payload, false);
  assert.equal('challengeExecutionRoute' in payload, false);
});

// --- reviewer execution identity / evidence must stay local (HOK-2969) ---
//
// toHokusaiSubmission is an allowlist builder, so a new EvalRecord field
// never automatically crosses the privacy boundary — but this pins that
// guarantee for the reviewer-identity fields this task introduces, and
// proves raw finding/evidence text specifically never leaks even when
// present deep inside `reviewExecutedIdentity` or `challengeStageEval`.

test('Hokusai submission boundary omits reviewer execution identity and raw review evidence text', () => {
  const record = makeRecord();
  record.reviewExecutedIdentity = makeReviewIdentitySet();
  record.challengeStageEval = {
    stage: 'review',
    provenance: 'direct',
    summary: 'Direct review evidence captured from self-review output and review result artifacts.',
    evidence: [{
      label: 'review_result',
      summary: 'RAW-SECRET-FINDING-TEXT-SHOULD-NEVER-LEAK',
      source: '.review-result.json',
    }],
  };

  const submission = toHokusaiSubmission(record);
  assert.equal(submission.ok, true);
  const serialized = JSON.stringify(submission.ok ? submission.submission : {});
  const payload = submission.ok ? submission.submission as unknown as Record<string, unknown> : {};

  assert.equal('reviewExecutedIdentity' in payload, false);
  assert.equal('challengeStageEval' in payload, false);
  assert.doesNotMatch(serialized, /RAW-SECRET-FINDING-TEXT-SHOULD-NEVER-LEAK/);
});

// --- a challenge record without an intent must not pass as clean evidence ---
//
// attestEvalRecordChallengeExecution returns undefined when there is no intent,
// so such a record used to land with no verdict AND trainingEligible left
// intact. Silence read as success, which is how an arm whose selected model had
// been replaced by rerouting still counted as evidence for the model that ran.

test('a challenge record with no intent is marked invalid rather than training-eligible', () => {
  const record = makeRecord({ trainingEligible: true });
  record.challengePairId = 'HOK-2726';
  record.challengeSide = 'challenger';

  const marked = enforceChallengeIntentPresence(record, 'HOK-2726');

  assert.equal(marked, true);
  assert.equal(record.invalidChallenge, true);
  assert.equal(record.trainingEligible, false);
  assert.equal(record.challengeDivergenceReason, 'missing_challenge_intent');
  assert.equal(record.nonRewardReason?.code, 'INVALID_CHALLENGE');
});

test('a challenge record that carries an intent is left alone', () => {
  const intent = projectChallengeIntentForPersistence(makeRuntimeIntent());
  assert.ok(intent);
  const record = makeRecord({ trainingEligible: true });
  record.challengePairId = 'HOK-2726';
  record.challengeSide = 'primary';
  record.challengeIntent = intent!;

  assert.equal(enforceChallengeIntentPresence(record, 'HOK-2726'), false);
  assert.equal(record.invalidChallenge, undefined);
  assert.equal(record.trainingEligible, true);
});

test('a non-challenge record is never touched by the intent guard', () => {
  const record = makeRecord({ trainingEligible: true });

  assert.equal(enforceChallengeIntentPresence(record, undefined), false);
  assert.equal(record.invalidChallenge, undefined);
  assert.equal(record.trainingEligible, true);
});

test('every TypeScript divergence reason is accepted by the eval JSON schema', () => {
  const validateReason = ajv.compile({
    ...evalSchema.$defs.InvalidChallengeReason,
    $defs: evalSchema.$defs,
  });
  // Mirrors the InvalidChallengeReason union. The schema enum had already
  // drifted (operator_reroute was missing), so pin both directions here.
  const reasons: InvalidChallengeReason[] = [
    'stage_override_lost',
    'native_launch_fallback',
    'identical_effective_route',
    'state_vs_derived_side_mismatch',
    'operator_reroute',
    'missing_challenge_intent',
  ];
  for (const reason of reasons) {
    assert.equal(validateReason(reason), true, `schema rejects divergence reason ${reason}`);
  }
  assert.deepEqual(
    [...(evalSchema.$defs.InvalidChallengeReason.enum as string[])].sort(),
    [...reasons].sort(),
    'eval-schema.json enum and the InvalidChallengeReason union have drifted',
  );
});

// Regression: both arms of a pair share one Linear issue, so `issueId` cannot
// distinguish them. The challenger's eval was launched with the primary's Linear
// id while running on `task/<slug>-challenger`; state lookup said `primary`,
// branch derivation said `challenger`, and the pair was invalidated as
// `state_vs_derived_side_mismatch`. Observed on HOK-2757, then again on HOK-2773
// and HOK-2777 after PR #1118 shipped.
//
// The workflow state below is what makes this reproduce: without it the state
// lookup returns nothing and the mismatch branch is never reached.
function seedPairState(repoDir: string): void {
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(
    join(repoDir, '.wavemill', 'workflow-state.json'),
    JSON.stringify({
      tasks: {
        'HOK-2773': { challengePairId: 'HOK-2773', challengeRole: 'primary' },
        'HOK-2773_c': { challengePairId: 'HOK-2773', challengeRole: 'challenger' },
      },
    }),
  );
}

test('resolveChallengeSide: a shared Linear id on a challenger branch is a mismatch without an explicit side', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'challenge-side-'));
  try {
    seedPairState(repoDir);
    const res = resolveChallengeSide({
      repoDir,
      challengePairId: 'HOK-2773',
      issueId: 'HOK-2773',                            // shared Linear id -> resolves to primary
      branchName: 'task/retire-models-challenger',    // unambiguously the challenger
    });
    assert.equal(res.canonicalSide, 'primary');
    assert.equal(res.fallbackSide, 'challenger');
    assert.equal(res.invalidReason, 'state_vs_derived_side_mismatch');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('resolveChallengeSide: an explicit side resolves that same case cleanly', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'challenge-side-'));
  try {
    seedPairState(repoDir);
    const res = resolveChallengeSide({
      repoDir,
      challengePairId: 'HOK-2773',
      issueId: 'HOK-2773',
      branchName: 'task/retire-models-challenger',
      explicitSide: 'challenger',
    });
    assert.equal(res.side, 'challenger');
    assert.equal(res.invalidReason, undefined);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('resolveChallengeSide: inference still applies when no explicit side is given', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'challenge-side-'));
  try {
    seedPairState(repoDir);
    const res = resolveChallengeSide({
      repoDir,
      challengePairId: 'HOK-2773',
      issueId: 'HOK-2773_c',
      branchName: 'task/retire-models-challenger',
    });
    assert.equal(res.side, 'challenger');
    assert.equal(res.invalidReason, undefined);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
