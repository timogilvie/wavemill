import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactWithStats } from './redaction-profiles.ts';
import { mutateJsonState } from './state-mutex.ts';

/**
 * The Ready → Tend protocol is a small, local compare-and-set record. GitHub
 * remains authoritative for `headSha`; callers must pass a freshly-read head.
 *
 * checked → ready-published → tend-claimed → terminal
 *
 * The record is intentionally additive beside .ready-result.json. A retry for
 * the same PR/head receives the recorded result; a different head replaces the
 * old record and therefore cannot inherit its ownership or retry budget.
 */
export const READY_TEND_HANDOFF_VERSION = 1;
export type ReadyTendState = 'checked' | 'ready-published' | 'tend-claimed' | 'terminal';
export type TransitionFailureStage = 'route-stamp' | 'ready-label' | 'ownership-changed' | 'github-api';

export interface TransitionCommandDiagnostic {
  stage: TransitionFailureStage;
  command?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  redacted: boolean;
  truncated: boolean;
}

export interface ReadyTendHandoffRecord {
  version: number;
  prNumber: number;
  headSha: string;
  token: string;
  state: ReadyTendState;
  checkedAt?: string;
  readyPublishedAt?: string;
  tendOwner?: 'tend';
  tendClaimedAt?: string;
  terminalAt?: string;
  transitionFailure?: TransitionCommandDiagnostic;
}

export interface HandoffOutcome {
  outcome: 'published' | 'claimed' | 'already-published' | 'already-claimed' | 'rejected';
  record: ReadyTendHandoffRecord;
}

export function readyTendHandoffPath(featureDir: string): string {
  return join(featureDir, '.ready-tend-handoff.json');
}

export function handoffToken(prNumber: number, headSha: string): string {
  return createHash('sha256').update(`ready-tend:${prNumber}:${headSha}`).digest('hex');
}

export function captureTransitionDiagnostic(input: {
  stage: TransitionFailureStage;
  command?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  maxChars?: number;
}): TransitionCommandDiagnostic {
  const maxChars = input.maxChars ?? 2_000;
  const stdout = boundRedacted(input.stdout, maxChars);
  const stderr = boundRedacted(input.stderr, maxChars);
  return {
    stage: input.stage,
    ...(input.command ? { command: input.command } : {}),
    ...(typeof input.exitCode === 'number' ? { exitCode: input.exitCode } : {}),
    ...(stdout.text ? { stdout: stdout.text } : {}),
    ...(stderr.text ? { stderr: stderr.text } : {}),
    redacted: stdout.redacted || stderr.redacted,
    truncated: stdout.truncated || stderr.truncated,
  };
}

function boundRedacted(value: string | undefined, maxChars: number): { text: string; redacted: boolean; truncated: boolean } {
  const result = redactWithStats(value ?? '');
  const normalized = result.text.split('\n').slice(0, 40).join('\n');
  return {
    text: normalized.slice(0, maxChars),
    redacted: result.redacted,
    truncated: normalized.length > maxChars || result.text.split('\n').length > 40,
  };
}

function newRecord(prNumber: number, headSha: string, state: ReadyTendState = 'checked'): ReadyTendHandoffRecord {
  return {
    version: READY_TEND_HANDOFF_VERSION,
    prNumber,
    headSha,
    token: handoffToken(prNumber, headSha),
    state,
    checkedAt: new Date().toISOString(),
  };
}

function matches(record: ReadyTendHandoffRecord, prNumber: number, headSha: string): boolean {
  return record.version === READY_TEND_HANDOFF_VERSION
    && record.prNumber === prNumber
    && record.headSha === headSha
    && record.token === handoffToken(prNumber, headSha);
}

export function readReadyTendHandoff(featureDir: string): ReadyTendHandoffRecord | null {
  const path = readyTendHandoffPath(featureDir);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as ReadyTendHandoffRecord;
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}

/** Persist the successful Ready-check evidence before any external label write. */
export async function recordReadyChecked(featureDir: string, prNumber: number, headSha: string): Promise<ReadyTendHandoffRecord> {
  return mutateJsonState<ReadyTendHandoffRecord>(
    readyTendHandoffPath(featureDir),
    (current) => {
      if (!matches(current, prNumber, headSha)) return newRecord(prNumber, headSha);
      return current;
    },
    { createIfMissing: true, initial: newRecord(prNumber, headSha) },
  );
}

export async function publishReadyHandoff(featureDir: string, prNumber: number, headSha: string): Promise<HandoffOutcome> {
  let outcome: HandoffOutcome['outcome'] = 'published';
  const record = await mutateJsonState<ReadyTendHandoffRecord>(
    readyTendHandoffPath(featureDir),
    (current) => {
      if (!matches(current, prNumber, headSha)) {
        return { ...newRecord(prNumber, headSha, 'ready-published'), readyPublishedAt: new Date().toISOString() };
      }
      if (current.state === 'tend-claimed') {
        outcome = 'already-claimed';
        return current;
      }
      if (current.state === 'ready-published') {
        outcome = 'already-published';
        return current;
      }
      if (current.state === 'terminal') {
        outcome = 'rejected';
        return current;
      }
      return { ...current, state: 'ready-published', readyPublishedAt: new Date().toISOString(), transitionFailure: undefined };
    },
    { createIfMissing: true, initial: newRecord(prNumber, headSha) },
  );
  return { outcome, record };
}

export async function claimReadyHandoff(featureDir: string, prNumber: number, headSha: string): Promise<HandoffOutcome> {
  let outcome: HandoffOutcome['outcome'] = 'rejected';
  const record = await mutateJsonState<ReadyTendHandoffRecord>(
    readyTendHandoffPath(featureDir),
    (current) => {
      if (!matches(current, prNumber, headSha)) return current;
      if (current.state === 'tend-claimed' && current.tendOwner === 'tend') {
        outcome = 'already-claimed';
        return current;
      }
      if (current.state !== 'ready-published') return current;
      outcome = 'claimed';
      return { ...current, state: 'tend-claimed', tendOwner: 'tend', tendClaimedAt: new Date().toISOString() };
    },
    { createIfMissing: true, initial: newRecord(prNumber, headSha) },
  );
  return { outcome, record };
}

export function isMatchingTendClaim(record: ReadyTendHandoffRecord | null, prNumber: number, headSha: string): boolean {
  return record !== null && matches(record, prNumber, headSha)
    && record.state === 'tend-claimed' && record.tendOwner === 'tend';
}
