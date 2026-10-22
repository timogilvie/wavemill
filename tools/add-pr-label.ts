#!/usr/bin/env -S npx tsx

import { fileURLToPath } from 'node:url';
import { runTool } from '../shared/lib/tool-runner.ts';
import { addLabelsToPullRequest, getPullRequest } from '../shared/lib/github.ts';

/**
 * Shared dependency seam for CLI tests.
 */
export const addPrLabelDeps = {
  getPullRequest,
  addLabelsToPullRequest,
  log: console.log,
};

/**
 * Add labels to a pull request while skipping labels already present.
 *
 * @param prNumber - Pull request number
 * @param labelNames - One or more label names to add
 * @param repo - Optional owner/repo override
 */
export async function addPrLabels(
  prNumber: string,
  labelNames: string[],
  repo?: string,
): Promise<void> {
  if (!prNumber || labelNames.length === 0) {
    throw new Error('PR number and at least one label name are required');
  }

  const pr = addPrLabelDeps.getPullRequest(prNumber, { repo });
  addPrLabelDeps.log(`Found: PR #${pr.number} - ${pr.title}`);

  const existingLabels = new Set(pr.labels.map((label) => label.name));
  const normalizedLabels = labelNames
    .map((label) => label.trim())
    .filter((label, index, all) => label.length > 0 && all.indexOf(label) === index);

  if (normalizedLabels.length === 0) {
    throw new Error('At least one non-empty label name is required');
  }

  const newLabels = normalizedLabels.filter((label) => !existingLabels.has(label));

  if (newLabels.length === 0) {
    addPrLabelDeps.log(`All labels already exist on PR #${pr.number}`);
    return;
  }

  await addPrLabelDeps.addLabelsToPullRequest(pr.number, newLabels, { repo });

  addPrLabelDeps.log(`Added ${newLabels.length} label(s) to PR #${pr.number}: ${newLabels.join(', ')}`);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

const config = {
  name: 'add-pr-label',
  description: 'Add labels to a GitHub pull request using the REST API',
  options: {
    repo: {
      type: 'string',
      description: 'Repository in owner/repo format (defaults to current repo)',
    },
  },
  positional: {
    name: 'prNumber labels...',
    description: 'PR number and one or more label names',
    required: true,
    multiple: true,
  },
  examples: [
    'npx tsx tools/add-pr-label.ts 229 "HOK-1305"',
    'npx tsx tools/add-pr-label.ts 42 "bug" "high-priority"',
    'npx tsx tools/add-pr-label.ts 15 "feature" --repo owner/repo',
  ],
  additionalHelp: [
    'Notes:',
    '  - Uses `gh api` against the REST labels endpoint to avoid the deprecated',
    // allow-side-effect-ledger: help text naming the avoided command.
    '    GraphQL path behind `gh pr edit --add-label`.',
    '  - GitHub may auto-create repository labels that do not already exist.',
  ].join('\n'),
  async run({ args, positional }) {
    const [prNumber, ...labelNames] = positional;
    await addPrLabels(prNumber, labelNames, args.repo);
  },
};

if (isMainModule) {
  runTool(config);
}
