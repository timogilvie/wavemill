#!/usr/bin/env -S npx tsx

import { fileURLToPath } from 'node:url';
import { githubDeps, type PullRequest, type PullRequestUpdateOptions } from '../shared/lib/github.ts';
import {
  parsePrMetadata,
  PR_ROUTE_METADATA_SCHEMA_VERSION,
  stableJsonStringify,
  updatePrMetadata,
  type ExecutedPrRoute,
  type PrMetadata,
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

function mergeRouteMetadata(body: string, route: ExecutedPrRoute): string {
  const parsed = parsePrMetadata(body);
  if (parsed.ok === false) {
    throw new Error(`Invalid wavemill-meta block: ${parsed.errors.map((error) => `${error.field}:${error.code}`).join(', ')}`);
  }
  return updatePrMetadata(body, {
    ...parsed.metadata,
    route_schema: PR_ROUTE_METADATA_SCHEMA_VERSION,
    executed_route: route,
  });
}

function assertVerified(body: string, expected: ExecutedPrRoute): void {
  const parsed = parsePrMetadata(body);
  if (parsed.ok === false) {
    throw new Error(`Post-write wavemill-meta parse failed: ${parsed.errors.map((error) => `${error.field}:${error.code}`).join(', ')}`);
  }
  if (parsed.metadata.route_schema !== PR_ROUTE_METADATA_SCHEMA_VERSION) {
    throw new Error('Post-write route_schema verification failed');
  }
  if (routeValue(parsed.metadata) !== stableJsonStringify(expected)) {
    throw new Error('Post-write executed_route verification mismatch');
  }
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

  const nextBody = mergeRouteMetadata(pr.body ?? '', reconciliation.route);
  const currentParsed = parsePrMetadata(pr.body ?? '');
  if (currentParsed.ok && routeValue(currentParsed.metadata) === stableJsonStringify(reconciliation.route)) {
    assertVerified(pr.body ?? '', reconciliation.route);
    return {
      prNumber: pr.number,
      updated: false,
      complete: reconciliation.complete,
      diagnostics: reconciliation.diagnostics,
      route: reconciliation.route,
    };
  }

  const updated = deps.updatePullRequest(input.prNumber, { repo, body: nextBody });
  assertVerified(updated.body ?? '', reconciliation.route);
  return {
    prNumber: pr.number,
    updated: true,
    complete: reconciliation.complete,
    diagnostics: reconciliation.diagnostics,
    route: reconciliation.route,
  };
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

const config = {
  name: 'stamp-pr-route',
  description: 'Stamp evidence-backed planner/coder/reviewer route metadata on a Wavemill PR',
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
