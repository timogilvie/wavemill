import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_ATTRIBUTION_CONFIG,
  AttributionConfigError,
  aggregateAttribution,
  attributePullRequest,
  evaluateReportGates,
  extractExecutedRoute,
  legacyDetectorSignatures,
  resolveAttributionConfig,
  sampleForPrecisionAudit,
  summarizeRepoAttribution,
  type AttributionPrInput,
  type PrAttribution,
} from './pr-attribution.ts';

function makePr(overrides: Partial<AttributionPrInput> = {}): AttributionPrInput {
  return {
    number: 1,
    authorLogin: 'octocat',
    authorType: 'User',
    headRef: 'feature/change',
    labels: [],
    mergedAt: '2026-09-01T00:00:00Z',
    commitMessages: ['Human authored change'],
    body: null,
    headSha: null,
    ...overrides,
  };
}

function metaBody(lines: string[]): string {
  return `Summary of the change.\n\n<!-- wavemill-meta\n${lines.join('\n')}\n-->\n`;
}

const EXECUTED_ROUTE = JSON.stringify({
  head_sha: 'abc123',
  planner: { status: 'executed', model: 'claude-opus-5' },
  coder: { status: 'executed', model: 'claude-fable-5' },
  reviewer: { status: 'executed', model: 'gpt-5.5' },
});

