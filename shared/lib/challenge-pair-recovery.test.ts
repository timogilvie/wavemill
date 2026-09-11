import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { assessChallengePair, runChallengeRecovery } from './challenge-pair-recovery.ts';

const NOW = () => '2026-01-01T00:00:00.000Z';
const PRIMARY_HEAD = 'a'.repeat(40);
const CHALLENGER_HEAD = 'b'.repeat(40);

function resolveFixturePrIdentity(pr: string): { url: string; headSha: string } {
  return {
    url: pr,
    headSha: pr.endsWith('/1') ? PRIMARY_HEAD : CHALLENGER_HEAD,
  };
}

function assess(repoDir: string, pairId: string) {
  return assessChallengePair(repoDir, pairId, NOW, resolveFixturePrIdentity);
}

function recover(repoDir: string, pairIds: string[], apply = false) {
  return runChallengeRecovery({ repoDir, pairIds, apply, now: NOW, resolvePrIdentity: resolveFixturePrIdentity });
}

interface ArmSpec {
  slug: string;
  intentCreatedAt?: string;
  intentStage?: string;
  stageStatus?: string;
  stageModel?: string;
  writeStageResult?: boolean;
}

interface FixtureSpec {
  pairId: string;
  primary?: ArmSpec;
  challenger?: ArmSpec;
  record?: Record<string, unknown>;
  evalPrUrls?: string[];
  evalRows?: Record<string, unknown>[];
  writeRecord?: boolean;
}

function makeRepo(spec: FixtureSpec): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'challenge-recovery-'));
  const evalsDir = join(repoDir, '.wavemill', 'evals');
  mkdirSync(evalsDir, { recursive: true });

  const tasks: Record<string, unknown> = {};

  const addArm = (issueId: string, arm: ArmSpec | undefined) => {
    if (!arm) return;
    tasks[issueId] = {
      slug: arm.slug,
      challengePairId: spec.pairId,
      challengeExecutionIntent: arm.intentCreatedAt
        ? { createdAt: arm.intentCreatedAt, selectedStage: arm.intentStage ?? 'review' }
        : null,
    };
    if (arm.writeStageResult === false) return;
    const featureDir = join(repoDir, 'worktrees', arm.slug, 'features', arm.slug);
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(
      join(featureDir, '.review-result.json'),
      JSON.stringify({ stage: 'review', status: arm.stageStatus ?? 'completed', model: arm.stageModel }),
    );
  };

  addArm(spec.pairId, spec.primary);
  addArm(`${spec.pairId}_c`, spec.challenger);

  writeFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), JSON.stringify({ tasks }));

  const record = spec.record ?? {
    challengePairId: spec.pairId,
    comparisonOutcome: 'invalid_challenge',
    invalidChallenge: true,
    invalidChallengeReason: 'state_vs_derived_side_mismatch',
    timestamp: '2026-08-14T23:00:38.257Z',
    primaryPrUrl: 'https://example.test/pull/1',
    challengerPrUrl: 'https://example.test/pull/2',
    primaryEvalScore: 0.9,
    challengerEvalScore: 0.93,
  };
  writeFileSync(
    join(evalsDir, 'challenge-records.jsonl'),
    spec.writeRecord === false ? '' : `${JSON.stringify(record)}\n`,
  );

  const prUrls = spec.evalPrUrls ?? ['https://example.test/pull/1', 'https://example.test/pull/2'];
  const evalRows = spec.evalRows ?? prUrls.map((prUrl) => ({
    id: `eval-${prUrl.endsWith('/1') ? 'primary' : 'challenger'}`,
    challengePairId: spec.pairId,
    challengeSide: prUrl.endsWith('/1') ? 'primary' : 'challenger',
    prUrl,
    score: prUrl.endsWith('/1') ? 0.9 : 0.93,
    timestamp: '2026-08-14T23:00:00.000Z',
    evaluatedPrHeadSha: prUrl.endsWith('/1') ? PRIMARY_HEAD : CHALLENGER_HEAD,
  }));
  writeFileSync(
    join(evalsDir, 'evals.jsonl'),
    evalRows.map((row) => JSON.stringify(row)).join('\n') + (evalRows.length ? '\n' : ''),
  );

  return repoDir;
}

function provenFixture(): FixtureSpec {
  return {
    pairId: 'PAIR-1',
    primary: { slug: 'p', intentCreatedAt: '2026-08-14T21:19:26.862Z', stageModel: 'claude-haiku-4-5-20251001' },
    challenger: { slug: 'c', intentCreatedAt: '2026-08-14T21:19:26.862Z', stageModel: 'glm-5.2' },
  };
}

