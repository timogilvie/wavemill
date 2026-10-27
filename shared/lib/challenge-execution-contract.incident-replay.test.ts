/**
 * HOK-3313 incident replay (fixed by HOK-3321).
 *
 * Replays the sanitized fixture at
 * tests/fixtures/challenge-replay/hok-3313-attestation-cases.json through the
 * real attestation and recovery code paths. Each eval record is first
 * validated against the EvalRecord schema (same Ajv setup as
 * challenge-execution-contract.test.ts) so the fixture cannot silently drift
 * from what the mill persists; then the expected verdict is asserted.
 *
 * Case 4 drives assessChallengePair (challenge-pair-recovery.ts) with a
 * materialised pair whose arms stamped the same model under two spellings —
 * pre-fix this pair looked supersedable; post-fix it is an identical control.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { EvalRecord } from './eval-schema.ts';
import { attestEvalRecordChallengeExecution } from './challenge-execution-contract.ts';
import { assessChallengePair } from './challenge-pair-recovery.ts';
import { validateEvalRecord } from './eval-validator.ts';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default || require('ajv/dist/2020');
const __dirname = dirname(fileURLToPath(import.meta.url));

interface FixtureCase {
  name: string;
  record?: EvalRecord;
  recovery?: {
    pairId: string;
    primary: { slug: string; stageModel: string };
    challenger: { slug: string; stageModel: string };
  };
  expected: {
    validity?: string;
    invalidReason?: string;
    verdict?: string;
    blockerIncludes?: string;
  };
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'tests', 'fixtures', 'challenge-replay', 'hok-3313-attestation-cases.json'), 'utf-8'),
) as { incident: string; cases: FixtureCase[] };

const evalSchema = JSON.parse(readFileSync(join(__dirname, 'eval-schema.json'), 'utf-8'));
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const validateEvalSchema = ajv.compile(evalSchema);

function materializeRecoveryRepo(spec: NonNullable<FixtureCase['recovery']>): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'hok-3313-replay-'));
  const evalsDir = join(repoDir, '.wavemill', 'evals');
  mkdirSync(evalsDir, { recursive: true });

  const tasks: Record<string, unknown> = {};
  for (const [key, arm] of [[spec.pairId, spec.primary], [`${spec.pairId}_c`, spec.challenger]] as const) {
    tasks[key] = {
      slug: arm.slug,
      challengePairId: spec.pairId,
      challengeExecutionIntent: { createdAt: '2026-10-26T14:10:00.000Z', selectedStage: 'plan' },
    };
    const featureDir = join(repoDir, 'worktrees', arm.slug, 'features', arm.slug);
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(
      join(featureDir, '.planning-result.json'),
      JSON.stringify({ stage: 'planning', status: 'completed', model: arm.stageModel }),
    );
  }
  writeFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), JSON.stringify({ tasks }));
  writeFileSync(join(evalsDir, 'challenge-records.jsonl'), '');
  writeFileSync(join(evalsDir, 'evals.jsonl'), '');
  return repoDir;
}

test(`HOK-3313 incident replay: every fixture record is schema-valid (${fixture.incident})`, () => {
  for (const testCase of fixture.cases) {
    if (!testCase.record) continue;
    const schemaErrors = validateEvalSchema(testCase.record)
      ? []
      : (validateEvalSchema.errors ?? []).map((e: { instancePath: string; message?: string }) => `${e.instancePath} ${e.message}`);
    assert.deepEqual(schemaErrors, [], `case ${testCase.name} record must satisfy eval-schema.json`);

    const issues = validateEvalRecord(testCase.record, { file: '<fixture>', line: 0 })
      .filter((issue) => issue.code === 'SCHEMA_VIOLATION');
    assert.deepEqual(issues, [], `case ${testCase.name} record must pass validateEvalRecord`);
  }
});

for (const testCase of fixture.cases) {
  if (testCase.record) {
    test(`HOK-3313 replay: ${testCase.name} attests ${testCase.expected.validity}`, () => {
      const attestation = attestEvalRecordChallengeExecution(testCase.record!);
      assert.ok(attestation, 'challenge record with an intent must attest');
      assert.equal(attestation.validity, testCase.expected.validity);
      assert.equal(attestation.invalidReason, testCase.expected.invalidReason);
    });
  } else if (testCase.recovery) {
    test(`HOK-3313 replay: ${testCase.name} recovery sees an identical control`, () => {
      const repoDir = materializeRecoveryRepo(testCase.recovery!);
      try {
        const assessment = assessChallengePair(repoDir, testCase.recovery!.pairId, () => '2026-10-26T16:00:00.000Z');
        assert.equal(assessment.verdict, testCase.expected.verdict);
        assert.ok(
          assessment.blockers.some((blocker) => blocker.includes(testCase.expected.blockerIncludes ?? '')),
          `blockers should include "${testCase.expected.blockerIncludes}": ${JSON.stringify(assessment.blockers)}`,
        );
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  }
}
