/** Production tools and verifier, scripted model only: never evidence for live eligibility. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getEffectiveRegistry } from '../../../shared/lib/model-registry.ts';
import { resolveCertificationSubject } from '../../../shared/lib/native-agent/certification/identity.ts';
import { runLiveCodingCanary } from '../../../shared/lib/native-agent/certification/live-coding-canary.ts';
import { CANARY_COMPLETION_PATH, CANARY_SENTINEL_PATH, CANARY_TEST_COMMAND } from '../../../shared/lib/native-agent/certification/qualification-contract.ts';
import type { WavemillLoopConfig } from '../../../shared/lib/native-agent/loop.ts';
export async function replayFunctionalQualification(root: string, mode = 'formatting', legacy = false) {
  const registry = getEffectiveRegistry();
  const endpoint = { tag: 'replay', providerName: 'Replay Host', quantization: null, deploymentRevision: null };
  const resolved = resolveCertificationSubject({ provider: 'openrouter', model: 'kimi-k2.7-code', registry, endpoint });
  const subject = { ...resolved.subject };
  if (legacy) delete subject.qualificationContract;
  // Captured arguments, no model reasoning or private transcript.
  const captured = JSON.parse(readFileSync(new URL('../../../docs/experiments/provider-candidates-2026-11-17/streamlake-mutation.json', import.meta.url), 'utf8'));
  const runLoopFn = async (config: WavemillLoopConfig) => {
    const repo = config.toolPolicy!.worktreePath;
    const call = async (name: string, args: unknown) => {
      const tool = config.context.tools.find(tool => tool.name === name)!;
      const result = await tool.execute(`replay-${name}`, args as never, undefined as never, undefined as never);
      config.onEvent!({ type: 'tool_execution_end', toolCallId: `replay-${name}`, toolName: name, result, isError: result.isError ?? false } as never);
      return result;
    };
    config.onEvent!({ type: 'agent_start' } as never);
    config.onEvent!({ type: 'message_end', message: { role: 'assistant', model: 'kimi-k2.7-code', api: 'openai-completions', provider: 'openrouter', responseModel: subject.providerNativeId,
      responseId: 'replay-generation', content: [], timestamp: 0, stopReason: 'stop', usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } } as never);
    if (mode === 'malformed') await call('apply_patch', { patch: { ...captured.calls[0].arguments.patch, operations: 'not-an-array' } });
    else await call('apply_patch', captured.calls[0].arguments);
    await call('run_tests', { command: CANARY_TEST_COMMAND });
    if (mode === 'wrong-value' || mode === 'after-test') writeFileSync(join(repo, CANARY_SENTINEL_PATH), 'export const CANARY_STATE = "wrong";\n');
    if (mode === 'wrong-escaping') writeFileSync(join(repo, 'src/payload.ts'), 'export const payload = "quote ";\n');
    if (mode === 'tampered-oracle') writeFileSync(join(repo, 'tests/canary.test.ts'), 'process.exit(0);\n');
    if (mode === 'extra-file') writeFileSync(join(repo, 'unexpected.txt'), 'changed');
    mkdirSync(join(repo, 'features/live-canary'), { recursive: true });
    writeFileSync(join(repo, CANARY_COMPLETION_PATH), mode === 'invalid-marker' ? '{}' : '{"stage":"coding","confidence":"high"}');
    return { messages: [], stopReason: 'stop' as const, turnsCompleted: 3, toolCallsExecuted: 3, totalInputTokens: 100, totalOutputTokens: 10, totalCostUsd: .01, wallClockMs: 100 };
  };
  return runLiveCodingCanary({ provider: 'openrouter', registryModelId: 'kimi-k2.7-code', subject, suiteVersion: 'v3', registry, repoDir: root, tmpRootOverride: root,
    profile: 'cache-heavy', runLoopFn, modelOverride: { id: 'replay', name: 'replay', api: 'openai-completions', provider: 'openrouter' } as never,
    exactPricing: { enabled: true, fetchGenerationCost: async () => ({ totalCostUsd: .01, providerName: endpoint.providerName }) } });
}
export async function assertFunctionalQualificationJourney(root: string) {
  for (const mode of ['formatting', 'wrong-value', 'malformed']) {
    const result = await replayFunctionalQualification(root, mode);
    assert.equal(result.status, mode === 'formatting' ? 'pass' : 'fail', result.detail);
    assert.equal(result.isLive, false);
    assert.equal(result.attemptEvidence?.length, 1);
    assert.equal(result.attemptEvidence?.[0].contribution?.completion_result, mode === 'formatting' ? 'success' : 'failure');
    assert.equal(result.attemptEvidence?.[0].contribution?.actual_cost_usd, .01);
  }
}
