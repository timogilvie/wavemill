import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { reportableWorkflowCostUsd, type WorkflowCostResult } from '../workflow-cost.ts';
import { buildSdkTaskCostSummaries, collectSdkTaskCostSummaries } from './collect.ts';
import type { CollectSdkTaskCostSummariesInput } from './collect.ts';
import { loadSdkTaskCostFixture } from './fixtures.ts';
import { meterWorkflowCost } from './meter.ts';

const PRICING = { 'priced-native': { inputCostPerMTok: 2, outputCostPerMTok: 8 } };

function silentLogger(warnings: string[] = [], logs: string[] = []) {
  return {
    log: (message: unknown) => logs.push(String(message)),
    warn: (message: unknown) => warnings.push(String(message)),
  };
}

function fixtureSummaries(name = 'claude-success') {
  const fixture = loadSdkTaskCostFixture(name);
  return buildSdkTaskCostSummaries({
    scanResults: fixture.scanResults,
    taskId: fixture.taskId,
    pricingTable: fixture.pricingTable,
    now: () => new Date(fixture.now),
  })!;
}

function nativeAssistant(sessionId: string, usage: { responseId?: string; input: number; output: number }): string {
  return JSON.stringify({
    seq: 2,
    sessionId,
    timestamp: 2,
    type: 'assistant_message',
    model: 'priced-native',
    ...(usage.responseId ? { responseId: usage.responseId } : {}),
    stopReason: 'end_turn',
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: usage.input + usage.output,
    },
    rawContent: [],
    replayContent: [],
    redacted: false,
  });
}

