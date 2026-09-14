/**
 * Tests for session-adapters module.
 *
 * Validates Claude and Codex session discovery, token parsing,
 * field mapping, and the adapter factory.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeSessionAdapter,
  CodexSessionAdapter,
  NativeSessionAdapter,
  getSessionAdapter,
  detectAgentType,
  getNativeProviderMetadata,
  matchesIssue,
} from './session-adapters.ts';
import { encodeProjectDir } from './workflow-cost.ts';

// ── Helpers ──────────────────────────────────────────────────────

/** Set up a fake ~/.claude/projects/<encoded>/ directory for Claude adapter tests. */
function setupClaudeSessionDir() {
  const tmpHome = mkdtempSync(join(tmpdir(), 'adapter-claude-'));
  const worktreePath = join(tmpHome, 'fake-worktree');
  const encoded = encodeProjectDir(worktreePath);
  const projectsDir = join(tmpHome, '.claude', 'projects', encoded);
  mkdirSync(projectsDir, { recursive: true });

  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;

  return {
    tmpHome,
    worktreePath,
    projectsDir,
    cleanup: () => {
      process.env.HOME = origHome;
      rmSync(tmpHome, { recursive: true, force: true });
    },
  };
}

function setupDeepSeekClaudeSessionDir() {
  const tmpHome = mkdtempSync(join(tmpdir(), 'adapter-deepseek-'));
  const worktreePath = join(tmpHome, 'fake-worktree');
  const encoded = encodeProjectDir(worktreePath);
  const projectsDir = join(
    worktreePath,
    '.wavemill',
    'runs',
    'HOK-1485',
    'providers',
    'deepseek',
    'home',
    '.claude',
    'projects',
    encoded,
  );
  mkdirSync(projectsDir, { recursive: true });

  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;

  return {
    tmpHome,
    worktreePath,
    projectsDir,
    cleanup: () => {
      process.env.HOME = origHome;
      rmSync(tmpHome, { recursive: true, force: true });
    },
  };
}

function setupHybridClaudeSessionDir() {
  const tmpHome = mkdtempSync(join(tmpdir(), 'adapter-hybrid-'));
  const worktreePath = join(tmpHome, 'fake-worktree');
  const encoded = encodeProjectDir(worktreePath);
  const standardProjectsDir = join(tmpHome, '.claude', 'projects', encoded);
  const deepseekProjectsDir1 = join(
    worktreePath,
    '.wavemill',
    'runs',
    'HOK-1485',
    'providers',
    'deepseek',
    'home',
    '.claude',
    'projects',
    encoded,
  );
  const deepseekProjectsDir2 = join(
    worktreePath,
    '.wavemill',
    'runs',
    'HOK-1486',
    'providers',
    'deepseek',
    'home',
    '.claude',
    'projects',
    encoded,
  );
  mkdirSync(standardProjectsDir, { recursive: true });
  mkdirSync(deepseekProjectsDir1, { recursive: true });
  mkdirSync(deepseekProjectsDir2, { recursive: true });

  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;

  return {
    tmpHome,
    worktreePath,
    standardProjectsDir,
    deepseekProjectsDir1,
    deepseekProjectsDir2,
    cleanup: () => {
      process.env.HOME = origHome;
      rmSync(tmpHome, { recursive: true, force: true });
    },
  };
}

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

/** Set up a fake ~/.codex/sessions/ directory for Codex adapter tests. */
function setupCodexSessionDir() {
  const tmpHome = mkdtempSync(join(tmpdir(), 'adapter-codex-'));
  const sessionsDir = join(tmpHome, '.codex', 'sessions', '2026', '02', '20');
  mkdirSync(sessionsDir, { recursive: true });

  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;

  return {
    tmpHome,
    sessionsDir,
    cleanup: () => {
      process.env.HOME = origHome;
      rmSync(tmpHome, { recursive: true, force: true });
    },
  };
}

/** Build a Claude assistant turn JSONL line. */
function claudeAssistantTurn(opts: {
  branch: string;
  model?: string;
  inputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
}): string {
  return JSON.stringify({
    type: 'assistant',
    gitBranch: opts.branch,
    message: {
      model: opts.model || 'claude-opus-4-6',
      role: 'assistant',
      content: [{ type: 'text', text: 'test' }],
      usage: {
        input_tokens: opts.inputTokens ?? 100,
        cache_creation_input_tokens: opts.cacheCreationTokens ?? 50,
        cache_read_input_tokens: opts.cacheReadTokens ?? 200,
        output_tokens: opts.outputTokens ?? 30,
      },
    },
  });
}

/** Build a Codex session_meta JSONL line. */
function codexSessionMeta(opts: { cwd: string; branch: string }): string {
  return JSON.stringify({
    timestamp: '2026-02-20T15:17:29.630Z',
    type: 'session_meta',
    payload: {
      id: '019c7ba0-test',
      timestamp: '2026-02-20T15:17:29.541Z',
      cwd: opts.cwd,
      originator: 'codex_exec',
      cli_version: '0.99.0',
      source: 'exec',
      model_provider: 'openai',
      git: {
        commit_hash: 'abc123',
        branch: opts.branch,
        repository_url: 'git@github.com:test/repo.git',
      },
    },
  });
}

/** Build a Codex turn_context JSONL line. */
function codexTurnContext(model: string): string {
  return JSON.stringify({
    timestamp: '2026-02-20T15:17:29.637Z',
    type: 'turn_context',
    payload: {
      cwd: '/test',
      model,
      effort: 'medium',
    },
  });
}

/** Build a Codex token_count event_msg JSONL line. */
function codexTokenCount(opts: {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}): string {
  return JSON.stringify({
    timestamp: '2026-02-20T15:17:37.151Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: opts.inputTokens,
          cached_input_tokens: opts.cachedInputTokens,
          output_tokens: opts.outputTokens,
          reasoning_output_tokens: opts.reasoningOutputTokens,
          total_tokens: opts.inputTokens + opts.outputTokens,
        },
      },
      rate_limits: {},
    },
  });
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

