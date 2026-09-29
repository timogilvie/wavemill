import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { validateRouteDecision } from './pr-metadata.ts';
import {
  appendRouteDecision,
  buildRouteDecision,
  classifyRouteDecisionSource,
  inferFeatureDirFromTaskFile,
  latestRouteDecision,
  LOCAL_ROUTER_POLICY_VERSION,
  parseRouteDecisions,
  readRouteDecisions,
  recommendedRouteOf,
  recordRouteDecision,
  recordRouteDecisionFromArtifact,
  resolvePolicyVersion,
  ROUTE_DECISION_KIND,
  toPrRouteDecision,
  type RouteDecisionRecord,
} from './route-decision.ts';
import type { WorkflowRouteDecision } from './workflow-router.ts';

const NOW = () => new Date('2026-09-28T12:00:00.000Z');
const tempDirs: string[] = [];

function featureDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'route-decision-test-'));
  tempDirs.push(root);
  const dir = join(root, 'features', 'hok-3098');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTraceContext(dir: string, traceId: string): void {
  writeFileSync(join(dir, '.trace-context.json'), JSON.stringify({
    schemaVersion: '1.0',
    traceId,
    issueId: 'HOK-3098',
    slug: 'hok-3098',
    createdAt: '2026-09-28T11:00:00.000Z',
  }));
}

