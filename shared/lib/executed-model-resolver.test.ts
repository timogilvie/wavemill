import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExecutedModelFromSessions } from './executed-model-resolver.ts';
import { encodeProjectDir } from './workflow-cost.ts';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function withTempHome(prefix: string) {
  const tmpHome = mkdtempSync(join(tmpdir(), prefix));
  const oldHome = process.env.HOME;
  process.env.HOME = tmpHome;
  cleanups.push(() => {
    process.env.HOME = oldHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });
  return tmpHome;
}

function setupClaude() {
  const home = withTempHome('resolver-claude-');
  const worktreePath = join(home, 'worktree');
  const projectsDir = join(home, '.claude', 'projects', encodeProjectDir(worktreePath));
  mkdirSync(projectsDir, { recursive: true });
  return { home, worktreePath, projectsDir };
}

function setupCodex() {
  const home = withTempHome('resolver-codex-');
  const sessionsDir = join(home, '.codex', 'sessions', '2026', '09', '15');
  mkdirSync(sessionsDir, { recursive: true });
  return { home, sessionsDir };
}

function writeJsonl(filePath: string, entries: unknown[]) {
  writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
}

function claudeTurn(opts: {
  branch?: string;
  model?: string;
  timestamp: string;
  isSidechain?: boolean;
  uuid?: string;
}) {
  return {
    type: 'assistant',
    timestamp: opts.timestamp,
    uuid: opts.uuid ?? `turn-${opts.timestamp}`,
    parentUuid: null,
    isSidechain: opts.isSidechain ?? false,
    gitBranch: opts.branch ?? 'task/HOK-3017',
    message: {
      model: opts.model ?? 'claude-haiku-4-5',
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 5,
      },
    },
  };
}

function codexMeta(opts: { cwd: string; branch: string; id?: string }) {
  return {
    timestamp: '2026-09-15T10:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: opts.id ?? 'codex-session',
      timestamp: '2026-09-15T10:00:00.000Z',
      cwd: opts.cwd,
      cli_version: '1.0.0',
      originator: 'codex_exec',
      git: { branch: opts.branch },
    },
  };
}

function codexTurn(model: string, timestamp: string) {
  return {
    timestamp,
    type: 'turn_context',
    payload: {
      turn_id: `turn-${timestamp}`,
      root_turn_id: null,
      model,
    },
  };
}

function codexToken(timestamp = '2026-09-15T10:02:30.000Z') {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 10,
          cached_input_tokens: 1,
          output_tokens: 2,
          reasoning_output_tokens: 3,
        },
        total_token_usage: {
          input_tokens: 10,
          cached_input_tokens: 1,
          output_tokens: 2,
          reasoning_output_tokens: 3,
          total_tokens: 15,
        },
      },
    },
  };
}

