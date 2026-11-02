import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { computeIdentityFingerprint, type ModelRegistry } from '../../model-registry.ts';
import { clearConfigCache } from '../../config.ts';
import type { LoopResult, WavemillLoopConfig } from '../loop.ts';
import {
  CANARY_COMPLETION_PATH,
  CANARY_SENTINEL_EXPECTED,
  CANARY_SENTINEL_PATH,
  CANARY_TMP_PREFIX,
  runLiveCodingCanary,
  safeRemoveCanaryDir,
  type RunLiveCodingCanaryOptions,
} from './live-coding-canary.ts';
import type { CertificationSubject } from './schema.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUBJECT: CertificationSubject = {
  registryKey: 'gpt-4o',
  nativeProvider: 'openai',
  providerId: 'openai',
  providerModelId: 'gpt-4o',
  providerNativeId: 'gpt-4o',
  identityRevision: 1,
  identityFingerprint: computeIdentityFingerprint({
    alias: 'gpt-4o',
    providerNativeId: 'gpt-4o',
    provider: 'openai',
    revision: 1,
  }),
  catalogHash: 'registry',
};

const REGISTRY: ModelRegistry = {
  models: {
    'gpt-4o': {
      vendor: 'openai',
      class: 'strong_generalist',
      strengths: [],
      weaknesses: [],
      qualityScores: { routing: 70, planning: 75, coding: 80, review: 75, classify: 70 },
      contextWindowTokens: 128_000,
      toolSupport: 'full',
      multimodal: { text: true, image: false },
      latencyTier: 'standard',
      reasoningTier: 'standard',
      costPerMillionInputTokensUsd: 3,
      costPerMillionOutputTokensUsd: 15,
    },
  },
  ladders: {},
} as unknown as ModelRegistry;

const MODEL_OVERRIDE = {
  id: 'openai:gpt-4o',
  name: 'gpt-4o',
  api: 'openai-responses',
  provider: 'openai',
} as unknown as WavemillLoopConfig['model'];

const FIXED_NOW = new Date('2026-09-01T00:00:00.000Z');

const scratchDirs: string[] = [];

function makeScratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

function loopResult(overrides: Partial<LoopResult> = {}): LoopResult {
  return {
    messages: [],
    stopReason: 'stop',
    turnsCompleted: 2,
    toolCallsExecuted: 2,
    totalInputTokens: 1000,
    totalOutputTokens: 200,
    totalCostUsd: 0.01,
    wallClockMs: 1500,
    ...overrides,
  };
}

function emitToolEnd(config: WavemillLoopConfig, toolName: string, isError = false): void {
  config.onEvent?.({
    type: 'tool_execution_end',
    toolCallId: `call-${toolName}`,
    toolName,
    isError,
    result: {},
  } as never);
}

interface FakeLoopBehavior {
  mutateSentinel?: string;
  writeCompletion?: string;
  extraFile?: { path: string; content: string };
  emit?: string[];
  result?: Partial<LoopResult>;
  throwError?: string;
}

/**
 * Injected loop runner: simulates model behavior by editing the disposable
 * repo directly and emitting synthetic tool events. Injection forces the
 * runner to record isLive=false.
 */
function fakeLoop(behaviors: FakeLoopBehavior[]): {
  runLoopFn: (config: WavemillLoopConfig) => Promise<LoopResult>;
  calls: () => number;
} {
  let call = 0;
  return {
    calls: () => call,
    runLoopFn: async (config: WavemillLoopConfig) => {
      const behavior = behaviors[Math.min(call, behaviors.length - 1)]!;
      call += 1;
      if (behavior.throwError) {
        throw new Error(behavior.throwError);
      }
      const repoDir = config.toolPolicy!.worktreePath;
      if (behavior.mutateSentinel !== undefined) {
        writeFileSync(join(repoDir, CANARY_SENTINEL_PATH), behavior.mutateSentinel, 'utf-8');
      }
      if (behavior.writeCompletion !== undefined) {
        const completionPath = join(repoDir, CANARY_COMPLETION_PATH);
        mkdirSync(join(repoDir, 'features/live-canary'), { recursive: true });
        writeFileSync(completionPath, behavior.writeCompletion, 'utf-8');
      }
      if (behavior.extraFile) {
        writeFileSync(join(repoDir, behavior.extraFile.path), behavior.extraFile.content, 'utf-8');
      }
      for (const toolName of behavior.emit ?? []) {
        emitToolEnd(config, toolName);
      }
      return loopResult(behavior.result);
    },
  };
}