describe('attributePullRequest - dimensions and precedence', () => {
  it('Copilot bot author + copilot branch: agent yes, harness strong, model unknown', () => {
    const result = attributePullRequest(
      makePr({
        authorLogin: 'copilot-swe-agent[bot]',
        authorType: 'Bot',
        headRef: 'copilot/fix-tests',
      }),
    );
    assert.equal(result.agent.status, 'agent');
    assert.equal(result.agent.confidence, 'strong');
    assert.deepEqual(result.signals.sort(), ['botAuthor', 'branchPrefix']);
    assert.equal(result.harness.status, 'identified');
    assert.equal(result.harness.value, 'github-copilot');
    assert.equal(result.harness.confidence, 'strong');
    assert.equal(result.model.status, 'unknown');
    assert.equal(result.model.value, undefined);
  });

  it('explicit model-version trailer identifies harness AND model (strong)', () => {
    const result = attributePullRequest(
      makePr({
        commitMessages: [
          'Fix the bug\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>',
        ],
      }),
    );
    assert.equal(result.agent.status, 'agent');
    assert.equal(result.harness.value, 'claude-code');
    assert.equal(result.harness.confidence, 'strong');
    assert.equal(result.model.status, 'identified');
    assert.equal(result.model.value, 'claude-fable-5');
    assert.equal(result.model.confidence, 'strong');
  });

  it('trailer naming only a product identifies a harness, never a model', () => {
    const result = attributePullRequest(
      makePr({ commitMessages: ['Change\n\nCo-authored-by: Copilot <copilot@github.com>'] }),
    );
    assert.equal(result.harness.value, 'github-copilot');
    assert.equal(result.model.status, 'unknown');
  });

  it('wavemill-meta block without route: harness wavemill (strong), model unknown', () => {
    const result = attributePullRequest(
      makePr({ body: metaBody(['schema-version: 1', 'task: HOK-1234']) }),
    );
    assert.deepEqual(result.signals, ['wavemillMeta']);
    assert.equal(result.harness.value, 'wavemill');
    assert.equal(result.harness.confidence, 'strong');
    assert.equal(result.model.status, 'unknown');
  });

  it('executed route at matching head SHA: harness + model verified, heuristics outranked but kept', () => {
    const result = attributePullRequest(
      makePr({
        body: metaBody(['route_schema: 1', `executed_route: ${EXECUTED_ROUTE}`]),
        headSha: 'abc123',
        commitMessages: ['Change\n\nCo-authored-by: Claude <noreply@anthropic.com>'],
      }),
    );
    assert.equal(result.harness.status, 'identified');
    assert.equal(result.harness.value, 'wavemill');
    assert.equal(result.harness.confidence, 'verified');
    assert.equal(result.model.status, 'identified');
    assert.equal(result.model.value, 'claude-fable-5'); // coder's resolved model
    assert.equal(result.model.confidence, 'verified');
    // The outranked claude-code trailer evidence stays in the harness evidence list.
    assert.ok(result.harness.evidence.some((item) => item.harnessId === 'claude-code'));
    assert.deepEqual(result.diagnostics, []);
  });

  it('verified route model outranks a conflicting trailer model; trailer kept in evidence', () => {
    const result = attributePullRequest(
      makePr({
        body: metaBody(['route_schema: 1', `executed_route: ${EXECUTED_ROUTE}`]),
        headSha: 'abc123',
        commitMessages: ['Change\n\nCo-authored-by: Claude Sonnet 5 <noreply@anthropic.com>'],
      }),
    );
    assert.equal(result.model.value, 'claude-fable-5');
    assert.equal(result.model.confidence, 'verified');
    assert.ok(result.model.evidence.some((item) => item.modelId === 'claude-sonnet-5'));
  });

  it('stale route head SHA: route discarded with diagnostic, harness still strong from wavemillMeta', () => {
    const result = attributePullRequest(
      makePr({
        body: metaBody(['route_schema: 1', `executed_route: ${EXECUTED_ROUTE}`]),
        headSha: 'def456',
      }),
    );
    assert.ok(result.diagnostics.some((item) => item.startsWith('stale-route-head:')));
    assert.ok(!result.signals.includes('executedRoute'));
    assert.equal(result.harness.value, 'wavemill');
    assert.equal(result.harness.confidence, 'strong');
    assert.equal(result.model.status, 'unknown');
  });

  it('roles with status inherited/not_run/unknown are never credited as execution', () => {
    const route = JSON.stringify({
      head_sha: 'abc123',
      planner: { status: 'inherited', model: 'claude-opus-5' },
      coder: { status: 'not_run', model: 'claude-fable-5' },
      reviewer: { status: 'unknown', model: 'gpt-5.5' },
    });
    const result = attributePullRequest(
      makePr({ body: metaBody(['route_schema: 1', `executed_route: ${route}`]), headSha: 'abc123' }),
    );
    assert.ok(!result.signals.includes('executedRoute'));
    assert.ok(
      result.diagnostics.some((item) => item.startsWith('executed-route-no-executed-roles:')),
    );
    assert.equal(result.model.status, 'unknown');
    assert.equal(result.harness.confidence, 'strong'); // wavemillMeta only
  });

  it('coder executed without a model: route credits harness but not model', () => {
    const route = JSON.stringify({
      head_sha: 'abc123',
      coder: { status: 'executed' },
    });
    const result = attributePullRequest(
      makePr({ body: metaBody(['route_schema: 1', `executed_route: ${route}`]), headSha: 'abc123' }),
    );
    assert.ok(result.signals.includes('executedRoute'));
    assert.equal(result.harness.confidence, 'verified');
    assert.equal(result.model.status, 'unknown');
  });

  it('two harnesses at the same tier: harness unknown, both evidence entries kept', () => {
    const result = attributePullRequest(
      makePr({
        commitMessages: [
          'Change\n\nCo-authored-by: Copilot <copilot@github.com>\nCo-authored-by: Claude <noreply@anthropic.com>',
        ],
      }),
    );
    assert.equal(result.harness.status, 'unknown');
    assert.equal(result.harness.evidence.length, 2);
    assert.ok(
      result.diagnostics.some((item) => item.startsWith('conflicting-harness-evidence:')),
    );
    // The PR is still agent-attributed despite the harness conflict.
    assert.equal(result.agent.status, 'agent');
  });

  it('weak branch evidence does not conflict with strong trailer evidence', () => {
    const result = attributePullRequest(
      makePr({
        headRef: 'codex/fix-thing',
        commitMessages: ['Change\n\nCo-authored-by: Claude <noreply@anthropic.com>'],
      }),
    );
    assert.equal(result.harness.status, 'identified');
    assert.equal(result.harness.value, 'claude-code');
    assert.equal(result.harness.evidence.length, 2);
  });

  it('zero signals: all three dimensions unknown, PR still scored, no human value anywhere', () => {
    const result = attributePullRequest(makePr());
    assert.deepEqual(result.signals, []);
    assert.equal(result.agent.status, 'unknown');
    assert.equal(result.harness.status, 'unknown');
    assert.equal(result.model.status, 'unknown');
    assert.ok(!JSON.stringify(result).includes('"human"'));
  });

  it('matchers are case-insensitive', () => {
    const result = attributePullRequest(
      makePr({
        authorLogin: 'COPILOT',
        headRef: 'Copilot/Fix-X',
        labels: ['AI-Generated'],
        commitMessages: ['change\n\nCO-AUTHORED-BY: CLAUDE FABLE 5 <noreply@anthropic.com>'],
      }),
    );
    // commitSignature also fires: the weak model-fragment scan sees the
    // model-version string inside the full commit message text.
    assert.deepEqual(
      result.signals.sort(),
      ['botAuthor', 'branchPrefix', 'coAuthoredBy', 'commitSignature', 'label'],
    );
    assert.equal(result.model.value, 'claude-fable-5');
  });

  it('generic branch prefixes and labels mark agent status without naming a harness', () => {
    const result = attributePullRequest(
      makePr({ headRef: 'ai-agent/refactor', labels: ['ai-generated'] }),
    );
    assert.equal(result.agent.status, 'agent');
    assert.equal(result.harness.status, 'unknown');
    assert.equal(result.harness.evidence.length, 0);
  });

  it('disabledSignals stops the corresponding evidence', () => {
    const config = resolveAttributionConfig({ disabledSignals: ['label', 'branchPrefix'] });
    const result = attributePullRequest(
      makePr({ headRef: 'copilot/fix', labels: ['ai-generated'] }),
      config,
    );
    assert.deepEqual(result.signals, []);
    assert.equal(result.agent.status, 'unknown');
  });

  it('config extraHarnesses and extraModelSignatures extend the vocabulary', () => {
    const config = resolveAttributionConfig({
      extraHarnesses: [
        { id: 'acme-bot', botLogins: ['acme-coder[bot]'], coAuthorFragments: ['acme coder'] },
      ],
      extraModelSignatures: [{ fragment: 'acme-large-9', modelId: 'acme-large-9' }],
    });
    const result = attributePullRequest(
      makePr({
        authorLogin: 'acme-coder[bot]',
        authorType: 'Bot',
        commitMessages: ['Change\n\nCo-authored-by: Acme Coder acme-large-9 <bot@acme.dev>'],
      }),
      config,
    );
    assert.equal(result.harness.value, 'acme-bot');
    assert.equal(result.model.value, 'acme-large-9');
  });

  it('flat extra* lists add agent-only evidence without naming a harness', () => {
    const config = resolveAttributionConfig({ extraBotLogins: ['internal-tool[bot]'] });
    const result = attributePullRequest(
      makePr({ authorLogin: 'internal-tool[bot]', authorType: 'Bot' }),
      config,
    );
    assert.equal(result.agent.status, 'agent');
    assert.equal(result.harness.status, 'unknown');
  });
});

