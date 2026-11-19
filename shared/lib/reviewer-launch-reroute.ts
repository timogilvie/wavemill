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
import { writePersistedContract } from './execution-contract.ts';
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
  repoDir: string;
  issue: string;
  from: string;
  to: string;
  refusal: ReviewerLaunchRefusal;
  source: 'router' | 'deterministic';
  at: string;
}): Promise<string> {
  const substitution = {
    from: input.from,
    to: input.to,
    reason: input.refusal.reason,
    ...(input.refusal.certification ? { certification: input.refusal.certification } : {}),
    source: input.source,
    at: input.at,
  };

  // HOK-3511: the one contract writer derives agent and provider from the
  // substitute model, and (HOK-3363) appends the override to the route record,
  // where the eval and the Hokusai contribution row read it.
  const written = await writePersistedContract({
    featureDir: input.featureDir,
    repoDir: input.repoDir,
    stages: [{
      stageRole: 'review',
      model: input.to,
      selectedAt: input.at,
      extra: { launchSubstitution: substitution },
    }],
    routeOverride: {
      source: 'launchability',
      reason: input.refusal.reason,
      ...(input.refusal.certification ? { certification: input.refusal.certification } : {}),
      at: input.at,
    },
  });

  const routingCompletePath = join(input.featureDir, '.routing-complete');
  if (existsSync(routingCompletePath)) {
    await mutateJsonState<Record<string, unknown>>(routingCompletePath, (current) => ({
      ...current,
      // allow-stage-launchability: the HOK-3363 override was appended above by writePersistedContract (routeOverride)
      reviewer: input.to,
    }));
  }

  appendFileSync(
    join(input.featureDir, REVIEWER_ROUTE_SUBSTITUTIONS_LOG),
    `${JSON.stringify({ issue: input.issue, role: 'reviewer', ...substitution })}\n`,
  );
  return written.stages.review?.agent ?? '';
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

  const agent = await applyReviewerSubstitution({
    featureDir: opts.featureDir,
    repoDir: opts.repoDir,
    issue: opts.issue,
    from,
    to: substitute,
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
