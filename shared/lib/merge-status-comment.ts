/**
 * The one standing "Wavemill merge status" PR comment (HOK-3316).
 *
 * Tend used to append a fresh "### Wavemill <Phase> failed" comment on every
 * failed merge attempt; with the reconciler re-labelling the PR every poll,
 * PR #1697 collected 158 identical comments. Every tend-authored PR comment
 * now goes through {@link postMergeStatusComment}:
 *
 * - One comment per PR, found by its hidden marker and edited in place on a
 *   later status, never appended.
 * - One write per condition `(pr, phase, head, base)` ({@link prCommentKey}):
 *   when the standing comment already records this condition the call is an
 *   observation — no GitHub write — and the side-effect ledger shadow row
 *   (HOK-3183) is recorded as an observation, never a duplicate attempt.
 *
 * This is the only module allowed to run `gh pr comment` (enforced by
 * `tools/check-merge-block-writers.ts`).
 *
 * @module merge-status-comment
 */

import { escapeShellArg } from './shell-utils.ts';
import { prCommentKey, shadowRecordSideEffect } from './side-effect-ledger.ts';

/** Hidden marker opening the standing comment's body. */
export const MERGE_STATUS_COMMENT_MARKER = '<!-- wavemill-merge-status -->';

const KEY_MARKER_PREFIX = '<!-- wavemill-merge-status-key: ';
const KEY_MARKER_SUFFIX = ' -->';
const GH_COMMENT_TIMEOUT_MS = 120_000;

export type MergeStatusShellRunner = (
  cmd: string,
  opts?: { encoding?: string; cwd?: string; timeout?: number },
) => string;

export interface MergeStatusCommentInput {
  prNumber: number;
  /** Condition phase, e.g. `rebase`, `checks`, `integration`, `lane-reclaim`. */
  phase: string;
  /** PR head the condition was observed at ('' when not applicable). */
  headSha: string;
  /** Integration base (or other second key part) of the condition. */
  baseSha: string;
  /** Markdown body for this status (rendered under the standing header). */
  body: string;
  repoDir: string;
  shellRunner: MergeStatusShellRunner;
}

export interface MergeStatusCommentResult {
  action: 'created' | 'edited' | 'observed';
  idempotencyKey: string;
  commentId?: string;
}

interface StandingComment {
  /** REST issue-comment id (numeric, as a string). */
  id: string;
  body: string;
}

/** Render the standing comment body for one condition. */
export function renderMergeStatusComment(idempotencyKey: string, body: string): string {
  return [
    MERGE_STATUS_COMMENT_MARKER,
    `${KEY_MARKER_PREFIX}${idempotencyKey}${KEY_MARKER_SUFFIX}`,
    '## Wavemill merge status',
    '',
    body.trim(),
    '',
    `<sub>Updated ${new Date().toISOString()} · this comment is edited in place on every merge-status change.</sub>`,
  ].join('\n');
}

/** The condition key recorded in a standing comment body, or null. */
export function recordedConditionKey(body: string): string | null {
  const start = body.indexOf(KEY_MARKER_PREFIX);
  if (start < 0) return null;
  const end = body.indexOf(KEY_MARKER_SUFFIX, start + KEY_MARKER_PREFIX.length);
  return end < 0 ? null : body.slice(start + KEY_MARKER_PREFIX.length, end);
}

/**
 * The oldest standing comment on the PR. A legacy duplicate (two markers) is
 * left alone: the oldest is the one edited from then on.
 */
function findStandingComment(input: MergeStatusCommentInput): StandingComment | null {
  const raw = input.shellRunner(
    `gh pr view ${input.prNumber} --json comments`,
    { encoding: 'utf-8', cwd: input.repoDir, timeout: GH_COMMENT_TIMEOUT_MS },
  );
  const text = String(raw ?? '').trim();
  // A successful gh call with no output lists no comments; a failed one throws.
  const parsed = (text ? JSON.parse(text) : {}) as {
    comments?: Array<{ id?: unknown; url?: unknown; body?: unknown; createdAt?: unknown }>;
  };
  const candidates = (parsed.comments ?? [])
    .filter((comment) => typeof comment.body === 'string' && comment.body.startsWith(MERGE_STATUS_COMMENT_MARKER))
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
  for (const comment of candidates) {
    const id = restCommentId(comment);
    if (id) {
      return { id, body: comment.body as string };
    }
  }
  return null;
}

/**
 * `gh pr view --json comments` returns GraphQL node ids; the REST edit needs
 * the numeric id, which the comment URL carries as `#issuecomment-<id>`. A
 * numeric `id` (some gh versions / test fakes) is used directly.
 */
function restCommentId(comment: { id?: unknown; url?: unknown }): string | null {
  if (typeof comment.id === 'number' || (typeof comment.id === 'string' && /^\d+$/.test(comment.id))) {
    return String(comment.id);
  }
  const match = typeof comment.url === 'string' ? comment.url.match(/issuecomment-(\d+)/) : null;
  return match ? match[1] : null;
}

/**
 * Post (or edit) the standing merge-status comment for one condition. Throws
 * when GitHub cannot be read or written; callers treat the comment as
 * best-effort and must never fall back to appending a raw comment.
 */
export function postMergeStatusComment(input: MergeStatusCommentInput): MergeStatusCommentResult {
  const idempotencyKey = prCommentKey(input.prNumber, input.phase, input.headSha, input.baseSha);
  const standing = findStandingComment(input);

  if (standing && recordedConditionKey(standing.body) === idempotencyKey) {
    shadowRecordSideEffect({
      kind: 'pr-comment',
      idempotencyKey,
      observation: true,
      result: { action: 'observed', commentId: standing.id },
      repoDir: input.repoDir,
    });
    return { action: 'observed', idempotencyKey, commentId: standing.id };
  }

  const rendered = renderMergeStatusComment(idempotencyKey, input.body);
  let result: MergeStatusCommentResult;
  if (standing) {
    input.shellRunner(
      `gh api --method PATCH ${escapeShellArg(`repos/{owner}/{repo}/issues/comments/${standing.id}`)} -f ${escapeShellArg(`body=${rendered}`)}`,
      { encoding: 'utf-8', cwd: input.repoDir, timeout: GH_COMMENT_TIMEOUT_MS },
    );
    result = { action: 'edited', idempotencyKey, commentId: standing.id };
  } else {
    input.shellRunner(
      `gh pr comment ${input.prNumber} --body ${escapeShellArg(rendered)}`,
      { encoding: 'utf-8', cwd: input.repoDir, timeout: GH_COMMENT_TIMEOUT_MS },
    );
    result = { action: 'created', idempotencyKey };
  }

  shadowRecordSideEffect({
    kind: 'pr-comment',
    idempotencyKey,
    result: { action: result.action, commentId: result.commentId },
    repoDir: input.repoDir,
  });
  return result;
}
