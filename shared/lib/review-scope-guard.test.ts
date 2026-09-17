import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  REVIEW_SCOPE_GUARD_COMMITTED_REMEDY_MESSAGE,
  REVIEW_SCOPE_GUARD_NO_COMMIT_MESSAGE,
  REVIEW_SCOPE_GUARD_UNVERIFIED_MESSAGE,
  ensureReviewScopeBaseline,
  readBaseline,
  validateReviewScope,
} from './review-scope-guard.ts';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function git(repoDir: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitFile(repoDir: string, path: string, contents: string, message: string): string {
  const absPath = join(repoDir, path);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, contents, 'utf-8');
  git(repoDir, `add ${shellQuote(path)}`);
  git(repoDir, `commit -m ${shellQuote(message)}`);
  return git(repoDir, 'rev-parse HEAD');
}

function makeRepo(): { repoDir: string; featureDir: string; baseCommit: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'review-scope-guard-'));
  git(repoDir, 'init -b auto/integration');
  git(repoDir, 'config user.name "Test User"');
  git(repoDir, 'config user.email "test@example.com"');
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    reviewMerge: { crossPrRevertCheck: { enabled: false } },
  }));
  const baseCommit = commitFile(repoDir, 'README.md', 'base\n', 'base');
  git(repoDir, 'checkout -b task/scope-guard');
  const featureDir = join(repoDir, 'features', 'scope-guard');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'selected-task.json'), JSON.stringify({
    taskId: 'HOK-1',
    featureName: 'scope-guard',
    reviewBaseCommit: baseCommit,
  }));
  writeFileSync(join(featureDir, 'task-packet.md'), `# Task

## Files to Modify

- \`src/app.ts\`
- \`src/app.test.ts\`
`);
  return {
    repoDir,
    featureDir,
    baseCommit,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

/**
 * A plain worktree: no features/ directory, no task packet, no baseline —
 * only git. `.wavemill-config.json` is committed on the integration branch so
 * it is neither untracked noise nor part of the task diff.
 */
function makeGitOnlyRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'review-scope-guard-git-'));
  git(repoDir, 'init -b auto/integration');
  git(repoDir, 'config user.name "Test User"');
  git(repoDir, 'config user.email "test@example.com"');
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    reviewMerge: { crossPrRevertCheck: { enabled: false } },
  }));
  git(repoDir, 'add .wavemill-config.json');
  commitFile(repoDir, 'README.md', 'base\n', 'base');
  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

function stageFile(repoDir: string, path: string, contents: string): void {
  const absPath = join(repoDir, path);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, contents, 'utf-8');
  git(repoDir, `add ${shellQuote(path)}`);
}

