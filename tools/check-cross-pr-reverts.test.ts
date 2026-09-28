import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { crossPrRevertCheckDeps, runCrossPrRevertCheck } from './check-cross-pr-reverts.ts';

function git(repoDir: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commitFile(repoDir: string, path: string, contents: string, message: string): void {
  writeFileSync(join(repoDir, path), contents);
  git(repoDir, `add ${shellQuote(path)}`);
  git(repoDir, `commit -m ${shellQuote(message)}`);
}

function removeFile(repoDir: string, path: string, message: string): void {
  git(repoDir, `rm ${shellQuote(path)}`);
  git(repoDir, `commit -m ${shellQuote(message)}`);
}

function mergePrBranch(
  repoDir: string,
  branch: string,
  prNumber: number,
  title: string,
): void {
  git(repoDir, `merge --no-ff ${shellQuote(branch)} -m ${shellQuote(`Merge pull request #${prNumber} from test/${branch}`)} -m ${shellQuote(title)}`);
}

function makeRepo(config: Record<string, unknown> = {}): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'cross-pr-revert-cli-'));
  git(repoDir, 'init -b main');
  git(repoDir, 'config user.name "Test User"');
  git(repoDir, 'config user.email "test@example.com"');
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config));
  commitFile(repoDir, 'README.md', 'base\n', 'Initial commit');
  git(repoDir, 'checkout -b auto/integration');

  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

function makeRepoWithoutConfig(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'cross-pr-revert-cli-'));
  git(repoDir, 'init -b main');
  git(repoDir, 'config user.name "Test User"');
  git(repoDir, 'config user.email "test@example.com"');
  commitFile(repoDir, 'README.md', 'base\n', 'Initial commit');

  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

test('runCrossPrRevertCheck blocks unacknowledged cross-PR deletions', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    git(repoDir, 'checkout -b pr-437');
    commitFile(repoDir, 'strategy.txt', 'live\n', 'Restore strategy explorer');
    git(repoDir, 'checkout auto/integration');
    mergePrBranch(repoDir, 'pr-437', 437, 'Restore strategy explorer');
    git(repoDir, 'checkout -b task/remove-strategy auto/integration');
    removeFile(repoDir, 'strategy.txt', 'Remove unrelated diff');

    const result = runCrossPrRevertCheck({
      repoDir,
      acknowledgementText: '',
    });

    assert.equal(result.blocked, true);
    assert.equal(result.unacknowledged.length, 1);
    assert.equal(result.unacknowledged[0].prNumber, 437);
  } finally {
    cleanup();
  }
});

test('runCrossPrRevertCheck allows explicitly acknowledged deletions', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    git(repoDir, 'checkout -b pr-437');
    commitFile(repoDir, 'strategy.txt', 'live\n', 'Restore strategy explorer');
    git(repoDir, 'checkout auto/integration');
    mergePrBranch(repoDir, 'pr-437', 437, 'Restore strategy explorer');
    git(repoDir, 'checkout -b task/remove-strategy auto/integration');
    removeFile(repoDir, 'strategy.txt', 'Intentionally remove strategy');

    const result = runCrossPrRevertCheck({
      repoDir,
      acknowledgementText: 'Intentionally reverts #437',
    });

    assert.equal(result.blocked, false);
    assert.equal(result.acknowledged.length, 1);
    assert.equal(result.unacknowledged.length, 0);
  } finally {
    cleanup();
  }
});

test('runCrossPrRevertCheck reports disabled status when config disables the guard', () => {
  const { repoDir, cleanup } = makeRepo({
    reviewMerge: {
      crossPrRevertCheck: {
        enabled: false,
      },
    },
  });
  try {
    const result = runCrossPrRevertCheck({
      repoDir,
      acknowledgementText: '',
    });

    assert.equal(result.blocked, false);
    assert.equal(result.disabled, true);
  } finally {
    cleanup();
  }
});

