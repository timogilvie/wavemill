// allow-queue-event-writer: this file *is* the queue-event writer guard
// guard; its pattern table names every forbidden shape. It is auto-excluded
// from its own scan (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the one queue event writer (HOK-3338).
 *
 * The invariant is that every queue/CI/repair event is written exclusively 
 * through shared/lib/queue-events.ts, which provides schema validation,
 * atomic writes, and deduplication by eventId. This guard fails when a site
 * tries to write events directly or declare local event shapes.
 */
import type { GuardSpec } from '../tools/lib/source-guard.ts';

export const QUEUE_EVENT_WRITER_GUARD: GuardSpec = {
  name: 'queue-event-writers',
  findingNoun: 'forbidden queue event shape(s) or write(s)',
  suppressionMarker: 'allow-queue-event-write',
  allowlistFile: 'tools/check-queue-event-writers.allowlist',
  invariantPaths: [
    // The one authorized writer and its tests/wrappers.
    'shared/lib/queue-events.ts',
    'tools/check-queue-event-writers.ts',
    'tools/check-queue-event-writers.allowlist',
    // Tend controller is allowed to import and use the queue-events module
    'shared/lib/tend-controller.ts',
  ],
  patterns: [
    {
      name: 'queue-event-interface-declaration',
      description: 'Local QueueEvent declaration outside the invariant source',
      lang: 'ts',
      re: /^\s*export\s+interface\s+QueueEvent\b/,
      excludePaths: ['shared/lib/queue-events.ts'], // The invariant source is allowed to declare it
    },
    {
      name: 'queue-event-type-alias',
      description: 'Local QueueEvent type alias outside the invariant source',
      lang: 'ts',
      re: /^\s*export\s+type\s+QueueEvent\b.*=/,
      excludePaths: ['shared/lib/queue-events.ts'],
    },
    {
      name: 'queue-event-write',
      description: 'Direct queue event write outside the invariant source',
      lang: 'ts',
      re: /\bappendQueueEvent\s*\(/,
      excludePaths: ['shared/lib/queue-events.ts'],
    },
    {
      name: 'queue-event-import',
      description: 'Import of queue event types outside the invariant source',
      lang: 'ts',
      re: /import.*QueueEvent/,
      excludePaths: [
        'shared/lib/queue-events.ts',
        'shared/lib/tend-controller.ts', // This is OK - it imports from queue-events.ts
      ],
    },
  ],
  structuralChecks: [],
  remediation: [
    'Queue/CI/repair events must be written exclusively through shared/lib/queue-events.ts.',
    'That module provides schema validation, atomic writes, and deduplication by eventId.',
    'Direct writes or local event shapes bypass these safety guarantees.',
    '',
    'To emit a queue event:',
    '1. Import appendQueueEvent from shared/lib/queue-events.ts',
    '2. Construct a QueueEvent with a stable eventId',
    '3. Call appendQueueEvent with the event',
    '',
    'Never declare local QueueEvent interfaces or write events directly.',
  ],
};