import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  NATIVE_STAGE_TIME_SPLIT_VERSION,
  formatTimeSplit,
  nativeStageTimeSplit,
  resolveNativeStageTimeSplit,
  type NativeStageTimeSplitWindow,
} from './stage-time-split.ts';
import { parseTranscriptJsonl, type TranscriptEvent } from './transcript.ts';
import type { BudgetExhaustedFact } from './budget-exhaustion.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures', 'time-split');

function readFixtureEvents(name: string): TranscriptEvent[] {
  return parseTranscriptJsonl(readFileSync(join(fixturesDir, name), 'utf8'));
}

// ---------------------------------------------------------------------------
// Synthetic event builders
// ---------------------------------------------------------------------------

let seqCounter = 0;
function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

function sessionStarted(timestamp: number): TranscriptEvent {
  return { seq: nextSeq(), sessionId: 's', timestamp, type: 'session_started', model: 'm', api: 'a', provider: 'p' };
}
function sessionEnded(timestamp: number): TranscriptEvent {
  return { seq: nextSeq(), sessionId: 's', timestamp, type: 'session_ended', messageCount: 0 };
}
function turnStarted(timestamp: number, turnIndex: number): TranscriptEvent {
  return { seq: nextSeq(), sessionId: 's', timestamp, type: 'turn_started', turnIndex };
}
function assistantMessage(timestamp: number, opts: { errorMessage?: string } = {}): TranscriptEvent {
  return {
    seq: nextSeq(),
    sessionId: 's',
    timestamp,
    type: 'assistant_message',
    model: 'm',
    stopReason: opts.errorMessage ? 'error' : 'toolUse',
    rawContent: [],
    replayContent: [],
    redacted: false,
    ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
  };
}
function toolStarted(timestamp: number, toolCallId: string, toolName = 'run_tests'): TranscriptEvent {
  return { seq: nextSeq(), sessionId: 's', timestamp, type: 'tool_started', toolCallId, toolName, args: {} };
}
function toolResult(timestamp: number, toolCallId: string, toolName = 'run_tests'): TranscriptEvent {
  return { seq: nextSeq(), sessionId: 's', timestamp, type: 'tool_result', toolCallId, toolName, isError: false, content: '' };
}

// ---------------------------------------------------------------------------
// HOK-3374 replay (the incident the issue is named for)
// ---------------------------------------------------------------------------

