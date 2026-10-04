/**
 * Session event stream writer.
 *
 * Canonical append-only event stream for session provenance. Maintains monotonic
 * sequence numbers, lock-protected appends, and no-rewrite guarantees.
 *
 * Artifact storage for large/redacted payloads uses content-addressed references
 * under .wavemill/artifacts/ with SHA-256 digests.
 */

import { appendFileSync, mkdirSync, existsSync, readdirSync, rmSync, writeFileSync, readFileSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type {
  SessionEvent,
  EventBase,
  ArtifactRef,
  RedactionMetadata,
  SESSION_STREAM_SCHEMA_VERSION,
} from './session-stream.schema.ts';
import { SESSION_STREAM_SCHEMA_VERSION as SCHEMA_VERSION } from './session-stream.schema.ts';
import { canonicalJsonStringify } from '../resource-registry.ts';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const DEFAULT_SESSION_EVENTS_DIR = '.wavemill/session-events';
const ARTIFACTS_DIR = '.wavemill/artifacts';
const LOCK_TIMEOUT_MS = 10000;

/**
 * Resolve the directory for session event streams.
 * Default: .wavemill/session-events/ (distinct from .wavemill/sessions/*.json metadata)
 */
export function resolveSessionEventsDir(repoDir?: string, explicitDir?: string): string {
  if (explicitDir) {
    return resolve(explicitDir);
  }
  return resolve(repoDir || process.cwd(), DEFAULT_SESSION_EVENTS_DIR);
}

/**
 * Resolve the canonical event stream file path for a session.
 */
export function resolveSessionEventStreamPath(sessionId: string, repoDir?: string): string {
  const dir = resolveSessionEventsDir(repoDir);
  return resolve(dir, `${sessionId}.jsonl`);
}

/**
 * Resolve the artifacts directory.
 */
export function resolveArtifactsDir(repoDir?: string): string {
  return resolve(repoDir || process.cwd(), ARTIFACTS_DIR);
}

/**
 * Find `*.jsonl` streams in a session-events dir whose `session_started`
 * event carries a scripted-model config digest (HOK-3121).
 *
 * Detection is content-based: the first non-blank line must be a JSON
 * object with `type === 'session_started'` and an `initialConfigDigest`
 * that starts with `model:scripted:`. This matches the fixtures the
 * scripted planning tests produced without hard-coding filenames.
 *
 * Missing dir → empty result. Unreadable files → skipped, not thrown.
 */
export function findScriptedSessionEventStreams(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const streamPath = resolve(dir, entry);
    let firstLine = '';
    try {
      const raw = readFileSync(streamPath, 'utf-8');
      for (const line of raw.split('\n')) {
        if (line.trim() !== '') {
          firstLine = line;
          break;
        }
      }
    } catch {
      continue;
    }
    if (!firstLine) continue;
    let parsed: { type?: unknown; initialConfigDigest?: unknown };
    try {
      parsed = JSON.parse(firstLine);
    } catch {
      continue;
    }
    if (parsed.type !== 'session_started') continue;
    const digest = parsed.initialConfigDigest;
    if (typeof digest !== 'string') continue;
    if (!digest.startsWith('model:scripted:')) continue;
    matches.push(streamPath);
  }
  return matches;
}

/**
 * Resolve artifact storage path by digest.
 */
export function resolveArtifactPath(digest: string, repoDir?: string): string {
  const dir = resolveArtifactsDir(repoDir);
  return resolve(dir, digest);
}

// ---------------------------------------------------------------------------
// Digest and artifact helpers
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 digest of content.
 */
export function computeDigest(content: string | Buffer): string {
  if (typeof content === 'string') {
    return createHash('sha256').update(content, 'utf-8').digest('hex');
  }
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Compute digest of a structured value (canonical JSON).
 */
export function computeValueDigest(value: unknown): string {
  const canonical = canonicalJsonStringify(value);
  return computeDigest(canonical);
}

/**
 * Store redacted artifact and return reference.
 */
export function storeArtifact(
  content: string | Buffer,
  repoDir?: string,
  truncated?: boolean,
  originalByteSize?: number,
): ArtifactRef {
  const digest = computeDigest(content);
  const path = resolveArtifactPath(digest, repoDir);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  // Only write if not already present (content-addressed).
  if (!existsSync(path)) {
    writeFileSync(path, content);
  }

  const byteSize = typeof content === 'string' ? Buffer.byteLength(content, 'utf-8') : content.length;
  return {
    digest,
    byteSize,
    path: digest, // Relative to artifacts dir, or could be full path
    ...(truncated !== undefined && { truncated }),
    ...(originalByteSize !== undefined && { originalByteSize }),
  };
}

/**
 * Retrieve artifact by digest.
 */
export function retrieveArtifact(digest: string, repoDir?: string): Buffer | null {
  const path = resolveArtifactPath(digest, repoDir);
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path);
}

