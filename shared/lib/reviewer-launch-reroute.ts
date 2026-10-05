/**
 * Reviewer launch reroute (HOK-3146).
 *
 * Mirrors `coder-launch-reroute.ts`, but for the reviewer role. Used when the
 * review agent sits at a Codex "model at capacity" prompt: the launch gate
 * accepted the reviewer, but the model refused mid-run, so retrying the same
 * route can never succeed. This module re-runs routing with every refused
 * reviewer excluded and replaces **only** the reviewer in the task's approved
 * route (`.phase-config.json` `review.*`, `.routing-complete` `reviewer`).
 *
 * Exclusions accumulate in `<featureDir>/.reviewer-launch-exclusions.json`.
 * The caller (the monitor's review-capacity path) bounds the number of
 * reroutes via the `review-capacity` bounded-retry bucket and terminalizes on
 * `no-eligible`.
 *
 * @module reviewer-launch-reroute
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { providerForModel } from './execution-contract.ts';
import { getEffectiveRegistry } from './model-registry.ts';
import { createLaunchabilityChecker } from './stage-launchability.ts';
import { mutateJsonState } from './state-mutex.ts';
import {
  findLaunchableSubstitute,
  routeWorkflowAuto,
  type RouteWorkflowOptions,
  type WorkflowRouteDecision,
} from './workflow-router.ts';
import { readRoutingPrompt } from './coder-launch-reroute.ts';

export const REVIEWER_LAUNCH_EXCLUSIONS_FILE = '.reviewer-launch-exclusions.json';
export const REVIEWER_ROUTE_SUBSTITUTIONS_LOG = '.route-substitutions.jsonl';

export interface ReviewerLaunchRefusal {
  reason: string;
  certification?: string;
  certifyCommand?: string;
}

export interface ReviewerLaunchExclusion {
  model: string;
  reason: string;
  certification?: string;
  at: string;
}

export interface ReviewerLaunchExclusions {
  models: ReviewerLaunchExclusion[];
}

export type RerouteRefusedReviewerResult =
  | {
    status: 'rerouted';
    from: string;
    to: string;
    agent: string;
    source: 'router' | 'deterministic';
    reason: string;
    certification?: string;
    excluded: string[];
  }
  | {
    status: 'no-eligible';
    from: string;
    reason: string;
    certification?: string;
    certifyCommand?: string;
    excluded: string[];
  };

export type RouteFn = (prompt: string, options: RouteWorkflowOptions) => Promise<WorkflowRouteDecision>;

export interface RerouteRefusedReviewerOptions {
  repoDir: string;
  featureDir: string;
  issue: string;
  refusedModels: string[];
  refusal: ReviewerLaunchRefusal;
  route?: RouteFn;
  routeOptions?: Partial<RouteWorkflowOptions>;
  now?: Date;
}

export function readReviewerLaunchExclusions(featureDir: string): ReviewerLaunchExclusions {
  const path = join(featureDir, REVIEWER_LAUNCH_EXCLUSIONS_FILE);
  if (!existsSync(path)) {
    return { models: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ReviewerLaunchExclusions>;
    return { models: Array.isArray(parsed.models) ? parsed.models.filter((entry) => typeof entry?.model === 'string') : [] };
  } catch {
    return { models: [] };
  }
}

async function recordExclusions(
  featureDir: string,
  models: string[],
  refusal: ReviewerLaunchRefusal,
  at: string,
): Promise<string[]> {
  const updated = await mutateJsonState<ReviewerLaunchExclusions>(
    join(featureDir, REVIEWER_LAUNCH_EXCLUSIONS_FILE),
    (current) => {
      const existing = Array.isArray(current?.models) ? current.models : [];
      const known = new Set(existing.map((entry) => entry.model));
      const added = models
        .filter((model) => model && !known.has(model))
        .map((model) => ({
          model,
          reason: refusal.reason,
          ...(refusal.certification ? { certification: refusal.certification } : {}),
          at,
        }));
      return { models: [...existing, ...added] };
    },
    { createIfMissing: true, initial: { models: [] } },
  );
  return updated.models.map((entry) => entry.model);
}

async function applyReviewerSubstitution(input: {
  featureDir: string;
  issue: string;
  from: string;
  to: string;
  agent: string;
  provider: string;
  refusal: ReviewerLaunchRefusal;
  source: 'router' | 'deterministic';
  at: string;
}): Promise<void> {
  const substitution = {
    from: input.from,
    to: input.to,
    reason: input.refusal.reason,
    ...(input.refusal.certification ? { certification: input.refusal.certification } : {}),
    source: input.source,
    at: input.at,
  };

  const phaseConfigPath = join(input.featureDir, '.phase-config.json');
  if (existsSync(phaseConfigPath)) {
    await mutateJsonState<Record<string, unknown>>(phaseConfigPath, (current) => {
      const review = (current.review && typeof current.review === 'object' ? current.review : {}) as Record<string, unknown>;
      return {
        ...current,
        review: {
          ...review,
          model: input.to,
          agent: input.agent,
          provider: input.provider,
          selectedAt: input.at,
          launchSubstitution: substitution,
        },
      };
    });
  }

  const routingCompletePath = join(input.featureDir, '.routing-complete');
  if (existsSync(routingCompletePath)) {
    await mutateJsonState<Record<string, unknown>>(routingCompletePath, (current) => ({
      ...current,
      reviewer: input.to,
      reviewerLaunchSubstitutions: [
        ...(Array.isArray(current.reviewerLaunchSubstitutions) ? current.reviewerLaunchSubstitutions : []),
        substitution,
      ],
    }));
  }

  appendFileSync(
    join(input.featureDir, REVIEWER_ROUTE_SUBSTITUTIONS_LOG),
    `${JSON.stringify({ issue: input.issue, role: 'reviewer', ...substitution })}\n`,
  );
}

/**
 * Re-route a reviewer the launch gate accepted but the model later refused
 * mid-run (e.g. Codex "model at capacity"). Same algorithm as the coder reroute:
 * prefer a fresh routing decision with the refused models excluded; fall back
 * to the router's deterministic substitution order when routing is unavailable
 * or its reviewer is still not launchable.
 */
