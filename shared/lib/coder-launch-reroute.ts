/**
 * Typed coder launch refusal → deterministic coder re-route (HOK-3142).
 *
 * When the coding launch gate refuses the routed coder for a deterministic
 * reason (e.g. `uncertified` / `missing_live_canary`), relaunching the same
 * route can never succeed. This module re-runs routing with every refused
 * coder excluded and replaces **only** the coder in the task's approved route
 * (`.phase-config.json` `coding.*`, `.routing-complete` `coder`). The planner,
 * reviewer, and depths the operator approved stay untouched.
 *
 * Exclusions accumulate in `<featureDir>/.coder-launch-exclusions.json`, so a
 * substitute that is refused in turn is excluded alongside the original. The
 * caller (the monitor) bounds the number of reroutes via the
 * `coding-launch-refused` bounded-retry bucket and terminalizes on
 * `no-eligible`.
 *
 * @module coder-launch-reroute
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

export const CODER_LAUNCH_EXCLUSIONS_FILE = '.coder-launch-exclusions.json';
export const ROUTE_SUBSTITUTIONS_LOG = '.route-substitutions.jsonl';

export interface CoderLaunchRefusal {
  /** Typed resolver reason, e.g. `uncertified`. */
  reason: string;
  /** Structured certification status, e.g. `missing_live_canary`. */
  certification?: string;
  certifyCommand?: string;
}

export interface CoderLaunchExclusion {
  model: string;
  reason: string;
  certification?: string;
  at: string;
}

export interface CoderLaunchExclusions {
  models: CoderLaunchExclusion[];
}

export type RerouteRefusedCoderResult =
  | {
    status: 'rerouted';
    from: string;
    to: string;
    agent: string;
    /** How the substitute was chosen. */
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

export interface RerouteRefusedCoderOptions {
  repoDir: string;
  featureDir: string;
  issue: string;
  /**
   * Refused coder ids. Pass both the routed model and the alias-resolved
   * launch model when they differ; the first entry is reported as `from`.
   */
  refusedModels: string[];
  refusal: CoderLaunchRefusal;
  /** Injectable for tests; defaults to `routeWorkflowAuto`. */
  route?: RouteFn;
  /** Extra routing constraints (e.g. a restricted `modelsAvailable` pool). */
  routeOptions?: Partial<RouteWorkflowOptions>;
  now?: Date;
}

export function readCoderLaunchExclusions(featureDir: string): CoderLaunchExclusions {
  const path = join(featureDir, CODER_LAUNCH_EXCLUSIONS_FILE);
  if (!existsSync(path)) {
    return { models: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<CoderLaunchExclusions>;
    return { models: Array.isArray(parsed.models) ? parsed.models.filter((entry) => typeof entry?.model === 'string') : [] };
  } catch {
    return { models: [] };
  }
}

async function recordExclusions(
  featureDir: string,
  models: string[],
  refusal: CoderLaunchRefusal,
  at: string,
): Promise<string[]> {
  const updated = await mutateJsonState<CoderLaunchExclusions>(
    join(featureDir, CODER_LAUNCH_EXCLUSIONS_FILE),
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

/**
 * Routing prompt for the reroute: the expanded task packet when present (the
 * same input expansion routed on), otherwise the selected task's description.
 */
export function readRoutingPrompt(featureDir: string): string {
  const packetPath = join(featureDir, 'task-packet.md');
  if (existsSync(packetPath)) {
    const packet = readFileSync(packetPath, 'utf-8').trim();
    if (packet) return packet;
  }
  const selectedPath = join(featureDir, 'selected-task.json');
  if (existsSync(selectedPath)) {
    try {
      const selected = JSON.parse(readFileSync(selectedPath, 'utf-8')) as Record<string, unknown>;
      const parts = [selected.title, selected.description].filter((part): part is string => typeof part === 'string' && part.length > 0);
      if (parts.length > 0) return parts.join('\n\n');
    } catch {
      // fall through to the empty prompt; deterministic fallback still works
    }
  }
  return '';
}

async function applyCoderSubstitution(input: {
  featureDir: string;
  repoDir: string;
  issue: string;
  from: string;
  to: string;
  refusal: CoderLaunchRefusal;
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
      stageRole: 'coding',
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
      coder: input.to,
    }));
  }

  appendFileSync(
    join(input.featureDir, ROUTE_SUBSTITUTIONS_LOG),
    `${JSON.stringify({ issue: input.issue, role: 'coder', ...substitution })}\n`,
  );
  return written.stages.coding?.agent ?? '';
}

/**
 * Re-route a coder the launch gate refused. Prefers a fresh routing decision
 * with the refused models excluded; when routing fails (e.g. Hokusai outage)
 * or its coder is still not launchable, walks the router's deterministic
 * substitution order so a remote failure can never block the reroute.
 */
export async function rerouteRefusedCoder(opts: RerouteRefusedCoderOptions): Promise<RerouteRefusedCoderResult> {
  const refused = [...new Set(opts.refusedModels.map((model) => model.trim()).filter(Boolean))];
  if (refused.length === 0) {
    throw new Error('rerouteRefusedCoder: at least one refused model is required');
  }
  const from = refused[0];
  const at = (opts.now ?? new Date()).toISOString();
  const excluded = await recordExclusions(opts.featureDir, refused, opts.refusal, at);
  const excludedSet = new Set(excluded);
  const launchable = createLaunchabilityChecker({ repoDir: opts.repoDir });
  const routeOptions: RouteWorkflowOptions & { repoDir: string } = {
    ...opts.routeOptions,
    repoDir: opts.repoDir,
    issueId: opts.issue,
    excludeModels: excluded,
    // Keep the reroute deterministic and cheap: no LLM difficulty classifier.
    skipDifficultyClassification: true,
  };

  let substitute: string | null = null;
  let source: 'router' | 'deterministic' = 'router';
  try {
    const route = opts.route ?? routeWorkflowAuto;
    const decision = await route(readRoutingPrompt(opts.featureDir), routeOptions);
    const candidate = decision.coder?.trim();
    if (candidate && !excludedSet.has(candidate) && launchable(candidate, 'coding').ok) {
      substitute = candidate;
    }
  } catch {
    // Routing failure is not a reason to stall; fall back below.
  }
  if (!substitute) {
    source = 'deterministic';
    substitute = findLaunchableSubstitute('coder', from, routeOptions, launchable);
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

  const agent = await applyCoderSubstitution({
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