test('validateReviewScope allows files in the original coding baseline', () => {
  const { repoDir, featureDir, baseCommit, cleanup } = makeRepo();
  try {
    commitFile(repoDir, 'src/app.ts', 'export const value = 1;\n', 'coding');

    const result = validateReviewScope({
      repoDir,
      featureDir,
      sinceCommit: baseCommit,
      writeBaseline: true,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.baselinePaths, ['src/app.ts']);
  } finally {
    cleanup();
  }
});

test('validateReviewScope blocks later committed files outside baseline and declared scope', () => {
  const { repoDir, featureDir, baseCommit, cleanup } = makeRepo();
  try {
    commitFile(repoDir, 'src/app.ts', 'export const value = 1;\n', 'coding');
    validateReviewScope({ repoDir, featureDir, sinceCommit: baseCommit, writeBaseline: true });
    commitFile(repoDir, 'shared/lib/unrelated.ts', 'stale\n', 'bad review fix');

    const result = validateReviewScope({
      repoDir,
      featureDir,
      sinceCommit: baseCommit,
      writeBaseline: true,
    });

    assert.equal(result.ok, false);
    assert(result.findings.some((finding) => finding.path === 'shared/lib/unrelated.ts'));
  } finally {
    cleanup();
  }
});

test('validateReviewScope includes staged and working-tree changes before commit', () => {
  const { repoDir, featureDir, baseCommit, cleanup } = makeRepo();
  try {
    commitFile(repoDir, 'src/app.ts', 'export const value = 1;\n', 'coding');
    validateReviewScope({ repoDir, featureDir, sinceCommit: baseCommit, writeBaseline: true });
    mkdirSync(join(repoDir, 'shared/lib'), { recursive: true });
    writeFileSync(join(repoDir, 'shared/lib/unrelated.ts'), 'stale\n', 'utf-8');

    const result = validateReviewScope({
      repoDir,
      featureDir,
      sinceCommit: baseCommit,
      includeWorkingTree: true,
    });

    assert.equal(result.ok, false);
    assert(result.findings.some((finding) => finding.path === 'shared/lib/unrelated.ts'));
  } finally {
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────
// Git-derived scope (HOK-2887): no featureDir, no sinceCommit
// ────────────────────────────────────────────────────────────────

test('validateReviewScope evaluates git-derived scope with no featureDir and no sinceCommit', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b task/plain-scope');
    commitFile(repoDir, 'tools/observer.ts', 'export const a = 1;\n', 'task work');
    stageFile(repoDir, 'tools/observer.ts', 'export const a = 2;\n');

    const result = validateReviewScope({ repoDir, includeWorkingTree: true });

    assert.equal(result.status, 'pass');
    assert.equal(result.ok, true);
    assert.equal(result.featureDir, null);
    assert.deepEqual(result.taskPaths, ['tools/observer.ts']);
    assert.deepEqual(result.stagedPaths, ['tools/observer.ts']);
    assert.match(result.baselineSource, /^git merge-base auto\/integration \([0-9a-f]+\)$/);
  } finally {
    cleanup();
  }
});

test('validateReviewScope blocks stale staged overwrites of integration-only files before any commit', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    // Replay of 17d17fb5 (PR #1243): the task never touched workflow-router.ts;
    // it landed on auto/integration and was merged in. Staging a stale
    // overwrite must be refused while it is still only in the index.
    git(repoDir, 'checkout -b task/observer-work');
    commitFile(repoDir, 'tools/observer.ts', 'observer fix\n', 'Fix observer task file');

    git(repoDir, 'checkout auto/integration');
    commitFile(repoDir, 'shared/lib/workflow-router.ts', 'queue watchdog fix\n', 'Fix queue watchdog');

    git(repoDir, 'checkout task/observer-work');
    git(repoDir, 'merge auto/integration --no-edit');
    const headBefore = git(repoDir, 'rev-parse HEAD');
    stageFile(repoDir, 'shared/lib/workflow-router.ts', 'stale pre-watchdog contents\n');

    const result = validateReviewScope({ repoDir, includeWorkingTree: true });

    assert.equal(result.status, 'fail');
    assert.equal(result.ok, false);
    assert.equal(result.message, REVIEW_SCOPE_GUARD_NO_COMMIT_MESSAGE);
    assert.deepEqual(result.taskPaths, ['tools/observer.ts']);
    assert.deepEqual(result.outOfScopePaths, ['shared/lib/workflow-router.ts']);
    assert(result.findings.some((finding) =>
      finding.severity === 'blocker' && finding.path === 'shared/lib/workflow-router.ts'));
    // The violation was caught in the index — no commit was created.
    assert.equal(git(repoDir, 'rev-parse HEAD'), headBefore);

    // Unstage + revert the out-of-scope path, stage a task-scoped fix → pass.
    git(repoDir, 'reset shared/lib/workflow-router.ts');
    git(repoDir, 'checkout -- shared/lib/workflow-router.ts');
    stageFile(repoDir, 'tools/observer.ts', 'observer fix\nreview follow-up\n');

    const validResult = validateReviewScope({ repoDir, includeWorkingTree: true });
    assert.equal(validResult.status, 'pass');
    assert.deepEqual(validResult.stagedPaths, ['tools/observer.ts']);
  } finally {
    cleanup();
  }
});

