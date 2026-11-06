import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { checkGuardSource } from '../../../tools/lib/source-guard.ts';
import { OUTPUT_RESERVATION_GUARD } from '../../../tools/check-output-reservation.ts';
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

// Replay the incident through the shared external-edge fake. The fake needs
// 8193 total reasoning + answer tokens; a preflight reservation of 8192
// must not be imposed as its generated-output cap.
describe('CLI output reservation incident replay', () => {
  it('keeps reservations separate from explicit caps, preserves ownership, and reports buffered timeouts truthfully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-output-contract-'));
    const script = String.raw`
      import assert from 'node:assert/strict';
      import { writeFileSync, readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { ClaudeCliAdapter } from './shared/lib/model-adapters/claude-cli-adapter.ts';
      import { readOwnershipRows } from './shared/lib/session-ownership.ts';
      const verdictFile = join(process.env.FAKE_ROOT, 'review.json');
      writeFileSync(verdictFile, JSON.stringify({verdict:'ready',codeReviewFindings:[]}));
      process.env.FAKE_JUDGE_VERDICT_FILE = verdictFile;
      const incident = JSON.parse(readFileSync('./tests/fixtures/review-output-contract/incident.json','utf8'));
      assert.equal(incident.completion.thinkingTokens,incident.request.maxTokens);
      process.env.FAKE_JUDGE_REQUIRED_OUTPUT_TOKENS = String(incident.completion.outputTokens + 1);
      delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
      const featureDir = join(process.env.FAKE_REPO_DIR, 'features', 'review');
      const adapter = new ClaudeCliAdapter({model:incident.request.model,repoDir:process.env.FAKE_REPO_DIR,reservedOutputTokens:incident.request.maxTokens});
      assert.equal(adapter.limits.reservedOutputTokens,8192);
      assert.equal(adapter.limits.maxOutputTokens,undefined);
      const options = {cwd:process.env.FAKE_REPO_DIR,ownership:{featureDir,helperPurpose:'json-code-review'}};
      const result = await adapter.invoke('Return the review verdict.',options);
      assert.equal(result.error,undefined);
      assert.equal(JSON.parse(result.text).verdict,'ready');
      assert.equal(result.reportedModel,'claude-sonnet-5');
      const row = readOwnershipRows(featureDir)[0];
      assert.equal(row.kind,'helper:json-code-review');
      assert.equal(row.model,'claude-sonnet-5');
      assert.equal(row.harness,'claude-code');
      const calls = readFileSync(join(process.env.FAKE_ROOT,'logs','judge-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(calls[0].maxOutputTokens,'');
      const capped = await adapter.invoke('Return the review verdict.',{...options,maxOutputTokens:8192});
      assert.match(capped.error?.message ?? '',/exhausted max_tokens/);
      const explicit = await adapter.invoke('Return the review verdict.',{...options,maxOutputTokens:9000});
      assert.equal(explicit.error,undefined);
      process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '9000';
      const inherited = await adapter.invoke('Return the review verdict.',options);
      assert.equal(inherited.error,undefined);
      const later = readFileSync(join(process.env.FAKE_ROOT,'logs','judge-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(later.at(-1).maxOutputTokens,'9000');
      process.env.FAKE_JUDGE_DELAY_SECONDS = '1';
      const timeout = await adapter.invoke('Return the review verdict.',{...options,timeout:100});
      assert.match(timeout.error?.message ?? '',/hard wall-clock cap/);
      assert.match(timeout.error.message,/Output silence does not establish agent liveness/);
      assert.doesNotMatch(timeout.error.message,/Process state:|IDLE/);
      console.log('OUTPUT_CONTRACT_REPLAY_PASSED');
    `;
    try {
      const output = execFileSync('bash', ['-c', `
        set -euo pipefail
        source "$1/tests/fakes/lib.sh"
        fakes_setup "$2/world"
        node --import tsx --input-type=module -e "$3"
      `, '_', process.cwd(), dir, script], {cwd:process.cwd(), encoding:'utf8',timeout:60_000,env:{...process.env,CLAUDE_CMD:'claude'}});
      assert.match(output,/OUTPUT_CONTRACT_REPLAY_PASSED/);
    } finally {
      rmSync(dir,{recursive:true,force:true});
    }
  });
});

// Guard against reintroducing the same decision in another call site.
it('output reservation guard rejects cap conflation and native ceilings in CLI review', () => {
  const scan = (file: string, source: string) => checkGuardSource(OUTPUT_RESERVATION_GUARD,file,source).map(f=>f.pattern);
  assert.deepEqual(scan('shared/lib/model-adapters/new-cli.ts','maxOutputTokens: opts.maxOutputTokens ?? this.reservedOutputTokens,'),['reservation-as-invocation-cap']);
  assert.deepEqual(scan('shared/lib/review-engine.ts','const options = { reservedOutputTokens: REVIEW_MAX_OUTPUT_TOKENS };'),['native-ceiling-in-cli-review']);
  assert.deepEqual(scan('shared/lib/model-adapters/claude-cli-adapter.ts','maxOutputTokens: opts.maxOutputTokens,'),[]);
  assert.deepEqual(scan('shared/lib/native-agent/review.ts','const cap = REVIEW_MAX_OUTPUT_TOKENS;'),[]);
});
