/**
 * Side-effect ledger shadow writes (HOK-3183 — Ledger D Phase 1).
 *
 * Every external effect the mill produces — a git push, a PR label write, a
 * Linear state transition, a PR merge, a tend merge-status comment — records one `side_effect` row keyed
 * as in design §4b (`docs/mill-task-ledger-design.md`). Phase 1 is shadow
 * only: rows are written alongside the existing ad-hoc guards and nothing
 * reads them on the decision path. A second request for an already-recorded
 * key bumps the row's `attempt` and leaves a `side-effect-duplicate-attempt`
 * evidence row, which is what the duplicate detector
 * (`side-effect-duplicate-detector.ts`) reports from the monitor tick.
 *
 * Phase 2 flips each call site, one at a time, to
 * "insert row → read `applied_at` → skip or apply" once the Gate holds. The
 * key builders here are the single source of truth for both phases.
 *
 * Writes only happen inside a mill process (`WAVEMILL_SESSION` set), never
 * from a unit test (`NODE_TEST_CONTEXT`) unless a test ledger was installed,
 * and never when `WAVEMILL_LEDGER_SHADOW_DISABLED=1`. Every failure is
 * swallowed: a shadow write must never fail the effect it records.
 *
 * @module side-effect-ledger
 */

import { Ledger, type SideEffectKind, type SideEffectRow } from './ledger.ts';
import { ensureIssueRoot, withShadowSuppressing } from './ledger-shadow.ts';
import { resolveLedgerRepoDir } from './label-write-ledger.ts';

/** Issue-root slug that owns side effects recorded with no task context. */
export const SHADOW_SIDE_EFFECT_ROOT_SLUG = '_shadow-side-effects';

/** Evidence event written when a key is requested a second time. */
export const DUPLICATE_ATTEMPT_EVENT = 'side-effect-duplicate-attempt';

/**
 * What the `pr-merge` key's oid names. Phase 1 keys on the PR head tend pushed
 * and merged; Phase 2 may tighten to the merge commit oid (one-line bump).
 */
export const MERGE_KEY_TARGET_SOURCE = 'pushed-head-sha';

export type PrLabelAction = 'labeled' | 'unlabeled';

const KEY_SEPARATOR = '|';

function keyPart(value: string | number): string {
  const text = String(value).trim();
  return text === '' ? 'unknown' : text;
}

function joinKey(parts: Array<string | number>): string {
  return parts.map(keyPart).join(KEY_SEPARATOR);
}

/** Normalise a branch name or ref to its full `refs/heads/<branch>` form. */
export function normalizePushRef(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.startsWith('refs/')) return trimmed;
  return `refs/heads/${trimmed.replace(/^heads\//, '')}`;
}

/** `git-push` key: `(remote, ref, oid)`. */
export function gitPushKey(remote: string, ref: string, oid: string): string {
  return joinKey([remote, normalizePushRef(ref), oid]);
}

/** `pr-label` key: `(pr_number, label, action, head_oid)`. */
export function prLabelKey(prNumber: number | string, label: string, action: PrLabelAction, headOid: string | null | undefined): string {
  return joinKey([prNumber, label, action, headOid ?? '']);
}

/** Prefix shared by every `pr-label` key for one (PR, label, action), across heads. */
export function prLabelKeyPrefix(prNumber: number | string, label: string, action: PrLabelAction): string {
  return `${joinKey([prNumber, label, action])}${KEY_SEPARATOR}`;
}

/** `pr-merge` key: `(pr_number, merge_commit_target_oid)`. */
export function prMergeKey(prNumber: number | string, mergeCommitTargetOid: string): string {
  return joinKey([prNumber, mergeCommitTargetOid]);
}

/**
 * `pr-comment` key: `(pr_number, phase, head_oid, base_oid)` (HOK-3316). One
 * merge-status comment per tend failure condition; the same condition seen
 * again is an observation, never a second comment.
 */
export function prCommentKey(prNumber: number | string, phase: string, headOid: string | null | undefined, baseOid: string | null | undefined): string {
  return joinKey([prNumber, phase, headOid ?? '', baseOid ?? '']);
}

/** `linear-transition` key: `(issue_key, from_state, to_state, trigger_event_id)`. */
export function linearTransitionKey(issueKey: string, fromState: string | null | undefined, toState: string, triggerEventId: string): string {
  return joinKey([issueKey, fromState ?? '', toState, triggerEventId]);
}

/**
 * Best-effort trigger event id for a Linear transition whose caller did not
 * pass one: same hint + target state within the same second collapse to one
 * key (a retried call), different events do not.
 */
export function synthesizeTriggerEventId(hint: string | undefined, toState: string, now: Date = new Date()): string {
  return `direct:${keyPart(hint ?? 'unknown')}:${keyPart(toState)}:${now.toISOString().slice(0, 19)}`;
}