test('validateReviewScope allows test and registration companions for scoped source files', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    commitFile(repoDir, 'tests/run-unit-tests.sh', '#!/bin/bash\n# runner\n', 'test runner');
    git(repoDir, 'checkout -b task/companions');
    commitFile(repoDir, 'shared/lib/foo.ts', 'export const foo = 1;\n', 'task work');
    stageFile(repoDir, 'shared/lib/foo.test.ts', 'import "./foo.ts";\n');
    stageFile(repoDir, 'tests/run-unit-tests.sh', '#!/bin/bash\n# runner\n# shared/lib/foo.test.ts\n');

    const result = validateReviewScope({ repoDir, includeWorkingTree: true });

    assert.equal(result.status, 'pass');
    assert.deepEqual(result.allowedCompanionPaths, [
      'shared/lib/foo.test.ts',
      'tests/run-unit-tests.sh',
    ]);
  } finally {
    cleanup();
  }
});

test('validateReviewScope rejects test and registration companions when the source is not in scope', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    commitFile(repoDir, 'tests/run-unit-tests.sh', '#!/bin/bash\n# runner\n', 'test runner');
    git(repoDir, 'checkout -b task/no-companions');
    commitFile(repoDir, 'tools/observer.ts', 'export const a = 1;\n', 'task work');
    stageFile(repoDir, 'shared/lib/bar.test.ts', 'import "./bar.ts";\n');
    stageFile(repoDir, 'tests/run-unit-tests.sh', '#!/bin/bash\n# runner\n# shared/lib/bar.test.ts\n');

    const result = validateReviewScope({ repoDir, includeWorkingTree: true });

    assert.equal(result.status, 'fail');
    assert.deepEqual(result.outOfScopePaths, [
      'shared/lib/bar.test.ts',
      'tests/run-unit-tests.sh',
    ]);
  } finally {
    cleanup();
  }
});

test('validateReviewScope rejects new unrelated staged files', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b task/unrelated');
    commitFile(repoDir, 'tools/observer.ts', 'export const a = 1;\n', 'task work');
    stageFile(repoDir, 'tools/unrelated.ts', 'export const b = 2;\n');

    const result = validateReviewScope({ repoDir, includeWorkingTree: true });

    assert.equal(result.status, 'fail');
    assert.deepEqual(result.outOfScopePaths, ['tools/unrelated.ts']);
  } finally {
    cleanup();
  }
});

test('validateReviewScope returns status error (never a pass) when git fails', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b task/git-failure');
    const failingRunner = (cmd: string): string => {
      if (cmd.includes('merge-base')) {
        throw new Error('fatal: Not a valid object name auto/integration');
      }
      return '';
    };

    const result = validateReviewScope({ repoDir, shellRunner: failingRunner });

    assert.equal(result.status, 'error');
    assert.equal(result.ok, false);
    assert.equal(result.message, REVIEW_SCOPE_GUARD_UNVERIFIED_MESSAGE);
    assert.equal(result.toolError?.commandClass, 'git-merge-base');
    assert.match(result.toolError?.stderr ?? '', /Not a valid object name/);
    assert.deepEqual(result.findings, []);
  } finally {
    cleanup();
  }
});

