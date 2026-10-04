import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  _internals,
  readIncidentLogExcerpt,
} from './incident-log-excerpt-reader.ts';

function tempRepo(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

const OBSERVED = 'failed_job_no_result';

test('prefers persisted job.error over any file read (no logPath needed)', () => {
  const repo = tempRepo('excerpt-persisted-');
  try {
    const excerpt = readIncidentLogExcerpt(
      {
        error: "SyntaxError: The requested module '@hokusai/core' does not provide an export named 'deriveTaskDescriptor'",
        // logPath intentionally unset: persisted error must be enough.
      },
      repo,
      OBSERVED,
    );
    assert.equal(excerpt.source, 'persisted_error');
    assert.equal(excerpt.diagnosedClass, 'module_export_contract_mismatch');
    assert.equal(excerpt.key, 'diag:module_export_contract_mismatch');
    assert.equal(excerpt.observedSymptom, OBSERVED);
    assert.match(excerpt.redactedText, /does not provide an export named/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('reads bounded head + tail from a huge log without exceeding MAX_READ_BYTES or MAX_EXCERPT_CHARS', () => {
  const repo = tempRepo('excerpt-huge-');
  try {
    mkdirSync(join(repo, '.wavemill', 'jobs'), { recursive: true });
    const logPath = join(repo, '.wavemill', 'jobs', 'HOK-2845.log');
    const filler = 'noise line noise line noise line noise line noise line\n'.repeat(40_000); // ~2MB
    const tailSignature = "SyntaxError: The requested module '@hokusai/core' does not provide an export named 'deriveTaskDescriptor'\n";
    writeFileSync(logPath, filler + tailSignature);

    const excerpt = readIncidentLogExcerpt({ logPath }, repo, OBSERVED);
    assert.equal(excerpt.source, 'log_head_tail');
    assert.equal(excerpt.diagnosedClass, 'module_export_contract_mismatch');
    assert.ok(excerpt.redactedText.length <= _internals.MAX_EXCERPT_CHARS,
      `excerpt length ${excerpt.redactedText.length} exceeds ${_internals.MAX_EXCERPT_CHARS}`);
    assert.match(excerpt.redactedText, /does not provide an export named/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('redacts Bearer tokens, sk- keys, emails, and absolute /Users paths from the excerpt', () => {
  const repo = tempRepo('excerpt-redact-');
  try {
    const persisted = [
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijk',
      'export OPENROUTER_KEY=sk-abcdefghijk123456789xyz',
      'contact: person@example.com wrote at /Users/tim/project/logs/mill.log',
      'Random API_KEY=supersecretvalue1234567890',
      "SyntaxError: does not provide an export named 'foo'",
    ].join('\n');
    const excerpt = readIncidentLogExcerpt({ error: persisted }, repo, OBSERVED);
    assert.equal(excerpt.diagnosedClass, 'module_export_contract_mismatch');
    for (const secret of [
      'eyJhbGciOiJIUzI1NiJ9.abcdefghijk',
      'sk-abcdefghijk123456789xyz',
      'person@example.com',
      '/Users/tim/project',
      'supersecretvalue1234567890',
    ]) {
      assert.doesNotMatch(excerpt.redactedText, new RegExp(escapeRegExp(secret)),
        `expected secret \`${secret}\` to be redacted, got: ${excerpt.redactedText}`);
    }
    assert.match(excerpt.redactedText, /\[REDACTED\]|\[REDACTED_TOKEN\]|\[REDACTED_EMAIL\]|\[PATH\]/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('binary log file (leading NUL) returns unavailable with no excerpt data', () => {
  const repo = tempRepo('excerpt-binary-');
  try {
    const logPath = join(repo, 'artifact.bin');
    writeFileSync(logPath, Buffer.from([0, 1, 2, 3, 4, 5]));
    const excerpt = readIncidentLogExcerpt({ logPath }, repo, OBSERVED);
    assert.equal(excerpt.source, 'unavailable');
    assert.equal(excerpt.redactedText, '');
    assert.equal(excerpt.diagnosedClass, null);
    assert.equal(excerpt.key, `observed:${OBSERVED}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('missing log path returns unavailable and preserves observed key', () => {
  const repo = tempRepo('excerpt-missing-');
  try {
    const excerpt = readIncidentLogExcerpt(
      { logPath: join(repo, 'nope.log') },
      repo,
      OBSERVED,
    );
    assert.equal(excerpt.source, 'unavailable');
    assert.equal(excerpt.key, `observed:${OBSERVED}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('unreadable log path (EACCES) returns unavailable', { skip: process.getuid?.() === 0 }, () => {
  const repo = tempRepo('excerpt-eacces-');
  try {
    const logPath = join(repo, 'locked.log');
    writeFileSync(logPath, "SyntaxError: does not provide an export named 'foo'\n");
    chmodSync(logPath, 0o000);
    try {
      const excerpt = readIncidentLogExcerpt({ logPath }, repo, OBSERVED);
      assert.equal(excerpt.source, 'unavailable');
    } finally {
      chmodSync(logPath, 0o600);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('symlink escape to /etc/passwd returns unavailable', () => {
  const repo = tempRepo('excerpt-symlink-');
  try {
    const logPath = join(repo, 'escape.log');
    try {
      symlinkSync('/etc/passwd', logPath);
    } catch {
      return; // symlink creation not permitted; treat as skipped
    }
    const excerpt = readIncidentLogExcerpt({ logPath }, repo, OBSERVED);
    assert.equal(excerpt.source, 'unavailable');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('logPath outside repoDir returns unavailable', () => {
  const repo = tempRepo('excerpt-outside-');
  const otherRepo = tempRepo('excerpt-outside-other-');
  try {
    const logPath = join(otherRepo, 'foreign.log');
    writeFileSync(logPath, "SyntaxError: does not provide an export named 'foo'\n");
    const excerpt = readIncidentLogExcerpt({ logPath }, repo, OBSERVED);
    assert.equal(excerpt.source, 'unavailable');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(otherRepo, { recursive: true, force: true });
  }
});

test('relative log path is rejected as unavailable', () => {
  const repo = tempRepo('excerpt-relative-');
  try {
    const excerpt = readIncidentLogExcerpt({ logPath: './foo.log' }, repo, OBSERVED);
    assert.equal(excerpt.source, 'unavailable');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('transcript-like path is rejected even when it sits inside repoDir', () => {
  const repo = tempRepo('excerpt-transcripts-');
  try {
    mkdirSync(join(repo, '.wavemill', 'transcripts'), { recursive: true });
    const logPath = join(repo, '.wavemill', 'transcripts', 'chat.jsonl');
    writeFileSync(logPath, "SyntaxError: does not provide an export named 'foo'\n");
    const excerpt = readIncidentLogExcerpt({ logPath }, repo, OBSERVED);
    assert.equal(excerpt.source, 'unavailable');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('persisted excerpt that resembles a prompt/transcript collapses to unavailable', () => {
  const repo = tempRepo('excerpt-prompt-heuristic-');
  try {
    const promptLike = 'assistant: hello\nuser: this is a prompt turn '.repeat(60);
    const excerpt = readIncidentLogExcerpt({ error: promptLike }, repo, OBSERVED);
    assert.equal(excerpt.source, 'unavailable');
    assert.equal(excerpt.redactedText, '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('classifies module-export SyntaxError as module_export_contract_mismatch', () => {
  const repo = tempRepo('excerpt-classify-module-');
  try {
    const excerpt = readIncidentLogExcerpt(
      {
        error: "SyntaxError: The requested module '@hokusai/core' does not provide an export named 'deriveTaskDescriptor'",
      },
      repo,
      OBSERVED,
    );
    assert.equal(excerpt.diagnosedClass, 'module_export_contract_mismatch');
    assert.equal(excerpt.key, 'diag:module_export_contract_mismatch');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('classifies plain Unexpected token as local_parse_failure (no export contract signal)', () => {
  const repo = tempRepo('excerpt-classify-parse-');
  try {
    const excerpt = readIncidentLogExcerpt(
      { error: 'SyntaxError: Unexpected token } in JSON at position 42' },
      repo,
      OBSERVED,
    );
    assert.equal(excerpt.diagnosedClass, 'local_parse_failure');
    assert.equal(excerpt.key, 'diag:local_parse_failure');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('unknown signature keeps diagnosedClass null and preserves observed key for fingerprint stability', () => {
  const repo = tempRepo('excerpt-classify-unknown-');
  try {
    const excerpt = readIncidentLogExcerpt(
      { error: 'ImportError: cannot import name FooBar from package.baz' },
      repo,
      OBSERVED,
    );
    assert.equal(excerpt.source, 'persisted_error');
    assert.equal(excerpt.diagnosedClass, null);
    assert.equal(excerpt.key, `observed:${OBSERVED}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('same diagnosed class produces the same key across differing stack frames / line numbers', () => {
  const repo = tempRepo('excerpt-stable-key-');
  try {
    const a = readIncidentLogExcerpt(
      { error: "SyntaxError: does not provide an export named 'x'\n  at file.js:12:5" },
      repo,
      OBSERVED,
    );
    const b = readIncidentLogExcerpt(
      { error: "SyntaxError: does not provide an export named 'x'\n  at other.js:987:3" },
      repo,
      OBSERVED,
    );
    assert.equal(a.key, b.key);
    assert.equal(a.diagnosedClass, b.diagnosedClass);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
