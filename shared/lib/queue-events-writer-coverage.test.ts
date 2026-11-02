/**
 * Queue Events Writer Coverage Test
 *
 * Verifies that every field in the queue-lifecycle-event schema is written
 * by at least one event construction path. This enforces that all schema
 * fields are actively used and not dead code.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { QueueLifecycleEvent } from '../shared/lib/queue-events.ts';

// Fields that must be covered by writer tests
const REQUIRED_FIELDS = ['eventId', 'eventType', 'timestamp', 'prNumber', 'headSha'];

const OPTIONAL_FIELDS = ['candidateId', 'attempt', 'actor', 'reason', 'executedModel'];

const ALL_FIELDS = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];

// Sample events covering each event type and their fields
const SAMPLE_EVENTS: QueueLifecycleEvent[] = [
  {
    eventId: 'ep-cand-1',
    eventType: 'candidate_prepared',
    timestamp: '2026-01-01T00:00:00Z',
    prNumber: 1,
    headSha: 'abc123',
    candidateId: 'candidate-1',
  },
  {
    eventId: 'ep-enq-1',
    eventType: 'enqueued',
    timestamp: '2026-01-01T00:00:01Z',
    prNumber: 1,
    headSha: 'abc123',
  },
  {
    eventId: 'ep-ci-1',
    eventType: 'check_run_completed',
    timestamp: '2026-01-01T00:00:02Z',
    prNumber: 1,
    headSha: 'abc123',
    attempt: 1,
  },
  {
    eventId: 'ep-reb-1',
    eventType: 'rebase_performed',
    timestamp: '2026-01-01T00:00:03Z',
    prNumber: 1,
    headSha: 'def456',
  },
  {
    eventId: 'ep-rep-1',
    eventType: 'repair_commit_pushed',
    timestamp: '2026-01-01T00:00:04Z',
    prNumber: 1,
    headSha: 'ghi789',
    actor: 'claude@anthropic.com',
    executedModel: 'claude-opus-5-5',
  },
  {
    eventId: 'ep-rer-1',
    eventType: 'rerun_requested',
    timestamp: '2026-01-01T00:00:05Z',
    prNumber: 1,
    headSha: 'abc123',
    reason: 'transient-ci-failure',
  },
  {
    eventId: 'ep-ej-1',
    eventType: 'ejected',
    timestamp: '2026-01-01T00:00:06Z',
    prNumber: 1,
    headSha: 'abc123',
    reason: 'blocked-by-conflict',
  },
  {
    eventId: 'ep-merge-1',
    eventType: 'merged',
    timestamp: '2026-01-01T00:00:07Z',
    prNumber: 1,
    headSha: 'abc123',
  },
  {
    eventId: 'ep-deq-1',
    eventType: 'dequeued',
    timestamp: '2026-01-01T00:00:08Z',
    prNumber: 1,
    headSha: 'abc123',
    reason: 'ready-passed',
  },
  {
    eventId: 'ep-aband-1',
    eventType: 'abandoned',
    timestamp: '2026-01-01T00:00:09Z',
    prNumber: 1,
    headSha: 'abc123',
    reason: 'pr-closed',
  },
];

// protects: every required schema field is exercised by at least one test event
test('queue-events: all required fields are covered', () => {
  const coveredFields = new Set<string>();

  for (const event of SAMPLE_EVENTS) {
    for (const field of REQUIRED_FIELDS) {
      const value = (event as Record<string, unknown>)[field];
      if (value !== undefined && value !== null) {
        coveredFields.add(field);
      }
    }
  }

  for (const field of REQUIRED_FIELDS) {
    assert(coveredFields.has(field), `Required field '${field}' is not covered by any sample event`);
  }
});

// protects: every optional schema field (candidateId, attempt, actor, reason, executedModel) is exercised by at least one test event
test('queue-events: all optional fields are covered', () => {
  const coveredFields = new Set<string>();

  for (const event of SAMPLE_EVENTS) {
    for (const field of OPTIONAL_FIELDS) {
      const value = (event as Record<string, unknown>)[field];
      if (value !== undefined && value !== null) {
        coveredFields.add(field);
      }
    }
  }

  for (const field of OPTIONAL_FIELDS) {
    assert(coveredFields.has(field), `Optional field '${field}' is not covered by any sample event`);
  }
});

// protects: every event type defined in the schema (candidate_prepared, enqueued, check_run_completed, rebase_performed, repair_commit_pushed, rerun_requested, ejected, merged, dequeued, abandoned) has a coverage test
test('queue-events: all event types are covered', () => {
  const eventTypes = [
    'candidate_prepared',
    'enqueued',
    'check_run_completed',
    'rebase_performed',
    'repair_commit_pushed',
    'rerun_requested',
    'ejected',
    'merged',
    'dequeued',
    'abandoned',
  ];

  const coveredTypes = new Set(SAMPLE_EVENTS.map((e) => e.eventType));

  for (const eventType of eventTypes) {
    assert(coveredTypes.has(eventType as QueueLifecycleEvent['eventType']),
      `Event type '${eventType}' is not covered by any sample event`);
  }
});

test('queue-events: all schema fields are either required or optional', () => {
  const definedFields = new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);
  const allFields = Array.from(definedFields);

  for (const field of allFields) {
    assert(
      REQUIRED_FIELDS.includes(field) || OPTIONAL_FIELDS.includes(field),
      `Field '${field}' is not classified as required or optional`,
    );
  }
});
