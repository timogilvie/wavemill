import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeCliAdapter,
  claudeCliReportedModelMatches,
  normalizeClaudeCliModelId,
  CLAUDE_CLI_HARNESS_OVERHEAD_TOKENS,
} from './claude-cli-adapter.ts';
import { CodexCliAdapter, CODEX_CLI_MAX_INPUT_CHARS } from './codex-cli-adapter.ts';
import { NativeOpenAIAdapter, NativeOpenRouterAdapter } from './native-adapter.ts';
import { resolveModelAdapter } from './resolve-adapter.ts';
import {
  BYTES_PER_TOKEN_DEFAULT,
  estimateTokensDefault,
  estimateTokensWithBytesPerToken,
} from './token-estimator.ts';
import { policyKindFor } from './transport-adapter.ts';

describe('token-estimator', () => {
  it('estimateTokensDefault scales with byte length', () => {
    assert.equal(estimateTokensDefault(''), 0);
    assert.equal(estimateTokensDefault('x'.repeat(300)), Math.ceil(300 / BYTES_PER_TOKEN_DEFAULT));
  });

  it('estimateTokensWithBytesPerToken rejects non-positive ratios', () => {
    assert.throws(() => estimateTokensWithBytesPerToken('abc', 0));
    assert.throws(() => estimateTokensWithBytesPerToken('abc', -1));
  });

  it('estimateTokensWithBytesPerToken calibrates against the given ratio', () => {
    const text = 'x'.repeat(1200);
    assert.equal(estimateTokensWithBytesPerToken(text, 3), 400);
    assert.equal(estimateTokensWithBytesPerToken(text, 2.4), Math.ceil(1200 / 2.4));
  });
});

describe('policyKindFor maps AdapterError.kind → ProviderErrorKind', () => {
  it('maps context errors to context-window-exceeded', () => {
    assert.equal(policyKindFor('input-too-large'), 'context-window-exceeded');
    assert.equal(policyKindFor('context-exceeded'), 'context-window-exceeded');
  });
  it('maps auth to provider-config-error', () => {
    assert.equal(policyKindFor('auth'), 'provider-config-error');
  });
  it('maps rate-limit and transient to provider-transient-error', () => {
    assert.equal(policyKindFor('rate-limit'), 'provider-transient-error');
    assert.equal(policyKindFor('transient'), 'provider-transient-error');
  });
  it('maps quota to provider-credit-exhausted', () => {
    assert.equal(policyKindFor('quota'), 'provider-credit-exhausted');
  });
  it('maps unknown to provider-unknown-error', () => {
    assert.equal(policyKindFor('unknown'), 'provider-unknown-error');
  });
});

