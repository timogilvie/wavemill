import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runNativeReview, nativeReviewTestUtils } from './review.ts';
import { ContextExhaustedError, ContextWindowExceededError } from './context-window-guard.ts';
import type { ReviewContext } from '../review-context-gatherer.ts';
import { parseTranscriptJsonl } from './transcript.ts';
import type { ReadyNativeProviderEntry } from './providers.ts';
import {
  getStageFailureEnvelopePath,
  readStageFailureEnvelope,
  type StageFailureEnvelope,
} from './stage-failure-envelope.ts';

describe('native review', () => {
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    nativeReviewTestUtils.resetDeps();
    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }
  });

  it('returns parsed review results from the native loop', async () => {
    const repoDir = makeTempRepo();
    setReadyProvider();

    nativeReviewTestUtils.setRunWavemillLoop(async (config) => {
      assert.equal(config.maxTokens, 8192);
      assert.equal(config.budget?.maxTurns, 11);
      assert.equal(config.budget?.maxToolCalls, 30);
      assert.match(config.terminalSynthesis?.prompt ?? '', /reserved terminal synthesis turn/);
      const message = assistantMessage(JSON.stringify({
        verdict: 'ready',
        codeReviewFindings: [],
      }));
      emitCommonEvents(config, message);
      return {
        messages: [message],
        stopReason: 'stop',
        turnsCompleted: 1,
        toolCallsExecuted: 0,
        totalInputTokens: 10,
        totalOutputTokens: 10,
        totalCostUsd: 0,
        wallClockMs: 5,
      };
    });

    try {
      const result = await runNativeReview(makeReviewContext(), repoDir, {});
      assert.equal(result.verdict, 'ready');
      assert.deepEqual(result.codeReviewFindings, []);
      assert.deepEqual(result.metadata?.deniedTools, []);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('pins the substantive-analysis identity when the requested model matches what ran (HOK-2969)', async () => {
    const repoDir = makeTempRepo();
    setProviderSelection({ requestedModel: 'gpt-4o' });

    nativeReviewTestUtils.setRunWavemillLoop(async (config) => {
      const message = assistantMessage(JSON.stringify({ verdict: 'ready', codeReviewFindings: [] }));
      emitCommonEvents(config, message);
      return {
        messages: [message],
        stopReason: 'stop',
        turnsCompleted: 1,
        toolCallsExecuted: 0,
        totalInputTokens: 10,
        totalOutputTokens: 10,
        totalCostUsd: 0,
        wallClockMs: 5,
      };
    });

    try {
      const result = await runNativeReview(makeReviewContext(), repoDir, { model: 'gpt-4o' });
      assert.equal(result.substantiveAnalysisIdentity?.role, 'substantive_analysis');
      assert.equal(result.substantiveAnalysisIdentity?.requestedModel, 'gpt-4o');
      assert.equal(result.substantiveAnalysisIdentity?.resolvedModel, 'gpt-4o');
      assert.equal(result.substantiveAnalysisIdentity?.agent, 'native-openai');
      assert.equal(result.substantiveAnalysisIdentity?.pinned, true);
      assert.equal(result.substantiveAnalysisIdentity?.fallbackReason, undefined);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('records an unpinned fallback identity when the requested model has no ready provider (HOK-2969)', async () => {
    const repoDir = makeTempRepo();
    setProviderSelection({
      requestedModel: 'glm-5.3',
      fallbackReason: 'requested_model_unavailable',
    });

    nativeReviewTestUtils.setRunWavemillLoop(async (config) => {
      const message = assistantMessage(JSON.stringify({ verdict: 'ready', codeReviewFindings: [] }));
      emitCommonEvents(config, message);
      return {
        messages: [message],
        stopReason: 'stop',
        turnsCompleted: 1,
        toolCallsExecuted: 0,
        totalInputTokens: 10,
        totalOutputTokens: 10,
        totalCostUsd: 0,
        wallClockMs: 5,
      };
    });

    try {
      const result = await runNativeReview(makeReviewContext(), repoDir, { model: 'glm-5.3' });
      // The fallback entry (from setProviderSelection) still resolves gpt-4o —
      // a challenge cannot be proven when the wrong model actually ran.
      assert.equal(result.substantiveAnalysisIdentity?.requestedModel, 'glm-5.3');
      assert.equal(result.substantiveAnalysisIdentity?.resolvedModel, 'gpt-4o');
      assert.equal(result.substantiveAnalysisIdentity?.pinned, false);
      assert.equal(result.substantiveAnalysisIdentity?.fallbackReason, 'requested_model_unavailable');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('carries the substantive-analysis identity onto a malformed-response failure too (HOK-2969)', async () => {
    const repoDir = makeTempRepo();
    setProviderSelection({ requestedModel: 'gpt-4o' });

    nativeReviewTestUtils.setRunWavemillLoop(async (config) => {
      const message = assistantMessage('not json');
      emitCommonEvents(config, message);
      return {
        messages: [message],
        stopReason: 'stop',
        turnsCompleted: 1,
        toolCallsExecuted: 0,
        totalInputTokens: 10,
        totalOutputTokens: 10,
        totalCostUsd: 0,
        wallClockMs: 5,
      };
    });

    try {
      const result = await runNativeReview(makeReviewContext(), repoDir, { model: 'gpt-4o' });
      assert.equal(result.verdict, 'not_ready');
      assert.equal(result.codeReviewFindings[0].category, 'native-review-malformed-response');
      assert.equal(result.substantiveAnalysisIdentity?.pinned, true);
      assert.equal(result.substantiveAnalysisIdentity?.resolvedModel, 'gpt-4o');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('records an unrequested review as derived and unpinned', async () => {
    const repoDir = makeTempRepo();
    setReadyProvider();

    nativeReviewTestUtils.setRunWavemillLoop(async (config) => {
      const message = assistantMessage(JSON.stringify({ verdict: 'ready', codeReviewFindings: [] }));
      emitCommonEvents(config, message);
      return {
        messages: [message],
        stopReason: 'stop',
        turnsCompleted: 1,
        toolCallsExecuted: 0,
        totalInputTokens: 10,
        totalOutputTokens: 10,
        totalCostUsd: 0,
        wallClockMs: 5,
      };
    });

    try {
      const result = await runNativeReview(makeReviewContext(), repoDir, {});
      assert.equal(result.substantiveAnalysisIdentity?.requestedModel, 'gpt-4o');
      assert.equal(result.substantiveAnalysisIdentity?.resolvedModel, 'gpt-4o');
      assert.equal(result.substantiveAnalysisIdentity?.pinned, false);
      assert.equal(result.substantiveAnalysisIdentity?.source, 'derived');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('records denied tools from transcript events', async () => {
    const repoDir = makeTempRepo();
    setReadyProvider();

    nativeReviewTestUtils.setRunWavemillLoop(async (config) => {
      config.onEvent?.({ type: 'agent_start' });
      config.onEvent?.({ type: 'turn_start' });
      config.onEvent?.({
        type: 'tool_execution_end',
        toolCallId: 'tool-1',
        toolName: 'apply_patch',
        isError: true,
        result: {
          content: [{ type: 'text', text: 'phase_denied: tool "apply_patch" is not allowed in review' }],
        },
      });
      const message = assistantMessage(JSON.stringify({
        verdict: 'not_ready',
        codeReviewFindings: [{
          severity: 'warning',
          location: 'file.ts:1',
          category: 'style',
          description: 'Example finding',
        }],
      }));
      config.onEvent?.({ type: 'message_end', message });
      config.onEvent?.({ type: 'turn_end', message, toolResults: [] });
      config.onEvent?.({ type: 'agent_end', messages: [message] });

      return {
        messages: [message],
        stopReason: 'stop',
        turnsCompleted: 1,
        toolCallsExecuted: 0,
        totalInputTokens: 10,
        totalOutputTokens: 10,
        totalCostUsd: 0,
        wallClockMs: 5,
      };
    });

    try {
      const result = await runNativeReview(makeReviewContext(), repoDir, {});
      assert.equal(result.metadata?.deniedTools?.length, 1);
      assert.deepEqual(result.metadata?.deniedTools?.[0], {
        tool: 'apply_patch',
        reason: 'phase_denied',
        message: 'phase_denied: tool "apply_patch" is not allowed in review',
      });

      const transcript = loadTranscript(repoDir);
      const toolResult = transcript.find((event) => event.type === 'tool_result');
      assert.equal(toolResult?.type, 'tool_result');
      if (toolResult?.type === 'tool_result') {
        assert.equal(toolResult.isError, true);
        assert.match(toolResult.content, /phase_denied/);
      }
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('maps malformed native output to a blocker finding', async () => {
    const repoDir = makeTempRepo();
    setReadyProvider();

    nativeReviewTestUtils.setRunWavemillLoop(async (config) => {
      const message = assistantMessage('this is not json');
      emitCommonEvents(config, message);
      return {
        messages: [message],
        stopReason: 'stop',
        turnsCompleted: 1,
        toolCallsExecuted: 0,
        totalInputTokens: 10,
        totalOutputTokens: 10,
        totalCostUsd: 0,
        wallClockMs: 5,
      };
    });

    try {
      const result = await runNativeReview(makeReviewContext(), repoDir, {});
      assert.equal(result.verdict, 'not_ready');
      assert.equal(result.codeReviewFindings[0].category, 'native-review-malformed-response');
      assert.deepEqual(result.metadata?.deniedTools, []);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('maps turn-limit exits to the no-evidence timeout category', async () => {
    const repoDir = makeTempRepo();
    setReadyProvider();

    nativeReviewTestUtils.setRunWavemillLoop(async (config) => {
      config.onEvent?.({ type: 'agent_start' });
      config.onEvent?.({ type: 'agent_end', messages: [] });
      return {
        messages: [],
        stopReason: 'turn_limit',
        turnsCompleted: 2,
        toolCallsExecuted: 1,
        totalInputTokens: 10,
        totalOutputTokens: 10,
        totalCostUsd: 0,
        wallClockMs: 5,
      };
    });

    try {
      const result = await runNativeReview(makeReviewContext(), repoDir, {});
      assert.equal(result.verdict, 'error');
      assert.equal(result.failureCategory, 'native-review-timeout');
      assert.equal(result.codeReviewFindings.length, 0);
      assert.match(result.reviewToolError ?? '', /iteration limit/i);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('maps wall-clock exits to native-review-timeout without a synthetic not_ready finding', async () => {
    const repoDir = makeTempRepo({
      review: {
        nativeTimeoutMs: 1234,
        nativeTimeoutMaxMs: 5000,
        nativeTimeoutMultiplier: 2,
      },
    });
    setReadyProvider();

    nativeReviewTestUtils.setRunWavemillLoop(async (config) => {
      assert.equal(config.budget?.maxWallClockMs, 1234);
      return {
        messages: [],
        stopReason: 'wall_clock_limit',
        turnsCompleted: 2,
        toolCallsExecuted: 1,
        totalInputTokens: 10,
        totalOutputTokens: 10,
        totalCostUsd: 0,
        wallClockMs: 1234,
      };
    });

    try {
      const result = await runNativeReview(makeReviewContext(), repoDir, {});
      assert.equal(result.verdict, 'error');
      assert.equal(result.failureCategory, 'native-review-timeout');
      assert.equal(result.codeReviewFindings.length, 0);
      assert.match(result.reviewToolError ?? '', /wall-clock budget/i);
      assert.equal(result.metadata?.effectiveNativeTimeoutMs, 1234);
      assert.equal(result.metadata?.nativeTimeoutMaxMs, 5000);
      assert.equal(result.metadata?.reviewInputFileCount, 1);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('maps a typed provider credit failure to provider-credit-exhausted (HOK-2964 REQ-F5)', async () => {
    const repoDir = makeTempRepo();
    setReadyProvider();

    const errorMessage = { role: 'assistant' as const, errorMessage: 'HTTP 402: insufficient credits', timestamp: Date.now() };
    nativeReviewTestUtils.setRunWavemillLoop(async (config) => {
      config.onEvent?.({ type: 'agent_start' });
      config.onEvent?.({ type: 'agent_end', messages: [errorMessage] });
      return {
        messages: [errorMessage],
        stopReason: 'error',
        turnsCompleted: 1,
        toolCallsExecuted: 0,
        totalInputTokens: 10,
        totalOutputTokens: 10,
        totalCostUsd: 0,
        wallClockMs: 5,
        providerError: {
          kind: 'provider-credit-exhausted',
          retryable: false,
          attempts: 0,
          errorMessage: 'HTTP 402: insufficient credits',
          turnsAtFailure: 1,
        },
      };
    });

    try {
      const result = await runNativeReview(makeReviewContext(), repoDir, {});
      assert.equal(result.verdict, 'not_ready');
      assert.equal(result.failureCategory, 'provider-credit-exhausted');
      assert.equal(result.codeReviewFindings[0].category, 'provider-credit-exhausted');
      assert.match(result.codeReviewFindings[0].description, /provider-credit-exhausted/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('maps a provider-reported context overflow to native-context-window-exceeded (HOK-2964)', async () => {
    const repoDir = makeTempRepo();
    setReadyProvider();

    const errorMessage = { role: 'assistant' as const, errorMessage: 'maximum context length is 128000 tokens', timestamp: Date.now() };
    nativeReviewTestUtils.setRunWavemillLoop(async (config) => {
      config.onEvent?.({ type: 'agent_start' });
      config.onEvent?.({ type: 'agent_end', messages: [errorMessage] });
      return {
        messages: [errorMessage],
        stopReason: 'error',
        turnsCompleted: 1,
        toolCallsExecuted: 0,
        totalInputTokens: 10,
        totalOutputTokens: 10,
        totalCostUsd: 0,
        wallClockMs: 5,
        providerError: {
          kind: 'context-window-exceeded',
          retryable: false,
          attempts: 0,
          errorMessage: 'maximum context length is 128000 tokens',
          turnsAtFailure: 1,
        },
      };
    });

    try {
      const result = await runNativeReview(makeReviewContext(), repoDir, {});
      assert.equal(result.verdict, 'not_ready');
      assert.equal(result.failureCategory, 'native-context-window-exceeded');
      assert.equal(result.codeReviewFindings[0].category, 'native-context-window-exceeded');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('records cleanup transcript and stage-result details on timeout', async () => {
    const repoDir = makeTempRepo();
    const featureDir = mkdtempSync(join(tmpdir(), 'native-review-feature-'));
    setReadyProvider();

    nativeReviewTestUtils.setRunWavemillLoop(async (config) => {
      config.onEvent?.({ type: 'agent_start' });
      config.onEvent?.({ type: 'agent_end', messages: [] });
      return {
        messages: [],
        stopReason: 'wall_clock_limit',
        turnsCompleted: 1,
        toolCallsExecuted: 0,
        totalInputTokens: 10,
        totalOutputTokens: 10,
        totalCostUsd: 0,
        wallClockMs: 300_000,
      };
    });

    try {
      const result = await runNativeReview(makeReviewContext(), repoDir, { featureDir });
      assert.equal(result.verdict, 'error');
      assert.equal(result.failureCategory, 'native-review-timeout');
      assert.equal(result.codeReviewFindings.length, 0);

      const transcript = loadTranscript(repoDir);
      const cleanup = transcript.find((event) => event.type === 'cleanup_report');
      assert.equal(cleanup?.type, 'cleanup_report');
      if (cleanup?.type === 'cleanup_report') {
        assert.equal(cleanup.reason, 'timeout');
        assert.equal(cleanup.finalTreeState, 'clean');
        assert.equal(cleanup.cleanupDecision, 'no-action-needed');
      }

      const stageResult = JSON.parse(
        readFileSync(join(featureDir, '.review-result.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(stageResult.status, 'failed');
      assert.equal((stageResult.artifacts as Record<string, unknown>).failureCategory, 'native-review-timeout');
      assert.equal((stageResult.artifacts as Record<string, unknown>).missingReviewEvidence, true);
      assert.equal((stageResult.artifacts as Record<string, unknown>).effectiveNativeTimeoutMs, 300_000);
      assert.equal(stageResult.finalTreeState, 'clean');
      assert.equal(stageResult.cleanupDecision, 'no-action-needed');
      assert.equal((stageResult.cleanupReport as Record<string, unknown>).reason, 'timeout');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(featureDir, { recursive: true, force: true });
    }
  });

  it('records a typed stage-timeout envelope for the HOK-3052 Kimi wall-clock incident', async () => {
    const repoDir = makeTempRepo();
    const featureDir = mkdtempSync(join(tmpdir(), 'native-review-feature-'));
    setOpenRouterKimiProvider({ requestedModel: 'openrouter/kimi-k2' });

    nativeReviewTestUtils.setRunWavemillLoop(async (config) => {
      config.onEvent?.({ type: 'agent_start' });
      config.onEvent?.({ type: 'agent_end', messages: [] });
      return {
        messages: [],
        stopReason: 'wall_clock_limit',
        turnsCompleted: 1,
        toolCallsExecuted: 0,
        totalInputTokens: 10,
        totalOutputTokens: 10,
        totalCostUsd: 0,
        wallClockMs: 300_000,
      };
    });

    try {
      const result = await runNativeReview(makeReviewContext(), repoDir, { featureDir });
      assert.equal(result.failureCategory, 'native-review-timeout');

      const envelope = await readEnvelope(featureDir);
      assert.equal(envelope.cause, 'stage-timeout');
      assert.equal(envelope.stage, 'review');
      assert.equal(envelope.stopReason, 'wall_clock_limit');
      // Canonical identity: one OpenRouter execution keys under openrouter, not
      // a split native/native-openrouter row.
      assert.equal(envelope.provider, 'openrouter');
      assert.equal(envelope.model, 'kimi-k2');
      assert.equal(envelope.agent, 'native-openrouter');
      assert.equal(envelope.requestedModel, 'openrouter/kimi-k2');
      // Configured budget is preserved and matches the effective review budget.
      assert.equal(envelope.configuredTimeoutMs, result.metadata?.effectiveNativeTimeoutMs);
      assert.equal(typeof envelope.retryAttempt, 'number');
      assert.equal(envelope.evidence.source, 'native-runtime');
      // Write-before-cleanup: the envelope survives even though the timeout
      // cleanup + stage-result write both ran (the stage result is written
      // after cleanup, so both files being present proves ordering held).
      const stageResult = JSON.parse(
        readFileSync(join(featureDir, '.review-result.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(stageResult.status, 'failed');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(featureDir, { recursive: true, force: true });
    }
  });

  it('maps classified provider-error stops to their typed envelope causes', async () => {
    for (const [providerErrorKind, cause] of [
      ['provider-credit-exhausted', 'provider-credit-exhausted'],
      ['provider-transient-error', 'provider-outage'],
      ['provider-config-error', 'provider-config-error'],
    ] as const) {
      const repoDir = makeTempRepo();
      const featureDir = mkdtempSync(join(tmpdir(), 'native-review-feature-'));
      setReadyProvider();

      nativeReviewTestUtils.setRunWavemillLoop(async (config) => {
        config.onEvent?.({ type: 'agent_start' });
        config.onEvent?.({ type: 'agent_end', messages: [] });
        return {
          messages: [],
          stopReason: 'error',
          providerError: { kind: providerErrorKind, errorMessage: `${providerErrorKind} occurred`, turnsCompleted: 1, toolCallsExecuted: 0, attempts: 1 },
          turnsCompleted: 1,
          toolCallsExecuted: 0,
          totalInputTokens: 10,
          totalOutputTokens: 10,
          totalCostUsd: 0,
          wallClockMs: 5,
        };
      });

      try {
        await runNativeReview(makeReviewContext(), repoDir, { featureDir });
        const envelope = await readEnvelope(featureDir);
        assert.equal(envelope.cause, cause, `providerErrorKind ${providerErrorKind}`);
        assert.equal(envelope.providerErrorKind, providerErrorKind);
        assert.equal(envelope.stopReason, 'error');
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
        rmSync(featureDir, { recursive: true, force: true });
      }
    }
  });

  it('records a context-exhausted envelope for a thrown context error', async () => {
    const repoDir = makeTempRepo();
    const featureDir = mkdtempSync(join(tmpdir(), 'native-review-feature-'));
    setReadyProvider();

    nativeReviewTestUtils.setRunWavemillLoop(async () => {
      throw new ContextExhaustedError('context-exhausted: compacted native review context to the floor', {
        phase: 'review',
        model: 'gpt-4o',
        provider: 'openai',
        limit: 100_000,
        limitSource: 'registry',
        reservedOutputTokens: 1_024,
        safetyMargin: 0.05,
        estimate: { systemPromptTokens: 1_000, messageTokens: 120_000, toolTokens: 0, inputTokens: 121_000 },
        projectedInputTokens: 127_050,
        projectedTotalTokens: 128_074,
        headroomTokens: -28_074,
      });
    });

    try {
      await runNativeReview(makeReviewContext(), repoDir, { featureDir });
      const envelope = await readEnvelope(featureDir);
      assert.equal(envelope.cause, 'context-exhausted');
      assert.match(envelope.evidence.detail, /context-exhausted/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(featureDir, { recursive: true, force: true });
    }
  });

  it('records a model-protocol envelope for an empty final response', async () => {
    const repoDir = makeTempRepo();
    const featureDir = mkdtempSync(join(tmpdir(), 'native-review-feature-'));
    setReadyProvider();

    nativeReviewTestUtils.setRunWavemillLoop(async (config) => {
      const message = assistantMessage('   ');
      emitCommonEvents(config, message);
      return {
        messages: [message],
        stopReason: 'stop',
        turnsCompleted: 1,
        toolCallsExecuted: 0,
        totalInputTokens: 10,
        totalOutputTokens: 10,
        totalCostUsd: 0,
        wallClockMs: 5,
      };
    });

    try {
      const result = await runNativeReview(makeReviewContext(), repoDir, { featureDir });
      assert.equal(result.failureCategory, 'native-review-malformed-response');
      const envelope = await readEnvelope(featureDir);
      assert.equal(envelope.cause, 'model-protocol');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(featureDir, { recursive: true, force: true });
    }
  });

  it('deletes a stale envelope when the review later succeeds', async () => {
    const repoDir = makeTempRepo();
    const featureDir = mkdtempSync(join(tmpdir(), 'native-review-feature-'));
    setReadyProvider();

    nativeReviewTestUtils.setRunWavemillLoop(async (config) => {
      const message = assistantMessage(JSON.stringify({ verdict: 'ready', codeReviewFindings: [] }));
      emitCommonEvents(config, message);
      return {
        messages: [message],
        stopReason: 'stop',
        turnsCompleted: 1,
        toolCallsExecuted: 0,
        totalInputTokens: 10,
        totalOutputTokens: 10,
        totalCostUsd: 0,
        wallClockMs: 5,
      };
    });

    try {
      // Pre-seed a stale envelope from a hypothetical earlier terminal attempt.
      writeFileSync(
        getStageFailureEnvelopePath(featureDir, 'review'),
        JSON.stringify({ schemaVersion: '1.0', stage: 'review', cause: 'stage-timeout', provider: 'openrouter', model: 'kimi-k2', agent: 'native-openrouter', evidence: { source: 'native-runtime', detail: 'stale' }, createdAt: new Date().toISOString() }),
        'utf-8',
      );
      const result = await runNativeReview(makeReviewContext(), repoDir, { featureDir });
      assert.equal(result.verdict, 'ready');
      await assert.rejects(readEnvelope(featureDir), /ENOENT/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(featureDir, { recursive: true, force: true });
    }
  });

  it('writes no envelope when no featureDir is provided', async () => {
    const repoDir = makeTempRepo();
    const featureDir = mkdtempSync(join(tmpdir(), 'native-review-feature-'));
    setReadyProvider();

    nativeReviewTestUtils.setRunWavemillLoop(async (config) => {
      config.onEvent?.({ type: 'agent_start' });
      config.onEvent?.({ type: 'agent_end', messages: [] });
      return {
        messages: [],
        stopReason: 'wall_clock_limit',
        turnsCompleted: 1,
        toolCallsExecuted: 0,
        totalInputTokens: 10,
        totalOutputTokens: 10,
        totalCostUsd: 0,
        wallClockMs: 300_000,
      };
    });

    try {
      // featureDir intentionally omitted from options — the gate must hold.
      await runNativeReview(makeReviewContext(), repoDir, {});
      assert.equal(readdirSync(featureDir).length, 0);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(featureDir, { recursive: true, force: true });
    }
  });

  it('maps context-window pre-flight failures to a review blocker', async () => {
    const repoDir = makeTempRepo();
    setReadyProvider();

    nativeReviewTestUtils.setRunWavemillLoop(async () => {
      throw new ContextWindowExceededError(
        'Native review pre-flight rejected the launch: estimated prompt is ~120000 input tokens plus 8192 reserved output tokens = 128192, which exceeds the 100000-token context window of gpt-4o (openai, limit from registry). The provider would reject this request (context_length_exceeded).',
        {
          phase: 'review',
          model: 'gpt-4o',
          provider: 'openai',
          limit: 100_000,
          limitSource: 'registry',
          reservedOutputTokens: 8_192,
          safetyMargin: 0.10,
          estimate: {
            systemPromptTokens: 1_000,
            messageTokens: 119_000,
            toolTokens: 0,
            inputTokens: 120_000,
          },
          projectedInputTokens: 120_000,
          projectedTotalTokens: 128_192,
          headroomTokens: -28_192,
        },
      );
    });

    try {
      const result = await runNativeReview(makeReviewContext(), repoDir, {});
      assert.equal(result.verdict, 'not_ready');
      assert.equal(result.codeReviewFindings.length, 1);
      assert.equal(result.codeReviewFindings[0].category, 'native-context-window-exceeded');
      assert.match(result.codeReviewFindings[0].description, /gpt-4o/);
      assert.match(result.codeReviewFindings[0].description, /100000-token context window/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('maps in-session context exhaustion to a distinct review blocker', async () => {
    const repoDir = makeTempRepo();
    setReadyProvider();

    nativeReviewTestUtils.setRunWavemillLoop(async () => {
      throw new ContextExhaustedError(
        'context-exhausted: compacted native review context to the floor and still exceeded the model context window',
        {
          phase: 'review',
          model: 'gpt-4o',
          provider: 'openai',
          limit: 100_000,
          limitSource: 'registry',
          reservedOutputTokens: 1_024,
          safetyMargin: 0.05,
          estimate: {
            systemPromptTokens: 1_000,
            messageTokens: 120_000,
            toolTokens: 0,
            inputTokens: 121_000,
          },
          projectedInputTokens: 127_050,
          projectedTotalTokens: 128_074,
          headroomTokens: -28_074,
          droppedCount: 10,
          droppedTokensEstimate: 50_000,
          handoff: { transcriptPath: '/tmp/native.jsonl', lastCompactionStrategy: 'drop-oldest-tool-results' },
        },
      );
    });

    try {
      const result = await runNativeReview(makeReviewContext(), repoDir, {});
      assert.equal(result.verdict, 'not_ready');
      assert.equal(result.codeReviewFindings[0].category, 'native-context-exhausted');
      assert.match(result.codeReviewFindings[0].description, /context-exhausted/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('surfaces actionable provider-resolution failures before launching the loop', async () => {
    const repoDir = makeTempRepo({
      nativeAgent: {
        enabled: true,
        allowedPhases: ['review'],
        // Model membership is owned by the global effective-model projection,
        // so a bare provider entry resolves to no certified models here.
        providers: {
          openai: {},
        },
      },
    });
    process.env.OPENAI_API_KEY = 'sk-review-test';

    try {
      const result = await runNativeReview(makeReviewContext(), repoDir, {});
      assert.equal(result.verdict, 'not_ready');
      assert.equal(result.failureCategory, 'native-runtime-unavailable');
      assert.equal(result.codeReviewFindings[0].category, 'native-runtime-unavailable');
      assert.match(result.codeReviewFindings[0].description, /no native providers are configured/);
      assert.match(result.codeReviewFindings[0].description, /wavemill native-agent models report --json/);
      assert.match(result.codeReviewFindings[0].description, /Configure nativeAgent\.providers/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

function makeTempRepo(config: Record<string, unknown> = {}): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'native-review-test-'));
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config), 'utf-8');
  return repoDir;
}

function makeReviewContext(): ReviewContext {
  return {
    diff: 'diff --git a/file.ts b/file.ts',
    plan: 'Plan',
    taskPacket: 'Task packet',
    designContext: null,
    metadata: {
      branch: 'feature/native-review',
      files: ['file.ts'],
      hasUiChanges: false,
    },
  };
}

function assistantMessage(text: string) {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    api: 'openai-responses',
    provider: 'openai',
    model: 'gpt-4o',
    usage: {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop' as const,
    timestamp: Date.now(),
  };
}

function setReadyProvider() {
  const provider: ReadyNativeProviderEntry = {
    providerName: 'openai',
    modelId: 'gpt-4o',
    status: 'ready',
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    headers: {},
    model: {
      id: 'openai:gpt-4o',
      name: 'gpt-4o',
      api: 'openai-responses',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      headers: {},
    } as ReadyNativeProviderEntry['model'],
  };

  nativeReviewTestUtils.setSelectReviewProvider(() => ({ ok: true, entry: provider }));
  nativeReviewTestUtils.setGetNativeProviderApiKey(() => 'test-key');
}

/** An OpenRouter-hosted Kimi reviewer, matching the HOK-3052 incident identity. */
function setOpenRouterKimiProvider(input: { requestedModel?: string } = {}) {
  const provider: ReadyNativeProviderEntry = {
    providerName: 'openrouter',
    modelId: 'kimi-k2',
    status: 'ready',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    headers: {},
    model: {
      id: 'openrouter:kimi-k2',
      name: 'kimi-k2',
      api: 'openai-completions',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      headers: {},
    } as ReadyNativeProviderEntry['model'],
  };

  nativeReviewTestUtils.setSelectReviewProvider(() => ({
    ok: true,
    entry: provider,
    ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
  }));
  nativeReviewTestUtils.setGetNativeProviderApiKey(() => 'test-key');
}

async function readEnvelope(featureDir: string): Promise<StageFailureEnvelope> {
  const result = await readStageFailureEnvelope(getStageFailureEnvelopePath(featureDir, 'review'));
  assert.ok(result.ok, `expected a valid review failure envelope: ${result.ok ? '' : result.message}`);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.value;
}

/** Like setReadyProvider, but lets a test control the requested/fallback fields (HOK-2969). */
function setProviderSelection(input: { requestedModel?: string; fallbackReason?: string }) {
  const provider: ReadyNativeProviderEntry = {
    providerName: 'openai',
    modelId: 'gpt-4o',
    status: 'ready',
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    headers: {},
    model: {
      id: 'openai:gpt-4o',
      name: 'gpt-4o',
      api: 'openai-responses',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      headers: {},
    } as ReadyNativeProviderEntry['model'],
  };

  nativeReviewTestUtils.setSelectReviewProvider(() => ({
    ok: true,
    entry: provider,
    ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
    ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {}),
  }));
  nativeReviewTestUtils.setGetNativeProviderApiKey(() => 'test-key');
}

function emitCommonEvents(config: { onEvent?: (event: any) => void }, message: ReturnType<typeof assistantMessage>) {
  config.onEvent?.({ type: 'agent_start' });
  config.onEvent?.({ type: 'turn_start' });
  config.onEvent?.({ type: 'message_end', message });
  config.onEvent?.({ type: 'turn_end', message, toolResults: [] });
  config.onEvent?.({ type: 'agent_end', messages: [message] });
}

function loadTranscript(repoDir: string) {
  const runsDir = join(repoDir, '.wavemill', 'runs');
  const runId = readdirSync(runsDir)[0];
  const nativeSessionsDir = join(runsDir, runId, 'native-sessions');
  const transcriptFile = readdirSync(nativeSessionsDir).find((file) => file.endsWith('.jsonl'));
  assert.ok(transcriptFile, 'expected a native transcript file');
  const transcriptPath = join(nativeSessionsDir, transcriptFile);
  return parseTranscriptJsonl(readFileSync(transcriptPath, 'utf-8'));
}