// ── Claude Adapter Tests ────────────────────────────────────────

describe('ClaudeSessionAdapter', () => {
  it('returns null when projects directory does not exist', () => {
    const adapter = new ClaudeSessionAdapter();
    const result = adapter.scan({
      worktreePath: '/nonexistent/path',
      branchName: 'task/test',
    });
    assert.equal(result, null);
  });

  it('returns null when no JSONL files exist', () => {
    const { worktreePath, cleanup } = setupClaudeSessionDir();
    try {
      const adapter = new ClaudeSessionAdapter();
      const result = adapter.scan({ worktreePath, branchName: 'task/test' });
      assert.equal(result, null);
    } finally {
      cleanup();
    }
  });

  it('aggregates tokens from matching branch only', () => {
    const { worktreePath, projectsDir, cleanup } = setupClaudeSessionDir();
    try {
      const branch = 'task/my-feature';
      const lines = [
        claudeAssistantTurn({ branch, inputTokens: 100, cacheCreationTokens: 50, cacheReadTokens: 200, outputTokens: 30 }),
        claudeAssistantTurn({ branch: 'task/other', inputTokens: 999, outputTokens: 999 }),
        claudeAssistantTurn({ branch, inputTokens: 200, cacheCreationTokens: 100, cacheReadTokens: 300, outputTokens: 70 }),
      ].join('\n');

      writeFileSync(join(projectsDir, 'session1.jsonl'), lines);

      const adapter = new ClaudeSessionAdapter();
      const result = adapter.scan({ worktreePath, branchName: branch });

      assert.ok(result);
      assert.equal(result.turnCount, 2);
      assert.equal(result.sessionCount, 1);

      const model = result.models['claude-opus-4-6'];
      assert.ok(model);
      assert.equal(model.inputTokens, 300);
      assert.equal(model.cacheCreationTokens, 150);
      assert.equal(model.cacheReadTokens, 500);
      assert.equal(model.outputTokens, 100);
    } finally {
      cleanup();
    }
  });

  it('aggregates tokens per model separately', () => {
    const { worktreePath, projectsDir, cleanup } = setupClaudeSessionDir();
    try {
      const branch = 'task/test';
      const lines = [
        claudeAssistantTurn({ branch, model: 'claude-opus-4-6', inputTokens: 100, outputTokens: 50 }),
        claudeAssistantTurn({ branch, model: 'claude-haiku-4-5-20251001', inputTokens: 200, outputTokens: 100 }),
        claudeAssistantTurn({ branch, model: 'claude-opus-4-6', inputTokens: 300, outputTokens: 150 }),
      ].join('\n');

      writeFileSync(join(projectsDir, 'session1.jsonl'), lines);

      const adapter = new ClaudeSessionAdapter();
      const result = adapter.scan({ worktreePath, branchName: branch });

      assert.ok(result);
      assert.equal(Object.keys(result.models).length, 2);
      assert.equal(result.models['claude-opus-4-6'].inputTokens, 400);
      assert.equal(result.models['claude-haiku-4-5-20251001'].inputTokens, 200);
    } finally {
      cleanup();
    }
  });

  it('discovers transcripts under DeepSeek provider homes', () => {
    const { worktreePath, projectsDir, cleanup } = setupDeepSeekClaudeSessionDir();
    try {
      const branch = 'task/test';
      writeFileSync(join(projectsDir, 'session1.jsonl'), claudeAssistantTurn({ branch, model: 'deepseek-v4-pro', inputTokens: 120, outputTokens: 45 }));

      const adapter = new ClaudeSessionAdapter();
      const result = adapter.scan({ worktreePath, branchName: branch });

      assert.ok(result);
      assert.equal(result.models['deepseek-v4-pro'].inputTokens, 120);
      assert.equal(result.sessionCount, 1);
    } finally {
      cleanup();
    }
  });

  it('aggregates standard Claude and multiple DeepSeek provider roots together', () => {
    const {
      worktreePath,
      standardProjectsDir,
      deepseekProjectsDir1,
      deepseekProjectsDir2,
      cleanup,
    } = setupHybridClaudeSessionDir();
    try {
      const branch = 'task/test';
      writeFileSync(join(standardProjectsDir, 'session1.jsonl'), claudeAssistantTurn({ branch, model: 'claude-opus-4-6', inputTokens: 100, outputTokens: 20 }));
      writeFileSync(join(deepseekProjectsDir1, 'session1.jsonl'), claudeAssistantTurn({ branch, model: 'deepseek-v4-pro', inputTokens: 200, outputTokens: 30 }));
      writeFileSync(join(deepseekProjectsDir2, 'session1.jsonl'), [
        claudeAssistantTurn({ branch: 'task/other', model: 'deepseek-v4-pro', inputTokens: 999, outputTokens: 999 }),
        claudeAssistantTurn({ branch, model: 'deepseek-v4-flash', inputTokens: 300, outputTokens: 40 }),
      ].join('\n'));

      const adapter = new ClaudeSessionAdapter();
      const result = adapter.scan({ worktreePath, branchName: branch });

      assert.ok(result);
      assert.equal(result.sessionCount, 3);
      assert.equal(result.turnCount, 3);
      assert.equal(result.models['claude-opus-4-6'].inputTokens, 100);
      assert.equal(result.models['deepseek-v4-pro'].inputTokens, 200);
      assert.equal(result.models['deepseek-v4-flash'].inputTokens, 300);
    } finally {
      cleanup();
    }
  });
});

// ── Codex Adapter Tests ─────────────────────────────────────────

