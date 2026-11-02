#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-2890): enforce review-gate remediation decision unification.
 *
 * Forbidden:
 * - `isRemediable` function (competing private classifier; use failure-policy)
 * - `notify_review_scope_agent` / `notify_review_rejection_agent` (use shared agent_remediation_deliver)
 *
 * Usage: npx tsx tools/check-review-gate-remediation.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import type { GuardSpec } from './lib/source-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

const REVIEW_GATE_REMEDIATION_GUARD: GuardSpec = {
  name: 'review-gate-remediation',
  findingNoun: 'private review-gate remediation classifier(s)',
  suppressionMarker: 'allow-review-gate-remediation',
  allowlistFile: 'tools/review-gate-remediation-allowlist.txt',
  invariantPaths: [
    'shared/lib/review-gate-remediation.ts',
    'shared/lib/agent-remediation-delivery.sh',
    'tools/review-gate-remediation-cli.ts',
    'tools/check-review-gate-remediation.ts',
  ],
  patterns: [
    {
      name: 'private-remediability-classifier',
      description: 'isRemediable is a competing private classifier; use failure-policy.ts classifyFailure instead',
      lang: 'ts',
      re: /function\s+isRemediable\s*\(/,
    },
    {
      name: 'notify-review-scope-agent-reintroduction',
      description: 'Use the shared agent_remediation_deliver helper in agent-remediation-delivery.sh instead',
      lang: 'both',
      re: /\bnotify_review_scope_agent\b|\bnotify_review_rejection_agent\b/,
    },
  ],
  remediation: [
    'The review-gate remediation decision is centralized in shared/lib/review-gate-remediation.ts',
    'and routed through failure-policy.ts. Agent delivery uses shared/lib/agent-remediation-delivery.sh.',
  ],
};

if (process.argv[1] === __filename) {
  runGuardCli(REVIEW_GATE_REMEDIATION_GUARD, process.argv[2] ?? defaultRepoRoot);
}