describe('challenge recovery assessment', () => {
  it('recovers HOK-2934-style eval-only evidence at each current head', () => {
    const spec = provenFixture();
    spec.writeRecord = false;
    spec.evalRows = [
      {
        id: 'primary-old', challengePairId: 'PAIR-1', challengeSide: 'primary',
        prUrl: 'https://example.test/pull/1', score: 0.1,
        timestamp: '2026-08-14T20:00:00.000Z', evaluatedPrHeadSha: 'c'.repeat(40),
      },
      {
        id: 'primary-current', challengePairId: 'PAIR-1', challengeSide: 'primary',
        prUrl: 'https://example.test/pull/1', score: 0.9,
        timestamp: '2026-08-14T22:00:00.000Z', evaluatedPrHeadSha: PRIMARY_HEAD,
      },
      {
        id: 'challenger-current', challengePairId: 'PAIR-1', challengeSide: 'challenger',
        prUrl: 'https://example.test/pull/2', score: 0.93,
        timestamp: '2026-08-14T22:01:00.000Z', evaluatedPrHeadSha: CHALLENGER_HEAD,
      },
    ];
    const repoDir = makeRepo(spec);
    try {
      const result = recover(repoDir, ['PAIR-1']);
      const assessment = result.assessments[0];
      assert.equal(assessment.verdict, 'supersedable');
      assert.equal(assessment.arms[0].selectedEvalId, 'primary-current');
      assert.equal(assessment.arms[1].selectedEvalId, 'challenger-current');
      assert.equal(assessment.arms[0].evalScore, 0.9);
      assert.equal(assessment.arms[1].evalScore, 0.93);
      assert.equal(result.auditEntriesWritten, 0);
      assert.equal(existsSync(join(repoDir, '.wavemill', 'evals', 'challenge-recovery-audit.jsonl')), false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('refuses old-head-only evidence instead of using a comparison score', () => {
    const spec = provenFixture();
    spec.writeRecord = false;
    spec.evalRows = [
      {
        id: 'primary-old', challengePairId: 'PAIR-1', challengeSide: 'primary',
        prUrl: 'https://example.test/pull/1', score: 0.9,
        timestamp: '2026-08-14T20:00:00.000Z', evaluatedPrHeadSha: 'c'.repeat(40),
      },
      {
        id: 'challenger-current', challengePairId: 'PAIR-1', challengeSide: 'challenger',
        prUrl: 'https://example.test/pull/2', score: 0.93,
        timestamp: '2026-08-14T22:01:00.000Z', evaluatedPrHeadSha: CHALLENGER_HEAD,
      },
    ];
    const repoDir = makeRepo(spec);
    try {
      const assessment = assess(repoDir, 'PAIR-1');
      assert.equal(assessment.verdict, 'quarantine-upheld');
      assert.equal(assessment.arms[0].selectorReason, 'old_head_only');
      assert.ok(assessment.blockers.some((blocker) => blocker.includes('current-head eval evidence refused (old_head_only)')));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('refuses ambiguous eval-derived PR identities when no comparison exists', () => {
    const spec = provenFixture();
    spec.writeRecord = false;
    spec.evalRows = [
      {
        id: 'primary-one', challengePairId: 'PAIR-1', challengeSide: 'primary',
        prUrl: 'https://example.test/pull/1', score: 0.9,
        timestamp: '2026-08-14T20:00:00.000Z', evaluatedPrHeadSha: PRIMARY_HEAD,
      },
      {
        id: 'primary-two', challengePairId: 'PAIR-1', challengeSide: 'primary',
        prUrl: 'https://example.test/pull/3', score: 0.9,
        timestamp: '2026-08-14T20:00:00.000Z', evaluatedPrHeadSha: PRIMARY_HEAD,
      },
      {
        id: 'challenger-current', challengePairId: 'PAIR-1', challengeSide: 'challenger',
        prUrl: 'https://example.test/pull/2', score: 0.93,
        timestamp: '2026-08-14T22:01:00.000Z', evaluatedPrHeadSha: CHALLENGER_HEAD,
      },
    ];
    const repoDir = makeRepo(spec);
    try {
      const assessment = assess(repoDir, 'PAIR-1');
      assert.equal(assessment.verdict, 'quarantine-upheld');
      assert.ok(assessment.arms[0].gaps.some((gap) => gap.includes('ambiguous PR identity')));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('supersedes only when both arms and a shared immutable intent are proven', () => {
    const repoDir = makeRepo(provenFixture());
    try {
      const assessment = assess(repoDir, 'PAIR-1');
      assert.equal(assessment.verdict, 'supersedable');
      assert.equal(assessment.intentProven, true);
      assert.deepEqual(assessment.blockers, []);
      // Models come from execution evidence, not from the prior (bad) attestation.
      assert.equal(assessment.arms[0].stageModel, 'claude-haiku-4-5-20251001');
      assert.equal(assessment.arms[1].stageModel, 'glm-5.2');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('upholds quarantine when intent is missing on either arm', () => {
    const spec = provenFixture();
    delete spec.challenger!.intentCreatedAt;
    const repoDir = makeRepo(spec);
    try {
      const assessment = assess(repoDir, 'PAIR-1');
      assert.equal(assessment.verdict, 'quarantine-upheld');
      assert.equal(assessment.intentProven, false);
      assert.ok(assessment.blockers.some((b) => b.includes('intent is missing')));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('upholds quarantine when the arms disagree about the intent', () => {
    const spec = provenFixture();
    spec.challenger!.intentCreatedAt = '2026-08-15T09:00:00.000Z';
    const repoDir = makeRepo(spec);
    try {
      const assessment = assess(repoDir, 'PAIR-1');
      assert.equal(assessment.verdict, 'quarantine-upheld');
      assert.ok(assessment.blockers.some((b) => b.includes('disagree on intent createdAt')));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('refuses to supersede an identical control', () => {
    const spec = provenFixture();
    spec.challenger!.stageModel = 'claude-haiku-4-5-20251001';
    const repoDir = makeRepo(spec);
    try {
      const assessment = assess(repoDir, 'PAIR-1');
      assert.equal(assessment.verdict, 'quarantine-upheld');
      assert.ok(assessment.blockers.some((b) => b.includes('identical control')));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('upholds quarantine when the challenge stage never completed', () => {
    const spec = provenFixture();
    spec.challenger!.stageStatus = 'failed';
    const repoDir = makeRepo(spec);
    try {
      const assessment = assess(repoDir, 'PAIR-1');
      assert.equal(assessment.verdict, 'quarantine-upheld');
      assert.ok(assessment.blockers.some((b) => b.includes('did not complete')));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('upholds quarantine when worktree evidence is gone', () => {
    const spec = provenFixture();
    spec.challenger!.writeStageResult = false;
    const repoDir = makeRepo(spec);
    try {
      const assessment = assess(repoDir, 'PAIR-1');
      assert.equal(assessment.verdict, 'quarantine-upheld');
      assert.ok(assessment.blockers.some((b) => b.includes('worktree evidence')));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('reports pair-not-found without inventing evidence', () => {
    const repoDir = makeRepo(provenFixture());
    try {
      const assessment = assess(repoDir, 'PAIR-NOPE');
      assert.equal(assessment.verdict, 'pair-not-found');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('challenge recovery application', () => {
  it('has no recover-all mode', () => {
    const repoDir = makeRepo(provenFixture());
    try {
      assert.throws(
        () => recover(repoDir, [], true),
        /explicit pair IDs/,
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('writes nothing on a dry run', () => {
    const repoDir = makeRepo(provenFixture());
    const recordsPath = join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl');
    const before = readFileSync(recordsPath, 'utf8');
    try {
      const result = recover(repoDir, ['PAIR-1']);
      assert.equal(result.applied, false);
      assert.equal(result.supersedingRecordsWritten, 0);
      assert.equal(result.auditEntriesWritten, 0);
      assert.equal(readFileSync(recordsPath, 'utf8'), before);
      assert.equal(existsSync(join(repoDir, '.wavemill', 'evals', 'challenge-recovery-audit.jsonl')), false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('appends the superseding record and preserves the invalid original', () => {
    const repoDir = makeRepo(provenFixture());
    const recordsPath = join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl');
    const originalLine = readFileSync(recordsPath, 'utf8').trim();
    try {
      const result = recover(repoDir, ['PAIR-1'], true);
      assert.equal(result.supersedingRecordsWritten, 1);

      const lines = readFileSync(recordsPath, 'utf8').trim().split('\n');
      assert.equal(lines.length, 2);
      // Original line is byte-identical — recovery is append-only.
      assert.equal(lines[0], originalLine);

      const superseding = JSON.parse(lines[1]);
      assert.equal(superseding.recordKind, 'superseding-comparison');
      assert.equal(superseding.invalidChallenge, false);
      assert.equal(superseding.primaryModel, 'claude-haiku-4-5-20251001');
      assert.equal(superseding.challengerModel, 'glm-5.2');
      // 0.93 challenger vs 0.90 primary
      assert.equal(superseding.comparisonOutcome, 'compared');
      // `winner` is the field the merge gate actually keys off.
      assert.equal(superseding.winner, 'challenger');
      assert.equal(superseding.supersedes.invalidChallengeReason, 'state_vs_derived_side_mismatch');
      assert.deepEqual(superseding.selectedEvalEvidence, {
        primary: { evalId: 'eval-primary', evaluatedPrHeadSha: PRIMARY_HEAD },
        challenger: { evalId: 'eval-challenger', evaluatedPrHeadSha: CHALLENGER_HEAD },
      });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('never names a winner on a tie', () => {
    const spec = provenFixture();
    spec.record = {
      challengePairId: 'PAIR-1',
      comparisonOutcome: 'invalid_challenge',
      invalidChallenge: true,
      invalidChallengeReason: 'state_vs_derived_side_mismatch',
      timestamp: '2026-08-14T23:00:38.257Z',
      primaryPrUrl: 'https://example.test/pull/1',
      challengerPrUrl: 'https://example.test/pull/2',
      primaryEvalScore: 0.9,
      challengerEvalScore: 0.9,
    };
    spec.evalRows = [
      {
        id: 'equal-primary', challengePairId: 'PAIR-1', challengeSide: 'primary',
        prUrl: 'https://example.test/pull/1', score: 0.9,
        timestamp: '2026-08-14T23:00:00.000Z', evaluatedPrHeadSha: PRIMARY_HEAD,
      },
      {
        id: 'equal-challenger', challengePairId: 'PAIR-1', challengeSide: 'challenger',
        prUrl: 'https://example.test/pull/2', score: 0.9,
        timestamp: '2026-08-14T23:00:00.000Z', evaluatedPrHeadSha: CHALLENGER_HEAD,
      },
    ];
    const repoDir = makeRepo(spec);
    const recordsPath = join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl');
    try {
      recover(repoDir, ['PAIR-1'], true);
      const lines = readFileSync(recordsPath, 'utf8').trim().split('\n');
      const superseding = JSON.parse(lines[1]);
      // Naming a winner arbitrarily would send an equally-scored PR to the
      // gate's destructive loser-cleanup path.
      assert.equal(superseding.winner, undefined);
      assert.equal(superseding.comparisonOutcome, 'inconclusive');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('audits an upheld quarantine without touching challenge records', () => {
    const spec = provenFixture();
    delete spec.challenger!.intentCreatedAt;
    const repoDir = makeRepo(spec);
    const recordsPath = join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl');
    const before = readFileSync(recordsPath, 'utf8');
    try {
      const result = recover(repoDir, ['PAIR-1'], true);
      assert.equal(result.supersedingRecordsWritten, 0);
      assert.equal(result.auditEntriesWritten, 1);
      assert.equal(readFileSync(recordsPath, 'utf8'), before);

      const audit = JSON.parse(readFileSync(result.auditPath, 'utf8').trim());
      assert.equal(audit.verdict, 'quarantine-upheld');
      assert.ok(audit.blockers.length > 0);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
describe('deferred awaiting_fork arms (HOK-2813)', () => {
  it('upholds the status quo for a pair whose challenger is still awaiting fork', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'challenge-recovery-deferred-'));
    try {
      mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
      writeFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), JSON.stringify({
        tasks: {
          'HOK-77': {
            slug: 'deferred-primary',
            challengePairId: 'HOK-77',
            challengeRole: 'primary',
            challengeExecutionIntent: { createdAt: NOW(), selectedStage: 'review' },
            challengeArms: [{
              key: 'HOK-77_c',
              slug: 'deferred-primary-challenger',
              role: 'challenger',
              variedStage: 'review',
              challengeArmState: 'awaiting_fork',
            }],
          },
        },
      }));

      const assessment = assess(repoDir, 'HOK-77');
      assert.equal(assessment.verdict, 'quarantine-upheld');
      assert.equal(assessment.arms.length, 0);
      assert.match(assessment.blockers.join('; '), /awaiting fork/);

      // Applying recovery must not write a superseding comparison record.
      recover(repoDir, ['HOK-77'], true);
      assert.equal(existsSync(join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl')), false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
