/**
 * Native stage time split (HOK-3380, slice 1 of 3).
 *
 * "Whose time was this?" gets one answer: {@link nativeStageTimeSplit}, a
 * pure, versioned derivation (`nativeStageTimeSplit/v1`) over the native
 * transcript. It replaces per-site arithmetic that used to divide a budget
 * stop's wall clock into "provider wait" and "everything else" and charge
 * everything else to the model — including time our own harness spent
 * running tools (HOK-3374: a coding agent lost two attempts to
 * `run_tests` on an overloaded host and both were charged to the model).
 *
 * ## Why the transcript, not the canonical session-events stream
 *
 * `tool-decision-projector.ts` reads the canonical `session-stream.schema.ts`
 * events, but that stream can carry almost no `model_response` events for a
 * long-running attempt (observed: 5 in 2308 lines for the HOK-3374 replay),
 * so request time cannot be derived from it. The append-only transcript
 * (`transcript.ts`, `.wavemill/runs/<session>/native-sessions/<stage>-<issue>.jsonl`)
 * carries everything this derivation needs, from the same `Date.now()` clock
 * `loop.ts` uses for its own wall-clock budget:
 *   - `turn_started` → `assistant_message` is request time (generation +
 *     provider latency, inseparable);
 *   - `assistant_message.errorMessage` marks a failed or aborted request;
 *   - `tool_started` → `tool_result`, paired by `toolCallId`, is harness tool
 *     time — the time our own command/tool execution held the loop, not the
 *     model.
 *
 * ## Rules
 *
 *   1. Unknown is computed, never assumed: `unknownMs = totalMs - (modelMs +
 *      providerWaitMs + harnessToolMs)`, clamped at 0. An unpaired
 *      `tool_started` contributes no interval to any bucket, so its time
 *      lands in `unknownMs` — it is never counted as harness time.
 *   2. Categories are each unioned (overlapping tool calls count once). If
 *      categories overlap at all (a malformed stream), harness wins over
 *      provider wins over model, so the four buckets still sum to `totalMs`.
 *   3. Generation time stays model time: a slow but healthy model that runs
 *      out of budget is still the model not finishing in time. Only a
 *      request that ended in `errorMessage`, the backoff gap that follows
 *      it, or a request still in flight when the window ends (including our
 *      own budget abort) count as provider wait.
 *   4. Events outside the given window are dropped; intervals that start
 *      inside the window and end after it are clipped to it.
 *
 * `resolveNativeStageTimeSplit` is the one place that turns a
 * {@link BudgetExhaustedFact.sessionStream} pointer into a split: it resolves
 * the transcript file (fail-soft — never throws, returns `null` on any
 * failure) and calls the pure function with the pointer's window. Everything
 * else in the fault rule and summaries reads the split, never a stored
 * `providerWaitMs`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { assistantErrorText, type BudgetExhaustedFact } from './budget-exhaustion.ts';
import type {
  TranscriptAssistantMessage,
  TranscriptEvent,
  TranscriptToolResult,
  TranscriptToolStarted,
  TranscriptTurnStarted,
} from './transcript.ts';

export const NATIVE_STAGE_TIME_SPLIT_VERSION = 'nativeStageTimeSplit/v1';

/** The window a split is computed over. Raw timestamps, not durations. */
export interface NativeStageTimeSplitWindow {
  fromMs: number;
  toMs: number;
}

export interface NativeStageTimeSplit {
  version: typeof NATIVE_STAGE_TIME_SPLIT_VERSION;
  /** Window length (`toMs - fromMs`). The other four buckets sum to this. */
  totalMs: number;
  /** Requests that returned a usable assistant message (generation; provider latency is inseparable, as today). */
  modelMs: number;
  /**
   * Failed requests (`assistant_message` with an `errorMessage`) plus the
   * backoff gap to the next `turn_started`, plus a request still in flight
   * at the end of the window (including our own budget abort).
   */
  providerWaitMs: number;
  /** Union of paired `tool_started` → `tool_result` intervals: our own harness holding the loop. */
  harnessToolMs: number;
  /** Everything else: unpaired tool calls, loop overhead, gaps, missing events. Computed, never assumed. */
  unknownMs: number;
  toolCalls: { paired: number; unpaired: number };
}

// ---------------------------------------------------------------------------
// Interval arithmetic (half-open [start, end) intervals in ms)
// ---------------------------------------------------------------------------

type Interval = readonly [number, number];

function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals]
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  const merged: Interval[] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      merged[merged.length - 1] = [last[0], Math.max(last[1], end)];
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

function sumLength(intervals: readonly Interval[]): number {
  return intervals.reduce((total, [start, end]) => total + (end - start), 0);
}

