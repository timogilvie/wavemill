/**
 * Bounded capture of the request bodies a native run actually sent (HOK-3261).
 *
 * When a native agent misbehaves we need to tell a harness fault (an
 * instruction that never reached the request, a truncated tool result, a
 * compaction that cut the wrong block) from a model fault. Session logs and
 * summaries cannot answer that; the request body can. This module keeps the
 * last few bodies per stage, each with the response's usage, stop reason and
 * provider-reported model, as a ring buffer in the task's feature dir:
 *
 *   <featureDir>/native-payloads/<stage>/payload-<ms>-<seq>-<rand>.json
 *
 * - Always on. There is no toggle (HOK-3235); the only knobs are the size caps
 *   in `nativeAgent.payloadCapture` (`maxFiles`, `maxBytes`).
 * - Bodies are redacted before they touch disk: secret patterns plus the
 *   literal value of every secret-named environment variable.
 * - The feature dir is reaped with the task, so the ring goes with it. A
 *   failed stage copies the ring next to its session transcript with
 *   {@link snapshotPayloadsForFailure}, which survives reaping so HOK-3231 can
 *   turn it into a replay fixture and HOK-3255 can read it for attribution.
 * - Capture never fails a run: every IO error is a warning.
 *
 * The hook is the Pi `onPayload` callback, the last point before the wire,
 * installed by {@link wrapStreamFnWithPayloadCapture} around the loop's
 * resolved `StreamFn` so retries, continuations and terminal synthesis are all
 * covered.
 *
 * @module payload-capture
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { DEFAULT_RULES, redactWithStats, type RedactionProfile } from '../redaction-profiles.ts';
import { extractProviderReportedIdentity } from './provider-identity.ts';

export const NATIVE_PAYLOAD_CAPTURE_SCHEMA_VERSION = '1.0';
export const DEFAULT_PAYLOAD_CAPTURE_MAX_FILES = 3;
export const DEFAULT_PAYLOAD_CAPTURE_MAX_BYTES = 5 * 1024 * 1024;

const PAYLOAD_DIR_NAME = 'native-payloads';
const PAYLOAD_FILE_PATTERN = /^payload-\d{13}-\d{4}-[0-9a-f]{6}\.json$/;
const SECRET_ENV_NAME = /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$/i;
const MIN_SECRET_ENV_VALUE_LENGTH = 8;

export interface PayloadCaptureConfig {
  /** Task feature dir; the ring lives under `native-payloads/<stage>/`. */
  featureDir: string;
  stage: string;
  /** Files kept per stage (default 3). */
  maxFiles?: number;
  /** Byte cap for the stage directory; the newest file is always kept (default 5 MiB). */
  maxBytes?: number;
  /** Environment whose secret-named values are redacted (default `process.env`). */
  env?: Record<string, string | undefined>;
}

/** One captured request, as written to disk. */
export interface CapturedPayloadRecord {
  schemaVersion: typeof NATIVE_PAYLOAD_CAPTURE_SCHEMA_VERSION;
  stage: string;
  /** Request order within this loop run, from 0. */
  turnIndex: number;
  capturedAt: string;
  /** Provider and api of the model the request was sent to. */
  provider: string;
  api: string;
  /** Wire id the request asked for. */
  requestModel: string;
  /** Provider-reported model (`response.model`), null when absent or no response arrived. */
  responseModel: string | null;
  responseId: string | null;
  /** Assistant stop reason, or `no-response` when the request never produced a message. */
  stopReason: string;
  errorMessage?: string;
  usage?: AssistantMessage['usage'];
  /** Redacted request body as handed to the transport. */
  payload: unknown;
}

interface PendingRequest {
  turnIndex: number;
  capturedAt: string;
  provider: string;
  api: string;
  requestModel: string;
  payload: unknown;
}

export function getPayloadCaptureDir(featureDir: string, stage: string): string {
  return path.join(featureDir, PAYLOAD_DIR_NAME, stage);
}

/**
 * List a capture directory's payload files, oldest first. File names start
 * with a zero-padded epoch-ms stamp, so name order is capture order.
 */
export function listCapturedPayloadFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => PAYLOAD_FILE_PATTERN.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

/** Redaction profile for request bodies: the default rules plus secret env values. */
export function buildPayloadRedactionProfile(
  env: Record<string, string | undefined> = process.env,
): RedactionProfile {
  const secretValues = Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name)
      && typeof value === 'string'
      && value.length >= MIN_SECRET_ENV_VALUE_LENGTH)
    .map(([, value]) => value as string)
    // Longest first so a secret that contains another is replaced whole.
    .sort((left, right) => right.length - left.length);
  return { id: 'native-payload', rules: DEFAULT_RULES, secretValues: [...new Set(secretValues)] };
}

/**
 * Redact every string leaf of a request body. Keys are kept as-is: request
 * bodies carry no auth headers, and masking by key name would rewrite tool
 * schemas that declare a `key` or `token` property, which would make the
 * capture lie about what the model saw.
 */
export function redactPayload(value: unknown, profile: RedactionProfile): unknown {
  if (typeof value === 'string') {
    return redactWithStats(value, profile).text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactPayload(item, profile));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, redactPayload(nested, profile)]),
    );
  }
  return value;
}

