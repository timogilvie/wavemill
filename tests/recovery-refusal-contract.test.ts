import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import fc from 'fast-check';
import { classifyFailure } from '../shared/lib/failure-policy.ts';
import type { RecoverySnapshot, RecoveryDecision } from '../shared/lib/task-recovery-controller.ts';
import type { RecoveryUnavailableReason } from '../shared/lib/execution-contract.ts';
import { resolveSeed } from '../shared/lib/fast-check-utils.ts';
import { loadContractModule } from './lib/contract-module.ts';

const sourceOverride = process.env.RECOVERY_CONTRACT_CONTROLLER_SOURCE;
const controller = await loadContractModule<{decideTaskRecovery(snapshot: RecoverySnapshot): RecoveryDecision}>(
  new URL('../shared/lib/task-recovery-controller.ts', import.meta.url), sourceOverride,
);
const incidentFixture = new URL('./fixtures/recovery-refusal-contract/hok-3512.json', import.meta.url);
const incident = JSON.parse(readFileSync(incidentFixture, 'utf8'));
const reasons: RecoveryUnavailableReason[] = ['contract_missing', 'contract_malformed', 'model_disabled',
  'model_not_launchable', 'provider_unavailable', 'agent_unsupported_for_model', 'certification_invalid_for_role'];

function snapshot(reason: RecoveryUnavailableReason | null, retry: 'proceed' | 'backoff' | 'exhausted' | 'exhausted-quiet' = 'proceed'): RecoverySnapshot {
  return {
    issue: 'HOK-3512', stage: 'coding',
    attempt: {currentRunId: 'current', controlRunId: 'current'},
    disposition: null, stageResult: {kind: 'failed'}, outstandingEffect: null, wait: null,
    failure: {decision: classifyFailure({stage: 'coding', detail: 'unknown stage failure'}), retry},
    executionContract: reason ? {ok: false, reason, detail: `saved route refused: ${reason}`} : null,
  };
}

function decide(input: RecoverySnapshot): RecoveryDecision {
  // Reconstruct the old boolean producer only for the pre-pilot negative
  // control. The modern contract tests retain the full validator evidence.
  const legacy = sourceOverride ? {...input, contractAvailable: input.executionContract?.ok ?? null} : input;
  return controller.decideTaskRecovery(legacy);
}

test('HOK-3512: repeated refusal polls reach escalation, then a repaired route can retry', () => {
  let refused = true;
  for (const event of incident.events) {
    if (event === 'repair-route') { refused = false; continue; }
    const d = decide(snapshot(refused ? incident.validator.reason : null));
    assert.equal(d.action, refused ? 'escalate' : 'retry-stage');
    if (refused) assert.ok(d.rationale.includes(incident.validator.reason), 'validator reason survives the decision');
  }
});

test('every refusal reaches actionable escalation independent of retry/backoff state', () => {
  for (const reason of reasons) {
    for (const retry of ['proceed', 'backoff', 'exhausted', 'exhausted-quiet'] as const) {
      const d = decide(snapshot(reason, retry));
      assert.equal(d.action, 'escalate', `${reason}/${retry}: refusal cannot wait for an event with no producer`);
      assert.equal(d.escalationBasis?.kind, 'policy-terminal');
      assert.ok(d.rationale.includes(reason));
      assert.equal(d.failure?.cause?.faultClass, 'selection-fault');
      assert.equal(d.failure?.attribution, 'unattributed');
      assert.ok(d.failure?.detail.includes(reason));
    }
  }
});

test('a failed validator read retains bounded retry rather than inventing a permanent refusal', () => {
  for (const [retry, action] of [['proceed', 'retry-stage'], ['backoff', 'wait'], ['exhausted', 'escalate']] as const) {
    const input = snapshot(null, retry);
    input.executionContract = {ok: false, reason: 'contract_read_failed', detail: 'CLI exited non-zero'};
    const d = decide(input);
    assert.equal(d.action, action);
    assert.equal(d.failure?.class, 'retryable');
    if (action === 'wait') assert.equal(d.wait?.wake, 'backoff-elapsed');
    assert.notEqual(d.escalationBasis?.kind, 'policy-terminal');
  }
  const exhausted = snapshot(null);
  exhausted.failure!.decision = classifyFailure({stage: 'coding', failureKind: 'task-budget-exhausted'});
  exhausted.executionContract = {ok: false, reason: 'contract_read_failed', detail: 'CLI exited non-zero'};
  assert.equal(decide(exhausted).escalationBasis?.kind, 'policy-terminal');
  assert.equal(decide(exhausted).failureKind, 'task-budget-exhausted');
});

test('refusal must not override stale identity, human holds, completion or uncertain effects', () => {
  const base = snapshot('model_disabled');
  assert.equal(decide({...base, attempt: {currentRunId: 'new', controlRunId: 'old'}}).action, 'reject-stale-control');
  assert.equal(decide({...base, wait: {owner: 'human', wake: 'operator-release'}}).action, 'wait');
  assert.equal(decide({...base, stageResult: {kind: 'valid', status: 'completed'}}).action, 'consume-advance');
  assert.equal(decide({...base, outstandingEffect: {kind: 'launch', acknowledged: false}}).action, 'verify-effect');
  assert.equal(decide({...base, disposition: {kind: 'in-flight', reason: 'agent-working'}}).action, 'no-action');
});

test('generated route/hold/completion sequences preserve action priority and never silently wait on refusal', () => {
  const seed = resolveSeed();
  console.error(`[refusal-contract] seed=${seed}`);
  const result = fc.check(fc.property(
    fc.array(fc.constantFrom('refuse', 'repair', 'hold', 'release', 'complete', 'stale', 'current', 'poll'), {minLength: 1, maxLength: 30}),
    events => {
      let refused = false, held = false, complete = false, stale = false;
      for (const event of [...events, 'poll']) {
        if (event === 'refuse') refused = true;
        if (event === 'repair') refused = false;
        if (event === 'hold') held = true;
        if (event === 'release') held = false;
        if (event === 'complete') complete = true;
        if (event === 'stale') stale = true;
        if (event === 'current') stale = false;
        if (event !== 'poll') continue;
        const input = snapshot(refused ? 'contract_malformed' : null);
        input.attempt.controlRunId = stale ? 'old' : 'current';
        input.wait = held ? {owner: 'human', wake: 'operator-release'} : null;
        if (complete) input.stageResult = {kind: 'valid', status: 'completed'};
        const expected = stale ? 'reject-stale-control' : held ? 'wait' : complete ? 'consume-advance' : refused ? 'escalate' : 'retry-stage';
        assert.equal(decide(input).action, expected, `events=${events.join(',')}`);
      }
    },
  ), {seed, numRuns: 1000});
  assert.equal(result.failed, false, JSON.stringify({seed, path: result.counterexamplePath,
    counterexample: result.counterexample, error: result.error}, null, 2));
});
