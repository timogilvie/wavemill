import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, formatGuardResult, runSourceGuard } from '../../tools/lib/source-guard.ts';
import {
  findUnfinalizedRouterExits,
  findUnrecordedStageSubstitutions,
  STAGE_LAUNCHABILITY_GUARD,
  topLevelFunctions,
  WORKFLOW_ROUTER_PATH,
} from './stage-launchability-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const ROUTER_FIXTURE = [
  'function finalizeDecision<T extends WorkflowRouteDecision>(decision: T): T {',
  '  return enforceLaunchableRoute(decision);',
  '}',
  '',
  'function routeInternal(prompt: string): StageAwareDecision {',
  '  const decision = build(prompt);',
  '  return finalizeDecision(decision);',
  '}',
  '',
  'export function routeDirect(prompt: string): WorkflowRouteDecision {',
  '  return finalizeDecision(build(prompt));',
  '}',
  '',
  'export function routeDelegating(',
  '  prompt: string,',
  '): StageAwareDecision {',
  '  return routeInternal(prompt);',
  '}',
  '',
  'export async function routeAsync(prompt: string): Promise<StageAwareDecision> {',
  '  return routeDelegating(prompt);',
  '}',
  '',
  'export function routeBypass(prompt: string): WorkflowRouteDecision {',
  '  return build(prompt);',
  '}',
  '',
  'export function summarize(decision: WorkflowRouteDecision): string {',
  '  return decision.coder;',
  '}',
  '',
].join('\n');

describe('topLevelFunctions', () => {
  it('splits column-0 declarations with multi-line signatures and return types', () => {
    const fns = topLevelFunctions(ROUTER_FIXTURE);
    assert.deepEqual(fns.map((fn) => [fn.name, fn.exported, fn.line]), [
      ['finalizeDecision', false, 1],
      ['routeInternal', false, 5],
      ['routeDirect', true, 10],
      ['routeDelegating', true, 14],
      ['routeAsync', true, 20],
      ['routeBypass', true, 24],
      ['summarize', true, 28],
    ]);
    assert.equal(fns[3].returnType, 'StageAwareDecision');
    assert.equal(fns[4].returnType, 'Promise<StageAwareDecision>');
    assert.equal(fns[6].returnType, 'string');
  });
});

describe('findUnfinalizedRouterExits', () => {
  it('reports only exported route exits that never reach a finalizer, following same-file calls', () => {
    assert.deepEqual(findUnfinalizedRouterExits(ROUTER_FIXTURE), [{ line: 24, detail: 'routeBypass' }]);
  });

  it('is suppressible at the declaration through the guard', () => {
    const suppressed = ROUTER_FIXTURE.replace(
      'export function routeBypass',
      '// allow-stage-launchability: callers finalize\nexport function routeBypass',
    );
    assert.deepEqual(checkGuardSource(STAGE_LAUNCHABILITY_GUARD, WORKFLOW_ROUTER_PATH, suppressed), []);
    const [finding] = checkGuardSource(STAGE_LAUNCHABILITY_GUARD, WORKFLOW_ROUTER_PATH, ROUTER_FIXTURE);
    assert.equal(finding.pattern, 'router-exit-not-finalized');
    assert.match(finding.description, /\(routeBypass\)$/);
  });
});

describe('route-decision-outside-router pattern', () => {
  const patternsOf = (file: string, source: string) =>
    checkGuardSource(STAGE_LAUNCHABILITY_GUARD, file, source).map((finding) => finding.pattern);

  it('flags route-decision return annotations outside the router', () => {
    assert.deepEqual(patternsOf('shared/lib/new-router.ts', 'export function pick(p: string): WorkflowRouteDecision {\n'), ['route-decision-outside-router']);
    assert.deepEqual(patternsOf('shared/lib/new-router.ts', '): Promise<StageAwareDecision | null> {\n'), ['route-decision-outside-router']);
  });

  it('ignores parameters, imports, and the router itself', () => {
    assert.deepEqual(patternsOf('shared/lib/x.ts', "import type { WorkflowRouteDecision } from './workflow-router.ts';\n"), []);
    assert.deepEqual(patternsOf('shared/lib/x.ts', 'export function show(decision: WorkflowRouteDecision): string {\n'), []);
    assert.deepEqual(patternsOf(WORKFLOW_ROUTER_PATH, 'function helper(d: T): WorkflowRouteDecision {\n  return finalizeDecision(d);\n}\n'), []);
  });
});

