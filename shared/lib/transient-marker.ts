import { writeFileSync, rmSync, readFileSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';

export interface MarkerCondition {
  head?: string;
  expiresOn?: string[];
  operatorEventSeq?: number;
  reviewArtifact?: {
    stage: string;
    status: string;
    startedAt?: string;
    finishedAt?: string;
    verdict?: string;
    failureCategory?: string;
  } | null;
  readyArtifact?: {
    stage: string;
    status: string;
    startedAt?: string;
    finishedAt?: string;
    verdict?: string;
    failureCategory?: string;
  } | null;
  observed?: Record<string, string>;
  waitingOn?: {
    kind: string;
    value: string;
    prNumber?: number;
  };
  recheckAfter?: string; // ISO 8601
}

export interface MarkerPayload {
  schemaVersion: 1;
  kind: string;
  headSha: string;
  writtenAt: string; // ISO 8601
  reason?: string;
  detail?: Record<string, unknown>;
  condition?: MarkerCondition;
}

export interface MarkerHandle {
  path: string; // absolute file path
  kind: string; // for finding attribution
}

export type MarkerReadStatus =
  | { status: 'absent' }
  | { status: 'legacy'; body: string }
  | { status: 'present'; payload: MarkerPayload };

export type MarkerValidation<T = void> =
  | { status: 'valid'; payload: MarkerPayload; condition: T }
  | { status: 'stale-sha'; payload: MarkerPayload; currentHead: string }
  | { status: 'contradicted'; payload: MarkerPayload; reason: string }
  | { status: 'absent' }
  | { status: 'legacy'; body: string };

export interface Finding {
  subsystem: string;
  title: string;
  body?: string;
  severity?: 'info' | 'warning' | 'error';
  context?: Record<string, unknown>;
}

export function writeMarker(
  handle: MarkerHandle,
  args: {
    headSha: string;
    reason?: string;
    detail?: Record<string, unknown>;
    condition?: MarkerCondition;
  }
): void {
  const payload: MarkerPayload = {
    schemaVersion: 1,
    kind: handle.kind,
    headSha: args.headSha,
    writtenAt: new Date().toISOString(),
    reason: args.reason,
    detail: args.detail,
    condition: args.condition,
  };

  const content = JSON.stringify(payload, null, 2);
  const dir = dirname(handle.path);
  mkdirSync(dir, { recursive: true });

  const pid = process.pid;
  const uuid = randomUUID();
  const tmpPath = `${handle.path}.tmp.${pid}.${uuid}`;

  try {
    writeFileSync(tmpPath, content, 'utf8');
    renameSync(tmpPath, handle.path);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }
}

export function clearMarker(handle: MarkerHandle): void {
  rmSync(handle.path, { force: true });
}

export function readMarker(handle: MarkerHandle): MarkerReadStatus {
  try {
    const body = readFileSync(handle.path, 'utf8');
    try {
      const payload = JSON.parse(body) as MarkerPayload;
      if (
        typeof payload === 'object' &&
        payload !== null &&
        payload.schemaVersion === 1 &&
        typeof payload.kind === 'string' &&
        typeof payload.headSha === 'string' &&
        typeof payload.writtenAt === 'string'
      ) {
        return { status: 'present', payload };
      }
    } catch {
      // Not valid JSON
    }
    return { status: 'legacy', body };
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return { status: 'absent' };
    }
    throw err;
  }
}

export async function validateMarker<T = void>(
  handle: MarkerHandle,
  args: {
    currentHead: string;
    deriveCondition: (payload: MarkerPayload) => Promise<T | null> | T | null;
    onInvalidated?: (reason: 'stale-sha' | 'contradicted', payload: MarkerPayload) => void;
  }
): Promise<MarkerValidation<T>> {
  const readStatus = readMarker(handle);

  if (readStatus.status === 'absent') {
    return { status: 'absent' };
  }

  if (readStatus.status === 'legacy') {
    return { status: 'legacy', body: readStatus.body };
  }

  const payload = readStatus.payload;

  // Check for stale SHA
  if (payload.headSha !== args.currentHead) {
    if (args.onInvalidated) {
      args.onInvalidated('stale-sha', payload);
    }
    return { status: 'stale-sha', payload, currentHead: args.currentHead };
  }

  // Derive the condition
  const condition = await args.deriveCondition(payload);

  // Check if contradicted (condition is falsy)
  if (!condition) {
    if (args.onInvalidated) {
      args.onInvalidated('contradicted', payload);
    }
    return { status: 'contradicted', payload, reason: 'condition no longer holds' };
  }

  return { status: 'valid', payload, condition };
}

export function buildStaleMarkerFinding(
  handle: MarkerHandle,
  validation: MarkerValidation,
  context: { repo: string; prNumber?: number; taskId?: string }
): Finding | null {
  if (validation.status === 'absent' || validation.status === 'legacy') {
    return null;
  }

  const payload = validation.payload;

  if (validation.status === 'stale-sha') {
    return {
      subsystem: 'marker-lifecycle',
      title: `Stale marker: ${handle.kind}`,
      body: `Marker was written against SHA ${payload.headSha} but current head is ${validation.currentHead}. ` +
        `This marker should have been cleared when the head advanced.`,
      severity: 'warning',
      context: {
        markerPath: handle.path,
        markerKind: handle.kind,
        recordedSha: payload.headSha,
        currentHead: validation.currentHead,
        writtenAt: payload.writtenAt,
        reason: payload.reason,
        ...context,
      },
    };
  }

  if (validation.status === 'contradicted') {
    return {
      subsystem: 'marker-lifecycle',
      title: `Contradicted marker: ${handle.kind}`,
      body: `Marker was written but the underlying condition no longer holds (${validation.reason}). ` +
        `This marker should have been cleared.`,
      severity: 'warning',
      context: {
        markerPath: handle.path,
        markerKind: handle.kind,
        recordedSha: payload.headSha,
        writtenAt: payload.writtenAt,
        reason: payload.reason,
        contradictionReason: validation.reason,
        ...context,
      },
    };
  }

  return null;
}
