#!/usr/bin/env -S npx tsx

import { fileURLToPath } from 'node:url';
import { githubDeps, type PullRequest, type PullRequestUpdateOptions } from '../shared/lib/github.ts';
import {
  extractMetadataBlock,
  parsePrMetadata,
  PR_ROUTE_METADATA_SCHEMA_VERSION,
  stableJsonStringify,
  updatePrMetadata,
  type ExecutedPrRoute,
  type PrMetadata,
  type PrRouteDecision,
} from '../shared/lib/pr-metadata.ts';
import { reconcilePrRoute, type ReconcilePrRouteResult } from '../shared/lib/pr-route-provenance.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

export interface StampPrRouteInput {
  prNumber: string;
  issue: string;
  featureDir: string;
  repo?: string;
  requireComplete?: boolean;
}

export interface StampPrRouteDeps {
  getPullRequest(prNumber: string, options: { repo?: string }): PullRequest;
  updatePullRequest(prNumber: string, options: PullRequestUpdateOptions): PullRequest;
  resolveOwnerRepo(): string;
  reconcile(input: { issue: string; featureDir: string; currentHeadSha: string }): Promise<ReconcilePrRouteResult>;
}

export interface StampPrRouteResult {
  prNumber: number;
  updated: boolean;
  complete: boolean;
  diagnostics: string[];
  route: ExecutedPrRoute;
  /** Route decision published as `route_decision`, when one is known. */
  decision: PrRouteDecision | null;
}

interface StampedRoute {
  route: ExecutedPrRoute;
  decision: PrRouteDecision | null;
}

export const stampPrRouteDeps: StampPrRouteDeps = {
  getPullRequest: (prNumber, options) => githubDeps.getPullRequest(prNumber, options),
  updatePullRequest: (prNumber, options) => githubDeps.updatePullRequest(prNumber, options),
  resolveOwnerRepo: () => githubDeps.resolveOwnerRepo(),
  reconcile: (input) => reconcilePrRoute(input),
};

