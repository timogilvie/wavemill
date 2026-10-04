/**
 * Tests for prompt template version registry.
 *
 * @module prompt-registry.test
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { logPromptUsage, loadAndRegisterTemplate, type PromptRegistryEntry } from './prompt-registry.ts';
import { openManifest, getManifest } from './resource-manifest.ts';

// ────────────────────────────────────────────────────────────────
// Test Fixtures
// ────────────────────────────────────────────────────────────────

const TEST_DIR = join(process.cwd(), '.test-prompt-registry');
const REGISTRY_PATH = join(TEST_DIR, 'prompt-registry.jsonl');
const TEMPLATE_PATH = join(TEST_DIR, 'test-template.md');

/** Read all entries from the registry file */
function readRegistry(): PromptRegistryEntry[] {
  if (!existsSync(REGISTRY_PATH)) {
    return [];
  }

  const content = readFileSync(REGISTRY_PATH, 'utf-8');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PromptRegistryEntry);
}

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('prompt-registry', () => {
  beforeEach(() => {
    // Clean up test directory before each test
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory after each test
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe('logPromptUsage', () => {
    it('creates registry file on first use', () => {
      logPromptUsage('tools/prompts/test.md', 'Hello {{VAR}}', { dir: TEST_DIR });

      assert.ok(existsSync(REGISTRY_PATH), 'Registry file should be created');
    });

    it('logs template name, hash, and timestamp', () => {
      const content = 'Hello {{VAR}}';
      logPromptUsage('tools/prompts/issue-writer.md', content, { dir: TEST_DIR });

      const entries = readRegistry();
      assert.equal(entries.length, 1, 'Should have one entry');

      const entry = entries[0];
      assert.equal(entry.templateName, 'issue-writer', 'Should extract template name');
      assert.ok(entry.templateHash, 'Should have hash');
      assert.ok(entry.timestamp, 'Should have timestamp');
      assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T/, 'Timestamp should be ISO 8601');
    });

    it('includes template content for new hashes', () => {
      const content = 'Hello {{VAR}}';
      logPromptUsage('tools/prompts/test.md', content, { dir: TEST_DIR });

      const entries = readRegistry();
      assert.equal(entries[0].templateContent, content, 'Should include content for new hash');
    });

    it('deduplicates by hash - same template logged twice produces one content entry', () => {
      const content = 'Hello {{VAR}}';

      // Log the same template twice
      logPromptUsage('tools/prompts/test.md', content, { dir: TEST_DIR });
      logPromptUsage('tools/prompts/test.md', content, { dir: TEST_DIR });

      const entries = readRegistry();
      assert.equal(entries.length, 2, 'Should have two entries (both usages logged)');

      // First entry should have content
      assert.ok(entries[0].templateContent, 'First entry should have content');

      // Second entry should NOT have content (hash already exists)
      assert.equal(entries[1].templateContent, undefined, 'Second entry should not have content');

      // Both should have same hash
      assert.equal(entries[0].templateHash, entries[1].templateHash, 'Should have same hash');
    });

    it('logs different hashes for different content', () => {
      logPromptUsage('tools/prompts/test.md', 'Version 1', { dir: TEST_DIR });
      logPromptUsage('tools/prompts/test.md', 'Version 2', { dir: TEST_DIR });

      const entries = readRegistry();
      assert.equal(entries.length, 2, 'Should have two entries');

      // Both should have content (different hashes)
      assert.ok(entries[0].templateContent, 'First entry should have content');
      assert.ok(entries[1].templateContent, 'Second entry should have content');

      // Hashes should be different
      assert.notEqual(entries[0].templateHash, entries[1].templateHash, 'Hashes should differ');
    });

    it('handles registry failures gracefully without throwing', () => {
      // Make directory read-only to force failure
      mkdirSync(join(TEST_DIR, '.subdir'), { recursive: true });
      writeFileSync(REGISTRY_PATH, 'invalid');

      // This shouldn't throw even if write fails
      assert.doesNotThrow(() => {
        logPromptUsage('tools/prompts/test.md', 'Hello', { dir: '/invalid/path/that/cannot/exist' });
      }, 'Should not throw on registry failure');
    });

    it('extracts template name correctly from various paths', () => {
      const testCases = [
        { path: 'tools/prompts/issue-writer.md', expected: 'issue-writer' },
        { path: '/abs/path/eval-judge.md', expected: 'eval-judge' },
        { path: 'template.txt', expected: 'template' },
        { path: 'nested/path/to/review.md', expected: 'review' },
      ];

      for (const { path, expected } of testCases) {
        // Clear registry between tests
        if (existsSync(REGISTRY_PATH)) {
          rmSync(REGISTRY_PATH);
        }

        logPromptUsage(path, 'content', { dir: TEST_DIR });
        const entries = readRegistry();

        assert.equal(entries[0].templateName, expected, `Should extract "${expected}" from "${path}"`);
      }
    });
  });

  describe('loadAndRegisterTemplate', async () => {
    it('loads template content and registers usage', async () => {
      // Create a test template file
      const templateContent = 'Test template: {{VAR}}';
      writeFileSync(TEMPLATE_PATH, templateContent, 'utf-8');

      const loaded = await loadAndRegisterTemplate(TEMPLATE_PATH, { dir: TEST_DIR });

      // Should return the content
      assert.equal(loaded, templateContent, 'Should return template content');

      // Should create registry entry
      const entries = readRegistry();
      assert.equal(entries.length, 1, 'Should log to registry');
      assert.equal(entries[0].templateName, 'test-template', 'Should extract template name');
      assert.equal(entries[0].templateContent, templateContent, 'Should include content');
    });

    it('throws if template file does not exist', async () => {
      await assert.rejects(
        async () => loadAndRegisterTemplate('/nonexistent/template.md', { dir: TEST_DIR }),
        'Should throw if template file does not exist'
      );
    });

    it('returns content even if registry logging fails', async () => {
      // Create a test template file
      const templateContent = 'Test template';
      writeFileSync(TEMPLATE_PATH, templateContent, 'utf-8');

      // Force registry failure by using invalid path, but this should still succeed
      const loaded = await loadAndRegisterTemplate(TEMPLATE_PATH, { dir: '/invalid/path' });

      assert.equal(loaded, templateContent, 'Should return content despite registry failure');
    });
  });

  describe('performance', () => {
    it('completes logging in under 250ms', () => {
      const content = 'Performance test template {{VAR}}';
      const start = Date.now();

      logPromptUsage('tools/prompts/perf-test.md', content, { dir: TEST_DIR });

      const duration = Date.now() - start;
      // The unit runner executes hundreds of files concurrently; retain a
      // meaningful bound without making this filesystem check scheduler-flaky.
      assert.ok(duration < 250, `Should complete in <250ms (took ${duration}ms)`);
    });
  });

  describe('native prompt usage', () => {
    it('records native-read-only-phase template name and hash', () => {
      const content = 'You are a read-only native planning agent.\nDo not modify any files.';
      const ref = logPromptUsage('tools/prompts/native-read-only-phase.md', content, { dir: TEST_DIR });

      assert.ok(ref, 'logPromptUsage must return a ResourceRef for native prompt');

      const entries = readRegistry();
      assert.equal(entries.length, 1, 'exactly one registry entry');
      assert.equal(entries[0].templateName, 'native-read-only-phase', 'template name must be extracted from path');
      assert.ok(entries[0].templateHash, 'hash must be present');
      assert.equal(entries[0].templateContent, content, 'content must be stored for new hash');
    });

    it('records native manifest usage when WAVEMILL_SESSION is set', () => {
      // Open a manifest so recordUse (called inside logPromptUsage) can attach a phase ref.
      const sessionId = 'native-prompt-test-session';
      openManifest(sessionId, { workflowType: 'feature', repoDir: TEST_DIR });

      const origSession = process.env.WAVEMILL_SESSION;
      const origPhase = process.env.WAVEMILL_PHASE;
      try {
        process.env.WAVEMILL_SESSION = sessionId;
        process.env.WAVEMILL_PHASE = 'planning';

        const content = 'Native planning system prompt content';
        logPromptUsage('tools/prompts/native-read-only-phase.md', content, { dir: TEST_DIR });

        const manifest = getManifest(sessionId, TEST_DIR);
        assert.ok(manifest, 'manifest must exist');
        const planningRefs = manifest?.phases.planning ?? [];
        assert.ok(planningRefs.length > 0, 'planning phase must have at least one resource ref');
      } finally {
        if (origSession === undefined) {
          delete process.env.WAVEMILL_SESSION;
        } else {
          process.env.WAVEMILL_SESSION = origSession;
        }
        if (origPhase === undefined) {
          delete process.env.WAVEMILL_PHASE;
        } else {
          process.env.WAVEMILL_PHASE = origPhase;
        }
      }
    });
  });

  it('repoDir option logs to the main checkout evals dir, never the worktree root', () => {
    const root = mkdtempSync(join(tmpdir(), 'prompt-registry-worktree-'));
    try {
      const main = join(root, 'main');
      const wt = join(root, 'wt');
      mkdirSync(main);
      const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
      git(main, 'init', '-q');
      git(main, '-c', 'user.email=t@e.st', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
      git(main, 'worktree', 'add', '-q', '-b', 'task/x', wt);

      logPromptUsage('tools/prompts/native-read-only-phase.md', 'phase prompt', { repoDir: wt });

      assert.equal(existsSync(join(wt, 'prompt-registry.jsonl')), false, 'registry leaked into worktree root');
      assert.equal(existsSync(join(main, '.wavemill', 'evals', 'prompt-registry.jsonl')), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