function decision(overrides: Partial<WorkflowRouteDecision> = {}): WorkflowRouteDecision {
  return {
    planner: 'planner-a',
    coder: 'coder-a',
    reviewer: 'reviewer-a',
    planDepth: 'medium',
    codeDepth: 'medium',
    reviewRecommended: 'static',
    expectedSuccess: 0.8,
    expectedCostPlan: 0.1,
    expectedCostCode: 0.5,
    expectedCostReview: 0.1,
    confidence: 0.7,
    reasoning: ['prompt text that must never be recorded'],
    signals: {
      taskType: 'feature' as WorkflowRouteDecision['signals']['taskType'],
      promptLength: 'medium' as WorkflowRouteDecision['signals']['promptLength'],
      complexityScore: 3,
      fileTypes: [],
      riskScore: 2,
    },
    routingMode: 'policy',
    ...overrides,
  };
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('classifyRouteDecisionSource', () => {
  it('hokusai when Model 30 answered and was accepted', () => {
    assert.deepEqual(classifyRouteDecisionSource({ routingMode: 'hokusai' }), { source: 'hokusai' });
  });

  it('fallback with a typed reason when Hokusai was rejected', () => {
    assert.deepEqual(
      classifyRouteDecisionSource({ routingMode: 'stage-aware', fallbackReason: 'null_response' }),
      { source: 'fallback', fallback_reason: 'null_response' },
    );
    assert.deepEqual(
      classifyRouteDecisionSource({ routingMode: 'heuristic-fallback', fallbackReason: 'disabled_model' }),
      { source: 'fallback', fallback_reason: 'disabled_model' },
    );
  });

  it('local for every wavemill-only routing mode', () => {
    for (const routingMode of ['policy', 'stage-aware', 'stage-aware-partial', 'heuristic', 'heuristic-fallback', undefined]) {
      assert.deepEqual(classifyRouteDecisionSource({ routingMode }), { source: 'local' }, String(routingMode));
    }
  });
});

describe('resolvePolicyVersion', () => {
  it('uses the Model 30 version when the response exposes one', () => {
    assert.equal(
      resolvePolicyVersion({ routingMode: 'hokusai', provenance: { hokusai: { modelVersion: 'model30-2026.09' } } as WorkflowRouteDecision['provenance'] }),
      'model30-2026.09',
    );
  });

  it('falls back to the local router version otherwise', () => {
    assert.equal(resolvePolicyVersion({ routingMode: 'hokusai' }), LOCAL_ROUTER_POLICY_VERSION);
    assert.equal(resolvePolicyVersion({ routingMode: 'policy' }), LOCAL_ROUTER_POLICY_VERSION);
    assert.match(LOCAL_ROUTER_POLICY_VERSION, /^wavemill-router@\d+\.\d+\.\d+$/);
  });
});

describe('recommendedRouteOf', () => {
  it('prefers the pre-escalation snapshot over the escalated final route', () => {
    assert.deepEqual(
      recommendedRouteOf(decision({
        coder: 'strong-coder',
        preEscalationRoute: { planner: 'planner-a', coder: 'cheap-coder', reviewer: 'reviewer-a' },
      })),
      { planner: 'planner-a', coder: 'cheap-coder', reviewer: 'reviewer-a' },
    );
  });

  it('uses the final route when no escalation step ran', () => {
    assert.deepEqual(recommendedRouteOf(decision()), { planner: 'planner-a', coder: 'coder-a', reviewer: 'reviewer-a' });
  });
});

describe('buildRouteDecision', () => {
  it('reuses the task traceId as decision_id', () => {
    const record = buildRouteDecision(decision(), { traceId: 'trace-0123', now: NOW });
    assert.deepEqual(record, {
      kind: ROUTE_DECISION_KIND,
      schema: 1,
      decision_id: 'trace-0123',
      source: 'local',
      policy_version: LOCAL_ROUTER_POLICY_VERSION,
      recommended: { planner: 'planner-a', coder: 'coder-a', reviewer: 'reviewer-a' },
      decided_at: '2026-09-28T12:00:00.000Z',
    });
  });

  it('mints a UUID when no traceId is available', () => {
    const record = buildRouteDecision(decision(), { now: NOW });
    assert.match(record.decision_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(record.trace_id, undefined);
    assert.equal(record.supersedes, undefined);
  });

  it('a re-route mints a fresh id, records the traceId alongside and supersedes the prior decision', () => {
    const record = buildRouteDecision(decision({ routingMode: 'stage-aware', fallbackReason: 'disabled_model' }), {
      traceId: 'trace-0123',
      priorDecisionIds: ['trace-0123'],
      mintId: () => 'uuid-2',
      now: NOW,
    });
    assert.equal(record.decision_id, 'uuid-2');
    assert.equal(record.trace_id, 'trace-0123');
    assert.equal(record.supersedes, 'trace-0123');
    assert.equal(record.source, 'fallback');
    assert.equal(record.fallback_reason, 'disabled_model');
  });

  it('records only ids, models, versions and enums (validator-clean)', () => {
    const record = buildRouteDecision(decision({
      routingMode: 'hokusai',
      provenance: { hokusai: { modelVersion: 'model30-2026.09', rationale: 'free text' } } as WorkflowRouteDecision['provenance'],
    }), { traceId: 'trace-0123', now: NOW });
    const { kind: _kind, schema: _schema, ...payload } = record;
    assert.deepEqual(validateRouteDecision(payload), []);
    assert.ok(!JSON.stringify(record).includes('prompt text'));
    assert.ok(!JSON.stringify(record).includes('free text'));
  });
});

describe('parseRouteDecisions', () => {
  it('reads only decision lines and tolerates old and malformed lines', () => {
    const record = buildRouteDecision(decision(), { traceId: 'trace-0123', now: NOW });
    const text = [
      JSON.stringify({ role: 'planner', requestedSelector: 'planner-a', resolvedModelId: 'planner-a', timestamp: 1 }),
      JSON.stringify({ route: { planner: 'x', coder: 'y', reviewer: 'z' } }),
      '{broken',
      JSON.stringify(record),
      JSON.stringify({ kind: ROUTE_DECISION_KIND, decision_id: 'incomplete' }),
      '',
    ].join('\n');
    assert.deepEqual(parseRouteDecisions(text), [record]);
  });

  it('drops unknown fields on read rather than publishing them', () => {
    const record = buildRouteDecision(decision(), { traceId: 'trace-0123', now: NOW });
    const [parsed] = parseRouteDecisions(JSON.stringify(record));
    assert.deepEqual(toPrRouteDecision(parsed), toPrRouteDecision(record));
  });

  it('latest decision is the last appended', () => {
    const first = buildRouteDecision(decision(), { traceId: 't', now: NOW });
    const second = buildRouteDecision(decision(), { traceId: 't', priorDecisionIds: ['t'], mintId: () => 'u2', now: () => new Date('2026-09-28T11:00:00.000Z') });
    assert.equal(latestRouteDecision([first, second])?.decision_id, 'u2');
    assert.equal(latestRouteDecision([]), null);
  });
});

describe('appendRouteDecision / readRouteDecisions', () => {
  it('appends additively after existing per-phase lines and round-trips', async () => {
    const dir = featureDir();
    const phaseLine = JSON.stringify({ role: 'coder', requestedSelector: 'coder-a', resolvedModelId: 'coder-a' });
    writeFileSync(join(dir, 'routing.jsonl'), `${phaseLine}\n`);
    const record = buildRouteDecision(decision(), { traceId: 'trace-0123', now: NOW });

    assert.equal(await appendRouteDecision(dir, record), 'appended');

    const lines = readFileSync(join(dir, 'routing.jsonl'), 'utf-8').trim().split('\n');
    assert.equal(lines[0], phaseLine);
    assert.deepEqual(await readRouteDecisions(dir), [record]);
  });

  it('is idempotent on decision_id', async () => {
    const dir = featureDir();
    const record = buildRouteDecision(decision(), { traceId: 'trace-0123', now: NOW });
    assert.equal(await appendRouteDecision(dir, record), 'appended');
    assert.equal(await appendRouteDecision(dir, record), 'duplicate');
    assert.equal((await readRouteDecisions(dir)).length, 1);
  });

  it('links a pre-minted record to the newest prior decision on first write', async () => {
    const dir = featureDir();
    await appendRouteDecision(dir, buildRouteDecision(decision(), { traceId: 'trace-0123', now: NOW }));
    const cached = buildRouteDecision(decision(), { mintId: () => 'cached-uuid', now: NOW });

    await appendRouteDecision(dir, cached);

    const records = await readRouteDecisions(dir);
    assert.equal(records[1].decision_id, 'cached-uuid');
    assert.equal(records[1].supersedes, 'trace-0123');
  });

  it('rejects invalid records without writing', async () => {
    const dir = featureDir();
    const invalid = { ...buildRouteDecision(decision(), { now: NOW }), source: 'oracle' } as unknown as RouteDecisionRecord;
    assert.equal(await appendRouteDecision(dir, invalid), 'invalid');
    assert.deepEqual(await readRouteDecisions(dir), []);
  });

  it('never throws when the feature dir is missing or unwritable', async () => {
    const record = buildRouteDecision(decision(), { now: NOW });
    assert.equal(await appendRouteDecision(join(tmpdir(), 'route-decision-missing', 'nope'), record), 'failed');
    assert.deepEqual(await readRouteDecisions(join(tmpdir(), 'route-decision-missing', 'nope')), []);

    const dir = featureDir();
    chmodSync(dir, 0o500);
    try {
      const outcome = await appendRouteDecision(dir, record);
      // Root can write through 0500; everyone else must fail closed.
      assert.ok(outcome === 'failed' || outcome === 'appended');
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe('recordRouteDecision', () => {
  it('keys the first decision off the trace context and re-routes off a fresh id', async () => {
    const dir = featureDir();
    writeTraceContext(dir, 'trace-0123');

    const first = await recordRouteDecision(dir, decision({ routingMode: 'hokusai' }), { now: NOW });
    const second = await recordRouteDecision(dir, decision({ fallbackReason: 'null_response' }), { now: NOW, mintId: () => 'uuid-2' });

    assert.equal(first?.decision_id, 'trace-0123');
    assert.equal(first?.source, 'hokusai');
    assert.equal(second?.decision_id, 'uuid-2');
    assert.equal(second?.trace_id, 'trace-0123');
    assert.equal(second?.supersedes, 'trace-0123');
    assert.equal(second?.source, 'fallback');
    assert.deepEqual((await readRouteDecisions(dir)).map((item) => item.decision_id), ['trace-0123', 'uuid-2']);
  });

  it('mints a UUID when the trace context does not exist yet', async () => {
    const dir = featureDir();
    const record = await recordRouteDecision(dir, decision(), { now: NOW, mintId: () => 'uuid-1' });
    assert.equal(record?.decision_id, 'uuid-1');
    assert.equal(record?.trace_id, undefined);
  });
});

describe('recordRouteDecisionFromArtifact', () => {
  it('persists the embedded decision with its original id and timestamp', async () => {
    const dir = featureDir();
    writeTraceContext(dir, 'trace-0123');
    const embedded = buildRouteDecision(decision(), { mintId: () => 'batch-uuid', now: () => new Date('2026-09-28T09:00:00.000Z') });

    assert.equal(await recordRouteDecisionFromArtifact(dir, { ...decision(), routeDecision: embedded }), 'appended');
    assert.equal(await recordRouteDecisionFromArtifact(dir, { ...decision(), routeDecision: embedded }), 'duplicate');

    const [record] = await readRouteDecisions(dir);
    assert.equal(record.decision_id, 'batch-uuid');
    assert.equal(record.decided_at, '2026-09-28T09:00:00.000Z');
  });

  it('mints a decision for pre-HOK-3098 artifacts', async () => {
    const dir = featureDir();
    writeTraceContext(dir, 'trace-0123');
    assert.equal(await recordRouteDecisionFromArtifact(dir, decision()), 'appended');
    assert.equal((await readRouteDecisions(dir))[0].decision_id, 'trace-0123');
  });

  it('ignores artifacts without a route', async () => {
    const dir = featureDir();
    assert.equal(await recordRouteDecisionFromArtifact(dir, null), 'invalid');
    assert.equal(await recordRouteDecisionFromArtifact(dir, { planner: 'a' }), 'invalid');
    assert.deepEqual(await readRouteDecisions(dir), []);
  });
});

describe('inferFeatureDirFromTaskFile', () => {
  it('infers features/<slug> and bugs/<slug> packet parents only', () => {
    assert.equal(inferFeatureDirFromTaskFile('/repo/features/my-task/task-packet.md'), '/repo/features/my-task');
    assert.equal(inferFeatureDirFromTaskFile('features/my-task/selected-task.json'), 'features/my-task');
    assert.equal(inferFeatureDirFromTaskFile('/repo/bugs/my-bug/task-packet.md'), '/repo/bugs/my-bug');
    assert.equal(inferFeatureDirFromTaskFile('/tmp/session-HOK-1-taskpacket.md'), undefined);
    assert.equal(inferFeatureDirFromTaskFile('/repo/features/task-packet.md'), undefined);
    assert.equal(inferFeatureDirFromTaskFile(undefined), undefined);
  });
});
