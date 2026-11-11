import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runSourceGuard } from './lib/source-guard.ts';
import { MODEL_TRANSPORT_GUARD } from './check-model-transport.ts';

function write(repo: string, relPath: string, contents: string): void {
  const fullPath = join(repo, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

function track(repo: string): void {
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' });
}

function patterns(repo: string): string[] {
  return runSourceGuard(MODEL_TRANSPORT_GUARD, repo).findings.map((f) => f.pattern).sort();
}

describe('MODEL_TRANSPORT_GUARD', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'model-transport-'));
    execFileSync('git', ['init', '-q', repo]);
    write(repo, 'tools/model-transport-allowlist.txt', '');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  // protects: a second CLI spawn outside the adapters must fail preflight.
  it('reports spawning the literal claude/codex binary', () => {
    write(repo, 'shared/lib/widget.ts', [
      "import { spawn } from 'node:child_process';",
      "spawn('claude', ['-p']);",
      "spawnSync('codex', ['exec']);",
      '',
    ].join('\n'));
    track(repo);
    assert.deepEqual(patterns(repo), ['cli-spawn', 'cli-spawn']);
  });

  // protects: claude argv construction belongs to ClaudeCliAdapter.
  it('reports claude output-format argv and the argv token', () => {
    write(repo, 'shared/lib/widget.ts', [
      'const command = `claude -p --output-format json --model x`;',
      "const args = ['-p', '--output-format', 'stream-json'];",
      '',
    ].join('\n'));
    track(repo);
    assert.deepEqual(patterns(repo), ['claude-output-format-argv', 'claude-output-format-token']);
  });

  // protects: codex argv construction belongs to CodexCliAdapter.
  it('reports codex exec --json argv', () => {
    write(repo, 'shared/lib/widget.ts', "const args = ['exec', '--json', '--sandbox', 'read-only'];\n");
    track(repo);
    assert.deepEqual(patterns(repo), ['codex-json-argv']);
  });

  // protects: codex JSONL parsing belongs to CodexCliAdapter.parseResult.
  it('reports codex JSONL event literals', () => {
    write(repo, 'shared/lib/widget.ts', [
      "if (event.type === 'turn.completed') {}",
      "if (event.type === 'agent_message') {}",
      '',
    ].join('\n'));
    track(repo);
    assert.deepEqual(patterns(repo), ['codex-jsonl-events', 'codex-jsonl-events']);
  });

  // protects: output-token env knobs are the adapter's, not a caller's.
  it('reports writes to CLAUDE_CODE_MAX_OUTPUT_TOKENS', () => {
    write(repo, 'shared/lib/widget.ts', 'env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(4096);\n');
    track(repo);
    assert.deepEqual(patterns(repo), ['output-token-env-write']);
  });

  // protects: a private LLM error classifier duplicates cli-error-classifier.
  it('reports a private classify*LLMError function', () => {
    write(repo, 'shared/lib/widget.ts', 'function classifyLLMError(error) { return error; }\n');
    track(repo);
    assert.deepEqual(patterns(repo), ['private-llm-error-classifier']);
  });

  // protects: the adapters remain the allowed home for transport code.
  it('does not report transport code under shared/lib/model-adapters/', () => {
    write(repo, 'shared/lib/model-adapters/claude-cli-adapter.ts', [
      "spawn('claude', ['-p', '--output-format', 'json']);",
      "if (event.type === 'thread.started') {}",
      'env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "1";',
      'function classifyLLMError() {}',
      '',
    ].join('\n'));
    track(repo);
    assert.deepEqual(patterns(repo), []);
  });

  // protects: prose in a comment is not an occurrence of the shape.
  it('ignores whole-line comments naming the forbidden shapes', () => {
    write(repo, 'shared/lib/widget.ts', [
      "// spawn('claude', ['-p', '--output-format', 'json'])",
      "// env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '1'",
      '',
    ].join('\n'));
    track(repo);
    assert.deepEqual(patterns(repo), []);
  });

  // protects: one justified exception can be suppressed inline.
  it('honours an inline allow-model-transport marker', () => {
    write(repo, 'shared/lib/widget.ts', [
      '// allow-model-transport: fixture intentionally spells a transport',
      "const args = ['exec', '--json'];",
      '',
    ].join('\n'));
    track(repo);
    assert.deepEqual(patterns(repo), []);
  });

  // protects: the guard runs clean against the real tree (ratchet: one allowlisted classifier).
  it('runs clean on the current repository', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    assert.deepEqual(runSourceGuard(MODEL_TRANSPORT_GUARD, repoRoot).findings, []);
  });
});
