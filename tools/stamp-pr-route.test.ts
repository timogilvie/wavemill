import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stampPrRoute, type StampPrRouteDeps } from './stamp-pr-route.ts';
import { parsePrMetadata, PR_ROUTE_METADATA_SCHEMA_VERSION, type ExecutedPrRoute } from '../shared/lib/pr-metadata.ts';
import type { PullRequest, PullRequestUpdateOptions } from '../shared/lib/github.ts';

const ROUTE: ExecutedPrRoute = {
  schema: PR_ROUTE_METADATA_SCHEMA_VERSION,
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

function depsWithBody(initialBody: string): { deps: StampPrRouteDeps; updates: () => number; body: () => string } {
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
      return { route: ROUTE, diagnostics: [], complete: true };
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
    }
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
