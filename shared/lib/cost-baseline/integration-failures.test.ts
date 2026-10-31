import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { computeIntegrationFailures } from './integration-failures.ts';
import { label, lane, session } from './cost-baseline.fixtures.ts';

// protects: raw failure counts drawn from the wrong source or off by one (first merge attempt is not a failure)
test('computeIntegrationFailures counts lane retries, ejections, blocks and repair launches', () => {
  const counts = computeIntegrationFailures({
    lane: lane({ mergeAttemptCount: 3, rebaseCount: 1, ciRestartCount: 2 }),
    labelEvents: [
      label('2026-10-20T09:00:00.000Z', 'wm:blocked', 'labeled'),
      label('2026-10-20T10:00:00.000Z', 'wm:ready', 'labeled'),
      label('2026-10-20T10:01:00.000Z', 'wm:merging', 'labeled'),
      label('2026-10-20T10:02:00.000Z', 'wm:merging', 'unlabeled'),
      label('2026-10-20T10:03:00.000Z', 'wm:blocked', 'labeled'),
      label('2026-10-20T11:00:00.000Z', 'wm:merging', 'labeled'),
      label('2026-10-20T11:05:00.000Z', 'wm:merged', 'labeled'),
    ],
    sessions: [
      session({ kind: 'conflict-resolution', launchEvidence: 'launch conflict-resolution@a#1 at x' }),
      session({ kind: 'conflict-resolution', launchEvidence: 'launch conflict-resolution@a#1 at x' }),
      session({ kind: 'conflict-resolution', launchEvidence: 'launch conflict-resolution@b#2 at y' }),
      session({ kind: 'ready-remediation', launchEvidence: null }),
    ],
  });
  assert.deepEqual(counts, {
    failedMergeAttempts: 2,
    rebases: 1,
    ciRestarts: 2,
    ejections: 1,
    blockedAfterReady: 1,
    conflictResolutionLaunches: 2,
    readyRemediationLaunches: 1,
    ciFixLaunches: 0,
  });
});

// protects: missing sources reported as zero failures instead of unknown
test('computeIntegrationFailures reports null when lane and ledger are absent', () => {
  const counts = computeIntegrationFailures({ lane: lane({ mergeAttemptCount: 1 }), labelEvents: [], sessions: [] });
  assert.equal(counts.failedMergeAttempts, 0);
  assert.equal(counts.rebases, null);
  assert.equal(counts.ciRestarts, null);
  assert.equal(counts.ejections, null);
  assert.equal(counts.blockedAfterReady, null);
  assert.equal(computeIntegrationFailures({ lane: null, labelEvents: [], sessions: [] }).failedMergeAttempts, null);
});
