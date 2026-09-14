/**
 * Tests for outcome collectors.
 *
 * These tests verify that each collector handles various scenarios gracefully
 * and returns well-formed outcome objects.
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function withFakeGh(checks: unknown[], run: (repoDir: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'ci-checks-'));
  const repoDir = join(tempDir, 'repo');
  const binDir = join(tempDir, 'bin');
  const ghPath = join(binDir, 'gh');
  const originalPath = process.env.PATH ?? '';

  mkdirSync(repoDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(ghPath, `#!/bin/bash\nprintf '%s' '${JSON.stringify(checks)}'\n`, 'utf-8');
  chmodSync(ghPath, 0o755);
  process.env.PATH = `${binDir}:${originalPath}`;

  try {
    run(repoDir);
  } finally {
    process.env.PATH = originalPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

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

  it('omits durationSeconds when completedAt is Go zero-time', () => {
    withFakeGh(
      [
        {
          name: 'build',
          state: 'completed',
          bucket: 'pending',
          startedAt: '2026-06-08T12:00:00Z',
          completedAt: '0001-01-01T00:00:00Z',
        },
      ],
      (repoDir) => {
        const outcome = collectCiOutcome('123', repoDir);
        assert.deepEqual(outcome.checks, [{ name: 'build', status: 'pending' }]);
      },
    );
  });

  it('omits durationSeconds when completedAt is before startedAt', () => {
    withFakeGh(
      [
        {
          name: 'lint',
          state: 'completed',
          bucket: 'fail',
          startedAt: '2026-06-08T12:00:10Z',
          completedAt: '2026-06-08T12:00:00Z',
        },
      ],
      (repoDir) => {
        const outcome = collectCiOutcome('124', repoDir);
        assert.deepEqual(outcome.checks, [{ name: 'lint', status: 'failure' }]);
      },
    );
  });

  it('retains durationSeconds for successful checks', () => {
    withFakeGh(
      [
        {
          name: 'test',
          state: 'completed',
          bucket: 'pass',
          startedAt: '2026-06-08T12:00:00Z',
          completedAt: '2026-06-08T12:01:05Z',
        },
      ],
      (repoDir) => {
        const outcome = collectCiOutcome('125', repoDir);
        assert.deepEqual(outcome.checks, [{ name: 'test', status: 'success', durationSeconds: 65 }]);
      },
    );
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

  it('accepts an optional checkoutDir without throwing (HOK-2806)', () => {
    assert.doesNotThrow(() =>
      collectStaticAnalysisOutcome(
        '999',
        'feature-branch',
        'main',
        '/nonexistent',
        '/nonexistent-checkout',
      ),
    );
  });

  it('does not populate S1 fields with 0/false on collector failure (HOK-2806 null discipline)', () => {
    // With a nonexistent repoDir + checkoutDir, no tool can complete, so any
    // S1 fields that appear must be null, never coerced to 0/false.
    const outcome = collectStaticAnalysisOutcome(
      '999',
      'feature-branch',
      'main',
      '/nonexistent',
      '/nonexistent-checkout',
    );
    if ('type_errors' in outcome) assert.equal(outcome.type_errors, null);
    if ('lint_errors' in outcome) assert.equal(outcome.lint_errors, null);
    if ('build_ok' in outcome) assert.equal(outcome.build_ok, null);
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
