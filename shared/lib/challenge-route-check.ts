/**
 * HOK-3156 — file-level wrapper around the one-variable route invariant.
 *
 * Shell callers (post-expansion re-route, fork materialisation, the pre-review
 * preflight) hold arm routes as files: a sealed `challenge-intent.json`, an
 * arm's `.routing-complete`, or its `.phase-config.json`. This module turns
 * whichever of those a caller has into the two routes
 * `assessChallengeRouteInvariant` compares, so every caller runs the same
 * check and shell never re-implements the diff.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChallengeStage } from './challenge-mode.ts';
import type { ChallengeRoutingMeta } from './challenge-comparison.ts';
import {
  CHALLENGE_ROUTE_FIELDS,
  assessChallengeRouteInvariant,
  challengeStageOfIntent,
  routeFromPhaseConfig,
  routingMetaFromRawRoute,
  sealedSideRoute,
  type ChallengeExecutionIntent,
  type ChallengeRouteInvariantResult,
  type ChallengeSide,
} from './challenge-execution-contract.ts';

export interface ChallengeRouteCheckInput {
  /** Varied stage; defaults to the intent's stage. Accepts plan|planning|implementation|coding|review. */
  stage?: string;
  /** Path to a sealed challenge intent file. */
  intentPath?: string;
  /** Raw sealed challenge intent JSON (alternative to intentPath). */
  intentJson?: string;
  /** Arm feature dir whose `.phase-config.json` is that arm's launch route. */
  primaryFeatureDir?: string;
  challengerFeatureDir?: string;
  /** Arm `.routing-complete`-shaped file. */
  primaryRoutingPath?: string;
  challengerRoutingPath?: string;
  /** Repo whose model registry resolves alias equivalence. */
  repoDir?: string;
}

export type ChallengeRouteSideSource = 'phase-config' | 'routing' | 'intent';

export type ChallengeRouteCheckOutcome =
  | {
    status: 'ok' | 'drift';
    result: ChallengeRouteInvariantResult;
    sources: Record<ChallengeSide, ChallengeRouteSideSource>;
    primary: Partial<ChallengeRoutingMeta>;
    challenger: Partial<ChallengeRoutingMeta>;
  }
  | { status: 'unreadable'; detail: string };

export function normalizeChallengeStage(raw: string | undefined): ChallengeStage | undefined {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'plan':
    case 'planning':
    case 'planner':
      return 'plan';
    case 'implementation':
    case 'coding':
    case 'coder':
      return 'implementation';
    case 'review':
    case 'reviewer':
      return 'review';
    default:
      return undefined;
  }
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

function loadIntent(input: ChallengeRouteCheckInput): ChallengeExecutionIntent | undefined {
  let raw: unknown;
  if (input.intentJson) {
    try {
      raw = JSON.parse(input.intentJson);
    } catch {
      raw = undefined;
    }
  } else if (input.intentPath) {
    raw = readJson(input.intentPath);
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as ChallengeExecutionIntent
    : undefined;
}

function resolveSide(
  side: ChallengeSide,
  featureDir: string | undefined,
  routingPath: string | undefined,
  intent: ChallengeExecutionIntent | undefined,
): { route: Partial<ChallengeRoutingMeta>; source: ChallengeRouteSideSource } | undefined {
  if (featureDir) {
    const config = readJson(join(featureDir, '.phase-config.json'));
    return config ? { route: routeFromPhaseConfig(config), source: 'phase-config' } : undefined;
  }
  if (routingPath) {
    const routing = routingMetaFromRawRoute(readJson(routingPath));
    return routing ? { route: routing, source: 'routing' } : undefined;
  }
  if (intent?.[side]) return { route: sealedSideRoute(intent, side), source: 'intent' };
  return undefined;
}

/**
 * Resolve both arm routes from whichever artifacts the caller supplied and
 * assess the one-variable invariant. Per side the precedence is feature dir
 * (`.phase-config.json`, what actually launches) → routing file → the sealed
 * intent's side. A field the sealed intent left empty is unconstrained.
 */
export function checkChallengeRoute(input: ChallengeRouteCheckInput): ChallengeRouteCheckOutcome {
  const intent = loadIntent(input);
  if ((input.intentPath || input.intentJson) && !intent) {
    return { status: 'unreadable', detail: 'challenge intent is missing or not valid JSON' };
  }
  const stage = normalizeChallengeStage(input.stage)
    ?? (intent ? challengeStageOfIntent(intent) : undefined);
  if (!stage) {
    return { status: 'unreadable', detail: 'varied stage unknown: pass --stage or a sealed intent' };
  }

  const primary = resolveSide('primary', input.primaryFeatureDir, input.primaryRoutingPath, intent);
  const challenger = resolveSide('challenger', input.challengerFeatureDir, input.challengerRoutingPath, intent);
  if (!primary || !challenger) {
    const missing = [!primary ? 'primary' : '', !challenger ? 'challenger' : ''].filter(Boolean).join(',');
    return { status: 'unreadable', detail: `route unreadable for side(s): ${missing}` };
  }

  // A sealed intent that never committed to a field (the envelope schema has
  // no depths) does not constrain it: compare only what both sides recorded.
  // Artifact-sourced sides (phase-config, routing) are compared as written.
  const primaryRoute = fillUncommitted(primary, challenger);
  const challengerRoute = fillUncommitted(challenger, primary);
  const result = assessChallengeRouteInvariant({
    variedStage: stage,
    primary: primaryRoute,
    challenger: challengerRoute,
    intentionallyIdentical: intent?.intentionallyIdentical === true,
    repoDir: input.repoDir,
  });
  return {
    status: result.driftedFields.length > 0 ? 'drift' : 'ok',
    result,
    sources: { primary: primary.source, challenger: challenger.source },
    primary: primaryRoute,
    challenger: challengerRoute,
  };
}

function fillUncommitted(
  side: { route: Partial<ChallengeRoutingMeta>; source: ChallengeRouteSideSource },
  other: { route: Partial<ChallengeRoutingMeta> },
): Partial<ChallengeRoutingMeta> {
  if (side.source !== 'intent') return side.route;
  const filled: Partial<ChallengeRoutingMeta> = { ...side.route };
  for (const field of CHALLENGE_ROUTE_FIELDS) {
    if (!filled[field]?.trim() && other.route[field]) filled[field] = other.route[field];
  }
  return filled;
}