describe('extractExecutedRoute - lenient HOK-2945 extraction', () => {
  it('extracts the route while tolerating unknown sibling fields', () => {
    const { route, diagnostics } = extractExecutedRoute(
      [
        'schema-version: 1',
        'task: HOK-1234',
        'some_future_field: hello',
        'route_schema: 1',
        `executed_route: ${EXECUTED_ROUTE}`,
      ].join('\n'),
    );
    assert.ok(route);
    assert.equal(route.headSha, 'abc123');
    assert.equal(route.roles.coder?.status, 'executed');
    assert.equal(route.roles.coder?.model, 'claude-fable-5');
    assert.deepEqual(diagnostics, []);
  });

  it('executed_route without route_schema is ignored with a diagnostic', () => {
    const { route, diagnostics } = extractExecutedRoute(`executed_route: ${EXECUTED_ROUTE}`);
    assert.equal(route, null);
    assert.ok(diagnostics.some((item) => item.startsWith('executed-route-missing-schema:')));
  });

  it('unsupported route_schema is ignored with a diagnostic', () => {
    const { route, diagnostics } = extractExecutedRoute(
      ['route_schema: 3', `executed_route: ${EXECUTED_ROUTE}`].join('\n'),
    );
    assert.equal(route, null);
    assert.ok(diagnostics.some((item) => item.startsWith('unsupported-route-schema:')));
  });

  it('malformed executed_route JSON never throws', () => {
    const { route, diagnostics } = extractExecutedRoute(
      ['route_schema: 1', 'executed_route: {not json'].join('\n'),
    );
    assert.equal(route, null);
    assert.ok(diagnostics.some((item) => item.startsWith('malformed-executed-route:')));
  });

  it('non-object executed_route JSON is rejected with a diagnostic', () => {
    const { route, diagnostics } = extractExecutedRoute(
      ['route_schema: 1', 'executed_route: [1,2,3]'].join('\n'),
    );
    assert.equal(route, null);
    assert.ok(diagnostics.some((item) => item.startsWith('malformed-executed-route:')));
  });

  it('accepts headSha and resolved_model field spellings', () => {
    const payload = JSON.stringify({
      headSha: 'fff999',
      coder: { status: 'executed', resolved_model: 'gpt-5.5' },
    });
    const { route } = extractExecutedRoute(
      ['route_schema: 1', `executed_route: ${payload}`].join('\n'),
    );
    assert.equal(route?.headSha, 'fff999');
    assert.equal(route?.roles.coder?.model, 'gpt-5.5');
  });

  it('with multiple wavemill-meta blocks the last block wins', () => {
    const body = `${metaBody(['route_schema: 1', `executed_route: ${EXECUTED_ROUTE}`])}\n${metaBody([
      'schema-version: 1',
    ])}`;
    const result = attributePullRequest(makePr({ body, headSha: 'abc123' }));
    assert.ok(!result.signals.includes('executedRoute'));
    assert.ok(result.signals.includes('wavemillMeta'));
  });
});

