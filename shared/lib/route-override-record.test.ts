/**
 * Tests for the one per-stage route record (HOK-3363), including the replay
 * fixtures from the issue: HOK-3329 (Hokusai → escalation → operator) and
 * HOK-3315 (Hokusai → challenge), each carried through to a contribution row
 * that validates against the current `@hokusai/core` row schema.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSubmitDataContributionRow } from './hokusai-contribution-builder.ts';
import {
  appendOverride,
  appendStageOverride,
  applyChallengeOverride,
  bindRouteDecisionId,
  decidedStageModel,
  finalizeStageRoutes,
  flattenRouteOverrides,
  hokusaiJoinKey,
  overrideStageModel,
  parseStageRoutes,
  ROUTE_OVERRIDES_CONTRIBUTION_SCHEMA,
  routeRecordContributionInputs,
  seedStageRoutes,
  type RouteRecordCarrier,
  type StageRouteRecord,
} from './route-override-record.ts';

function hokusaiDecision(overrides: Partial<RouteRecordCarrier> = {}): RouteRecordCarrier {
  return {
    planner: 'claude-sonnet-4-5',
    coder: 'claude-haiku-4-5',
    reviewer: 'claude-sonnet-4-5',
    routingMode: 'hokusai',
    provenance: {
      source: 'live',
      inputKind: 'task-packet',
      inputPath: '',
      inputHash: '',
      routedAt: '2026-10-30T09:00:00.000Z',
      routerMode: 'normal',
      requestId: 'a5f5e403-req',
      inferenceLogId: 'a5f5e403-req',
    },
    ...overrides,
  };
}

describe('hokusaiJoinKey', () => {
  // protects: the join key being lost when only metadata.request_id is present.
  it('prefers inferenceLogId and falls back to requestId', () => {
    assert.equal(hokusaiJoinKey({ inferenceLogId: 'log-1', requestId: 'req-1' }), 'log-1');
    assert.equal(hokusaiJoinKey({ requestId: 'req-1' }), 'req-1');
    assert.equal(hokusaiJoinKey({ inferenceLogId: '  ', requestId: undefined }), undefined);
    assert.equal(hokusaiJoinKey(undefined), undefined);
  });
});

describe('seedStageRoutes', () => {
  // protects: a Hokusai decision whose record does not name what Hokusai recommended.
  it('records the Hokusai recommendation and join key for a Hokusai decision', () => {
    const routes = seedStageRoutes(hokusaiDecision({ routeDecision: { decision_id: 'dec-1' } as RouteRecordCarrier['routeDecision'] }));
    assert.deepEqual(routes.coder, {
      hokusai: { requestId: 'a5f5e403-req', decisionId: 'dec-1', recommended: 'claude-haiku-4-5' },
      executed: 'claude-haiku-4-5',
      overrides: [],
    });
  });

  // protects: a local route being reported to Hokusai as a Hokusai recommendation.
  it('carries no Hokusai block for a locally routed decision', () => {
    const routes = seedStageRoutes(hokusaiDecision({ routingMode: 'policy' }));
    assert.equal(routes.coder.hokusai, undefined);
    assert.equal(routes.coder.executed, 'claude-haiku-4-5');
  });
});

describe('appendOverride / overrideStageModel', () => {
  // protects: a same-model "override" polluting the record.
  it('ignores an override that changes nothing', () => {
    const record: StageRouteRecord = { executed: 'a', overrides: [] };
    assert.equal(appendOverride(record, { source: 'operator', from: 'a', to: 'a', reason: 'r', at: 'x' }), record);
    const decision = hokusaiDecision();
    assert.equal(overrideStageModel(decision, 'coder', 'claude-haiku-4-5', { source: 'operator', reason: 'r' }), decision);
  });

  // protects: a stage model replaced in the router without the record seeing it.
  it('replaces the stage model and appends the override in one step', () => {
    const decision = overrideStageModel(hokusaiDecision(), 'coder', 'claude-opus-4-7', {
      source: 'launchability',
      reason: 'uncertified',
      certification: 'missing_live_canary',
      at: '2026-10-30T09:00:01.000Z',
    });
    assert.equal(decision.coder, 'claude-opus-4-7');
    assert.deepEqual(decision.stageRoutes?.coder, {
      hokusai: { requestId: 'a5f5e403-req', recommended: 'claude-haiku-4-5' },
      executed: 'claude-opus-4-7',
      overrides: [{
        source: 'launchability',
        from: 'claude-haiku-4-5',
        to: 'claude-opus-4-7',
        reason: 'uncertified',
        certification: 'missing_live_canary',
        at: '2026-10-30T09:00:01.000Z',
      }],
    });
    assert.equal(decision.stageRoutes?.planner.overrides.length, 0);
  });

  // protects: the second override's `from` naming Hokusai's pick instead of the model it replaced.
  it('chains overrides: each `from` is the previous `to`', () => {
    let decision = overrideStageModel(hokusaiDecision(), 'coder', 'b', { source: 'escalation', reason: 'r1', at: '1' });
    decision = overrideStageModel(decision, 'coder', 'c', { source: 'launchability', reason: 'r2', at: '2' });
    assert.deepEqual(decision.stageRoutes?.coder.overrides.map((o) => [o.from, o.to]), [['claude-haiku-4-5', 'b'], ['b', 'c']]);
    assert.equal(decidedStageModel(decision.stageRoutes!.coder), 'claude-haiku-4-5');
  });
});

describe('finalizeStageRoutes', () => {
  // protects: the router exit returning a decision without a record.
  it('seeds a record when no override ran and pins executed to the final models', () => {
    const finalized = finalizeStageRoutes(hokusaiDecision());
    assert.equal(finalized.stageRoutes?.coder.executed, 'claude-haiku-4-5');
    assert.equal(finalized.stageRoutes?.coder.hokusai?.recommended, 'claude-haiku-4-5');
  });
});

describe('bindRouteDecisionId', () => {
  // protects: the Wavemill decision id never reaching the Hokusai block.
  it('binds the minted decision id onto Hokusai stage records only', () => {
    const routes = bindRouteDecisionId(seedStageRoutes(hokusaiDecision()), 'dec-9');
    assert.equal(routes?.coder.hokusai?.decisionId, 'dec-9');
    assert.equal(bindRouteDecisionId(seedStageRoutes(hokusaiDecision({ routingMode: 'policy' })), 'dec-9')?.coder.hokusai, undefined);
    assert.equal(bindRouteDecisionId(undefined, 'dec-9'), undefined);
  });
});

describe('flattenRouteOverrides', () => {
  // protects: overrides exported out of temporal order.
  it('tags each override with its stage and orders by time', () => {
    let routes = seedStageRoutes(hokusaiDecision());
    routes = appendStageOverride(routes, 'coder', 'x', { source: 'operator', reason: 'late', at: '2026-10-30T12:00:00.000Z' });
    routes = appendStageOverride(routes, 'reviewer', 'y', { source: 'launchability', reason: 'early', at: '2026-10-30T10:00:00.000Z' });
    assert.deepEqual(flattenRouteOverrides(routes).map((o) => [o.stage, o.reason]), [['reviewer', 'early'], ['coder', 'late']]);
    assert.deepEqual(flattenRouteOverrides(null), []);
  });
});

describe('parseStageRoutes', () => {
  // protects: a persisted record losing fields (or accepting junk) on the way back in.
  it('round-trips every override variant and drops malformed entries', () => {
    let routes = seedStageRoutes(hokusaiDecision());
    routes = appendStageOverride(routes, 'coder', 'b', {
      source: 'escalation', reason: 'r', at: '1',
      triggers: [{ metric: 'confidence', value: 0.334, threshold: 0.4 }], hokusai: { requestId: 'req-2' },
    });
    routes = appendStageOverride(routes, 'coder', 'c', { source: 'challenge', reason: 'r', at: '2', pairId: 'p', side: 'primary' });
    routes = appendStageOverride(routes, 'coder', 'd', { source: 'operator', reason: 'r', at: '3', actor: 'op' });
    routes = appendStageOverride(routes, 'planner', 'e', { source: 'launchability', reason: 'r', at: '4', certification: 'c' });
    assert.deepEqual(parseStageRoutes(JSON.parse(JSON.stringify(routes))), routes);

    const junk = JSON.parse(JSON.stringify(routes));
    junk.coder.overrides.push({ source: 'whim', from: 'a', to: 'b', reason: 'r', at: '5' });
    junk.coder.overrides.push({ source: 'challenge', from: 'a', to: 'b', reason: 'r', at: '5' });
    assert.equal(parseStageRoutes(junk)?.coder.overrides.length, 3);
    assert.equal(parseStageRoutes({ coder: routes.coder }), null);
    assert.equal(parseStageRoutes('nope'), null);
  });
});

describe('applyChallengeOverride', () => {
  const seal = {
    pairId: 'pair-1',
    selectedStage: 'implementation' as const,
    primaryVariedModel: 'claude-haiku-4-5',
    challengerVariedModel: 'gpt-5.5',
  };

  // protects: re-running the eval appending the same challenge override twice.
  it('is idempotent per pair and side', () => {
    const routes = seedStageRoutes(hokusaiDecision({ coder: 'claude-opus-4-7' }));
    const once = applyChallengeOverride(routes, seal, 'challenger', 't');
    assert.equal(applyChallengeOverride(once, seal, 'challenger', 't'), once);
    assert.equal(once?.coder.overrides.length, 1);
  });

  // protects: a challenge arm without a route artifact silently dropping the override.
  it('seeds a bare record from the sealed incumbent when no record exists', () => {
    const routes = applyChallengeOverride(null, seal, 'challenger', 't');
    assert.deepEqual(routes?.coder.overrides.map((o) => [o.from, o.to]), [['claude-haiku-4-5', 'gpt-5.5']]);
    assert.deepEqual(applyChallengeOverride(null, seal, 'primary', 't')?.coder.overrides, []);
  });
});

describe('replay fixtures', () => {
  // protects: HOK-3329 — Hokusai learning "glm failed" instead of "Haiku was overridden twice".
  it('HOK-3329: Hokusai claude-haiku-4-5 → escalation glm-5.3-flash (0.334 < 0.4) → operator claude-opus-5-5', () => {
    let decision = hokusaiDecision({
      provenance: { ...hokusaiDecision().provenance!, requestId: 'b41b1171', inferenceLogId: 'b41b1171' },
    });
    decision = overrideStageModel(decision, 'coder', 'glm-5.3-flash', {
      source: 'escalation',
      reason: 'hokusai_reask_below_floor',
      triggers: [{ metric: 'confidence', value: 0.334, threshold: 0.4 }],
      hokusai: { requestId: 'b41b1171-reask' },
      at: '2026-10-30T10:00:00.000Z',
    });
    const finalized = finalizeStageRoutes(decision);
    const routes = appendStageOverride(finalized.stageRoutes!, 'coder', 'claude-opus-5-5', {
      source: 'operator',
      reason: 'operator_force_reroute',
      at: '2026-10-30T14:00:00.000Z',
    });

    assert.equal(routes.coder.hokusai?.recommended, 'claude-haiku-4-5');
    assert.equal(routes.coder.hokusai?.requestId, 'b41b1171');
    assert.equal(routes.coder.executed, 'claude-opus-5-5');
    const [escalation, operator] = routes.coder.overrides;
    assert.ok(escalation.source === 'escalation');
    assert.equal(escalation.from, 'claude-haiku-4-5');
    assert.equal(escalation.to, 'glm-5.3-flash');
    assert.deepEqual(escalation.triggers, [{ metric: 'confidence', value: 0.334, threshold: 0.4 }]);
    assert.equal(operator.source, 'operator');
    assert.equal(operator.from, 'glm-5.3-flash');
    assert.equal(operator.to, 'claude-opus-5-5');

    const row = buildSubmitDataContributionRow({
      observedAt: '2026-10-31T00:00:00.000Z',
      observedSuccess: false,
      budgetCompliant: true,
      harness: 'wavemill',
      inputs: routeRecordContributionInputs(routes, hokusaiJoinKey(decision.provenance)),
    });
    assert.equal(row.inputs?.inference_log_id, 'b41b1171');
    assert.equal(row.inputs?.route_overrides_schema, ROUTE_OVERRIDES_CONTRIBUTION_SCHEMA);
    assert.deepEqual(row.inputs?.route_override_sources, ['escalation', 'operator']);
    assert.deepEqual(row.inputs?.route_override_to, ['glm-5.3-flash', 'claude-opus-5-5']);
  });

  // protects: HOK-3315 — the challenge's varied model reaching Hokusai as Hokusai's recommendation.
  it('HOK-3315: Hokusai claude-opus-4-7 → challenge claude-haiku-4-5 on the primary arm', () => {
    const decision = finalizeStageRoutes(hokusaiDecision({
      planner: 'claude-opus-4-7',
      coder: 'claude-opus-4-7',
      reviewer: 'claude-opus-4-7',
      provenance: { ...hokusaiDecision().provenance!, requestId: '87447d9f', inferenceLogId: '87447d9f' },
      routeDecision: { decision_id: '06fb4138' } as RouteRecordCarrier['routeDecision'],
    }));
    const routes = applyChallengeOverride(decision.stageRoutes, {
      pairId: 'pair-hok-3315',
      selectedStage: 'implementation',
      primaryVariedModel: 'claude-haiku-4-5',
      challengerVariedModel: 'gpt-5.5',
    }, 'primary', '2026-10-30T11:00:00.000Z');

    assert.deepEqual(routes?.coder, {
      hokusai: { requestId: '87447d9f', decisionId: '06fb4138', recommended: 'claude-opus-4-7' },
      executed: 'claude-haiku-4-5',
      overrides: [{
        source: 'challenge',
        from: 'claude-opus-4-7',
        to: 'claude-haiku-4-5',
        reason: 'challenge_primary_incumbent',
        at: '2026-10-30T11:00:00.000Z',
        pairId: 'pair-hok-3315',
        side: 'primary',
      }],
    });

    const row = buildSubmitDataContributionRow({
      observedAt: '2026-10-31T00:00:00.000Z',
      observedSuccess: false,
      budgetCompliant: true,
      inputs: routeRecordContributionInputs(routes, '87447d9f'),
    });
    assert.equal(row.inputs?.inference_log_id, '87447d9f');
    assert.deepEqual(row.inputs?.route_override_sources, ['challenge']);
    assert.deepEqual(row.inputs?.route_override_from, ['claude-opus-4-7']);
  });
});
