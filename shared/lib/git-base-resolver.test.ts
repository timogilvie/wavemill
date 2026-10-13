import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchOriginBranch,
  ORIGIN_FETCH_TIMEOUT_MS,
  resolveDefaultBaseRef,
  resolveOriginFirstRef,
  resolveReviewDiffBase,
  REVIEW_SKIP_FETCH_ENV,
} from './git-base-resolver.ts';

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

interface RecordedCall {
  cmd: string;
  opts: { timeout?: number; env?: Record<string, string | undefined> } | undefined;
}

function recordingExec(handler: (cmd: string) => string | Error): {
  calls: RecordedCall[];
  exec: (cmd: string, opts?: RecordedCall['opts']) => string;
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    exec: (cmd, opts) => {
      calls.push({ cmd, opts });
      const result = handler(cmd);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  };
}

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test('fetchOriginBranch bounds the fetch with an exec timeout, never timeout(1)', () => {
  const { calls, exec } = recordingExec(() => '');
  assert.equal(fetchOriginBranch('/tmp/repo', 'auto/integration', { execShellCommand: exec }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "git fetch --quiet origin 'auto/integration'");
  assert.doesNotMatch(calls[0].cmd, /^timeout /);
  assert.equal(calls[0].opts?.timeout, ORIGIN_FETCH_TIMEOUT_MS);
  assert.equal(calls[0].opts?.env?.GIT_TERMINAL_PROMPT, '0');
});

test('fetchOriginBranch strips origin/ and refs/ prefixes before fetching', () => {
  for (const input of ['origin/main', 'refs/heads/main', 'refs/remotes/origin/main']) {
    const { calls, exec } = recordingExec(() => '');
    assert.equal(fetchOriginBranch('/tmp/repo', input, { execShellCommand: exec }), true, input);
    assert.equal(calls[0].cmd, "git fetch --quiet origin 'main'", input);
  }
});

test('fetchOriginBranch refuses unsafe or unfetchable names without running git', () => {
  for (const input of ['', '-x', 'a..b', 'origin/-x', 'abcdef0123456789abcdef0123456789abcdef01', 'refs/tags/v1']) {
    const { calls, exec } = recordingExec(() => '');
    assert.equal(fetchOriginBranch('/tmp/repo', input, { execShellCommand: exec }), false, input);
    assert.equal(calls.length, 0, input);
  }
});

test('fetchOriginBranch returns false when the fetch fails', () => {
  const { exec } = recordingExec(() => new Error('fatal: could not read from remote'));
  assert.equal(fetchOriginBranch('/tmp/repo', 'main', { execShellCommand: exec }), false);
});

function diffBaseExec(options: { fetchFails?: boolean; originExists?: boolean } = {}) {
  return recordingExec((cmd) => {
    if (cmd.startsWith('git fetch')) {
      return options.fetchFails ? new Error('offline') : '';
    }
    if (cmd.includes('refs/remotes/origin/')) {
      return options.originExists === false ? new Error('unknown ref') : '';
    }
    if (cmd.startsWith('git rev-parse --verify --quiet')) {
      return `${'b'.repeat(40)}\n`;
    }
    if (cmd.startsWith('git merge-base')) {
      return `${'m'.repeat(40)}\n`;
    }
    return new Error(`unexpected: ${cmd}`);
  });
}

test('resolveReviewDiffBase fetches, resolves origin-first, and records base + merge-base', () => {
  const { calls, exec } = diffBaseExec();
  const base = withEnv(REVIEW_SKIP_FETCH_ENV, undefined, () =>
    resolveReviewDiffBase('/tmp/repo', 'auto/integration', { execShellCommand: exec }));
  assert.deepEqual(base, {
    requestedRef: 'auto/integration',
    ref: 'origin/auto/integration',
    kind: 'remote',
    fetch: 'fetched',
    baseSha: 'b'.repeat(40),
    mergeBaseSha: 'm'.repeat(40),
  });
  assert.match(calls[0].cmd, /^git fetch /);
  assert.ok(calls.some((call) => call.cmd === "git merge-base 'origin/auto/integration' HEAD"));
});

test('resolveReviewDiffBase records a failed fetch and falls back to the local branch', () => {
  const { exec } = diffBaseExec({ fetchFails: true, originExists: false });
  const base = withEnv(REVIEW_SKIP_FETCH_ENV, undefined, () =>
    resolveReviewDiffBase('/tmp/repo', 'main', { execShellCommand: exec }));
  assert.equal(base.fetch, 'failed');
  assert.equal(base.kind, 'local');
  assert.equal(base.ref, 'main');
});

test('resolveReviewDiffBase skips the fetch for SHAs and when WAVEMILL_REVIEW_SKIP_FETCH=1', () => {
  const sha = 'abcdef0123456789abcdef0123456789abcdef01';
  const shaRun = diffBaseExec();
  const shaBase = withEnv(REVIEW_SKIP_FETCH_ENV, undefined, () =>
    resolveReviewDiffBase('/tmp/repo', sha, { execShellCommand: shaRun.exec }));
  assert.equal(shaBase.fetch, 'skipped');
  assert.equal(shaBase.kind, 'explicit');
  assert.equal(shaBase.ref, sha);
  assert.ok(!shaRun.calls.some((call) => call.cmd.startsWith('git fetch')));

  const optOut = diffBaseExec();
  const optOutBase = withEnv(REVIEW_SKIP_FETCH_ENV, '1', () =>
    resolveReviewDiffBase('/tmp/repo', 'auto/integration', { execShellCommand: optOut.exec }));
  assert.equal(optOutBase.fetch, 'skipped');
  assert.equal(optOutBase.ref, 'origin/auto/integration');
  assert.ok(!optOut.calls.some((call) => call.cmd.startsWith('git fetch')));
});

test('resolveReviewDiffBase still fetches an explicit origin/<b> so it is fresh', () => {
  const { calls, exec } = diffBaseExec();
  const base = withEnv(REVIEW_SKIP_FETCH_ENV, undefined, () =>
    resolveReviewDiffBase('/tmp/repo', 'origin/auto/integration', { execShellCommand: exec }));
  assert.equal(base.fetch, 'fetched');
  assert.equal(base.kind, 'explicit');
  assert.equal(calls[0].cmd, "git fetch --quiet origin 'auto/integration'");
});

test('resolveReviewDiffBase never throws when git fails everywhere', () => {
  const { exec } = recordingExec(() => new Error('fatal: not a git repository'));
  const base = withEnv(REVIEW_SKIP_FETCH_ENV, undefined, () =>
    resolveReviewDiffBase('/tmp/repo', 'main', { execShellCommand: exec }));
  assert.equal(base.fetch, 'failed');
  assert.equal(base.baseSha, null);
  assert.equal(base.mergeBaseSha, null);
});
