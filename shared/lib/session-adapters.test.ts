/**
 * Tests for session-adapters module.
 *
 * HOK-3407 reduced this module to the NativeSessionAdapter and the
 * matchesIssue filter — Claude Code and Codex transcripts are now read
 * through `@hokusai/costs` sources, via `sdk-task-cost/measure.ts`.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NativeSessionAdapter,
  getNativeProviderMetadata,
  matchesIssue,
} from './session-adapters.ts';

// ── Helpers ──────────────────────────────────────────────────────

function setupNativeSessionDir() {
  const tmpHome = mkdtempSync(join(tmpdir(), 'adapter-native-'));
  const worktreePath = join(tmpHome, 'fake-worktree');
  const nativeSessionsDir = join(
    worktreePath,
    '.wavemill',
    'runs',
    'HOK-2305',
    'native-sessions',
  );
  mkdirSync(nativeSessionsDir, { recursive: true });

  return {
    tmpHome,
    worktreePath,
    nativeSessionsDir,
    cleanup: () => {
      rmSync(tmpHome, { recursive: true, force: true });
    },
  };
}

function nativeSessionStarted(model = 'pi-model'): string {
  return JSON.stringify({
    seq: 1,
    sessionId: 'native-session',
    timestamp: 1,
    type: 'session_started',
    model,
    api: 'responses',
    provider: 'pi',
  });
}

function nativeAssistantMessage(opts: {
  model?: string;
  responseId?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
} = {}): string {
  return JSON.stringify({
    seq: 2,
    sessionId: 'native-session',
    timestamp: 2,
    type: 'assistant_message',
    model: opts.model,
    ...(opts.responseId ? { responseId: opts.responseId } : {}),
    stopReason: 'end_turn',
    usage: {
      input: opts.input ?? 0,
      output: opts.output ?? 0,
      cacheRead: opts.cacheRead ?? 0,
      cacheWrite: opts.cacheWrite ?? 0,
      totalTokens:
        (opts.input ?? 0) +
        (opts.output ?? 0) +
        (opts.cacheRead ?? 0) +
        (opts.cacheWrite ?? 0),
    },
    rawContent: [],
    replayContent: [],
    redacted: false,
  });
}

// ── Native Adapter Tests ────────────────────────────────────────

describe('NativeSessionAdapter', () => {
  it('returns null when no native runs directory exists', () => {
    // protects: scanning a worktree with no transcripts does not error
    const adapter = new NativeSessionAdapter();
    const result = adapter.scan({
      worktreePath: '/nonexistent/path',
      branchName: 'task/test',
    });
    assert.equal(result, null);
  });

  it('aggregates assistant message usage across native session files', () => {
    // protects: the native adapter still sums per-model usage across turns
    const { worktreePath, nativeSessionsDir, cleanup } = setupNativeSessionDir();
    try {
      const lines = [
        nativeSessionStarted('pi-model'),
        nativeAssistantMessage({ responseId: 'gen-one', input: 100, output: 25, cacheRead: 20, cacheWrite: 10 }),
        nativeAssistantMessage({ model: 'pi-model', responseId: 'gen-two', input: 200, output: 50, cacheRead: 40, cacheWrite: 30 }),
      ].join('\n');

      writeFileSync(join(nativeSessionsDir, 'session.jsonl'), lines);

      const adapter = new NativeSessionAdapter();
      const result = adapter.scan({ worktreePath, branchName: 'task/test' });

      assert.ok(result);
      assert.equal(result.sessionCount, 1);
      assert.equal(result.turnCount, 2);
      assert.deepEqual(result.models['pi-model'], {
        inputTokens: 300,
        cacheCreationTokens: 40,
        cacheReadTokens: 60,
        outputTokens: 75,
      });
      assert.deepEqual(result.nativeSessions?.[0].responseIds, ['gen-one', 'gen-two']);
      assert.equal(result.nativeSessions?.[0].turns[0].responseId, 'gen-one');
      assert.equal(result.nativeSessions?.[0].turns[0].inputTokens, 100);
    } finally {
      cleanup();
    }
  });

  it('uses session_started model when assistant_message omits model', () => {
    // protects: a missing per-turn model falls back to the session_started model
    const { worktreePath, nativeSessionsDir, cleanup } = setupNativeSessionDir();
    try {
      const lines = [
        nativeSessionStarted('fallback-model'),
        nativeAssistantMessage({ input: 100, output: 10 }),
      ].join('\n');

      writeFileSync(join(nativeSessionsDir, 'session.jsonl'), lines);

      const adapter = new NativeSessionAdapter();
      const result = adapter.scan({ worktreePath, branchName: 'task/test' });

      assert.ok(result);
      assert.deepEqual(result.models['fallback-model'], {
        inputTokens: 100,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 10,
      });
    } finally {
      cleanup();
    }
  });

  it('preserves assistant turns with missing usage as unavailable native records', () => {
    // protects: a turn without usage still appears as a native record, usage unavailable
    const { worktreePath, nativeSessionsDir, cleanup } = setupNativeSessionDir();
    try {
      const missingUsage = JSON.stringify({
        seq: 2,
        sessionId: 'native-session',
        timestamp: 2,
        type: 'assistant_message',
        model: 'pi-model',
        stopReason: 'end_turn',
        rawContent: [],
        replayContent: [],
        redacted: false,
      });
      const lines = [
        nativeSessionStarted('pi-model'),
        missingUsage,
      ].join('\n');

      writeFileSync(join(nativeSessionsDir, 'session.jsonl'), lines);

      const adapter = new NativeSessionAdapter();
      const result = adapter.scan({ worktreePath, branchName: 'task/test' });

      assert.ok(result);
      assert.equal(result.sessionCount, 1);
      assert.equal(result.turnCount, 1);
      assert.deepEqual(result.models, {});
      assert.equal(result.nativeSessions?.[0]?.usageAvailable, false);
      assert.equal(result.nativeSessions?.[0]?.modelId, 'pi-model');
    } finally {
      cleanup();
    }
  });

  it('deduplicates native sessions by session id across run paths', () => {
    // protects: a session copied into a second run dir is not double-counted
    const { worktreePath, nativeSessionsDir, cleanup } = setupNativeSessionDir();
    try {
      const secondRunDir = join(worktreePath, '.wavemill', 'runs', 'HOK-2306', 'native-sessions');
      mkdirSync(secondRunDir, { recursive: true });
      const lines = [
        nativeSessionStarted('pi-model'),
        nativeAssistantMessage({ input: 100, output: 25 }),
      ].join('\n');

      writeFileSync(join(nativeSessionsDir, 'session.jsonl'), lines);
      writeFileSync(join(secondRunDir, 'session-copy.jsonl'), lines);

      const adapter = new NativeSessionAdapter();
      const result = adapter.scan({ worktreePath, branchName: 'task/test' });

      assert.ok(result);
      assert.equal(result.sessionCount, 1);
      assert.equal(result.turnCount, 1);
      assert.deepEqual(result.models['pi-model'], {
        inputTokens: 100,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 25,
      });
    } finally {
      cleanup();
    }
  });
});

// ── Native Provider Metadata Tests ─────────────────────────────

describe('getNativeProviderMetadata', () => {
  it('returns null when no native sessions exist', () => {
    // protects: no transcripts → null (not a throw, not a stub)
    const result = getNativeProviderMetadata('/nonexistent/path');
    assert.equal(result, null);
  });

  it('extracts provider and api from session_started event', () => {
    // protects: the eval record still gets its provider metadata
    const { worktreePath, nativeSessionsDir, cleanup } = setupNativeSessionDir();
    try {
      const lines = [
        nativeSessionStarted('pi-model'),
        nativeAssistantMessage({ input: 100, output: 50 }),
      ].join('\n');

      writeFileSync(join(nativeSessionsDir, 'session.jsonl'), lines);

      const result = getNativeProviderMetadata(worktreePath);
      assert.ok(result);
      assert.equal(result.provider, 'pi');
      assert.equal(result.endpoint, 'responses');
    } finally {
      cleanup();
    }
  });

  it('returns provider without endpoint when api is missing', () => {
    // protects: a session_started with no api still produces a provider result
    const { worktreePath, nativeSessionsDir, cleanup } = setupNativeSessionDir();
    try {
      const sessionStartedNoApi = JSON.stringify({
        seq: 1,
        sessionId: 'native-session',
        timestamp: 1,
        type: 'session_started',
        model: 'pi-model',
        provider: 'custom-provider',
      });
      const lines = [
        sessionStartedNoApi,
        nativeAssistantMessage({ input: 100, output: 50 }),
      ].join('\n');

      writeFileSync(join(nativeSessionsDir, 'session.jsonl'), lines);

      const result = getNativeProviderMetadata(worktreePath);
      assert.ok(result);
      assert.equal(result.provider, 'custom-provider');
      assert.equal(result.endpoint, undefined);
    } finally {
      cleanup();
    }
  });
});

describe('matchesIssue', () => {
  // protects: naive issue-only filters silently dropped review/expansion files
  it('matches the transcript belonging to the issue', () => {
    assert.equal(matchesIssue('coding-HOK-2728_c.jsonl', 'HOK-2728_c'), true);
    assert.equal(matchesIssue('planning-HOK-2728_c.jsonl', 'HOK-2728_c'), true);
  });

  it('does not match a different issue', () => {
    assert.equal(matchesIssue('coding-HOK-537_c.jsonl', 'HOK-2728_c'), false);
    assert.equal(matchesIssue('coding-AB2-1_c.jsonl', 'HOK-2728_c'), false);
    assert.equal(matchesIssue('coding-AB2-1_c.jsonl', 'AB2-1_c'), true);
  });

  it('does not let a primary issue match its challenger', () => {
    assert.equal(matchesIssue('coding-HOK-2728_c.jsonl', 'HOK-2728'), false);
    assert.equal(matchesIssue('coding-HOK-2728.jsonl', 'HOK-2728'), true);
  });

  it('applies the same sanitisation makeTranscriptPath uses', () => {
    assert.equal(matchesIssue('coding-HOK-123-x.jsonl', 'HOK-123/x'), true);
  });

  it('matches everything when no issue is supplied', () => {
    assert.equal(matchesIssue('coding-HOK-2728_c.jsonl'), true);
  });

  it('keeps this task\'s review transcript, which is named by branch', () => {
    assert.equal(
      matchesIssue('gtm-backend-review-task-my-slug.jsonl', 'HOK-2728_c', 'task/my-slug'),
      true,
    );
  });

  it('drops another task\'s review transcript', () => {
    assert.equal(
      matchesIssue('gtm-backend-review-task-other-slug.jsonl', 'HOK-2728_c', 'task/my-slug'),
      false,
    );
  });

  it('keeps transcripts with no task or branch identity', () => {
    assert.equal(matchesIssue('expansion-wavemill.jsonl', 'HOK-2728_c', 'task/my-slug'), true);
  });

  it('attributes expansion transcripts by the issue embedded mid-name', () => {
    // protects: HOK-3256 regression — end-anchored filter dropped every expansion transcript
    const file = 'expansion-expansion-HOK-1309-1788901038378.jsonl';
    assert.equal(matchesIssue(file, 'HOK-3220', 'task/a1-one-schema'), false);
    assert.equal(matchesIssue(file, 'HOK-1309', 'task/some-slug'), true);
  });

  it('attributes a transcript by its run-dir name', () => {
    assert.equal(matchesIssue('session.jsonl', 'HOK-3220', undefined, 'expansion-HOK-1309-1788901038378'), false);
    assert.equal(matchesIssue('session.jsonl', 'HOK-1309', undefined, 'expansion-HOK-1309-1788901038378'), true);
    assert.equal(matchesIssue('session.jsonl', 'HOK-1309', undefined, 'wavemill'), true);
  });

  it('does not match an issue that is only a prefix of the embedded one', () => {
    assert.equal(matchesIssue('expansion-expansion-HOK-32-1788901038378.jsonl', 'HOK-3220'), false);
    assert.equal(matchesIssue('expansion-expansion-HOK-3220-1788901038378.jsonl', 'HOK-32'), false);
  });

  it('keeps primary and challenger embedded IDs apart', () => {
    assert.equal(matchesIssue('expansion-expansion-HOK-2728_c-1.jsonl', 'HOK-2728'), false);
    assert.equal(matchesIssue('expansion-expansion-HOK-2728-1.jsonl', 'HOK-2728_c'), false);
  });

  it('drops a review transcript for a branch without a task-style prefix', () => {
    assert.equal(
      matchesIssue('manual-review-review-fix-glm-5-2-live-pricing.jsonl', 'HOK-3220', 'task/a1-one-schema'),
      false,
    );
    assert.equal(
      matchesIssue('manual-review-review-fix-glm-5-2-live-pricing.jsonl', 'HOK-3220', 'fix/glm-5-2-live-pricing'),
      true,
    );
  });

  it('does not let a primary branch claim its challenger branch review', () => {
    assert.equal(
      matchesIssue('wavemill-review-task-my-slug-challenger.jsonl', 'HOK-2728', 'task/my-slug'),
      false,
    );
  });
});

describe('NativeSessionAdapter cross-task isolation', () => {
  // protects: HOK-3256 — sibling worktrees share the repo's run directory, so a
  // reaped worktree's scan must stay scoped to its own sessions.
  function writeSession(runsDir: string, runDir: string, fileName: string, input: number) {
    const dir = join(runsDir, runDir, 'native-sessions');
    mkdirSync(dir, { recursive: true });
    // Distinct session IDs: the adapter de-duplicates by sessionId.
    const withSessionId = (line: string) => JSON.stringify({ ...JSON.parse(line), sessionId: fileName });
    writeFileSync(
      join(dir, fileName),
      [nativeSessionStarted('pi-model'), nativeAssistantMessage({ input, output: 1 })]
        .map(withSessionId)
        .join('\n'),
    );
  }

  let tmpRoot: string;
  let repoDir: string;
  let worktreesDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'adapter-native-cross-'));
    repoDir = join(tmpRoot, 'repo');
    worktreesDir = join(repoDir, 'worktrees');
    const runsDir = join(repoDir, '.wavemill', 'runs');
    writeSession(runsDir, 'expansion-HOK-100-123', 'expansion-expansion-HOK-100-123.jsonl', 1);
    writeSession(runsDir, 'expansion-HOK-200-456', 'expansion-expansion-HOK-200-456.jsonl', 10);
    writeSession(runsDir, 'wavemill', 'coding-HOK-100.jsonl', 100);
    writeSession(runsDir, 'wavemill', 'coding-HOK-200_c.jsonl', 1000);
    writeSession(runsDir, 'wavemill', 'wavemill-review-task-alpha.jsonl', 10000);
    writeSession(runsDir, 'wavemill', 'wavemill-review-task-beta-challenger.jsonl', 100000);
    writeSession(runsDir, 'manual-review', 'manual-review-review-fix-unrelated.jsonl', 1000000);
    mkdirSync(join(worktreesDir, 'alpha'), { recursive: true });
    mkdirSync(join(worktreesDir, 'beta-challenger'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function inputTokens(opts: { worktree: string; issueId: string; branchName: string }) {
    const result = new NativeSessionAdapter().scan({
      worktreePath: join(worktreesDir, opts.worktree),
      repoDir,
      issueId: opts.issueId,
      branchName: opts.branchName,
    });
    assert.ok(result);
    return { sessions: result.sessionCount, input: result.models['pi-model'].inputTokens };
  }

  it('charges each sibling worktree only its own sessions', () => {
    assert.deepEqual(
      inputTokens({ worktree: 'alpha', issueId: 'HOK-100', branchName: 'task/alpha' }),
      { sessions: 3, input: 1 + 100 + 10000 },
    );
    assert.deepEqual(
      inputTokens({ worktree: 'beta-challenger', issueId: 'HOK-200_c', branchName: 'task/beta-challenger' }),
      { sessions: 2, input: 1000 + 100000 },
    );
  });

  it('keeps a reaped worktree scoped to its own sessions', () => {
    assert.deepEqual(
      inputTokens({ worktree: 'reaped-gamma', issueId: 'HOK-200', branchName: 'task/beta' }),
      { sessions: 1, input: 10 },
    );
  });
});
