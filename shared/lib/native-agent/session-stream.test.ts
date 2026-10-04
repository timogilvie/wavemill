import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach } from 'node:test';

import {
  SessionStreamWriter,
  computeDigest,
  computeValueDigest,
  storeArtifact,
  retrieveArtifact,
  resolveSessionEventStreamPath,
  resolveSessionEventsDir,
  resolveArtifactsDir,
  resolveArtifactPath,
  type SessionStreamWriterOptions,
} from './session-stream.ts';

import {
  parseSessionEventJsonl,
  SessionStreamParseError,
  filterEventsByType,
  type SessionEvent,
  type SessionStartedEvent,
  type ModelRequestEvent,
  type ToolCallEvent,
  type SessionEndedEvent,
} from './session-stream.schema.ts';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const FIXED_TIME = 1_750_000_000;

function clock(): number {
  return FIXED_TIME;
}

const TEST_SESSION_ID = 'test-session-1';
const TEST_TRACE_ID = 'trace-1';
const TEST_PHASE = 'coding';

function makeTempDir(): string {
  const dir = join(tmpdir(), `session-stream-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(tempDir: string): void {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

describe('Path resolution', () => {
  it('resolves session events directory with default', () => {
    const dir = resolveSessionEventsDir();
    assert.match(dir, /.wavemill\/session-events/);
  });

  it('resolves session events directory with explicit override', () => {
    const explicit = '/custom/path';
    const dir = resolveSessionEventsDir(undefined, explicit);
    assert.equal(dir, explicit);
  });

  it('resolves session event stream path from sessionId', () => {
    const tempDir = makeTempDir();
    try {
      const path = resolveSessionEventStreamPath(TEST_SESSION_ID, tempDir);
      assert.match(path, /session-events\/test-session-1\.jsonl/);
    } finally {
      cleanup(tempDir);
    }
  });

  it('resolves artifacts directory', () => {
    const dir = resolveArtifactsDir();
    assert.match(dir, /.wavemill\/artifacts/);
  });

  it('resolves artifact path by digest', () => {
    const digest = 'abc123def456';
    const path = resolveArtifactPath(digest);
    assert.match(path, /artifacts\/abc123def456/);
  });
});

// ---------------------------------------------------------------------------
// Digest and hashing
// ---------------------------------------------------------------------------

describe('Digest computation', () => {
  it('computes SHA-256 digest of string content', () => {
    const content = 'hello world';
    const digest = computeDigest(content);
    assert.match(digest, /^[a-f0-9]{64}$/); // SHA-256 hex is 64 chars
  });

  it('computes SHA-256 digest of buffer content', () => {
    const content = Buffer.from('hello world', 'utf-8');
    const digest = computeDigest(content);
    assert.match(digest, /^[a-f0-9]{64}$/);
  });

  it('same content produces same digest', () => {
    const d1 = computeDigest('content');
    const d2 = computeDigest('content');
    assert.equal(d1, d2);
  });

  it('different content produces different digest', () => {
    const d1 = computeDigest('content1');
    const d2 = computeDigest('content2');
    assert.notEqual(d1, d2);
  });

  it('computes digest of canonical JSON value', () => {
    const value1 = { b: 2, a: 1 };
    const value2 = { a: 1, b: 2 };
    const d1 = computeValueDigest(value1);
    const d2 = computeValueDigest(value2);
    assert.equal(d1, d2, 'canonical order should produce same digest');
  });

  it('array order affects value digest', () => {
    const d1 = computeValueDigest([1, 2, 3]);
    const d2 = computeValueDigest([3, 2, 1]);
    assert.notEqual(d1, d2);
  });
});

// ---------------------------------------------------------------------------
// Artifact storage and retrieval
// ---------------------------------------------------------------------------

describe('Artifact storage', () => {
  it('stores artifact and returns reference', () => {
    const tempDir = makeTempDir();
    try {
      const content = 'sensitive tool result';
      const ref = storeArtifact(content, tempDir);

      assert(ref.digest);
      assert.match(ref.digest, /^[a-f0-9]{64}$/);
      assert.equal(ref.byteSize, Buffer.byteLength(content, 'utf-8'));
      assert.equal(ref.path, ref.digest);
      assert.equal(ref.truncated, undefined);
    } finally {
      cleanup(tempDir);
    }
  });

  it('stores artifact with truncation metadata', () => {
    const tempDir = makeTempDir();
    try {
      const content = 'abbreviated content';
      const ref = storeArtifact(content, tempDir, true, 5000);

      assert.equal(ref.truncated, true);
      assert.equal(ref.originalByteSize, 5000);
      assert(ref.byteSize < ref.originalByteSize);
    } finally {
      cleanup(tempDir);
    }
  });

  it('retrieves stored artifact by digest', () => {
    const tempDir = makeTempDir();
    try {
      const content = 'test content for retrieval';
      const ref = storeArtifact(content, tempDir);
      const retrieved = retrieveArtifact(ref.digest, tempDir);

      assert(retrieved);
      assert.equal(retrieved.toString('utf-8'), content);
    } finally {
      cleanup(tempDir);
    }
  });

  it('returns null for non-existent artifact', () => {
    const tempDir = makeTempDir();
    try {
      const retrieved = retrieveArtifact('nonexistent123', tempDir);
      assert.equal(retrieved, null);
    } finally {
      cleanup(tempDir);
    }
  });

  it('implements content addressing (same content, one file)', () => {
    const tempDir = makeTempDir();
    try {
      const content = 'shared content';
      const ref1 = storeArtifact(content, tempDir);
      const ref2 = storeArtifact(content, tempDir);

      assert.equal(ref1.digest, ref2.digest);

      // Verify only one file was created
      const artifactDir = resolveArtifactsDir(tempDir);
      assert(existsSync(join(artifactDir, ref1.digest)));
    } finally {
      cleanup(tempDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Writer: basic operations
// ---------------------------------------------------------------------------

describe('SessionStreamWriter: basic operations', () => {
  it('writes session_started event', () => {
    const tempDir = makeTempDir();
    try {
      const path = join(tempDir, 'session-events', 'test.jsonl');
      const writer = new SessionStreamWriter(
        {
          sessionId: TEST_SESSION_ID,
          traceId: TEST_TRACE_ID,
          phase: TEST_PHASE,
          path,
          clock,
        },
        tempDir,
      );

      const event = writer.writeSessionStarted({
        initialConfigDigest: 'digest123',
      });

      assert.equal(event.type, 'session_started');
      assert.equal(event.sessionId, TEST_SESSION_ID);
      assert.equal(event.traceId, TEST_TRACE_ID);
      assert.equal(event.phase, TEST_PHASE);
      assert.equal(event.seq, 0);
      assert(event.eventId);

      // Verify file was written
      assert(existsSync(path));
      const content = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(content.trim());
      assert.equal(parsed.type, 'session_started');
    } finally {
      cleanup(tempDir);
    }
  });

  it('increments sequence number across events', () => {
    const tempDir = makeTempDir();
    try {
      const path = join(tempDir, 'session-events', 'test.jsonl');
      const writer = new SessionStreamWriter(
        {
          sessionId: TEST_SESSION_ID,
          traceId: TEST_TRACE_ID,
          phase: TEST_PHASE,
          path,
          clock,
        },
        tempDir,
      );

      const e1 = writer.writeSessionStarted({ initialConfigDigest: 'digest1' });
      const e2 = writer.writeModelRequest({
        callId: 'call1',
        turnIndex: 0,
        provider: 'openai',
        modelId: 'gpt-4',
        config: {},
        contextDigest: 'ctx1',
        promptRefs: [],
      });

      assert.equal(e1.seq, 0);
      assert.equal(e2.seq, 1);
    } finally {
      cleanup(tempDir);
    }
  });

  it('generates unique eventIds', () => {
    const tempDir = makeTempDir();
    try {
      const path = join(tempDir, 'session-events', 'test.jsonl');
      const writer = new SessionStreamWriter(
        {
          sessionId: TEST_SESSION_ID,
          traceId: TEST_TRACE_ID,
          phase: TEST_PHASE,
          path,
          clock,
        },
        tempDir,
      );

      const e1 = writer.writeSessionStarted({ initialConfigDigest: 'digest1' });
      const e2 = writer.writeSessionStarted({ initialConfigDigest: 'digest2' });

      assert(e1.eventId);
      assert(e2.eventId);
      assert.notEqual(e1.eventId, e2.eventId);
    } finally {
      cleanup(tempDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Writer: specific event types
// ---------------------------------------------------------------------------

describe('SessionStreamWriter: event type coverage', () => {
  it('writes model_request event', () => {
    const tempDir = makeTempDir();
    try {
      const path = join(tempDir, 'session-events', 'test.jsonl');
      const writer = new SessionStreamWriter(
        {
          sessionId: TEST_SESSION_ID,
          traceId: TEST_TRACE_ID,
          phase: TEST_PHASE,
          path,
          clock,
        },
        tempDir,
      );

      const event = writer.writeModelRequest({
        callId: 'call1',
        turnIndex: 0,
        provider: 'openai',
        modelId: 'gpt-4',
        config: { temperature: 0.7, maxTokens: 2048 },
        contextDigest: 'ctx123',
        promptRefs: [{ resourceId: 'prompt:system', contentHash: 'hash1' }],
      });

      assert.equal(event.type, 'model_request');
      assert.equal(event.callId, 'call1');
      assert.equal(event.provider, 'openai');
    } finally {
      cleanup(tempDir);
    }
  });

  it('writes model_response event', () => {
    const tempDir = makeTempDir();
    try {
      const path = join(tempDir, 'session-events', 'test.jsonl');
      const writer = new SessionStreamWriter(
        {
          sessionId: TEST_SESSION_ID,
          traceId: TEST_TRACE_ID,
          phase: TEST_PHASE,
          path,
          clock,
        },
        tempDir,
      );

      const requestEvent = writer.writeModelRequest({
        callId: 'call1',
        turnIndex: 0,
        provider: 'openai',
        modelId: 'gpt-4',
        config: {},
        contextDigest: 'ctx1',
        promptRefs: [],
      });

      const responseEvent = writer.writeModelResponse({
        requestEventId: requestEvent.eventId,
        callId: 'call1',
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      assert.equal(responseEvent.type, 'model_response');
      assert.equal(responseEvent.requestEventId, requestEvent.eventId);
      assert.equal(responseEvent.stopReason, 'end_turn');
    } finally {
      cleanup(tempDir);
    }
  });

  it('writes tool_call and tool_result events', () => {
    const tempDir = makeTempDir();
    try {
      const path = join(tempDir, 'session-events', 'test.jsonl');
      const writer = new SessionStreamWriter(
        {
          sessionId: TEST_SESSION_ID,
          traceId: TEST_TRACE_ID,
          phase: TEST_PHASE,
          path,
          clock,
        },
        tempDir,
      );

      const toolCallEvent = writer.writeToolCall({
        callId: 'tool1',
        toolName: 'read_file',
        argumentsSummary: 'path="/path/to/file"',
      });

      const toolResultEvent = writer.writeToolResult({
        callId: toolCallEvent.callId,
        toolName: 'read_file',
        isError: false,
        contentSummary: 'File content...',
        byteSize: 1024,
      });

      assert.equal(toolCallEvent.type, 'tool_call');
      assert.equal(toolResultEvent.type, 'tool_result');
      assert.equal(toolResultEvent.callId, toolCallEvent.callId);
    } finally {
      cleanup(tempDir);
    }
  });

  it('writes session_ended event', () => {
    const tempDir = makeTempDir();
    try {
      const path = join(tempDir, 'session-events', 'test.jsonl');
      const writer = new SessionStreamWriter(
        {
          sessionId: TEST_SESSION_ID,
          traceId: TEST_TRACE_ID,
          phase: TEST_PHASE,
          path,
          clock,
        },
        tempDir,
      );

      const event = writer.writeSessionEnded({
        stopReason: 'completion',
        totalTurns: 5,
        totalToolCalls: 10,
      });

      assert.equal(event.type, 'session_ended');
      assert.equal(event.totalTurns, 5);
      assert.equal(event.totalToolCalls, 10);
    } finally {
      cleanup(tempDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Parser and helpers
// ---------------------------------------------------------------------------

describe('parseSessionEventJsonl', () => {
  it('parses valid JSONL', () => {
    const jsonl =
      '{"eventId":"1","seq":0,"timestamp":1000,"sessionId":"s1","traceId":"t1","phase":"coding","schemaVersion":"1","type":"session_started","initialConfigDigest":"d1"}\n' +
      '{"eventId":"2","seq":1,"timestamp":1000,"sessionId":"s1","traceId":"t1","phase":"coding","schemaVersion":"1","type":"session_ended","stopReason":"complete","totalTurns":1,"totalToolCalls":0}\n';

    const events = parseSessionEventJsonl(jsonl);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'session_started');
    assert.equal(events[1].type, 'session_ended');
  });

  it('skips blank lines', () => {
    const jsonl =
      '{"eventId":"1","seq":0,"timestamp":1000,"sessionId":"s1","traceId":"t1","phase":"coding","schemaVersion":"1","type":"session_started","initialConfigDigest":"d1"}\n' +
      '\n' +
      '{"eventId":"2","seq":1,"timestamp":1000,"sessionId":"s1","traceId":"t1","phase":"coding","schemaVersion":"1","type":"session_ended","stopReason":"complete","totalTurns":1,"totalToolCalls":0}\n';

    const events = parseSessionEventJsonl(jsonl);
    assert.equal(events.length, 2);
  });

  it('fails on malformed JSON', () => {
    const jsonl = 'not valid json\n';
    assert.throws(() => parseSessionEventJsonl(jsonl), SessionStreamParseError);
  });

  it('fails on first malformed line', () => {
    const jsonl =
      '{"eventId":"1","seq":0,"timestamp":1000,"sessionId":"s1","traceId":"t1","phase":"coding","schemaVersion":"1","type":"session_started","initialConfigDigest":"d1"}\n' +
      '{invalid}\n';

    try {
      parseSessionEventJsonl(jsonl);
      assert.fail('Should have thrown');
    } catch (err) {
      if (err instanceof SessionStreamParseError) {
        assert.equal(err.lineNumber, 2);
      } else {
        throw err;
      }
    }
  });
});

describe('filterEventsByType', () => {
  it('filters events by type', () => {
    const tempDir = makeTempDir();
    try {
      const path = join(tempDir, 'session-events', 'test.jsonl');
      const writer = new SessionStreamWriter(
        {
          sessionId: TEST_SESSION_ID,
          traceId: TEST_TRACE_ID,
          phase: TEST_PHASE,
          path,
          clock,
        },
        tempDir,
      );

      writer.writeSessionStarted({ initialConfigDigest: 'digest1' });
      writer.writeModelRequest({
        callId: 'call1',
        turnIndex: 0,
        provider: 'openai',
        modelId: 'gpt-4',
        config: {},
        contextDigest: 'ctx1',
        promptRefs: [],
      });
      writer.writeSessionEnded({ stopReason: 'complete', totalTurns: 1, totalToolCalls: 0 });

      const content = readFileSync(path, 'utf-8');
      const events = parseSessionEventJsonl(content);

      const modelRequests = filterEventsByType(events, 'model_request');
      assert.equal(modelRequests.length, 1);
      assert.equal(modelRequests[0].type, 'model_request');
    } finally {
      cleanup(tempDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Write to file and persistence
// ---------------------------------------------------------------------------

describe('SessionStreamWriter: persistence', () => {
  it('appends events to existing file', () => {
    const tempDir = makeTempDir();
    try {
      const path = join(tempDir, 'session-events', 'test.jsonl');

      // Write first event with one writer
      {
        const writer = new SessionStreamWriter(
          {
            sessionId: TEST_SESSION_ID,
            traceId: TEST_TRACE_ID,
            phase: TEST_PHASE,
            path,
            clock,
          },
          tempDir,
        );
        writer.writeSessionStarted({ initialConfigDigest: 'digest1' });
      }

      // Append second event with new writer (different seq numbers)
      {
        const writer = new SessionStreamWriter(
          {
            sessionId: TEST_SESSION_ID,
            traceId: TEST_TRACE_ID,
            phase: TEST_PHASE,
            path,
            clock,
          },
          tempDir,
        );
        writer.writeSessionEnded({ stopReason: 'complete', totalTurns: 1, totalToolCalls: 0 });
      }

      const content = readFileSync(path, 'utf-8');
      const events = parseSessionEventJsonl(content);
      assert.equal(events.length, 2);
      assert.equal(events[0].type, 'session_started');
      assert.equal(events[1].type, 'session_ended');
    } finally {
      cleanup(tempDir);
    }
  });

  it('preserves event line boundaries in JSONL', () => {
    const tempDir = makeTempDir();
    try {
      const path = join(tempDir, 'session-events', 'test.jsonl');
      const writer = new SessionStreamWriter(
        {
          sessionId: TEST_SESSION_ID,
          traceId: TEST_TRACE_ID,
          phase: TEST_PHASE,
          path,
          clock,
        },
        tempDir,
      );

      writer.writeSessionStarted({ initialConfigDigest: 'digest1' });
      writer.writeSessionEnded({ stopReason: 'complete', totalTurns: 1, totalToolCalls: 0 });

      const content = readFileSync(path, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim() !== '');
      assert.equal(lines.length, 2, 'Should have exactly 2 non-empty lines');

      // Each line should be valid JSON
      for (const line of lines) {
        assert.doesNotThrow(() => JSON.parse(line));
      }
    } finally {
      cleanup(tempDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-turn menu event round-trip (HOK-3054)
// ---------------------------------------------------------------------------

describe('SessionStreamWriter: tool_menu + provider_tools + model_request digest wiring', () => {
  it('round-trips a menu payload with digests attached to model_request', () => {
    const tempDir = makeTempDir();
    try {
      const path = join(tempDir, 'session-events', 'menu.jsonl');
      const writer = new SessionStreamWriter(
        {
          sessionId: 'menu-round-trip',
          traceId: 'trace-menu',
          phase: 'planning',
          path,
          clock,
        },
        tempDir,
      );

      const logicalEntries = [
        {
          name: 'read_file',
          family: 'core',
          logicalId: 'core.read_file',
        },
      ];
      const providerEntries = [
        {
          name: 'read_file',
          parameters: { type: 'object', properties: {} },
        },
      ];
      const toolMenuDigest = computeValueDigest(logicalEntries);
      const providerToolsDigest = computeValueDigest(providerEntries);

      writer.writeSessionStarted({ initialConfigDigest: 'digest' });
      writer.writeToolMenu({
        toolNames: ['read_file'],
        digest: toolMenuDigest,
      });
      writer.writeProviderTools({
        toolCount: 1,
        digest: providerToolsDigest,
      });
      writer.writeModelRequest({
        callId: 'req-1',
        turnIndex: 0,
        provider: 'test-provider',
        modelId: 'test-model',
        config: {},
        contextDigest: 'ctx',
        promptRefs: [],
        toolMenuDigest,
        providerToolsDigest,
      });
      writer.writeSessionEnded({ stopReason: 'stop', totalTurns: 1, totalToolCalls: 0 });

      const events = parseSessionEventJsonl(readFileSync(path, 'utf-8'));
      const toolMenu = events.find((e) => e.type === 'tool_menu') as any;
      const providerTools = events.find((e) => e.type === 'provider_tools') as any;
      const modelRequest = events.find((e) => e.type === 'model_request') as any;
      assert.ok(toolMenu);
      assert.ok(providerTools);
      assert.ok(modelRequest);
      assert.equal(toolMenu.digest, toolMenuDigest);
      assert.equal(providerTools.digest, providerToolsDigest);
      assert.equal(modelRequest.toolMenuDigest, toolMenuDigest);
      assert.equal(modelRequest.providerToolsDigest, providerToolsDigest);
      // Digest of the canonical form is reproducible from the payloads themselves.
      assert.equal(computeValueDigest(logicalEntries), toolMenuDigest);
      assert.equal(computeValueDigest(providerEntries), providerToolsDigest);
    } finally {
      cleanup(tempDir);
    }
  });

  it('accepts an empty menu — digest matches the canonical empty-array digest and is byte-stable', () => {
    const tempDir = makeTempDir();
    try {
      const path = join(tempDir, 'session-events', 'menu-empty.jsonl');
      const writer = new SessionStreamWriter(
        {
          sessionId: 'menu-empty',
          traceId: 'trace-empty',
          phase: 'planning',
          path,
          clock,
        },
        tempDir,
      );

      const emptyDigest = computeValueDigest([]);
      writer.writeSessionStarted({ initialConfigDigest: 'digest' });
      writer.writeToolMenu({ toolNames: [], digest: emptyDigest });
      writer.writeProviderTools({ toolCount: 0, digest: emptyDigest });
      writer.writeModelRequest({
        callId: 'req-1',
        turnIndex: 0,
        provider: 'test-provider',
        modelId: 'test-model',
        config: {},
        contextDigest: 'ctx',
        promptRefs: [],
        toolMenuDigest: emptyDigest,
        providerToolsDigest: emptyDigest,
      });

      const events = parseSessionEventJsonl(readFileSync(path, 'utf-8'));
      const modelRequest = events.find((e) => e.type === 'model_request') as any;
      assert.equal(modelRequest.toolMenuDigest, emptyDigest);
      assert.equal(modelRequest.providerToolsDigest, emptyDigest);
      // Byte-stability: identical inputs yield identical digest strings.
      assert.equal(computeValueDigest([]), emptyDigest);
    } finally {
      cleanup(tempDir);
    }
  });
});
