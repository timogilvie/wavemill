// HOK-3338 queue/CI/repair lifecycle event logger
// This module is the sole writer of queue lifecycle events with schema validation

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
    }).catch(() => {
      // Ignore Observer write failures
    });
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

/**
 * Atomic artifact write utilities using the temp-file + atomic-rename pattern.
 * Prevents corruption from concurrent writes or unexpected termination.
 */

import { writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Write a JSON artifact atomically to a file path.
 *
 * Pattern:
 * 1. Create parent directories
 * 2. Serialize data to JSON
 * 3. Write to temp file (includes random suffix to avoid collisions)
 * 4. Atomically rename temp to target (atomic at OS level)
 *
 * This ensures:
 * - Concurrent writers don't corrupt each other
 * - Incomplete writes don't overwrite valid artifacts
 * - On crash, temp files can be cleaned up without affecting valid data
 *
 * @param filePath - Target file path
 * @param data - Data to serialize and write
 * @throws On JSON serialization or I/O errors
 */
export async function writeArtifactAtomic(
  filePath: string,
  data: unknown,
): Promise<void> {
  const dir = dirname(filePath);
  const filename = basename(filePath);
  const randomSuffix = randomBytes(4).toString('hex');
  const tempFile = join(dir, `.${filename}.${randomSuffix}.tmp`);

  try {
    // Ensure parent directory exists
    mkdirSync(dir, { recursive: true });

    // Serialize to JSON
    const jsonString = JSON.stringify(data, null, 2);

    // Write to temp file
    writeFileSync(tempFile, jsonString, 'utf-8');

    // Atomically rename (atomic at OS level)
    renameSync(tempFile, filePath);
  } catch (err) {
    // Best-effort cleanup of temp file on error
    try {
      unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Synchronous version of writeArtifactAtomic.
 * Use when async is not available (e.g., in sync contexts).
 *
 * @param filePath - Target file path
 * @param data - Data to serialize and write
 */
export function writeArtifactAtomicSync(
  filePath: string,
  data: unknown,
): void {
  const dir = dirname(filePath);
  const filename = basename(filePath);
  const randomSuffix = randomBytes(4).toString('hex');
  const tempFile = join(dir, `.${filename}.${randomSuffix}.tmp`);

  try {
    // Ensure parent directory exists
    mkdirSync(dir, { recursive: true });

    // Serialize to JSON
    const jsonString = JSON.stringify(data, null, 2);

    // Write to temp file
    writeFileSync(tempFile, jsonString, 'utf-8');

    // Atomically rename
    renameSync(tempFile, filePath);
  } catch (err) {
    // Best-effort cleanup of temp file on error
    try {
      unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}
