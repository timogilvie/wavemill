/**
 * HOK-3362 cross-stage table: the same budget-exhaustion evidence must produce
 * the same typed fact, the same failure kind, the same retry decision and the
 * same derived fault class whichever native stage ran out of budget.
 *
 * Each row drives the real stage producer (launchNativePlanning,
 * launchNativeCoding, runNativeReview) to a `turn_limit` stop after two turns
 * that each executed one tool call, then reads back the envelope the producer
 * wrote and runs it through the monitor's conversion and both classifiers.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { classifyArmFault } from '../arm-failure-taxonomy.ts';
import { classifyFailure } from '../failure-policy.ts';
import type { BudgetExhaustedFact } from './budget-exhaustion.ts';
import { launchNativeCoding } from './launch-coding.ts';
import { launchNativePlanning } from './launch-planning.ts';
import { registerScriptedPiProvider, type ScriptedPiProviderTurn } from './provider.ts';
import type { ReadyNativeProviderEntry } from './providers.ts';
import { nativeReviewTestUtils, runNativeReview } from './review.ts';
import {
  getStageFailureEnvelopePath,
  readStageFailureEnvelope,
  terminalFailureKindForEnvelope,
  type StageFailureStage,
} from './stage-failure-envelope.ts';

const TURNS = 2;
const scratch: string[] = [];

after(() => {
  nativeReviewTestUtils.resetDeps();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function gitRepo(prefix: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content, 'utf-8');
  }
  execFileSync('git', ['init', dir], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'budget@wavemill.test'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Budget Test'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'commit', '-m', 'fixture'], { stdio: 'pipe' });
  return dir;
}

/** Two turns, each reading the same file: progress without a final answer. */
function readTurns(path: string): ScriptedPiProviderTurn[] {
  return Array.from({ length: TURNS + 2 }, (_, index) => ({
    content: [{ type: 'tool_call' as const, id: `read-${index}`, name: 'read_file', arguments: { path } }],
    usage: { input: 10, output: 5, totalTokens: 15 },
    stopReason: 'tool_calls' as const,
  }));
}

function scriptedModel(label: string, path: string) {
  const api = `budget-cross-stage-${label}-${process.pid}-${Date.now()}`;
  registerScriptedPiProvider({ api, provider: 'scripted', turns: readTurns(path) });
  return { id: `scripted:${api}`, name: `scripted:${api}`, api, provider: 'scripted' } as const;
}

async function runPlanning(): Promise<string> {
  const wtDir = gitRepo('budget-planning-', {
    'src.ts': 'export const value = 1;\n',
    'features/demo/task-packet.md': '# Task Packet\n## 1. Objective\nPlan.\n## Success Criteria\n- done\n',
  });
  writeFileSync(join(wtDir, '.wavemill-config.json'), JSON.stringify({
    nativeAgent: { planning: { maxTurns: TURNS, maxToolCalls: 120, maxWallClockMs: 60_000 } },
  }));
  await assert.rejects(() => launchNativePlanning({
    session: 'budget',
    issue: 'HOK-3362',
    slug: 'demo',
    wtDir,
    repoDir: wtDir,
    loopModelOverride: scriptedModel('planning', 'src.ts'),
    runTsxCommand: (args) => {
      const outputIndex = args.indexOf('--output');
      if (outputIndex >= 0) {
        writeFileSync(args[outputIndex + 1]!, JSON.stringify({ planner: 'm', coder: 'm', reviewer: 'm', planDepth: 'light' }));
      }
      return '';
    },
  }), /native-stage-timeout/);
  return join(wtDir, 'features', 'demo');
}

async function runCoding(): Promise<string> {
  const repoDir = gitRepo('budget-coding-', {
    'src/app.ts': "export const message = 'before';\n",
    'features/demo/plan.md': '# Plan\n',
    'features/demo/task-packet.md': '# Task Packet\n',
  });
  await assert.rejects(() => launchNativeCoding({
    session: 'budget',
    issue: 'HOK-3362',
    slug: 'demo',
    wtDir: repoDir,
    repoDir,
    loopModelOverride: scriptedModel('coding', 'src/app.ts'),
    loopBudgetOverride: { maxTurns: TURNS },
  }), /native-stage-timeout/);
  return join(repoDir, 'features', 'demo');
}