describe('resolveExecutedModelFromSessions', () => {
  it('resolves a single Claude model in the stage window', () => {
    const fixture = setupClaude();
    writeJsonl(join(fixture.projectsDir, 'claude.jsonl'), [
      claudeTurn({ timestamp: '2026-09-15T10:01:00.000Z', model: 'claude-haiku-4-5' }),
    ]);

    const result = resolveExecutedModelFromSessions({
      worktreePath: fixture.worktreePath,
      branchName: 'task/HOK-3017',
      agent: 'claude',
      startedAt: '2026-09-15T10:00:00.000Z',
      finishedAt: '2026-09-15T10:05:00.000Z',
    });

    assert.equal(result.executedModel, 'claude-haiku-4-5');
    assert.equal(result.evidenceStatus, 'direct');
    assert.equal(result.evidenceSource, 'claude-session');
  });

  it('excludes Claude turns after finishedAt', () => {
    const fixture = setupClaude();
    writeJsonl(join(fixture.projectsDir, 'claude.jsonl'), [
      claudeTurn({ timestamp: '2026-09-15T10:04:59.000Z', model: 'claude-haiku-4-5' }),
      claudeTurn({ timestamp: '2026-09-15T10:05:01.000Z', model: 'claude-sonnet-5' }),
    ]);

    const result = resolveExecutedModelFromSessions({
      worktreePath: fixture.worktreePath,
      branchName: 'task/HOK-3017',
      agent: 'claude',
      startedAt: '2026-09-15T10:00:00.000Z',
      finishedAt: '2026-09-15T10:05:00.000Z',
    });

    assert.equal(result.executedModel, 'claude-haiku-4-5');
  });

  it('ignores Claude sidechain turns when main-loop turns exist', () => {
    const fixture = setupClaude();
    writeJsonl(join(fixture.projectsDir, 'claude.jsonl'), [
      claudeTurn({ timestamp: '2026-09-15T10:01:00.000Z', model: 'claude-haiku-4-5', isSidechain: true }),
      claudeTurn({ timestamp: '2026-09-15T10:02:00.000Z', model: 'claude-sonnet-5', isSidechain: false }),
    ]);

    const result = resolveExecutedModelFromSessions({
      worktreePath: fixture.worktreePath,
      branchName: 'task/HOK-3017',
      agent: 'claude',
      startedAt: '2026-09-15T10:00:00.000Z',
      finishedAt: '2026-09-15T10:05:00.000Z',
    });

    assert.equal(result.executedModel, 'claude-sonnet-5');
    assert.match(result.evidenceDetail, /excludedSubagentTurns=1/);
  });

  it('chooses the dominant Claude model and reports every observed model', () => {
    const fixture = setupClaude();
    writeJsonl(join(fixture.projectsDir, 'claude.jsonl'), [
      claudeTurn({ timestamp: '2026-09-15T10:01:00.000Z', model: 'claude-haiku-4-5' }),
      claudeTurn({ timestamp: '2026-09-15T10:02:00.000Z', model: 'claude-sonnet-5' }),
      claudeTurn({ timestamp: '2026-09-15T10:03:00.000Z', model: 'claude-sonnet-5' }),
    ]);

    const result = resolveExecutedModelFromSessions({
      worktreePath: fixture.worktreePath,
      branchName: 'task/HOK-3017',
      agent: 'claude',
      startedAt: '2026-09-15T10:00:00.000Z',
      finishedAt: '2026-09-15T10:05:00.000Z',
    });

    assert.equal(result.executedModel, 'claude-sonnet-5');
    assert.match(result.evidenceDetail, /claude-sonnet-5:2/);
    assert.match(result.evidenceDetail, /claude-haiku-4-5:1/);
  });

  it('reports missing evidence without echoing an intended model', () => {
    const fixture = setupClaude();

    const result = resolveExecutedModelFromSessions({
      worktreePath: fixture.worktreePath,
      branchName: 'task/HOK-3017',
      agent: 'claude',
      startedAt: '2026-09-15T10:00:00.000Z',
      finishedAt: '2026-09-15T10:05:00.000Z',
    });

    assert.equal(result.executedModel, null);
    assert.equal(result.evidenceStatus, 'missing');
    assert.doesNotMatch(result.evidenceDetail, /gpt-5\.5|claude-haiku-4-5/);
  });

  it('resolves a Codex rollout model in the stage window', () => {
    const fixture = setupCodex();
    const worktreePath = join(fixture.home, 'worktree');
    writeJsonl(join(fixture.sessionsDir, 'rollout-1.jsonl'), [
      codexMeta({ cwd: worktreePath, branch: 'task/HOK-3017' }),
      codexTurn('gpt-5.5', '2026-09-15T10:01:00.000Z'),
      codexToken(),
    ]);

    const result = resolveExecutedModelFromSessions({
      worktreePath,
      branchName: 'task/HOK-3017',
      agent: 'codex',
      startedAt: '2026-09-15T10:00:00.000Z',
      finishedAt: '2026-09-15T10:05:00.000Z',
    });

    assert.equal(result.executedModel, 'gpt-5.5');
    assert.equal(result.evidenceSource, 'codex-session');
  });

  it('matches Codex sessions by branch when the worktree no longer exists', () => {
    const fixture = setupCodex();
    writeJsonl(join(fixture.sessionsDir, 'rollout-branch.jsonl'), [
      codexMeta({ cwd: '/deleted/worktree', branch: 'task/HOK-3017' }),
      codexTurn('gpt-5.5', '2026-09-15T10:01:00.000Z'),
      codexToken(),
    ]);

    const result = resolveExecutedModelFromSessions({
      worktreePath: '/some/other/deleted/worktree',
      branchName: 'task/HOK-3017',
      agent: 'codex',
      startedAt: '2026-09-15T10:00:00.000Z',
      finishedAt: '2026-09-15T10:05:00.000Z',
    });

    assert.equal(result.executedModel, 'gpt-5.5');
  });

  it('merges overlapping sessions before computing dominance', () => {
    const fixture = setupClaude();
    writeJsonl(join(fixture.projectsDir, 'one.jsonl'), [
      claudeTurn({ timestamp: '2026-09-15T10:01:00.000Z', model: 'claude-haiku-4-5' }),
    ]);
    writeJsonl(join(fixture.projectsDir, 'two.jsonl'), [
      claudeTurn({ timestamp: '2026-09-15T10:02:00.000Z', model: 'claude-sonnet-5' }),
      claudeTurn({ timestamp: '2026-09-15T10:03:00.000Z', model: 'claude-sonnet-5' }),
    ]);

    const result = resolveExecutedModelFromSessions({
      worktreePath: fixture.worktreePath,
      branchName: 'task/HOK-3017',
      agent: 'claude',
      startedAt: '2026-09-15T10:00:00.000Z',
      finishedAt: '2026-09-15T10:05:00.000Z',
    });

    assert.equal(result.executedModel, 'claude-sonnet-5');
    assert.match(result.evidenceDetail, /sessions=2/);
  });
});
