// allow-stage-launchability: this file *is* the stage-launchability guard; its
// pattern table names every forbidden shape. It is auto-excluded from its own
// scan (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the router ↔ launcher parity invariant (HOK-3142,
 * enforced by HOK-3236): every router-selected model passes
 * `isLaunchableForStage()` because every routing exit runs through
 * `finalizeDecision` → `enforceLaunchableRoute` in shared/lib/workflow-router.ts.
 *
 * Two checks:
 *
 * - **router-exit-not-finalized** (structural, workflow-router.ts only): every
 *   exported top-level function whose declared return type is a route decision
 *   (`WorkflowRouteDecision` / `StageAwareDecision`) must reach
 *   `finalizeDecision(` or `enforceLaunchableRoute(` — directly, or through a
 *   same-file function that does. Reachability is a call-graph property, not
 *   an all-paths proof; intermediate builders whose callers finalize carry an
 *   `allow-stage-launchability:` marker on their declaration.
 * - **route-decision-outside-router** (line pattern, everywhere else): a
 *   function annotated to return a route decision is a routing path living
 *   outside the router, where finalizeDecision cannot be enforced. Existing
 *   adapters (Hokusai response mapping, batch caching, successor upgrades)
 *   are allowlisted with a reason.
 */
import type { GuardSpec, StructuralMatch } from '../../tools/lib/source-guard.ts';

export const WORKFLOW_ROUTER_PATH = 'shared/lib/workflow-router.ts';

const ROUTE_DECISION_TYPE = /\b(?:WorkflowRouteDecision|StageAwareDecision)\b/;
const FINALIZERS = /\b(?:finalizeDecision|enforceLaunchableRoute)\s*\(/;
const FUNCTION_DECL = /^(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[<(]/;

interface TopLevelFunction {
  name: string;
  exported: boolean;
  /** 1-indexed declaration line. */
  line: number;
  returnType: string;
  body: string;
}

/**
 * Split a module into its top-level `function` declarations. Relies on the
 * repo's formatting convention: declarations start at column 0 and the body
 * closes with a column-0 `}`. Arrow-function consts are not route exits in
 * this module and are ignored.
 */
export function topLevelFunctions(sourceText: string): TopLevelFunction[] {
  const lines = sourceText.split(/\r?\n/);
  const functions: TopLevelFunction[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const decl = FUNCTION_DECL.exec(lines[i]);
    if (!decl) continue;
    // Signature: from the declaration to the first line ending with `{`.
    let sigEnd = i;
    while (sigEnd < lines.length && !/\{\s*$/.test(lines[sigEnd])) sigEnd += 1;
    let end = sigEnd + 1;
    while (end < lines.length && !/^\}/.test(lines[end])) end += 1;
    const signature = lines.slice(i, sigEnd + 1).join('\n');
    const returnMatch = /\)\s*:\s*([^{]+?)\s*\{\s*$/.exec(signature);
    functions.push({
      name: decl[2],
      exported: Boolean(decl[1]),
      line: i + 1,
      returnType: returnMatch ? returnMatch[1] : '',
      body: lines.slice(sigEnd + 1, end).join('\n'),
    });
    i = end;
  }
  return functions;
}

/**
 * Exported route-decision functions that never reach a finalizer through the
 * same-file call graph.
 */
export function findUnfinalizedRouterExits(sourceText: string): StructuralMatch[] {
  const functions = topLevelFunctions(sourceText);
  const finalized = new Set(functions.filter((fn) => FINALIZERS.test(fn.body)).map((fn) => fn.name));
  // Propagate to a fixpoint: calling a finalized function finalizes the caller.
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of functions) {
      if (finalized.has(fn.name)) continue;
      for (const callee of finalized) {
        if (new RegExp(`\\b${callee.replace(/\$/g, '\\$')}\\s*\\(`).test(fn.body)) {
          finalized.add(fn.name);
          changed = true;
          break;
        }
      }
    }
  }
  return functions
    .filter((fn) => fn.exported && ROUTE_DECISION_TYPE.test(fn.returnType) && !finalized.has(fn.name))
    .filter((fn) => !/^(?:enforceLaunchableRoute|finalizeDecision)$/.test(fn.name))
    .map((fn) => ({ line: fn.line, detail: fn.name }));
}

export const STAGE_LAUNCHABILITY_GUARD: GuardSpec = {
  name: 'stage-launchability',
  findingNoun: 'routing exit(s) that bypass finalizeDecision',
  suppressionMarker: 'allow-stage-launchability',
  allowlistFile: 'tools/stage-launchability-allowlist.txt',
  invariantPaths: [
    'shared/lib/stage-launchability.ts',
    'shared/lib/stage-launchability-guard.ts',
  ],
  patterns: [
    {
      name: 'route-decision-outside-router',
      description: 'function returning a route decision outside workflow-router.ts — route through routeWorkflow*() so finalizeDecision runs',
      lang: 'ts',
      re: /\)\s*:\s*(?:Promise\s*<\s*)?(?:WorkflowRouteDecision|StageAwareDecision)\b/,
      excludePaths: [WORKFLOW_ROUTER_PATH],
    },
  ],
  structuralChecks: [
    {
      name: 'router-exit-not-finalized',
      description: 'exported router function returns a route decision without reaching finalizeDecision / enforceLaunchableRoute',
      paths: [WORKFLOW_ROUTER_PATH],
      find: findUnfinalizedRouterExits,
    },
  ],
  remediation: [
    'Every router-selected model must pass isLaunchableForStage() (HOK-3142): each routing',
    'exit in shared/lib/workflow-router.ts returns through finalizeDecision, which runs',
    'enforceLaunchableRoute. Never add a routing path that returns without it.',
  ],
};
