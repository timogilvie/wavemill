import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stampPrRoute, type StampPrRouteDeps } from './stamp-pr-route.ts';
import {
  EXECUTED_ROUTE_SCHEMA_VERSION,
  parsePrMetadata,
  PR_ROUTE_METADATA_SCHEMA_VERSION,
  renderPrMetadata,
  type ExecutedPrRoute,
  type PrRouteDecision,
} from '../shared/lib/pr-metadata.ts';
import type { PullRequest, PullRequestUpdateOptions } from '../shared/lib/github.ts';

const ROUTE: ExecutedPrRoute = {
  schema: EXECUTED_ROUTE_SCHEMA_VERSION,
  issue: 'HOK-2945',
  head_sha: 'abc123',
  planner: {
    status: 'executed',
    requested_selector: 'planner',
    resolved_model: 'planner',
    adapter: 'claude',
    source: 'artifact',
    pinned: true,
    evidence: { source: 'stage-result', status: 'direct', stage: 'planning', head_sha: 'abc123' },
  },
  coder: {
    status: 'executed',
    requested_selector: 'coder',
    resolved_model: 'coder',
    adapter: 'codex',
    source: 'artifact',
    pinned: true,
    evidence: { source: 'stage-result', status: 'direct', stage: 'coding', head_sha: 'abc123' },
  },
  reviewer: {
    status: 'executed',
    evidence: { source: 'native-runtime', status: 'direct', stage: 'review', head_sha: 'abc123' },
    orchestrator: {
      requested_selector: 'reviewer',
      resolved_model: 'reviewer',
      adapter: 'native',
      source: 'artifact',
      pinned: true,
    },
    substantiveAnalysis: {
      requested_selector: 'analysis',
      resolved_model: 'analysis',
      adapter: 'native',
      source: 'artifact',
      pinned: true,
    },
  },
};

function pr(body: string): PullRequest {
  return {
    number: 42,
    title: 'Test PR',
    body,
    state: 'OPEN',
    author: 'octocat',
    headRefName: 'task/test',
    headRefOid: 'abc123',
    baseRefName: 'main',
    labels: [],
    url: 'https://github.com/acme/widgets/pull/42',
    createdAt: '2026-09-15T00:00:00Z',
    updatedAt: '2026-09-15T00:00:00Z',
    mergedAt: null,
    closedAt: null,
  };
}

const DECISION: PrRouteDecision = {
  decision_id: 'trace-abc',
  source: 'hokusai',
  policy_version: 'model30-v7',
  recommended: { planner: 'planner', coder: 'cheap-coder', reviewer: 'reviewer' },
  decided_at: '2026-09-28T12:00:00.000Z',
};

function depsWithBody(
  initialBody: string,
  decision: PrRouteDecision | null = null,
): { deps: StampPrRouteDeps; updates: () => number; body: () => string } {
  let body = initialBody;
  let updateCount = 0;
  const deps: StampPrRouteDeps = {
    getPullRequest() {
      return pr(body);
    },
    updatePullRequest(_prNumber: string, options: PullRequestUpdateOptions) {
      updateCount += 1;
      body = options.body ?? body;
      return pr(body);
    },
    resolveOwnerRepo() {
      return 'acme/widgets';
    },
    async reconcile() {
      return { route: ROUTE, decision, diagnostics: [], complete: true };
    },
  };
  return { deps, updates: () => updateCount, body: () => body };
}