test('validateReviewScope fails closed on ambiguous staged paths', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'review-scope-guard-mock-'));
  try {
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
      reviewMerge: { crossPrRevertCheck: { enabled: false } },
    }));
    const mockRunner = (cmd: string): string => {
      if (cmd.includes('merge-base')) {
        return 'abc123\n';
      }
      if (cmd.includes('--cached --name-only -z')) {
        return 'tools/../observer.ts\0';
      }
      if (cmd.includes('--name-only -z')) {
        return 'tools/observer.ts\0';
      }
      if (cmd.includes('rev-parse --abbrev-ref')) {
        return 'main\n';
      }
      return '';
    };

    const result = validateReviewScope({ repoDir, shellRunner: mockRunner });

    assert.equal(result.status, 'error');
    assert.equal(result.toolError?.commandClass, 'git-path-normalization');
    assert.match(result.toolError?.stderr ?? '', /Ambiguous staged index path/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('validateReviewScope still admits a packet-declared new file via declared scope', () => {
  const { repoDir, featureDir, cleanup } = makeRepo();
  try {
    // Commit the feature-dir artifacts and config so they are task paths, then
    // stage a brand-new file that only the task packet declares.
    git(repoDir, 'add .wavemill-config.json features');
    git(repoDir, 'commit -m "feature artifacts"');
    stageFile(repoDir, 'src/app.ts', 'export const value = 1;\n');

    const result = validateReviewScope({
      repoDir,
      featureDir,
      includeWorkingTree: true,
      writeBaseline: false,
    });

    assert.equal(result.status, 'pass');
    assert(result.declaredScope.includes('src/app.ts'));
  } finally {
    cleanup();
  }
});

test('validateReviewScope ignores reverts that live in the integration branch history itself', () => {
  // The cross-PR revert detector flags any branch whose HEAD matches the
  // pre-PR content of a recently merged PR — including branches that are
  // simply up to date with an integration branch that itself reverted the
  // PR. The guard must not block commits for reverts this branch did not
  // introduce.
  const repoDir = mkdtempSync(join(tmpdir(), 'review-scope-guard-revert-'));
  try {
    git(repoDir, 'init -b auto/integration');
    git(repoDir, 'config user.name "Test User"');
    git(repoDir, 'config user.email "test@example.com"');
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
      reviewMerge: { crossPrRevertCheck: { enabled: true } },
    }));
    git(repoDir, 'add .wavemill-config.json');
    commitFile(repoDir, 'lib/common.sh', 'original\n', 'base');

    // A PR merges into integration...
    git(repoDir, 'checkout -b fix/liveness');
    commitFile(repoDir, 'lib/common.sh', 'liveness fix\n', 'liveness fix');
    git(repoDir, 'checkout auto/integration');
    git(repoDir, 'merge --no-ff fix/liveness -m "Merge pull request #7 from test/fix-liveness"');
    // ...and integration itself later reverts it.
    commitFile(repoDir, 'lib/common.sh', 'original\n', 'revert: drop liveness fix');

    // A task branch off the current tip stages purely in-scope work.
    git(repoDir, 'checkout -b task/up-to-date');
    commitFile(repoDir, 'tools/observer.ts', 'export const a = 1;\n', 'task work');
    stageFile(repoDir, 'tools/observer.ts', 'export const a = 2;\n');

    const result = validateReviewScope({ repoDir, includeWorkingTree: true });

    assert.equal(result.status, 'pass');
    assert.deepEqual(result.crossPrReverts, []);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────
// HOK-2913: missing baseline, remediation wording, PR lookup, baseline writer
// ────────────────────────────────────────────────────────────────

/** Delegate real commands to git while intercepting gh invocations. */
function makeGhInterceptingRunner(behavior: 'no-pr' | 'found'): (cmd: string, opts?: { encoding?: string; cwd?: string }) => string {
  return (cmd, opts) => {
    if (cmd.startsWith('gh ')) {
      if (behavior === 'found') {
        return JSON.stringify({ number: 42, title: 'A PR', body: 'body text' });
      }
      throw new Error('no pull requests found for branch "task/scope-guard"');
    }
    return execSync(cmd, { ...opts, encoding: 'utf-8', shell: '/bin/bash' }) as string;
  };
}

test('validateReviewScope passes with no baseline artifact and a clean index (committed task files are the scope)', () => {
  // REQ-F1: the branch's own committed deliverable must never be reported as
  // out-of-scope merely because the baseline artifact is absent.
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b task/deliverable');
    commitFile(repoDir, 'shared/lib/new-checker.ts', 'export const c = 1;\n', 'Add checker');
    commitFile(repoDir, 'package.json', '{"name":"x"}\n', 'Add deps');

    const result = validateReviewScope({ repoDir, includeWorkingTree: true });

    assert.equal(result.status, 'pass');
    assert.equal(result.baselineIsArtifact, false);
    assert.deepEqual(result.outOfScopePaths, []);
    assert.deepEqual(result.taskPaths.sort(), ['package.json', 'shared/lib/new-checker.ts']);
  } finally {
    cleanup();
  }
});