describe('ClaudeCliAdapter', () => {
  it('exposes claude CLI harness overhead and registry limits', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'claude-adapter-'));
    try {
      const adapter = new ClaudeCliAdapter({ model: 'claude-haiku-4-5', repoDir });
      assert.equal(adapter.kind, 'claude-cli');
      assert.equal(adapter.limits.cliHarnessOverheadTokens, CLAUDE_CLI_HARNESS_OVERHEAD_TOKENS);
      // claude-haiku-4-5 is in the registry → contextWindowTokens populated.
      assert.ok(typeof adapter.limits.contextWindowTokens === 'number');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('refuses an oversized HOK-2804-shaped prompt without a network call', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'claude-adapter-cw-'));
    try {
      const adapter = new ClaudeCliAdapter({ model: 'claude-haiku-4-5', repoDir });
      // 2.8MB JSON-heavy payload like HOK-2804.
      const hugePrompt = JSON.stringify({ blob: 'x'.repeat(2_800_000) });
      const refusal = adapter.preflight(hugePrompt);
      assert.ok(refusal, 'preflight should refuse the HOK-2804 prompt');
      assert.equal(refusal!.kind, 'context-exceeded');
      assert.equal(refusal!.policyKind, 'context-window-exceeded');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('parseResult recovers the real CLI error text from stdout on non-zero exit', () => {
    const adapter = new ClaudeCliAdapter({ model: 'claude-haiku-4-5' });
    const stdoutError = JSON.stringify({
      is_error: true,
      error: 'rate limit reached, retry-after: 42',
    });
    const parsed = adapter.parseResult(stdoutError, '', 1);
    assert.ok(parsed.error);
    assert.equal(parsed.error!.kind, 'rate-limit');
    assert.match(parsed.error!.message, /rate limit reached/);
    assert.equal(parsed.error!.policyKind, 'provider-transient-error');
  });

  it('parseResult still carries stdout text when stdout is not a JSON envelope', () => {
    const adapter = new ClaudeCliAdapter({ model: 'claude-haiku-4-5' });
    const parsed = adapter.parseResult('garbage not json', '', 1);
    assert.ok(parsed.error);
    assert.equal(parsed.error!.kind, 'unknown');
    assert.match(parsed.error!.message, /garbage not json/);
  });

  it('parseResult parses a successful JSON envelope with usage and modelUsage', () => {
    const adapter = new ClaudeCliAdapter({ model: 'claude-haiku-4-5' });
    const stdoutOk = JSON.stringify({
      result: 'done',
      usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 },
      total_cost_usd: 0.00123,
      modelUsage: { 'claude-haiku-4-5': { requests: 1 } },
    });
    const parsed = adapter.parseResult(stdoutOk, '', 0);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.text, 'done');
    assert.equal(parsed.reportedModel, 'claude-haiku-4-5');
    assert.equal(parsed.usage?.inputTokens, 15);
    assert.equal(parsed.usage?.outputTokens, 3);
    assert.equal(parsed.usage?.totalTokens, 18);
    assert.equal(parsed.usage?.costUsd, 0.00123);
  });

  it('normalizeClaudeCliModelId strips provider prefix, variant, and dated snapshot', () => {
    assert.equal(normalizeClaudeCliModelId('anthropic/claude-opus-4-6'), 'claude-opus-4-6');
    assert.equal(normalizeClaudeCliModelId('claude-opus-4-6[1m]'), 'claude-opus-4-6');
    assert.equal(normalizeClaudeCliModelId('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  });

  it('claudeCliReportedModelMatches identifies variant and snapshot pairs', () => {
    assert.equal(claudeCliReportedModelMatches('claude-opus-4-6', 'claude-opus-4-6[1m]'), true);
    assert.equal(claudeCliReportedModelMatches('claude-haiku-4-5-20251001', 'claude-haiku-4-5'), true);
    assert.equal(claudeCliReportedModelMatches('claude-sonnet-5', 'claude-opus-5-5'), false);
  });
});

describe('CodexCliAdapter', () => {
  it('declares the codex 1,048,576-char input cap', () => {
    const adapter = new CodexCliAdapter({ model: 'gpt-5.6-terra' });
    assert.equal(adapter.limits.maxInputChars, CODEX_CLI_MAX_INPUT_CHARS);
    assert.equal(adapter.limits.cliHarnessOverheadTokens, 20_000);
  });

  it('refuses a prompt that exceeds the char cap with input-too-large', () => {
    const adapter = new CodexCliAdapter({ model: 'gpt-5.6-terra' });
    const refusal = adapter.preflight('x'.repeat(CODEX_CLI_MAX_INPUT_CHARS + 1));
    assert.ok(refusal);
    assert.equal(refusal!.kind, 'input-too-large');
    assert.equal(refusal!.policyKind, 'context-window-exceeded');
    assert.match(refusal!.message, /1048576-char input cap/);
  });

  it('parseResult reports input-too-large when codex writes the char-cap rejection to stderr', () => {
    const adapter = new CodexCliAdapter({ model: 'gpt-5.6-terra' });
    const stderr = 'Error: Input exceeds the maximum length of 1048576 characters (actual_chars: 2809877)';
    const parsed = adapter.parseResult('', stderr, 1);
    assert.ok(parsed.error);
    assert.equal(parsed.error!.kind, 'input-too-large');
    assert.equal(parsed.error!.policyKind, 'context-window-exceeded');
    assert.match(parsed.error!.message, /Input exceeds the maximum length/);
  });

  it('parseResult reports a 429 rate-limit from stderr', () => {
    const adapter = new CodexCliAdapter({ model: 'gpt-5.6-terra' });
    const parsed = adapter.parseResult('', 'HTTP 429 rate_limit_exceeded', 1);
    assert.ok(parsed.error);
    assert.equal(parsed.error!.kind, 'rate-limit');
    assert.equal(parsed.error!.policyKind, 'provider-transient-error');
  });

  it('parseResult extracts agent_message + usage from a JSONL turn stream', () => {
    const adapter = new CodexCliAdapter({ model: 'gpt-5.6-terra' });
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3, reasoning_output_tokens: 1 } }),
    ].join('\n');
    const parsed = adapter.parseResult(stdout, '', 0);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.text, 'hello');
    assert.equal(parsed.reportedModel, 'unverified');
    assert.equal(parsed.usage?.inputTokens, 10);
    assert.equal(parsed.usage?.outputTokens, 4);
    assert.equal(parsed.usage?.totalTokens, 14);
  });
});

describe('Native adapters', () => {
  it('populate limits from the registry and refuse an outsized prompt', () => {
    const adapter = new NativeOpenRouterAdapter({ model: 'gpt-5.6-terra' });
    assert.equal(adapter.kind, 'native-openrouter');
    assert.equal(adapter.limits.cliHarnessOverheadTokens, 0);
    const huge = 'x'.repeat(10_000_000);
    const refusal = adapter.preflight(huge);
    // The registry has a limit for gpt-5.6-terra, so this must refuse.
    assert.ok(refusal);
    assert.equal(refusal!.kind, 'context-exceeded');
  });

  it('invoke and parseResult throw with a clear message (native does not use them)', async () => {
    const adapter = new NativeOpenAIAdapter({ model: 'gpt-5.6-terra' });
    await assert.rejects(() => adapter.invoke('x'), /no transport-level invoke/);
    assert.throws(() => adapter.parseResult('', '', 0), /parseResult/);
  });
});

describe('resolveModelAdapter', () => {
  it('returns a claude-cli adapter for an Anthropic model', () => {
    const result = resolveModelAdapter({ model: 'claude-haiku-4-5', phase: 'review' });
    assert.equal(result.resolution.ok, true);
    assert.equal(result.adapter?.kind, 'claude-cli');
  });

  it('returns a codex-cli adapter for a gpt-* model', () => {
    const result = resolveModelAdapter({ model: 'gpt-5.6-terra', phase: 'review' });
    assert.equal(result.resolution.ok, true);
    assert.equal(result.adapter?.kind, 'codex-cli');
  });

  it('returns null adapter when the model is unroutable', () => {
    const result = resolveModelAdapter({ model: 'not-a-model-anywhere', phase: 'review' });
    assert.equal(result.resolution.ok, false);
    assert.equal(result.adapter, null);
  });
});