describe('stampPrRoute', () => {
  it('preserves prose and stamps route metadata', async () => {
    const fixture = depsWithBody(['## Summary', '', 'Human text.', '', '<!-- wavemill-meta', 'task: HOK-2945', '-->'].join('\n'));

    const result = await stampPrRoute(
      { prNumber: '42', issue: 'HOK-2945', featureDir: '/tmp/feature', repo: 'acme/widgets' },
      fixture.deps,
    );

    assert.equal(result.updated, true);
    assert.equal(fixture.updates(), 1);
    assert.match(fixture.body(), /Human text/);
    const parsed = parsePrMetadata(fixture.body());
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.deepEqual(parsed.metadata.executed_route, ROUTE);
      assert.equal(parsed.metadata.route_schema, PR_ROUTE_METADATA_SCHEMA_VERSION);
      assert.equal(parsed.metadata.route_decision, undefined);
    }
  });

  it('stamps route_decision alongside executed_route with route_schema 2', async () => {
    const fixture = depsWithBody('Body', DECISION);

    const result = await stampPrRoute({ prNumber: '42', issue: 'HOK-3098', featureDir: '/tmp/feature' }, fixture.deps);

    assert.equal(result.updated, true);
    assert.deepEqual(result.decision, DECISION);
    const parsed = parsePrMetadata(fixture.body());
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.metadata.route_schema, 2);
      assert.deepEqual(parsed.metadata.executed_route, ROUTE);
      assert.deepEqual(parsed.metadata.route_decision, DECISION);
    }
  });

  it('shows an escalated coder as recommended != executed', async () => {
    // The router recommended cheap-coder; the coding stage actually ran `coder`.
    const fixture = depsWithBody('Body', DECISION);
    await stampPrRoute({ prNumber: '42', issue: 'HOK-3098', featureDir: '/tmp/feature' }, fixture.deps);

    const parsed = parsePrMetadata(fixture.body());
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.metadata.route_decision?.recommended.coder, 'cheap-coder');
      assert.equal(parsed.metadata.executed_route?.coder.resolved_model, 'coder');
      assert.notEqual(
        parsed.metadata.route_decision?.recommended.coder,
        parsed.metadata.executed_route?.coder.resolved_model,
      );
    }
  });

  it('no-ops when the same decision is already stamped', async () => {
    const first = depsWithBody('Body', DECISION);
    await stampPrRoute({ prNumber: '42', issue: 'HOK-3098', featureDir: '/tmp/feature' }, first.deps);
    const second = depsWithBody(first.body(), DECISION);

    const result = await stampPrRoute({ prNumber: '42', issue: 'HOK-3098', featureDir: '/tmp/feature' }, second.deps);

    assert.equal(result.updated, false);
    assert.equal(second.updates(), 0);
  });

  it('carries the stamped decision forward when routing.jsonl has none', async () => {
    const first = depsWithBody('Body', DECISION);
    await stampPrRoute({ prNumber: '42', issue: 'HOK-3098', featureDir: '/tmp/feature' }, first.deps);
    const second = depsWithBody(first.body(), null);

    const result = await stampPrRoute({ prNumber: '42', issue: 'HOK-3098', featureDir: '/tmp/feature' }, second.deps);

    assert.equal(result.updated, false);
    assert.deepEqual(result.decision, DECISION);
  });

  it('replaces the stamped decision with a newer re-route decision', async () => {
    const first = depsWithBody('Body', DECISION);
    await stampPrRoute({ prNumber: '42', issue: 'HOK-3098', featureDir: '/tmp/feature' }, first.deps);
    const reroute: PrRouteDecision = {
      ...DECISION,
      decision_id: '5b0e7c1e-7c55-4a55-9d6c-0d7a3f4b2e11',
      trace_id: 'trace-abc',
      source: 'local',
      policy_version: 'wavemill-router@1.0.0',
      supersedes: 'trace-abc',
    };
    const second = depsWithBody(first.body(), reroute);

    const result = await stampPrRoute({ prNumber: '42', issue: 'HOK-3098', featureDir: '/tmp/feature' }, second.deps);

    assert.equal(result.updated, true);
    const parsed = parsePrMetadata(second.body());
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.deepEqual(parsed.metadata.route_decision, reroute);
    }
  });

  it('upgrades a v1 block to route_schema 2 on restamp', async () => {
    const v1Body = [
      'Body',
      '',
      '<!-- wavemill-meta',
      'route_schema: 1',
      `executed_route: ${JSON.stringify(ROUTE)}`,
      '-->',
    ].join('\n');
    assert.equal(parsePrMetadata(v1Body).ok, true);
    const fixture = depsWithBody(v1Body, DECISION);

    const result = await stampPrRoute({ prNumber: '42', issue: 'HOK-3098', featureDir: '/tmp/feature' }, fixture.deps);

    assert.equal(result.updated, true);
    const parsed = parsePrMetadata(fixture.body());
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.metadata.route_schema, 2);
      assert.deepEqual(parsed.metadata.route_decision, DECISION);
    }
  });

  it('a malformed stamped route_decision never blocks stamping', async () => {
    const valid = renderPrMetadata({ route_schema: 2, executed_route: ROUTE });
    const corrupted = `Body\n\n${valid.replace('-->', 'route_decision: {"decision_id":""}\n-->')}`;
    assert.equal(parsePrMetadata(corrupted).ok, false);
    const fixture = depsWithBody(corrupted, null);

    const result = await stampPrRoute({ prNumber: '42', issue: 'HOK-3098', featureDir: '/tmp/feature' }, fixture.deps);

    assert.equal(result.updated, true);
    assert.equal(result.decision, null);
    const parsed = parsePrMetadata(fixture.body());
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.metadata.route_decision, undefined);
      assert.deepEqual(parsed.metadata.executed_route, ROUTE);
    }
  });

  it('an unrenderable reconciled decision degrades to a diagnostic', async () => {
    const bad = { ...DECISION, recommended: { ...DECISION.recommended, coder: '/Users/someone/model' } };
    const fixture = depsWithBody('Body', bad);

    const result = await stampPrRoute({ prNumber: '42', issue: 'HOK-3098', featureDir: '/tmp/feature' }, fixture.deps);

    assert.equal(result.updated, true);
    assert.equal(result.decision, null);
    assert.ok(result.diagnostics.some((item) => item.startsWith('route_decision: omitted')));
    const parsed = parsePrMetadata(fixture.body());
    assert.equal(parsed.ok, true);
  });

  it('skips the update when the route is already present', async () => {
    const first = depsWithBody(['Body', '', '<!-- wavemill-meta', 'task: HOK-2945', '-->'].join('\n'));
    await stampPrRoute({ prNumber: '42', issue: 'HOK-2945', featureDir: '/tmp/feature' }, first.deps);
    const second = depsWithBody(first.body());

    const result = await stampPrRoute({ prNumber: '42', issue: 'HOK-2945', featureDir: '/tmp/feature' }, second.deps);

    assert.equal(result.updated, false);
    assert.equal(second.updates(), 0);
  });

  it('fails when complete evidence is required but missing', async () => {
    const fixture = depsWithBody('Body');
    const deps: StampPrRouteDeps = {
      ...fixture.deps,
      async reconcile() {
        return {
          route: { ...ROUTE, coder: { ...ROUTE.coder, status: 'unknown', evidence: { source: 'stage-result', reason: 'missing_execution_evidence' } } },
          decision: null,
          diagnostics: ['coder: missing_execution_evidence'],
          complete: false,
        };
      },
    };

    await assert.rejects(
      () => stampPrRoute({ prNumber: '42', issue: 'HOK-2945', featureDir: '/tmp/feature', requireComplete: true }, deps),
      /Route evidence incomplete/,
    );
    assert.equal(fixture.updates(), 0);
  });
});