const ROUTE_DECISION = JSON.stringify({
  decision_id: 'trace-0123',
  source: 'hokusai',
  policy_version: 'model30-2026.09',
  recommended: { planner: 'claude-opus-5', coder: 'claude-haiku-5', reviewer: 'gpt-5.5' },
  decided_at: '2026-09-28T12:00:00.000Z',
});

describe('extractExecutedRoute - route_decision (HOK-3098)', () => {
  it('v1 block: executed route extracted, decision null', () => {
    const { route, decision, diagnostics } = extractExecutedRoute(
      ['route_schema: 1', `executed_route: ${EXECUTED_ROUTE}`].join('\n'),
    );
    assert.equal(route?.roles.coder?.model, 'claude-fable-5');
    assert.equal(decision, null);
    assert.deepEqual(diagnostics, []);
  });

  it('v2 block: executed route and route_decision both extracted', () => {
    const { route, decision, diagnostics } = extractExecutedRoute(
      [
        'schema-version: 1',
        'route_schema: 2',
        `executed_route: ${EXECUTED_ROUTE}`,
        `route_decision: ${ROUTE_DECISION}`,
        'some_future_field: ignored',
      ].join('\n'),
    );
    assert.equal(route?.roles.coder?.model, 'claude-fable-5');
    assert.deepEqual(decision, {
      decisionId: 'trace-0123',
      source: 'hokusai',
      policyVersion: 'model30-2026.09',
      recommended: { planner: 'claude-opus-5', coder: 'claude-haiku-5', reviewer: 'gpt-5.5' },
      decidedAt: '2026-09-28T12:00:00.000Z',
    });
    assert.deepEqual(diagnostics, []);
  });

  it('v2 block with a fallback re-route decision keeps the optional fields', () => {
    const payload = JSON.stringify({
      decision_id: '5b0e7c1e-7c55-4a55-9d6c-0d7a3f4b2e11',
      trace_id: 'trace-0123',
      source: 'fallback',
      fallback_reason: 'disabled_model',
      policy_version: 'wavemill-router@1.0.0',
      recommended: { planner: 'a', coder: 'b', reviewer: 'c' },
      decided_at: '2026-09-28T12:00:00.000Z',
      supersedes: 'trace-0123',
    });
    const { decision } = extractExecutedRoute(
      ['route_schema: 2', `executed_route: ${EXECUTED_ROUTE}`, `route_decision: ${payload}`].join('\n'),
    );
    assert.equal(decision?.traceId, 'trace-0123');
    assert.equal(decision?.fallbackReason, 'disabled_model');
    assert.equal(decision?.supersedes, 'trace-0123');
  });

  it('v2 block without route_decision: decision null, no diagnostic', () => {
    const { route, decision, diagnostics } = extractExecutedRoute(
      ['route_schema: 2', `executed_route: ${EXECUTED_ROUTE}`].join('\n'),
    );
    assert.ok(route);
    assert.equal(decision, null);
    assert.deepEqual(diagnostics, []);
  });

  it('route_decision on a v1 block is ignored with a schema-mismatch diagnostic', () => {
    const { route, decision, diagnostics } = extractExecutedRoute(
      ['route_schema: 1', `executed_route: ${EXECUTED_ROUTE}`, `route_decision: ${ROUTE_DECISION}`].join('\n'),
    );
    assert.ok(route);
    assert.equal(decision, null);
    assert.ok(diagnostics.some((item) => item.startsWith('route-decision-schema-mismatch:')));
  });

  it('malformed route_decision never throws and never hides the executed route', () => {
    for (const raw of ['{not json', '[1,2]', '{"source":"local"}']) {
      const { route, decision, diagnostics } = extractExecutedRoute(
        ['route_schema: 2', `executed_route: ${EXECUTED_ROUTE}`, `route_decision: ${raw}`].join('\n'),
      );
      assert.ok(route, raw);
      assert.equal(decision, null, raw);
      assert.ok(diagnostics.some((item) => item.startsWith('malformed-route-decision:')), raw);
    }
  });

  it('route_decision survives a malformed executed_route', () => {
    const { route, decision } = extractExecutedRoute(
      ['route_schema: 2', 'executed_route: {not json', `route_decision: ${ROUTE_DECISION}`].join('\n'),
    );
    assert.equal(route, null);
    assert.equal(decision?.decisionId, 'trace-0123');
  });

  it('attributePullRequest surfaces routeDecision without crediting recommended models', () => {
    const result = attributePullRequest(
      makePr({
        body: metaBody(['route_schema: 2', `executed_route: ${EXECUTED_ROUTE}`, `route_decision: ${ROUTE_DECISION}`]),
        headSha: 'abc123',
      }),
    );
    assert.equal(result.routeDecision?.decisionId, 'trace-0123');
    assert.equal(result.routeDecision?.recommended.coder, 'claude-haiku-5');
    // Identity comes from what ran, never from the recommendation.
    assert.equal(result.model.value, 'claude-fable-5');
  });

  it('attributePullRequest omits routeDecision for v1 PRs', () => {
    const result = attributePullRequest(
      makePr({ body: metaBody(['route_schema: 1', `executed_route: ${EXECUTED_ROUTE}`]), headSha: 'abc123' }),
    );
    assert.equal('routeDecision' in result, false);
    assert.equal(result.model.value, 'claude-fable-5');
  });
});

