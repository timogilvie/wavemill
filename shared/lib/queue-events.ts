/**
 * Queue/CI/Repair Lifecycle Events — HOK-3339
 *
 * Single writer module for the Tend merge lane to emit deduplicated, validated
 * lifecycle events. Events are appended to a JSONL log file with deduplication
 * by eventId. Reads and writes validate against the queue-lifecycle-event schema.
 *
 * Key design rules:
 * - Only this module writes queue/CI/repair events
 * - Append is best-effort: logs and reports failures without blocking merges
 * - Deduplicates by eventId to handle crash/resume cycles
 * - Validates all events on read and write
 * - Uses atomic append operations to prevent corruption
 *
 * @see shared/lib/queue-metrics.ts — the one derivation module reading these
 *   events into queue/CI/repair durations and time-to-land (HOK-3340).
 * @see docs/queue-metrics.md — boundary table and modeling decisions.
 * @module queue-events
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export type QueueEventType =
  | 'candidate_prepared'
  | 'enqueued'
  | 'check_run_completed'
  | 'rebase_performed'
  | 'repair_commit_pushed'
  | 'rerun_requested'
  | 'ejected'
  | 'merged'
  | 'dequeued'
  | 'abandoned';

export interface QueueLifecycleEvent {
  eventId: string;
  eventType: QueueEventType;
  timestamp: string;
  prNumber: number;
  headSha: string;
  candidateId?: string;
  attempt?: number;
  actor?: string;
  reason?: string;
  executedModel?: string | null;
}

// ────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────

interface ValidationError {
  message: string;
  instancePath?: string;
  keyword?: string;
}

let schemaValidator: Ajv2020 | null = null;
let eventValidator: ReturnType<Ajv2020['compile']> | null = null;

function loadSchemaSync(): Record<string, unknown> {
  // Resolve schema from the repo root
  const currentDir = dirname(new URL(import.meta.url).pathname);
  const repoRoot = dirname(currentDir);
  const schemaPath = join(repoRoot, 'schemas', 'queue-lifecycle-event.schema.json');
  const content = readFileSync(schemaPath, 'utf-8');
  return JSON.parse(content);
}

function getEventValidator() {
  if (!eventValidator) {
    if (!schemaValidator) {
      schemaValidator = new Ajv2020({ removeAdditional: false });
    }
    const schema = loadSchemaSync();
    eventValidator = schemaValidator.compile(schema);
  }
  return eventValidator;
}

export function validateQueueEvent(event: unknown): { ok: true } | { ok: false; errors: ValidationError[] } {
  const validator = getEventValidator();
  const valid = validator(event);
  if (!valid) {
    const errors: ValidationError[] = (validator.errors || []).map((err: ErrorObject) => ({
      message: err.message || 'Validation error',
      instancePath: err.instancePath,
      keyword: err.keyword,
    }));
    return { ok: false, errors };
  }
  return { ok: true };
}

// ────────────────────────────────────────────────────────────────
// I/O
// ────────────────────────────────────────────────────────────────

function getEventLogPath(mergeStateDir: string): string {
  return join(mergeStateDir, '.queue-events.jsonl');
}

/**
 * Read all events from the event log, validating and deduplicating by eventId.
 * Returns an empty array if the log doesn't exist. Returns only valid events;
 * invalid lines are logged as warnings and skipped.
 */
export async function readQueueEvents(mergeStateDir: string): Promise<QueueLifecycleEvent[]> {
  const eventLogPath = getEventLogPath(mergeStateDir);

  if (!existsSync(eventLogPath)) {
    return [];
  }

  const content = readFileSync(eventLogPath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim());

  const eventById = new Map<string, QueueLifecycleEvent>();

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      const validation = validateQueueEvent(event);
      if (validation.ok) {
        // Deduplicate: keep latest event for each eventId
        eventById.set(event.eventId, event);
      } else {
        const errors = validation.errors || [];
        console.warn(`Invalid queue event in log: ${errors.map((e) => e.message).join('; ')}`);
      }
    } catch (error) {
      console.warn(`Failed to parse queue event line: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return Array.from(eventById.values());
}

/**
 * Append an event to the event log atomically. Deduplicates by eventId:
 * if an event with the same eventId already exists, this is a no-op.
 *
 * Best-effort: if validation or append fails, logs the error and returns
 * the error wrapped; never throws or blocks callers.
 */
export async function appendQueueEventBestEffort(
  mergeStateDir: string,
  event: Omit<QueueLifecycleEvent, 'timestamp'> & { timestamp?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    // Fill in timestamp if not provided
    const fullEvent: QueueLifecycleEvent = {
      ...event,
      timestamp: event.timestamp || new Date().toISOString(),
    };

    // Validate
    const validation = validateQueueEvent(fullEvent);
    if (!validation.ok) {
      const errors = validation.errors || [];
      const errorMsg = errors.map((e) => `${e.instancePath || 'root'}: ${e.message}`).join('; ');
      return { ok: false, error: `Validation failed: ${errorMsg}` };
    }

    // Check for duplicates
    const existing = await readQueueEvents(mergeStateDir);
    if (existing.some((e) => e.eventId === fullEvent.eventId)) {
      // Duplicate eventId: idempotent no-op
      return { ok: true };
    }

    // Append atomically
    const eventLogPath = getEventLogPath(mergeStateDir);
    mkdirSync(mergeStateDir, { recursive: true });

    appendFileSync(eventLogPath, JSON.stringify(fullEvent) + '\n', 'utf-8');

    return { ok: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Append failed: ${errorMsg}` };
  }
}
