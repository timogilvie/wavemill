import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
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

/** Move Tend's existing claim to a head that Tend itself just pushed. */
export async function rebindTendHandoff(
  featureDir: string,
  prNumber: number,
  previousHeadSha: string,
  pushedHeadSha: string,
): Promise<HandoffOutcome> {
  let outcome: HandoffOutcome['outcome'] = 'rejected';
  const record = await mutateJsonState<ReadyTendHandoffRecord>(
    readyTendHandoffPath(featureDir),
    (current) => {
      if (matches(current, prNumber, pushedHeadSha) && current.state === 'tend-claimed' && current.tendOwner === 'tend') {
        outcome = 'already-claimed';
        return current;
      }
      if (!matches(current, prNumber, previousHeadSha) || current.state !== 'tend-claimed' || current.tendOwner !== 'tend') {
        return current;
      }
      outcome = 'claimed';
      return {
        ...newRecord(prNumber, pushedHeadSha, 'tend-claimed'),
        readyPublishedAt: current.readyPublishedAt,
        tendOwner: 'tend',
        tendClaimedAt: current.tendClaimedAt,
      };
    },
    { createIfMissing: true, initial: newRecord(prNumber, previousHeadSha) },
  );
  return { outcome, record };
}

export function isMatchingTendClaim(record: ReadyTendHandoffRecord | null, prNumber: number, headSha: string): boolean {
  return record !== null && matches(record, prNumber, headSha)
    && record.state === 'tend-claimed' && record.tendOwner === 'tend';
}

/**
 * Stale-worktree marker (HOK-3112).
 *
 * Tend rebases a PR in its own scratch worktree and force-pushes. The task
 * worktree that Ready runs in is never touched by that push, so it keeps the
 * pre-rebase commit. This marker records "the task worktree is behind the PR
 * head because Tend pushed" so that:
 *
 * - the monitor syncs the task worktree to the PR head before its next Ready
 *   run (a Ready pass at the stale checkout would otherwise publish the handoff
 *   at a head Tend can never claim), and
 * - Tend's HOK-3105 self-heal can prove the live head is Tend's own push (the
 *   recorded `pushedHeadSha`) before republishing the handoff there.
 *
 * The monitor clears the marker once the task worktree matches the PR head.
 */
export const TEND_PUSHED_HEAD_VERSION = 1;

export interface TendPushedHeadRecord {
  version: number;
  prNumber: number;
  /** PR head before Tend's push (the commit the task worktree still has). */
  previousHeadSha: string;
  /** Head Tend force-pushed to the PR branch. */
  pushedHeadSha: string;
  pushedAt: string;
  by: 'tend';
}

export function tendPushedHeadPath(featureDir: string): string {
  return join(featureDir, '.tend-pushed-head.json');
}

/** Record that Tend pushed `pushedHeadSha` over `previousHeadSha` on this PR. */
export async function recordTendPushedHead(
  featureDir: string,
  prNumber: number,
  previousHeadSha: string,
  pushedHeadSha: string,
): Promise<TendPushedHeadRecord> {
  const next: TendPushedHeadRecord = {
    version: TEND_PUSHED_HEAD_VERSION,
    prNumber,
    previousHeadSha,
    pushedHeadSha,
    pushedAt: new Date().toISOString(),
    by: 'tend',
  };
  return mutateJsonState<TendPushedHeadRecord>(
    tendPushedHeadPath(featureDir),
    (current) => {
      // Consecutive Tend pushes without an intervening monitor sync: keep the
      // oldest previous head, because that is what the task worktree still has.
      const keepPrevious = current?.version === TEND_PUSHED_HEAD_VERSION
        && current.prNumber === prNumber
        && current.pushedHeadSha === previousHeadSha
        && typeof current.previousHeadSha === 'string'
        && current.previousHeadSha.length > 0;
      return keepPrevious ? { ...next, previousHeadSha: current.previousHeadSha } : next;
    },
    { createIfMissing: true, initial: next },
  );
}

export function readTendPushedHead(featureDir: string): TendPushedHeadRecord | null {
  const path = tendPushedHeadPath(featureDir);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<TendPushedHeadRecord> | null;
    if (!value || typeof value !== 'object') return null;
    if (value.version !== TEND_PUSHED_HEAD_VERSION || typeof value.prNumber !== 'number'
      || typeof value.pushedHeadSha !== 'string' || !value.pushedHeadSha) return null;
    return value as TendPushedHeadRecord;
  } catch {
    return null;
  }
}

export function clearTendPushedHead(featureDir: string): void {
  rmSync(tendPushedHeadPath(featureDir), { force: true });
}