describe('CodexSessionAdapter', () => {
  it('returns null when sessions directory does not exist', () => {
    const adapter = new CodexSessionAdapter();
    // Temporarily set HOME to something without .codex
    const origHome = process.env.HOME;
    process.env.HOME = '/nonexistent/home';
    try {
      const result = adapter.scan({
        worktreePath: '/some/worktree',
        branchName: 'task/test',
      });
      assert.equal(result, null);
    } finally {
      process.env.HOME = origHome;
    }
  });

  it('discovers sessions by matching cwd', () => {
    const { sessionsDir, cleanup } = setupCodexSessionDir();
    try {
      const worktreePath = '/test/my-worktree';
      const branch = 'task/my-feature';

      const lines = [
        codexSessionMeta({ cwd: worktreePath, branch }),
        codexTurnContext('gpt-5.3-codex'),
        codexTokenCount({ inputTokens: 1000, cachedInputTokens: 800, outputTokens: 200, reasoningOutputTokens: 50 }),
      ].join('\n');

      writeFileSync(join(sessionsDir, 'rollout-test.jsonl'), lines);

      const adapter = new CodexSessionAdapter();
      const result = adapter.scan({ worktreePath, branchName: branch });

      assert.ok(result);
      assert.equal(result.sessionCount, 1);
    } finally {
      cleanup();
    }
  });

  it('discovers matching sessions without depending on transcript body size', () => {
    const { sessionsDir, cleanup } = setupCodexSessionDir();
    try {
      const worktreePath = '/test/large-worktree';
      const branch = 'task/large-session';
      const largeBodyEvent = JSON.stringify({
        timestamp: '2026-02-20T15:17:31.000Z',
        type: 'event_msg',
        payload: {
          type: 'agent_reasoning',
          text: 'x'.repeat(1024 * 1024),
        },
      });

      const lines = [
        codexSessionMeta({ cwd: worktreePath, branch }),
        largeBodyEvent,
        codexTurnContext('gpt-5.3-codex'),
        codexTokenCount({ inputTokens: 1234, cachedInputTokens: 567, outputTokens: 89, reasoningOutputTokens: 10 }),
      ].join('\n');

      writeFileSync(join(sessionsDir, 'rollout-large.jsonl'), lines);

      const adapter = new CodexSessionAdapter();
      const result = adapter.scan({ worktreePath, branchName: branch });

      assert.ok(result);
      assert.equal(result.sessionCount, 1);
      assert.equal(result.turnCount, 1);
      assert.deepEqual(result.models['gpt-5.3-codex'], {
        inputTokens: 1234,
        cacheCreationTokens: 0,
        cacheReadTokens: 567,
        outputTokens: 99,
      });
    } finally {
      cleanup();
    }
  });

  it('skips Codex files with oversized first records', () => {
    const { sessionsDir, cleanup } = setupCodexSessionDir();
    try {
      const worktreePath = '/test/oversized-meta';
      const branch = 'task/oversized-meta';
      const oversizedMeta = JSON.stringify({
        timestamp: '2026-02-20T15:17:29.630Z',
        type: 'session_meta',
        payload: {
          id: '019c7ba0-test',
          timestamp: '2026-02-20T15:17:29.541Z',
          cwd: worktreePath,
          originator: 'codex_exec',
          cli_version: '0.99.0',
          source: 'exec',
          notes: 'x'.repeat(80 * 1024),
          model_provider: 'openai',
          git: {
            commit_hash: 'abc123',
            branch,
            repository_url: 'git@github.com:test/repo.git',
          },
        },
      });

      const lines = [
        oversizedMeta,
        codexTurnContext('gpt-5.3-codex'),
        codexTokenCount({ inputTokens: 100, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 5 }),
      ].join('\n');

      writeFileSync(join(sessionsDir, 'rollout-oversized-meta.jsonl'), lines);

      const adapter = new CodexSessionAdapter();
      const result = adapter.scan({ worktreePath, branchName: branch });

      assert.equal(result, null);
    } finally {
      cleanup();
    }
  });

  it('refreshes cached Codex metadata when a session file changes', () => {
    const { sessionsDir, cleanup } = setupCodexSessionDir();
    try {
      const worktreePath = '/test/cache-refresh';
      const branch = 'task/cache-refresh';
      const filePath = join(sessionsDir, 'rollout-cache-refresh.jsonl');
      const adapter = new CodexSessionAdapter();

      writeFileSync(filePath, [
        codexSessionMeta({ cwd: '/other/cwd', branch: 'task/other' }),
        codexTurnContext('gpt-5.3-codex'),
        codexTokenCount({ inputTokens: 10, cachedInputTokens: 5, outputTokens: 2, reasoningOutputTokens: 1 }),
      ].join('\n'));

      assert.equal(adapter.scan({ worktreePath, branchName: branch }), null);

      writeFileSync(filePath, [
        codexSessionMeta({ cwd: worktreePath, branch }),
        codexTurnContext('gpt-5.3-codex'),
        codexTokenCount({ inputTokens: 100, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 5 }),
      ].join('\n'));

      const result = adapter.scan({ worktreePath, branchName: branch });
      assert.ok(result);
      assert.equal(result.sessionCount, 1);
      assert.equal(result.models['gpt-5.3-codex'].inputTokens, 100);
    } finally {
      cleanup();
    }
  });

  it('discovers sessions by matching branch when cwd differs', () => {
    const { sessionsDir, cleanup } = setupCodexSessionDir();
    try {
      const branch = 'task/my-feature';

      const lines = [
        codexSessionMeta({ cwd: '/different/cwd', branch }),
        codexTurnContext('gpt-5.3-codex'),
        codexTokenCount({ inputTokens: 500, cachedInputTokens: 400, outputTokens: 100, reasoningOutputTokens: 20 }),
      ].join('\n');

      writeFileSync(join(sessionsDir, 'rollout-test.jsonl'), lines);

      const adapter = new CodexSessionAdapter();
      const result = adapter.scan({ worktreePath: '/some/other/path', branchName: branch });

      assert.ok(result);
      assert.equal(result.sessionCount, 1);
    } finally {
      cleanup();
    }
  });

  it('does not match sessions with wrong cwd and wrong branch', () => {
    const { sessionsDir, cleanup } = setupCodexSessionDir();
    try {
      const lines = [
        codexSessionMeta({ cwd: '/other/cwd', branch: 'task/other-branch' }),
        codexTurnContext('gpt-5.3-codex'),
        codexTokenCount({ inputTokens: 500, cachedInputTokens: 400, outputTokens: 100, reasoningOutputTokens: 20 }),
      ].join('\n');

      writeFileSync(join(sessionsDir, 'rollout-test.jsonl'), lines);

      const adapter = new CodexSessionAdapter();
      const result = adapter.scan({ worktreePath: '/my/worktree', branchName: 'task/my-feature' });

      assert.equal(result, null);
    } finally {
      cleanup();
    }
  });

  it('uses last token_count entry, not intermediate ones', () => {
    const { sessionsDir, cleanup } = setupCodexSessionDir();
    try {
      const worktreePath = '/test/worktree';
      const branch = 'task/test';

      const lines = [
        codexSessionMeta({ cwd: worktreePath, branch }),
        codexTurnContext('gpt-5.3-codex'),
        // Intermediate count (should be ignored)
        codexTokenCount({ inputTokens: 100, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 5 }),
        // Another intermediate
        codexTokenCount({ inputTokens: 500, cachedInputTokens: 300, outputTokens: 80, reasoningOutputTokens: 20 }),
        // Final cumulative total (should be used)
        codexTokenCount({ inputTokens: 2000, cachedInputTokens: 1500, outputTokens: 300, reasoningOutputTokens: 100 }),
      ].join('\n');

      writeFileSync(join(sessionsDir, 'rollout-test.jsonl'), lines);

      const adapter = new CodexSessionAdapter();
      const result = adapter.scan({ worktreePath, branchName: branch });

      assert.ok(result);
      const model = result.models['gpt-5.3-codex'];
      assert.ok(model);
      assert.equal(model.inputTokens, 2000);
      assert.equal(model.cacheReadTokens, 1500);
      assert.equal(model.outputTokens, 400); // 300 + 100 reasoning
    } finally {
      cleanup();
    }
  });

  it('maps Codex fields correctly', () => {
    const { sessionsDir, cleanup } = setupCodexSessionDir();
    try {
      const worktreePath = '/test/worktree';
      const branch = 'task/test';

      const lines = [
        codexSessionMeta({ cwd: worktreePath, branch }),
        codexTurnContext('gpt-5.3-codex'),
        codexTokenCount({ inputTokens: 1000, cachedInputTokens: 800, outputTokens: 200, reasoningOutputTokens: 50 }),
      ].join('\n');

      writeFileSync(join(sessionsDir, 'rollout-test.jsonl'), lines);

      const adapter = new CodexSessionAdapter();
      const result = adapter.scan({ worktreePath, branchName: branch });

      assert.ok(result);
      const model = result.models['gpt-5.3-codex'];
      assert.ok(model);
      // cached_input_tokens → cacheReadTokens
      assert.equal(model.cacheReadTokens, 800);
      // cacheCreationTokens always 0 for Codex
      assert.equal(model.cacheCreationTokens, 0);
      // output_tokens + reasoning_output_tokens → outputTokens
      assert.equal(model.outputTokens, 250);
      assert.equal(model.inputTokens, 1000);
    } finally {
      cleanup();
    }
  });

  it('extracts model from turn_context', () => {
    const { sessionsDir, cleanup } = setupCodexSessionDir();
    try {
      const worktreePath = '/test/worktree';
      const branch = 'task/test';

      const lines = [
        codexSessionMeta({ cwd: worktreePath, branch }),
        codexTurnContext('gpt-5.3-codex'),
        codexTokenCount({ inputTokens: 100, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 5 }),
      ].join('\n');

      writeFileSync(join(sessionsDir, 'rollout-test.jsonl'), lines);

      const adapter = new CodexSessionAdapter();
      const result = adapter.scan({ worktreePath, branchName: branch });

      assert.ok(result);
      assert.ok(result.models['gpt-5.3-codex']);
      assert.equal(Object.keys(result.models).length, 1);
    } finally {
      cleanup();
    }
  });

  it('returns null when session has no token_count entries', () => {
    const { sessionsDir, cleanup } = setupCodexSessionDir();
    try {
      const worktreePath = '/test/worktree';
      const branch = 'task/test';

      const lines = [
        codexSessionMeta({ cwd: worktreePath, branch }),
        codexTurnContext('gpt-5.3-codex'),
        // No token_count entries
      ].join('\n');

      writeFileSync(join(sessionsDir, 'rollout-test.jsonl'), lines);

      const adapter = new CodexSessionAdapter();
      const result = adapter.scan({ worktreePath, branchName: branch });

      assert.equal(result, null);
    } finally {
      cleanup();
    }
  });

  it('aggregates across multiple matching session files', () => {
    const { sessionsDir, cleanup } = setupCodexSessionDir();
    try {
      const worktreePath = '/test/worktree';
      const branch = 'task/test';

      // Session 1
      const session1 = [
        codexSessionMeta({ cwd: worktreePath, branch }),
        codexTurnContext('gpt-5.3-codex'),
        codexTokenCount({ inputTokens: 1000, cachedInputTokens: 500, outputTokens: 100, reasoningOutputTokens: 20 }),
      ].join('\n');

      // Session 2
      const session2 = [
        codexSessionMeta({ cwd: worktreePath, branch }),
        codexTurnContext('gpt-5.3-codex'),
        codexTokenCount({ inputTokens: 2000, cachedInputTokens: 1500, outputTokens: 200, reasoningOutputTokens: 50 }),
      ].join('\n');

      writeFileSync(join(sessionsDir, 'rollout-session1.jsonl'), session1);
      writeFileSync(join(sessionsDir, 'rollout-session2.jsonl'), session2);

      const adapter = new CodexSessionAdapter();
      const result = adapter.scan({ worktreePath, branchName: branch });

      assert.ok(result);
      assert.equal(result.sessionCount, 2);

      const model = result.models['gpt-5.3-codex'];
      assert.ok(model);
      assert.equal(model.inputTokens, 3000);
      assert.equal(model.cacheReadTokens, 2000);
      assert.equal(model.outputTokens, 370); // (100+20) + (200+50)
    } finally {
      cleanup();
    }
  });
});

