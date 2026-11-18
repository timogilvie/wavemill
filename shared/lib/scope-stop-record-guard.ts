// allow-scope-stop-record: this is the invariant definition.
/**
 * Invariant (HOK-3457): every review scope-guard refusal must record a typed
 * `.review-scope-stop.json` finding through `writeMarker` before exiting, and
 * no prompt or production code may instruct the agent to wait, pause, or
 * stop-but-not-exit on a scope stop. See docs/invariants/scope-stop-record.md.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const SCOPE_STOP_RECORD_GUARD: GuardSpec = {
  name: 'scope-stop-record',
  findingNoun: 'scope-stop regressions',
  invariantDocs: ['docs/invariants/scope-stop-record.md'],
  suppressionMarker: 'allow-scope-stop-record',
  allowlistFile: 'tools/scope-stop-record-allowlist.txt',
  invariantPaths: [
    'shared/lib/scope-stop-record-guard.ts',
    'tools/check-scope-stop-record.ts',
    'tools/check-review-scope.ts',
  ],
  patterns: [
    {
      name: 'stop-review-fix-committing',
      lang: 'both',
      re: /stop\s+review-fix\s+committing/i,
      description:
        'Old scope-stop phrasing; the agent must exit 1 immediately after the tool writes the stop record.',
    },
    {
      name: 'wait-on-scope-violation',
      lang: 'both',
      re: /\b(?:wait|pause)\s+for\s+(?:the\s+)?(?:operator|scope)/i,
      description:
        'Scope-stop handling must not wait for an operator; the mill returns the task to coding automatically.',
    },
  ],
  remediation: [
    'HOK-3457: let the scope-stop producer (tools/check-review-scope.ts) write .review-scope-stop.json and exit;',
    'the review-phase prompt and adapter say "exit 1 immediately" — never "stop review-fix committing" or "wait".',
  ],
};