test('runCrossPrRevertCheck returns tool error when integration ref is missing', () => {
  const { repoDir, cleanup } = makeRepo();
  const execMock = mock.method(crossPrRevertCheckDeps, 'execShellCommand', (command: string) => {
    if (command.includes('git merge-base')) {
      throw new Error('fatal: Not a valid object name auto/integration');
    }
    throw new Error(`unexpected command: ${command}`);
  });
  const detectMock = mock.method(crossPrRevertCheckDeps, 'detectCrossPrReverts', () => {
    throw new Error('detectCrossPrReverts should not run when integration ref is missing');
  });

  try {
    const result = runCrossPrRevertCheck({
      repoDir,
      acknowledgementText: '',
    });

    assert.equal(result.blocked, false);
    assert.equal(result.reverts.length, 0);
    assert.equal(result.acknowledged.length, 0);
    assert.equal(result.unacknowledged.length, 0);
    assert.ok(result.toolError);
    assert.equal(result.toolError.commandClass, 'git-merge-base');
    assert.equal(result.toolError.ref, 'auto/integration');
    assert.match(result.toolError.command, /git merge-base auto\/integration HEAD/);
    assert.match(result.toolError.stderr, /Not a valid object name/);
  } finally {
    detectMock.mock.restore();
    execMock.mock.restore();
    cleanup();
  }
});

test('runCrossPrRevertCheck bounds tool error stderr', () => {
  const { repoDir, cleanup } = makeRepo();
  const longMessage = `fatal: ${'x'.repeat(3000)}`;
  const execMock = mock.method(crossPrRevertCheckDeps, 'execShellCommand', (command: string) => {
    if (command.includes('git merge-base')) {
      throw new Error(longMessage);
    }
    throw new Error(`unexpected command: ${command}`);
  });
  const detectMock = mock.method(crossPrRevertCheckDeps, 'detectCrossPrReverts', () => {
    throw new Error('detectCrossPrReverts should not run when merge-base fails');
  });

  try {
    const result = runCrossPrRevertCheck({
      repoDir,
      acknowledgementText: '',
    });

    assert.ok(result.toolError);
    assert.equal(result.toolError.commandClass, 'git-merge-base');
    assert.ok(result.toolError.stderr.length < longMessage.length);
    assert.match(result.toolError.stderr, /…\[truncated\]$/);
  } finally {
    detectMock.mock.restore();
    execMock.mock.restore();
    cleanup();
  }
});

