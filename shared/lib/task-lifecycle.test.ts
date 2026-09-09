import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import {
  normalizeTaskLifecycle,
  validateTaskLifecycleState,
} from './task-lifecycle.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('valid active allocated lifecycle consumes a slot', () => {
  const normalized = normalizeTaskLifecycle({
    status: 'active',
    phase: 'coding',
    lifecycle: {
      schemaVersion: 1,
      workflowOutcome: 'active',
      resourceDisposition: 'allocated',
      launchContract: {
        baseBranch: 'auto/integration',
        remoteBranchDeletionPolicy: {
          allowed: true,
          mode: 'merged-pr-task-branch',
          source: 'cleanup_remote_task_branch',
        },
      },
    },
  });

  assert.equal(normalized.lifecycle.workflowOutcome, 'active');
  assert.equal(normalized.lifecycle.resourceDisposition, 'allocated');
  assert.equal(normalized.slotConsumes, true);
  assert.equal(normalized.branchDeletionAuthorized, true);
  assert.deepEqual(normalized.validationErrors, []);
});

test('closed plus allocated without retention is invalid', () => {
  const errors = validateTaskLifecycleState({
    schemaVersion: 1,
    workflowOutcome: 'closed',
    resourceDisposition: 'allocated',
    launchContract: {
      remoteBranchDeletionPolicy: {
        allowed: true,
        mode: 'merged-pr-task-branch',
      },
    },
  });

  assert.ok(errors.includes('closed + allocated requires retention.reason'));
});

test('terminal retained with explicit reason validates and does not consume a slot', () => {
  const normalized = normalizeTaskLifecycle({
    lifecycle: {
      schemaVersion: 1,
      workflowOutcome: 'closed',
      resourceDisposition: 'retained',
      retention: {
        reason: 'operator-preserved-pane',
      },
      launchContract: {
        remoteBranchDeletionPolicy: {
          allowed: false,
          mode: 'manual-verification',
        },
      },
    },
  });

  assert.equal(normalized.lifecycle.resourceDisposition, 'retained');
  assert.equal(normalized.slotConsumes, false);
  assert.equal(normalized.branchDeletionAuthorized, false);
  assert.deepEqual(normalized.validationErrors, []);
});

test('legacy HOK-2595-like terminal pane state normalizes to verification-required', () => {
  const normalized = normalizeTaskLifecycle({
    slug: 'detect-and-correlate',
    status: 'closed',
    phase: 'closed',
    paneState: 'active',
    executionOwner: 'task',
    pr: '1023',
    branch: 'task/detect-and-correlate',
  });

  assert.equal(normalized.lifecycle.workflowOutcome, 'closed');
  assert.equal(normalized.lifecycle.resourceDisposition, 'verification-required');
  assert.equal(normalized.slotConsumes, false);
  assert.equal(normalized.branchDeletionAuthorized, false);
  assert.equal(normalized.lifecycle.retention?.reason, 'verification-required');
  assert.match(normalized.lifecycle.verificationRequiredReason ?? '', /legacy-terminal-resource-state/);
});

test('legacy HOK-2913 challenger state never authorizes remote branch deletion', () => {
  const normalized = normalizeTaskLifecycle({
    slug: 'review-scope-guards-merge-base-fallback-flags-the-branchs-own-challenger',
    status: 'closed',
    phase: 'closed',
    challengeRole: 'challenger',
    challengePairId: 'HOK-2913',
    paneState: 'active',
  });

  assert.equal(normalized.lifecycle.workflowOutcome, 'closed');
  assert.equal(normalized.lifecycle.resourceDisposition, 'verification-required');
  assert.equal(normalized.branchDeletionAuthorized, false);
});

test('legacy superseded challenger is terminal and does not consume a slot', () => {
  const normalized = normalizeTaskLifecycle({
    slug: 'review-scope-guards-challenger',
    status: 'superseded',
    phase: 'superseded',
    challengeRole: 'challenger',
    challengePairId: 'HOK-2913',
    paneState: 'active',
  });

  assert.equal(normalized.lifecycle.workflowOutcome, 'closed');
  assert.equal(normalized.lifecycle.resourceDisposition, 'verification-required');
  assert.equal(normalized.slotConsumes, false);
});

test('unknown lifecycle fields survive normalization', () => {
  const normalized = normalizeTaskLifecycle({
    lifecycle: {
      schemaVersion: 1,
      workflowOutcome: 'active',
      resourceDisposition: 'allocated',
      futureField: {
        keep: true,
      },
      launchContract: {
        remoteBranchDeletionPolicy: {
          allowed: true,
          mode: 'merged-pr-task-branch',
        },
      },
    },
  });

  assert.deepEqual(normalized.lifecycle.futureField, { keep: true });
});