/** `base` minus the union of `subtract` (both merged internally first). */
function subtractIntervals(base: readonly Interval[], subtract: readonly Interval[]): Interval[] {
  const mergedSubtract = mergeIntervals(subtract);
  if (mergedSubtract.length === 0) return mergeIntervals(base);
  const result: Interval[] = [];
  for (const [start, end] of mergeIntervals(base)) {
    let cursor = start;
    for (const [subStart, subEnd] of mergedSubtract) {
      if (subEnd <= cursor) continue;
      if (subStart >= end) break;
      if (subStart > cursor) {
        result.push([cursor, Math.min(subStart, end)]);
      }
      cursor = Math.max(cursor, subEnd);
      if (cursor >= end) break;
    }
    if (cursor < end) result.push([cursor, end]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pure derivation
// ---------------------------------------------------------------------------

function deriveDefaultWindow(events: readonly TranscriptEvent[]): NativeStageTimeSplitWindow {
  if (events.length === 0) return { fromMs: 0, toMs: 0 };
  const started = events.find((event) => event.type === 'session_started');
  let ended: TranscriptEvent | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === 'session_ended') {
      ended = events[index];
      break;
    }
  }
  return {
    fromMs: started ? started.timestamp : events[0].timestamp,
    toMs: ended ? ended.timestamp : events[events.length - 1].timestamp,
  };
}

function pairToolCalls(events: readonly TranscriptEvent[]): {
  paired: Array<{ start: TranscriptToolStarted; result: TranscriptToolResult }>;
  unpaired: TranscriptToolStarted[];
} {
  const pendingStarts = new Map<string, TranscriptToolStarted>();
  const paired: Array<{ start: TranscriptToolStarted; result: TranscriptToolResult }> = [];
  for (const event of events) {
    if (event.type === 'tool_started') {
      pendingStarts.set(event.toolCallId, event);
    } else if (event.type === 'tool_result') {
      const start = pendingStarts.get(event.toolCallId);
      if (start) {
        pendingStarts.delete(event.toolCallId);
        paired.push({ start, result: event });
      }
    }
  }
  return { paired, unpaired: [...pendingStarts.values()] };
}

interface TaggedInterval {
  start: number;
  end: number;
  kind: 'model' | 'provider';
}

/**
 * Zip `turn_started` with the `assistant_message` that follows it. A failed
 * request (`errorMessage`) is provider wait, and so is the backoff gap up to
 * the next `turn_started`. A `turn_started` with no following
 * `assistant_message` — including the last turn of a run the wall clock cut
 * off mid-request — is provider wait out to `windowEndFallback`.
 */
function buildTurnIntervals(events: readonly TranscriptEvent[], windowEndFallback: number): TaggedInterval[] {
  const out: TaggedInterval[] = [];
  let currentTurnStart: TranscriptTurnStarted | undefined;
  let pendingBackoffFromMs: number | undefined;

  for (const event of events) {
    if (event.type === 'turn_started') {
      if (currentTurnStart) {
        // Defensive: a turn_started with no assistant_message before the next
        // one started. The outstanding request's time is provider wait.
        out.push({ start: currentTurnStart.timestamp, end: event.timestamp, kind: 'provider' });
      }
      if (pendingBackoffFromMs !== undefined) {
        out.push({ start: pendingBackoffFromMs, end: event.timestamp, kind: 'provider' });
        pendingBackoffFromMs = undefined;
      }
      currentTurnStart = event;
    } else if (event.type === 'assistant_message') {
      if (!currentTurnStart) continue;
      const message = event as TranscriptAssistantMessage;
      const errorText = assistantErrorText({ role: 'assistant', errorMessage: message.errorMessage });
      if (errorText) {
        out.push({ start: currentTurnStart.timestamp, end: message.timestamp, kind: 'provider' });
        pendingBackoffFromMs = message.timestamp;
      } else {
        out.push({ start: currentTurnStart.timestamp, end: message.timestamp, kind: 'model' });
      }
      currentTurnStart = undefined;
    }
  }
  if (currentTurnStart) {
    out.push({ start: currentTurnStart.timestamp, end: windowEndFallback, kind: 'provider' });
  }
  if (pendingBackoffFromMs !== undefined) {
    out.push({ start: pendingBackoffFromMs, end: windowEndFallback, kind: 'provider' });
  }
  return out;
}

/**
 * Compute the time split for one native stage run. Pure: no file I/O. See
 * the module doc for the rules. `window` defaults to the first
 * `session_started` through the last `session_ended` (or the first/last
 * event when those are absent) — callers with a fact pointer should always
 * pass the pointer's window explicitly, since a transcript can carry more
 * than one attempt appended (`seq` restarts per attempt).
 */
export function nativeStageTimeSplit(
  events: readonly TranscriptEvent[],
  window?: NativeStageTimeSplitWindow,
): NativeStageTimeSplit {
  const resolvedWindow = window ?? deriveDefaultWindow(events);
  const totalMs = Math.max(0, resolvedWindow.toMs - resolvedWindow.fromMs);
  const inWindow = (timestamp: number) => timestamp >= resolvedWindow.fromMs && timestamp <= resolvedWindow.toMs;
  const clipEnd = (end: number) => Math.min(end, resolvedWindow.toMs);

  const { paired, unpaired } = pairToolCalls(events);
  const pairedInWindow = paired.filter((p) => inWindow(p.start.timestamp));
  const unpairedInWindow = unpaired.filter((start) => inWindow(start.timestamp));

  const harnessIntervals: Interval[] = pairedInWindow
    .map((p): Interval => [p.start.timestamp, clipEnd(p.result.timestamp)])
    .filter(([start, end]) => end > start);

  const turnIntervals = buildTurnIntervals(events, resolvedWindow.toMs)
    .filter((interval) => inWindow(interval.start))
    .map((interval) => ({ ...interval, end: clipEnd(interval.end) }))
    .filter((interval) => interval.end > interval.start);

  const modelIntervals: Interval[] = turnIntervals
    .filter((interval) => interval.kind === 'model')
    .map((interval): Interval => [interval.start, interval.end]);
  const providerIntervals: Interval[] = turnIntervals
    .filter((interval) => interval.kind === 'provider')
    .map((interval): Interval => [interval.start, interval.end]);

  // Overlaps (a malformed stream) resolve harness > provider > model so the
  // four buckets always sum to totalMs.
  const harnessUnion = mergeIntervals(harnessIntervals);
  const providerExclusive = subtractIntervals(providerIntervals, harnessUnion);
  const modelExclusive = subtractIntervals(modelIntervals, [...harnessUnion, ...providerExclusive]);

  const harnessToolMs = sumLength(harnessUnion);
  const providerWaitMs = sumLength(providerExclusive);
  const modelMs = sumLength(modelExclusive);
  const unknownMs = Math.max(0, totalMs - harnessToolMs - providerWaitMs - modelMs);

  return {
    version: NATIVE_STAGE_TIME_SPLIT_VERSION,
    totalMs,
    modelMs,
    providerWaitMs,
    harnessToolMs,
    unknownMs,
    toolCalls: { paired: pairedInWindow.length, unpaired: unpairedInWindow.length },
  };
}

// ---------------------------------------------------------------------------
// I/O: resolving the fact's pointer to a transcript file (fail-soft)
// ---------------------------------------------------------------------------

export interface ResolveNativeStageTimeSplitDirs {
  featureDir?: string;
  repoDir?: string;
}

/**
 * `path` resolution order (HOK-3380 D4): the absolute pointer path, then
 * `<featureDir or repoDir>/native-sessions/<basename>` — the same archive
 * layout `executed-model-resolver.ts` already reads (`wavemill-common.sh`
 * copies every `*.jsonl` path referenced by feature-dir JSON into
 * `<archive>/native-sessions/<basename>`).
 */
function resolveTranscriptPath(pointerPath: string, dirs: ResolveNativeStageTimeSplitDirs): string | null {
  if (existsSync(pointerPath)) return pointerPath;
  const base = basename(pointerPath);
  const candidates = [dirs.featureDir, dirs.repoDir]
    .filter((dir): dir is string => Boolean(dir))
    .map((dir) => join(dir, 'native-sessions', base));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Parse transcript JSONL tolerantly: malformed lines are skipped, never thrown. */
function readTranscriptEventsTolerant(filePath: string): TranscriptEvent[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const events: TranscriptEvent[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as TranscriptEvent);
    } catch {
      // Skip malformed lines; a partial transcript still yields a partial split.
    }
  }
  return events;
}

