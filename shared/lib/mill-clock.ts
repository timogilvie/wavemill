/**
 * Tick clock seam (HOK-3227) — TypeScript twin of `shared/lib/mill-clock.sh`.
 *
 * Off by default: with `WAVEMILL_TICK_CLOCK_FILE` unset, `millClockNowMs()` is
 * `Date.now()` and `millClockSleep()` is a real timer, so production behaviour
 * is unchanged.
 *
 * When a golden journey sets `WAVEMILL_TICK_CLOCK_FILE`, the file holds
 * `"<tick> <epoch>"` (the monitor advances `<tick>` once per pass) and time is
 * `epoch + tick * WAVEMILL_TICK_CLOCK_SECONDS` (default 60) plus whatever this
 * process has virtually slept. Sleeps resolve immediately and advance the
 * virtual offset, so retry backoff and deadline loops run deterministically
 * and still terminate within one process.
 */

import { readFileSync } from 'node:fs';

let virtualSleptMs = 0;

/** True when a tick clock file is configured. */
export function millClockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.WAVEMILL_TICK_CLOCK_FILE);
}

function readTickClock(env: NodeJS.ProcessEnv): { tick: number; epochSeconds: number } {
  let tick = 0;
  let epochSeconds = Number.NaN;
  try {
    const [rawTick, rawEpoch] = readFileSync(env.WAVEMILL_TICK_CLOCK_FILE as string, 'utf8').trim().split(/\s+/);
    if (/^\d+$/.test(rawTick ?? '')) tick = Number(rawTick);
    if (/^\d+$/.test(rawEpoch ?? '')) epochSeconds = Number(rawEpoch);
  } catch {
    // Missing file: tick 0.
  }
  if (Number.isNaN(epochSeconds) && /^\d+$/.test(env.WAVEMILL_TICK_CLOCK_EPOCH ?? '')) {
    epochSeconds = Number(env.WAVEMILL_TICK_CLOCK_EPOCH);
  }
  if (Number.isNaN(epochSeconds)) epochSeconds = Math.floor(Date.now() / 1000);
  return { tick, epochSeconds };
}

/** Epoch milliseconds: wall clock, or the tick-derived virtual time. */
export function millClockNowMs(env: NodeJS.ProcessEnv = process.env): number {
  if (!millClockEnabled(env)) return Date.now();
  const tickSeconds = /^\d+$/.test(env.WAVEMILL_TICK_CLOCK_SECONDS ?? '')
    ? Number(env.WAVEMILL_TICK_CLOCK_SECONDS)
    : 60;
  const { tick, epochSeconds } = readTickClock(env);
  return (epochSeconds + tick * tickSeconds) * 1000 + virtualSleptMs;
}

/** Sleep for `ms`: a real timer, or an instant virtual advance under the tick clock. */
export function millClockSleep(ms: number, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (millClockEnabled(env)) {
    virtualSleptMs += Math.max(0, ms);
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Test-only: forget virtual sleeps accumulated in this process. */
export function resetMillClockForTests(): void {
  virtualSleptMs = 0;
}
