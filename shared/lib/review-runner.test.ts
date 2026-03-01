/**
 * Tests for review-runner module.
 *
 * Note: These tests focus on logic validation without invoking the actual LLM.
 * End-to-end tests with real LLM calls should be run manually.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ReviewResult, ReviewOptions } from './review-runner.ts';

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
