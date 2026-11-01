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
 *
 * And the one route-override record (HOK-3363) — every override of Hokusai's
 * model reaches Hokusai:
 *
 * - **stage-substitution-without-override** (structural, the files that
 *   substitute stage models after routing): an object literal that spreads a
 *   decision/route and then sets `planner` / `coder` / `reviewer` (or
 *   `[role]`), or an assignment to `<x>.coder` / `<x>[role]`, inside a
 *   top-level function that never appends to the route record
 *   (`overrideStageModel` / `appendStageOverride` /
 *   `appendRouteOverrideToFeatureDir`). Local routers composing their *own*
 *   decision carry an `allow-stage-launchability:` marker.
 * - **private-route-change-flag** (line pattern, everywhere): the retired
 *   per-mechanism copies (`routeChanged`, `preEscalationRoute`,
 *   `launchabilitySubstitutions`, `provenance.escalation`, …) and the retired
 *   local coder ranking (`modelClassRank`, `isStrongerCoder`, …). A change of
 *   route is an override in `stageRoutes`, and "is this coder stronger?" is
 *   Hokusai's question.
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
  /** 1-indexed line of the closing column-0 `}`. */
  endLine: number;
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
      endLine: end + 1,
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

/** Calls that append to the one route record (route-override-record.ts / route-artifact.ts). */
const ROUTE_RECORD_APPEND = /\b(?:overrideStageModel|appendStageOverride|appendRouteOverrideToFeatureDir)\s*\(/;
const STAGE_ROLE_KEY = /^\s*(?:planner|coder|reviewer|\[role\])\s*[:,]/;
const INLINE_SPREAD_ROLE = /\{\s*\.\.\.[A-Za-z_$][\w$.]*\s*,\s*(?:planner|coder|reviewer|\[role\])\s*:/;
const BARE_SPREAD = /^(\s*)\.\.\.[A-Za-z_$][\w$.]*,\s*$/;
const ROLE_ASSIGNMENT = /\b[A-Za-z_$][\w$]*(?:\.(?:planner|coder|reviewer)|\[role\])\s*=(?!=)/;

/** Paths where stage models are substituted after the router decided them. */
export const STAGE_SUBSTITUTION_PATHS: readonly string[] = [
  WORKFLOW_ROUTER_PATH,
  'shared/lib/route-batch.ts',
  'shared/lib/coder-launch-reroute.ts',
  'shared/lib/reviewer-launch-reroute.ts',
  'shared/lib/challenge-execution-contract.ts',
  'tools/reroute-task.ts',
];

/**
 * Lines that replace a stage model on an existing decision/route without the
 * enclosing top-level function appending to the route record. Code outside
 * any top-level function is checked against the whole file.
 */
export function findUnrecordedStageSubstitutions(sourceText: string): StructuralMatch[] {
  const lines = sourceText.split(/\r?\n/);
  const functions = topLevelFunctions(sourceText);
  const scopeAppends = (lineIndex: number): boolean => {
    const fn = functions.find((candidate) => lineIndex >= candidate.line - 1 && lineIndex <= candidate.endLine - 1);
    return ROUTE_RECORD_APPEND.test(fn ? fn.body : sourceText);
  };
  const flagged = new Set<number>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    if (INLINE_SPREAD_ROLE.test(line) || ROLE_ASSIGNMENT.test(line)) {
      flagged.add(i);
      continue;
    }
    const spread = BARE_SPREAD.exec(line);
    if (!spread) continue;
    const indent = spread[1].length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (!next.trim()) continue;
      const nextIndent = next.length - next.trimStart().length;
      if (nextIndent < indent) break;
      if (nextIndent === indent && STAGE_ROLE_KEY.test(next)) {
        flagged.add(j);
      }
    }
  }
  return [...flagged]
    .sort((a, b) => a - b)
    .filter((index) => !scopeAppends(index))
    .map((index) => ({ line: index + 1 }));
}

/** Retired per-mechanism route-change copies and the retired local coder ranking. */
const PRIVATE_ROUTE_CHANGE_FLAG = new RegExp([
  '\\brouteChanged\\b',
  '\\bpreEscalationRoute\\b',
  '\\bPreEscalationRoute\\b',
  '\\blaunchabilitySubstitutions\\b',
  '\\b(?:coder|reviewer)LaunchSubstitutions\\b',
  '\\bprovenance\\??\\.escalation\\b',
  '\\bminCoderClassRankIncrease\\b',
  '\\bmodelClassRank\\b',
  '\\bisStrongerCoder\\b',
  '\\bisEscalationEligibleCoder\\b',
  '\\bstrongerCoderCandidates\\b',
].join('|'));

export const STAGE_LAUNCHABILITY_GUARD: GuardSpec = {
  name: 'stage-launchability',
  findingNoun: 'routing exit(s) that bypass finalizeDecision or the route record',
  suppressionMarker: 'allow-stage-launchability',
  allowlistFile: 'tools/stage-launchability-allowlist.txt',
  invariantPaths: [
    'shared/lib/stage-launchability.ts',
    'shared/lib/stage-launchability-guard.ts',
    'shared/lib/route-override-record.ts',
  ],
  patterns: [
    {
      name: 'route-decision-outside-router',
      description: 'function returning a route decision outside workflow-router.ts — route through routeWorkflow*() so finalizeDecision runs',
      lang: 'ts',
      re: /\)\s*:\s*(?:Promise\s*<\s*)?(?:WorkflowRouteDecision|StageAwareDecision)\b/,
      excludePaths: [WORKFLOW_ROUTER_PATH],
    },
    {
      name: 'private-route-change-flag',
      description: 'retired route-change copy or local coder ranking — record the change as an override in stageRoutes (route-override-record.ts); escalation re-asks Hokusai (HOK-3363)',
      lang: 'ts',
      re: PRIVATE_ROUTE_CHANGE_FLAG,
    },
  ],
  structuralChecks: [
    {
      name: 'router-exit-not-finalized',
      description: 'exported router function returns a route decision without reaching finalizeDecision / enforceLaunchableRoute',
      paths: [WORKFLOW_ROUTER_PATH],
      find: findUnfinalizedRouterExits,
    },
    {
      name: 'stage-substitution-without-override',
      description: 'stage model replaced without appending an override to the route record — use overrideStageModel / appendRouteOverrideToFeatureDir (HOK-3363)',
      paths: STAGE_SUBSTITUTION_PATHS,
      find: findUnrecordedStageSubstitutions,
    },
  ],
  remediation: [
    'Every router-selected model must pass isLaunchableForStage() (HOK-3142): each routing',
    'exit in shared/lib/workflow-router.ts returns through finalizeDecision, which runs',
    'enforceLaunchableRoute. Never add a routing path that returns without it.',
    'Every override of a decided stage model appends to the one route record (HOK-3363):',
    'overrideStageModel() in the router, appendRouteOverrideToFeatureDir() on disk. Never',
    'replace a stage model silently or keep a private route-change flag.',
  ],
};