describe('nativeStageTimeSplit — HOK-3374 attempt-2 replay', () => {
  const events = readFixtureEvents('hok-3374-attempt-2.transcript.jsonl');
  const started = events.find((e) => e.type === 'session_started')!;
  const ended = [...events].reverse().find((e) => e.type === 'session_ended')!;
  const window: NativeStageTimeSplitWindow = { fromMs: started.timestamp, toMs: ended.timestamp };

  // protects: ~51 minutes of the model's own test-runner commands being charged back as model time (HOK-3374)
  it('attributes most of the wall clock to harness tool time, not provider wait', () => {
    const split = nativeStageTimeSplit(events, window);
    assert.equal(split.version, NATIVE_STAGE_TIME_SPLIT_VERSION);
    assert.equal(split.totalMs, 3_600_000);
    assert.ok(split.harnessToolMs >= 50 * 60_000 && split.harnessToolMs <= 54 * 60_000, `harnessToolMs=${split.harnessToolMs}`);
    assert.ok(Math.abs(split.modelMs - 7.2 * 60_000) <= 0.2 * 60_000, `modelMs=${split.modelMs}`);
    assert.equal(split.providerWaitMs, 0);
    assert.equal(split.toolCalls.unpaired, 0);
    assert.equal(split.harnessToolMs + split.providerWaitMs + split.modelMs + split.unknownMs, split.totalMs);
  });

  // protects: the resolver silently failing to find an archived transcript, leaving the split unknown
  it('resolves the same split through the featureDir archive when the recorded path no longer exists', () => {
    const featureDir = mkdtempSync(join(tmpdir(), 'stage-time-split-'));
    try {
      const archiveDir = join(featureDir, 'native-sessions');
      mkdirSync(archiveDir, { recursive: true });
      writeFileSync(join(archiveDir, 'coding-HOK-3374.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      const fact: BudgetExhaustedFact = {
        kind: 'wall_clock',
        stopReason: 'wall_clock_limit',
        limit: 3_600_000,
        used: 3_600_000,
        progress: { turnsCompleted: 92, toolCallsExecuted: 116, wallClockMs: 3_600_000 },
        sessionStream: {
          path: '/nonexistent/path/coding-HOK-3374.jsonl',
          fromMs: window.fromMs,
          toMs: window.toMs,
        },
      };
      const split = resolveNativeStageTimeSplit(fact, { featureDir });
      assert.ok(split);
      assert.ok(split!.harnessToolMs >= 50 * 60_000);
    } finally {
      rmSync(featureDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Synthetic scenarios
// ---------------------------------------------------------------------------

describe('nativeStageTimeSplit — synthetic scenarios', () => {
  // protects: a failing-request-dominated run being charged to the model
  it('attributes a provider-dominated run mostly to providerWaitMs', () => {
    const base = 0;
    const events: TranscriptEvent[] = [
      sessionStarted(base),
      turnStarted(base, 0),
      assistantMessage(base + 10 * 60_000, { errorMessage: '502 Bad Gateway' }),
      turnStarted(base + 11 * 60_000, 1),
      assistantMessage(base + 21 * 60_000, { errorMessage: '502 Bad Gateway' }),
      turnStarted(base + 22 * 60_000, 2),
      assistantMessage(base + 23 * 60_000),
      sessionEnded(base + 23 * 60_000),
    ];
    const split = nativeStageTimeSplit(events, { fromMs: base, toMs: base + 23 * 60_000 });
    const share = split.providerWaitMs / split.totalMs;
    assert.ok(share >= 0.5, `providerWaitMs share=${share}`);
  });

  // protects: a single stalled in-flight request being charged to the model because it never got a response
  it('attributes a single in-flight request at window end mostly to providerWaitMs', () => {
    const window = { fromMs: 0, toMs: 60_000 };
    const events: TranscriptEvent[] = [sessionStarted(0), turnStarted(0, 0)];
    const split = nativeStageTimeSplit(events, window);
    assert.ok(split.providerWaitMs / split.totalMs >= 0.9, `share=${split.providerWaitMs / split.totalMs}`);
    assert.equal(split.toolCalls.paired, 0);
  });

  // protects: fast, numerous tool calls being miscounted as harness-dominated
  it('attributes turn-churn with fast tools mostly to modelMs', () => {
    const events: TranscriptEvent[] = [sessionStarted(0)];
    let t = 0;
    for (let turn = 0; turn < 50; turn += 1) {
      events.push(turnStarted(t, turn));
      t += 15_000;
      events.push(assistantMessage(t));
      const callId = `call-${turn}`;
      events.push(toolStarted(t, callId));
      t += 50;
      events.push(toolResult(t, callId));
    }
    events.push(sessionEnded(t));
    const split = nativeStageTimeSplit(events, { fromMs: 0, toMs: t });
    assert.ok(split.modelMs > split.harnessToolMs, `modelMs=${split.modelMs} harnessToolMs=${split.harnessToolMs}`);
    assert.equal(split.toolCalls.unpaired, 0);
  });

  // protects: an unpaired tool call being counted as harness time instead of unknown
  it('excludes an unpaired tool call from harnessToolMs and counts it as unknown', () => {
    const window = { fromMs: 0, toMs: 60_000 };
    const events: TranscriptEvent[] = [sessionStarted(0), toolStarted(1000, 'orphan')];
    const split = nativeStageTimeSplit(events, window);
    assert.equal(split.harnessToolMs, 0);
    assert.equal(split.toolCalls.unpaired, 1);
    assert.equal(split.toolCalls.paired, 0);
    assert.ok(split.unknownMs > 0);
  });

  // protects: overlapping parallel tool calls being double-counted as a plain sum
  it('unions overlapping parallel tool intervals instead of summing them', () => {
    const window = { fromMs: 0, toMs: 10_000 };
    const events: TranscriptEvent[] = [
      sessionStarted(0),
      toolStarted(0, 'a'),
      toolStarted(1000, 'b'),
      toolResult(5000, 'a'),
      toolResult(6000, 'b'),
    ];
    const split = nativeStageTimeSplit(events, window);
    // Union of [0,5000] and [1000,6000] is [0,6000] = 6000ms, not 5000+5000.
    assert.equal(split.harnessToolMs, 6000);
    assert.equal(split.toolCalls.paired, 2);
  });

  // protects: a stage window beginning while a request or harness tool is already running
  it('clips overlapping request and tool intervals to the supplied window', () => {
    const events: TranscriptEvent[] = [
      sessionStarted(0),
      turnStarted(0, 0),
      assistantMessage(9000),
      toolStarted(9000, 'spans-window'),
      toolResult(16_000, 'spans-window'),
      sessionEnded(16_000),
    ];
    const split = nativeStageTimeSplit(events, { fromMs: 4000, toMs: 14_000 });
    assert.equal(split.totalMs, 10_000);
    assert.equal(split.modelMs, 5000);
    assert.equal(split.harnessToolMs, 5000);
    assert.equal(split.unknownMs, 0);
    assert.equal(split.toolCalls.paired, 1);
  });

  // protects: a transcript carrying two appended attempts (seq restarts) leaking the other attempt's time into the split
  it('only counts events inside the given window when a transcript holds two appended attempts', () => {
    const attempt1: TranscriptEvent[] = [
      sessionStarted(0),
      turnStarted(0, 0),
      assistantMessage(5000),
      toolStarted(5000, 'attempt1-call'),
      toolResult(9000, 'attempt1-call'),
      sessionEnded(10_000),
    ];
    const attempt2: TranscriptEvent[] = [
      sessionStarted(10_000),
      turnStarted(10_000, 0),
      assistantMessage(11_000),
      toolStarted(11_000, 'attempt2-call'),
      toolResult(19_000, 'attempt2-call'),
      sessionEnded(20_000),
    ];
    const events = [...attempt1, ...attempt2];
    const split = nativeStageTimeSplit(events, { fromMs: 10_000, toMs: 20_000 });
    assert.equal(split.toolCalls.paired, 1);
    assert.equal(split.harnessToolMs, 8000);
    assert.equal(split.totalMs, 10_000);
  });
});

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

describe('resolveNativeStageTimeSplit', () => {
  // protects: a missing pointer or missing file silently producing a fabricated split
  it('returns null when the fact has no pointer or the file is absent', () => {
    assert.equal(resolveNativeStageTimeSplit(null), null);
    assert.equal(resolveNativeStageTimeSplit(undefined), null);
    const noPointer: BudgetExhaustedFact = {
      kind: 'turn',
      stopReason: 'turn_limit',
      limit: 10,
      used: 10,
      progress: { turnsCompleted: 10, toolCallsExecuted: 1, wallClockMs: 1000 },
    };
    assert.equal(resolveNativeStageTimeSplit(noPointer), null);
    const missingFile: BudgetExhaustedFact = {
      ...noPointer,
      sessionStream: { path: '/definitely/not/a/real/path.jsonl', fromMs: 0, toMs: 1000 },
    };
    assert.equal(resolveNativeStageTimeSplit(missingFile, { featureDir: '/definitely/not/a/real/dir' }), null);
  });

  // protects: the resolver throwing instead of failing soft on a corrupt transcript
  it('never throws on an unreadable or empty transcript', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stage-time-split-empty-'));
    try {
      const path = join(dir, 'empty.jsonl');
      writeFileSync(path, '');
      const fact: BudgetExhaustedFact = {
        kind: 'wall_clock',
        stopReason: 'wall_clock_limit',
        limit: 1000,
        used: 1000,
        progress: { turnsCompleted: 1, toolCallsExecuted: 0, wallClockMs: 1000 },
        sessionStream: { path, fromMs: 0, toMs: 1000 },
      };
      assert.equal(resolveNativeStageTimeSplit(fact), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

describe('formatTimeSplit', () => {
  // protects: a missing split being silently rendered as all-zero instead of "unknown"
  it('reports unknown when there is no split', () => {
    assert.equal(formatTimeSplit(null), 'unknown (no session stream)');
    assert.equal(formatTimeSplit(undefined), 'unknown (no session stream)');
  });

  it('formats each bucket with the version', () => {
    const text = formatTimeSplit({
      version: NATIVE_STAGE_TIME_SPLIT_VERSION,
      totalMs: 3_600_000,
      modelMs: 431_537,
      providerWaitMs: 0,
      harnessToolMs: 3_167_438,
      unknownMs: 1025,
      toolCalls: { paired: 116, unpaired: 0 },
    });
    assert.ok(text.startsWith(`${NATIVE_STAGE_TIME_SPLIT_VERSION}: `), text);
    assert.match(text, /harness tools/);
    assert.match(text, /model/);
    assert.match(text, /provider wait/);
    assert.match(text, /unknown/);
  });
});
