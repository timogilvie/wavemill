import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './ledger.ts';
import { prCommentKey, setSideEffectLedgerForTesting } from './side-effect-ledger.ts';
import {
  MERGE_STATUS_COMMENT_MARKER,
  postMergeStatusComment,
  recordedConditionKey,
  renderMergeStatusComment,
  type MergeStatusShellRunner,
} from './merge-status-comment.ts';

let dir: string;
let ledger: Ledger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wavemill-merge-status-comment-'));
  ledger = Ledger.open({ dbPath: join(dir, 'ledger.sqlite') });
  setSideEffectLedgerForTesting(ledger);
});

afterEach(() => {
  setSideEffectLedgerForTesting(null);
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A fake gh with one PR's comment thread: create appends, PATCH edits by id. */
function fakeGh(initial: Array<{ id: number; body: string; createdAt: string }> = []) {
  const comments = initial.map((c) => ({ ...c, url: `https://github.com/o/r/pull/7#issuecomment-${c.id}` }));
  const calls: string[] = [];
  let nextId = 1000;
  const run: MergeStatusShellRunner = (cmd) => {
    calls.push(cmd);
    if (cmd.startsWith('gh pr view 7 --json comments')) {
      // gh returns GraphQL node ids; the REST id is only in the URL.
      return JSON.stringify({ comments: comments.map((c) => ({ id: `IC_node${c.id}`, url: c.url, body: c.body, createdAt: c.createdAt })) });
    }
    if (cmd.startsWith('gh pr comment 7 --body ')) {
      const id = nextId++;
      const body = unquote(cmd.slice('gh pr comment 7 --body '.length));
      comments.push({ id, body, createdAt: `2026-10-26T00:00:${String(id % 60).padStart(2, '0')}Z`, url: `https://github.com/o/r/pull/7#issuecomment-${id}` });
      return '';
    }
    const patch = cmd.match(/^gh api --method PATCH 'repos\/\{owner\}\/\{repo\}\/issues\/comments\/(\d+)' -f (.*)$/s);
    if (patch) {
      const target = comments.find((c) => String(c.id) === patch[1]);
      assert.ok(target, `PATCH of unknown comment ${patch[1]}`);
      target!.body = unquote(patch[2]).replace(/^body=/, '');
      return '';
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
  return { run, calls, comments };
}

function unquote(arg: string): string {
  // escapeShellArg wraps in single quotes and escapes embedded ones as '\''.
  return arg.replace(/^'/, '').replace(/'$/, '').replace(/'\\''/g, "'");
}

const base = { prNumber: 7, repoDir: '/repo', body: '### Wavemill Rebase failed\n\nCONFLICT (content)' };

test('the first condition creates one standing comment and records a pr-comment row', () => {
  const gh = fakeGh();
  const result = postMergeStatusComment({ ...base, phase: 'rebase', headSha: 'h1', baseSha: 'b1', shellRunner: gh.run });
  assert.equal(result.action, 'created');
  assert.equal(gh.comments.length, 1);
  assert.ok(gh.comments[0].body.startsWith(MERGE_STATUS_COMMENT_MARKER));
  assert.equal(recordedConditionKey(gh.comments[0].body), prCommentKey(7, 'rebase', 'h1', 'b1'));
  const row = ledger.findSideEffect('pr-comment', prCommentKey(7, 'rebase', 'h1', 'b1'));
  assert.ok(row);
  assert.equal(row!.attempt, 0);
});

test('the same condition seen N times is an observation: no write, no duplicate attempt', () => {
  const gh = fakeGh();
  for (let poll = 0; poll < 10; poll += 1) {
    postMergeStatusComment({ ...base, phase: 'rebase', headSha: 'h1', baseSha: 'b1', shellRunner: gh.run });
  }
  assert.equal(gh.comments.length, 1);
  assert.equal(gh.calls.filter((cmd) => cmd.startsWith('gh pr comment') || cmd.includes('PATCH')).length, 1);
  assert.equal(ledger.findSideEffect('pr-comment', prCommentKey(7, 'rebase', 'h1', 'b1'))!.attempt, 0);
});

test('a new condition edits the standing comment in place instead of appending', () => {
  const gh = fakeGh();
  postMergeStatusComment({ ...base, phase: 'rebase', headSha: 'h1', baseSha: 'b1', shellRunner: gh.run });
  const moved = postMergeStatusComment({ ...base, phase: 'rebase', headSha: 'h1', baseSha: 'b2', shellRunner: gh.run });
  assert.equal(moved.action, 'edited');
  assert.equal(moved.commentId, '1000');
  assert.equal(gh.comments.length, 1);
  assert.equal(recordedConditionKey(gh.comments[0].body), prCommentKey(7, 'rebase', 'h1', 'b2'));
  assert.ok(ledger.findSideEffect('pr-comment', prCommentKey(7, 'rebase', 'h1', 'b2')));
});

test('human comments are never edited; the oldest standing comment wins', () => {
  const gh = fakeGh([
    { id: 1, body: 'LGTM from a human', createdAt: '2026-10-25T00:00:00Z' },
    { id: 2, body: renderMergeStatusComment('7|rebase|old|old', 'old'), createdAt: '2026-10-25T00:01:00Z' },
    { id: 3, body: renderMergeStatusComment('7|rebase|older|older', 'dup'), createdAt: '2026-10-25T00:02:00Z' },
  ]);
  const result = postMergeStatusComment({ ...base, phase: 'checks', headSha: 'h9', baseSha: 'b9', shellRunner: gh.run });
  assert.equal(result.action, 'edited');
  assert.equal(result.commentId, '2');
  assert.equal(gh.comments[0].body, 'LGTM from a human');
  assert.equal(recordedConditionKey(gh.comments[1].body), prCommentKey(7, 'checks', 'h9', 'b9'));
});

test('a GitHub read failure throws without posting', () => {
  const calls: string[] = [];
  const run: MergeStatusShellRunner = (cmd) => {
    calls.push(cmd);
    throw new Error('HTTP 502');
  };
  assert.throws(() => postMergeStatusComment({ ...base, phase: 'rebase', headSha: 'h1', baseSha: 'b1', shellRunner: run }), /HTTP 502/);
  assert.equal(calls.length, 1);
  assert.equal(ledger.listSideEffectsByKind('pr-comment').length, 0);
});
