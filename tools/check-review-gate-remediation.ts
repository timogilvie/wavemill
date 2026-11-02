#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-2890): enforce review-gate remediation decision unification.
 *
 * Forbidden:
 * - `isRemediable` / `isReviewRemediable` / `isGateRemediable` or any
 *   `canBeRemediated` / `isRecoverable` scoped to review-gate — these are
 *   competing private classifiers; the one disposition lives in
 *   `shared/lib/review-gate-remediation.ts`.
 * - `notify_review_scope_agent` / `notify_review_rejection_agent` — use the
 *   shared `agent_remediation_deliver` helper.
 * - `wavemill_pane_send_message` calls introduced for review-gate purposes
 *   outside `agent-remediation-delivery.sh` — the shared delivery helper is
 *   the one review-gate transport.
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
    'shared/lib/review-gate-remediation.test.ts',
    'shared/lib/agent-remediation-delivery.sh',
    'tools/review-gate-remediation-cli.ts',
    'tools/check-review-gate-remediation.ts',
  ],
  patterns: [
    {
      name: 'private-remediability-classifier',
      description:
        'isRemediable / isReviewRemediable / isGateRemediable is a competing private classifier; use decideReviewGateRemediation / dispositionFromReviewArtifactSignals.',
      lang: 'ts',
      re: /function\s+(?:isRemediable|isReviewRemediable|isGateRemediable|isReviewGateRemediable)\s*\(/,
    },
    {
      name: 'notify-review-scope-agent-reintroduction',
      description:
        'Use the shared agent_remediation_deliver helper in agent-remediation-delivery.sh instead of a review-scope-specific notifier.',
      lang: 'both',
      re: /\bnotify_review_scope_agent\b|\bnotify_review_rejection_agent\b|\bnotify_review_agent\b/,
    },
    {
      name: 'review-gate-pane-send-outside-helper',
      description:
        'wavemill_pane_send_message for review-gate purposes must route through shared/lib/agent-remediation-delivery.sh.',
      lang: 'sh',
      re: /wavemill_pane_send_message\s+[^\n]*(?:review-gate|review_gate|review-scope-stop|review-gate-remediation)/,
    },
  ],
  remediation: [
    'The review-gate remediation decision is centralized in shared/lib/review-gate-remediation.ts.',
    'Agent delivery uses shared/lib/agent-remediation-delivery.sh via agent_remediation_deliver.',
    'Pre-D7a review artifacts without typed findings[] route through',
    'dispositionFromReviewArtifactSignals, which preserves review_result_infra_failure semantics.',
  ],
};

if (process.argv[1] === __filename) {
  runGuardCli(REVIEW_GATE_REMEDIATION_GUARD, process.argv[2] ?? defaultRepoRoot);
}
