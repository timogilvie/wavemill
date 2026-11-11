// allow-attention: this file *is* the attention guard; its pattern table names
// every forbidden shape. It is auto-excluded from its own scan via
// invariantPaths; the marker above is defensive.
/**
 * Preflight guard for the one attention decision (HOK-3423): "does this task
 * need a human, and why?" is answered only by `deriveAttentionItems` in
 * `shared/lib/attention.ts`, and the dashboard inbox renders only its
 * projection (`.wavemill/attention.json`).
 *
 * Shapes caught:
 * - `actionable-classification` — the retired `is_actionable_state` and its
 *   private detail readers, or a new `echo "actionable"` classification.
 * - `inbox-membership` — a write to the dashboard's `inbox_tasks` outside the
 *   projection reader (suppressed on the one line that renders the projection
 *   in its order).
 * - `raw-needs-attention-read` — reading the `.needs-attention` marker outside
 *   the escalation module (HOK-3360, the writer), the condition reconciler
 *   (HOK-3172, the expiry owner) and `attention.ts`. Existing readers are held
 *   by the counted ratchet in `tools/attention-allowlist.txt` (the Observer's
 *   go in slice 2/2).
 * - `raw-hook-state-inbox-case` — classifying attention from a raw hook state
 *   (`exited|waiting|blocked|approval-needed|policy-denied|error`) instead of
 *   the HOK-3101 task-progress primitive.
 * - `private-exhaustion-recheck` — re-checking `stage-failure-ready`
 *   exhaustion that the escalation step already recorded in `.needs-attention`.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const ATTENTION_GUARD: GuardSpec = {
  name: 'attention',
  invariantDocs: ['docs/invariants/attention.md'],
  findingNoun: 'attention decision(s) outside the one projection',
  suppressionMarker: 'allow-attention',
  allowlistFile: 'tools/attention-allowlist.txt',
  invariantPaths: [
    'shared/lib/attention.ts',
    'shared/lib/attention-guard.ts',
    'tools/attention-projection.ts', // install-paths: allow invariantPaths list, not an argv target
    'tools/check-attention.ts', // install-paths: allow invariantPaths list, not an argv target
    'shared/lib/operator-escalation.ts',
    'shared/lib/operator-escalation.sh',
    'shared/lib/condition-reconciler.sh',
  ],
  patterns: [
    {
      name: 'actionable-classification',
      description: 'private inbox classification — add the source to deriveAttentionItems (shared/lib/attention.ts)',
      lang: 'sh',
      re: /\bis_actionable_state\b|\bcoding_blocked_completion_detail\b|\bplanning_rejection_detail\b|\bready_attention_detail\b|\becho\s+"?actionable"?(\s|;|$)/,
    },
    {
      name: 'inbox-membership',
      description: 'inbox membership written outside the attention projection reader — render attention.json',
      lang: 'both',
      re: /\binbox_tasks\+=|\binbox(Tasks|Items)\s*(\.push\(|=\s*\[)/,
    },
    {
      name: 'raw-needs-attention-read',
      description: 'raw .needs-attention read — consume the attention projection (or the escalation module) instead',
      lang: 'both',
      re: /(\s-[efs]\s|\bcat\s|\bhead\s|\bjq\b|\bmarker_reason\b|readFileSync|\breadFile\(|existsSync|readMarker|\bjoin\()[^\n]*\.needs-attention(?![-.\w])/,
    },
    {
      name: 'raw-hook-state-inbox-case',
      description: 'attention decided from a raw hook state — read task-progress agentState/blockingPrompt through the projection',
      lang: 'sh',
      re: /exited\|waiting\|blocked\|approval-needed\|policy-denied\|error\)\s*echo\s+"?actionable/,
    },
    {
      name: 'private-exhaustion-recheck',
      description: 'private stage-failure-ready exhaustion re-check — the escalation basis in .needs-attention already records it',
      lang: 'sh',
      re: /bounded_retry_is_exhausted\s+[^\n]*["']?stage-failure-ready\b/,
    },
  ],
  remediation: [
    'HOK-3423: one attention decision feeds the inbox.',
    'Add a new attention source to deriveAttentionItems() in shared/lib/attention.ts',
    '(reading an existing primitive), and render .wavemill/attention.json; never',
    're-classify in the dashboard or add a raw .needs-attention reader.',
  ],
};