// ---------------------------------------------------------------------------
// Lock management
// ---------------------------------------------------------------------------

/**
 * Acquire an exclusive write lock for a session's event stream.
 * Returns a release function.
 */
function acquireLock(sessionId: string, repoDir?: string): () => void {
  const dir = resolveSessionEventsDir(repoDir);
  const lockPath = resolve(dir, `.${sessionId}.lock`);
  const startTime = Date.now();

  mkdirSync(dirname(lockPath), { recursive: true });

  // Simple spin-lock with timeout. In production, use a better locking library.
  while (true) {
    if (Date.now() - startTime > LOCK_TIMEOUT_MS) {
      throw new Error(
        `Failed to acquire lock for session ${sessionId} within ${LOCK_TIMEOUT_MS}ms. ` +
        `Lock file may be stale: ${lockPath}. ` +
        `Try removing it manually or waiting for the writer to timeout.`,
      );
    }

    try {
      // Try to create the lock file exclusively (fails if exists).
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, time: Date.now() }), {
        flag: 'wx', // write exclusive
      });
      break;
    } catch {
      // Lock held by another writer. Wait a bit and retry.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }

  // Return release function.
  return () => {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // If lock can't be removed (already gone, permission issue), continue.
    }
  };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface SessionStreamWriterOptions {
  /** Session identifier. */
  sessionId: string;
  /** Trace/run ID. */
  traceId: string;
  /** Execution phase. */
  phase: string;
  /** Absolute path to the event stream file. Parent directory is created if needed. */
  path: string;
  /** Override to pin timestamps in tests. Defaults to Date.now. */
  clock?: () => number;
  /** Callback for artifact storage errors (non-fatal). */
  onArtifactError?: (error: Error) => void;
}

/**
 * Append-only session event stream writer.
 *
 * Maintains monotonic sequence numbers and lock-protected appends.
 * Does not rewrite existing events.
 */
export class SessionStreamWriter {
  private seq = 0;
  private readonly options: SessionStreamWriterOptions;
  private readonly clockFn: () => number;
  private readonly repoDir?: string;

  constructor(options: SessionStreamWriterOptions, repoDir?: string) {
    this.options = options;
    this.clockFn = options.clock ?? (() => Date.now());
    this.repoDir = repoDir;
    mkdirSync(dirname(options.path), { recursive: true });
  }

  /**
   * Write a pre-built session event.
   */
  write(event: SessionEvent): void {
    this.append(event);
  }

  /**
   * Write a session_started event.
   */
  writeSessionStarted(opts: {
    parentSessionId?: string;
    initialConfigDigest: string;
    manifestId?: string;
  }): SessionEvent {
    const event = this.createEvent({
      type: 'session_started',
      sessionId: this.options.sessionId,
      parentSessionId: opts.parentSessionId,
      initialConfigDigest: opts.initialConfigDigest,
      manifestId: opts.manifestId,
    });
    this.append(event);
    return event;
  }

  /**
   * Write a session_ended event.
   */
  writeSessionEnded(opts: {
    stopReason: string;
    totalTurns: number;
    totalToolCalls: number;
    totalTokens?: number;
  }): SessionEvent {
    const event = this.createEvent({
      type: 'session_ended',
      stopReason: opts.stopReason,
      totalTurns: opts.totalTurns,
      totalToolCalls: opts.totalToolCalls,
      ...(opts.totalTokens !== undefined && { totalTokens: opts.totalTokens }),
    });
    this.append(event);
    return event;
  }

