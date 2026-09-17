#!/usr/bin/env -S npx tsx

import { fileURLToPath } from 'node:url';
import { WM_LABELS, setWavemillReady } from '../shared/lib/pr-state-labels.ts';
import { isTendClaimedForHead } from '../shared/lib/ready-tend-handoff.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

export const setPrReadyLabelDeps = {
  setWavemillReady,
  isTendClaimedForHead,
  log: console.log,
};

export interface SetPrReadyLabelResult {
  prNumber: number;
  tendClaimed: boolean;
}

export function setPrReadyLabel(prNumber: string, repo?: string, markerRoot?: string, handoffStateDir?: string): SetPrReadyLabelResult {
  if (!prNumber) {
    throw new Error('PR number is required');
  }

  const pr = setPrReadyLabelDeps.setWavemillReady(prNumber, {
    ...(repo ? { repo } : {}),
    ...(markerRoot ? { markerRoot } : {}),
  });

  // Verify the write actually landed before claiming success.
  //
  // setWavemillReady re-fetches after mutating, so these labels are post-write
  // state rather than the values we asked for.
  const labels = new Set(pr.labels.map((label) => label.name));
  const missing = labels.has(WM_LABELS.ready) ? [] : [`missing ${WM_LABELS.ready}`];
  const lingering = [WM_LABELS.blocked, WM_LABELS.merging]
    .filter((label) => labels.has(label))
    .map((label) => `still has ${label}`);
  const problems = [...missing, ...lingering];

  if (problems.length > 0) {
    // If wm:merging is present (with or without wm:ready missing — Tend removes
    // wm:ready when it applies wm:merging) and Tend has legitimately claimed this
    // PR for the same head, treat this as a successful handoff rather than a
    // Ready label failure (HOK-3038).
    const mergingIsFromTend = labels.has(WM_LABELS.merging)
      && !labels.has(WM_LABELS.blocked);
    if (mergingIsFromTend && handoffStateDir) {
      const headSha = pr.headRefOid ?? '';
      if (headSha && setPrReadyLabelDeps.isTendClaimedForHead(handoffStateDir, Number(prNumber), headSha)) {
        setPrReadyLabelDeps.log(`Tend claimed PR #${pr.number} during Ready finalization — treating as successful handoff`);
        return { prNumber: pr.number, tendClaimed: true };
      }
    }

    const observed = [...labels].sort().join(', ') || '(none)';
    throw new Error(
      `Ready label reconciliation failed for PR #${pr.number}: ${problems.join('; ')}. Observed labels: [${observed}]`,
    );
  }

  setPrReadyLabelDeps.log(`Canonicalized ready labels for PR #${pr.number}`);
  return { prNumber: pr.number, tendClaimed: false };
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

const config = {
  name: 'set-pr-ready-label',
  description: 'Canonicalize the Wavemill ready labels on a GitHub pull request',
  options: {
    repo: {
      type: 'string',
      description: 'Repository in owner/repo format (defaults to current repo)',
    },
    'marker-root': {
      type: 'string',
      description: 'Shared repository root for the PR-state marker sidecar',
    },
    'handoff-state-dir': {
      type: 'string',
      description: 'Feature/state directory for ready-tend handoff record',
    },
  },
  positional: {
    name: 'pr-number',
    description: 'Pull request number',
    required: true,
  },
  examples: [
    'npx tsx tools/set-pr-ready-label.ts 229',
    'npx tsx tools/set-pr-ready-label.ts 229 --repo owner/repo',
  ],
  async run({ args, positional }) {
    setPrReadyLabel(positional[0], args.repo, args['marker-root'], args['handoff-state-dir']);
  },
} as const;

if (isMainModule) {
  runTool(config);
}
