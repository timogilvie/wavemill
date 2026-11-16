#!/usr/bin/env -S npx tsx
/**
 * Preflight: a PR change enters a model prompt only through the one builder,
 * and a PR's diff is read only through the one reader (HOK-3493).
 *
 * Two forbidden shapes:
 * - a `gh pr diff` call outside `fetchPrDiff` (a second diff reader would see
 *   a different change than the reviewer saw);
 * - a prompt byte/character cap outside the builder (how much fits a model is
 *   the transport adapter's answer, and an unfittable change is its typed
 *   `context-window-exceeded`).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli, type GuardSpec } from './lib/source-guard.ts';

export const MODEL_INPUT_GUARD: GuardSpec = {
  name: 'model-input',
  invariantDocs: ['docs/invariants/model-input.md'],
  findingNoun: 'model-input bypass(es)',
  suppressionMarker: 'allow-model-input',
  allowlistFile: 'tools/model-input-allowlist.txt',
  invariantPaths: ['tools/check-model-input.ts'], // install-paths: allow source-guard file identity, not an executable argv
  patterns: [
    {
      name: 'gh-pr-diff-outside-reader',
      description: 'Read a PR diff through fetchPrDiff (pr-diff-provider.ts), never with a private `gh pr diff` call.',
      lang: 'ts',
      re: /['"]pr['"]\s*,\s*['"]diff['"]|\bgh\s+pr\s+diff\b/,
      excludePaths: ['shared/lib/pr-diff-provider.ts'],
    },
    {
      name: 'gh-pr-diff-outside-reader',
      description: 'Read a PR diff through fetchPrDiff (pr-diff-provider.ts), never with a private `gh pr diff` call.',
      lang: 'sh',
      re: /\bgh\s+pr\s+diff\b/,
    },
    {
      name: 'prompt-byte-cap',
      description: 'Build change-carrying prompt text with buildBudgetedChangeInput; over budget is the adapter\'s typed refusal, not a byte cap.',
      lang: 'ts',
      re: /\b(?:max\w*Prompt\w*(?:Bytes|Chars)|[A-Z_]*PROMPT[A-Z_]*_(?:BYTES|CHARS))\b|\btruncate\w*ForPrompt\b/,
      excludePaths: ['shared/lib/review-input-budget.ts'],
    },
  ],
  remediation: [
    'A PR change enters a prompt only through buildBudgetedChangeInput in shared/lib/review-input-budget.ts (pass the model adapter and a template filled with an empty change slot).',
    'A PR diff is read only through fetchPrDiff in shared/lib/pr-diff-provider.ts (local git first, then gh pr diff).',
    'Never add a prompt byte/char cap: when the change cannot fit, throw ChangeInputRefusedError(adapter.preflight(prompt)) and record adapterError.policyKind.',
  ],
};

const filename = fileURLToPath(import.meta.url);
if (process.argv[1] === filename) {
  runGuardCli(MODEL_INPUT_GUARD, process.argv[2] ?? join(dirname(filename), '..'));
}
