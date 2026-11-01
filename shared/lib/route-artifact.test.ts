import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { clearConfigCache } from './config.ts';
import {
  buildRoutePrediction,
  buildRouteLifecycleProvenance,
  deriveRouteDecisionSource,
  formatRouteArtifactSignature,
  POLICY_RESOLVER_VERSION,
  ROUTE_ARTIFACT_SCHEMA_VERSION,
  buildRouteProvenance,
  hasValidPostExpansionRoute,
  readBothRouteArtifacts,
  readRouteLifecycleArtifacts,
  resolveRouterPolicyVersion,
  resolveRouteDecisionBudget,
  routeChangedMaterially,
  stringifyRouteArtifact,
  validateExpandedRouteArtifact,
  withResolvedRouteBudget,
  writeRouteArtifact,
  appendRouteOverrideToFeatureDir,
  routeRecordCarrier,
} from './route-artifact.ts';
import type { WorkflowRouteDecision } from './workflow-router.ts';

function minimalDecision(overrides: Partial<WorkflowRouteDecision> = {}): WorkflowRouteDecision {
  return {
    planner: 'claude-sonnet-5',
    coder: 'gpt-5.4',
    reviewer: 'claude-sonnet-5',
    planDepth: 'light',
    codeDepth: 'medium',
    reviewRecommended: 'static',
    expectedSuccess: 0.8,
    expectedCostPlan: 0.1,
    expectedCostCode: 0.2,
    expectedCostReview: 0.1,
    confidence: 0.7,
    reasoning: [],
    signals: {
      taskType: 'feature',
      promptLength: 'medium',
      complexityScore: 0.5,
      fileTypes: [],
      riskScore: 0.2,
    },
    ...overrides,
  };
}

test('same input bytes produce same sha256', () => {
  const a = buildRouteProvenance({
    source: 'expanded',
    inputKind: 'task-packet',
    inputPath: 'features/a/task-packet.md',
    inputBytes: 'same bytes',
    routerMode: 'normal',
    routedAt: '2026-04-30T00:00:00.000Z',
  });
  const b = buildRouteProvenance({
    source: 'expanded',
    inputKind: 'task-packet',
    inputPath: 'features/a/task-packet.md',
    inputBytes: 'same bytes',
    routerMode: 'normal',
    routedAt: '2026-04-30T00:00:00.000Z',
  });
  assert.equal(a.inputHash, b.inputHash);
});

test('changed input bytes produce different hash', () => {
  const a = buildRouteProvenance({
    source: 'expanded',
    inputKind: 'task-packet',
    inputBytes: 'a',
    routerMode: 'normal',
  });
  const b = buildRouteProvenance({
    source: 'expanded',
    inputKind: 'task-packet',
    inputBytes: 'b',
    routerMode: 'normal',
  });
  assert.notEqual(a.inputHash, b.inputHash);
});

