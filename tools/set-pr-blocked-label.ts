#!/usr/bin/env -S npx tsx

import { fileURLToPath } from 'node:url';
import { getPullRequest, type PullRequest } from '../shared/lib/github.ts';
import { WM_LABELS, setWavemillBlocked } from '../shared/lib/pr-state-labels.ts';
import { escapeShellArg, execShellCommand } from '../shared/lib/shell-utils.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

export const setPrBlockedLabelDeps = {
  getPullRequest,
  setWavemillBlocked,
  execShellCommand,
  log: console.log,
};

export interface SetPrBlockedLabelOutcome {
  outcome: 'blocked' | 'unchanged';
  pr: PullRequest;
}

export function setPrBlockedLabel(
  prNumber: string,
  reason: string,
  repo?: string,
  markerRoot?: string,
  headSha?: string,
): SetPrBlockedLabelOutcome {
  if (!prNumber) {
    throw new Error('PR number is required');
  }
  if (!reason) {
    throw new Error('Reason is required');
  }

  const options = {
    ...(repo ? { repo } : {}),
    ...(markerRoot ? { markerRoot } : {}),
  };

  // Idempotency check: if the PR already carries wm:blocked and neither
  // wm:ready nor wm:merging, there is nothing to do. Monitor polling can
  // re-enter the failed branch many times per head; this label check is what
  // makes repeated invocations safe without any head-keyed storage of our own.
  const current = setPrBlockedLabelDeps.getPullRequest(prNumber, options);
  const currentLabels = new Set(current.labels.map((label) => label.name));
  if (
    currentLabels.has(WM_LABELS.blocked)
    && !currentLabels.has(WM_LABELS.ready)
    && !currentLabels.has(WM_LABELS.merging)
  ) {
    setPrBlockedLabelDeps.log(`PR #${current.number} already carries ${WM_LABELS.blocked}; no change`);
    return { outcome: 'unchanged', pr: current };
  }

  const pr = setPrBlockedLabelDeps.setWavemillBlocked(prNumber, { headSha, reason }, options);

  const shaDisplay = headSha ? headSha.slice(0, 7) : 'the current head';
  const body = [
    `⛔ Ready checks failed for commit \`${shaDisplay}\` and this PR has been demoted to \`${WM_LABELS.blocked}\`.`,
    '',
    `**Reason:** ${reason}`,
    '',
    'Push a new commit or ask an operator to investigate before it re-enters the merge queue.',
  ].join('\n');

  const repoFlag = options.repo ? ` --repo ${escapeShellArg(options.repo)}` : '';
  try {
    setPrBlockedLabelDeps.execShellCommand(
      `gh pr comment ${escapeShellArg(String(pr.number))} --body ${escapeShellArg(body)}${repoFlag}`,
      { encoding: 'utf-8' },
    );
  } catch (error) {
    // Best effort: the label transition is what tend reads. A comment failure
    // (API hiccup, rate limit) should not surface as a Ready-stage error.
    const message = error instanceof Error ? error.message : String(error);
    setPrBlockedLabelDeps.log(`Warning: failed to post blocked-label comment on PR #${pr.number}: ${message}`);
  }

  setPrBlockedLabelDeps.log(`Demoted PR #${pr.number} to ${WM_LABELS.blocked}`);
  return { outcome: 'blocked', pr };
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

const config = {
  name: 'set-pr-blocked-label',
  description: 'Demote a GitHub pull request to the Wavemill blocked label after a Ready failure',
  options: {
    reason: {
      type: 'string',
      description: 'Human-readable reason for the demotion (included in the PR comment)',
    },
    repo: {
      type: 'string',
      description: 'Repository in owner/repo format (defaults to current repo)',
    },
    'marker-root': {
      type: 'string',
      description: 'Shared repository root for the PR-state marker sidecar',
    },
    head: {
      type: 'string',
      description: 'Current GitHub PR head SHA',
    },
  },
  positional: {
    name: 'pr-number',
    description: 'Pull request number',
    required: true,
  },
  examples: [
    'npx tsx tools/set-pr-blocked-label.ts 229 --reason "Cross-PR revert guard blocked ready phase"',
    'npx tsx tools/set-pr-blocked-label.ts 229 --reason "Ready checks failed" --head abc1234 --repo owner/repo',
  ],
  async run({ args, positional }) {
    if (!args.reason) {
      throw new Error('--reason is required');
    }
    const result = setPrBlockedLabel(positional[0], args.reason, args.repo, args['marker-root'], args.head);
    console.log(JSON.stringify({ outcome: result.outcome, prNumber: result.pr.number }));
  },
} as const;

if (isMainModule) {
  runTool(config);
}
