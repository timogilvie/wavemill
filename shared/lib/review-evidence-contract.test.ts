import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  computeReviewEvidenceDigest,
  isAnalysisIdentityValid,
  classifyEvidenceMode,
  countReviewFindings,
  createEmptyReviewEvidence,
  type ReviewExecutedIdentitySet,
  type ReviewEvidenceArtifact,
} from './review-evidence-contract.ts';

test('review-evidence-contract: pinned analysis identity', () => {
  const identity = {
    requested: 'claude-sonnet-5',
    resolved: 'claude-sonnet-5',
    status: 'pinned' as const,
  };
  assert.equal(isAnalysisIdentityValid(identity), true);
});

test('review-evidence-contract: fallback analysis identity is invalid', () => {
  const identity = {
    requested: 'claude-sonnet-5',
    resolved: 'claude-opus-5',
    status: 'fallback' as const,
  };
  assert.equal(isAnalysisIdentityValid(identity), false);
});

test('review-evidence-contract: unpinned analysis identity is invalid', () => {
  const identity = {
    requested: null,
    resolved: 'claude-opus-5',
    status: 'unpinned' as const,
  };
  assert.equal(isAnalysisIdentityValid(identity), false);
});

test('review-evidence-contract: evidence mode direct with valid analysis identity', () => {
  const now = new Date().toISOString();
  const identities: ReviewExecutedIdentitySet = {
    orchestrator: {
      requested: null,
      resolved: 'claude-sonnet-5',
      status: 'not-run',
    },
    analysis: {
      requested: 'claude-sonnet-5',
      resolved: 'claude-sonnet-5',
      status: 'pinned',
    },
    recordedAt: now,
  };

  const artifact: ReviewEvidenceArtifact = {
    metadata: {
      schemaVersion: '1.0.0',
      contentDigest: 'abc123',
      createdAt: now,
      updatedAt: now,
    },
    identities,
    iterations: [],
  };

  const result = classifyEvidenceMode(artifact);
  assert.equal(result.mode, 'direct');
  assert.equal(result.reason, 'analysis-pinned');
});

test('review-evidence-contract: evidence mode insufficient with fallback analysis', () => {
  const now = new Date().toISOString();
  const identities: ReviewExecutedIdentitySet = {
    orchestrator: {
      requested: null,
      resolved: 'claude-sonnet-5',
      status: 'not-run',
    },
    analysis: {
      requested: 'claude-sonnet-5',
      resolved: 'claude-opus-5',
      status: 'fallback',
    },
    recordedAt: now,
  };

  const artifact: ReviewEvidenceArtifact = {
    metadata: {
      schemaVersion: '1.0.0',
      contentDigest: 'abc123',
      createdAt: now,
      updatedAt: now,
    },
    identities,
    iterations: [],
  };

  const result = classifyEvidenceMode(artifact);
  assert.equal(result.mode, 'not-applicable');
  assert(result.reason?.includes('analysis-identity-invalid'));
});

test('review-evidence-contract: count review findings with multiple iterations', () => {
  const now = new Date().toISOString();
  const identities: ReviewExecutedIdentitySet = {
    orchestrator: {
      requested: null,
      resolved: 'claude-sonnet-5',
      status: 'not-run',
    },
    analysis: {
      requested: 'claude-sonnet-5',
      resolved: 'claude-sonnet-5',
      status: 'pinned',
    },
    recordedAt: now,
  };

  const artifact: ReviewEvidenceArtifact = {
    metadata: {
      schemaVersion: '1.0.0',
      contentDigest: 'abc123',
      createdAt: now,
      updatedAt: now,
    },
    identities,
    iterations: [
      {
        number: 1,
        startedAt: now,
        completedAt: now,
        findings: [
          { location: 'file.ts:10', category: 'correctness', severity: 'blocker', description: 'Missing check', disposition: 'open' },
          { location: 'file.ts:20', category: 'correctness', severity: 'warning', description: 'Inefficient loop', disposition: 'open' },
        ],
        commands: [],
        delta: { forkCommitSha: 'abc123', forkCommitVerified: true, filesChanged: ['file.ts'], linesAdded: 5, linesRemoved: 2 },
        passedReview: false,
        failureReason: 'Blocking findings present',
      },
      {
        number: 2,
        startedAt: now,
        completedAt: now,
        findings: [
          { location: 'file.ts:10', category: 'correctness', severity: 'blocker', description: 'Missing check', disposition: 'fixed', dismissalJustification: 'Added validation' },
        ],
        commands: [],
        delta: { forkCommitSha: 'abc123', forkCommitVerified: true, filesChanged: ['file.ts'], linesAdded: 8, linesRemoved: 2 },
        passedReview: true,
      },
    ],
  };

  const counts = countReviewFindings(artifact);
  assert.equal(counts.total, 3);
  assert.equal(counts.blockers, 2); // Both iterations have a blocker, even though one is fixed
  assert.equal(counts.dismissed, 0);
  assert.equal(counts.passedIterations, 1);
});