function baseOptions(
  runLoopFn: RunLiveCodingCanaryOptions['runLoopFn'],
  overrides: Partial<RunLiveCodingCanaryOptions> = {},
): RunLiveCodingCanaryOptions {
  return {
    provider: 'openai',
    registryModelId: 'gpt-4o',
    subject: SUBJECT,
    suiteVersion: 'v3',
    registry: REGISTRY,
    repoDir: makeScratchDir('canary-repo-'),
    now: () => FIXED_NOW,
    tmpRootOverride: makeScratchDir('canary-tmp-'),
    runLoopFn,
    modelOverride: MODEL_OVERRIDE,
    ...overrides,
  };
}

const GOOD_BEHAVIOR: FakeLoopBehavior = {
  mutateSentinel: CANARY_SENTINEL_EXPECTED,
  writeCompletion: '{"stage":"coding","confidence":"high"}\n',
  emit: ['apply_patch', 'create_marker'],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runLiveCodingCanary', () => {
  it('passes when the sentinel mutates exactly and the completion artifact is valid', async () => {
    const loop = fakeLoop([GOOD_BEHAVIOR]);
    const options = baseOptions(loop.runLoopFn);
    const result = await runLiveCodingCanary(options);

    assert.equal(result.status, 'pass');
    assert.equal(result.reason, undefined);
    assert.equal(result.phase, 'coding');
    assert.equal(result.scenarioId, 'live.coding.mutation-canary.v1');
    assert.equal(result.provider, 'openai');
    assert.equal(result.model, 'gpt-4o');
    assert.equal(result.suiteVersion, 'v3');
    assert.equal(result.ranAt, FIXED_NOW.toISOString());
    assert.equal(result.attempts, 1);
    assert.ok(result.evidence, 'evidence must be recorded');
    assert.equal(result.evidence!.structuredMutationToolCalls, 2);
    assert.deepEqual(result.evidence!.mutationToolNames, ['apply_patch', 'create_marker'].sort());
    assert.equal(result.evidence!.completionArtifactPresent, true);
    assert.equal(result.evidence!.actualSentinelHash, result.evidence!.expectedSentinelHash);
    assert.deepEqual(result.evidence!.changedPaths, [CANARY_COMPLETION_PATH, CANARY_SENTINEL_PATH].sort());
    assert.ok(result.usage, 'usage must be recorded');
  });

  it('marks injected loop runs as non-live regardless of outcome', async () => {
    const loop = fakeLoop([GOOD_BEHAVIOR]);
    const result = await runLiveCodingCanary(baseOptions(loop.runLoopFn));
    assert.equal(result.status, 'pass');
    assert.equal(result.isLive, false, 'injected harness results must never be live');
  });

  it('fails as protocol_failure when apply_patch appears only as assistant text', async () => {
    // The "model" writes nothing and calls no tools — its prose claimed
    // `[apply_patch ...]`, which produces no tool events.
    const loop = fakeLoop([{ emit: [] }]);
    const result = await runLiveCodingCanary(baseOptions(loop.runLoopFn));
    assert.equal(result.status, 'fail');
    assert.equal(result.reason, 'protocol_failure');
    assert.equal(result.evidence?.structuredMutationToolCalls, 0);
  });

  it('does not count errored tool events as structured mutation evidence', async () => {
    const loop = fakeLoop([{ emit: [] }]);
    const options = baseOptions(async (config) => {
      emitToolEnd(config, 'apply_patch', true);
      return loopResult();
    });
    void loop;
    const result = await runLiveCodingCanary(options);
    assert.equal(result.status, 'fail');
    assert.equal(result.reason, 'protocol_failure');
  });

  it('fails as wrong_mutation when the sentinel content is not the expected bytes', async () => {
    const loop = fakeLoop([{
      ...GOOD_BEHAVIOR,
      mutateSentinel: "export const CANARY_STATE = 'wrong';\n",
    }]);
    const result = await runLiveCodingCanary(baseOptions(loop.runLoopFn));
    assert.equal(result.status, 'fail');
    assert.equal(result.reason, 'wrong_mutation');
    assert.notEqual(result.evidence?.actualSentinelHash, result.evidence?.expectedSentinelHash);
  });

  it('fails as extra_repository_change when an out-of-scope file is created', async () => {
    const loop = fakeLoop([{
      ...GOOD_BEHAVIOR,
      extraFile: { path: 'rogue.txt', content: 'should not exist\n' },
    }]);
    const result = await runLiveCodingCanary(baseOptions(loop.runLoopFn));
    assert.equal(result.status, 'fail');
    assert.equal(result.reason, 'extra_repository_change');
    assert.ok(result.evidence?.changedPaths.includes('rogue.txt'));
  });

  it('fails as missing_completion_artifact when no artifact is written', async () => {
    const loop = fakeLoop([{
      mutateSentinel: CANARY_SENTINEL_EXPECTED,
      emit: ['apply_patch'],
    }]);
    const result = await runLiveCodingCanary(baseOptions(loop.runLoopFn));
    assert.equal(result.status, 'fail');
    assert.equal(result.reason, 'missing_completion_artifact');
    assert.equal(result.evidence?.completionArtifactPresent, false);
  });

  it('fails as missing_completion_artifact when the artifact is malformed', async () => {
    const loop = fakeLoop([{
      ...GOOD_BEHAVIOR,
      writeCompletion: 'not json at all {{{',
    }]);
    const result = await runLiveCodingCanary(baseOptions(loop.runLoopFn));
    assert.equal(result.status, 'fail');
    assert.equal(result.reason, 'missing_completion_artifact');
  });

  it('classifies thrown transient provider errors as inconclusive with bounded retries', async () => {
    const loop = fakeLoop([
      { throwError: '429 rate limit exceeded, please retry' },
      { throwError: '503 service unavailable' },
    ]);
    const result = await runLiveCodingCanary(baseOptions(loop.runLoopFn, { maxAttempts: 2 }));
    assert.equal(result.status, 'inconclusive');
    assert.equal(result.reason, 'provider_transient_error');
    assert.equal(result.attempts, 2, 'transient errors retry up to maxAttempts');
    assert.equal(loop.calls(), 2);
  });

  it('recovers when a transient first attempt is followed by a passing attempt', async () => {
    const loop = fakeLoop([
      { result: { stopReason: 'error', providerError: { kind: 'provider-transient-error', retryable: true, attempts: 3, errorMessage: '500 upstream error', turnsAtFailure: 1 } } },
      GOOD_BEHAVIOR,
    ]);
    const result = await runLiveCodingCanary(baseOptions(loop.runLoopFn, { maxAttempts: 2 }));
    assert.equal(result.status, 'pass');
    assert.equal(result.attempts, 2);
  });

  it('classifies provider config errors as inconclusive without retry', async () => {
    const loop = fakeLoop([{
      result: {
        stopReason: 'error',
        providerError: { kind: 'provider-config-error', retryable: false, attempts: 1, errorMessage: '401 invalid api key', turnsAtFailure: 0 },
      },
    }]);
    const result = await runLiveCodingCanary(baseOptions(loop.runLoopFn, { maxAttempts: 3 }));
    assert.equal(result.status, 'inconclusive');
    assert.equal(result.reason, 'provider_config_error');
    assert.equal(loop.calls(), 1, 'config errors are not retried');
  });

  it('treats wall-clock expiry as inconclusive and records the fired limit', async () => {
    const loop = fakeLoop([{ result: { stopReason: 'wall_clock_limit' } }]);
    const result = await runLiveCodingCanary(baseOptions(loop.runLoopFn));
    assert.equal(result.status, 'inconclusive');
    assert.equal(result.reason, 'budget_exceeded');
    assert.equal(result.limitExceeded, 'wall_clock');
  });

  // protects: the canary reading our own wall-clock abort ("Request was aborted") as a provider transient error (HOK-3362)
  it('classifies a wall-clock stop by its budget, not by the abort message it left', async () => {
    const loop = fakeLoop([{
      result: {
        stopReason: 'wall_clock_limit',
        messages: [{ role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request was aborted', timestamp: 0 } as never],
      },
    }]);
    const result = await runLiveCodingCanary(baseOptions(loop.runLoopFn));
    assert.equal(result.status, 'inconclusive');
    assert.equal(result.reason, 'budget_exceeded');
    assert.equal(result.limitExceeded, 'wall_clock');
  });

  it('treats token/tool-call/cost budget exhaustion as definitive failures naming the limit', async () => {
    for (const [stopReason, limit] of [
      ['token_limit', 'tokens'],
      ['tool_call_limit', 'tool_calls'],
      ['cost_limit', 'cost'],
      ['turn_limit', 'turns'],
    ] as const) {
      const loop = fakeLoop([{ result: { stopReason } }]);
      const result = await runLiveCodingCanary(baseOptions(loop.runLoopFn));
      assert.equal(result.status, 'fail', `${stopReason} must fail`);
      assert.equal(result.reason, 'budget_exceeded');
      assert.equal(result.limitExceeded, limit);
    }
  });

  it('applies configured limit overrides to the loop budget', async () => {
    let seenBudget: Record<string, unknown> | undefined;
    const result = await runLiveCodingCanary(baseOptions(async (config) => {
      seenBudget = config.budget as Record<string, unknown>;
      return loopResult({ stopReason: 'wall_clock_limit' });
    }, {
      limits: { maxWallClockMs: 5000, maxToolCalls: 3, maxTotalTokens: 999, maxCostUsd: 0.05 },
    }));
    assert.equal(result.status, 'inconclusive');
    assert.equal(seenBudget?.maxWallClockMs, 5000);
    assert.equal(seenBudget?.maxToolCalls, 3);
    assert.equal(seenBudget?.maxTotalTokens, 999);
    assert.equal(seenBudget?.maxCostUsd, 0.05);
    assert.deepEqual(result.limits, {
      maxWallClockMs: 5000,
      maxTurns: 6,
      maxToolCalls: 3,
      maxTotalTokens: 999,
      maxCostUsd: 0.05,
    });
  });

  it('removes the disposable repository on pass, failure, and provider error', async () => {
    for (const behavior of [
      GOOD_BEHAVIOR,
      { emit: [] },
      { throwError: '429 too many requests' },
    ] as FakeLoopBehavior[]) {
      const tmpRootOverride = makeScratchDir('canary-clean-');
      const loop = fakeLoop([behavior]);
      await runLiveCodingCanary(baseOptions(loop.runLoopFn, { tmpRootOverride, maxAttempts: 1 }));
      assert.deepEqual(readdirSync(tmpRootOverride), [], 'temp root must be empty after the run');
    }
  });

  it('returns skipped when the provider API key is not configured', async () => {
    const repoDir = makeScratchDir('canary-nokey-');
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
      nativeAgent: {
        providers: { openai: { apiKeyEnv: 'CANARY_TEST_DEFINITELY_UNSET_KEY' } },
      },
    }));
    clearConfigCache(repoDir);
    try {
      const loop = fakeLoop([GOOD_BEHAVIOR]);
      const result = await runLiveCodingCanary(baseOptions(loop.runLoopFn, {
        repoDir,
        modelOverride: undefined,
      }));
      assert.equal(result.status, 'skipped');
      assert.equal(result.reason, 'provider_config_error');
      assert.equal(loop.calls(), 0, 'the loop must never run without credentials');
    } finally {
      clearConfigCache(repoDir);
    }
  });

  it('redacts secret-shaped values and absolute paths from persisted detail', async () => {
    const loop = fakeLoop([{
      throwError: '429 rate limited; Authorization: Bearer sk-supersecret1234567890 at /Users/someone/repo',
    }]);
    const result = await runLiveCodingCanary(baseOptions(loop.runLoopFn, { maxAttempts: 1 }));
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('sk-supersecret1234567890'), 'API key must never appear in the result');
    assert.ok(!serialized.includes('/Users/someone'), 'local absolute paths must never appear in the result');
  });
});