describe('evaluateReportGates - suppression at the floor boundary', () => {
  const eligible = { eligiblePrCount: 50 };

  it('coverage exactly at the 60.0 floor renders', () => {
    const gates = evaluateReportGates({
      ...eligible,
      modelCoveragePercent: 60.0,
      harnessCoveragePercent: 60.0,
    });
    assert.equal(gates.survivalByModel.render, true);
    assert.equal(gates.survivalByModel.reason, undefined);
    assert.equal(gates.survivalByHarness.render, true);
  });

  it('coverage 59.9 suppresses with an explicit reason carrying the coverage figure', () => {
    const gates = evaluateReportGates({
      ...eligible,
      modelCoveragePercent: 59.9,
      harnessCoveragePercent: 59.9,
    });
    assert.equal(gates.survivalByModel.render, false);
    assert.equal(gates.survivalByModel.coverage, 59.9);
    assert.match(gates.survivalByModel.reason ?? '', /59\.9% is below the 60% floor/);
  });

  it('gates are independent: harness can render while model is suppressed', () => {
    const gates = evaluateReportGates({
      ...eligible,
      modelCoveragePercent: 59.9,
      harnessCoveragePercent: 60.0,
    });
    assert.equal(gates.survivalByModel.render, false);
    assert.equal(gates.survivalByHarness.render, true);
  });

  it('19 eligible PRs suppresses both gates regardless of coverage; 20 is eligible', () => {
    const below = evaluateReportGates({
      eligiblePrCount: 19,
      modelCoveragePercent: 100,
      harnessCoveragePercent: 100,
    });
    assert.equal(below.survivalByModel.render, false);
    assert.match(below.survivalByModel.reason ?? '', /only 19 eligible PRs \(minimum 20\)/);
    assert.equal(below.survivalByHarness.render, false);

    const at = evaluateReportGates({
      eligiblePrCount: 20,
      modelCoveragePercent: 100,
      harnessCoveragePercent: 100,
    });
    assert.equal(at.survivalByModel.render, true);
    assert.equal(at.survivalByHarness.render, true);
  });

  it('a custom floor from config is honored', () => {
    const config = resolveAttributionConfig({ coverageFloorPercent: 40, minEligiblePrs: 5 });
    const gates = evaluateReportGates(
      { eligiblePrCount: 5, modelCoveragePercent: 40, harnessCoveragePercent: 39.9 },
      config,
    );
    assert.equal(gates.survivalByModel.render, true);
    assert.equal(gates.survivalByHarness.render, false);
  });
});

