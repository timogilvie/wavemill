#!/usr/bin/env -S npx tsx
/** Preflight guard (HOK-3448): one boundary for Claude CLI stdout and tool reports. */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli, type GuardSpec } from './lib/source-guard.ts';

export const REVIEW_REPORT_BOUNDARY_GUARD: GuardSpec = {
  name: 'review-report-boundary',
  findingNoun: 'review-report boundary violation(s)',
  suppressionMarker: 'allow-review-report-boundary',
  allowlistFile: 'tools/review-report-boundary-allowlist.txt',
  invariantPaths: [
    'shared/lib/model-adapters/claude-cli-output.ts',
    'tools/check-review-report-boundary.ts',
  ],
  patterns: [
    {
      name: 'retired-text-completion',
      description: 'looksLikeJson and unwrapJsonEnvelope were deleted in HOK-3448; use the single claude-cli-output boundary.',
      lang: 'both',
      re: /\blooksLikeJson\b|\bunwrapJsonEnvelope\b/,
    },
    {
      name: 'private-report-findings',
      description: 'The literal ReportFindings string belongs in claude-cli-output.ts; import the type/source from there.',
      lang: 'both',
      scopedPaths: ['shared/lib/llm-cli.ts', 'shared/lib/model-adapters/', 'shared/lib/review-engine.ts'],
      re: /\bReportFindings\b/,
    },
    {
      name: 'private-claude-envelope-is_error',
      description: 'Reading .is_error outside claude-cli-output.ts duplicates the single stdout interpreter.',
      lang: 'ts',
      scopedPaths: ['shared/lib/llm-cli.ts', 'shared/lib/model-adapters/', 'shared/lib/review-engine.ts'],
      re: /\.is_error\b/,
    },
    {
      name: 'private-claude-envelope-total_cost_usd',
      description: 'Reading total_cost_usd outside claude-cli-output.ts duplicates the single stdout interpreter.',
      lang: 'ts',
      scopedPaths: ['shared/lib/llm-cli.ts', 'shared/lib/model-adapters/', 'shared/lib/review-engine.ts'],
      re: /\btotal_cost_usd\b/,
    },
    {
      name: 'private-claude-envelope-modelUsage',
      description: 'Reading modelUsage outside claude-cli-output.ts duplicates the single stdout interpreter.',
      lang: 'ts',
      scopedPaths: ['shared/lib/llm-cli.ts', 'shared/lib/model-adapters/', 'shared/lib/review-engine.ts'],
      re: /\bmodelUsage\b/,
    },
    {
      name: 'private-tool-use-scan',
      description: 'Scanning tool_use blocks outside claude-cli-output.ts duplicates the single stdout interpreter.',
      lang: 'ts',
      scopedPaths: ['shared/lib/model-adapters/', 'shared/lib/review-engine.ts'],
      re: /type\s*===?\s*['"]tool_use['"]/,
    },
  ],
  remediation: [
    'Claude CLI stdout, ReportFindings reports, and review completion decisions live in shared/lib/model-adapters/claude-cli-output.ts.',
    'Use AdapterInvokeResult.structuredReport/structuredReportError in review-engine; do not re-parse the verbose array.',
  ],
};

const filename = fileURLToPath(import.meta.url);
if (process.argv[1] === filename) {
  runGuardCli(REVIEW_REPORT_BOUNDARY_GUARD, process.argv[2] ?? join(dirname(filename), '..'));
}