test('sha256 of hello matches known digest', () => {
  const item = buildRouteProvenance({
    source: 'live',
    inputKind: 'issue',
    inputBytes: 'hello',
    routerMode: 'normal',
  });
  assert.equal(item.inputHash, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

test('routedAt is iso-8601 utc by default', () => {
  const item = buildRouteProvenance({
    source: 'live',
    inputKind: 'issue',
    inputBytes: 'hello',
    routerMode: 'normal',
  });
  assert.match(item.routedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('route artifact metadata constants are stable', () => {
  assert.equal(ROUTE_ARTIFACT_SCHEMA_VERSION, '1.2');
  assert.equal(POLICY_RESOLVER_VERSION, '1.0.0');
});

test('resolveRouterPolicyVersion maps live router modes and provenance', () => {
  assert.equal(resolveRouterPolicyVersion({ routingMode: 'hokusai' }), 'hokusai');
  assert.equal(resolveRouterPolicyVersion({ routingMode: 'policy' }), 'policy');
  assert.equal(resolveRouterPolicyVersion({ routingMode: 'stage-aware' }), 'stage-aware');
  assert.equal(resolveRouterPolicyVersion({ routingMode: 'stage-aware-partial' }), 'stage-aware');
  assert.equal(resolveRouterPolicyVersion({ routingMode: 'heuristic-fallback' }), 'heuristic-fallback');
  assert.equal(resolveRouterPolicyVersion({ source: 'heuristic-fallback' }), 'heuristic-fallback');
  assert.equal(resolveRouterPolicyVersion({ routingMode: 'heuristic' }), 'heuristic');
  assert.equal(resolveRouterPolicyVersion({ source: 'expanded' }), 'expanded-route');
  assert.equal(resolveRouterPolicyVersion({ inputKind: 'task-packet' }), 'expanded-route');
  assert.equal(resolveRouterPolicyVersion({}), 'baseline');
});

test('heuristic fallback convention uses empty hash/path without input', () => {
  const item = buildRouteProvenance({
    source: 'heuristic-fallback',
    inputKind: 'issue',
    inputPath: '/tmp/input.txt',
    routerMode: 'survival',
  });
  assert.equal(item.inputKind, 'heuristic');
  assert.equal(item.inputPath, '');
  assert.equal(item.inputHash, '');
});

test('validateExpandedRouteArtifact accepts execution fields', () => {
  const result = validateExpandedRouteArtifact({
    coder: 'gpt-5.4',
    codeDepth: 'deep',
    reviewer: 'claude-sonnet-5',
    reviewMode: 'static+llm',
    harnessId: 'a'.repeat(64),
    cache_hit: true,
    route_source: 'batch',
    packet_hash: 'a'.repeat(64),
    extra: true,
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.invalid, []);
  assert.deepEqual(result.normalized, {
    coder: 'gpt-5.4',
    codeDepth: 'deep',
    reviewer: 'claude-sonnet-5',
    reviewMode: 'static+llm',
  });
});

test('validateExpandedRouteArtifact falls back from reviewRecommended', () => {
  const result = validateExpandedRouteArtifact({
    coder: 'gpt-5.4',
    codeDepth: 'medium',
    reviewer: 'claude-sonnet-5',
    reviewRecommended: 'llm',
  });

  assert.equal(result.valid, true);
  assert.equal(result.normalized?.reviewMode, 'llm');
});

test('validateExpandedRouteArtifact reports missing required fields', () => {
  const result = validateExpandedRouteArtifact({
    coder: 'gpt-5.4',
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.missing.sort(), ['codeDepth', 'reviewMode', 'reviewer']);
  assert.deepEqual(result.invalid, []);
});

test('validateExpandedRouteArtifact rejects non-object values', () => {
  const result = validateExpandedRouteArtifact(null);

  assert.equal(result.valid, false);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.invalid, ['artifact']);
});

test('validateExpandedRouteArtifact rejects blank execution fields', () => {
  const result = validateExpandedRouteArtifact({
    coder: '',
    codeDepth: 'medium',
    reviewer: 'claude-sonnet-5',
    reviewMode: 'static',
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.invalid, ['coder']);
});

test('validateExpandedRouteArtifact rejects malformed optional metadata', () => {
  const result = validateExpandedRouteArtifact({
    coder: 'gpt-5.4',
    codeDepth: 'deep',
    reviewer: 'claude-sonnet-5',
    reviewMode: 'static+llm',
    cache_hit: 'yes',
    harnessId: 'abc',
    route_source: 'live',
    packet_hash: 'abc123',
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.invalid.sort(), ['cache_hit', 'harnessId', 'packet_hash', 'route_source']);
});

test('buildRoutePrediction extracts compact prediction contract', () => {
  const prediction = buildRoutePrediction(minimalDecision({
    expectedCostPlan: 0.11,
    expectedCostCode: 0.22,
    expectedCostReview: 0.33,
    reasoning: [
      'High repo-surface risk.',
      'Feature work benefits from balanced route.',
    ],
    signals: {
      taskType: 'feature',
      promptLength: 'medium',
      complexityScore: 0.7,
      fileTypes: ['ts'],
      riskScore: 0.4,
      taskDifficulty: 'medium',
    },
  }));

  assert.deepEqual(prediction, {
    expectedSuccess: 0.8,
    expectedCostUsd: 0.66,
    confidence: 0.7,
    riskScore: 0.4,
    taskType: 'feature',
    taskDifficulty: 'medium',
    topFeatures: [
      'High repo-surface risk.',
      'Feature work benefits from balanced route.',
      'taskType=feature',
      'taskDifficulty=medium',
      'complexityScore=0.7',
    ],
    rationaleSummary: 'High repo-surface risk. Feature work benefits from balanced route.',
  });
});

test('stringifyRouteArtifact returns strict JSON with trailing newline', () => {
  const output = stringifyRouteArtifact({ coder: 'gpt-5.4', nested: { ok: true } });

  assert.match(output, /^\{/);
  assert.match(output, /\n$/);
  assert.doesNotThrow(() => JSON.parse(output));
});

test('writeRouteArtifact writes strict JSON bytes parseable as-is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-artifact-'));
  try {
    const target = join(dir, '.routing-complete');
    writeRouteArtifact(target, { coder: 'gpt-5.4', reviewMode: 'llm' });

    const written = readFileSync(target, 'utf-8');
    assert.equal(written.trimStart().startsWith('{'), true);
    assert.doesNotThrow(() => JSON.parse(written));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeRouteArtifact rejects non-serializable top-level payloads', () => {
  assert.throws(() => writeRouteArtifact(join(tmpdir(), 'unused.json'), undefined), /serialize to a JSON document/);
});

test('resolveRouteDecisionBudget preserves explicit zero over defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-artifact-budget-'));
  try {
    writeFileSync(join(dir, '.wavemill-config.json'), JSON.stringify({
      mill: { defaultMaxCostUsd: 25 },
    }));
    clearConfigCache(dir);
    assert.equal(
      resolveRouteDecisionBudget(minimalDecision({ constraints: { maxCostUsd: 4 } }), {
        explicitMaxCostUsd: 0,
        repoDir: dir,
      }),
      0,
    );
  } finally {
    clearConfigCache(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withResolvedRouteBudget writes constraints and top-level budget from config default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-artifact-budget-'));
  try {
    writeFileSync(join(dir, '.wavemill-config.json'), JSON.stringify({
      mill: { defaultMaxCostUsd: 12.5 },
    }));
    clearConfigCache(dir);

    const decision = withResolvedRouteBudget(minimalDecision(), { repoDir: dir });

    assert.equal(decision.maxCostUsd, 12.5);
    assert.equal(decision.constraints?.maxCostUsd, 12.5);
  } finally {
    clearConfigCache(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withResolvedRouteBudget writes top-level null when no budget is available', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-artifact-budget-'));
  try {
    writeFileSync(join(dir, '.wavemill-config.json'), JSON.stringify({ router: { enabled: false } }));
    clearConfigCache(dir);

    const decision = withResolvedRouteBudget(minimalDecision(), { repoDir: dir });

    assert.equal(decision.maxCostUsd, null);
    assert.equal(decision.constraints, undefined);
  } finally {
    clearConfigCache(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeFeatureDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'route-artifact-'));
  const featureDir = join(root, 'features', 'demo');
  mkdirSync(featureDir, { recursive: true });
  return featureDir;
}

test('readBothRouteArtifacts returns both snapshots when present', () => {
  const featureDir = makeFeatureDir();
  writeFileSync(join(featureDir, '.initial-route.json'), JSON.stringify({
    planner: 'gpt-5.4',
    coder: 'claude-sonnet-5',
    reviewer: 'claude-opus-4-6',
    planDepth: 'deep',
    codeDepth: 'medium',
    reviewMode: 'llm',
  }));
  writeFileSync(join(featureDir, '.post-expansion-route.json'), JSON.stringify({
    coder: 'gpt-5.4',
    reviewer: 'claude-sonnet-4-5-20250929',
    codeDepth: 'deep',
    reviewMode: 'static+llm',
  }));

  const result = readBothRouteArtifacts(featureDir);
  assert.equal(result.bootstrap?.artifactPath?.endsWith('/features/demo/.initial-route.json'), true);
  assert.match(result.bootstrap?.artifactHash ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(result.bootstrap && {
    planner: 'gpt-5.4',
    coder: 'claude-sonnet-5',
    reviewer: 'claude-opus-4-6',
    planDepth: 'deep',
    codeDepth: 'medium',
    reviewMode: 'llm',
    cache_hit: undefined,
    route_source: undefined,
    packet_hash: undefined,
  }, {
    planner: 'gpt-5.4',
    coder: 'claude-sonnet-5',
    reviewer: 'claude-opus-4-6',
    planDepth: 'deep',
    codeDepth: 'medium',
    reviewMode: 'llm',
    cache_hit: undefined,
    route_source: undefined,
    packet_hash: undefined,
  });
  assert.equal(result.expanded?.artifactPath?.endsWith('/features/demo/.post-expansion-route.json'), true);
  assert.match(result.expanded?.artifactHash ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(result.expanded && {
    coder: 'gpt-5.4',
    reviewer: 'claude-sonnet-4-5-20250929',
    codeDepth: 'deep',
    reviewMode: 'static+llm',
    planDepth: undefined,
    planner: undefined,
    cache_hit: undefined,
    route_source: undefined,
    packet_hash: undefined,
  }, {
    coder: 'gpt-5.4',
    reviewer: 'claude-sonnet-4-5-20250929',
    codeDepth: 'deep',
    reviewMode: 'static+llm',
    planDepth: undefined,
    planner: undefined,
    cache_hit: undefined,
    route_source: undefined,
    packet_hash: undefined,
  });
});

test('readBothRouteArtifacts exposes expanded route as authoritative when snapshots conflict', () => {
  const featureDir = makeFeatureDir();
  writeFileSync(join(featureDir, '.initial-route.json'), JSON.stringify({
    coder: 'bootstrap-coder',
    reviewer: 'bootstrap-reviewer',
    codeDepth: 'shallow',
    reviewMode: 'static',
  }));
  writeFileSync(join(featureDir, '.post-expansion-route.json'), JSON.stringify({
    coder: 'expanded-coder',
    reviewer: 'expanded-reviewer',
    codeDepth: 'deep',
    reviewMode: 'static+llm',
  }));

  const result = readBothRouteArtifacts(featureDir);
  assert.equal(result.bootstrap?.coder, 'bootstrap-coder');
  assert.equal(result.bootstrap?.codeDepth, 'shallow');
  assert.equal(result.expanded?.coder, 'expanded-coder');
  assert.equal(result.expanded?.codeDepth, 'deep');
  assert.notEqual(result.bootstrap?.coder, result.expanded?.coder);
});

test('readBothRouteArtifacts returns null for missing sides independently', () => {
  const featureDir = makeFeatureDir();
  writeFileSync(join(featureDir, '.initial-route.json'), JSON.stringify({
    coder: 'claude-sonnet-5',
    reviewer: 'claude-opus-4-6',
    codeDepth: 'medium',
    reviewMode: 'llm',
  }));

  const result = readBothRouteArtifacts(featureDir);
  assert.equal(result.bootstrap?.coder, 'claude-sonnet-5');
  assert.equal(result.expanded, null);
});

test('readBothRouteArtifacts normalizes expanded reviewRecommended to reviewMode', () => {
  const featureDir = makeFeatureDir();
  writeFileSync(join(featureDir, '.post-expansion-route.json'), JSON.stringify({
    coder: 'gpt-5.4',
    reviewer: 'claude-sonnet-5',
    codeDepth: 'deep',
    reviewRecommended: 'static+llm',
  }));

  const result = readBothRouteArtifacts(featureDir);
  assert.equal(result.expanded?.reviewMode, 'static+llm');
});

test('readBothRouteArtifacts reads expanded-only artifacts', () => {
  const featureDir = makeFeatureDir();
  writeFileSync(join(featureDir, '.post-expansion-route.json'), JSON.stringify({
    coder: 'gpt-5.4',
    reviewer: 'claude-opus-4-6',
    codeDepth: 'deep',
    reviewRecommended: 'static',
    cache_hit: true,
    route_source: 'cache',
    packet_hash: 'a'.repeat(64),
  }));

  const result = readBothRouteArtifacts(featureDir);
  assert.equal(result.bootstrap, null);
  assert.equal(result.expanded?.artifactPath?.endsWith('/features/demo/.post-expansion-route.json'), true);
  assert.match(result.expanded?.artifactHash ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(result.expanded && {
    coder: 'gpt-5.4',
    reviewer: 'claude-opus-4-6',
    codeDepth: 'deep',
    reviewMode: 'static',
    planDepth: undefined,
    planner: undefined,
    cache_hit: true,
    route_source: 'cache',
    packet_hash: 'a'.repeat(64),
  }, {
    coder: 'gpt-5.4',
    reviewer: 'claude-opus-4-6',
    codeDepth: 'deep',
    reviewMode: 'static',
    planDepth: undefined,
    planner: undefined,
    cache_hit: true,
    route_source: 'cache',
    packet_hash: 'a'.repeat(64),
  });
});

test('readBothRouteArtifacts returns null for malformed artifacts without throwing', () => {
  const featureDir = makeFeatureDir();
  writeFileSync(join(featureDir, '.initial-route.json'), '{');
  writeFileSync(join(featureDir, '.post-expansion-route.json'), JSON.stringify({
    coder: '',
    reviewer: 'claude-opus-4-6',
    codeDepth: 'deep',
    reviewMode: 'static',
  }));

  const result = readBothRouteArtifacts(featureDir);
  assert.equal(result.bootstrap, null);
  assert.equal(result.expanded, null);
});

test('readBothRouteArtifacts ignores malformed expanded snapshot while keeping bootstrap snapshot', () => {
  const featureDir = makeFeatureDir();
  writeFileSync(join(featureDir, '.initial-route.json'), JSON.stringify({
    coder: 'bootstrap-coder',
    reviewer: 'bootstrap-reviewer',
    codeDepth: 'medium',
    reviewMode: 'static',
  }));
  writeFileSync(join(featureDir, '.post-expansion-route.json'), '{');

  const result = readBothRouteArtifacts(featureDir);
  assert.equal(result.bootstrap?.coder, 'bootstrap-coder');
  assert.equal(result.expanded, null);
});

test('readBothRouteArtifacts keeps normalized expanded fields and includes provenance metadata', () => {
  const featureDir = makeFeatureDir();
  writeFileSync(join(featureDir, '.post-expansion-route.json'), JSON.stringify({
    planner: 'expanded-planner',
    coder: 'gpt-5.4',
    reviewer: 'claude-sonnet-5',
    planDepth: 'deep',
    codeDepth: 'deep',
    reviewMode: 'static+llm',
    cache_hit: true,
    route_source: 'batch',
    packet_hash: 'b'.repeat(64),
    provenance: { source: 'expanded', inputHash: 'ignored-in-snapshot' },
  }));

  const result = readBothRouteArtifacts(featureDir);
  assert.equal(result.expanded?.artifactPath?.endsWith('/features/demo/.post-expansion-route.json'), true);
  assert.match(result.expanded?.artifactHash ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(result.expanded && {
    planner: 'expanded-planner',
    coder: 'gpt-5.4',
    reviewer: 'claude-sonnet-5',
    planDepth: 'deep',
    codeDepth: 'deep',
    reviewMode: 'static+llm',
    cache_hit: true,
    route_source: 'batch',
    packet_hash: 'b'.repeat(64),
    inputHash: 'ignored-in-snapshot',
    source: 'expanded',
    routerMode: undefined,
    routingMode: undefined,
  }, {
    planner: 'expanded-planner',
    coder: 'gpt-5.4',
    reviewer: 'claude-sonnet-5',
    planDepth: 'deep',
    codeDepth: 'deep',
    reviewMode: 'static+llm',
    cache_hit: true,
    route_source: 'batch',
    packet_hash: 'b'.repeat(64),
    inputHash: 'ignored-in-snapshot',
    source: 'expanded',
    routerMode: undefined,
    routingMode: undefined,
  });
});

test('formatRouteArtifactSignature renders compact operator-facing route ids', () => {
  assert.equal(
    formatRouteArtifactSignature({
      coder: 'gpt-5.4',
      codeDepth: 'deep',
      reviewer: 'claude-sonnet-5',
      reviewMode: 'static+llm',
    }),
    'coder=gpt-5.4,codeDepth=deep,reviewer=claude-sonnet-5,reviewMode=static+llm',
  );
});

test('routeChangedMaterially tracks coder/reviewer class and depth changes', () => {
  const result = routeChangedMaterially(
    {
      coder: 'claude-sonnet-5',
      codeDepth: 'medium',
      reviewer: 'claude-opus-4-6',
      reviewMode: 'llm',
    },
    {
      coder: 'gpt-5.4',
      codeDepth: 'deep',
      reviewer: 'claude-sonnet-5',
      reviewMode: 'llm',
    },
  );

  assert.equal(result.changed, true);
  assert.deepEqual(result.reasons.sort(), ['code_depth', 'coder_class', 'reviewer_class']);
});

test('routeChangedMaterially tracks planner-only expanded route changes', () => {
  const result = routeChangedMaterially(
    {
      planner: 'claude-haiku-4-5',
      coder: 'gpt-5.4',
      reviewer: 'claude-sonnet-5',
      planDepth: 'light',
      codeDepth: 'medium',
      reviewMode: 'static',
    },
    {
      planner: 'claude-opus-4-7',
      coder: 'gpt-5.4',
      reviewer: 'claude-sonnet-5',
      planDepth: 'deep',
      codeDepth: 'medium',
      reviewMode: 'static',
    },
  );

  assert.equal(result.changed, true);
  assert.deepEqual(result.reasons.sort(), ['plan_depth', 'planner_class']);
});

test('readRouteLifecycleArtifacts falls back to archived bootstrap and active route files', () => {
  const featureDir = makeFeatureDir();
  const archiveDir = join(dirname(featureDir), 'archive');
  mkdirSync(archiveDir, { recursive: true });

  // HOK-2891: archive keeps the live basename.
  writeFileSync(join(archiveDir, '.initial-route.json'), JSON.stringify({
    coder: 'bootstrap-coder',
    reviewer: 'bootstrap-reviewer',
    codeDepth: 'medium',
    reviewMode: 'static',
  }));
  writeFileSync(join(archiveDir, '.routing-complete'), JSON.stringify({
    coder: 'active-coder',
    reviewer: 'active-reviewer',
    codeDepth: 'deep',
    reviewMode: 'llm',
  }));
  writeFileSync(join(archiveDir, '.post-expansion-route.json'), JSON.stringify({
    coder: 'expanded-coder',
    reviewer: 'expanded-reviewer',
    codeDepth: 'deep',
    reviewMode: 'llm',
    cache_hit: true,
    route_source: 'cache',
    packet_hash: 'c'.repeat(64),
  }));

  const result = readRouteLifecycleArtifacts(undefined, archiveDir);
  assert.equal(result.bootstrap?.coder, 'bootstrap-coder');
  assert.equal(result.expanded?.coder, 'expanded-coder');
  assert.equal(result.active?.coder, 'active-coder');
});

test('readRouteLifecycleArtifacts keeps immutable planning launch route separate from active route', () => {
  const featureDir = makeFeatureDir();

  writeFileSync(join(featureDir, '.initial-route.json'), JSON.stringify({
    planner: 'claude-haiku-4-5',
    coder: 'gpt-5.4',
    reviewer: 'claude-sonnet-5',
    planDepth: 'light',
    codeDepth: 'medium',
    reviewMode: 'static',
  }));
  writeFileSync(join(featureDir, '.routing-complete'), JSON.stringify({
    planner: 'later-reroute-planner',
    coder: 'later-reroute-coder',
    reviewer: 'later-reroute-reviewer',
    planDepth: 'light',
    codeDepth: 'deep',
    reviewMode: 'llm',
  }));
  writeFileSync(join(featureDir, '.phase-config.json'), JSON.stringify({
    planning: {
      model: 'claude-opus-4-7',
      agent: 'claude',
      depth: 'deep',
      launchRoute: {
        source: 'effective-route',
        planner: 'claude-opus-4-7',
        plannerAgent: 'claude',
        planDepth: 'deep',
        route: {
          planner: 'claude-opus-4-7',
          coder: 'gpt-5.4',
          reviewer: 'claude-sonnet-5',
          planDepth: 'deep',
          codeDepth: 'medium',
          reviewMode: 'static',
        },
      },
    },
  }));

  const artifacts = readRouteLifecycleArtifacts(featureDir);
  const provenance = buildRouteLifecycleProvenance(artifacts);

  assert.equal(artifacts.active?.planner, 'later-reroute-planner');
  assert.equal(artifacts.planningLaunch?.planner, 'claude-opus-4-7');
  assert.equal(provenance?.activeRoute?.planner, 'later-reroute-planner');
  assert.equal(provenance?.planningLaunchRoute?.planner, 'claude-opus-4-7');
});

test('deriveRouteDecisionSource returns preserved when active route stays bootstrap', () => {
  const decisionSource = deriveRouteDecisionSource({
    bootstrap: {
      coder: 'claude-sonnet-5',
      codeDepth: 'medium',
      reviewer: 'claude-opus-4-6',
      reviewMode: 'llm',
    },
    expanded: {
      coder: 'gpt-5.4',
      codeDepth: 'deep',
      reviewer: 'claude-sonnet-5',
      reviewMode: 'static',
    },
    active: {
      coder: 'claude-sonnet-5',
      codeDepth: 'medium',
      reviewer: 'claude-opus-4-6',
      reviewMode: 'llm',
    },
  });

  assert.equal(decisionSource, 'preserved');
});

test('buildRouteLifecycleProvenance includes active route and expanded cache metadata', () => {
  const provenance = buildRouteLifecycleProvenance({
    bootstrap: {
      coder: 'claude-sonnet-5',
      codeDepth: 'medium',
      reviewer: 'claude-opus-4-6',
      reviewMode: 'llm',
    },
    expanded: {
      coder: 'gpt-5.4',
      codeDepth: 'deep',
      reviewer: 'claude-sonnet-5',
      reviewMode: 'static',
      cache_hit: true,
      route_source: 'cache',
      packet_hash: 'd'.repeat(64),
    },
    active: {
      coder: 'gpt-5.4',
      codeDepth: 'deep',
      reviewer: 'claude-sonnet-5',
      reviewMode: 'static',
    },
  });

  assert.deepEqual(provenance, {
    bootstrapRoute: {
      coder: 'claude-sonnet-5',
      codeDepth: 'medium',
      reviewer: 'claude-opus-4-6',
      reviewMode: 'llm',
    },
    expandedRoute: {
      coder: 'gpt-5.4',
      codeDepth: 'deep',
      reviewer: 'claude-sonnet-5',
      reviewMode: 'static',
      cacheHit: true,
      routeSource: 'cache',
    },
    activeRoute: {
      coder: 'gpt-5.4',
      codeDepth: 'deep',
      reviewer: 'claude-sonnet-5',
      reviewMode: 'static',
    },
    decisionSource: 'expanded',
    expandedCacheHit: true,
    packetHash: 'd'.repeat(64),
    routeSource: 'cache',
  });
});

test('hasValidPostExpansionRoute returns missing when file is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-artifact-'));
  try {
    assert.deepEqual(hasValidPostExpansionRoute(dir), { ok: false, reason: 'missing' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hasValidPostExpansionRoute returns invalid-json for malformed file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-artifact-'));
  try {
    writeFileSync(join(dir, '.post-expansion-route.json'), '{');
    assert.deepEqual(hasValidPostExpansionRoute(dir), { ok: false, reason: 'invalid-json' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hasValidPostExpansionRoute reports missing required fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-artifact-'));
  try {
    writeFileSync(join(dir, '.post-expansion-route.json'), JSON.stringify({ reviewer: 'claude' }));
    const result = hasValidPostExpansionRoute(dir);
    assert.equal(result.ok, false);
    assert.match(result.reason || '', /^missing-required-field:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hasValidPostExpansionRoute returns ok for valid artifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-artifact-'));
  try {
    writeFileSync(join(dir, '.post-expansion-route.json'), JSON.stringify({
      coder: 'gpt-5.4',
      codeDepth: 'medium',
      reviewer: 'claude-sonnet-5',
      reviewMode: 'llm',
    }));
    assert.deepEqual(hasValidPostExpansionRoute(dir), { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── HOK-3363: the per-stage route record on disk ────────────────────────────

function writeRouteArtifactFile(dir: string, name: string, value: Record<string, unknown>): void {
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

const HOKUSAI_ROUTE_ARTIFACT = {
  planner: 'claude-sonnet-4-5-20250929',
  coder: 'claude-haiku-4-5-20251001',
  reviewer: 'claude-sonnet-4-5-20250929',
  planDepth: 'medium',
  codeDepth: 'medium',
  reviewMode: 'llm',
  routingMode: 'hokusai',
  provenance: { source: 'expanded', inputKind: 'task-packet', inputPath: '', inputHash: '', routedAt: '2026-10-30T00:00:00.000Z', routerMode: 'normal', requestId: 'req-1', inferenceLogId: 'req-1' },
  stageRoutes: {
    planner: { hokusai: { requestId: 'req-1', recommended: 'claude-sonnet-4-5-20250929' }, executed: 'claude-sonnet-4-5-20250929', overrides: [] },
    coder: { hokusai: { requestId: 'req-1', recommended: 'claude-haiku-4-5-20251001' }, executed: 'claude-haiku-4-5-20251001', overrides: [] },
    reviewer: { hokusai: { requestId: 'req-1', recommended: 'claude-sonnet-4-5-20250929' }, executed: 'claude-sonnet-4-5-20250929', overrides: [] },
  },
};

// protects: an operator reroute that never reaches the record the eval reads (HOK-3363).
test('appendRouteOverrideToFeatureDir appends to the expanded route and the lifecycle reader returns it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-record-'));
  try {
    writeRouteArtifactFile(dir, '.initial-route.json', { ...HOKUSAI_ROUTE_ARTIFACT, stageRoutes: undefined });
    writeRouteArtifactFile(dir, '.post-expansion-route.json', HOKUSAI_ROUTE_ARTIFACT);

    const outcome = await appendRouteOverrideToFeatureDir(dir, 'coder', 'claude-opus-5-5', {
      source: 'operator',
      reason: 'operator_force_reroute',
      at: '2026-10-30T12:00:00.000Z',
      actor: 'operator',
    });
    assert.equal(outcome, 'appended');

    const written = JSON.parse(readFileSync(join(dir, '.post-expansion-route.json'), 'utf-8'));
    assert.equal(written.coder, 'claude-haiku-4-5-20251001', 'the routed decision itself is not rewritten');
    assert.equal(written.stageRoutes.coder.executed, 'claude-opus-5-5');

    const provenance = buildRouteLifecycleProvenance(readRouteLifecycleArtifacts(dir));
    assert.equal(provenance?.hokusaiInferenceLogId, 'req-1');
    assert.deepEqual(provenance?.stageRoutes?.coder, {
      hokusai: { requestId: 'req-1', recommended: 'claude-haiku-4-5-20251001' },
      executed: 'claude-opus-5-5',
      overrides: [{
        source: 'operator',
        from: 'claude-haiku-4-5-20251001',
        to: 'claude-opus-5-5',
        reason: 'operator_force_reroute',
        at: '2026-10-30T12:00:00.000Z',
        actor: 'operator',
      }],
    });
    assert.equal(routeRecordCarrier(readRouteLifecycleArtifacts(dir))?.artifactPath?.endsWith('.post-expansion-route.json'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// protects: a same-model reroute polluting the record, and pre-HOK-3363 artifacts losing the override.
test('appendRouteOverrideToFeatureDir is a no-op for the same model and seeds a record for legacy artifacts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-record-'));
  try {
    const { stageRoutes: _ignored, ...legacy } = HOKUSAI_ROUTE_ARTIFACT;
    writeRouteArtifactFile(dir, '.initial-route.json', legacy);

    assert.equal(await appendRouteOverrideToFeatureDir(dir, 'coder', 'claude-haiku-4-5-20251001', {
      source: 'operator', reason: 'operator_reroute',
    }), 'noop');
    assert.equal(JSON.parse(readFileSync(join(dir, '.initial-route.json'), 'utf-8')).stageRoutes, undefined);

    assert.equal(await appendRouteOverrideToFeatureDir(dir, 'reviewer', 'claude-opus-4-7', {
      source: 'launchability', reason: 'uncertified', certification: 'missing_live_canary', at: '2026-10-30T12:00:00.000Z',
    }), 'appended');
    const routes = JSON.parse(readFileSync(join(dir, '.initial-route.json'), 'utf-8')).stageRoutes;
    assert.equal(routes.reviewer.overrides[0].from, 'claude-sonnet-4-5-20250929');
    assert.equal(routes.reviewer.overrides[0].certification, 'missing_live_canary');
    assert.equal(routes.coder.executed, 'claude-haiku-4-5-20251001');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// protects: a reroute claiming to have recorded an override when no route record exists.
test('appendRouteOverrideToFeatureDir reports a feature dir with no route artifact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-record-'));
  try {
    assert.equal(await appendRouteOverrideToFeatureDir(dir, 'coder', 'x', { source: 'operator', reason: 'r' }), 'no_route_artifact');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