describe('summarizeRepoAttribution - coverage accounting', () => {
  const fablePr = (number: number): AttributionPrInput =>
    makePr({
      number,
      commitMessages: ['Change\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>'],
    });

  it('scores all PRs and keeps unattributed ones in the per-PR records', () => {
    const summary = summarizeRepoAttribution('acme/widgets', [
      makePr({ number: 1, authorLogin: 'copilot', authorType: 'Bot' }),
      makePr({ number: 2 }),
    ]);
    assert.equal(summary.sampledMergedPrs, 2);
    assert.equal(summary.pullRequests.length, 2);
    assert.equal(summary.unionCount, 1);
    assert.equal(summary.unattributedCount, 1);
    assert.equal(summary.unionCoveragePercent, 50);
    assert.equal(summary.pullRequests[1].agent.status, 'unknown');
  });

  it('a PR firing multiple signals counts once in the union but per signal in signal counts', () => {
    const summary = summarizeRepoAttribution('acme/widgets', [
      makePr({ number: 1, authorLogin: 'copilot', authorType: 'Bot', headRef: 'copilot/x' }),
    ]);
    assert.equal(summary.unionCount, 1);
    assert.equal(summary.signalCounts.botAuthor, 1);
    assert.equal(summary.signalCounts.branchPrefix, 1);
  });

  it('model coverage at exactly the floor renders survival-by-model (20+ PRs)', () => {
    const prs = [
      ...Array.from({ length: 15 }, (_, i) => fablePr(i + 1)),
      ...Array.from({ length: 10 }, (_, i) => makePr({ number: 100 + i })),
    ];
    const summary = summarizeRepoAttribution('acme/widgets', prs);
    assert.equal(summary.eligiblePrCount, 25);
    assert.equal(summary.eligibleForFeasibilityGate, true);
    assert.equal(summary.dimensions.model.coveragePercent, 60);
    assert.equal(summary.gates.survivalByModel.render, true);
  });

  it('below the floor both the coverage figure and the suppression reason are surfaced', () => {
    const prs = [
      ...Array.from({ length: 14 }, (_, i) => fablePr(i + 1)),
      ...Array.from({ length: 11 }, (_, i) => makePr({ number: 100 + i })),
    ];
    const summary = summarizeRepoAttribution('acme/widgets', prs);
    assert.equal(summary.dimensions.model.coveragePercent, 56);
    assert.equal(summary.gates.survivalByModel.render, false);
    assert.match(summary.gates.survivalByModel.reason ?? '', /56% is below the 60% floor/);
  });

  it('a repo with zero PRs yields 0% coverage without division errors and suppressed gates', () => {
    const summary = summarizeRepoAttribution('acme/empty', []);
    assert.equal(summary.unionCoveragePercent, 0);
    assert.equal(summary.dimensions.model.coveragePercent, 0);
    assert.equal(summary.eligibleForFeasibilityGate, false);
    assert.equal(summary.gates.survivalByModel.render, false);
    assert.ok(summary.gates.survivalByModel.reason);
  });

  it('tracks per-dimension confidence and value histograms', () => {
    const summary = summarizeRepoAttribution('acme/widgets', [
      fablePr(1),
      makePr({
        number: 2,
        body: metaBody(['route_schema: 1', `executed_route: ${EXECUTED_ROUTE}`]),
        headSha: 'abc123',
      }),
    ]);
    assert.equal(summary.dimensions.model.byConfidence.verified, 1);
    assert.equal(summary.dimensions.model.byConfidence.strong, 1);
    assert.deepEqual(summary.dimensions.harness.byValue, { 'claude-code': 1, wavemill: 1 });
  });
});

