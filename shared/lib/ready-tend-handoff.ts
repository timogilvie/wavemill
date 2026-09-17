import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mutateJsonState } from './state-mutex.ts';

export type HandoffState = 'ready-published' | 'tend-claimed';

export type HandoffFailureStage =
  | 'route-stamp'
  | 'ready-label'
  | 'ownership-changed'
  | 'github-api';

export interface HandoffRecord {
  schemaVersion: 1;
  prNumber: number;
  headSha: string;
  state: HandoffState;
  owner: 'ready' | 'tend';
  publishedAt: string;
  claimedAt?: string;
  failureStage?: HandoffFailureStage;
  diagnosticExcerpt?: string;
}

export interface HandoffResult {
  outcome: 'published' | 'claimed' | 'already-claimed' | 'stale-head' | 'conflict';
  record: HandoffRecord;
}

function handoffPath(stateDir: string): string {
  return join(stateDir, '.ready-tend-handoff.json');
}

function redactDiagnostic(text: string, maxLen = 500): string {
  return text
    .replace(/gh[opusr]_[A-Za-z0-9_]+/g, '[redacted-token]')
    .replace(/(token|secret|password|api[_-]?key)=\S+/gi, '$1=[redacted]')
    .replace(/\/Users\/[^\s/]+/g, '/Users/[redacted]')
    .slice(0, maxLen);
}

export function readHandoffRecord(stateDir: string): HandoffRecord | null {
  const filePath = handoffPath(stateDir);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    if (parsed && typeof parsed === 'object' && (parsed as HandoffRecord).schemaVersion === 1) {
      return parsed as HandoffRecord;
    }
    return null;
  } catch {
    return null;
  }
}

export async function publishReadyHandoff(
  stateDir: string,
  prNumber: number,
  headSha: string,
): Promise<HandoffResult> {
  const filePath = handoffPath(stateDir);
  const existing = readHandoffRecord(stateDir);

  if (existing && existing.headSha === headSha && existing.prNumber === prNumber) {
    if (existing.state === 'tend-claimed') {
      return { outcome: 'already-claimed', record: existing };
    }
    return { outcome: 'published', record: existing };
  }

  const record: HandoffRecord = {
    schemaVersion: 1,
    prNumber,
    headSha,
    state: 'ready-published',
    owner: 'ready',
    publishedAt: new Date().toISOString(),
  };

  const result = await mutateJsonState<HandoffRecord>(
    filePath,
    () => record,
    { createIfMissing: true, initial: record },
  );

  return { outcome: 'published', record: result };
}

export async function claimTendHandoff(
  stateDir: string,
  prNumber: number,
  headSha: string,
): Promise<HandoffResult> {
  const existing = readHandoffRecord(stateDir);

  if (!existing) {
    const record: HandoffRecord = {
      schemaVersion: 1,
      prNumber,
      headSha,
      state: 'tend-claimed',
      owner: 'tend',
      publishedAt: new Date().toISOString(),
      claimedAt: new Date().toISOString(),
    };
    const result = await mutateJsonState<HandoffRecord>(
      handoffPath(stateDir),
      () => record,
      { createIfMissing: true, initial: record },
    );
    return { outcome: 'claimed', record: result };
  }

  if (existing.headSha !== headSha) {
    return { outcome: 'stale-head', record: existing };
  }

  if (existing.prNumber !== prNumber) {
    return { outcome: 'conflict', record: existing };
  }

  if (existing.state === 'tend-claimed' && existing.owner === 'tend') {
    return { outcome: 'already-claimed', record: existing };
  }

  const result = await mutateJsonState<HandoffRecord>(
    handoffPath(stateDir),
    (current) => ({
      ...current,
      state: 'tend-claimed',
      owner: 'tend',
      claimedAt: new Date().toISOString(),
    }),
    { createIfMissing: false },
  );

  return { outcome: 'claimed', record: result };
}

export function isTendClaimedForHead(
  stateDir: string,
  prNumber: number,
  headSha: string,
): boolean {
  const record = readHandoffRecord(stateDir);
  return record !== null
    && record.state === 'tend-claimed'
    && record.owner === 'tend'
    && record.prNumber === prNumber
    && record.headSha === headSha;
}

export async function recordHandoffFailure(
  stateDir: string,
  stage: HandoffFailureStage,
  diagnosticOutput?: string,
): Promise<void> {
  const existing = readHandoffRecord(stateDir);
  if (!existing) return;

  await mutateJsonState<HandoffRecord>(
    handoffPath(stateDir),
    (current) => ({
      ...current,
      failureStage: stage,
      diagnosticExcerpt: diagnosticOutput ? redactDiagnostic(diagnosticOutput) : undefined,
    }),
    { createIfMissing: false },
  );
}
