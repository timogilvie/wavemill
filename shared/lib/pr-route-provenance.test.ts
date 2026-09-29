import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { reconcilePrRoute, type ReconcilePrRouteDeps } from './pr-route-provenance.ts';
import type { StageResult } from './stage-result.ts';

function depsFor(featureDir: string, files: Record<string, unknown>): ReconcilePrRouteDeps {
  const byPath = new Map<string, string>();
  for (const [name, value] of Object.entries(files)) {
    byPath.set(join(featureDir, name), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return {
    async readText(path: string): Promise<string | null> {
      return byPath.get(path) ?? null;
    },
  };
}

function stageResult(input: Partial<StageResult> & Pick<StageResult, 'stage' | 'agent' | 'model'>): StageResult {
  return {
    status: 'completed',
    startedAt: '2026-09-15T00:00:00.000Z',
    finishedAt: '2026-09-15T00:01:00.000Z',
    intendedModel: input.model,
    executedModel: input.model,
    executionEvidence: { status: 'direct', source: 'stage-result-cli' },
    modelAttributionEligible: true,
    notes: '',
    ...input,
  };
}

describe('reconcilePrRoute', () => {
  it('credits executed stage results instead of intended routing and preserves review sub-identities', async () => {
    const featureDir = '/workspace/features/hok-2945';
    const head = 'abc123';
    const result = await reconcilePrRoute(
      { issue: 'HOK-2945', featureDir, currentHeadSha: head },
      depsFor(featureDir, {
        '.planning-result.json': stageResult({
          stage: 'planning',
          agent: 'claude',
          model: 'planner-intended',
          intendedModel: 'planner-intended',
          executedModel: 'planner-executed',
          headSha: head,
        } as Partial<StageResult> & Pick<StageResult, 'stage' | 'agent' | 'model'>),
        '.coding-result.json': stageResult({
          stage: 'coding',
          agent: 'codex',
          model: 'coder-intended',
          intendedModel: 'coder-intended',
          executedModel: 'coder-executed',
          headSha: head,
        } as Partial<StageResult> & Pick<StageResult, 'stage' | 'agent' | 'model'>),
        '.review-result.json': stageResult({
          stage: 'review',
          agent: 'native',
          model: 'reviewer-orchestrator',
          headSha: head,
          artifacts: {
            type: 'review',
            reviewHeadSha: head,
            reviewExecutedIdentity: {
              orchestrator: {
                role: 'review_orchestrator',
                requestedModel: 'claude-haiku-4-5',
                resolvedModel: 'claude-haiku-4-5',
                agent: 'native',
                source: 'artifact',
                pinned: true,
              },
              substantiveAnalysis: {
                role: 'substantive_analysis',
                requestedModel: 'gemini',
                resolvedModel: 'google/gemini-2.5-pro',
                agent: 'openrouter',
                source: 'derived',
                pinned: true,
              },
            },
          },
        } as Partial<StageResult> & Pick<StageResult, 'stage' | 'agent' | 'model'>),
        'routing.jsonl': '{"route":{"planner":"planner-intended","coder":"coder-intended","reviewer":"reviewer-intended"}}\n',
      }),
    );

    assert.equal(result.complete, true);
    assert.equal(result.route.planner.status, 'executed');
    assert.equal(result.route.planner.resolved_model, 'planner-executed');
    assert.equal(result.route.planner.requested_selector, 'planner-intended');
    assert.equal(result.route.planner.pinned, false);
    assert.equal(result.route.coder.resolved_model, 'coder-executed');
    assert.equal(result.route.reviewer.status, 'executed');
    assert.equal(result.route.reviewer.orchestrator?.resolved_model, 'claude-haiku-4-5');
    assert.equal(result.route.reviewer.substantiveAnalysis?.resolved_model, 'google/gemini-2.5-pro');
    assert.equal(result.route.reviewer.substantiveAnalysis?.pinned, false);
  });

  it('reports stale stage evidence as unknown without substituting intent', async () => {
    const featureDir = '/workspace/features/hok-2945';
    const result = await reconcilePrRoute(
      { issue: 'HOK-2945', featureDir, currentHeadSha: 'new-head' },
      depsFor(featureDir, {
        '.coding-result.json': stageResult({
          stage: 'coding',
          agent: 'codex',
          model: 'intended-coder',
          intendedModel: 'intended-coder',
          executedModel: 'executed-coder',
          headSha: 'old-head',
        } as Partial<StageResult> & Pick<StageResult, 'stage' | 'agent' | 'model'>),
      }),
    );

    assert.equal(result.complete, false);
    assert.equal(result.route.coder.status, 'unknown');
    assert.equal(result.route.coder.resolved_model, undefined);
    assert.equal(result.route.coder.evidence.reason, 'stage_result_stale_head');
  });

  describe('route decisions (HOK-3098)', () => {
    const featureDir = '/workspace/features/hok-3098';
    const head = 'abc123';
    const firstDecision = {
      kind: 'route_decision',
      schema: 1,
      decision_id: 'trace-0123',
      source: 'hokusai',
      policy_version: 'model30-2026.09',
      recommended: { planner: 'planner-a', coder: 'cheap-coder', reviewer: 'reviewer-a' },
      decided_at: '2026-09-28T12:00:00.000Z',
    };
    const reroute = {
      kind: 'route_decision',
      schema: 1,
      decision_id: '5b0e7c1e-7c55-4a55-9d6c-0d7a3f4b2e11',
      trace_id: 'trace-0123',
      source: 'fallback',
      fallback_reason: 'null_response',
      policy_version: 'wavemill-router@1.0.0',
      recommended: { planner: 'planner-b', coder: 'coder-b', reviewer: 'reviewer-b' },
      decided_at: '2026-09-28T12:30:00.000Z',
      supersedes: 'trace-0123',
    };
    const phaseLine = JSON.stringify({ role: 'coder', requestedSelector: 'coder-requested', resolvedModelId: 'coder-requested' });
    const legacyRouteLine = JSON.stringify({ route: { planner: 'planner-intended', coder: 'coder-intended', reviewer: 'reviewer-intended' } });
    const coding = stageResult({
      stage: 'coding',
      agent: 'codex',
      model: 'strong-coder',
      headSha: head,
    } as Partial<StageResult> & Pick<StageResult, 'stage' | 'agent' | 'model'>);

    it('returns the recorded decision and projects it without routing.jsonl-only fields', async () => {
      const result = await reconcilePrRoute(
        { issue: 'HOK-3098', featureDir, currentHeadSha: head },
        depsFor(featureDir, {
          'routing.jsonl': `${phaseLine}\n${JSON.stringify(firstDecision)}\n`,
          '.coding-result.json': coding,
        }),
      );
      const { kind: _kind, schema: _schema, ...expected } = firstDecision;
      assert.deepEqual(result.decision, expected);
      assert.ok(!result.diagnostics.includes('route_decision: no route decision recorded'));
    });

    it('recommended coder differs from the executed coder after escalation', async () => {
      const result = await reconcilePrRoute(
        { issue: 'HOK-3098', featureDir, currentHeadSha: head },
        depsFor(featureDir, {
          'routing.jsonl': `${JSON.stringify(firstDecision)}\n`,
          '.coding-result.json': coding,
        }),
      );
      assert.equal(result.decision?.recommended.coder, 'cheap-coder');
      assert.equal(result.route.coder.resolved_model, 'strong-coder');
    });

    it('a genuine re-route yields the latest decision with supersedes', async () => {
      const result = await reconcilePrRoute(
        { issue: 'HOK-3098', featureDir, currentHeadSha: head },
        depsFor(featureDir, {
          'routing.jsonl': [JSON.stringify(firstDecision), phaseLine, JSON.stringify(reroute), ''].join('\n'),
        }),
      );
      assert.equal(result.decision?.decision_id, reroute.decision_id);
      assert.equal(result.decision?.supersedes, 'trace-0123');
      assert.equal(result.decision?.fallback_reason, 'null_response');
    });

    it('decision lines never leak into requested selectors; legacy lines still do', async () => {
      const result = await reconcilePrRoute(
        { issue: 'HOK-3098', featureDir, currentHeadSha: head },
        depsFor(featureDir, {
          'routing.jsonl': [legacyRouteLine, JSON.stringify({ ...firstDecision, planner: 'leak', coder: 'leak' }), ''].join('\n'),
        }),
      );
      assert.equal(result.route.planner.requested_selector, 'planner-intended');
      assert.equal(result.route.coder.requested_selector, 'coder-intended');
    });

    it('old routing.jsonl files without decisions yield a null decision and a diagnostic', async () => {
      const result = await reconcilePrRoute(
        { issue: 'HOK-3098', featureDir, currentHeadSha: head },
        depsFor(featureDir, { 'routing.jsonl': `${legacyRouteLine}\n${phaseLine}\n` }),
      );
      assert.equal(result.decision, null);
      assert.ok(result.diagnostics.includes('route_decision: no route decision recorded'));
    });

    it('invalid decision lines are skipped, never published', async () => {
      const unsafe = { ...reroute, recommended: { ...reroute.recommended, coder: '/Users/me/model' } };
      const result = await reconcilePrRoute(
        { issue: 'HOK-3098', featureDir, currentHeadSha: head },
        depsFor(featureDir, {
          'routing.jsonl': [JSON.stringify(firstDecision), JSON.stringify(unsafe), '{broken', ''].join('\n'),
        }),
      );
      assert.equal(result.decision?.decision_id, 'trace-0123');
    });
  });
});