describe('aggregateAttribution - macro vs micro', () => {
  it('two repos (10 PRs @100%, 90 PRs @0%): macro 50.0, micro 10.0', () => {
    const attributed = Array.from({ length: 10 }, (_, i) =>
      makePr({ number: i + 1, authorLogin: 'copilot', authorType: 'Bot' }),
    );
    const unattributed = Array.from({ length: 90 }, (_, i) => makePr({ number: 1000 + i }));
    const summaries = [
      summarizeRepoAttribution('acme/small', attributed),
      summarizeRepoAttribution('acme/large', unattributed),
    ];
    const aggregate = aggregateAttribution(summaries);
    assert.equal(aggregate.repoCount, 2);
    assert.equal(aggregate.totalPrs, 100);
    assert.equal(aggregate.dimensionCoverage.agent.macroPercent, 50);
    assert.equal(aggregate.dimensionCoverage.agent.microPercent, 10);
    assert.equal(aggregate.unionCoverage.macroPercent, 50);
    assert.equal(aggregate.unionCoverage.microPercent, 10);
    assert.equal(aggregate.signalCoverage.botAuthor.macroPercent, 50);
    assert.equal(aggregate.signalCoverage.botAuthor.microPercent, 10);
  });

  it('feasibility gate pools over eligible repos only (>=20 eligible PRs)', () => {
    const attributed = Array.from({ length: 10 }, (_, i) =>
      makePr({ number: i + 1, authorLogin: 'copilot', authorType: 'Bot' }),
    );
    const unattributed = Array.from({ length: 90 }, (_, i) => makePr({ number: 1000 + i }));
    const aggregate = aggregateAttribution([
      summarizeRepoAttribution('acme/small', attributed), // 10 PRs: ineligible
      summarizeRepoAttribution('acme/large', unattributed), // 90 PRs: eligible, 0%
    ]);
    assert.equal(aggregate.eligibleRepoCount, 1);
    assert.equal(aggregate.gates.survivalByHarness.render, false);
    assert.equal(aggregate.gates.survivalByHarness.coverage, 0);
  });

  it('zero repos aggregates to zeros without errors', () => {
    const aggregate = aggregateAttribution([]);
    assert.equal(aggregate.repoCount, 0);
    assert.equal(aggregate.totalPrs, 0);
    assert.equal(aggregate.dimensionCoverage.model.macroPercent, 0);
    assert.equal(aggregate.gates.survivalByModel.render, false);
  });
});

describe('resolveAttributionConfig', () => {
  it('returns the defaults for an absent config', () => {
    assert.deepEqual(resolveAttributionConfig(undefined), DEFAULT_ATTRIBUTION_CONFIG);
    assert.deepEqual(resolveAttributionConfig(null), DEFAULT_ATTRIBUTION_CONFIG);
  });

  it('rejects unknown top-level keys with a typed error naming the field', () => {
    assert.throws(
      () => resolveAttributionConfig({ coverageFloor: 60 }),
      (err: unknown) =>
        err instanceof AttributionConfigError && err.field === 'coverageFloor',
    );
  });

  it('rejects malformed values with the offending field path', () => {
    assert.throws(
      () => resolveAttributionConfig({ coverageFloorPercent: 'sixty' }),
      (err: unknown) =>
        err instanceof AttributionConfigError && err.field === 'coverageFloorPercent',
    );
    assert.throws(
      () => resolveAttributionConfig({ extraModelSignatures: [{ fragment: '' }] }),
      (err: unknown) =>
        err instanceof AttributionConfigError &&
        err.field === 'extraModelSignatures[0].fragment',
    );
    assert.throws(
      () => resolveAttributionConfig({ disabledSignals: ['telepathy'] }),
      (err: unknown) =>
        err instanceof AttributionConfigError && err.field === 'disabledSignals',
    );
  });

  it('applies per-repo overrides only to the matching repo', () => {
    const raw = {
      extraBotLogins: ['everywhere[bot]'],
      repos: {
        'acme/widgets': { extraBotLogins: ['acme-only[bot]'], coverageFloorPercent: 40 },
      },
    };
    const widgets = resolveAttributionConfig(raw, 'acme/widgets');
    assert.deepEqual(widgets.extraBotLogins, ['everywhere[bot]', 'acme-only[bot]']);
    assert.equal(widgets.coverageFloorPercent, 40);

    const other = resolveAttributionConfig(raw, 'acme/gears');
    assert.deepEqual(other.extraBotLogins, ['everywhere[bot]']);
    assert.equal(other.coverageFloorPercent, 60);
  });

  it('validates every per-repo section eagerly, even for other repos', () => {
    assert.throws(
      () =>
        resolveAttributionConfig(
          { repos: { 'acme/other': { bogusKey: true } } },
          'acme/widgets',
        ),
      (err: unknown) =>
        err instanceof AttributionConfigError && err.field === 'repos.acme/other.bogusKey',
    );
  });
});

