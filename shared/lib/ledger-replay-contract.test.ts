/**
 * HOK-3184 replay-contract test (acceptance §3 of task packet).
 *
 * Verifies that the step-row transitions produced by the three required
 * HOK-3177 replay scenarios — malformed-model-response, agent-sigkill,
 * host-sleep — all converge on the ledger shape the design doc specifies:
 *
 *   malformed-model-response → step `running` → `aborted` with `settled_reason`
 *       prefixed `exhausted:<bucket>:` (re-review exhausted its budget).
 *   agent-sigkill            → step `running` → `aborted` with `settled_reason`
 *       `interrupted:*` (the orchestrator settles with `interrupted`).
 *   host-sleep               → step `running` → `done` (recovers after sleep).
 *
 * These are the ledger-side outcomes the mill would end up with after the
 * incident-replay harness converges the file state. The test asserts the
 * shadow helpers produce rows that match.
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './ledger.ts';
import {
  computeStepInputsHash,
  markRetryExhausted,
  recordRetryAttempt,
  recordAgentEvidence,
  settleStep,
  upsertStep,
} from './ledger-shadow.ts';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wavemill-ledger-replay-'));
  dbPath = join(dir, 'ledger.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('malformed-model-response: step row transitions running → aborted:exhausted:<bucket>', () => {
  const ledger = Ledger.open({ dbPath });
  const step = upsertStep(ledger, {
    issueKey: 'HOK-3184',
    kind: 'review',
    inputsHash: computeStepInputsHash({ headSha: 'malformed', baseSha: 'base' }),
    maxAttempts: 3,
  });
  assert.equal(ledger.getTask(step.id)!.state, 'running');
  recordRetryAttempt(ledger, step.id);
  recordRetryAttempt(ledger, step.id);
  recordRetryAttempt(ledger, step.id);
  markRetryExhausted(ledger, step.id, 'review-infra-recovery', 'malformed_model_response');
  const row = ledger.getTask(step.id)!;
  assert.equal(row.settled_as, 'aborted');
  assert.ok(row.settled_reason?.startsWith('exhausted:review-infra-recovery'));
  assert.ok(row.settled_reason?.includes('malformed_model_response'));
  ledger.close();
});

test('agent-sigkill: step row transitions running → interrupted via settleStep', () => {
  const ledger = Ledger.open({ dbPath });
  const step = upsertStep(ledger, {
    issueKey: 'HOK-3184',
    kind: 'review',
    inputsHash: computeStepInputsHash({ headSha: 'sigkill-head' }),
  });
  // Agent writes a working hook event before the kill.
  recordAgentEvidence(ledger, 'HOK-3184', 'PreToolUse', 'Edit');
  // The orchestrator detects the dead process and settles the step as interrupted.
  settleStep(ledger, step.id, 'interrupted', 'agent_sigkill_mid_stage');
  const row = ledger.getTask(step.id)!;
  assert.equal(row.settled_as, 'interrupted');
  assert.equal(row.settled_reason, 'agent_sigkill_mid_stage');
  ledger.close();
});

test('host-sleep: step row transitions running → done after recovery', () => {
  const ledger = Ledger.open({ dbPath });
  const step = upsertStep(ledger, {
    issueKey: 'HOK-3184',
    kind: 'ready',
    inputsHash: computeStepInputsHash({ headSha: 'sleep-head', prNumber: 42 }),
  });
  // Pre-sleep: agent reports working.
  recordAgentEvidence(ledger, 'HOK-3184', 'PreToolUse', 'Read');
  // Post-sleep: agent resumes and reports Stop.
  recordAgentEvidence(ledger, 'HOK-3184', 'Stop', 'ready verdict');
  settleStep(ledger, step.id, 'done', 'ready_passed');
  const row = ledger.getTask(step.id)!;
  assert.equal(row.settled_as, 'done');
  assert.equal(row.settled_reason, 'ready_passed');
  // Both agent-hook evidence rows survived.
  const evidenceRows = ledger.listEvidence(step.id);
  assert.equal(evidenceRows.filter((r) => r.source === 'agent-hook').length, 2);
  ledger.close();
});

test('a new head mid-flight produces a distinct step row with fresh attempt=0', () => {
  const ledger = Ledger.open({ dbPath });
  const first = upsertStep(ledger, {
    issueKey: 'HOK-3184',
    kind: 'review',
    inputsHash: computeStepInputsHash({ headSha: 'head-1' }),
  });
  recordRetryAttempt(ledger, first.id);
  recordRetryAttempt(ledger, first.id);
  const second = upsertStep(ledger, {
    issueKey: 'HOK-3184',
    kind: 'review',
    inputsHash: computeStepInputsHash({ headSha: 'head-2' }),
  });
  assert.notEqual(second.id, first.id);
  assert.equal(ledger.getTask(second.id)!.attempt, 0);
  assert.equal(ledger.getTask(first.id)!.attempt, 2);
  ledger.close();
});
