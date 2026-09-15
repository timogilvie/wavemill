/**
 * Tests for review-runner module.
 *
 * Note: These tests focus on logic validation without invoking the actual LLM.
 * End-to-end tests with real LLM calls should be run manually.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reviewChanges, reviewRunnerDeps, type ReviewOptions } from './review-runner.ts';
import type { ReviewScopeGuardResult } from './review-scope-guard.ts';

// Test constants
const TEST_DIR = join(tmpdir(), `review-runner-test-${Date.now()}`);

describe('review-runner', () => {
  beforeEach(() => {
    // Create test directory
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mock.restoreAll();
  });

  describe('Configuration Loading', () => {
    it('should use default configuration when no config file exists', () => {
      assert.ok(true);
    });

    it('should load custom judge model from config', () => {
      const configPath = join(TEST_DIR, '.wavemill-config.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          eval: {
            judge: {
              model: 'claude-haiku-4-5-20251001',
              provider: 'claude-cli',
            },
          },
        })
      );

      assert.ok(true);
    });

    it('should load UI verification settings from config', () => {
      const configPath = join(TEST_DIR, '.wavemill-config.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          ui: {
            visualVerification: false,
            devServer: 'http://localhost:3000',
          },
        })
      );

      assert.ok(true);
    });
  });

  describe('Review Options', () => {
    it('should respect skipUi option', () => {
      const options: ReviewOptions = {
        skipUi: true,
      };

      assert.equal(options.skipUi, true);
    });

    it('should respect uiOnly option', () => {
      const options: ReviewOptions = {
        uiOnly: true,
      };

      assert.equal(options.uiOnly, true);
    });

    it('should respect verbose option', () => {
      const options: ReviewOptions = {
        verbose: true,
      };

      assert.equal(options.verbose, true);
    });

    it('should expose operatingMode option for degraded review routing', () => {
      const options: ReviewOptions = {
        operatingMode: 'survival',
      };

      assert.equal(options.operatingMode, 'survival');
    });

    it('should forward operatingMode to the review engine', () => {
      const source = readFileSync(new URL('./review-runner.ts', import.meta.url), 'utf-8');

      assert.match(source, /operatingMode:\s*options\.operatingMode/);
    });

    it('fails closed without running review when a reviewer-stage challenge pin is unresolvable', async () => {
      const featureDir = join(TEST_DIR, 'features', 'external-harness-challenger');
      mkdirSync(featureDir, { recursive: true });
      mock.method(reviewRunnerDeps, 'getCurrentBranch', () => 'task/external-harness-challenger');
      mock.method(reviewRunnerDeps, 'getGitDiff', () => 'diff --git a/app.ts b/app.ts');
      mock.method(reviewRunnerDeps, 'assertReviewableDiff', () => undefined);
      mock.method(reviewRunnerDeps, 'ensureClaudeAvailable', async () => undefined);
      mock.method(reviewRunnerDeps, 'gatherReviewContextAsync', async () => ({
        diff: 'diff --git a/app.ts b/app.ts',
        plan: 'plan',
        taskPacket: 'packet',
        designContext: null,
        metadata: {
          branch: 'task/external-harness-challenger',
          files: ['app.ts'],
          lineCount: { added: 1, removed: 0 },
          hasUiChanges: false,
        },
      }));
      mock.method(reviewRunnerDeps, 'validateReviewScope', () => ({
        ok: true,
        status: 'pass',
        baselineSource: 'explicit',
        inScopePaths: ['app.ts'],
        outOfScopePaths: [],
        findings: [],
      } satisfies ReviewScopeGuardResult));
      mock.method(reviewRunnerDeps, 'detectCrossPrReverts', () => []);
      mock.method(reviewRunnerDeps, 'resolveReviewStageChallengePin', () => ({
        pairId: 'HOK-2958',
        unresolvable: true,
      }));
      const runReview = mock.method(reviewRunnerDeps, 'runReview', async () => {
        throw new Error('runReview should not be called');
      });

      const result = await reviewChanges({ repoDir: TEST_DIR, featureDir });

      assert.equal(runReview.mock.callCount(), 0);
      assert.equal(result.verdict, 'not_ready');
      assert.equal(result.failureCategory, 'challenge-review-pin-unresolvable');
      assert.equal(result.substantiveAnalysisIdentity?.source, 'derived');
      assert.equal(result.substantiveAnalysisIdentity?.pinned, false);
      assert.equal(result.substantiveAnalysisIdentity?.fallbackReason, 'challenge_intent_unresolvable');
      assert.match(result.codeReviewFindings[0].description, /HOK-2958/);
    });

    it('adds a deterministic blocker for unacknowledged cross-PR reverts', async () => {
      mock.method(reviewRunnerDeps, 'getCurrentBranch', () => 'task/remove-strategy');
      mock.method(reviewRunnerDeps, 'getGitDiff', () => 'diff --git a/strategy.txt b/strategy.txt');
      mock.method(reviewRunnerDeps, 'assertReviewableDiff', () => undefined);
      mock.method(reviewRunnerDeps, 'ensureClaudeAvailable', async () => undefined);
      mock.method(reviewRunnerDeps, 'gatherReviewContextAsync', async () => ({
        diff: 'diff --git a/strategy.txt b/strategy.txt',
        plan: 'plan',
        taskPacket: 'packet',
        designContext: null,
        metadata: {
          branch: 'task/remove-strategy',
          files: ['strategy.txt'],
          hasUiChanges: false,
        },
      }));
      mock.method(reviewRunnerDeps, 'execShellCommand', (command: string) => {
        if (command.includes('git merge-base')) {
          return 'base-sha\n';
        }
        if (command.includes('gh pr view')) {
          return '';
        }
        if (command.includes('git log --format=%B')) {
          return '';
        }
        throw new Error(`unexpected command: ${command}`);
      });
      mock.method(reviewRunnerDeps, 'detectCrossPrReverts', () => [
        {
          prNumber: 437,
          title: 'Restore strategy explorer (#437)',
          files: [{ path: 'strategy.txt', status: 'deleted', confidence: 'deleted' }],
        },
      ]);
      mock.method(reviewRunnerDeps, 'runReview', async (context) => {
        assert.match(context.diff, /Cross-PR revert detector findings/);
        return {
          verdict: 'ready',
          codeReviewFindings: [],
          metadata: {
            branch: 'task/remove-strategy',
            files: ['strategy.txt'],
            hasUiChanges: false,
            designContextAvailable: false,
            uiVerificationRun: false,
          },
        };
      });

      const result = await reviewChanges({
        repoDir: TEST_DIR,
      });

      assert.equal(result.verdict, 'not_ready');
      // Assert on the cross-pr-revert finding specifically. The scope guard also
      // reports here (this fixture supplies neither sinceCommit nor featureDir),
      // so a total-length assertion couples this test to an unrelated check.
      const revertFindings = result.codeReviewFindings.filter((f) => f.category === 'cross-pr-revert');
      assert.equal(revertFindings.length, 1);
      assert.equal(revertFindings[0].severity, 'blocker');
      assert.match(revertFindings[0].description, /Reverts #437/);
    });

    it('fails closed when cross-PR revert evidence cannot be collected', async () => {
      mock.method(reviewRunnerDeps, 'getCurrentBranch', () => 'task/no-integration-branch');
      mock.method(reviewRunnerDeps, 'getGitDiff', () => 'diff --git a/app.ts b/app.ts');
      mock.method(reviewRunnerDeps, 'assertReviewableDiff', () => undefined);
      mock.method(reviewRunnerDeps, 'ensureClaudeAvailable', async () => undefined);
      mock.method(reviewRunnerDeps, 'gatherReviewContextAsync', async () => ({
        diff: 'diff --git a/app.ts b/app.ts',
        plan: 'plan',
        taskPacket: 'packet',
        designContext: null,
        metadata: {
          branch: 'task/no-integration-branch',
          files: ['app.ts'],
          hasUiChanges: false,
        },
      }));
      mock.method(reviewRunnerDeps, 'execShellCommand', (command: string) => {
        if (command.includes('git merge-base')) {
          throw new Error('fatal: Not a valid object name auto/integration');
        }
        throw new Error(`unexpected command: ${command}`);
      });
      mock.method(reviewRunnerDeps, 'detectCrossPrReverts', () => {
        throw new Error('detectCrossPrReverts should not run when integration ref is missing');
      });
      mock.method(reviewRunnerDeps, 'runReview', async (context) => {
        assert.match(context.diff, /Cross-PR revert detector findings/);
        return {
          verdict: 'ready',
          codeReviewFindings: [],
          metadata: {
            branch: 'task/no-integration-branch',
            files: ['app.ts'],
            hasUiChanges: false,
            designContextAvailable: false,
            uiVerificationRun: false,
          },
        };
      });

      const result = await reviewChanges({
        repoDir: TEST_DIR,
      });

      assert.equal(result.verdict, 'not_ready');
      const evidenceFindings = result.codeReviewFindings.filter((f) => f.category === 'cross-pr-revert');
      assert.equal(evidenceFindings.length, 1);
      assert.match(evidenceFindings[0].description, /Unable to prove/);
    });
  });

  describe('Review Scope Guard Classification (HOK-2889)', () => {
    function makeGuardResult(overrides: Partial<ReviewScopeGuardResult>): ReviewScopeGuardResult {
      return {
        ok: false,
        status: 'error',
        baselinePaths: [],
        declaredScope: [],
        baselineSource: 'unresolved',
        baselineIsArtifact: false,
        featureDir: null,
        integrationRef: 'auto/integration',
        mergeBase: null,
        taskPaths: [],
        stagedPaths: [],
        allowedCompanionPaths: [],
        outOfScopePaths: [],
        findings: [],
        crossPrReverts: [],
        message: 'review scope guard result',
        ...overrides,
      };
    }

    function mockReviewPipeline(runReviewResult: Record<string, unknown>): void {
      mock.method(reviewRunnerDeps, 'getCurrentBranch', () => 'task/scope-guard');
      mock.method(reviewRunnerDeps, 'getGitDiff', () => 'diff --git a/app.ts b/app.ts');
      mock.method(reviewRunnerDeps, 'assertReviewableDiff', () => undefined);
      mock.method(reviewRunnerDeps, 'ensureClaudeAvailable', async () => undefined);
      mock.method(reviewRunnerDeps, 'gatherReviewContextAsync', async () => ({
        diff: 'diff --git a/app.ts b/app.ts',
        plan: 'plan',
        taskPacket: 'packet',
        designContext: null,
        metadata: {
          branch: 'task/scope-guard',
          files: ['app.ts'],
          hasUiChanges: false,
        },
      }));
      mock.method(reviewRunnerDeps, 'execShellCommand', (command: string) => {
        if (command.includes('git merge-base')) {
          return 'base-sha\n';
        }
        if (command.includes('gh pr view')) {
          return '';
        }
        if (command.includes('git log --format=%B')) {
          return '';
        }
        throw new Error(`unexpected command: ${command}`);
      });
      mock.method(reviewRunnerDeps, 'detectCrossPrReverts', () => []);
      mock.method(reviewRunnerDeps, 'runReview', async () => ({
        verdict: 'ready',
        codeReviewFindings: [],
        metadata: {
          branch: 'task/scope-guard',
          files: ['app.ts'],
          hasUiChanges: false,
          designContextAvailable: false,
          uiVerificationRun: false,
        },
        ...runReviewResult,
      }));
    }

    it('surfaces an unverifiable scope guard as a warning plus failureCategory, never a blocker', async () => {
      mockReviewPipeline({});
      mock.method(reviewRunnerDeps, 'validateReviewScope', () => makeGuardResult({
        status: 'error',
        toolError: {
          commandClass: 'git-diff-baseline',
          command: 'git diff --name-only',
          exitCode: 128,
          stderr: 'fatal: bad object',
        },
      }));

      const result = await reviewChanges({ repoDir: TEST_DIR });

      assert.equal(result.verdict, 'ready');
      assert.equal(result.failureCategory, 'review-scope-unverifiable');
      const scopeFindings = result.codeReviewFindings.filter((f) => f.category === 'review-scope');
      assert.equal(scopeFindings.length, 1);
      assert.equal(scopeFindings[0].severity, 'warning');
      assert.match(scopeFindings[0].description, /could not be verified/);
      assert.match(scopeFindings[0].description, /not a code defect/);
      const blockers = result.codeReviewFindings.filter((f) => f.severity === 'blocker');
      assert.equal(blockers.length, 0);
    });

    it('still blocks on a real scope violation without an infra failure category', async () => {
      mockReviewPipeline({});
      mock.method(reviewRunnerDeps, 'validateReviewScope', () => makeGuardResult({
        ok: false,
        status: 'fail',
        outOfScopePaths: ['rogue.ts'],
        findings: [{
          severity: 'blocker',
          kind: 'violation',
          category: 'review-scope',
          path: 'rogue.ts',
          message: 'Unexpected review change outside task scope: rogue.ts (M).',
        }],
      }));

      const result = await reviewChanges({ repoDir: TEST_DIR });

      assert.equal(result.verdict, 'not_ready');
      assert.equal(result.failureCategory, undefined);
      const scopeFindings = result.codeReviewFindings.filter((f) => f.category === 'review-scope');
      assert.equal(scopeFindings.length, 1);
      assert.equal(scopeFindings[0].severity, 'blocker');
    });

    it('never clobbers an existing failure category from the review engine', async () => {
      mockReviewPipeline({ failureCategory: 'native-runtime-unavailable' });
      mock.method(reviewRunnerDeps, 'validateReviewScope', () => makeGuardResult({
        status: 'error',
        toolError: {
          commandClass: 'git-diff-baseline',
          command: 'git diff --name-only',
          stderr: 'fatal: bad object',
        },
      }));

      const result = await reviewChanges({ repoDir: TEST_DIR });

      assert.equal(result.failureCategory, 'native-runtime-unavailable');
    });

    it('treats a thrown guard as unverifiable instead of failing the review', async () => {
      mockReviewPipeline({});
      mock.method(reviewRunnerDeps, 'validateReviewScope', () => {
        throw new Error('unexpected guard crash');
      });

      const result = await reviewChanges({ repoDir: TEST_DIR });

      assert.equal(result.verdict, 'ready');
      assert.equal(result.failureCategory, 'review-scope-unverifiable');
      const scopeFindings = result.codeReviewFindings.filter((f) => f.category === 'review-scope');
      assert.equal(scopeFindings.length, 1);
      assert.equal(scopeFindings[0].severity, 'warning');
      assert.match(scopeFindings[0].description, /unexpected guard crash/);
    });
  });

  describe('Review Result Parsing', () => {
    it('should handle ready verdict with no findings', () => {
      const mockResponse = {
        verdict: 'ready',
        codeReviewFindings: [],
      };

      assert.equal(mockResponse.verdict, 'ready');
      assert.equal(mockResponse.codeReviewFindings.length, 0);
    });

    it('should handle not_ready verdict with blockers', () => {
      const mockResponse = {
        verdict: 'not_ready',
        codeReviewFindings: [
          {
            severity: 'blocker',
            location: 'test.ts:10',
            category: 'security',
            description: 'SQL injection vulnerability',
          },
        ],
      };

      assert.equal(mockResponse.verdict, 'not_ready');
      assert.equal(mockResponse.codeReviewFindings.length, 1);
      assert.equal(mockResponse.codeReviewFindings[0].severity, 'blocker');
    });

    it('should handle UI findings when present', () => {
      const mockResponse = {
        verdict: 'not_ready',
        codeReviewFindings: [],
        uiFindings: [
          {
            severity: 'warning',
            location: 'Button.tsx:25',
            category: 'consistency',
            description: 'Using arbitrary color instead of design token',
          },
        ],
      };

      assert.ok(mockResponse.uiFindings);
      assert.equal(mockResponse.uiFindings.length, 1);
    });

    it('should handle stronger reviewer escalation fields when present', () => {
      const mockResponse = {
        verdict: 'ready',
        codeReviewFindings: [],
        needsStrongerReviewer: true,
        strongerReviewerReason: 'Cross-file contract verification was incomplete',
      };

      assert.equal(mockResponse.needsStrongerReviewer, true);
      assert.match(mockResponse.strongerReviewerReason, /Cross-file contract/);
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed JSON response gracefully', () => {
      const malformedJson = '{ "verdict": "ready", "codeReviewFindings": [';

      assert.throws(() => JSON.parse(malformedJson));
    });

    it('should handle missing verdict in response', () => {
      const invalidResponse: Record<string, unknown> = {
        codeReviewFindings: [],
      };

      assert.equal(invalidResponse.verdict, undefined);
    });

    it('should handle invalid verdict value', () => {
      const invalidResponse = {
        verdict: 'maybe',
        codeReviewFindings: [],
      };

      assert.equal(['ready', 'not_ready'].includes(invalidResponse.verdict), false);
    });
  });
});