export async function rerouteRefusedReviewer(opts: RerouteRefusedReviewerOptions): Promise<RerouteRefusedReviewerResult> {
  const refused = [...new Set(opts.refusedModels.map((model) => model.trim()).filter(Boolean))];
  if (refused.length === 0) {
    throw new Error('rerouteRefusedReviewer: at least one refused model is required');
  }
  const from = refused[0];
  const at = (opts.now ?? new Date()).toISOString();
  const excluded = await recordExclusions(opts.featureDir, refused, opts.refusal, at);
  const excludedSet = new Set(excluded);
  const launchable = createLaunchabilityChecker({ repoDir: opts.repoDir });
  const routeOptions: RouteWorkflowOptions & { repoDir: string } = {
    ...opts.routeOptions,
    repoDir: opts.repoDir,
    excludeModels: excluded,
    skipDifficultyClassification: true,
  };

  let substitute: string | null = null;
  let source: 'router' | 'deterministic' = 'router';
  try {
    const route = opts.route ?? routeWorkflowAuto;
    const decision = await route(readRoutingPrompt(opts.featureDir), routeOptions);
    const candidate = decision.reviewer?.trim();
    if (candidate && !excludedSet.has(candidate) && launchable(candidate, 'review').ok) {
      substitute = candidate;
    }
  } catch {
    // Routing failure is not a reason to stall; fall back below.
  }
  if (!substitute) {
    source = 'deterministic';
    substitute = findLaunchableSubstitute('reviewer', from, routeOptions, launchable);
  }

  if (!substitute) {
    return {
      status: 'no-eligible',
      from,
      reason: opts.refusal.reason,
      ...(opts.refusal.certification ? { certification: opts.refusal.certification } : {}),
      ...(opts.refusal.certifyCommand ? { certifyCommand: opts.refusal.certifyCommand } : {}),
      excluded,
    };
  }

  const check = launchable(substitute, 'review');
  const agent = 'agent' in check ? check.agent : '';
  await applyReviewerSubstitution({
    featureDir: opts.featureDir,
    issue: opts.issue,
    from,
    to: substitute,
    agent,
    provider: providerForModel(substitute, getEffectiveRegistry(opts.repoDir)),
    refusal: opts.refusal,
    source,
    at,
  });
  return {
    status: 'rerouted',
    from,
    to: substitute,
    agent,
    source,
    reason: opts.refusal.reason,
    ...(opts.refusal.certification ? { certification: opts.refusal.certification } : {}),
    excluded,
  };
}