/**
 * Resolve a {@link BudgetExhaustedFact.sessionStream} pointer to a split.
 * The one place that does file I/O for this derivation; everything else
 * (the fault rule, summaries) takes a split value, never a path. Never
 * throws: no pointer, no file, or an unparseable/empty transcript all give
 * `null`, which the fault rule treats as "whose time is unknown".
 */
export function resolveNativeStageTimeSplit(
  fact: BudgetExhaustedFact | null | undefined,
  dirs: ResolveNativeStageTimeSplitDirs = {},
): NativeStageTimeSplit | null {
  const pointer = fact?.sessionStream;
  if (!pointer?.path) return null;
  const filePath = resolveTranscriptPath(pointer.path, dirs);
  if (!filePath) return null;
  const events = readTranscriptEventsTolerant(filePath);
  if (events.length === 0) return null;
  try {
    return nativeStageTimeSplit(events, { fromMs: pointer.fromMs, toMs: pointer.toMs });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

/** Human-readable fragment for summaries. `null`/`undefined` means no stream was available. */
export function formatTimeSplit(split: NativeStageTimeSplit | null | undefined): string {
  if (!split) return 'unknown (no session stream)';
  return `${split.version}: ${formatDuration(split.harnessToolMs)} harness tools, `
    + `${formatDuration(split.modelMs)} model, ${formatDuration(split.providerWaitMs)} provider wait, `
    + `${formatDuration(split.unknownMs)} unknown`;
}