test('review-evidence-contract: count dismissed findings', () => {
  const now = new Date().toISOString();
  const identities: ReviewExecutedIdentitySet = {
    orchestrator: { requested: null, resolved: 'claude-sonnet-5', status: 'not-run' },
    analysis: { requested: 'claude-sonnet-5', resolved: 'claude-sonnet-5', status: 'pinned' },
    recordedAt: now,
  };

  const artifact: ReviewEvidenceArtifact = {
    metadata: {
      schemaVersion: '1.0.0',
      contentDigest: 'abc123',
      createdAt: now,
      updatedAt: now,
    },
    identities,
    iterations: [
      {
        number: 1,
        startedAt: now,
        completedAt: now,
        findings: [
          {
            location: 'test.ts:100',
            category: 'performance',
            severity: 'blocker',
            description: 'Slow operation',
            disposition: 'dismissed',
            dismissalJustification: 'Operation cache handles this in production',
            dismissalEvidence: 'Cache hit rate: 99.5%',
          },
        ],
        commands: [],
        delta: { forkCommitSha: 'abc123', forkCommitVerified: true, filesChanged: [], linesAdded: 0, linesRemoved: 0 },
        passedReview: true,
      },
    ],
  };

  const counts = countReviewFindings(artifact);
  assert.equal(counts.total, 1);
  assert.equal(counts.blockers, 0);
  assert.equal(counts.dismissed, 1);
});

test('review-evidence-contract: compute content digest', () => {
  const now = new Date().toISOString();
  const identities: ReviewExecutedIdentitySet = {
    orchestrator: { requested: null, resolved: 'claude-sonnet-5', status: 'not-run' },
    analysis: { requested: 'claude-sonnet-5', resolved: 'claude-sonnet-5', status: 'pinned' },
    recordedAt: now,
  };

  const iterations = [
    {
      number: 1,
      startedAt: now,
      completedAt: now,
      findings: [
        { location: 'file.ts:10', category: 'bug', severity: 'blocker', description: 'Error', disposition: 'open' },
      ],
      commands: [],
      delta: { forkCommitSha: 'abc123', forkCommitVerified: true, filesChanged: ['file.ts'], linesAdded: 5, linesRemoved: 2 },
      passedReview: false,
    },
  ];

  const digest1 = computeReviewEvidenceDigest(identities, iterations);
  const digest2 = computeReviewEvidenceDigest(identities, iterations);

  assert.equal(typeof digest1, 'string');
  assert.equal(digest1.length, 64); // SHA-256 is 64 hex chars
  assert.equal(digest1, digest2); // Same inputs produce same digest
});

test('review-evidence-contract: create empty evidence artifact', () => {
  const now = new Date().toISOString();
  const identities: ReviewExecutedIdentitySet = {
    orchestrator: { requested: null, resolved: 'claude-sonnet-5', status: 'not-run' },
    analysis: { requested: 'claude-sonnet-5', resolved: 'claude-sonnet-5', status: 'pinned' },
    recordedAt: now,
  };

  const artifact = createEmptyReviewEvidence(identities);

  assert.equal(artifact.metadata.schemaVersion, '1.0.0');
  assert.equal(artifact.identities.analysis.status, 'pinned');
  assert.equal(artifact.iterations.length, 0);
  assert.equal(artifact.error, undefined);
});