test('validateReviewScope gives committed-history violations a committed remedy, never "unstage"', () => {
  // REQ-F3: with a clean index, telling the operator to unstage is an
  // impossible instruction (HOK-2913).
  const { repoDir, featureDir, baseCommit, cleanup } = makeRepo();
  try {
    commitFile(repoDir, 'src/app.ts', 'export const value = 1;\n', 'coding');
    validateReviewScope({ repoDir, featureDir, sinceCommit: baseCommit, writeBaseline: true });
    commitFile(repoDir, 'shared/lib/unrelated.ts', 'stale\n', 'bad review fix');

    const result = validateReviewScope({
      repoDir,
      featureDir,
      sinceCommit: baseCommit,
      writeBaseline: true,
    });

    assert.equal(result.status, 'fail');
    const finding = result.findings.find((entry) => entry.path === 'shared/lib/unrelated.ts');
    assert.equal(finding?.observedIn, 'committed');
    assert.equal(result.message, REVIEW_SCOPE_GUARD_COMMITTED_REMEDY_MESSAGE);
    assert.ok(!result.message.includes('unstaged'), 'committed-only failures must not instruct unstaging');
  } finally {
    cleanup();
  }
});

test('validateReviewScope marks staged violations as staged and keeps the unstage remedy', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b task/staged-remedy');
    commitFile(repoDir, 'tools/observer.ts', 'export const a = 1;\n', 'task work');
    stageFile(repoDir, 'tools/unrelated.ts', 'export const b = 2;\n');

    const result = validateReviewScope({ repoDir, includeWorkingTree: true });

    assert.equal(result.status, 'fail');
    const finding = result.findings.find((entry) => entry.path === 'tools/unrelated.ts');
    assert.equal(finding?.observedIn, 'staged');
    assert.equal(result.message, REVIEW_SCOPE_GUARD_NO_COMMIT_MESSAGE);
  } finally {
    cleanup();
  }
});

test('validateReviewScope reports prLookup none as a distinct non-blocking outcome', () => {
  // REQ-F5: "no PR found" must be classified, not folded into the blocking
  // path or leaked as noise.
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b task/scope-guard');
    commitFile(repoDir, 'tools/observer.ts', 'export const a = 1;\n', 'task work');

    const result = validateReviewScope({
      repoDir,
      includeWorkingTree: true,
      shellRunner: makeGhInterceptingRunner('no-pr'),
    });

    assert.equal(result.status, 'pass');
    assert.equal(result.prLookup, 'none');
    assert.equal(result.prNumber, null);
  } finally {
    cleanup();
  }
});

test('validateReviewScope reports prLookup found with the PR number', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b task/scope-guard-pr');
    commitFile(repoDir, 'tools/observer.ts', 'export const a = 1;\n', 'task work');

    const result = validateReviewScope({
      repoDir,
      includeWorkingTree: true,
      shellRunner: makeGhInterceptingRunner('found'),
    });

    assert.equal(result.status, 'pass');
    assert.equal(result.prLookup, 'found');
    assert.equal(result.prNumber, 42);
  } finally {
    cleanup();
  }
});

test('ensureReviewScopeBaseline creates the artifact from merge-base and never regenerates it', () => {
  // REQ-F2: the coding→review handoff materializes the baseline; later calls
  // (e.g. review relaunches after review-fix commits) keep the original.
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b task/baseline-writer');
    commitFile(repoDir, 'shared/lib/new-checker.ts', 'export const c = 1;\n', 'Add checker');
    const featureDir = join(repoDir, 'features', 'baseline-writer');
    mkdirSync(featureDir, { recursive: true });

    const first = ensureReviewScopeBaseline({ repoDir, featureDir });
    assert.equal(first.created, true);
    assert.deepEqual(first.baseline.paths, ['shared/lib/new-checker.ts']);
    assert.ok(existsSync(first.baselinePath));

    // A later (review-fix) commit must not widen the recorded scope.
    commitFile(repoDir, 'tools/review-fix.ts', 'export const r = 1;\n', 'review fix');
    const second = ensureReviewScopeBaseline({ repoDir, featureDir });
    assert.equal(second.created, false);
    assert.deepEqual(second.baseline.paths, ['shared/lib/new-checker.ts']);

    const onDisk = JSON.parse(readFileSync(first.baselinePath, 'utf-8')) as { paths: string[] };
    assert.deepEqual(onDisk.paths, ['shared/lib/new-checker.ts']);
  } finally {
    cleanup();
  }
});