describe('safeRemoveCanaryDir', () => {
  it('refuses to remove directories outside the canary prefix', () => {
    const base = makeScratchDir('canary-guard-');
    const victim = join(base, 'unrelated-dir');
    mkdirSync(victim);
    safeRemoveCanaryDir(victim, base);
    assert.ok(existsSync(victim), 'non-canary directories must never be removed');

    const nested = join(base, `${CANARY_TMP_PREFIX}abc`, 'inner');
    mkdirSync(nested, { recursive: true });
    safeRemoveCanaryDir(nested, base);
    assert.ok(existsSync(nested), 'nested paths under a canary dir are not removal roots');

    const canaryDir = join(base, `${CANARY_TMP_PREFIX}abc`);
    safeRemoveCanaryDir(canaryDir, base);
    assert.ok(!existsSync(canaryDir), 'exact canary directories are removed');
  });
});

describe('canary workspace baseline', () => {
  it('creates a git repo whose only baseline entry is the sentinel', async () => {
    let observedRepo: string | undefined;
    const loop = fakeLoop([GOOD_BEHAVIOR]);
    await runLiveCodingCanary(baseOptions(async (config) => {
      observedRepo = config.toolPolicy!.worktreePath;
      const status = execFileSync('git', ['status', '--porcelain', '-uall'], {
        cwd: observedRepo,
        encoding: 'utf-8',
      });
      assert.equal(status.trim(), '', 'baseline must be committed clean');
      return loop.runLoopFn(config);
    }));
    assert.ok(observedRepo, 'loop must receive the disposable repo path');
  });
});
