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
  getSessionAdapter,
  detectAgentType,
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

  it('returns ClaudeSessionAdapter for unknown agent type', () => {
    const adapter = getSessionAdapter('unknown-agent');
    assert.ok(adapter instanceof ClaudeSessionAdapter);
  });
});