test('launch contract preserves requireConfirm and backfills provenance', () => {
  const normalized = normalizeTaskLifecycle({
    lifecycle: {
      schemaVersion: 1,
      workflowOutcome: 'active',
      resourceDisposition: 'allocated',
      launchContract: {
        baseBranch: 'auto/integration',
        mergeMethod: 'squash',
        requireConfirm: true,
        remoteBranchDeletionPolicy: {
          allowed: true,
          mode: 'merged-pr-task-branch',
        },
      },
    },
  });

  assert.equal(normalized.lifecycle.launchContract?.requireConfirm, true);
  assert.deepEqual(normalized.lifecycle.launchContract?.provenance, {
    baseBranch: 'launch-contract',
    requireConfirm: 'launch-contract',
    mergeMethod: 'launch-contract',
    remoteBranchDeletionPolicy: 'launch-contract',
  });
});

test('cleanup episode survives normalization on retained terminal lifecycle', () => {
  const normalized = normalizeTaskLifecycle({
    lifecycle: {
      schemaVersion: 1,
      workflowOutcome: 'merged',
      resourceDisposition: 'retained',
      retention: {
        reason: 'local-work-preserved',
      },
      cleanupEpisode: {
        schemaVersion: 1,
        episodeId: 'HOK-2955:cleanup:abc123',
        fingerprint: 'abc123',
        fingerprintInputs: {
          branch: 'task/example',
          localHeadSha: 'a'.repeat(40),
        },
        disposition: 'retained',
        failureClass: 'expected-preservation',
        firstAttemptAt: '2026-09-08T12:00:00Z',
        lastAttemptAt: '2026-09-08T12:00:00Z',
        attemptCount: 1,
        nextRetryAt: null,
        requiredOperatorAction: 'Push task/example to origin or explicitly abandon it.',
        lastOutcome: 'local-work-preserved',
        updatedAt: '2026-09-08T12:00:00Z',
        futureEpisodeField: {
          keep: true,
        },
      },
      launchContract: {
        remoteBranchDeletionPolicy: {
          allowed: false,
          mode: 'manual-verification',
        },
      },
    },
  });

  assert.equal(normalized.slotConsumes, false);
  assert.equal(normalized.lifecycle.cleanupEpisode?.disposition, 'retained');
  assert.deepEqual(normalized.lifecycle.cleanupEpisode?.futureEpisodeField, { keep: true });
});

test('malformed lifecycle fails closed to verification-required without deletion authority', () => {
  const normalized = normalizeTaskLifecycle({
    status: 'merged',
    phase: 'done',
    lifecycle: {
      schemaVersion: 1,
      workflowOutcome: 'finished',
      resourceDisposition: 'gone',
      launchContract: {
        remoteBranchDeletionPolicy: {
          allowed: true,
        },
      },
    },
  });

  assert.equal(normalized.lifecycle.workflowOutcome, 'merged');
  assert.equal(normalized.lifecycle.resourceDisposition, 'verification-required');
  assert.equal(normalized.branchDeletionAuthorized, false);
  assert.equal(normalized.lifecycle.retention?.reason, 'verification-required');
});

test('JSON schema rejects closed allocated state without retention', () => {
  const schema = JSON.parse(readFileSync(join(__dirname, '..', 'schemas', 'task-lifecycle-state.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(schema);

  assert.equal(validate({
    schemaVersion: 1,
    workflowOutcome: 'closed',
    resourceDisposition: 'allocated',
    launchContract: {
      remoteBranchDeletionPolicy: {
        allowed: false,
      },
    },
  }), false);

  assert.equal(validate({
    schemaVersion: 1,
    workflowOutcome: 'closed',
    resourceDisposition: 'allocated',
    retention: {
      reason: 'operator-retained-pane',
    },
    launchContract: {
      remoteBranchDeletionPolicy: {
        allowed: false,
      },
    },
  }), true);

  assert.equal(validate({
    schemaVersion: 1,
    workflowOutcome: 'merged',
    resourceDisposition: 'retained',
    retention: {
      reason: 'local-work-preserved',
    },
    cleanupEpisode: {
      schemaVersion: 1,
      episodeId: 'HOK-2955:cleanup:abc123',
      fingerprint: 'abc123',
      disposition: 'retained',
      failureClass: 'expected-preservation',
      attemptCount: 1,
      updatedAt: '2026-09-08T12:00:00Z',
    },
    launchContract: {
      remoteBranchDeletionPolicy: {
        allowed: false,
      },
    },
  }), true);
});
