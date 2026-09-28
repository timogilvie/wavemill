import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDefaultBaseRef, resolveOriginFirstRef } from './git-base-resolver.ts';

function makeExec(handler: (cmd: string) => string | Error): (cmd: string, opts?: { encoding?: string; cwd?: string }) => string {
  return (cmd: string) => {
    const result = handler(cmd);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };
}

test('resolveDefaultBaseRef returns origin/<name> when origin/HEAD resolves', () => {
  const exec = makeExec((cmd) => {
    if (cmd.startsWith('git symbolic-ref refs/remotes/origin/HEAD')) {
      return 'refs/remotes/origin/develop\n';
    }
    throw new Error('unexpected');
  });
  const value = resolveDefaultBaseRef('/tmp/repo', { execShellCommand: exec });
  assert.equal(value, 'origin/develop');
});

test('resolveDefaultBaseRef returns bare name from init.defaultBranch fallback', () => {
  const exec = makeExec((cmd) => {
    if (cmd.startsWith('git symbolic-ref')) {
      throw new Error('no symbolic ref');
    }
    if (cmd.startsWith('git config --get init.defaultBranch')) {
      return 'master\n';
    }
    throw new Error('unexpected');
  });
  const value = resolveDefaultBaseRef('/tmp/repo', { execShellCommand: exec });
  assert.equal(value, 'master');
});

test('resolveDefaultBaseRef returns bare main as final fallback', () => {
  const exec = makeExec(() => {
    throw new Error('no ref');
  });
  const value = resolveDefaultBaseRef('/tmp/repo', { execShellCommand: exec });
  assert.equal(value, 'main');
});

test('resolveOriginFirstRef rewrites a bare name to origin/<name> when origin ref verifies', () => {
  let sawProbe = '';
  const exec = makeExec((cmd) => {
    sawProbe = cmd;
    if (cmd.includes('rev-parse')) {
      return '';
    }
    throw new Error('unexpected');
  });
  const result = resolveOriginFirstRef('/tmp/repo', 'main', { execShellCommand: exec });
  assert.equal(result.ref, 'origin/main');
  assert.equal(result.kind, 'remote');
  assert.match(sawProbe, /refs\/remotes\/origin\/main/);
});

test('resolveOriginFirstRef falls back to bare name when origin ref does not verify', () => {
  const exec = makeExec(() => {
    throw new Error('fatal: unknown ref');
  });
  const result = resolveOriginFirstRef('/tmp/repo', 'main', { execShellCommand: exec });
  assert.equal(result.ref, 'main');
  assert.equal(result.kind, 'local');
});

test('resolveOriginFirstRef passes origin/x through unchanged', () => {
  let called = 0;
  const exec = makeExec(() => {
    called += 1;
    return '';
  });
  const result = resolveOriginFirstRef('/tmp/repo', 'origin/main', { execShellCommand: exec });
  assert.equal(result.ref, 'origin/main');
  assert.equal(result.kind, 'explicit');
  assert.equal(called, 0);
});

test('resolveOriginFirstRef passes refs/heads/x through unchanged', () => {
  const exec = makeExec(() => '');
  const result = resolveOriginFirstRef('/tmp/repo', 'refs/heads/topic', { execShellCommand: exec });
  assert.equal(result.ref, 'refs/heads/topic');
  assert.equal(result.kind, 'explicit');
});

test('resolveOriginFirstRef passes an explicit 40-hex SHA through unchanged', () => {
  const exec = makeExec(() => '');
  const sha = 'abcdef0123456789abcdef0123456789abcdef01';
  const result = resolveOriginFirstRef('/tmp/repo', sha, { execShellCommand: exec });
  assert.equal(result.ref, sha);
  assert.equal(result.kind, 'explicit');
});