describe('NativeSessionAdapter', () => {
  it('returns null when no native runs directory exists', () => {
    const adapter = new NativeSessionAdapter();
    const result = adapter.scan({
      worktreePath: '/nonexistent/path',
      branchName: 'task/test',
    });
    assert.equal(result, null);
  });

  it('aggregates assistant message usage across native session files', () => {
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
    const result = getNativeProviderMetadata('/nonexistent/path');
    assert.equal(result, null);
  });

  it('extracts provider and api from session_started event', () => {
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
    const { worktreePath, nativeSessionsDir, cleanup } = setupNativeSessionDir();
    try {
      // Create a session_started event without 'api' field
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

  it('returns first session_started event when multiple sessions exist', () => {
    const { worktreePath, nativeSessionsDir, cleanup } = setupNativeSessionDir();
    try {
      const lines1 = [
        nativeSessionStarted('first-model'),
        nativeAssistantMessage({ input: 100, output: 50 }),
      ].join('\n');
      const lines2 = [
        JSON.stringify({
          seq: 1,
          sessionId: 'second-session',
          timestamp: 2,
          type: 'session_started',
          model: 'second-model',
          api: 'other-api',
          provider: 'other-provider',
        }),
        nativeAssistantMessage({ input: 200, output: 100 }),
      ].join('\n');

      writeFileSync(join(nativeSessionsDir, 'session1.jsonl'), lines1);
      writeFileSync(join(nativeSessionsDir, 'session2.jsonl'), lines2);

      const result = getNativeProviderMetadata(worktreePath);
      assert.ok(result);
      // Should return the first one found (order may vary by filesystem)
      assert.ok(['pi', 'other-provider'].includes(result.provider));
    } finally {
      cleanup();
    }
  });
});

// ── Auto-Detection Tests ───────────────────────────────────────

describe('detectAgentType', () => {
  it('detects claude when only Claude sessions exist', () => {
    const { worktreePath, projectsDir, cleanup } = setupClaudeSessionDir();
    try {
      const branch = 'task/test';
      const lines = [
        claudeAssistantTurn({ branch, inputTokens: 100, outputTokens: 50 }),
      ].join('\n');
      writeFileSync(join(projectsDir, 'session1.jsonl'), lines);

      const detected = detectAgentType({ worktreePath, branchName: branch });
      assert.equal(detected, 'claude');
    } finally {
      cleanup();
    }
  });

  it('detects codex when only Codex sessions exist', () => {
    const { sessionsDir, cleanup } = setupCodexSessionDir();
    try {
      const worktreePath = '/test/worktree';
      const branch = 'task/test';

      const lines = [
        codexSessionMeta({ cwd: worktreePath, branch }),
        codexTurnContext('gpt-5.3-codex'),
        codexTokenCount({ inputTokens: 1000, cachedInputTokens: 500, outputTokens: 100, reasoningOutputTokens: 20 }),
      ].join('\n');

      writeFileSync(join(sessionsDir, 'rollout-test.jsonl'), lines);

      const detected = detectAgentType({ worktreePath, branchName: branch });
      assert.equal(detected, 'codex');
    } finally {
      cleanup();
    }
  });

  it('picks agent with more turns when both exist', () => {
    // Set up both Claude and Codex sessions
    const tmpHome = mkdtempSync(join(tmpdir(), 'adapter-both-'));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;

    try {
      const worktreePath = join(tmpHome, 'test-worktree');
      const branch = 'task/test';

      // Set up Claude session with 1 turn
      const encoded = encodeProjectDir(worktreePath);
      const claudeDir = join(tmpHome, '.claude', 'projects', encoded);
      mkdirSync(claudeDir, { recursive: true });
      const claudeLines = [
        claudeAssistantTurn({ branch, inputTokens: 100, outputTokens: 50 }),
      ].join('\n');
      writeFileSync(join(claudeDir, 'session1.jsonl'), claudeLines);

      // Set up Codex session with 2 files (2 turns)
      const codexDir = join(tmpHome, '.codex', 'sessions', '2026', '02', '20');
      mkdirSync(codexDir, { recursive: true });
      const codexLines = [
        codexSessionMeta({ cwd: worktreePath, branch }),
        codexTurnContext('gpt-5.3-codex'),
        codexTokenCount({ inputTokens: 1000, cachedInputTokens: 500, outputTokens: 100, reasoningOutputTokens: 20 }),
      ].join('\n');
      writeFileSync(join(codexDir, 'session1.jsonl'), codexLines);
      writeFileSync(join(codexDir, 'session2.jsonl'), codexLines);

      const detected = detectAgentType({ worktreePath, branchName: branch });
      assert.equal(detected, 'codex'); // Codex has 2 sessions vs Claude's 1
    } finally {
      process.env.HOME = origHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('returns null when no sessions exist', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'adapter-none-'));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;

    try {
      const detected = detectAgentType({
        worktreePath: '/nonexistent/path',
        branchName: 'task/test',
      });
      assert.equal(detected, null);
    } finally {
      process.env.HOME = origHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('detects native when only native sessions exist', () => {
    const { worktreePath, nativeSessionsDir, cleanup } = setupNativeSessionDir();
    try {
      const lines = [
        nativeSessionStarted('pi-model'),
        nativeAssistantMessage({ input: 100, output: 50 }),
      ].join('\n');
      writeFileSync(join(nativeSessionsDir, 'session.jsonl'), lines);

      const detected = detectAgentType({ worktreePath, branchName: 'task/test' });
      assert.equal(detected, 'native');
    } finally {
      cleanup();
    }
  });

  it('picks native over claude when native has more turns', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'adapter-native-claude-'));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;

    try {
      const worktreePath = join(tmpHome, 'test-worktree');
      const branch = 'task/test';

      // Set up Claude session with 1 turn
      const encoded = encodeProjectDir(worktreePath);
      const claudeDir = join(tmpHome, '.claude', 'projects', encoded);
      mkdirSync(claudeDir, { recursive: true });
      const claudeLines = [
        claudeAssistantTurn({ branch, inputTokens: 100, outputTokens: 50 }),
      ].join('\n');
      writeFileSync(join(claudeDir, 'session1.jsonl'), claudeLines);

      // Set up native session with 2 assistant messages (2 turns)
      const nativeSessionsDir = join(
        worktreePath,
        '.wavemill',
        'runs',
        'HOK-2305',
        'native-sessions',
      );
      mkdirSync(nativeSessionsDir, { recursive: true });
      const nativeLines = [
        nativeSessionStarted('pi-model'),
        nativeAssistantMessage({ input: 100, output: 50 }),
        nativeAssistantMessage({ input: 200, output: 100 }),
      ].join('\n');
      writeFileSync(join(nativeSessionsDir, 'session.jsonl'), nativeLines);

      const detected = detectAgentType({ worktreePath, branchName: branch });
      assert.equal(detected, 'native'); // Native has 2 turns vs Claude's 1
    } finally {
      process.env.HOME = origHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('picks winner from all three agents based on turn count', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'adapter-all-three-'));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;

    try {
      const worktreePath = join(tmpHome, 'test-worktree');
      const branch = 'task/test';

      // Set up Claude session with 1 turn
      const encoded = encodeProjectDir(worktreePath);
      const claudeDir = join(tmpHome, '.claude', 'projects', encoded);
      mkdirSync(claudeDir, { recursive: true });
      const claudeLines = [
        claudeAssistantTurn({ branch, inputTokens: 100, outputTokens: 50 }),
      ].join('\n');
      writeFileSync(join(claudeDir, 'session1.jsonl'), claudeLines);

      // Set up Codex session with 2 files (2 turns)
      const codexDir = join(tmpHome, '.codex', 'sessions', '2026', '02', '20');
      mkdirSync(codexDir, { recursive: true });
      const codexLines = [
        codexSessionMeta({ cwd: worktreePath, branch }),
        codexTurnContext('gpt-5.3-codex'),
        codexTokenCount({ inputTokens: 1000, cachedInputTokens: 500, outputTokens: 100, reasoningOutputTokens: 20 }),
      ].join('\n');
      writeFileSync(join(codexDir, 'session1.jsonl'), codexLines);
      writeFileSync(join(codexDir, 'session2.jsonl'), codexLines);

      // Set up native session with 3 assistant messages (3 turns)
      const nativeSessionsDir = join(
        worktreePath,
        '.wavemill',
        'runs',
        'HOK-2305',
        'native-sessions',
      );
      mkdirSync(nativeSessionsDir, { recursive: true });
      const nativeLines = [
        nativeSessionStarted('pi-model'),
        nativeAssistantMessage({ input: 100, output: 50 }),
        nativeAssistantMessage({ input: 200, output: 100 }),
        nativeAssistantMessage({ input: 300, output: 150 }),
      ].join('\n');
      writeFileSync(join(nativeSessionsDir, 'session.jsonl'), nativeLines);

      const detected = detectAgentType({ worktreePath, branchName: branch });
      assert.equal(detected, 'native'); // Native has 3 turns vs Codex's 2 vs Claude's 1
    } finally {
      process.env.HOME = origHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// ── Factory Tests ───────────────────────────────────────────────

describe('getSessionAdapter', () => {
  it('returns ClaudeSessionAdapter by default', () => {
    const adapter = getSessionAdapter();
    assert.ok(adapter instanceof ClaudeSessionAdapter);
  });

  it('returns ClaudeSessionAdapter for "claude"', () => {
    const adapter = getSessionAdapter('claude');
    assert.ok(adapter instanceof ClaudeSessionAdapter);
  });

  it('returns CodexSessionAdapter for "codex"', () => {
    const adapter = getSessionAdapter('codex');
    assert.ok(adapter instanceof CodexSessionAdapter);
  });

  it('returns NativeSessionAdapter for "native"', () => {
    const adapter = getSessionAdapter('native');
    assert.ok(adapter instanceof NativeSessionAdapter);
  });

  it('returns ClaudeSessionAdapter for unknown agent type', () => {
    const adapter = getSessionAdapter('unknown-agent');
    assert.ok(adapter instanceof ClaudeSessionAdapter);
  });

  it('returns ClaudeSessionAdapter for "claude-deepseek"', () => {
    const adapter = getSessionAdapter('claude-deepseek');
    assert.ok(adapter instanceof ClaudeSessionAdapter);
  });
});

describe('matchesIssue', () => {
  // Native transcripts for every task share one directory, so without this
  // filter each task's cost absorbed every other task's tokens.
  it('matches the transcript belonging to the issue', () => {
    assert.equal(matchesIssue('coding-HOK-2728_c.jsonl', 'HOK-2728_c'), true);
    assert.equal(matchesIssue('planning-HOK-2728_c.jsonl', 'HOK-2728_c'), true);
  });

  it('does not match a different issue', () => {
    assert.equal(matchesIssue('coding-HOK-537_c.jsonl', 'HOK-2728_c'), false);
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

  // Review and expansion transcripts do not encode the issue, so an
  // issue-only filter would silently drop the whole review phase from cost.
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

  it('keeps unattributable transcripts such as expansion', () => {
    assert.equal(matchesIssue('expansion-abc123.jsonl', 'HOK-2728_c', 'task/my-slug'), true);
  });
});

// ────────────────────────────────────────────────────────────────
// External session detail (HOK-2958)
// ────────────────────────────────────────────────────────────────

describe('ClaudeSessionAdapter externalSessions', () => {
  it('captures per-turn model switches, lineage, reasoning tokens, and trigger source', () => {
    const { worktreePath, projectsDir, cleanup } = setupClaudeSessionDir();
    try {
      const lines = [
        JSON.stringify({
          type: 'user',
          sessionId: 'sess-rich',
          version: '2.1.270',
          gitBranch: 'task/test',
          isSidechain: false,
          promptSource: 'sdk',
          promptId: 'prompt-1',
          uuid: 'u0',
          timestamp: '2026-09-01T10:00:00Z',
          message: { role: 'user', content: 'go' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'sess-rich',
          version: '2.1.270',
          gitBranch: 'task/test',
          isSidechain: false,
          uuid: 'a1',
          parentUuid: 'u0',
          timestamp: '2026-09-01T10:00:05Z',
          message: {
            model: 'claude-opus-4-6',
            role: 'assistant',
            content: [],
            usage: {
              input_tokens: 100,
              cache_creation_input_tokens: 50,
              cache_read_input_tokens: 200,
              output_tokens: 30,
              output_tokens_details: { thinking_tokens: 12 },
            },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'sess-rich',
          version: '2.1.270',
          gitBranch: 'task/test',
          isSidechain: true,
          uuid: 'a2',
          parentUuid: 'a1',
          timestamp: '2026-09-01T10:01:00Z',
          message: {
            model: 'claude-haiku-4-5-20251001',
            role: 'assistant',
            content: [],
            usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 },
          },
        }),
      ].join('\n');
      writeFileSync(join(projectsDir, 'sess-rich.jsonl'), lines);

      const result = new ClaudeSessionAdapter().scan({ worktreePath, branchName: 'task/test' });
      assert.ok(result);
      assert.equal(result.externalSessions?.length, 1);
      const session = result.externalSessions![0];
      assert.equal(session.sessionId, 'sess-rich');
      assert.equal(session.harness, 'claude-code');
      assert.equal(session.harnessVersion, '2.1.270');
      assert.equal(session.triggerSource, 'sdk');
      assert.equal(session.triggerProvenance, 'claude_code.promptSource');
      assert.equal(session.turnCount, 2);
      assert.deepEqual(session.turns.map((t) => t.model), ['claude-opus-4-6', 'claude-haiku-4-5-20251001']);
      assert.deepEqual(session.turns.map((t) => t.isSubagent), [false, true]);
      assert.equal(session.turns[1].parentId, 'a1');
      assert.equal(session.turns[0].usage.reasoningTokens, 12);
      assert.equal(session.turns[0].usage.cacheWriteTokens, 50);
      // Second turn has no thinking tokens reported → null, never 0
      assert.equal(session.turns[1].usage.reasoningTokens, null);
      assert.equal(session.usage.inputTokens, 140);
      assert.equal(session.usage.reasoningTokens, 12);
      // No costUSD in current Claude Code versions → null, never 0
      assert.equal(session.actualCostUsd, null);
      // Aggregate result unchanged in shape and content
      assert.equal(result.models['claude-opus-4-6'].inputTokens, 100);
      assert.equal(result.models['claude-haiku-4-5-20251001'].inputTokens, 40);
      assert.equal(result.turnCount, 2);
    } finally {
      cleanup();
    }
  });

  it('degrades gracefully for old-version entries lacking uuid/isSidechain/thinking_tokens', () => {
    const { worktreePath, projectsDir, cleanup } = setupClaudeSessionDir();
    try {
      writeFileSync(
        join(projectsDir, 'sess-old.jsonl'),
        claudeAssistantTurn({ branch: 'task/test' }),
      );

      const result = new ClaudeSessionAdapter().scan({ worktreePath, branchName: 'task/test' });
      assert.ok(result);
      const session = result.externalSessions![0];
      assert.equal(session.turns[0].turnId, null);
      assert.equal(session.turns[0].isSubagent, null);
      assert.equal(session.turns[0].usage.reasoningTokens, null);
      assert.equal(session.triggerSource, null);
      assert.equal(session.harnessVersion, null);
      assert.ok(session.diagnostics.some((d) => d.includes('uuid')));
      assert.ok(session.diagnostics.some((d) => d.includes('thinking_tokens')));
      // Aggregate unchanged despite the missing detail fields
      assert.equal(result.models['claude-opus-4-6'].inputTokens, 100);
    } finally {
      cleanup();
    }
  });

  it('drops identity attributes embedded in raw session lines', () => {
    const { worktreePath, projectsDir, cleanup } = setupClaudeSessionDir();
    try {
      const line = JSON.stringify({
        type: 'assistant',
        sessionId: 'sess-priv',
        gitBranch: 'task/test',
        uuid: 'a1',
        cwd: '/Users/someone/secret-project',
        user: { email: 'person@example.com', account_uuid: 'acct-uuid-123' },
        organization: { id: 'org-id-456' },
        message: {
          model: 'claude-opus-4-6',
          role: 'assistant',
          content: [],
          usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 },
        },
      });
      writeFileSync(join(projectsDir, 'sess-priv.jsonl'), line);

      const result = new ClaudeSessionAdapter().scan({ worktreePath, branchName: 'task/test' });
      assert.ok(result);
      const serialized = JSON.stringify(result.externalSessions);
      assert.equal(serialized.includes('person@example.com'), false);
      assert.equal(serialized.includes('acct-uuid-123'), false);
      assert.equal(serialized.includes('org-id-456'), false);
      assert.equal(serialized.includes('secret-project'), false);
    } finally {
      cleanup();
    }
  });
});

describe('CodexSessionAdapter externalSessions', () => {
  function codexTurnContextWithIds(model: string, turnId: string, rootTurnId: string): string {
    return JSON.stringify({
      timestamp: '2026-09-01T11:00:00Z',
      type: 'turn_context',
      payload: { cwd: '/test', model, effort: 'medium', turn_id: turnId, root_turn_id: rootTurnId },
    });
  }

  function codexTokenCountWithDelta(opts: {
    total: Record<string, number>;
    last?: Record<string, number>;
  }): string {
    return JSON.stringify({
      timestamp: '2026-09-01T11:00:10Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: opts.total,
          ...(opts.last ? { last_token_usage: opts.last } : {}),
        },
        rate_limits: { primary_window: 'secret-rate-limit' },
      },
    });
  }

  it('captures per-turn deltas, turn identity, cache writes, and reasoning tokens', () => {
    const { sessionsDir, cleanup } = setupCodexSessionDir();
    try {
      const lines = [
        codexSessionMeta({ cwd: '/some/worktree', branch: 'task/test' }),
        codexTurnContextWithIds('gpt-5.3-codex', 't1', 't1'),
        codexTokenCountWithDelta({
          total: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 5, total_tokens: 130 },
          last: { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 8, output_tokens: 30, reasoning_output_tokens: 5 },
        }),
        codexTurnContextWithIds('gpt-5.3-codex-mini', 't2', 't1'),
        codexTokenCountWithDelta({
          total: { input_tokens: 150, cached_input_tokens: 30, output_tokens: 45, reasoning_output_tokens: 9, total_tokens: 195 },
          last: { input_tokens: 50, cached_input_tokens: 10, cache_write_input_tokens: 2, output_tokens: 15, reasoning_output_tokens: 4 },
        }),
      ].join('\n');
      writeFileSync(join(sessionsDir, 'rollout-rich.jsonl'), lines);

      const result = new CodexSessionAdapter().scan({ worktreePath: '/some/worktree', branchName: 'task/test' });
      assert.ok(result);
      assert.equal(result.externalSessions?.length, 1);
      const session = result.externalSessions![0];
      assert.equal(session.harness, 'codex');
      assert.equal(session.sessionId, '019c7ba0-test');
      assert.equal(session.harnessVersion, '0.99.0');
      assert.equal(session.triggerSource, 'codex_exec');
      assert.equal(session.triggerProvenance, 'codex.session_meta.originator');
      assert.equal(session.turnCount, 2);
      assert.deepEqual(session.turns.map((t) => t.turnId), ['t1', 't2']);
      assert.deepEqual(session.turns.map((t) => t.parentId), ['t1', 't1']);
      assert.deepEqual(session.turns.map((t) => t.model), ['gpt-5.3-codex', 'gpt-5.3-codex-mini']);
      assert.equal(session.turns[0].usage.cacheWriteTokens, 8);
      assert.equal(session.turns[1].usage.reasoningTokens, 4);
      // Session totals come from cumulative total_token_usage
      assert.equal(session.usage.inputTokens, 150);
      assert.equal(session.usage.reasoningTokens, 9);
      // total_token_usage carries no cache_write field → null, never 0
      assert.equal(session.usage.cacheWriteTokens, null);
      assert.equal(session.actualCostUsd, null);
      // Aggregate result unchanged: last turn_context model, cumulative totals
      assert.equal(result.models['gpt-5.3-codex-mini'].inputTokens, 150);
      assert.equal(result.models['gpt-5.3-codex-mini'].outputTokens, 45 + 9);
      assert.equal(result.turnCount, 1);
    } finally {
      cleanup();
    }
  });

  it('degrades to session-level usage when only cumulative totals exist', () => {
    const { sessionsDir, cleanup } = setupCodexSessionDir();
    try {
      const lines = [
        codexSessionMeta({ cwd: '/some/worktree', branch: 'task/test' }),
        codexTurnContext('gpt-5.3-codex'),
        codexTokenCount({ inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 5 }),
      ].join('\n');
      writeFileSync(join(sessionsDir, 'rollout-old.jsonl'), lines);

      const result = new CodexSessionAdapter().scan({ worktreePath: '/some/worktree', branchName: 'task/test' });
      assert.ok(result);
      const session = result.externalSessions![0];
      // Old turn_context without turn ids still yields a turn with null identity
      assert.equal(session.turnCount, 1);
      assert.equal(session.turns[0].turnId, null);
      assert.equal(session.turns[0].usageAvailable, false);
      assert.ok(session.diagnostics.some((d) => d.includes('last_token_usage')));
      assert.equal(session.usage.inputTokens, 100);
      // Aggregate identical to the pre-HOK-2958 behavior
      assert.equal(result.models['gpt-5.3-codex'].inputTokens, 100);
      assert.equal(result.models['gpt-5.3-codex'].outputTokens, 35);
    } finally {
      cleanup();
    }
  });

  it('drops cwd, repository_url, rate limits, and identity attributes', () => {
    const { sessionsDir, cleanup } = setupCodexSessionDir();
    try {
      const meta = JSON.parse(codexSessionMeta({ cwd: '/some/worktree', branch: 'task/test' }));
      meta.payload.user = { email: 'person@example.com', account_uuid: 'acct-uuid-123' };
      meta.payload.organization = { id: 'org-id-456' };
      const lines = [
        JSON.stringify(meta),
        codexTurnContext('gpt-5.3-codex'),
        codexTokenCount({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 }),
      ].join('\n');
      writeFileSync(join(sessionsDir, 'rollout-priv.jsonl'), lines);

      const result = new CodexSessionAdapter().scan({ worktreePath: '/some/worktree', branchName: 'task/test' });
      assert.ok(result);
      const serialized = JSON.stringify(result.externalSessions);
      assert.equal(serialized.includes('person@example.com'), false);
      assert.equal(serialized.includes('acct-uuid-123'), false);
      assert.equal(serialized.includes('org-id-456'), false);
      assert.equal(serialized.includes('/some/worktree'), false);
      assert.equal(serialized.includes('repository_url'), false);
      assert.equal(serialized.includes('git@github.com'), false);
      assert.equal(serialized.includes('secret-rate-limit'), false);
    } finally {
      cleanup();
    }
  });
});
