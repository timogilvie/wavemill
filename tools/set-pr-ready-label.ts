#!/usr/bin/env -S npx tsx

import { fileURLToPath } from 'node:url';
import { getPullRequest, type PullRequest } from '../shared/lib/github.ts';
import { WM_LABELS, setWavemillMerging, setWavemillReady } from '../shared/lib/pr-state-labels.ts';
import { isMatchingTendClaim, readReadyTendHandoff } from '../shared/lib/ready-tend-handoff.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

export const setPrReadyLabelDeps = {
  getPullRequest,
  setWavemillReady,
  setWavemillMerging,
  log: console.log,
};

export interface SetPrReadyLabelOutcome {
  outcome: 'ready' | 'tend-owned';
  pr: PullRequest;
}

export function setPrReadyLabel(
  prNumber: string,
  repo?: string,
  markerRoot?: string,
  featureDir?: string,
  headSha?: string,
): SetPrReadyLabelOutcome {
  if (!prNumber) {
    throw new Error('PR number is required');
  }

  const options = {
    ...(repo ? { repo } : {}),
    ...(markerRoot ? { markerRoot } : {}),
  };
  const matchingTendClaim = (): boolean => Boolean(featureDir && headSha
    && isMatchingTendClaim(readReadyTendHandoff(featureDir), Number(prNumber), headSha));

  // A Tend claim is durable ownership. Do not undo its merge-lane label just
  // because Ready's earlier label write is completing late.
  if (featureDir && headSha) {
    const observed = setPrReadyLabelDeps.getPullRequest(prNumber, options);
    if (new Set(observed.labels.map((label) => label.name)).has(WM_LABELS.merging) && matchingTendClaim()) {
      setPrReadyLabelDeps.log(`Tend already owns PR #${observed.number}; retaining ${WM_LABELS.merging}`);
      return { outcome: 'tend-owned', pr: observed };
    }
  }

  let pr = setPrReadyLabelDeps.setWavemillReady(prNumber, options);

  // Tend can claim after the pre-write observation. Restore its lane lock
  // rather than reporting Ready as failed; the matching token proves this is
  // the same head, not an unrelated concurrent mutation.
  if (matchingTendClaim()) {
    pr = setPrReadyLabelDeps.setWavemillMerging(prNumber, options);
    setPrReadyLabelDeps.log(`Tend claimed PR #${pr.number} during Ready finalization; retaining ${WM_LABELS.merging}`);
    return { outcome: 'tend-owned', pr };
  }

  // Verify the write actually landed before claiming success.
  //
  // A label mutation can report success while changing nothing -- `gh pr edit
  // --add-label` fails on a Projects-classic GraphQL deprecation, and the mill
  // has logged "Restored ready labels for PR #N" on consecutive polls while the
  // PR stayed wm:blocked. A log line that lies about the outcome turns a
  // one-line fix into a long diagnosis, so fail loudly instead.
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
    const observed = [...labels].sort().join(', ') || '(none)';
    throw new Error(
      `Ready label reconciliation failed for PR #${pr.number}: ${problems.join('; ')}. Observed labels: [${observed}]`,
    );
  }

  setPrReadyLabelDeps.log(`Canonicalized ready labels for PR #${pr.number}`);
  return { outcome: 'ready', pr };
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
    'feature-dir': {
      type: 'string',
      description: 'Ready artifact directory used to recognize a matching Tend claim',
    },
    head: {
      type: 'string',
      description: 'Current GitHub PR head SHA for the handoff token',
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
    const result = setPrReadyLabel(positional[0], args.repo, args['marker-root'], args['feature-dir'], args.head);
    console.log(JSON.stringify({ outcome: result.outcome, prNumber: result.pr.number }));
  },
} as const;

if (isMainModule) {
  runTool(config);
}