  /**
   * Write a model_request event.
   */
  writeModelRequest(opts: {
    callId: string;
    turnIndex: number;
    provider: string;
    modelId: string;
    config: Record<string, unknown>;
    contextDigest: string;
    contextTokens?: number;
    promptRefs: Array<{ resourceId: string; contentHash: string; version?: string }>;
    injectedContextRefs?: Array<{ resourceId: string; contentHash: string; version?: string }>;
    toolMenuDigest?: string;
    providerToolsDigest?: string;
    policyConfigDigest?: string;
    turnBudgetRemaining?: number;
    toolCallBudgetRemaining?: number;
    tokensUsedSoFar?: number;
  }): SessionEvent {
    const event = this.createEvent({
      type: 'model_request',
      callId: opts.callId,
      turnIndex: opts.turnIndex,
      provider: opts.provider,
      modelId: opts.modelId,
      config: opts.config,
      contextDigest: opts.contextDigest,
      ...(opts.contextTokens !== undefined && { contextTokens: opts.contextTokens }),
      promptRefs: opts.promptRefs,
      ...(opts.injectedContextRefs?.length && { injectedContextRefs: opts.injectedContextRefs }),
      ...(opts.toolMenuDigest && { toolMenuDigest: opts.toolMenuDigest }),
      ...(opts.providerToolsDigest && { providerToolsDigest: opts.providerToolsDigest }),
      ...(opts.policyConfigDigest && { policyConfigDigest: opts.policyConfigDigest }),
      ...(opts.turnBudgetRemaining !== undefined && { turnBudgetRemaining: opts.turnBudgetRemaining }),
      ...(opts.toolCallBudgetRemaining !== undefined && { toolCallBudgetRemaining: opts.toolCallBudgetRemaining }),
      ...(opts.tokensUsedSoFar !== undefined && { tokensUsedSoFar: opts.tokensUsedSoFar }),
    });
    this.append(event);
    return event;
  }

  /**
   * Write a model_response event.
   */
  writeModelResponse(opts: {
    requestEventId: string;
    callId: string;
    actualModel?: string;
    stopReason: string;
    contentSummary?: Record<string, unknown>;
    usage?: Record<string, unknown>;
  }): SessionEvent {
    const event = this.createEvent({
      type: 'model_response',
      requestEventId: opts.requestEventId,
      callId: opts.callId,
      ...(opts.actualModel && { actualModel: opts.actualModel }),
      stopReason: opts.stopReason,
      ...(opts.contentSummary && { contentSummary: opts.contentSummary }),
      ...(opts.usage && { usage: opts.usage }),
    });
    this.append(event);
    return event;
  }

  /**
   * Write a tool_policy_decision event.
   */
  writeToolPolicyDecision(opts: {
    callId: string;
    toolName: string;
    decision: 'allow' | 'deny';
    denialReason?: string;
    policyConfigDigest?: string;
  }): SessionEvent {
    const event = this.createEvent({
      type: 'tool_policy_decision',
      callId: opts.callId,
      toolName: opts.toolName,
      decision: opts.decision,
      ...(opts.denialReason && { denialReason: opts.denialReason }),
      ...(opts.policyConfigDigest && { policyConfigDigest: opts.policyConfigDigest }),
    });
    this.append(event);
    return event;
  }

  /**
   * Write a tool_call event.
   */
  writeToolCall(opts: {
    callId: string;
    toolName: string;
    argumentsDigest?: string;
    argumentsSummary?: string;
  }): SessionEvent {
    const event = this.createEvent({
      type: 'tool_call',
      callId: opts.callId,
      toolName: opts.toolName,
      ...(opts.argumentsDigest && { argumentsDigest: opts.argumentsDigest }),
      ...(opts.argumentsSummary && { argumentsSummary: opts.argumentsSummary }),
    });
    this.append(event);
    return event;
  }

  /**
   * Write a tool_result event.
   */
  writeToolResult(opts: {
    callId: string;
    toolName: string;
    isError: boolean;
    contentSummary?: string;
    byteSize?: number;
    artifactRef?: ArtifactRef;
    redaction?: RedactionMetadata;
    wavemillMetadata?: Record<string, unknown>;
  }): SessionEvent {
    const event = this.createEvent({
      type: 'tool_result',
      callId: opts.callId,
      toolName: opts.toolName,
      isError: opts.isError,
      ...(opts.contentSummary !== undefined && { contentSummary: opts.contentSummary }),
      ...(opts.byteSize !== undefined && { byteSize: opts.byteSize }),
      ...(opts.artifactRef && { artifactRef: opts.artifactRef }),
      ...(opts.redaction && { redaction: opts.redaction }),
      ...(opts.wavemillMetadata && { wavemillMetadata: opts.wavemillMetadata }),
    });
    this.append(event);
    return event;
  }

  /**
   * Write a compaction event.
   */
  writeCompaction(opts: {
    strategy: string;
    affectedEventCount?: number;
    beforeContextDigest?: string;
    afterContextDigest?: string;
    artifactRef?: ArtifactRef;
  }): SessionEvent {
    const event = this.createEvent({
      type: 'compaction',
      strategy: opts.strategy,
      ...(opts.affectedEventCount !== undefined && { affectedEventCount: opts.affectedEventCount }),
      ...(opts.beforeContextDigest && { beforeContextDigest: opts.beforeContextDigest }),
      ...(opts.afterContextDigest && { afterContextDigest: opts.afterContextDigest }),
      ...(opts.artifactRef && { artifactRef: opts.artifactRef }),
    });
    this.append(event);
    return event;
  }

