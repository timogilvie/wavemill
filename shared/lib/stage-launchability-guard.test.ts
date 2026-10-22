import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, formatGuardResult, runSourceGuard } from '../../tools/lib/source-guard.ts';
import {
  findUnfinalizedRouterExits,
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

describe('stage-launchability guard — repository', () => {
  it('passes at HEAD: every exported router exit reaches finalizeDecision', () => {
    const result = runSourceGuard(STAGE_LAUNCHABILITY_GUARD, repoRoot);
    assert.deepEqual(result.findings, [], formatGuardResult(STAGE_LAUNCHABILITY_GUARD, result));
  });
});
