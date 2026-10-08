// HOK-3150 §3.2: kill-point instrumentation. The child sets
// HOK3150_CRASH_POINT=<point> at startup and the harness installs hooks that
// pause and signal the parent on reaching each point. The parent is the
// crash-harness; it watches for a signal file and sends `kill -9` once seen.
//
// Points implemented:
//  A  — mid-model-request:    pause while a partial assistant response is on
//                             the stream (never resolves on parent kill).
//  B  — mid-safe-tool:        pause inside a `safe` tool between intent commit
//                             and real execute.
//  C1 — mid-unsafe-tool before write: pause inside an unsafe tool between
//                                     intent commit and real execute.
//  C2 — mid-unsafe-tool between file writes: handled externally by
//                                             patch-io-interpose.ts.
//  C3 — mid-unsafe-tool after execute, before result commit: pause after
//                                                            real execute.

import { writeFile } from 'node:fs/promises';

export type CrashPoint = 'A' | 'B' | 'C1' | 'C2' | 'C3' | 'none';

/** Parse HOK3150_CRASH_POINT. Unknown values are treated as `none`. */
export function readCrashPoint(env: NodeJS.ProcessEnv): CrashPoint {
  const v = env.HOK3150_CRASH_POINT;
  if (v === 'A' || v === 'B' || v === 'C1' || v === 'C2' || v === 'C3') return v;
  return 'none';
}

export interface CrashSignal {
  readonly point: CrashPoint;
  readonly readyFile: string;
}

const FIRED = new Set<string>();

/** Signal the parent and block indefinitely (parent will send SIGKILL). */
export async function fireAndBlock(signal: CrashSignal, context: string): Promise<void> {
  if (FIRED.has(signal.point)) return; // only once per process
  FIRED.add(signal.point);
  await writeFile(
    signal.readyFile,
    JSON.stringify({ point: signal.point, context, pid: process.pid, t: Date.now() }) + '\n',
    'utf8',
  );
  // Block for up to 60s. SIGKILL cannot be caught, so this just gives the
  // parent time to kill us. If somehow we are not killed, exit nonzero so
  // the harness sees a failed trial.
  await new Promise<void>((resolve) => setTimeout(resolve, 60_000));
  console.error(`[crash-points] crash-point ${signal.point} timed out without SIGKILL`);
  process.exit(99);
}
