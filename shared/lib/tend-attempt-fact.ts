/**
 * Tend merge-attempt fact (HOK-3316).
 *
 * When tend's merge attempt for a PR fails (per-commit rebase, CI on the
 * pushed head, the in-lane Ready re-check, the merge call, the Ready → Tend
 * handoff, or the scratch worktree), the outcome is recorded here as one
 * condition-keyed marker (HOK-3172) in the task's state dir. It is a *fact*,
 * not a label: `deriveMergeLabel()` reads it as one more input and renders
 * `wm:blocked` with reason `tend-<phase>-failed` while the fact holds.
 *
 * The fact is keyed on `(PR head SHA, integration base SHA)`:
 *
 * - A new PR head expires it — the condition reconciler's `remote` trigger
 *   clears the file once the PR cache shows another `headRefOid`, and every
 *   reader also refuses a fact recorded for another head.
 * - A moved integration base expires it consumer-side: readers compare the
 *   recorded `baseSha` with the live integration tip and treat a mismatch as
 *   "no fact", so the PR is eligible again and tend makes exactly one new
 *   attempt against the new base.
 * - An operator event (`advance`, `re-review`) clears it through the
 *   reconciler's `operator-event` trigger.
 *
 * The `head` trigger is deliberately not used: tend pushes from its own
 * scratch worktree, so after a rebase + push the task worktree HEAD is not
 * the PR head and the trigger would clear a fact for the pushed head at once.
 *
 * Nothing but the reconciler clears this file; gates never clear markers.
 *
 * @module tend-attempt-fact
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMarker, writeMarker, type MarkerHandle } from './transient-marker.ts';
import type { FailureClass } from './failure-policy.ts';
import { getIntegrationConfig } from './config.ts';

/** File name of the fact in the task's state (feature) dir. */
export const TEND_ATTEMPT_FACT_FILE = '.tend-attempt-result.json';

/** Marker kind recorded in the payload, for attribution in findings. */
export const TEND_ATTEMPT_FACT_KIND = 'tend-attempt';

/** The merge-attempt phases a fact can name; the label reason is `tend-<phase>-failed`. */
export const TEND_ATTEMPT_PHASES = ['rebase', 'checks', 'ready', 'merge', 'handoff', 'worktree'] as const;
export type TendAttemptPhase = typeof TEND_ATTEMPT_PHASES[number];

export interface TendAttemptFact {
  phase: TendAttemptPhase;
  prNumber: number;
  /** PR head the attempt ran against (the pushed head once tend has pushed). */
  headSha: string;
  /** Integration branch tip the attempt ran against. */
  baseSha: string;
  /** Truncated tend output for the failure. */
  excerpt: string;
  /** HOK-3176 failure-policy class of the failure. */
  failureClass: FailureClass;
  writtenAt: string;
}

export function tendAttemptFactHandle(featureDir: string): MarkerHandle {
  return { path: join(featureDir, TEND_ATTEMPT_FACT_FILE), kind: TEND_ATTEMPT_FACT_KIND };
}

/**
 * Map a tend block phase onto the closed fact phase set. `worktree-timeout`
 * (scratch-prep budget exhausted) is a worktree failure; any phase tend does
 * not otherwise name is attributed to the merge step that ran last.
 */
export function normalizeTendAttemptPhase(phase: string): TendAttemptPhase {
  if ((TEND_ATTEMPT_PHASES as readonly string[]).includes(phase)) {
    return phase as TendAttemptPhase;
  }
  if (phase.startsWith('worktree')) {
    return 'worktree';
  }
  if (phase.startsWith('handoff')) {
    return 'handoff';
  }
  return 'merge';
}

/** `tend-<phase>-failed`: the derived-label reason for a valid fact. */
export function tendAttemptBlockReason(phase: TendAttemptPhase): string {
  return `tend-${phase}-failed`;
}