/**
 * Ring buffer of the last request bodies for one stage. `recordRequest` runs
 * from `onPayload`; `recordResponse` runs when the assistant message for that
 * request ends and writes the pair to disk.
 */
export class PayloadRingBuffer {
  readonly dir: string;
  private readonly stage: string;
  private readonly maxFiles: number;
  private readonly maxBytes: number;
  private readonly profile: RedactionProfile;
  private pending: PendingRequest | undefined;
  private nextTurnIndex = 0;
  private sequence = 0;

  constructor(config: PayloadCaptureConfig) {
    this.dir = getPayloadCaptureDir(config.featureDir, config.stage);
    this.stage = config.stage;
    this.maxFiles = Math.max(1, Math.floor(config.maxFiles ?? DEFAULT_PAYLOAD_CAPTURE_MAX_FILES));
    this.maxBytes = Math.max(1, Math.floor(config.maxBytes ?? DEFAULT_PAYLOAD_CAPTURE_MAX_BYTES));
    this.profile = buildPayloadRedactionProfile(config.env);
  }

  /** Buffer the body of the request that is about to go out. */
  recordRequest(payload: unknown, model: { id: string; provider: string; api: string }): void {
    // A request whose response never surfaced (thrown stream) is still evidence.
    this.flushPending();
    try {
      this.pending = {
        turnIndex: this.nextTurnIndex++,
        capturedAt: new Date().toISOString(),
        provider: String(model.provider),
        api: String(model.api),
        requestModel: String(model.id),
        payload: redactPayload(payload, this.profile),
      };
    } catch (error) {
      console.warn(`native payload capture: failed to buffer request: ${(error as Error).message}`);
      this.pending = undefined;
    }
  }

  /** Pair the buffered request with its assistant message and write it. */
  recordResponse(message: AssistantMessage): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    const identity = extractProviderReportedIdentity(message, pending.requestModel);
    this.write({
      schemaVersion: NATIVE_PAYLOAD_CAPTURE_SCHEMA_VERSION,
      stage: this.stage,
      ...pending,
      responseModel: identity.reportedModel,
      responseId: identity.responseId,
      stopReason: String(message.stopReason ?? 'unknown'),
      ...(message.errorMessage
        ? { errorMessage: redactWithStats(message.errorMessage, this.profile).text }
        : {}),
      ...(message.usage ? { usage: message.usage } : {}),
    });
  }

  /** Write a buffered request that never got a response. */
  flushPending(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    this.write({
      schemaVersion: NATIVE_PAYLOAD_CAPTURE_SCHEMA_VERSION,
      stage: this.stage,
      ...pending,
      responseModel: null,
      responseId: null,
      stopReason: 'no-response',
    });
  }

  private write(record: CapturedPayloadRecord): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const stamp = String(Date.now()).padStart(13, '0');
      const seq = String(this.sequence++ % 10_000).padStart(4, '0');
      const fileName = `payload-${stamp}-${seq}-${randomBytes(3).toString('hex')}.json`;
      const filePath = path.join(this.dir, fileName);
      const tmpPath = `${filePath}.${randomUUID()}.tmp`;
      writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
      renameSync(tmpPath, filePath);
      this.evict();
    } catch (error) {
      console.warn(`native payload capture: failed to write ${this.stage} payload: ${(error as Error).message}`);
    }
  }

  /** Drop the oldest files until both caps hold, always keeping the newest. */
  private evict(): void {
    const files = listCapturedPayloadFiles(this.dir).map((file) => ({ file, bytes: statSync(file).size }));
    let totalBytes = files.reduce((sum, entry) => sum + entry.bytes, 0);
    while (files.length > 1 && (files.length > this.maxFiles || totalBytes > this.maxBytes)) {
      const oldest = files.shift()!;
      unlinkSync(oldest.file);
      totalBytes -= oldest.bytes;
    }
  }
}

/**
 * Wrap a `StreamFn` so every request it sends is recorded in `ring`. A
 * caller-supplied `onPayload` runs first and may replace the body; the ring
 * records whatever actually goes on the wire and never edits it.
 */
export function wrapStreamFnWithPayloadCapture(streamFn: StreamFn, ring: PayloadRingBuffer): StreamFn {
  return (model, context, options) => streamFn(model, context, {
    ...options,
    onPayload: async (payload, payloadModel) => {
      const replaced = await options?.onPayload?.(payload, payloadModel);
      ring.recordRequest(replaced === undefined ? payload : replaced, payloadModel);
      return replaced;
    },
  });
}

/**
 * Copy a stage's ring buffer to `destDir` so it outlives the feature dir.
 * Returns `destDir`, or undefined when there was nothing to copy or the copy
 * failed (best-effort: evidence never masks the failure it describes). A
 * second call replaces the earlier snapshot.
 */
export function snapshotPayloadsForFailure(
  featureDir: string,
  stage: string,
  destDir: string,
): string | undefined {
  const files = listCapturedPayloadFiles(getPayloadCaptureDir(featureDir, stage));
  if (files.length === 0) return undefined;
  try {
    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(destDir, { recursive: true });
    for (const file of files) {
      copyFileSync(file, path.join(destDir, path.basename(file)));
    }
    return destDir;
  } catch (error) {
    console.warn(`native payload capture: failed to snapshot ${stage} payloads: ${(error as Error).message}`);
    return undefined;
  }
}
