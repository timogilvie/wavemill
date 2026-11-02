// allow-queue-events: this file *is* the queue-events guard; its pattern
// table names every forbidden shape. It is auto-excluded from its own scan.
/**
 * Preflight guard for the one-queue-events-writer invariant (HOK-3339,
 * enforced by HOK-3236): all queue/CI/repair lifecycle events are written
 * exclusively by `shared/lib/queue-events.ts::appendQueueEventBestEffort`.
 *
 * Three mechanical shapes give a second writer away:
 *
 * - calling a queue-event write function outside `queue-events.ts`;
 * - defining a local QueueLifecycleEvent or QueueEventType type outside the
 *   canonical module;
 * - appending directly to a `.queue-events.jsonl` file outside the module.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const QUEUE_EVENTS_GUARD: GuardSpec = {
  name: 'queue-event-writers',
  findingNoun: 'queue/CI/repair event write site(s) outside the canonical module',
  suppressionMarker: 'allow-queue-event-writers',
  allowlistFile: 'tools/queue-events-writers-allowlist.txt',
  invariantPaths: [
    'shared/lib/queue-events.ts',
    'shared/lib/queue-events.test.ts',
    'shared/lib/queue-events-guard.ts',
    'tools/check-queue-event-writers.ts',
  ],
  patterns: [
    {
      name: 'queue-event-write-call',
      description: 'call to `appendQueueEventBestEffort` or other queue-events write function outside the canonical module',
      lang: 'ts',
      re: /appendQueueEventBestEffort|appendQueueEvent/,
    },
    {
      name: 'local-queue-event-type',
      description: 'definition of QueueLifecycleEvent, QueueEventType, or similar local event types — these belong exclusively in queue-events.ts',
      lang: 'ts',
      re: /(?:type|interface)\s+(Queue(?:Lifecycle)?Event|QueueEventType)/,
    },
    {
      name: 'direct-log-append',
      description: 'direct append to .queue-events.jsonl file — use appendQueueEventBestEffort instead',
      lang: 'both',
      re: /\.queue-events\.jsonl/,
    },
  ],
  remediation: [
    'All queue/CI/repair lifecycle events must be written through the',
    'canonical `appendQueueEventBestEffort` function in',
    '`shared/lib/queue-events.ts`. This ensures consistent validation,',
    'deduplication, and error handling across all event writes.',
  ],
};