describe('meterWorkflowCost', () => {
  let base: string;
  let worktreePath: string;

  beforeEach(() => {
    base = join(tmpdir(), `wavemill-meter-${randomUUID()}`);
    worktreePath = join(base, 'worktree');
    mkdirSync(worktreePath, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function writeNativeSession(lines: string[]): void {
    const dir = join(worktreePath, '.wavemill', 'runs', 'run-1', 'native-sessions');
    mkdirSync(dir, { recursive: true });
    const started = JSON.stringify({
      seq: 1, sessionId: 'session-1', timestamp: 1, type: 'session_started', model: 'priced-native', api: 'responses', provider: 'pi',
    });
    writeFileSync(join(dir, 'session-1.jsonl'), [started, ...lines].join('\n'));
  }

  function meterNative(exactPricing?: Parameters<typeof meterWorkflowCost>[0]['exactPricing'], logger = silentLogger()) {
    return meterWorkflowCost({
      worktreePath,
      branchName: 'task/native',
      agentType: 'native',
      pricingTable: PRICING,
      label: 'test',
      collect: collectSdkTaskCostSummaries,
      ...(exactPricing ? { exactPricing } : {}),
      logger,
    });
  }

  it('hands the collector the join inputs and pricing table, and projects its summary', async () => {
    const summaries = fixtureSummaries();
    let received: CollectSdkTaskCostSummariesInput | undefined;
    const logs: string[] = [];
    const metered = await meterWorkflowCost({
      worktreePath: '/w',
      branchName: 'task/x',
      repoDir: '/r',
      issueId: 'HOK-1',
      agentType: 'claude',
      pricingTable: PRICING,
      label: 'Eval',
      collect: (input) => {
        received = input;
        return summaries;
      },
      logger: silentLogger([], logs),
    });
    assert.deepEqual(received, {
      worktreePath: '/w', branchName: 'task/x', repoDir: '/r', issueId: 'HOK-1', pricingTable: PRICING,
    });
    assert.equal(metered.summaries, summaries);
    assert.equal(metered.reason, 'sdk_summary');
    assert.ok(Math.abs(reportableWorkflowCostUsd(metered.outcome)! - summaries[0].total_cost_usd!) < 1e-9);
    assert.ok(logs.some((line) => line.startsWith('Eval: SDK task cost — claude-code:')));
  });

  it('records a no_sessions failure (never a zero) when nothing was collected', async () => {
    const metered = await meterWorkflowCost({ worktreePath, branchName: 'task/x', label: 'test', collect: () => null, logger: silentLogger() });
    assert.equal(metered.outcome.status, 'no_sessions');
    assert.equal(metered.reason, 'no_sdk_summary');
    assert.equal(reportableWorkflowCostUsd(metered.outcome), undefined);
  });

  it('records an adapter_error and warns when the collector throws', async () => {
    const warnings: string[] = [];
    const metered = await meterWorkflowCost({
      worktreePath,
      branchName: 'task/x',
      label: 'Eval',
      collect: () => {
        throw new Error('sdk exploded');
      },
      logger: silentLogger(warnings),
    });
    assert.equal(metered.summaries, null);
    assert.equal(metered.outcome.status, 'adapter_error');
    assert.ok(warnings.some((warning) => warning.includes('SDK task cost collection failed — sdk exploded')));
  });

  describe('OpenRouter exact pricing', () => {
    it('emits each fetched generation charge as a provider-reported SDK cost', async () => {
      writeNativeSession([
        nativeAssistant('session-1', { responseId: 'gen-one', input: 1_000_000, output: 0 }),
        nativeAssistant('session-1', { responseId: 'gen-two', input: 1_000_000, output: 0 }),
      ]);
      const metered = await meterNative({
        enabled: true,
        fetchGenerationCost: async (id) => ({ totalCostUsd: id === 'gen-one' ? 0.5 : 0.75 }),
      });

      assert.equal(metered.outcome.status, 'success');
      const outcome = metered.outcome as WorkflowCostResult;
      assert.equal(outcome.totalCostUsd, 1.25);
      assert.equal(outcome.models['priced-native'].costUsd, 1.25);
      assert.deepEqual(outcome.pricingUsed, {});
      assert.equal(outcome.attribution?.models[0].providerReportedCostUsd, 1.25);
      assert.equal(outcome.attribution?.models[0].pricingSource, 'openrouter_api');
      assert.equal(metered.summaries?.[0].cost_source, 'provider_reported');
    });

    it('falls back to the local estimate per missing generation and warns once', async () => {
      writeNativeSession([
        nativeAssistant('session-1', { responseId: 'gen-one', input: 1_000_000, output: 0 }),
        nativeAssistant('session-1', { responseId: 'gen-two', input: 2_000_000, output: 0 }),
      ]);
      const warnings: string[] = [];
      const metered = await meterNative({
        enabled: true,
        fetchGenerationCost: async (id) => (id === 'gen-one' ? { totalCostUsd: 0.5 } : null),
      }, silentLogger(warnings));

      const outcome = metered.outcome as WorkflowCostResult;
      // $0.50 exact + 2M input tokens at $2/MTok estimated.
      assert.equal(outcome.totalCostUsd, 4.5);
      assert.equal(outcome.attribution?.models[0].providerReportedCostUsd, 0.5);
      assert.equal(outcome.attribution?.models[0].pricingSource, 'mixed');
      assert.equal(outcome.pricingUsed['priced-native'].inputCostPerMTok, 2);
      assert.ok(warnings.some((message) => message.includes('1 generation')));
    });

    it('never calls OpenRouter for turns without a response id', async () => {
      writeNativeSession([nativeAssistant('session-1', { input: 1_000_000, output: 0 })]);
      let calls = 0;
      const metered = await meterNative({
        enabled: true,
        fetchGenerationCost: async () => {
          calls++;
          return { totalCostUsd: 99 };
        },
      });
      const outcome = metered.outcome as WorkflowCostResult;
      assert.equal(calls, 0);
      assert.equal(outcome.totalCostUsd, 2);
      assert.equal(outcome.attribution?.models[0].pricingSource, 'local_estimate');
    });

    it('disabled exact pricing is byte-identical to no exact pricing', async () => {
      writeNativeSession([nativeAssistant('session-1', { responseId: 'gen-one', input: 1_000_000, output: 0 })]);
      let calls = 0;
      const disabled = await meterNative({
        enabled: false,
        fetchGenerationCost: async () => {
          calls++;
          return { totalCostUsd: 99 };
        },
      });
      const plain = await meterNative();
      assert.equal(calls, 0);
      assert.deepEqual(
        { ...disabled, summaries: disabled.summaries?.map(({ collected_at: _, ...rest }) => rest) },
        { ...plain, summaries: plain.summaries?.map(({ collected_at: _, ...rest }) => rest) },
      );
    });

    it('keeps local estimates when the exact lookup itself throws', async () => {
      writeNativeSession([nativeAssistant('session-1', { responseId: 'gen-one', input: 1_000_000, output: 0 })]);
      const warnings: string[] = [];
      const metered = await meterNative({
        enabled: true,
        fetchGenerationCost: async () => {
          throw new Error('network down');
        },
      }, silentLogger(warnings));
      const outcome = metered.outcome as WorkflowCostResult;
      assert.equal(outcome.totalCostUsd, 2);
      assert.equal(outcome.attribution?.models[0].pricingSource, 'local_estimate');
      assert.ok(warnings.some((message) => message.includes('1 generation')));
    });
  });
});
