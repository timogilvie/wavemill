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

/**
 * Typed reason for why a Tend claim (or rebind) was rejected (HOK-3108).
 *
 * - `missing`: the handoff file does not exist on disk. Ready has not published
 *   for this head; nothing to claim.
 * - `unreadable`: the file exists but cannot be parsed as JSON.
 * - `head-mismatch`: version/PR/head/token do not match what was requested. A
 *   force-push has landed and the record is bound to a different head.
 * - `not-published`: the record matches but state is `checked` — Ready has not
 *   yet published. (An agent applied wm:ready without a handoff, HOK-3107.)
 * - `terminal`: the record is in the terminal state.
 * - `foreign-claim`: `tend-claimed` without `tendOwner==='tend'` — some other
 *   holder owns the claim.
 * - `no-matching-tend-claim`: rebind found no matching `tend-claimed` record at
 *   the previous head that Tend can rebind.
 */
export type HandoffRejectionReason =
  | 'missing'
  | 'unreadable'
  | 'head-mismatch'
  | 'not-published'
  | 'terminal'
  | 'foreign-claim'
  | 'no-matching-tend-claim';

/**
 * Extended claim outcome (HOK-3108). Same shape as `HandoffOutcome` but with
 * `record: null` when no file exists or the file is unreadable, and an
 * optional `rejectionReason` for rejections. The tool's JSON output remains
 * compatible: it may now print `record:null` and a `rejectionReason` field.
 */