test('ensureReviewScopeBaseline records launch-base provenance for an explicit launch base', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b task/launch-base');
    const launchBase = git(repoDir, 'rev-parse HEAD');
    commitFile(repoDir, 'shared/lib/new-checker.ts', 'export const c = 1;\n', 'Add checker');
    const featureDir = join(repoDir, 'features', 'launch-base');
    mkdirSync(featureDir, { recursive: true });

    const result = ensureReviewScopeBaseline({
      repoDir,
      featureDir,
      sinceCommit: launchBase,
      sinceCommitSource: 'launch-base',
    });

    assert.equal(result.baseline.sinceCommit, launchBase);
    assert.equal(result.baseline.provenance, 'launch-base');
    assert.equal(result.baseline.baseRef, launchBase);
    assert.deepEqual(result.baseline.paths, ['shared/lib/new-checker.ts']);
  } finally {
    cleanup();
  }
});

test('ensureReviewScopeBaseline fails closed when launch base does not resolve', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b task/missing-launch-base');
    commitFile(repoDir, 'shared/lib/new-checker.ts', 'export const c = 1;\n', 'Add checker');
    const featureDir = join(repoDir, 'features', 'missing-launch-base');
    mkdirSync(featureDir, { recursive: true });

    assert.throws(
      () => ensureReviewScopeBaseline({
        repoDir,
        featureDir,
        sinceCommit: 'deadbee',
        sinceCommitSource: 'launch-base',
      }),
      /recorded launch base deadbee could not be resolved.*refusing to widen scope/,
    );
  } finally {
    cleanup();
  }
});

test('ensureReviewScopeBaseline fails closed when launch base is not an ancestor of head', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b unrelated-base');
    const unrelatedBase = commitFile(repoDir, 'side.txt', 'side\n', 'side');
    git(repoDir, 'checkout auto/integration');
    git(repoDir, 'checkout -b task/non-ancestor-launch-base');
    commitFile(repoDir, 'shared/lib/new-checker.ts', 'export const c = 1;\n', 'Add checker');
    const featureDir = join(repoDir, 'features', 'non-ancestor-launch-base');
    mkdirSync(featureDir, { recursive: true });

    assert.throws(
      () => ensureReviewScopeBaseline({
        repoDir,
        featureDir,
        sinceCommit: unrelatedBase,
        sinceCommitSource: 'launch-base',
      }),
      /recorded launch base [0-9a-f]+ is not an ancestor of HEAD.*refusing to widen scope/,
    );
  } finally {
    cleanup();
  }
});

test('ensureReviewScopeBaseline prefers origin integration when local integration is stale', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    const staleLocalIntegration = git(repoDir, 'rev-parse auto/integration');
    commitFile(repoDir, 'shared/lib/inherited.ts', 'inherited\n', 'integration work');
    const launchBase = git(repoDir, 'rev-parse HEAD');
    git(repoDir, `update-ref refs/remotes/origin/auto/integration ${launchBase}`);
    git(repoDir, `checkout -b task/stale-local ${launchBase}`);
    git(repoDir, `update-ref refs/heads/auto/integration ${staleLocalIntegration}`);
    commitFile(repoDir, 'shared/lib/task-owned.ts', 'task\n', 'task work');
    const featureDir = join(repoDir, 'features', 'stale-local');
    mkdirSync(featureDir, { recursive: true });

    const result = ensureReviewScopeBaseline({ repoDir, featureDir });

    assert.equal(result.baseline.provenance, 'remote-merge-base');
    assert.equal(result.baseline.baseRef, 'origin/auto/integration');
    assert.equal(result.baseline.sinceCommit, launchBase);
    assert.deepEqual(result.baseline.paths, ['shared/lib/task-owned.ts']);
  } finally {
    cleanup();
  }
});

