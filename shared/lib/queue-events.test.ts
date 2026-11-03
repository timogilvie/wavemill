import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readQueueEvents,
  appendQueueEventBestEffort,
  validateQueueEvent,
  type QueueLifecycleEvent,
} from './queue-events.ts';

// protects: invalid event values are rejected by the schema validator
test('queue-events: validate event', () => {
  const event: QueueLifecycleEvent = {
    eventId: 'test-1',
    eventType: 'enqueued',
    timestamp: new Date().toISOString(),
    prNumber: 123,
    headSha: 'abc123',
  };

  const validation = validateQueueEvent(event);
  assert.strictEqual(validation.ok, true);
});

// protects: schema validation rejects invalid event type enums
test('queue-events: reject invalid event type', () => {
  const event = {
    eventId: 'test-1',
    eventType: 'invalid_type',
    timestamp: new Date().toISOString(),
    prNumber: 123,
    headSha: 'abc123',
  };

  const validation = validateQueueEvent(event);
  assert.strictEqual(validation.ok, false);
});

// protects: events are persisted to disk and re-read with all fields preserved
test('queue-events: append and read', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'queue-events-'));
  try {
    const event1: Omit<QueueLifecycleEvent, 'timestamp'> = {
      eventId: 'event-1',
      eventType: 'enqueued',
      prNumber: 123,
      headSha: 'abc123',
    };

    const result = await appendQueueEventBestEffort(stateDir, event1);
    assert.strictEqual(result.ok, true);

    const events = await readQueueEvents(stateDir);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].eventId, 'event-1');
    assert.strictEqual(events[0].eventType, 'enqueued');
    assert.strictEqual(events[0].prNumber, 123);
  } finally {
    rmSync(stateDir, { recursive: true });
  }
});

// protects: duplicate events with the same eventId are idempotent and not written twice to the log
test('queue-events: deduplicate by eventId', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'queue-events-'));
  try {
    const event: Omit<QueueLifecycleEvent, 'timestamp'> = {
      eventId: 'event-1',
      eventType: 'enqueued',
      prNumber: 123,
      headSha: 'abc123',
    };

    // Append twice
    let result = await appendQueueEventBestEffort(stateDir, event);
    assert.strictEqual(result.ok, true);

    result = await appendQueueEventBestEffort(stateDir, event);
    assert.strictEqual(result.ok, true);

    // Should only have one event
    const events = await readQueueEvents(stateDir);
    assert.strictEqual(events.length, 1);
  } finally {
    rmSync(stateDir, { recursive: true });
  }
});

// protects: multiple distinct events are all persisted and re-read in order
test('queue-events: handle multiple events', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'queue-events-'));
  try {
    const events = [
      { eventId: 'event-1', eventType: 'candidate_prepared' as const, prNumber: 123, headSha: 'abc123' },
      { eventId: 'event-2', eventType: 'enqueued' as const, prNumber: 123, headSha: 'abc123' },
      { eventId: 'event-3', eventType: 'check_run_completed' as const, prNumber: 123, headSha: 'abc123', attempt: 1 },
      { eventId: 'event-4', eventType: 'merged' as const, prNumber: 123, headSha: 'abc123' },
    ];

    for (const event of events) {
      const result = await appendQueueEventBestEffort(stateDir, event);
      assert.strictEqual(result.ok, true);
    }

    const read = await readQueueEvents(stateDir);
    assert.strictEqual(read.length, 4);
    assert.strictEqual(read[0].eventId, 'event-1');
    assert.strictEqual(read[1].eventId, 'event-2');
    assert.strictEqual(read[2].eventId, 'event-3');
    assert.strictEqual(read[3].eventId, 'event-4');
  } finally {
    rmSync(stateDir, { recursive: true });
  }
});

// protects: validation errors are reported and no invalid events are persisted
test('queue-events: append best-effort with invalid event', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'queue-events-'));
  try {
    const invalidEvent = {
      eventId: 'event-1',
      eventType: 'invalid',
      prNumber: 123,
      headSha: 'abc123',
    };

    const result = await appendQueueEventBestEffort(stateDir, invalidEvent as any);
    assert.strictEqual(result.ok, false);
    assert(result.error.includes('Validation failed'));

    // No events should be written
    const events = await readQueueEvents(stateDir);
    assert.strictEqual(events.length, 0);
  } finally {
    rmSync(stateDir, { recursive: true });
  }
});

// protects: reading from a non-existent log returns an empty array (graceful degradation)
test('queue-events: read empty log', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'queue-events-'));
  try {
    const events = await readQueueEvents(stateDir);
    assert.strictEqual(events.length, 0);
  } finally {
    rmSync(stateDir, { recursive: true });
  }
});

// protects: optional fields (actor, executedModel) are preserved when present
test('queue-events: preserve all fields', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'queue-events-'));
  try {
    const event: Omit<QueueLifecycleEvent, 'timestamp'> = {
      eventId: 'event-1',
      eventType: 'repair_commit_pushed',
      prNumber: 123,
      headSha: 'abc123',
      actor: 'claude@anthropic.com',
      executedModel: 'claude-opus-5-5',
    };

    const result = await appendQueueEventBestEffort(stateDir, event);
    assert.strictEqual(result.ok, true);

    const events = await readQueueEvents(stateDir);
    assert.strictEqual(events.length, 1);
    const read = events[0];
    assert.strictEqual(read.eventId, 'event-1');
    assert.strictEqual(read.eventType, 'repair_commit_pushed');
    assert.strictEqual(read.prNumber, 123);
    assert.strictEqual(read.headSha, 'abc123');
    assert.strictEqual(read.actor, 'claude@anthropic.com');
    assert.strictEqual(read.executedModel, 'claude-opus-5-5');
  } finally {
    rmSync(stateDir, { recursive: true });
  }
});