function redactMessage(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/gh[opusr]_[A-Za-z0-9_]+/g, '[redacted-token]')
    .replace(/(token|secret|password|api[_-]?key)=\S+/gi, '$1=[redacted]')
    .replace(/\/Users\/[^\s"']+/g, '[redacted-path]')
    .replace(/\/tmp\/[^\s"']+/g, '[redacted-path]');
}

function routeValue(meta: PrMetadata): string {
  return meta.executed_route ? stableJsonStringify(meta.executed_route) : '';
}

function decisionValue(decision: PrRouteDecision | null | undefined): string {
  return decision ? stableJsonStringify(decision) : '';
}

function metadataMatches(meta: PrMetadata, expected: StampedRoute): boolean {
  return meta.route_schema === PR_ROUTE_METADATA_SCHEMA_VERSION
    && routeValue(meta) === stableJsonStringify(expected.route)
    && decisionValue(meta.route_decision) === decisionValue(expected.decision);
}

const ROUTE_DECISION_LINE = /^route_decision:.*$/m;

/**
 * Parses the current PR metadata. A malformed `route_decision` alone must not
 * block stamping (HOK-3098 is best-effort), so when it is the only problem the
 * line is dropped and the rest of the block is kept.
 */
function parseCurrentMetadata(body: string): ReturnType<typeof parsePrMetadata> {
  const parsed = parsePrMetadata(body);
  if (parsed.ok === true || !parsed.errors.every((error) => error.field === 'route_decision')) {
    return parsed;
  }
  const { block } = extractMetadataBlock(body);
  if (block === null) return parsed;
  return parsePrMetadata(body.replace(block, block.replace(ROUTE_DECISION_LINE, '')));
}

function mergeRouteMetadata(body: string, expected: StampedRoute): string {
  const parsed = parseCurrentMetadata(body);
  if (parsed.ok === false) {
    throw new Error(`Invalid wavemill-meta block: ${parsed.errors.map((error) => `${error.field}:${error.code}`).join(', ')}`);
  }
  const { route_decision: _previousDecision, ...rest } = parsed.metadata;
  return updatePrMetadata(body, {
    ...rest,
    route_schema: PR_ROUTE_METADATA_SCHEMA_VERSION,
    executed_route: expected.route,
    ...(expected.decision ? { route_decision: expected.decision } : {}),
  });
}

function assertVerified(body: string, expected: StampedRoute): void {
  const parsed = parsePrMetadata(body);
  if (parsed.ok === false) {
    throw new Error(`Post-write wavemill-meta parse failed: ${parsed.errors.map((error) => `${error.field}:${error.code}`).join(', ')}`);
  }
  if (parsed.metadata.route_schema !== PR_ROUTE_METADATA_SCHEMA_VERSION) {
    throw new Error('Post-write route_schema verification failed');
  }
  if (routeValue(parsed.metadata) !== stableJsonStringify(expected.route)) {
    throw new Error('Post-write executed_route verification mismatch');
  }
  if (decisionValue(parsed.metadata.route_decision) !== decisionValue(expected.decision)) {
    throw new Error('Post-write route_decision verification mismatch');
  }
}

/**
 * The decision to publish: the latest one recorded for the task, else the one
 * the PR already carries. A decision is recorded once and never rewritten, so
 * re-stamping on a new head (or from a feature dir whose routing.jsonl was
 * lost) carries the original decision forward instead of dropping it.
 */
function resolveStampedDecision(
  reconciled: PrRouteDecision | null,
  current: PrMetadata | null,
): PrRouteDecision | null {
  return reconciled ?? current?.route_decision ?? null;
}

export async function stampPrRoute(
  input: StampPrRouteInput,
  deps: StampPrRouteDeps = stampPrRouteDeps,
): Promise<StampPrRouteResult> {
  if (!input.prNumber.trim()) throw new Error('PR number is required');
  if (!input.issue.trim()) throw new Error('Issue is required');
  if (!input.featureDir.trim()) throw new Error('Feature directory is required');

  const repo = input.repo?.trim() || deps.resolveOwnerRepo();
  if (!repo) throw new Error('Unable to determine GitHub repository. Pass --repo owner/repo.');

  const pr = deps.getPullRequest(input.prNumber, { repo });
  const currentHeadSha = pr.headRefOid?.trim();
  if (!currentHeadSha) {
    throw new Error(`PR #${pr.number} is missing headRefOid; cannot stamp route freshness`);
  }

  const reconciliation = await deps.reconcile({
    issue: input.issue,
    featureDir: input.featureDir,
    currentHeadSha,
  });

  if (input.requireComplete && !reconciliation.complete) {
    throw new Error(
      `Route evidence incomplete for PR #${pr.number}: ${reconciliation.diagnostics.join('; ') || 'unknown route evidence missing'}`,
    );
  }

  const diagnostics = [...reconciliation.diagnostics];
  const currentParsed = parseCurrentMetadata(pr.body ?? '');
  let expected: StampedRoute = {
    route: reconciliation.route,
    decision: resolveStampedDecision(
      reconciliation.decision ?? null,
      currentParsed.ok ? currentParsed.metadata : null,
    ),
  };
  let nextBody: string;
  try {
    nextBody = mergeRouteMetadata(pr.body ?? '', expected);
  } catch (err) {
    // The decision is best-effort: if it cannot be rendered, stamp the
    // executed route alone rather than failing the ready stage.
    if (!expected.decision) throw err;
    diagnostics.push(`route_decision: omitted (${redactMessage(err)})`);
    expected = { ...expected, decision: null };
    nextBody = mergeRouteMetadata(pr.body ?? '', expected);
  }
  // No-op only when the body already parses strictly and matches; a dropped
  // malformed route_decision line still needs a rewrite.
  const strictCurrent = parsePrMetadata(pr.body ?? '');
  if (strictCurrent.ok && metadataMatches(strictCurrent.metadata, expected)) {
    assertVerified(pr.body ?? '', expected);
    return {
      prNumber: pr.number,
      updated: false,
      complete: reconciliation.complete,
      diagnostics,
      route: reconciliation.route,
      decision: expected.decision,
    };
  }

  const updated = deps.updatePullRequest(input.prNumber, { repo, body: nextBody });
  assertVerified(updated.body ?? '', expected);
  return {
    prNumber: pr.number,
    updated: true,
    complete: reconciliation.complete,
    diagnostics,
    route: reconciliation.route,
    decision: expected.decision,
  };
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

const config = {
  name: 'stamp-pr-route',
  description: 'Stamp evidence-backed executed route and route decision metadata on a Wavemill PR',
  options: {
    issue: {
      type: 'string',
      description: 'Linear issue id for the Wavemill task',
    },
    'feature-dir': {
      type: 'string',
      description: 'Feature artifact directory containing stage results',
    },
    repo: {
      type: 'string',
      description: 'Repository in owner/repo format (defaults to current repo)',
    },
    'require-complete': {
      type: 'boolean',
      description: 'Fail when planner, coder, and reviewer execution evidence is incomplete',
    },
  },
  positional: {
    name: 'pr-number',
    description: 'Pull request number',
    required: true,
  },
  examples: [
    'npx tsx tools/stamp-pr-route.ts 229 --issue HOK-2945 --feature-dir features/my-task',
    'npx tsx tools/stamp-pr-route.ts 229 --issue HOK-2945 --feature-dir features/my-task --repo owner/repo',
  ] as string[],
  async run({ args, positional }) {
    if (!args.issue) throw new Error('--issue is required');
    if (!args['feature-dir']) throw new Error('--feature-dir is required');

    try {
      const result = await stampPrRoute({
        prNumber: positional[0],
        issue: args.issue,
        featureDir: args['feature-dir'],
        repo: args.repo,
        requireComplete: args['require-complete'] === true,
      });
      console.log(JSON.stringify({
        prNumber: result.prNumber,
        updated: result.updated,
        complete: result.complete,
        decisionId: result.decision?.decision_id ?? null,
        diagnostics: result.diagnostics,
      }));
    } catch (err) {
      throw new Error(redactMessage(err));
    }
  },
} as const;

if (isMainModule) {
  runTool(config);
}
