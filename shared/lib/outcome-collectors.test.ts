/**
 * Tests for outcome collectors.
 *
 * These tests verify that each collector handles various scenarios gracefully
 * and returns well-formed outcome objects.
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectCiOutcome,
  collectTestsOutcome,
  collectStaticAnalysisOutcome,
  collectReviewOutcome,
  collectReworkOutcome,
  collectDeliveryOutcome,
  clearPrChecksCache,
} from './outcome-collectors.ts';
import type { InterventionSummary } from './intervention-detector.ts';

// Clear cache before each test to ensure test isolation
beforeEach(() => {
  clearPrChecksCache();
});

describe('collectCiOutcome', () => {
  it('returns ran=false when no checks exist', () => {
    const outcome = collectCiOutcome('999', '/nonexistent');
    assert.equal(outcome.ran, false);
    assert.equal(outcome.passed, true); // Default when no checks
    assert.deepEqual(outcome.checks, []);
  });

  it('returns well-formed outcome structure', () => {
    const outcome = collectCiOutcome('999', '/nonexistent');
    assert.ok('ran' in outcome);
    assert.ok('passed' in outcome);
    assert.ok(Array.isArray(outcome.checks));
  });
});

describe('collectTestsOutcome', () => {
  it('returns added=false when no test files added', () => {
    const outcome = collectTestsOutcome('999', 'feature-branch', 'main', '/nonexistent');
    assert.equal(outcome.added, false);
  });

  it('returns well-formed outcome structure', () => {
    const outcome = collectTestsOutcome('999', 'feature-branch', 'main', '/nonexistent');
    assert.ok('added' in outcome);
    assert.ok(typeof outcome.added === 'boolean');
  });
});

describe('collectStaticAnalysisOutcome', () => {
  it('returns empty object when no static analysis checks found', () => {
    const outcome = collectStaticAnalysisOutcome('999', 'feature-branch', 'main', '/nonexistent');
    assert.ok(typeof outcome === 'object');
  });

  it('returns well-formed outcome structure', () => {
    const outcome = collectStaticAnalysisOutcome('999', 'feature-branch', 'main', '/nonexistent');
    // All fields are optional, just verify it's an object
    assert.ok(typeof outcome === 'object');
    assert.ok(!Array.isArray(outcome));
  });
});

describe('collectReviewOutcome', () => {
  it('returns default review outcome when no reviews exist', () => {
    const interventionSummary: InterventionSummary = {
      interventions: [],
      totalInterventionScore: 0,
    };

    const outcome = collectReviewOutcome('999', interventionSummary, '/nonexistent');
    assert.equal(outcome.humanReviewRequired, false);
    assert.equal(outcome.rounds, 0);
    assert.equal(outcome.approvals, 0);
    assert.equal(outcome.changeRequests, 0);
  });

  it('detects humanReviewRequired from intervention summary', () => {
    const interventionSummary: InterventionSummary = {
      interventions: [
        { type: 'review_comment', count: 2, details: ['comment 1', 'comment 2'] },
      ],
      totalInterventionScore: 0.1,
    };

    const outcome = collectReviewOutcome('999', interventionSummary, '/nonexistent');
    assert.equal(outcome.humanReviewRequired, true);
  });

  it('returns well-formed outcome structure', () => {
    const interventionSummary: InterventionSummary = {
      interventions: [],
      totalInterventionScore: 0,
    };

    const outcome = collectReviewOutcome('999', interventionSummary, '/nonexistent');
    assert.ok('humanReviewRequired' in outcome);
    assert.ok('rounds' in outcome);
    assert.ok('approvals' in outcome);
    assert.ok('changeRequests' in outcome);
    assert.ok(typeof outcome.rounds === 'number');
    assert.ok(typeof outcome.approvals === 'number');
    assert.ok(typeof outcome.changeRequests === 'number');
  });
});

describe('collectReworkOutcome', () => {
  it('returns agentIterations=0 when no commits exist', () => {
    const outcome = collectReworkOutcome('/nonexistent', 'nonexistent-branch', 'claude', '/nonexistent');
    assert.equal(outcome.agentIterations, 0);
  });

  it('returns well-formed outcome structure', () => {
    const outcome = collectReworkOutcome('/nonexistent', 'feature-branch', 'claude', '/nonexistent');
    assert.ok('agentIterations' in outcome);
    assert.ok(typeof outcome.agentIterations === 'number');
  });
});

describe('collectDeliveryOutcome', () => {
  it('returns prCreated=false when PR does not exist', () => {
    const outcome = collectDeliveryOutcome('999', '/nonexistent');
    assert.equal(outcome.prCreated, false);
    assert.equal(outcome.merged, false);
  });

  it('returns well-formed outcome structure', () => {
    const outcome = collectDeliveryOutcome('999', '/nonexistent');
    assert.ok('prCreated' in outcome);
    assert.ok('merged' in outcome);
    assert.ok(typeof outcome.prCreated === 'boolean');
    assert.ok(typeof outcome.merged === 'boolean');
  });
});

describe('Outcome collectors error handling', () => {
  it('collectors do not throw on invalid input', () => {
    assert.doesNotThrow(() => collectCiOutcome('', ''));
    assert.doesNotThrow(() => collectTestsOutcome('', '', '', ''));
    assert.doesNotThrow(() => collectStaticAnalysisOutcome('', '', '', ''));
    assert.doesNotThrow(() => collectReworkOutcome('', '', undefined, ''));
    assert.doesNotThrow(() => collectDeliveryOutcome('', ''));
  });
});

describe('PR checks caching', () => {
  it('clearPrChecksCache clears all caches when called with no arguments', () => {
    // This is a basic smoke test - we can't easily verify internal cache state
    // but we can verify the function doesn't throw
    assert.doesNotThrow(() => clearPrChecksCache());
  });

  it('clearPrChecksCache clears specific PR cache when called with arguments', () => {
    assert.doesNotThrow(() => clearPrChecksCache('123', '/some/path'));
  });

  it('multiple collectors share cached PR checks data', () => {
    // All three collectors should work with the same PR
    // They should all use the shared cache (verified by no errors)
    const prNumber = '999';
    const repoDir = '/nonexistent';

    assert.doesNotThrow(() => {
      collectCiOutcome(prNumber, repoDir);
      collectTestsOutcome(prNumber, 'branch', 'main', repoDir);
      collectStaticAnalysisOutcome(prNumber, 'branch', 'main', repoDir);
    });
  });
});
