#!/usr/bin/env -S npx tsx

import { execSync } from 'node:child_process';
import { runTool } from '../shared/lib/tool-runner.ts';
import { readAllStageResults } from '../shared/lib/stage-result.ts';
import {
  parsePrMetadata,
  renderPrMetadata,
  updatePrMetadata,
  type PrMetadata,
} from '../shared/lib/pr-metadata.ts';
import {
  reconcileRoute,
  renderExecutedRoute,
  ROUTE_SCHEMA_VERSION,
  type ReconcileInput,
  type InheritedStageDescriptor,
} from '../shared/lib/pr-route-provenance.ts';
import { errorMessage } from '../shared/lib/error-utils.ts';

function ghExec(args: string[], repo?: string): string {
  const repoArgs = repo ? ['--repo', repo] : [];
  const cmd = ['gh', ...args, ...repoArgs].join(' ');
  return execSync(cmd, { encoding: 'utf-8', timeout: 30_000 }).trim();
}

interface PrData {
  body: string;
  headSha: string;
}

function fetchPr(prNumber: string, repo?: string): PrData {
  const json = ghExec(
    ['pr', 'view', prNumber, '--json', 'body,headRefOid'],
    repo,
  );
  const parsed = JSON.parse(json) as { body: string; headRefOid: string };
  return { body: parsed.body ?? '', headSha: parsed.headRefOid };
}

function updatePrBody(prNumber: string, body: string, repo?: string): void {
  const repoArgs = repo ? ['--repo', repo] : [];
  const cmd = ['gh', 'pr', 'edit', prNumber, '--body-file', '-', ...repoArgs].join(' ');
  execSync(cmd, { input: body, encoding: 'utf-8', timeout: 30_000 });
}

export interface StampResult {
  stamped: boolean;
  skipped: boolean;
  route: string;
  diagnostics: string[];
}

export async function stampPrRoute(opts: {
  prNumber: string;
  issueId: string;
  featureDir: string;
  repo?: string;
  inheritedStages?: InheritedStageDescriptor[];
}): Promise<StampResult> {
  const pr = fetchPr(opts.prNumber, opts.repo);

  const stageResults = await readAllStageResults(opts.featureDir);

  const input: ReconcileInput = {
    issueId: opts.issueId,
    prHeadSha: pr.headSha,
    stageResults,
    inheritedStages: opts.inheritedStages,
  };

  const { route, diagnostics } = reconcileRoute(input);
  const routeJson = renderExecutedRoute(route);

  const parsed = parsePrMetadata(pr.body);
  const existingMeta: PrMetadata = parsed.ok ? parsed.metadata : {};

  const updatedMeta: PrMetadata = {
    ...existingMeta,
    route_schema: ROUTE_SCHEMA_VERSION,
    executed_route: routeJson,
  };

  const newBody = updatePrMetadata(pr.body, updatedMeta);

  if (newBody === pr.body) {
    return { stamped: false, skipped: true, route: routeJson, diagnostics };
  }

  updatePrBody(opts.prNumber, newBody, opts.repo);

  const verify = fetchPr(opts.prNumber, opts.repo);
  const verifyParsed = parsePrMetadata(verify.body);
  if (verifyParsed.ok === false) {
    const errorMessages = verifyParsed.errors.map((e) => e.message).join('; ');
    throw new Error(`Post-write verification failed: metadata parse errors: ${errorMessages}`);
  }
  if (verifyParsed.metadata.executed_route !== routeJson) {
    throw new Error('Post-write verification failed: executed_route mismatch');
  }

  return { stamped: true, skipped: false, route: routeJson, diagnostics };
}

runTool({
  name: 'stamp-pr-route',
  description: 'Stamp executed route provenance into a PR wavemill-meta block',
  options: {
    issue: {
      type: 'string',
      description: 'Linear issue ID (e.g. HOK-1234)',
    },
    'feature-dir': {
      type: 'string',
      description: 'Path to the feature directory containing stage results',
    },
    repo: {
      type: 'string',
      description: 'Repository in owner/repo format (defaults to current repo)',
    },
  },
  positional: {
    name: 'pr-number',
    description: 'Pull request number',
    required: true,
  },
  examples: [
    'npx tsx tools/stamp-pr-route.ts 42 --issue HOK-1234 --feature-dir features/my-feature',
  ],
  async run({ args, positional }) {
    const prNumber = positional[0];
    if (!prNumber) {
      throw new Error('PR number is required');
    }
    const issueId = args.issue as string | undefined;
    if (!issueId) {
      throw new Error('--issue is required');
    }
    const featureDir = args['feature-dir'] as string | undefined;
    if (!featureDir) {
      throw new Error('--feature-dir is required');
    }

    try {
      const result = await stampPrRoute({
        prNumber,
        issueId,
        featureDir,
        repo: args.repo as string | undefined,
      });

      if (result.skipped) {
        console.log(`Route metadata already up to date for PR #${prNumber}`);
      } else {
        console.log(`Stamped route metadata on PR #${prNumber}`);
      }

      if (result.diagnostics.length > 0) {
        console.error(`Route diagnostics: ${result.diagnostics.join('; ')}`);
      }
    } catch (err) {
      const msg = errorMessage(err).replace(/ghp_[a-zA-Z0-9]+/g, '<redacted>');
      console.error(`Failed to stamp route on PR #${prNumber}: ${msg}`);
      process.exit(1);
    }
  },
});