export interface ClaimHandoffOutcome {
  outcome: HandoffOutcome['outcome'];
  record: ReadyTendHandoffRecord | null;
  rejectionReason?: HandoffRejectionReason;
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

/**
 * Pure classifier for what a locked read of the handoff record means for a
 * claim at `(prNumber, headSha)`. `claimable` if state is `ready-published`
 * and the token matches; `already-claimed` if Tend already owns it. Otherwise
 * a typed rejection reason.
 */
export function classifyClaim(
  record: ReadyTendHandoffRecord | null,
  prNumber: number,
  headSha: string,
): 'claimable' | 'already-claimed' | HandoffRejectionReason {
  if (record === null) return 'missing';
  if (!matches(record, prNumber, headSha)) return 'head-mismatch';
  if (record.state === 'terminal') return 'terminal';
  if (record.state === 'checked') return 'not-published';
  if (record.state === 'tend-claimed') {
    return record.tendOwner === 'tend' ? 'already-claimed' : 'foreign-claim';
  }
  if (record.state === 'ready-published') return 'claimable';
  return 'head-mismatch';
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

/**
 * Attempt to transition a published Ready handoff into `tend-claimed` (HOK-3108).
 *
 * A rejection never writes to disk. In particular the pre-HOK-3108 behavior
 * of creating a fresh `checked` record when no file existed is gone: an agent
 * that applies `wm:ready` without a published handoff cannot masquerade as a
 * legitimate "Ready still checking" state.
 *
 * The two-phase read is:
 *   1. optimistic pre-read (no lock) to decide whether to even touch the file;
 *      a rejection stops here with no write, no create.
 *   2. locked re-validation under `mutateJsonState`. `createIfMissing:false`
 *      would throw `State file not found` if the file disappeared between
 *      steps — we catch that race and return a `missing` rejection.
 *
 * The rewrite on the locked pass never creates the file, but it does rewrite
 * an existing file with identical content when the classifier concurrently
 * changed (i.e. the record was already claimed by another process). This
 * matches `mutateJsonState`'s contract and is intentional; the file already
 * existed a moment ago, so an idempotent rewrite is acceptable.
 */
export async function claimReadyHandoff(featureDir: string, prNumber: number, headSha: string): Promise<ClaimHandoffOutcome> {
  const preRead = readReadyTendHandoff(featureDir);
  const path = readyTendHandoffPath(featureDir);
  if (preRead === null) {
    // Distinguish "file missing" from "file exists but is unreadable" so the
    // logged reason is precise. readReadyTendHandoff returns null for both.
    const reason: HandoffRejectionReason = existsSync(path) ? 'unreadable' : 'missing';
    return { outcome: 'rejected', record: null, rejectionReason: reason };
  }
  const classification = classifyClaim(preRead, prNumber, headSha);
  if (classification !== 'claimable' && classification !== 'already-claimed') {
    return { outcome: 'rejected', record: preRead, rejectionReason: classification };
  }

  let outcome: HandoffOutcome['outcome'] = 'rejected';
  let rejectionReason: HandoffRejectionReason | undefined;
  let record: ReadyTendHandoffRecord;
  try {
    record = await mutateJsonState<ReadyTendHandoffRecord>(
      path,
      (current) => {
        const locked = classifyClaim(current, prNumber, headSha);
        if (locked === 'already-claimed') {
          outcome = 'already-claimed';
          return current;
        }
        if (locked !== 'claimable') {
          outcome = 'rejected';
          rejectionReason = locked;
          return current;
        }
        outcome = 'claimed';
        return { ...current, state: 'tend-claimed', tendOwner: 'tend', tendClaimedAt: new Date().toISOString() };
      },
    );
  } catch (error) {
    // Race: file vanished between the optimistic pre-read and the locked read.
    if (error instanceof Error && /State file not found/.test(error.message)) {
      return { outcome: 'rejected', record: null, rejectionReason: 'missing' };
    }
    throw error;
  }
  return rejectionReason !== undefined
    ? { outcome, record, rejectionReason }
    : { outcome, record };
}

/**
 * Move Tend's existing claim to a head that Tend itself just pushed (HOK-3108).
 *
 * Like `claimReadyHandoff`, a rejection never writes to disk. The pre-HOK-3108
 * `createIfMissing:true` created a `checked` record when the handoff file was
 * missing entirely; that stray artifact is gone.
 */
export async function rebindTendHandoff(
  featureDir: string,
  prNumber: number,
  previousHeadSha: string,
  pushedHeadSha: string,
): Promise<ClaimHandoffOutcome> {
  const preRead = readReadyTendHandoff(featureDir);
  const path = readyTendHandoffPath(featureDir);
  if (preRead === null) {
    const reason: HandoffRejectionReason = existsSync(path) ? 'unreadable' : 'missing';
    return { outcome: 'rejected', record: null, rejectionReason: reason };
  }
  const alreadyReboundToPushed = matches(preRead, prNumber, pushedHeadSha)
    && preRead.state === 'tend-claimed'
    && preRead.tendOwner === 'tend';
  const readyToRebind = matches(preRead, prNumber, previousHeadSha)
    && preRead.state === 'tend-claimed'
    && preRead.tendOwner === 'tend';
  if (!alreadyReboundToPushed && !readyToRebind) {
    return { outcome: 'rejected', record: preRead, rejectionReason: 'no-matching-tend-claim' };
  }

  let outcome: HandoffOutcome['outcome'] = 'rejected';
  let rejectionReason: HandoffRejectionReason | undefined;
  let record: ReadyTendHandoffRecord;
  try {
    record = await mutateJsonState<ReadyTendHandoffRecord>(
      path,
      (current) => {
        if (matches(current, prNumber, pushedHeadSha) && current.state === 'tend-claimed' && current.tendOwner === 'tend') {
          outcome = 'already-claimed';
          return current;
        }
        if (!matches(current, prNumber, previousHeadSha) || current.state !== 'tend-claimed' || current.tendOwner !== 'tend') {
          outcome = 'rejected';
          rejectionReason = 'no-matching-tend-claim';
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
    );
  } catch (error) {
    if (error instanceof Error && /State file not found/.test(error.message)) {
      return { outcome: 'rejected', record: null, rejectionReason: 'missing' };
    }
    throw error;
  }
  return rejectionReason !== undefined
    ? { outcome, record, rejectionReason }
    : { outcome, record };
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

function shortSha(headSha: string): string {
  return headSha ? headSha.slice(0, 7) : '(unknown)';
}

/**
 * Human-readable text describing a claim rejection (HOK-3108). Feeds
 * `executeMerge`'s `failureExcerpt`, the loop's skip-reason log, and the
 * `wm:blocked` comment.
 */
export function describeClaimRejection(
  outcome: ClaimHandoffOutcome,
  prNumber: number,
  headSha: string,
): string {
  const shortHead = shortSha(headSha);
  const reason = outcome.rejectionReason ?? 'head-mismatch';
  switch (reason) {
    case 'missing':
      return `no Ready handoff file (.ready-tend-handoff.json) exists for PR #${prNumber} at head ${shortHead}`;
    case 'unreadable':
      return `Ready handoff file for PR #${prNumber} exists but is unreadable JSON`;
    case 'head-mismatch': {
      const recordedHead = outcome.record?.headSha ? shortSha(outcome.record.headSha) : '(unknown)';
      return `Ready handoff is bound to head ${recordedHead}, live head is ${shortHead}`;
    }
    case 'not-published':
      return `Ready handoff for PR #${prNumber} at head ${shortHead} is in state 'checked' (never published)`;
    case 'terminal':
      return `Ready handoff for PR #${prNumber} at head ${shortHead} is terminal`;
    case 'foreign-claim':
      return `Ready handoff for PR #${prNumber} at head ${shortHead} is already tend-claimed by another owner`;
    case 'no-matching-tend-claim':
      return `no matching Tend claim on the Ready handoff for PR #${prNumber} at head ${shortHead}`;
    default:
      return `Ready handoff rejected for PR #${prNumber} at head ${shortHead}`;
  }
}
