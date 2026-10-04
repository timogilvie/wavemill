/**
 * Tests for the counterfactual runner.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckpoint, type CreateCheckpointInput } from './session-checkpoint.ts';
import {
  CounterfactualRefusedError,
  EXPLORATION_BUDGET_EXHAUSTED,
  defaultOutcomeAdapter,
  runCounterfactuals,
} from './counterfactual-runner.ts';

function mkRepo(): string {
  return mkdtempSync(join(tmpdir(), 'hok2081-cf-'));
}

function baseInput(overrides: Partial<CreateCheckpointInput> = {}): CreateCheckpointInput {
  return {
    sessionId: 's-1',
    decisionId: 'd-1',
    phase: 'coding',
    events: [{ id: 'evt-1', kind: 'tool_call', payload: {}, tool: 'read_file' }],
    toolResults: [{ callId: 'evt-1', tool: 'read_file', content: 'ok' }],
    workingFiles: [],
    runtimeEnv: {
      whitelistEnv: {},
      network_access: false,
      modelId: 'claude-opus-4-6',
    },
    gitState: { headSha: 'abc', dirty: false },
    entropy: { mathRandomSeed: 1, dateNowSeedMs: 0 },
    toolMenu: { toolNames: ['read_file', 'write_file'], chosenTool: 'read_file' },
    now: () => new Date('2026-09-24T00:00:00Z'),
    ...overrides,
  };
}

describe('counterfactual-runner: enumerate-all', () => {
  it('produces 1 baseline + N counterfactual rows linked by source_decision_id', async () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(baseInput(), { repoDir: repo });
      const result = await runCounterfactuals({
        checkpointRoot: handle.root,
        modelId: 'claude-opus-4-6',
        policy: { kind: 'enumerate-all' },
        budget: { branchesMax: 10, stepsPerBranchMax: 4, wallSecondsMax: 30 },
      });
      assert.equal(result.baseline.decision_source, 'live');
      assert.equal(result.counterfactuals.length, 1);
      assert.equal(result.counterfactuals[0].decision_source, 'counterfactual');
      assert.equal(result.counterfactuals[0].source_decision_id, result.baseline.id);
      assert.equal(result.baseline.modelId, 'claude-opus-4-6');
      assert.ok(result.counterfactuals[0].policy_source?.startsWith('enumerate-all'));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('trims branches beyond branchesMax and marks the excess as budget-exhausted', async () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(
        baseInput({
          toolMenu: { toolNames: ['read_file', 'write_file', 'grep_files'], chosenTool: 'read_file' },
        }),
        { repoDir: repo },
      );
      const result = await runCounterfactuals({
        checkpointRoot: handle.root,
        modelId: 'claude-opus-4-6',
        policy: { kind: 'enumerate-all' },
        budget: { branchesMax: 1, stepsPerBranchMax: 4, wallSecondsMax: 30 },
      });
      assert.equal(result.branchesExpanded, 1);
      assert.equal(result.budgetExhausted, true);
      assert.equal(result.counterfactuals.length, 2);
      const exhausted = result.counterfactuals.filter((r) => r.policy_source?.includes('budget_exhausted'));
      assert.equal(exhausted.length, 1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('counterfactual-runner: deterministic-baseline', () => {
  it('emits only the baseline row', async () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(baseInput(), { repoDir: repo });
      const result = await runCounterfactuals({
        checkpointRoot: handle.root,
        modelId: 'claude-opus-4-6',
        policy: { kind: 'deterministic-baseline' },
        budget: { branchesMax: 10, stepsPerBranchMax: 4, wallSecondsMax: 30 },
      });
      assert.equal(result.counterfactuals.length, 0);
      assert.equal(result.baseline.decision_source, 'live');
      assert.equal(result.baseline.replay_fidelity, 1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('counterfactual-runner: epsilon-greedy', () => {
  it('samples deterministically from the decision id', async () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(
        baseInput({
          toolMenu: {
            toolNames: ['read_file', 'write_file', 'grep_files', 'bash'],
            chosenTool: 'read_file',
          },
        }),
        { repoDir: repo },
      );
      const first = await runCounterfactuals({
        checkpointRoot: handle.root,
        modelId: 'claude-opus-4-6',
        policy: { kind: 'epsilon-greedy', epsilon: 0.5 },
        budget: { branchesMax: 10, stepsPerBranchMax: 4, wallSecondsMax: 30 },
      });
      const second = await runCounterfactuals({
        checkpointRoot: handle.root,
        modelId: 'claude-opus-4-6',
        policy: { kind: 'epsilon-greedy', epsilon: 0.5 },
        budget: { branchesMax: 10, stepsPerBranchMax: 4, wallSecondsMax: 30 },
      });
      const firstTools = first.counterfactuals.map((r) => r.policy_source);
      const secondTools = second.counterfactuals.map((r) => r.policy_source);
      assert.deepEqual(firstTools, secondTools, 'epsilon-greedy must be deterministic on decisionId');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects epsilon out of [0,1]', async () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(baseInput(), { repoDir: repo });
      await assert.rejects(
        () =>
          runCounterfactuals({
            checkpointRoot: handle.root,
            modelId: 'claude-opus-4-6',
            policy: { kind: 'epsilon-greedy', epsilon: 2 },
            budget: { branchesMax: 2, stepsPerBranchMax: 4, wallSecondsMax: 30 },
          }),
        (err) => err instanceof CounterfactualRefusedError && err.reason === 'invalid_policy',
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('counterfactual-runner: model guard', () => {
  it('refuses when the runner model does not match the checkpoint', async () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(baseInput(), { repoDir: repo });
      await assert.rejects(
        () =>
          runCounterfactuals({
            checkpointRoot: handle.root,
            modelId: 'claude-haiku-4-5',
            policy: { kind: 'enumerate-all' },
            budget: { branchesMax: 2, stepsPerBranchMax: 4, wallSecondsMax: 30 },
          }),
        (err) => err instanceof CounterfactualRefusedError && err.reason === 'model_mismatch',
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('counterfactual-runner: outcome adapter injection', () => {
  it('lets callers score branches without touching the LLM', async () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(baseInput(), { repoDir: repo });
      const result = await runCounterfactuals({
        checkpointRoot: handle.root,
        modelId: 'claude-opus-4-6',
        policy: { kind: 'enumerate-all' },
        budget: { branchesMax: 2, stepsPerBranchMax: 4, wallSecondsMax: 30 },
        outcomeAdapter: ({ toolChoice, isBaseline }) => ({
          score: isBaseline ? 0.9 : 0.4,
          rationale: `Custom outcome for ${toolChoice}`,
        }),
      });
      assert.equal(result.baseline.score, 0.9);
      assert.equal(result.counterfactuals[0].score, 0.4);
      assert.match(result.counterfactuals[0].rationale, /Custom outcome/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('defaultOutcomeAdapter is deterministic on the decisionId + toolChoice', async () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(baseInput(), { repoDir: repo });
      const first = await defaultOutcomeAdapter({
        checkpoint: handle,
        toolChoice: 'write_file',
        isBaseline: false,
        branchIndex: 0,
        stepsBudget: 1,
      });
      const second = await defaultOutcomeAdapter({
        checkpoint: handle,
        toolChoice: 'write_file',
        isBaseline: false,
        branchIndex: 0,
        stepsBudget: 1,
      });
      assert.equal(first.score, second.score);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('counterfactual-runner: budget-exhausted rows', () => {
  it('emits a policy_source containing budget_exhausted when steps trim', async () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(
        baseInput({
          toolMenu: {
            toolNames: ['read_file', 'write_file', 'grep_files', 'bash'],
            chosenTool: 'read_file',
          },
        }),
        { repoDir: repo },
      );
      const result = await runCounterfactuals({
        checkpointRoot: handle.root,
        modelId: 'claude-opus-4-6',
        policy: { kind: 'enumerate-all' },
        budget: { branchesMax: 2, stepsPerBranchMax: 4, wallSecondsMax: 30 },
      });
      assert.equal(result.branchesExpanded, 2);
      const exhausted = result.counterfactuals.filter((r) => r.policy_source?.includes('budget_exhausted'));
      assert.equal(exhausted.length, 1, 'One branch should be recorded as budget-exhausted');
      assert.equal(exhausted[0].metadata?.branchFailureReason, EXPLORATION_BUDGET_EXHAUSTED);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
