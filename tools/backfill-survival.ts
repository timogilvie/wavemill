#!/usr/bin/env -S npx tsx

/**
 * Arbiter S2 survival-label backfill (HOK-2805).
 *
 * Enumerates merged PRs on an integration branch and emits one frozen
 * v1.0.0 survival label per PR per elapsed 14/30/60-day horizon as JSONL on
 * stdout. Diagnostics and per-repo/per-horizon base rates go to stderr only.
 *
 * Repo-agnostic: works against any local checkout given owner/repo/branch —
 * no wavemill state is read. The wavemill evals.jsonl join is a separate
 * caller-side layer.
 *
 * Scheduling (idempotent — latest computed_at per (prUrl, horizon) wins in
 * queries, so appending re-runs is safe). Example cron entry:
 *
 *   15 3 * * * cd /path/to/repo && npx tsx tools/backfill-survival.ts \
 *     --integration-branch auto/integration \
 *     >> .wavemill/evals/survival-labels.jsonl 2>> /tmp/backfill-survival.log
 */

import { resolve } from 'node:path';
import { execArgvCommand } from '../shared/lib/shell-utils.ts';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  createDefaultDeps,
  enumerateMergedPrs,
  isSkippedPr,
  labelMergedPr,
  resolveMergedPr,
  summarizeLabels,
  type MergedPrRef,
  type SurvivalLabellerTarget,
} from '../shared/lib/survival-labeller.ts';
import { HORIZONS, type ArbiterSurvivalLabelV1, type HorizonDays } from '../shared/lib/arbiter-survival-label.ts';

function detectOwnerRepo(repoDir: string): { owner: string; repo: string } | null {
  const result = execArgvCommand('git', ['-C', repoDir, 'remote', 'get-url', 'origin']);
  if (result.exitCode !== 0) return null;
  const match = result.stdout.trim().match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) return null;
  return { owner: match[1] as string, repo: match[2] as string };
}

function parseHorizons(raw: string | undefined): HorizonDays[] {
  if (!raw) return [...HORIZONS];
  const parsed = raw.split(',').map((part) => Number(part.trim()));
  const invalid = parsed.filter((value) => !(HORIZONS as readonly number[]).includes(value));
  if (invalid.length > 0) {
    throw new Error(`invalid horizons ${invalid.join(', ')}: allowed values are ${HORIZONS.join(', ')}`);
  }
  return parsed as HorizonDays[];
}

runTool({
  name: 'backfill-survival',
  description: 'Emit Arbiter S2 survival labels (JSONL) for merged PRs on an integration branch',
  options: {
    owner: { type: 'string', description: 'GitHub owner (default: parsed from origin remote)' },
    repo: { type: 'string', description: 'GitHub repo name (default: parsed from origin remote)' },
    'integration-branch': { type: 'string', description: 'Integration branch to walk (required; "main" is rejected)' },
    'repo-dir': { type: 'string', description: 'Local checkout to analyse (default: .)' },
    token: { type: 'string', description: 'GitHub token for gh calls (default: ambient gh auth)' },
    'pr-url': { type: 'string', description: 'Label a single PR URL instead of enumerating' },
    'max-prs': { type: 'string', description: 'Max merged PRs to enumerate (default: 1000)' },
    horizons: { type: 'string', description: 'Comma-separated horizons from 14,30,60 (default: all)' },
    'no-links': { type: 'boolean', description: 'Skip gh cross-reference lookups (offline/bulk runs)' },
  },
  examples: [
    'npx tsx tools/backfill-survival.ts --integration-branch auto/integration > survival-labels.jsonl',
    'npx tsx tools/backfill-survival.ts --owner foo --repo bar --integration-branch develop --repo-dir /tmp/bar --no-links',
    'npx tsx tools/backfill-survival.ts --integration-branch auto/integration --pr-url https://github.com/timogilvie/wavemill/pull/1348',
  ],
  run({ args }) {
    const repoDir = resolve((args['repo-dir'] as string | undefined) || '.');
    const integrationBranch = args['integration-branch'] as string | undefined;
    if (!integrationBranch) {
      throw new Error('--integration-branch is required');
    }
    let owner = args.owner as string | undefined;
    let repo = args.repo as string | undefined;
    if (!owner || !repo) {
      const detected = detectOwnerRepo(repoDir);
      if (!detected) {
        throw new Error('cannot detect owner/repo from origin remote; pass --owner and --repo');
      }
      owner = owner ?? detected.owner;
      repo = repo ?? detected.repo;
    }
    const target: SurvivalLabellerTarget = {
      owner,
      repo,
      integrationBranch,
      repoDir,
      token: args.token as string | undefined,
    };
    const deps = createDefaultDeps(target);
    deps.onDiagnostic = (message) => console.error(`[backfill-survival] ${message}`);
    const horizons = parseHorizons(args.horizons as string | undefined);
    const includeLinkedReferences = args['no-links'] === true ? false : undefined;
    const maxCount = args['max-prs'] ? Number(args['max-prs']) : 1000;

    let prs: MergedPrRef[];
    const allMergedPrs = enumerateMergedPrs(target, deps, { maxCount });
    if (args['pr-url']) {
      const resolved = resolveMergedPr(target, deps, args['pr-url'] as string);
      if (isSkippedPr(resolved)) {
        console.error(`[backfill-survival] skipped ${resolved.prUrl}: ${resolved.reason} (${resolved.detail})`);
        process.exitCode = 1;
        return;
      }
      prs = [resolved];
    } else {
      // Oldest first for stable, replayable output order.
      prs = [...allMergedPrs].sort(
        (a, b) => a.mergedAtEpoch - b.mergedAtEpoch || a.prNumber - b.prNumber,
      );
    }

    const labels: ArbiterSurvivalLabelV1[] = [];
    for (const pr of prs) {
      try {
        const prLabels = labelMergedPr(target, deps, pr, {
          horizons,
          allMergedPrs,
          ...(includeLinkedReferences === undefined ? {} : { includeLinkedReferences }),
        });
        for (const label of prLabels) {
          console.log(JSON.stringify(label));
          labels.push(label);
        }
      } catch (error) {
        console.error(`[backfill-survival] failed to label ${pr.prUrl}: ${String(error)}`);
      }
    }

    const summary = summarizeLabels(`${owner}/${repo}`, labels);
    console.error(JSON.stringify(summary, null, 2));
  },
});
