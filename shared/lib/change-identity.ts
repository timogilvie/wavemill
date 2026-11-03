/**
 * The one head-freshness primitive (HOK-3370).
 *
 * Evidence binds to the *change*, not the head SHA. A task's change identity
 * is the stable patch-id of its diff against the merge-base with the base
 * branch: a base merge or a clean rebase keeps the identity (review evidence
 * stays fresh), while a reviewer, remediation or conflict commit changes it
 * (evidence is stale and review re-runs through the existing stage path).
 *
 * Consumers (pr-route-provenance, review identity, monitor reconciliation)
 * call `isEvidenceFresh` instead of comparing raw head SHAs. Raw head-SHA
 * freshness comparisons outside this module are forbidden
 * (`tools/check-head-publication.ts`).
 */

import { execFileSync, spawnSync } from 'node:child_process';

export interface ChangeIdentity {
  /** Stable patch-id of `diff(merge-base(head, base)..head)`; 'empty' when the diff is empty. */
  changeId: string;
  headSha: string;
  mergeBase: string;
}

export type EvidenceFreshness =
  | { fresh: true; reason: 'same-head' | 'same-change-identity' }
  | {
      fresh: false;
      reason:
        | 'change-identity-differs'
        | 'evidence-head-unreachable'
        | 'current-head-unreachable'
        | 'compute-failed';
    };

const CHANGE_ID_EMPTY = 'empty';

function git(gitDir: string, args: string[]): string {
  return execFileSync('git', ['-C', gitDir, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/**
 * Compute the change identity of `headSha` against `baseRef`.
 *
 * Returns null when the objects are unreachable or git fails — callers treat
 * null as "cannot prove freshness" (stale), never as fresh.
 */
export function computeChangeIdentity(
  gitDir: string,
  headSha: string,
  baseRef: string,
): ChangeIdentity | null {
  let mergeBase: string;
  try {
    mergeBase = git(gitDir, ['merge-base', headSha, baseRef]);
  } catch {
    return null;
  }
  if (!mergeBase) return null;

  // `git diff | git patch-id --stable` — the stable patch-id is invariant
  // under rebase/merge reordering of unrelated history, exactly the
  // "same change" equivalence evidence freshness needs.
  let diff: string;
  try {
    diff = execFileSync('git', ['-C', gitDir, 'diff', `${mergeBase}..${headSha}`], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  if (!diff.trim()) {
    return { changeId: CHANGE_ID_EMPTY, headSha, mergeBase };
  }

  const patchId = spawnSync('git', ['-C', gitDir, 'patch-id', '--stable'], {
    input: diff,
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (patchId.status !== 0) return null;
  const changeId = (patchId.stdout || '').trim().split(/\s+/)[0] || '';
  if (!changeId) return null;
  return { changeId, headSha, mergeBase };
}

export interface EvidenceFreshnessRequest {
  /** Git dir (worktree) the SHAs are resolvable in. */
  gitDir: string;
  /** Head SHA the evidence (review/stage result) was recorded at. */
  evidenceHeadSha: string;
  /** Current head SHA the evidence is being judged against. */
  currentHeadSha: string;
  /** Base ref for the merge-base (e.g. `origin/auto/integration`). */
  baseRef: string;
  /**
   * Change identity recorded with the evidence, when the writer stored it.
   * Saves one computation; the evidence head need not be reachable then.
   */
  evidenceChangeId?: string;
}

/**
 * Decide whether stage evidence recorded at `evidenceHeadSha` is still fresh
 * for `currentHeadSha`.
 *
 * Fast path: identical heads are fresh. Otherwise the two change identities
 * are compared: equal → fresh (base merge / clean rebase), different →
 * stale. Unreachable objects → stale (today's behaviour; never less safe).
 */
export function isEvidenceFresh(request: EvidenceFreshnessRequest): EvidenceFreshness {
  const { gitDir, evidenceHeadSha, currentHeadSha, baseRef } = request;
  if (!evidenceHeadSha || !currentHeadSha) {
    return { fresh: false, reason: 'compute-failed' };
  }
  if (evidenceHeadSha === currentHeadSha) {
    return { fresh: true, reason: 'same-head' };
  }

  const current = computeChangeIdentity(gitDir, currentHeadSha, baseRef);
  if (!current) {
    return { fresh: false, reason: 'current-head-unreachable' };
  }

  let evidenceChangeId = request.evidenceChangeId?.trim() || '';
  if (!evidenceChangeId) {
    const evidence = computeChangeIdentity(gitDir, evidenceHeadSha, baseRef);
    if (!evidence) {
      return { fresh: false, reason: 'evidence-head-unreachable' };
    }
    evidenceChangeId = evidence.changeId;
  }

  if (evidenceChangeId === current.changeId) {
    return { fresh: true, reason: 'same-change-identity' };
  }
  return { fresh: false, reason: 'change-identity-differs' };
}
