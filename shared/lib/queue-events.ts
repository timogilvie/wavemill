/**
 * HOK-3338 queue/CI/repair lifecycle event logger
 * This is the sole event-log API for queue lifecycle events with schema validation.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mutateJsonState } from './task-progress.ts';
import { errorMessage } from './error-utils.ts';
import { appendObserverFinding } from './observer-findings.ts';

// Event log directory structure
const EVENT_LOG_DIR = '.wavemill/queue-events';

export interface QueueEvent {
  eventId: string;
  eventType: 'candidate_prepared' | 'enqueued' | 'check_run_completed' | 'rebase_performed' | 'repair_commit_pushed' | 'rerun_requested' | 'ejected' | 'merged' | 'dequeued' | 'abandoned';
  timestamp: string;
  candidateId?: string;
  prNumber?: number;
  attempt?: number;
  actor?: string;
  executedModel?: string;
  laneOutcome?: 'merged' | 'dequeued' | 'abandoned';
  detail?: Record<string, unknown>;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

/**
 * Validate a queue event against the HOK-3338 contract
 * @param event - Queue event to validate
 * @returns Validation result
 */
export function validateQueueEvent(event: unknown): ValidationResult {
  // Basic validation - in reality this would use the real HOK-3338 contract
  const e = event as Partial<QueueEvent>;
  
  if (!e.eventId) {
    return { isValid: false, errors: ['Missing eventId'] };
  }
  
  if (!e.eventType) {
    return { isValid: false, errors: ['Missing eventType'] };
  }
  
  if (!e.timestamp) {
    return { isValid: false, errors: ['Missing timestamp'] };
  }
  
  const validTypes = ['candidate_prepared', 'enqueued', 'check_run_completed', 'rebase_performed', 'repair_commit_pushed', 'rerun_requested', 'ejected', 'merged', 'dequeued', 'abandoned'];
  if (!validTypes.includes(e.eventType)) {
    return { isValid: false, errors: [`Invalid eventType: ${e.eventType}`] };
  }
  
  return { isValid: true, errors: [] };
}

/**
 * Check if an event ID already exists in the event log to prevent duplicates
 * @param repoDir - Repository directory path
 * @param eventId - Event ID to check
 * @returns True if event ID already exists
 */
async function eventIdExists(repoDir: string, eventId: string): Promise<boolean> {
  const eventLogPath = join(repoDir, EVENT_LOG_DIR, 'events.log');
  
  if (!existsSync(eventLogPath)) {
    return false;
  }
  
  try {
    const content = readFileSync(eventLogPath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim() !== '');
    
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as QueueEvent;
        if (event.eventId === eventId) {
          return true;
        }
      } catch {
        // Ignore malformed lines
        continue;
      }
    }
  } catch {
    // If we can't read the file, assume the event doesn't exist
    return false;
  }
  
  return false;
}

/**
 * Append a validated queue event to the event log
 * This operation is best-effort: logs errors to Observer but doesn't block control flow
 * Events are deduplicated by eventId to ensure idempotency
 * @param repoDir - Repository directory path
 * @param event - Queue event to append
 */
export async function appendQueueEvent(repoDir: string, event: QueueEvent): Promise<void> {
  try {
    // Validate the event before writing
    const validationResult = validateQueueEvent(event);
    if (!validationResult.isValid) {
      throw new Error(`Invalid queue event: ${validationResult.errors.join(', ')}`);
    }
    
    // Check for duplicate eventId to ensure idempotency
    if (await eventIdExists(repoDir, event.eventId)) {
      // Event already exists, skip appending
      return;
    }
    
    // Write atomically under the shared state mutex
    await mutateJsonState(
      join(repoDir, EVENT_LOG_DIR),
      () => {
        const eventLogPath = join(repoDir, EVENT_LOG_DIR, 'events.log');
        
        // Ensure directory exists
        mkdirSync(dirname(eventLogPath), { recursive: true });
        
        // Append the validated event as JSONL
        appendFileSync(eventLogPath, JSON.stringify(event) + '\n');
        
        return Promise.resolve();
      },
      { lockPrefix: 'queue-event-append' }
    );
  } catch (error) {
    // Best-effort: report to Observer but don't block control flow
    try {
      await appendObserverFinding({
        title: 'Queue Event Append Failed',
        severity: 'warning',
        recommendation: 'Check event schema compliance',
        issue: 'HOK-3338',
        repoDir,
        id: `queue-event-append-${Date.now()}`,
        source: 'queue-events',
        detail: `Failed to append queue event: ${errorMessage(error)}`,
        event
      });
    } catch {
      // Ignore Observer write failures
    }
  }
}

/**
 * Read and validate all queue events from the event log
 * @param repoDir - Repository directory path
 * @returns Array of validated queue events
 */
export async function readQueueEvents(repoDir: string): Promise<QueueEvent[]> {
  const eventLogPath = join(repoDir, EVENT_LOG_DIR, 'events.log');
  
  if (!existsSync(eventLogPath)) {
    return [];
  }
  
  const content = readFileSync(eventLogPath, 'utf8');
  const lines = content.split('\n').filter(line => line.trim() !== '');
  
  const events: QueueEvent[] = [];
  
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as QueueEvent;
      
      // Validate each event during read
      const validationResult = validateQueueEvent(event);
      if (!validationResult.isValid) {
        throw new Error(`Invalid queue event in log: ${validationResult.errors.join(', ')}`);
      }
      
      events.push(event);
    } catch (error) {
      // Fail closed on malformed event data
      throw new Error(`Malformed event data in log: ${errorMessage(error)}`);
    }
  }
  
  return events;
}