test('readBaseline accepts old and new artifact shapes', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'review-scope-baseline-shape-'));
  try {
    const oldPath = join(repoDir, 'old.json');
    writeFileSync(oldPath, JSON.stringify({
      version: 1,
      createdAt: '',
      source: 'legacy',
      sinceCommit: 'abc1234',
      headRef: 'HEAD',
      paths: ['b.ts', 'a.ts'],
    }));
    const oldBaseline = readBaseline(oldPath);
    assert.deepEqual(oldBaseline?.paths, ['a.ts', 'b.ts']);
    assert.equal(oldBaseline?.provenance, undefined);

    const newPath = join(repoDir, 'new.json');
    writeFileSync(newPath, JSON.stringify({
      version: 1,
      createdAt: '',
      source: 'new',
      sinceCommit: 'def5678',
      headRef: 'HEAD',
      paths: ['a.ts'],
      provenance: 'launch-base',
      baseRef: 'def5678',
    }));
    const newBaseline = readBaseline(newPath);
    assert.equal(newBaseline?.provenance, 'launch-base');
    assert.equal(newBaseline?.baseRef, 'def5678');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('write-review-scope-baseline CLI materializes the artifact for the mill handoff', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b task/cli-baseline');
    commitFile(repoDir, 'shared/lib/new-checker.ts', 'export const c = 1;\n', 'Add checker');
    const featureDir = join(repoDir, 'features', 'cli-baseline');
    mkdirSync(featureDir, { recursive: true });

    const result = spawnSync(
      'npx',
      [
        'tsx',
        join(process.cwd(), 'tools', 'write-review-scope-baseline.ts'),
        '--repo-dir', repoDir,
        '--feature-dir', featureDir,
      ],
      { encoding: 'utf-8' },
    );

    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stdout}\n${result.stderr}`);
    assert.ok(existsSync(join(featureDir, '.review-scope-baseline.json')));
    assert.match(result.stdout, /Provenance: /);
  } finally {
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────
// CLI exit contract: 0 pass / 1 policy violation / 2 tool failure
// ────────────────────────────────────────────────────────────────

const CLI_TOOL = join(process.cwd(), 'tools', 'check-review-scope.ts');

function runCli(repoDir: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('npx', ['tsx', CLI_TOOL, '--repo-dir', repoDir], { encoding: 'utf-8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('check-review-scope CLI exits 0 when staged changes are in git-derived scope', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b task/cli-pass');
    commitFile(repoDir, 'tools/observer.ts', 'export const a = 1;\n', 'task work');
    stageFile(repoDir, 'tools/observer.ts', 'export const a = 2;\n');

    const { status, stdout } = runCli(repoDir);

    assert.equal(status, 0, `expected exit 0, got ${status}: ${stdout}`);
    assert.match(stdout, /Review scope guard passed/);
  } finally {
    cleanup();
  }
});

test('check-review-scope CLI exits 1 and lists paths on a policy violation', () => {
  const { repoDir, cleanup } = makeGitOnlyRepo();
  try {
    git(repoDir, 'checkout -b task/cli-fail');
    commitFile(repoDir, 'tools/observer.ts', 'export const a = 1;\n', 'task work');
    stageFile(repoDir, 'tools/unrelated.ts', 'export const b = 2;\n');

    const { status, stdout } = runCli(repoDir);

    assert.equal(status, 1, `expected exit 1, got ${status}: ${stdout}`);
    assert.match(stdout, /tools\/unrelated\.ts/);
    assert.match(stdout, /No review commit may be created/);
  } finally {
    cleanup();
  }
});

test('check-review-scope CLI exits 2 and reports unverified on a git failure', () => {
  // A config file explicitly implies the integration branch, but the branch
  // does not exist locally: merge-base fails, which must be a tool error —
  // never a pass and never a policy violation.
  const repoDir = mkdtempSync(join(tmpdir(), 'review-scope-guard-broken-'));
  try {
    git(repoDir, 'init -b main');
    git(repoDir, 'config user.name "Test User"');
    git(repoDir, 'config user.email "test@example.com"');
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
      reviewMerge: { crossPrRevertCheck: { enabled: false } },
    }));
    commitFile(repoDir, 'README.md', 'base\n', 'base');

    const { status, stdout } = runCli(repoDir);

    assert.equal(status, 2, `expected exit 2, got ${status}: ${stdout}`);
    assert.match(stdout, /could not verify/);
    assert.match(stdout, /unverified/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