async function runReview(): Promise<string> {
  const repoDir = mkdtempSync(join(tmpdir(), 'budget-review-'));
  const featureDir = mkdtempSync(join(tmpdir(), 'budget-review-feature-'));
  scratch.push(repoDir, featureDir);
  writeFileSync(join(repoDir, '.wavemill-config.json'), '{}', 'utf-8');
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
  // The review loop is injected with the same evidence the scripted planning
  // and coding runs produce: two turns, one tool call each, turn budget spent.
  nativeReviewTestUtils.setRunWavemillLoop(async () => ({
    messages: [],
    stopReason: 'turn_limit',
    turnsCompleted: TURNS,
    toolCallsExecuted: TURNS,
    totalInputTokens: 20,
    totalOutputTokens: 10,
    totalCostUsd: 0,
    wallClockMs: 5,
  }) as never);
  const result = await runNativeReview({
    diff: 'diff --git a/file.ts b/file.ts',
    plan: 'Plan',
    taskPacket: 'Task packet',
    designContext: null,
    metadata: { branch: 'feature/budget', files: ['file.ts'], hasUiChanges: false },
  }, repoDir, { featureDir });
  // HOK-3019: review keeps its escalation category, produced from the fact.
  assert.equal(result.failureCategory, 'native-review-timeout');
  return featureDir;
}

describe('one budget outcome across native stages (HOK-3362)', () => {
  const rows: Array<[StageFailureStage, () => Promise<string>]> = [
    ['planning', runPlanning],
    ['coding', runCoding],
    ['review', runReview],
  ];
  const facts = new Map<StageFailureStage, BudgetExhaustedFact>();
  const classes = new Map<StageFailureStage, string>();

  for (const [stage, run] of rows) {
    // protects: a stage recording its budget stop under a private kind/cause (provider_error, no_completion_artifact, planning-turn-limit)
    it(`${stage}: writes the stage-timeout envelope with the turn fact and derives the class from it`, async () => {
      const featureDir = await run();
      const read = await readStageFailureEnvelope(getStageFailureEnvelopePath(featureDir, stage));
      assert.equal(read.ok, true, `${stage} envelope must validate`);
      if (!read.ok) return;
      const envelope = read.value;
      assert.equal(envelope.cause, 'stage-timeout');
      assert.equal(envelope.stopReason, 'turn_limit');
      const fact = envelope.budgetExhausted!;
      assert.equal(fact.kind, 'turn');
      assert.equal(fact.progress.turnsCompleted, TURNS);
      assert.equal(fact.progress.toolCallsExecuted, TURNS);

      const failureKind = terminalFailureKindForEnvelope(envelope);
      assert.equal(failureKind, 'native-stage-timeout');
      // Retry policy unchanged: retryable under the stage's shared bucket.
      const decision = classifyFailure({ stage, failureKind });
      assert.equal(decision.class, 'retryable');
      assert.equal(decision.retryBucket, `stage-failure-${stage}`);

      facts.set(stage, fact);
      classes.set(stage, classifyArmFault({ failureKind, budgetExhausted: fact }));
    });
  }

  // protects: stages diverging again on the same evidence
  it('every stage derives the same class from the same evidence', () => {
    assert.deepEqual([...classes.keys()].sort(), ['coding', 'planning', 'review']);
    assert.deepEqual(new Set(classes.values()), new Set(['model-fault']));
    const shapes = [...facts.values()].map((fact) => ({
      kind: fact.kind,
      stopReason: fact.stopReason,
      turnsCompleted: fact.progress.turnsCompleted,
      toolCallsExecuted: fact.progress.toolCallsExecuted,
    }));
    for (const shape of shapes) assert.deepEqual(shape, shapes[0]);
  });
});