test('runCrossPrRevertCheck resolves the default base branch when config is absent', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'cross-pr-revert-no-config-'));
  const detectMock = mock.method(crossPrRevertCheckDeps, 'detectCrossPrReverts', (input) => {
    assert.equal(input.integrationRef, 'main');
    return [];
  });
  const resolveMock = mock.method(crossPrRevertCheckDeps, 'resolveDefaultBaseRef', () => 'main');

  try {
    const result = runCrossPrRevertCheck({
      repoDir,
      baseRef: 'abc123',
      acknowledgementText: '',
    });

    assert.equal(result.blocked, false);
    assert.equal(result.reverts.length, 0);
  } finally {
    resolveMock.mock.restore();
    detectMock.mock.restore();
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('runCrossPrRevertCheck uses explicit integrationRef for config-less repos', () => {
  const { repoDir, cleanup } = makeRepoWithoutConfig();

  try {
    const result = runCrossPrRevertCheck({
      repoDir,
      integrationRef: 'main',
      acknowledgementText: '',
    });

    assert.equal(result.blocked, false);
    assert.equal(result.reverts.length, 0);
    assert.equal(result.unacknowledged.length, 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.equal(message.includes('auto/integration'), false);
    assert.fail(`expected explicit integrationRef to avoid auto/integration fallback, got: ${message}`);
  } finally {
    cleanup();
  }
});

test('runCrossPrRevertCheck prefers configured integration branches over resolver fallback', () => {
  const { repoDir, cleanup } = makeRepo({
    integration: {
      integrationBranch: 'release/integration',
    },
  });
  const detectMock = mock.method(crossPrRevertCheckDeps, 'detectCrossPrReverts', (input) => {
    assert.equal(input.integrationRef, 'release/integration');
    return [];
  });
  const resolveMock = mock.method(crossPrRevertCheckDeps, 'resolveDefaultBaseRef', () => 'main');

  try {
    const result = runCrossPrRevertCheck({
      repoDir,
      baseRef: 'abc123',
      acknowledgementText: '',
    });

    assert.equal(result.blocked, false);
  } finally {
    resolveMock.mock.restore();
    detectMock.mock.restore();
    cleanup();
  }
});

test('runCrossPrRevertCheck skips when an explicit integrationRef is missing', () => {
  const { repoDir, cleanup } = makeRepoWithoutConfig();

  try {
    const result = runCrossPrRevertCheck({
      repoDir,
      integrationRef: 'does-not-exist',
      acknowledgementText: '',
    });

    assert.equal(result.blocked, false);
    assert.equal(result.reverts.length, 0);
    assert.equal(result.acknowledged.length, 0);
    assert.equal(result.unacknowledged.length, 0);
  } finally {
    cleanup();
  }
});

test('runCrossPrRevertCheck honors an explicit baseRef without calling git merge-base', () => {
  const { repoDir, cleanup } = makeRepo();
  const execMock = mock.method(crossPrRevertCheckDeps, 'execShellCommand', (command: string) => {
    if (command.includes('git merge-base')) {
      throw new Error('git merge-base should not run when baseRef is provided');
    }
    return '';
  });
  const detectMock = mock.method(crossPrRevertCheckDeps, 'detectCrossPrReverts', (input) => {
    assert.equal(input.baseRef, 'explicit-base');
    return [];
  });

  try {
    const result = runCrossPrRevertCheck({
      repoDir,
      baseRef: 'explicit-base',
      acknowledgementText: '',
    });

    assert.equal(result.blocked, false);
  } finally {
    detectMock.mock.restore();
    execMock.mock.restore();
    cleanup();
  }
});

test('runCrossPrRevertCheck treats empty integrationRef like no explicit override', () => {
  const { repoDir, cleanup } = makeRepo({
    integration: {
      integrationBranch: 'main',
    },
  });
  const mergeBaseCommands: string[] = [];
  const execMock = mock.method(crossPrRevertCheckDeps, 'execShellCommand', (command: string, options?: { cwd?: string; encoding?: string }) => {
    if (command.includes('git merge-base')) {
      mergeBaseCommands.push(command);
    }
    return execSync(command, {
      cwd: options?.cwd ?? repoDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd();
  });

  try {
    const result = runCrossPrRevertCheck({
      repoDir,
      integrationRef: '',
      acknowledgementText: '',
    });

    assert.equal(result.blocked, false);
    assert.equal(mergeBaseCommands.length > 0, true);
    assert.equal(mergeBaseCommands.some((command) => command.includes("'main'")), true);
  } finally {
    execMock.mock.restore();
    cleanup();
  }
});

for (const message of [
  'fatal: couldn\'t find remote ref auto/integration',
  'error: origin/auto/integration does not exist',
]) {
  test(`runCrossPrRevertCheck treats "${message}" as a missing integration ref`, () => {
    const { repoDir, cleanup } = makeRepo();
    const execMock = mock.method(crossPrRevertCheckDeps, 'execShellCommand', (command: string) => {
      if (command.includes('git merge-base')) {
        throw new Error(message);
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const detectMock = mock.method(crossPrRevertCheckDeps, 'detectCrossPrReverts', () => {
      throw new Error('detectCrossPrReverts should not run when integration ref is missing');
    });

    try {
      const result = runCrossPrRevertCheck({
        repoDir,
        acknowledgementText: '',
      });

      assert.equal(result.blocked, false);
      assert.equal(result.reverts.length, 0);
    } finally {
      detectMock.mock.restore();
      execMock.mock.restore();
      cleanup();
    }
  });
}

test('runCrossPrRevertCheck falls back to recent commit messages when gh metadata is unavailable', () => {
  const { repoDir, cleanup } = makeRepo();
  const execMock = mock.method(crossPrRevertCheckDeps, 'execShellCommand', (command: string, options?: { cwd?: string; encoding?: string }) => {
    if (command.startsWith('gh pr view')) {
      throw new Error('no open pr');
    }
    return execSync(command, {
      cwd: options?.cwd ?? repoDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd();
  });

  try {
    git(repoDir, 'checkout -b pr-437');
    commitFile(repoDir, 'strategy.txt', 'live\n', 'Restore strategy explorer');
    git(repoDir, 'checkout auto/integration');
    mergePrBranch(repoDir, 'pr-437', 437, 'Restore strategy explorer');
    git(repoDir, 'checkout -b task/remove-strategy auto/integration');
    removeFile(repoDir, 'strategy.txt', 'Intentionally reverts #437');

    const result = runCrossPrRevertCheck({
      repoDir,
    });

    assert.equal(result.blocked, false);
    assert.equal(result.acknowledged.length, 1);
    assert.equal(result.unacknowledged.length, 0);
  } finally {
    execMock.mock.restore();
    cleanup();
  }
});

// HOK-3090 incident-2: the operator checkout's local `auto/integration` is
// N commits behind `origin/auto/integration`, and the PR under review is based
// on the origin tip. A guard that used the stale local ref would read the new
// files on origin as "deleted" by the PR. Origin-first resolution must diff
// against `origin/auto/integration` and see no reverts.
test('runCrossPrRevertCheck ignores stale-local base and diffs against origin/<base>', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'cross-pr-revert-stale-local-'));
  try {
    // Bare "origin"
    const originDir = mkdtempSync(join(tmpdir(), 'cross-pr-revert-origin-'));
    execSync(`git init --bare -q -b main ${shellQuote(originDir)}`, { stdio: 'pipe' });

    // Seed the origin with an auto/integration branch and a merged file.
    const seedDir = mkdtempSync(join(tmpdir(), 'cross-pr-revert-seed-'));
    execSync(`git clone -q ${shellQuote(originDir)} ${shellQuote(seedDir)}`, { stdio: 'pipe' });
    git(seedDir, 'config user.name "t"');
    git(seedDir, 'config user.email "t@t"');
    commitFile(seedDir, 'README.md', 'seed\n', 'seed');
    git(seedDir, 'checkout -b auto/integration');
    git(seedDir, 'push -q origin main auto/integration');

    // Clone as operator checkout; check out auto/integration.
    execSync(`git clone -q ${shellQuote(originDir)} ${shellQuote(repoDir)}`, { stdio: 'pipe' });
    git(repoDir, 'config user.name "t"');
    git(repoDir, 'config user.email "t@t"');
    writeFileSync(join(repoDir, '.wavemill-config.json'), '{}');
    git(repoDir, 'fetch -q origin auto/integration:auto/integration');
    git(repoDir, 'checkout auto/integration');

    // Advance origin/auto/integration by 1 commit adding a file. The operator's
    // local auto/integration is now 1 behind.
    const advDir = mkdtempSync(join(tmpdir(), 'cross-pr-revert-adv-'));
    execSync(`git clone -q ${shellQuote(originDir)} ${shellQuote(advDir)}`, { stdio: 'pipe' });
    git(advDir, 'config user.name "t"');
    git(advDir, 'config user.email "t@t"');
    git(advDir, 'checkout auto/integration');
    commitFile(advDir, 'origin-only.txt', 'origin-added\n', 'origin added file');
    git(advDir, 'push -q origin auto/integration');

    // Refresh the operator's remote-tracking ref so origin/auto/integration is
    // current, but leave refs/heads/auto/integration stale.
    git(repoDir, 'fetch -q origin');

    // Cut a task branch from the fresh origin tip. It does NOT delete anything.
    git(repoDir, 'checkout -q -b task/new-work origin/auto/integration');
    commitFile(repoDir, 'unrelated.txt', 'unrelated\n', 'unrelated change');

    const result = runCrossPrRevertCheck({
      repoDir,
      integrationRef: 'auto/integration',
      acknowledgementText: '',
    });

    assert.equal(result.blocked, false, `unexpected block: ${JSON.stringify(result, null, 2)}`);
    assert.equal(result.unacknowledged.length, 0);
    assert.equal(result.reverts.length, 0);
    assert.ok(!result.toolError, `unexpected toolError: ${JSON.stringify(result.toolError)}`);

    rmSync(originDir, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
    rmSync(advDir, { recursive: true, force: true });
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
