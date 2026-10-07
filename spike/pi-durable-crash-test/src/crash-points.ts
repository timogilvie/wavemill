// Crash Points
// Env-gated instrumentation that signals the parent at each kill point

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Crash point identifiers
 */
export type CrashPoint = 'A' | 'B' | 'C1' | 'C2' | 'C3';

/**
 * Signal that we've reached a crash point
 * Creates a file that the parent process can watch for
 */
export async function signalCrashPoint(point: CrashPoint, scratchDir: string): Promise<void> {
  const signalFile = join(scratchDir, '.crash-ready');
  await mkdir(scratchDir, { recursive: true });
  await writeFile(signalFile, point, 'utf8');
  
  // Block indefinitely until killed
  return new Promise(() => {
    // This will block until the process is killed
  });
}

/**
 * Check if we should inject a crash at a specific point
 * @returns The crash point if we should crash, undefined otherwise
 */
export function getCrashPoint(): CrashPoint | undefined {
  return process.env.HOK3150_CRASH_POINT as CrashPoint | undefined;
}

/**
 * Instrumentation for mid-model-request crash point (A)
 * Should be called when the first streamed partial of generation >=2 is committed
 */
export async function instrumentMidModelRequest(scratchDir: string): Promise<void> {
  const crashPoint = getCrashPoint();
  if (crashPoint === 'A') {
    await signalCrashPoint('A', scratchDir);
  }
}

/**
 * Instrumentation for mid-safe-tool crash point (B)
 * Should be called inside read_file/search_text execute, after pi-durable committed the intent
 */
export async function instrumentMidSafeTool(scratchDir: string): Promise<void> {
  const crashPoint = getCrashPoint();
  if (crashPoint === 'B') {
    await signalCrashPoint('B', scratchDir);
  }
}

/**
 * Instrumentation for mid-unsafe-tool crash points (C1, C2, C3)
 * Should be called at various points during apply_patch execution
 */
export async function instrumentMidUnsafeTool(
  point: 'C1' | 'C2' | 'C3', 
  scratchDir: string
): Promise<void> {
  const crashPoint = getCrashPoint();
  if (crashPoint === point) {
    await signalCrashPoint(point, scratchDir);
  }
}
