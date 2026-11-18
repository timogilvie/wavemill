/**
 * Invariant: Every review scope-guard refusal must record a typed
 * `.review-scope-stop.json` finding through `writeMarker` before exiting.
 * The prompt must never instruct the agent to wait, pause, or
 * stop-but-not-exit on a scope stop.
 *
 * See docs/invariants/scope-stop-record.md for the full invariant specification.
 */

import type { GuardSpec } from '../tools/lib/source-guard.ts';

export const scopeStopRecordGuard: GuardSpec = {
  name: 'scope-stop-record',
  description: 'Review scope guard refusals must record findings before exiting',
  forbiddenPatterns: [
    {
      // Forbidden phrases that pair a review scope guard failure with "wait", "do not exit"
      pattern: /stop review-fix committing/i,
      message: 'Review scope guard refusals must not instruct the agent to "stop review-fix committing" without also saying "exit 1 immediately"'
    },
    {
      // Forbidden phrases that tell the agent to wait on scope
      pattern: /wait.*scope/i,
      message: 'Review scope guard refusals must not instruct the agent to wait on scope violations'
    },
    {
      // Forbidden phrases that tell the agent to pause or stop-but-not-exit
      pattern: /pause.*scope|stop.*scope.*but.*not.*exit/i,
      message: 'Review scope guard refusals must not instruct the agent to pause or stop-but-not-exit on scope violations'
    }
  ],
  allowedPatterns: [
    {
      // Allow the approved exit-immediately phrasing
      pattern: /exit 1 immediately/i,
      message: 'Approved phrasing for immediate exit on scope stop'
    }
  ]
};