export interface ShadowSideEffectInput {
  kind: SideEffectKind;
  idempotencyKey: string;
  /** The effect's outcome, captured after the external call returned; sets `applied_at`. */
  result?: unknown;
  /**
   * True when the caller observed the effect already in place rather than
   * performing it (branch already published, PR already merged). An
   * observation never counts as a duplicate attempt.
   */
  observation?: boolean;
  /** Explicit owner step; overrides issue attribution. */
  stepId?: string;
  /** Issue/task key owning the effect; defaults to `WAVEMILL_ISSUE`. */
  issueKey?: string;
  /** Repo whose task ledger receives the row. */
  repoDir?: string;
  /** Working directory used to find the main checkout when `repoDir` is absent. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ShadowSideEffectOutcome {
  row: SideEffectRow;
  isNew: boolean;
  /** True when this request repeated an already-recorded key. */
  duplicate: boolean;
}

let testLedger: Ledger | null = null;

/**
 * Route every shadow write in this process to `ledger` (tests only), bypassing
 * the mill-session gate. Pass null to restore normal resolution.
 */
export function setSideEffectLedgerForTesting(ledger: Ledger | null): void {
  testLedger = ledger;
}

function resolveTargetLedger(input: ShadowSideEffectInput, env: NodeJS.ProcessEnv): Ledger | null {
  if (testLedger) return testLedger;
  if (!env.WAVEMILL_SESSION) return null;
  // A unit test running inside a mill pane inherits WAVEMILL_SESSION; its
  // mocked effects must not land in the real repo's ledger.
  if (env.NODE_TEST_CONTEXT) return null;
  const repoDir = input.repoDir ?? resolveLedgerRepoDir(env, input.cwd ?? process.cwd());
  if (!repoDir) return null;
  return Ledger.open({ repoDir });
}

/**
 * Resolve the task row that owns a side effect: the explicit step, else the
 * issue root for `issueKey` / `WAVEMILL_ISSUE`, else the singleton
 * `_shadow-side-effects` root. Attribution is best-effort in Phase 1 — the
 * duplicate detector keys on `(kind, idempotency_key)`, not the owner.
 */
export function resolveSideEffectOwner(ledger: Ledger, input: Pick<ShadowSideEffectInput, 'stepId' | 'issueKey'>, env: NodeJS.ProcessEnv = process.env): string {
  if (input.stepId) return input.stepId;
  const issueKey = input.issueKey ?? env.WAVEMILL_ISSUE;
  return ensureIssueRoot(ledger, issueKey && issueKey.trim() ? issueKey.trim() : SHADOW_SIDE_EFFECT_ROOT_SLUG).id;
}

function recordInLedger(ledger: Ledger, input: ShadowSideEffectInput, env: NodeJS.ProcessEnv): ShadowSideEffectOutcome {
  const ownerId = resolveSideEffectOwner(ledger, input, env);
  return ledger.transaction((tx) => {
    const { row, isNew } = tx.recordSideEffect({ stepId: ownerId, kind: input.kind, idempotencyKey: input.idempotencyKey });
    if (isNew) {
      const applied = input.result === undefined ? row : tx.applySideEffect(row.id, input.result);
      return { row: applied, isNew, duplicate: false };
    }
    if (input.observation) {
      // Already-in-place observation of a recorded effect: fill applied_at if
      // the original request never recorded its outcome, never count it.
      const applied = row.applied_at || input.result === undefined ? row : tx.applySideEffect(row.id, input.result);
      return { row: applied, isNew, duplicate: false };
    }
    const bumped = tx.incrementSideEffectAttempt(row.id);
    tx.recordEvidence(row.step_id, 'controller', DUPLICATE_ATTEMPT_EVENT, `${input.kind}${KEY_SEPARATOR}${input.idempotencyKey}`);
    return { row: bumped, isNew, duplicate: true };
  });
}

/**
 * Shadow-record one side effect. Returns null when the write was skipped
 * (outside the mill, kill switch, binding unavailable) or failed. Never throws.
 */
export function shadowRecordSideEffect(input: ShadowSideEffectInput): ShadowSideEffectOutcome | null {
  const env = input.env ?? process.env;
  if (env.WAVEMILL_LEDGER_SHADOW_DISABLED === '1') return null;
  return withShadowSuppressing(() => {
    const ledger = resolveTargetLedger(input, env);
    if (!ledger) return null;
    const outcome = recordInLedger(ledger, input, env);
    if (outcome.duplicate) {
      console.warn(`[ledger-shadow] duplicate side-effect attempt: kind=${input.kind} key=${input.idempotencyKey} attempt=${outcome.row.attempt}`);
    }
    return outcome;
  });
}