describe('legacyDetectorSignatures - golden parity with the frozen R4 lists', () => {
  it('reproduces the pre-refactor DETECTOR_SIGNATURES literals exactly, order included', () => {
    assert.deepEqual(legacyDetectorSignatures(), {
      botLogins: [
        'copilot',
        'copilot-swe-agent',
        'copilot-swe-agent[bot]',
        'github-copilot[bot]',
        'claude',
        'claude[bot]',
        'anthropic-code-agent[bot]',
        'cursor[bot]',
        'devin-ai-integration[bot]',
        'devin-ai[bot]',
        'openhands-agent[bot]',
        'sweep-ai[bot]',
        'codegen-sh[bot]',
        'codex[bot]',
        'openai-codex[bot]',
      ],
      coAuthorFragments: [
        'claude',
        'anthropic',
        'copilot',
        'codex',
        'openai',
        'cursor',
        'aider',
        'devin',
        'openhands',
        'sweep ai',
        'swe-agent',
        'codegen',
      ],
      branchPrefixes: [
        'codex/',
        'codex-',
        'copilot/',
        'copilot-',
        'cursor/',
        'cursor-',
        'claude/',
        'claude-',
        'aider/',
        'aider-',
        'devin/',
        'devin-',
        'openhands/',
        'openhands-',
        'swe-agent/',
        'swe-agent-',
        'ai-agent/',
        'agent/',
      ],
      labelNames: [
        'ai-generated',
        'ai generated',
        'ai-agent',
        'ai agent',
        'agent-authored',
        'agent authored',
        'copilot',
        'github copilot',
        'copilot-swe-agent',
        'codex',
        'openai codex',
        'claude',
        'claude code',
        'cursor',
        'aider',
        'devin',
        'openhands',
        'sweep ai',
        'codegen',
      ],
      commitSignatureFragments: [
        'generated with claude code',
        'generated by claude code',
        'generated with openai codex',
        'generated by openai codex',
        'generated by codex',
        'generated with codex',
        'generated with github copilot',
        'generated by github copilot',
        'copilot-swe-agent',
        'written by aider',
        'generated by aider',
        'devin ai',
        'openhands agent',
        'sweep ai',
        'codegen ai',
      ],
    });
  });
});

describe('sampleForPrecisionAudit', () => {
  const attributions = (): PrAttribution[] =>
    Array.from({ length: 30 }, (_, i) =>
      attributePullRequest(
        makePr(
          i % 2 === 0
            ? { number: i + 1, authorLogin: 'copilot', authorType: 'Bot' }
            : { number: i + 1 },
        ),
      ),
    );

  it('is deterministic for a fixed seed and samples only attributed PRs', () => {
    const first = sampleForPrecisionAudit(attributions(), 5, 7);
    const second = sampleForPrecisionAudit(attributions(), 5, 7);
    assert.deepEqual(
      first.map((pr) => pr.number),
      second.map((pr) => pr.number),
    );
    assert.equal(first.length, 5);
    assert.ok(first.every((pr) => pr.signals.length > 0));
    const numbers = first.map((pr) => pr.number);
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
  });

  it('caps at the attributed population and tolerates non-positive sizes', () => {
    const all = sampleForPrecisionAudit(attributions(), 100, 7);
    assert.equal(all.length, 15);
    assert.deepEqual(sampleForPrecisionAudit(attributions(), 0, 7), []);
    assert.deepEqual(sampleForPrecisionAudit(attributions(), -3, 7), []);
  });
});