/** Current `.operator-events.jsonl` seq (line count), matching `operator_event_seq`. */
function currentOperatorEventSeq(featureDir: string): number {
  const eventsPath = join(featureDir, '.operator-events.jsonl');
  if (!existsSync(eventsPath)) return 0;
  try {
    return readFileSync(eventsPath, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return 0;
  }
}

/**
 * Record the outcome of a failed tend merge attempt. Overwrites any previous
 * fact for the task: one attempt, one fact. Throws on a write failure so the
 * caller can log it (the caller must not fall back to a label write).
 */
export function writeTendAttemptFact(featureDir: string, fact: Omit<TendAttemptFact, 'writtenAt'>): void {
  writeMarker(tendAttemptFactHandle(featureDir), {
    headSha: fact.headSha,
    reason: tendAttemptBlockReason(fact.phase),
    detail: {
      phase: fact.phase,
      prNumber: fact.prNumber,
      baseSha: fact.baseSha,
      excerpt: fact.excerpt,
      failureClass: fact.failureClass,
    },
    condition: {
      expiresOn: ['remote', 'operator-event'],
      operatorEventSeq: currentOperatorEventSeq(featureDir),
      observed: { prHeadRefOid: fact.headSha, integrationBaseSha: fact.baseSha },
    },
  });
}

/**
 * Read the recorded fact, or null when absent or malformed. Does not judge
 * whether it still holds — see {@link readValidTendAttemptFact}.
 */
export function readTendAttemptFact(featureDir: string): TendAttemptFact | null {
  let status;
  try {
    status = readMarker(tendAttemptFactHandle(featureDir));
  } catch (error) {
    console.warn(`[tend-attempt] fact-read-failed featureDir=${featureDir} error=${String(error)}`);
    return null;
  }
  if (status.status !== 'present' || status.payload.kind !== TEND_ATTEMPT_FACT_KIND) {
    return null;
  }
  const { payload } = status;
  const detail = payload.detail ?? {};
  const phase = typeof detail.phase === 'string' ? detail.phase : '';
  const baseSha = typeof detail.baseSha === 'string' ? detail.baseSha : '';
  if (!(TEND_ATTEMPT_PHASES as readonly string[]).includes(phase) || !payload.headSha) {
    return null;
  }
  const failureClass = detail.failureClass;
  return {
    phase: phase as TendAttemptPhase,
    prNumber: typeof detail.prNumber === 'number' ? detail.prNumber : 0,
    headSha: payload.headSha,
    baseSha,
    excerpt: typeof detail.excerpt === 'string' ? detail.excerpt : '',
    failureClass: failureClass === 'terminal' || failureClass === 'retryable' ? failureClass : 'code-failure',
    writtenAt: payload.writtenAt,
  };
}

/**
 * True when `fact` still holds for the live PR head and integration base.
 * An unknown live base (`''`/undefined) never validates a fact that recorded
 * one: the reader cannot prove the base has not moved, and a stale block is
 * worse than one extra tend attempt.
 */
export function tendAttemptFactHolds(
  fact: Pick<TendAttemptFact, 'headSha' | 'baseSha'>,
  live: { prHeadSha: string; integrationBaseSha?: string },
): boolean {
  if (!fact.headSha || fact.headSha !== live.prHeadSha) {
    return false;
  }
  if (!fact.baseSha) {
    // The attempt could not resolve its base; the head key alone holds it.
    return true;
  }
  return !!live.integrationBaseSha && fact.baseSha === live.integrationBaseSha;
}

/** The recorded fact when it still holds for this head and base, else null. */
export function readValidTendAttemptFact(
  featureDir: string,
  live: { prHeadSha: string; integrationBaseSha?: string },
): TendAttemptFact | null {
  const fact = readTendAttemptFact(featureDir);
  return fact && tendAttemptFactHolds(fact, live) ? fact : null;
}

/**
 * Tip of the configured integration branch as this checkout last fetched it
 * (`refs/remotes/origin/<branch>`), or undefined. Tend's health check fetches
 * the branch at the top of every poll, before the reconciler runs, so the
 * tip is at most one poll old. Never throws.
 */
export function resolveIntegrationBaseSha(repoDir: string, integrationBranch?: string): string | undefined {
  let branch = integrationBranch;
  if (!branch) {
    try {
      branch = getIntegrationConfig(repoDir).integrationBranch;
    } catch {
      return undefined;
    }
  }
  if (!branch) return undefined;
  try {
    const sha = execFileSync('git', ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}^{commit}`], {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
    }).trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}