  /**
   * Write a mutation_outcome event.
   */
  writeMutationOutcome(opts: {
    commandType: string;
    commandSummary?: string;
    isError: boolean;
    outcomeSummary?: string;
    toolCallId?: string;
  }): SessionEvent {
    const event = this.createEvent({
      type: 'mutation_outcome',
      commandType: opts.commandType,
      ...(opts.commandSummary && { commandSummary: opts.commandSummary }),
      isError: opts.isError,
      ...(opts.outcomeSummary && { outcomeSummary: opts.outcomeSummary }),
      ...(opts.toolCallId && { toolCallId: opts.toolCallId }),
    });
    this.append(event);
    return event;
  }

  /**
   * Write an approval event.
   */
  writeApproval(opts: {
    stage: 'requesting' | 'ready' | 'approved' | 'denied';
    approvalId?: string;
    notes?: string;
  }): SessionEvent {
    const event = this.createEvent({
      type: 'approval',
      stage: opts.stage,
      ...(opts.approvalId && { approvalId: opts.approvalId }),
      ...(opts.notes && { notes: opts.notes }),
    });
    this.append(event);
    return event;
  }

  /**
   * Write a retry event.
   */
  writeRetry(opts: {
    failedEventId: string;
    reason: string;
    retryCount: number;
  }): SessionEvent {
    const event = this.createEvent({
      type: 'retry',
      failedEventId: opts.failedEventId,
      reason: opts.reason,
      retryCount: opts.retryCount,
    });
    this.append(event);
    return event;
  }

  /**
   * Write a session_resume event.
   */
  writeSessionResume(opts: {
    lastCommittedEventId?: string;
    resumeFromSeq?: number;
    reason: string;
  }): SessionEvent {
    const event = this.createEvent({
      type: 'session_resume',
      ...(opts.lastCommittedEventId && { lastCommittedEventId: opts.lastCommittedEventId }),
      ...(opts.resumeFromSeq !== undefined && { resumeFromSeq: opts.resumeFromSeq }),
      reason: opts.reason,
    });
    this.append(event);
    return event;
  }

  /**
   * Write a session_fork event.
   */
  writeSessionFork(opts: {
    parentSessionId: string;
    childSessionId: string;
    subagentType?: string;
    reason: string;
  }): SessionEvent {
    const event = this.createEvent({
      type: 'session_fork',
      parentSessionId: opts.parentSessionId,
      childSessionId: opts.childSessionId,
      ...(opts.subagentType && { subagentType: opts.subagentType }),
      reason: opts.reason,
    });
    this.append(event);
    return event;
  }

  /**
   * Write a tool_menu event.
   */
  writeToolMenu(opts: {
    toolNames: string[];
    digest: string;
    artifactRef?: ArtifactRef;
  }): SessionEvent {
    const event = this.createEvent({
      type: 'tool_menu',
      toolNames: opts.toolNames,
      digest: opts.digest,
      ...(opts.artifactRef && { artifactRef: opts.artifactRef }),
    });
    this.append(event);
    return event;
  }

  /**
   * Write a provider_tools event.
   */
  writeProviderTools(opts: {
    toolCount: number;
    digest: string;
    artifactRef?: ArtifactRef;
  }): SessionEvent {
    const event = this.createEvent({
      type: 'provider_tools',
      toolCount: opts.toolCount,
      digest: opts.digest,
      ...(opts.artifactRef && { artifactRef: opts.artifactRef }),
    });
    this.append(event);
    return event;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private createEvent(partial: Omit<SessionEvent, keyof EventBase>): SessionEvent {
    const base: EventBase = {
      eventId: randomUUID(),
      seq: this.nextSeq(),
      timestamp: this.clockFn(),
      sessionId: this.options.sessionId,
      traceId: this.options.traceId,
      phase: this.options.phase,
      schemaVersion: SCHEMA_VERSION,
    };
    return { ...base, ...partial } as SessionEvent;
  }

  private nextSeq(): number {
    return this.seq++;
  }

  private append(event: SessionEvent): void {
    const releaseLock = acquireLock(this.options.sessionId, this.repoDir);
    try {
      // Ensure durable append: write then fsync to prevent partial JSON on crash
      const content = JSON.stringify(event) + '\n';
      const flags = existsSync(this.options.path) ? 'a' : 'w';
      mkdirSync(dirname(this.options.path), { recursive: true });

      const fd = openSync(this.options.path, flags);
      try {
        writeSync(fd, content, 'utf-8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } finally {
      releaseLock();
    }
  }
}
