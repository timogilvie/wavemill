/**
 * Tests for llm-cli.ts classifier isolation (HOK-3202)
 *
 * Verifies that:
 * 1. Classifier spawns are isolated from the interactive agent harness
 * 2. is_error envelopes throw proper errors
 * 3. Non-classifier calls are not isolated
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('llm-cli classifier isolation (HOK-3202)', () => {
  it('classifier spawn sets MAX_THINKING_TOKENS=0 and isolation flags', async () => {
    // We'll test this by importing the module and inspecting spawn calls
    // Since we can't easily mock spawn in ES modules, we'll test integration
    // by creating a mock claude CLI that echoes its args and env

    const testDir = mkdtempSync(join(tmpdir(), 'llm-cli-test-'));

    try {
      // Create a mock claude CLI that outputs its args and env
      const mockClaudePath = join(testDir, 'claude');
      const mockClaudeScript = `#!/bin/bash
echo '{"result":"OK","env_max_thinking":"'"\${MAX_THINKING_TOKENS:-unset}"'","args":"'"$*"'"}'
`;
      await import('node:fs/promises').then(fs => fs.writeFile(mockClaudePath, mockClaudeScript, { mode: 0o755 }));

      // Import and call llm-cli with classifier taskType
      const { callLLM } = await import('../shared/lib/llm-cli.ts');

      const result = await callLLM('test prompt', {
        provider: 'claude',
        taskType: 'classify',
        cliCmd: mockClaudePath,
        mode: 'sync',
      });

      // Parse the response to check env and args
      const parsed = JSON.parse(result.rawOutput);

      // Should have MAX_THINKING_TOKENS=0
      assert.equal(parsed.env_max_thinking, '0', 'MAX_THINKING_TOKENS should be 0 for classifier');

      // Should have isolation flags
      assert.match(parsed.args, /--tools/, 'Should include --tools flag');
      assert.match(parsed.args, /--strict-mcp-config/, 'Should include --strict-mcp-config flag');
      assert.match(parsed.args, /--no-session-persistence/, 'Should include --no-session-persistence flag');
      assert.match(parsed.args, /--disable-slash-commands/, 'Should include --disable-slash-commands flag');

    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('non-classifier spawn does not add isolation flags', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'llm-cli-test-'));

    try {
      const mockClaudePath = join(testDir, 'claude');
      const mockClaudeScript = `#!/bin/bash
echo '{"result":"OK","env_max_thinking":"'"\${MAX_THINKING_TOKENS:-unset}"'","args":"'"$*"'"}'
`;
      await import('node:fs/promises').then(fs => fs.writeFile(mockClaudePath, mockClaudeScript, { mode: 0o755 }));

      const { callLLM } = await import('../shared/lib/llm-cli.ts');

      const result = await callLLM('test prompt', {
        provider: 'claude',
        taskType: 'plan', // Not 'classify'
        cliCmd: mockClaudePath,
        mode: 'sync',
      });

      const parsed = JSON.parse(result.rawOutput);

      // Should NOT have MAX_THINKING_TOKENS set
      assert.equal(parsed.env_max_thinking, 'unset', 'MAX_THINKING_TOKENS should not be set for non-classifier');

      // Should NOT have isolation flags
      assert.doesNotMatch(parsed.args, /--tools/, 'Should not include --tools flag for non-classifier');
      assert.doesNotMatch(parsed.args, /--strict-mcp-config/, 'Should not include --strict-mcp-config for non-classifier');

    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('is_error envelope throws proper error', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'llm-cli-test-'));

    try {
      const mockClaudePath = join(testDir, 'claude');
      const mockClaudeScript = `#!/bin/bash
echo '{"is_error":true,"error":"API Error: response exceeded the 1024 output token maximum"}'
`;
      await import('node:fs/promises').then(fs => fs.writeFile(mockClaudePath, mockClaudeScript, { mode: 0o755 }));

      const { callLLM } = await import('../shared/lib/llm-cli.ts');

      // Should throw an error because is_error is true
      let caughtError: Error | null = null;
      try {
        await callLLM('test prompt', {
          provider: 'claude',
          cliCmd: mockClaudePath,
          mode: 'sync',
        });
      } catch (err) {
        caughtError = err as Error;
      }

      assert.ok(caughtError, 'Should have thrown an error');
      assert.match(caughtError!.message, /claude CLI returned is_error:/, 'Error should mention is_error');
      assert.match(caughtError!.message, /exceeded the 1024 output token maximum/, 'Error should include the error message');

    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
