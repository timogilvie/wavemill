/**
 * Review-loop round counting for the MQ-0.1 baseline (HOK-3336).
 *
 * Two different loops are counted:
 *
 * - **Review rounds** — reviewer passes over the PR. Sources, best first:
 *   `.review-result.json.artifacts.reviewIterations[]` (HOK-2969, append-only
 *   across review invocations); one `helper:*review*` session per
 *   self-review tool pass (launch-record era); `artifacts.iterations` (the
 *   final review run only); distinct review stage launches (launch-record
 *   rows only — a legacy session count is not a launch count).
 * - **Recode rounds** — coding launches after the first: a full author ↔
 *   reviewer cycle where the coder was relaunched.
 *
 * Finding attribution (pre-existing vs newly changed code) is file-level only:
 * a finding whose file is in that iteration's `reviewerDelta.filesChanged` is
 * on changed code. Line-level blame needs the reaped branch history and is a
 * reported gap.
 *
 * @module cost-baseline/review-rounds
 */

import type { BaselineSession, BaselineTask, ReviewLoopMetrics } from './types.ts';

/** True for ownership kinds that are a review pass (`review`, `helper:json-code-review`, ...). */
export function isReviewKind(kind: string): boolean {
  return kind === 'review' || (kind.startsWith('helper:') && kind.includes('review'));
}

/**
 * Distinct launches of `kind`, keyed by the ownership row's launch evidence.
 * Returns null when sessions of the kind exist but none names its launch
 * (records from before launch-record attribution), so callers can tell
 * "zero launches" from "not countable".
 */
export function countLaunches(sessions: BaselineSession[], kind: string): number | null {
  const ofKind = sessions.filter((s) => s.kind === kind);
  if (ofKind.length === 0) return 0;
  const keyed = new Set(ofKind.map((s) => s.launchEvidence).filter((e): e is string => e !== null));
  if (keyed.size === 0) return null;
  // A session without evidence beside keyed ones is another session of a
  // recorded launch (e.g. a Codex sub-thread), never an extra launch.
  return keyed.size;
}

/**
 * Launch evidence strings of `kind`, ordered by launch epoch
 * (`launch <kind>@<head>#<epoch> at ...`), falling back to first-turn time.
 */
export function orderedLaunches(sessions: BaselineSession[], kind: string): string[] {
  const firstSeen = new Map<string, number>();
  for (const session of sessions) {
    if (session.kind !== kind || !session.launchEvidence) continue;
    const epoch = /#(\d+)/.exec(session.launchEvidence);
    const at = epoch ? Number(epoch[1]) * 1000 : Date.parse(session.firstTurnAt ?? '') || Number.MAX_SAFE_INTEGER;
    const known = firstSeen.get(session.launchEvidence);
    firstSeen.set(session.launchEvidence, known === undefined ? at : Math.min(known, at));
  }
  return [...firstSeen.entries()].sort((a, b) => a[1] - b[1]).map(([evidence]) => evidence);
}

const SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?|sh|md|json|ya?ml|py|sql|toml)$/;

/**
 * File path of a finding location (`path/file.ts:12`, `path/file.ts:12-20`);
 * null for symbol or prose locations (`module.foo()`, `README section 4`).
 */
export function findingFile(location: string): string | null {
  const head = (location.trim().split(/[\s:(#]/)[0] ?? '').replace(/^\.\//, '');
  return SOURCE_FILE_RE.test(head) ? head : null;
}

function fileInDelta(file: string, filesChanged: string[]): boolean {
  return filesChanged.some((changed) => changed === file || changed.endsWith(`/${file}`) || file.endsWith(`/${changed}`));
}

/** Review-loop round counts and finding attribution for one task. */
export function computeReviewLoop(task: Pick<BaselineTask, 'sessions' | 'review'>): ReviewLoopMetrics {
  const iterations = task.review?.reviewIterations ?? null;
  const reviewHelperSessions = task.sessions.filter((s) => s.kind.startsWith('helper:') && isReviewKind(s.kind)).length;
  // Legacy review sessions carry no launch evidence, and one review stage can
  // span several sessions (Codex threads), so they are not countable launches.
  // Launches are countable only on launch-record tasks; before that a task's
  // review/coding sessions may sit under "unattributed", so zero means unknown.
  const launchRecorded = task.sessions.some((s) => s.launchEvidence !== null);
  const reviewLaunches = launchRecorded ? countLaunches(task.sessions, 'review') : null;

  let rounds: number | null = null;
  let roundsSource: ReviewLoopMetrics['roundsSource'] = 'none';
  if (iterations && iterations.length > 0) {
    rounds = iterations.length;
    roundsSource = 'review-iterations';
  } else if (reviewHelperSessions > 0) {
    rounds = reviewHelperSessions;
    roundsSource = 'review-helper-sessions';
  } else if (task.review?.iterations != null) {
    rounds = task.review.iterations;
    roundsSource = 'artifact-iterations';
  } else if (reviewLaunches !== null && reviewLaunches > 0) {
    rounds = reviewLaunches;
    roundsSource = 'review-launches';
  }

  const codingLaunches = launchRecorded ? countLaunches(task.sessions, 'coding') : null;
  const recodeRounds = codingLaunches === null ? null : Math.max(codingLaunches - 1, 0);

  let findings: ReviewLoopMetrics['findings'] = null;
  if (iterations && iterations.length > 0) {
    findings = { total: 0, onChangedFiles: 0, onUnchangedFiles: 0, unresolvable: 0 };
    for (const iteration of iterations) {
      for (const finding of iteration.findings) {
        findings.total++;
        const file = findingFile(finding.location);
        if (!file || !iteration.filesChanged) findings.unresolvable++;
        else if (fileInDelta(file, iteration.filesChanged)) findings.onChangedFiles++;
        else findings.onUnchangedFiles++;
      }
    }
  }

  return { rounds, roundsSource, reviewLaunches, recodeRounds, findings };
}
