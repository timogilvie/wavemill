/**
 * HOK-3454: operator abort writes a valid terminal lifecycle.
 *
 * `recordArmTermination` with `actor: 'operator'` flips the task row to
 * `aborted` and must stamp a `retention` block so the lifecycle pair is
 * schema-valid and the task-record write guard logs no violation.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { recordArmTermination } from './arm-termination.ts';
import { createTerminalFeedbackReplay } from '../../tests/fixtures/terminal-arm-feedback/replay.ts';
import { readEvalRecords } from './eval-persistence.ts';
import type { WorkflowState } from './workflow-state.ts';

let repoDir: string;
let statePath: string;

function seedState(): void {
  // Seed the invalid pre-fix row directly: the fixture builder validates
  // against the schema and would reject closed+allocated without retention,
  // but the shadow log shows this exact invalid state reached the writer.
  const state = {
    // allow-task-literal: deliberately invalid pre-fix row from the shadow log
    tasks: {
      'HOK-3424_c': {
        slug: 'attention-22-observer-push-reads-the-attention-projection-delete',
        status: 'active',
        phase: 'coding',
        branch: '',
        worktree: '',
        pr: '',
        lifecycle: {
          schemaVersion: 1,
          workflowOutcome: 'active',
          resourceDisposition: 'allocated',
        },
      },
    },
  };
  writeFileSync(statePath, JSON.stringify(state));
}

function readState(): WorkflowState {
  return JSON.parse(readFileSync(statePath, 'utf-8')) as WorkflowState;
}

function violationsLog(): string[] {
  const log = join(repoDir, '.wavemill', 'state-schema-violations.jsonl');
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf-8').split('\n').filter(Boolean);
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'arm-termination-'));
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  statePath = join(repoDir, '.wavemill', 'workflow-state.json');
  seedState();
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe('operator abort lifecycle write', () => {
  it('stamps retention on a terminal allocated row', async () => {
    const result = await recordArmTermination({
      issueId: 'HOK-3424_c',
      kind: 'cancelled',
      actor: 'operator',
      stage: 'coding',
      scope: 'single',
      stateFile: statePath,
      repoDir,
      now: () => new Date('2026-11-08T23:31:34.625Z'),
    });

    assert.equal(result.stateMutated, true);
    const task = readState().tasks?.['HOK-3424_c'];
    assert.equal(task?.phase, 'aborted');
    assert.equal(task?.status, 'aborted');
    assert.equal(task?.lifecycle?.workflowOutcome, 'aborted');
    assert.equal(task?.lifecycle?.resourceDisposition, 'verification-required');
    assert.ok(
      typeof task?.lifecycle?.retention?.reason === 'string' && task.lifecycle.retention.reason.length > 0,
      'operator abort must set retention.reason',
    );
    assert.equal(task?.lifecycle?.retention?.policy, 'manual-verification-required');
    assert.equal(task?.lifecycle?.retention?.actor, 'operator-abort');
    assert.deepEqual(task?.lifecycle?.retention?.evidence, {
      stage: 'coding',
      scope: 'single',
      abortReason: result.abortReason,
    });
    assert.deepEqual(violationsLog(), [], 'the write guard must log no violations');
  });
});

// protects: terminal economics survive locally even with Hokusai submission disabled.
it('records cost and provider facts in reliability and failure evals before submission or cleanup', async () => {
  const world = await createTerminalFeedbackReplay(repoDir, 2);
  const input = { repoDir, featureDir: world.featureDir, issueId: 'REPLAY-1_c', kind: 'cancelled' as const,
    actor: 'monitor' as const, stage: 'planning', model: 'z-ai/glm-5.3', skipStateMutation: true };
  const result = await recordArmTermination(input);
  assert.equal(result.faultClass, 'harness-fault');
  assert.equal(result.reliability.nativeProviderExecutions?.length, 2);
  assert.ok(result.reliability.taskCostSummary?.length);
  const record = readEvalRecords({ repoDir }).find(row => row.id === result.evalRecordId);
  assert.ok(record);
  assert.equal(record.nativeProviderExecutions?.length, 2);
  assert.ok(record.taskCostSummary?.length);
  const repeated = await recordArmTermination(input);
  assert.equal(repeated.reliability.id, result.reliability.id);
  assert.equal(repeated.evalRecordId, result.evalRecordId);
});