describe('stage-substitution-without-override (HOK-3363)', () => {
  const findingsOf = (file: string, source: string) =>
    checkGuardSource(STAGE_LAUNCHABILITY_GUARD, file, source)
      .filter((finding) => finding.pattern === 'stage-substitution-without-override')
      .map((finding) => finding.line);

  const SILENT = [
    'function escalate(decision: StageAwareDecision): StageAwareDecision {',
    '  return {',
    '    ...decision,',
    '    coder: stronger,',
    '  };',
    '}',
    '',
    'function inline(decision: WorkflowRouteDecision): WorkflowRouteDecision {',
    '  return { ...decision, [role]: substitute };',
    '}',
    '',
    'function assign(decision: WorkflowRouteDecision): void {',
    '  decision.reviewer = other;',
    '}',
    '',
  ].join('\n');

  // protects: a new escalation/substitution path replacing a stage model without an override.
  it('flags spread-then-role literals and role assignments in a function that never appends', () => {
    assert.deepEqual(findUnrecordedStageSubstitutions(SILENT).map((match) => match.line), [4, 9, 13]);
    assert.deepEqual(findingsOf(WORKFLOW_ROUTER_PATH, SILENT), [4, 9, 13]);
  });

  // protects: the guard rejecting the sanctioned path.
  it('passes the same substitution when the function appends to the route record', () => {
    const recorded = [
      'function escalate(decision: StageAwareDecision): StageAwareDecision {',
      "  const next = overrideStageModel(decision, 'coder', stronger, { source: 'escalation', reason: 'r' });",
      '  return {',
      '    ...next,',
      '    coder: stronger,',
      '  };',
      '}',
      '',
      'async function writeRoute(featureDir: string): Promise<void> {',
      "  await mutate((current) => ({ ...current, coder: to }));",
      "  await appendRouteOverrideToFeatureDir(featureDir, 'coder', to, { source: 'launchability', reason: 'r' });",
      '}',
      '',
    ].join('\n');
    assert.deepEqual(findUnrecordedStageSubstitutions(recorded), []);
  });

  // protects: false positives on fresh decisions and comparisons.
  it('ignores fresh literals, equality checks, nested keys and other paths', () => {
    const fresh = [
      'function build(): WorkflowRouteDecision {',
      '  const route = { planner: p, coder: c, reviewer: r };',
      '  if (decision.coder === other) return route;',
      '  return { ...route, signals: { coder: 1 } };',
      '}',
      '',
    ].join('\n');
    assert.deepEqual(findUnrecordedStageSubstitutions(fresh), []);
    assert.deepEqual(findingsOf('shared/lib/unrelated.ts', SILENT), []);
  });

  // protects: a local router's own decision composition being unflaggable as legitimate.
  it('is suppressible with the stage-launchability marker', () => {
    const suppressed = SILENT.replace('    coder: stronger,', '    // allow-stage-launchability: local router composing its own decision\n    coder: stronger,');
    assert.deepEqual(findingsOf(WORKFLOW_ROUTER_PATH, suppressed), [10, 14]);
  });
});

describe('private-route-change-flag (HOK-3363)', () => {
  const patternsOf = (file: string, source: string) =>
    checkGuardSource(STAGE_LAUNCHABILITY_GUARD, file, source).map((finding) => finding.pattern);

  // protects: a retired per-mechanism route-change copy or local coder ranking coming back.
  it('flags retired route-change flags and the local coder ranking anywhere', () => {
    for (const line of [
      'record.routeChanged = true;',
      'const pre = decision.preEscalationRoute;',
      'decision.launchabilitySubstitutions?.push(x);',
      'if (decision.provenance?.escalation) {}',
      'const rank = modelClassRank(candidate);',
      'if (isStrongerCoder(a, b)) {}',
    ]) {
      assert.deepEqual(patternsOf('shared/lib/anything.ts', `${line}\n`), ['private-route-change-flag'], line);
    }
  });

  // protects: false positives on docs and on routeChangedMaterially (expansion materiality, not an override flag).
  it('ignores comments and the still-supported route-materiality helper', () => {
    assert.deepEqual(patternsOf('shared/lib/anything.ts', '// routeChanged was retired\n'), []);
    assert.deepEqual(patternsOf('shared/lib/anything.ts', 'const m = routeChangedMaterially(a, b);\n'), []);
  });
});

describe('stage-launchability guard — repository', () => {
  it('passes at HEAD: every exported router exit reaches finalizeDecision', () => {
    const result = runSourceGuard(STAGE_LAUNCHABILITY_GUARD, repoRoot);
    assert.deepEqual(result.findings, [], formatGuardResult(STAGE_LAUNCHABILITY_GUARD, result));
  });
});
