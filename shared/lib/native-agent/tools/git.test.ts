import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { validateCodingArtifacts } from '../coding-artifacts.ts';
import { runWavemillLoop } from '../loop.ts';
import { evaluateBeforeToolCallPolicy } from './policies.ts';
import { createToolRegistry } from './registry.ts';
import { toPiAgentTool } from './pi-adapter.ts';
import {
  createGitAddTool,
  createGitCommitTool,
  createGitCommitTools,
  createGitDiffStatTool,
  createGitDiffTool,
  createGitLogTool,
  createGitStatusTool,
  createGitTools,
  gitAfterToolCall,
  gitMutationAfterToolCall,
  gitMutationToolPolicyConfig,
  gitToolPolicyConfig,
  type GitAddDetails,
  type GitCommitDetails,
  type GitDiffDetails,
  type GitDiffStatDetails,
  type GitLogDetails,
  type GitStatusDetails,
} from './git.ts';
import { createIntendedFileTracker } from './intended-files.ts';

const reposToClean = new Set<string>();
const piIdentity = (messages: any[]): any[] => messages;

after(() => {
  for (const repoPath of reposToClean) {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

describe('native-agent git tools', () => {
  it('exposes read-only git inspection descriptors and path policy metadata', () => {
    const registry = createToolRegistry(createGitTools('/repo'));
    const metadata = registry.list();

    assert.deepEqual(
      metadata.map((entry) => entry.name),
      ['git_status', 'git_diff', 'git_diff_stat', 'git_log'],
    );
    assert.deepEqual(gitToolPolicyConfig, {
      pathFieldsByTool: { git_diff: ['path'], git_diff_stat: ['path'], git_log: ['path'] },
    });
    for (const entry of metadata) {
      assert.equal(entry.class, 'read-only');
      assert.deepEqual(entry.allowedPhases, ['planning', 'coding', 'review']);
    }
    assert.deepEqual(metadata[1]!.outputCapPolicy, { strategy: 'truncate', maxBytes: 64 * 1024 });
    assert.deepEqual(metadata[2]!.outputCapPolicy, { strategy: 'none' });
    assert.deepEqual(metadata[3]!.outputCapPolicy, { strategy: 'none' });
  });

  it('returns structured status for a clean repo and does not mutate repository state', async () => {
    const repo = createRepo('git-status-clean-');
    writeFile(repo, 'tracked.txt', 'base\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'initial']);

    const tool = createGitStatusTool(repo);
    const before = repoSnapshot(repo);
    const result = await tool.execute('call-1', {});
    const afterState = repoSnapshot(repo);

    assertRepoUnchanged(before, afterState);
    const details = result.details as GitStatusDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.branch.head, 'main');
      assert.equal(details.isClean, true);
      assert.deepEqual(details.staged, []);
      assert.deepEqual(details.unstaged, []);
      assert.deepEqual(details.untracked, []);
    }
  });

  it('reports staged, unstaged, and untracked files deterministically', async () => {
    const repo = createRepo('git-status-dirty-');
    writeFile(repo, 'tracked.txt', 'base\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'initial']);

    writeFile(repo, 'tracked.txt', 'base\nworktree\n');
    writeFile(repo, 'staged.txt', 'staged\n');
    git(repo, ['add', 'staged.txt']);
    writeFile(repo, 'untracked.txt', 'untracked\n');

    const tool = createGitStatusTool(repo);
    const before = repoSnapshot(repo);
    const result = await tool.execute('call-2', {});
    const afterState = repoSnapshot(repo);

    assertRepoUnchanged(before, afterState);
    const details = result.details as GitStatusDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.isClean, false);
      assert.deepEqual(details.staged.map((entry) => entry.path), ['staged.txt']);
      assert.deepEqual(details.unstaged.map((entry) => entry.path), ['tracked.txt']);
      assert.deepEqual(details.untracked.map((entry) => entry.path), ['untracked.txt']);
    }
  });

  it('returns HEAD-relative diff by default and preserves repository state', async () => {
    const repo = createRepo('git-diff-head-');
    writeFile(repo, 'app.txt', 'base\n');
    git(repo, ['add', 'app.txt']);
    git(repo, ['commit', '-m', 'initial']);

    writeFile(repo, 'app.txt', 'base\nstaged\n');
    git(repo, ['add', 'app.txt']);
    writeFile(repo, 'app.txt', 'base\nstaged\nunstaged\n');

    const tool = createGitDiffTool(repo);
    const before = repoSnapshot(repo);
    const result = await tool.execute('call-3', {});
    const afterState = repoSnapshot(repo);

    assertRepoUnchanged(before, afterState);
    const details = result.details as GitDiffDetails;
    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.base, 'HEAD');
      assert.match(details.diff, /\+staged/);
      assert.match(details.diff, /\+unstaged/);
      assert.equal(details.truncated, false);
      assert.equal(result.content[0]!.text, details.diff);
    }
  });

  it('supports path-scoped diffs inside the worktree', async () => {
    const repo = createRepo('git-diff-path-');
    writeFile(repo, 'src/one.txt', 'one\n');
    writeFile(repo, 'src/two.txt', 'two\n');
    git(repo, ['add', 'src/one.txt', 'src/two.txt']);
    git(repo, ['commit', '-m', 'initial']);

    writeFile(repo, 'src/one.txt', 'one\nchanged\n');
    writeFile(repo, 'src/two.txt', 'two\nchanged\n');

    const tool = createGitDiffTool(repo);
    const result = await tool.execute('call-4', { path: './src/../src/one.txt' });
    const details = result.details as GitDiffDetails;

    assert.equal(details.ok, true);
    if (details.ok) {
      assert.match(details.diff, /src\/one.txt/);
      assert.doesNotMatch(details.diff, /src\/two.txt/);
      assert.equal(details.path, 'src/one.txt');
    }
  });

  it('truncates oversized diff output with byte metadata', async () => {
    const repo = createRepo('git-diff-truncate-');
    writeFile(repo, 'utf8.txt', 'start\n');
    git(repo, ['add', 'utf8.txt']);
    git(repo, ['commit', '-m', 'initial']);

    writeFile(repo, 'utf8.txt', `start\n${'é'.repeat(80)}\n`);

    const tool = createGitDiffTool(repo);
    const result = await tool.execute('call-5', { maxBytes: 64 });
    const details = result.details as GitDiffDetails;

    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.truncated, true);
      assert.equal(details.retainedBytes <= 64, true);
      assert.equal(details.originalBytes > details.retainedBytes, true);
      assert.equal(Buffer.byteLength(details.diff, 'utf8'), details.retainedBytes);
    }
  });

  it('returns empty diff stat and current history for a clean repo', async () => {
    const repo = createRepo('git-clean-inspect-');
    writeFile(repo, 'tracked.txt', 'base\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'initial']);

    const diffStatTool = createGitDiffStatTool(repo);
    const logTool = createGitLogTool(repo);
    const before = repoSnapshot(repo);
    const [diffStatResult, logResult] = await Promise.all([
      diffStatTool.execute('call-6', {}),
      logTool.execute('call-7', {}),
    ]);
    const afterState = repoSnapshot(repo);

    assertRepoUnchanged(before, afterState);

    const diffStat = diffStatResult.details as GitDiffStatDetails;
    assert.equal(diffStat.ok, true);
    if (diffStat.ok) {
      assert.equal(diffStat.base, 'HEAD');
      assert.deepEqual(diffStat.files, []);
      assert.deepEqual(diffStat.totals, { filesChanged: 0, additions: 0, deletions: 0 });
    }

    const log = logResult.details as GitLogDetails;
    assert.equal(log.ok, true);
    if (log.ok) {
      assert.equal(log.maxCount, 20);
      assert.equal(log.truncated, false);
      assert.equal(log.commits.length, 1);
      assert.equal(log.commits[0]!.subject, 'initial');
    }
  });

  it('reports structured diff stat for tracked modifications', async () => {
    const repo = createRepo('git-diff-stat-dirty-');
    writeFile(repo, 'app.txt', 'one\ntwo\nthree\n');
    git(repo, ['add', 'app.txt']);
    git(repo, ['commit', '-m', 'initial']);

    writeFile(repo, 'app.txt', 'one\nchanged\nthree\nfour\n');

    const tool = createGitDiffStatTool(repo);
    const result = await tool.execute('call-8', {});
    const details = result.details as GitDiffStatDetails;

    assert.equal(details.ok, true);
    if (details.ok) {
      assert.deepEqual(details.files, [
        { path: 'app.txt', additions: 2, deletions: 1, binary: false },
      ]);
      assert.deepEqual(details.totals, { filesChanged: 1, additions: 2, deletions: 1 });
    }
  });

  it('supports path-scoped diff stat inside the worktree', async () => {
    const repo = createRepo('git-diff-stat-path-');
    writeFile(repo, 'src/one.txt', 'one\n');
    writeFile(repo, 'src/two.txt', 'two\n');
    git(repo, ['add', 'src/one.txt', 'src/two.txt']);
    git(repo, ['commit', '-m', 'initial']);

    writeFile(repo, 'src/one.txt', 'one\nchanged\n');
    writeFile(repo, 'src/two.txt', 'two\nchanged\n');

    const tool = createGitDiffStatTool(repo);
    const result = await tool.execute('call-9', { path: './src/../src/one.txt' });
    const details = result.details as GitDiffStatDetails;

    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.path, 'src/one.txt');
      assert.deepEqual(details.files, [
        { path: 'src/one.txt', additions: 1, deletions: 0, binary: false },
      ]);
      assert.deepEqual(details.totals, { filesChanged: 1, additions: 1, deletions: 0 });
    }
  });

  it('marks binary files in diff stat output', async () => {
    const repo = createRepo('git-diff-stat-binary-');
    writeBinaryFile(repo, 'blob.bin', Buffer.from([0, 1, 2, 3]));
    git(repo, ['add', 'blob.bin']);
    git(repo, ['commit', '-m', 'initial']);

    writeBinaryFile(repo, 'blob.bin', Buffer.from([3, 2, 1, 0, 4]));

    const tool = createGitDiffStatTool(repo);
    const result = await tool.execute('call-10', {});
    const details = result.details as GitDiffStatDetails;

    assert.equal(details.ok, true);
    if (details.ok) {
      assert.deepEqual(details.files, [
        { path: 'blob.bin', additions: null, deletions: null, binary: true },
      ]);
      assert.deepEqual(details.totals, { filesChanged: 1, additions: 0, deletions: 0 });
    }
  });

  it('returns bounded log output and indicates truncation', async () => {
    const repo = createRepo('git-log-bounded-');
    writeFile(repo, 'history.txt', '0\n');
    git(repo, ['add', 'history.txt']);
    git(repo, ['commit', '-m', 'commit-0']);

    for (let index = 1; index <= 4; index += 1) {
      writeFile(repo, 'history.txt', `${index}\n`);
      git(repo, ['commit', '-am', `commit-${index}`]);
    }

    const tool = createGitLogTool(repo);
    const result = await tool.execute('call-11', { maxCount: 3 });
    const details = result.details as GitLogDetails;

    assert.equal(details.ok, true);
    if (details.ok) {
      assert.equal(details.maxCount, 3);
      assert.equal(details.truncated, true);
      assert.equal(details.commits.length, 3);
      assert.deepEqual(
        details.commits.map((commit) => commit.subject),
        ['commit-4', 'commit-3', 'commit-2'],
      );
    }
  });

  it('rejects invalid git inputs and marks loop tool results as errors', async () => {
    const repo = createRepo('git-invalid-inputs-');
    writeFile(repo, 'tracked.txt', 'base\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'initial']);
    writeFile(repo, 'tracked.txt', 'base\nchanged\n');

    const diffTool = createGitDiffTool(repo);
    const diffStatTool = createGitDiffStatTool(repo);
    const logTool = createGitLogTool(repo);

    const emptyBase = (await diffStatTool.execute('call-12', { base: '   ' })).details as GitDiffStatDetails;
    assert.equal(emptyBase.ok, false);
    if (!emptyBase.ok) {
      assert.equal(emptyBase.error.code, 'invalid_input');
    }

    const dashedBase = (await diffTool.execute('call-13', { base: '--output=x' })).details as GitDiffDetails;
    assert.equal(dashedBase.ok, false);
    if (!dashedBase.ok) {
      assert.equal(dashedBase.error.code, 'invalid_input');
    }

    const fractionalCount = (await logTool.execute('call-14', { maxCount: 1.5 as any })).details as GitLogDetails;
    assert.equal(fractionalCount.ok, false);
    if (!fractionalCount.ok) {
      assert.equal(fractionalCount.error.code, 'invalid_input');
    }

    const zeroCount = (await logTool.execute('call-15', { maxCount: 0 })).details as GitLogDetails;
    assert.equal(zeroCount.ok, false);
    if (!zeroCount.ok) {
      assert.equal(zeroCount.error.code, 'invalid_input');
    }

    const overCapCount = (await logTool.execute('call-16', { maxCount: 101 })).details as GitLogDetails;
    assert.equal(overCapCount.ok, false);
    if (!overCapCount.ok) {
      assert.equal(overCapCount.error.code, 'invalid_input');
    }

    const direct = await diffStatTool.execute('call-17', { base: 'missing-ref' });
    const directDetails = direct.details as GitDiffStatDetails;
    assert.equal(directDetails.ok, false);
    if (!directDetails.ok) {
      assert.equal(directDetails.error.code, 'git_failed');
      assert.match(directDetails.error.message, /missing-ref|bad revision|unknown revision/i);
    }

    const loopResult = await executeViaLoop(repo, toPiAgentTool(diffStatTool), {
      type: 'tool_call',
      id: 'diff-stat-1',
      name: 'git_diff_stat',
      arguments: { base: 'missing-ref' },
    });
    const toolResult = loopResult.messages.find(
      (message: any) => message.role === 'toolResult' && message.toolName === 'git_diff_stat',
    ) as any;
    assert.ok(toolResult);
    assert.equal(toolResult.isError, true);
  });

  it('hardens revision and path inputs against shell-injection-shaped values', async () => {
    const repo = createRepo('git-hardened-inputs-');
    writeFile(repo, 'tracked.txt', 'base\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'initial']);
    writeFile(repo, 'tracked.txt', 'base\nchanged\n');

    const diffTool = createGitDiffTool(repo);
    const diffStatTool = createGitDiffStatTool(repo);
    const logTool = createGitLogTool(repo);

    const invalidBases: Array<{ label: string; base: string }> = [
      { label: 'double-dot range', base: 'main..feature' },
      { label: 'triple-dot range', base: 'main...feature' },
      { label: 'embedded whitespace', base: 'main HEAD' },
      { label: 'shell separator', base: 'main;evil' },
      { label: 'NUL byte', base: 'main x' },
      { label: 'pipe metacharacter', base: 'main|cat' },
      { label: 'subshell metacharacter', base: 'main$(id)' },
    ];
    for (const { label, base } of invalidBases) {
      const details = (await diffStatTool.execute(`call-base-${label}`, { base })).details as GitDiffStatDetails;
      assert.equal(details.ok, false, `expected git_diff_stat to reject ${label}`);
      if (!details.ok) {
        assert.equal(details.error.code, 'invalid_input');
      }
      const diffDetails = (await diffTool.execute(`call-diff-base-${label}`, { base })).details as GitDiffDetails;
      assert.equal(diffDetails.ok, false, `expected git_diff to reject ${label}`);
      if (!diffDetails.ok) {
        assert.equal(diffDetails.error.code, 'invalid_input');
      }
    }

    const headDiff = (await diffTool.execute('call-base-head', { base: 'HEAD' })).details as GitDiffDetails;
    assert.equal(headDiff.ok, true);
    if (headDiff.ok) {
      assert.equal(headDiff.base, 'HEAD');
    }
    const headStat = (await diffStatTool.execute('call-stat-head', { base: 'HEAD' })).details as GitDiffStatDetails;
    assert.equal(headStat.ok, true);
    if (headStat.ok) {
      assert.equal(headStat.base, 'HEAD');
    }

    const nulPath = (await diffStatTool.execute('call-path-nul', { path: 'tracked .txt' })).details as GitDiffStatDetails;
    assert.equal(nulPath.ok, false);
    if (!nulPath.ok) {
      assert.equal(nulPath.error.code, 'invalid_input');
      assert.match(nulPath.error.message, /NUL/);
    }
    const dashPath = (await diffTool.execute('call-path-dash', { path: '--exec=evil' })).details as GitDiffDetails;
    assert.equal(dashPath.ok, false);
    if (!dashPath.ok) {
      assert.equal(dashPath.error.code, 'invalid_input');
      assert.match(dashPath.error.message, /must not start with "-"/);
    }
    const logNulPath = (await logTool.execute('call-log-path-nul', { path: 'tracked .txt' })).details as GitLogDetails;
    assert.equal(logNulPath.ok, false);
    if (!logNulPath.ok) {
      assert.equal(logNulPath.error.code, 'invalid_input');
    }
    const logDashPath = (await logTool.execute('call-log-path-dash', { path: '--all' })).details as GitLogDetails;
    assert.equal(logDashPath.ok, false);
    if (!logDashPath.ok) {
      assert.equal(logDashPath.error.code, 'invalid_input');
    }
  });

  it('returns structured not-a-repo errors', async () => {
    const nonRepo = mkdtempSync(path.join(tmpdir(), 'git-not-repo-'));
    reposToClean.add(nonRepo);

    const result = await createGitStatusTool(nonRepo).execute('call-18', {});
    const details = result.details as GitStatusDetails;

    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error.code, 'not_git_repository');
      assert.match(details.error.message, /not a git repository/i);
    }
  });

  it('blocks out-of-bounds git paths before execution', () => {
    const registry = createToolRegistry(createGitTools('/repo')).list();

    assert.deepEqual(
      evaluateBeforeToolCallPolicy({
        phase: 'coding',
        worktreePath: '/repo',
        registry,
        config: gitToolPolicyConfig,
        toolCall: {
          name: 'git_diff_stat',
          arguments: { path: '../secret.txt' },
        },
      }),
      {
        kind: 'deny',
        reason: 'path_denied',
        message: "path_denied: '../secret.txt' resolves outside the worktree",
      },
    );

    assert.deepEqual(
      evaluateBeforeToolCallPolicy({
        phase: 'coding',
        worktreePath: '/repo',
        registry,
        config: gitToolPolicyConfig,
        toolCall: {
          name: 'git_log',
          arguments: { path: '../secret.txt' },
        },
      }),
      {
        kind: 'deny',
        reason: 'path_denied',
        message: "path_denied: '../secret.txt' resolves outside the worktree",
      },
    );
  });

  it('exposes git mutation descriptors and path policy metadata', () => {
    const tracker = createIntendedFileTracker();
    const registry = createToolRegistry(createGitCommitTools('/repo', { tracker }));
    const metadata = registry.list();

    assert.deepEqual(metadata.map((entry) => entry.name), ['git_add', 'git_commit', 'discard_owned_path']);
    assert.deepEqual(gitMutationToolPolicyConfig, {
      pathFieldsByTool: { git_add: ['paths'], discard_owned_path: ['paths'] },
    });
    for (const entry of metadata) {
      assert.equal(entry.class, 'mutation');
      assert.deepEqual(entry.allowedPhases, ['coding']);
      assert.equal(entry.executionMode, 'sequential');
    }
  });

  it('stages and commits intended files and increments commit count', async () => {
    const repo = createRepo('git-add-commit-happy-');
    writeFile(repo, 'src/app.ts', 'base\n');
    git(repo, ['add', 'src/app.ts']);
    git(repo, ['commit', '-m', 'initial']);

    writeFile(repo, 'src/app.ts', 'base\nchanged\n');
    const tracker = createIntendedFileTracker();
    tracker.record(['./src/app.ts']);

    const addTool = createGitAddTool(repo, { tracker });
    const commitTool = createGitCommitTool(repo, { tracker });

    const addResult = await addTool.execute('call-add-1', { paths: ['./src/../src/app.ts'] });
    const addDetails = addResult.details as GitAddDetails;
    assert.equal(addDetails.ok, true);
    if (addDetails.ok) {
      assert.deepEqual(addDetails.paths, ['src/app.ts']);
    }

    const commitResult = await commitTool.execute('call-commit-1', { message: 'feat: update intended file' });
    const commitDetails = commitResult.details as GitCommitDetails;
    assert.equal(commitDetails.ok, true);
    if (commitDetails.ok) {
      assert.match(commitDetails.oid, /^[0-9a-f]{40}$/);
      assert.equal(commitDetails.subject, 'feat: update intended file');
      assert.deepEqual(commitDetails.files, ['src/app.ts']);
      assert.equal(commitDetails.commitCount, 1);
      assert.equal(git(repo, ['rev-parse', 'HEAD']), commitDetails.oid);
    }

    assert.equal(tracker.commitCount, 1);
    assert.equal(readFileSync(path.join(repo, 'src/app.ts'), 'utf-8'), 'base\nchanged\n');

    const artifactValidation = validateCodingArtifacts({
      type: 'coding',
      filesChanged: 1,
      linesAdded: 1,
      linesRemoved: 0,
      commitCount: tracker.commitCount,
    });
    assert.equal(artifactValidation.ok, true);
  });

  it('rejects staging dirty files that were not recorded as intended', async () => {
    const repo = createRepo('git-add-not-intended-');
    writeFile(repo, 'tracked.txt', 'base\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'initial']);

    writeFile(repo, 'tracked.txt', 'base\nchanged\n');
    const tracker = createIntendedFileTracker();
    const tool = createGitAddTool(repo, { tracker });

    const result = await tool.execute('call-add-2', { paths: ['tracked.txt'] });
    const details = result.details as GitAddDetails;

    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error.code, 'not_intended');
    }
    assert.equal(git(repo, ['diff', '--cached', '--name-only']), '');
  });

  it('rejects staging paths outside the worktree', async () => {
    const repo = createRepo('git-add-out-of-scope-');
    const tracker = createIntendedFileTracker();
    tracker.record(['tracked.txt']);
    const tool = createGitAddTool(repo, { tracker });

    const result = await tool.execute('call-add-3', { paths: ['../elsewhere.txt'] });
    const details = result.details as GitAddDetails;

    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error.code, 'out_of_scope');
    }
  });

  it('rejects empty commits when nothing is staged', async () => {
    const repo = createRepo('git-commit-empty-');
    writeFile(repo, 'tracked.txt', 'base\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'initial']);

    const tracker = createIntendedFileTracker();
    const tool = createGitCommitTool(repo, { tracker });
    const result = await tool.execute('call-commit-2', { message: 'feat: should fail' });
    const details = result.details as GitCommitDetails;

    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error.code, 'empty_commit');
    }
  });

  it('rejects commits when staged files fall outside the intended set', async () => {
    const repo = createRepo('git-commit-staged-out-of-scope-');
    writeFile(repo, 'tracked.txt', 'base\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'initial']);

    writeFile(repo, 'tracked.txt', 'base\nchanged\n');
    git(repo, ['add', 'tracked.txt']);

    const tracker = createIntendedFileTracker();
    const tool = createGitCommitTool(repo, { tracker });
    const result = await tool.execute('call-commit-3', { message: 'feat: blocked' });
    const details = result.details as GitCommitDetails;

    assert.equal(details.ok, false);
    if (!details.ok) {
      assert.equal(details.error.code, 'out_of_scope');
    }
  });

  it('surfaces commit failure diagnostics and marks mutation loop results as errors', async () => {
    const repo = createRepo('git-commit-failure-');
    writeFile(repo, 'tracked.txt', 'base\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'initial']);

    writeFile(repo, 'tracked.txt', 'base\nchanged\n');
    git(repo, ['config', '--unset', 'user.name']);
    git(repo, ['config', '--unset', 'user.email']);

    const tracker = createIntendedFileTracker();
    tracker.record(['tracked.txt']);

    const addTool = createGitAddTool(repo, { tracker });
    const addResult = await addTool.execute('call-add-4', { paths: ['tracked.txt'] });
    assert.equal((addResult.details as GitAddDetails).ok, true);

    const isolatedHome = mkdtempSync(path.join(tmpdir(), 'git-identity-home-'));
    reposToClean.add(isolatedHome);
    const previousEnv = {
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
      EMAIL: process.env.EMAIL,
    };

    process.env.HOME = isolatedHome;
    process.env.XDG_CONFIG_HOME = path.join(isolatedHome, 'xdg');
    process.env.GIT_CONFIG_GLOBAL = path.join(isolatedHome, 'missing-gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_AUTHOR_NAME = '';
    process.env.GIT_AUTHOR_EMAIL = '';
    process.env.GIT_COMMITTER_NAME = '';
    process.env.GIT_COMMITTER_EMAIL = '';
    process.env.EMAIL = '';

    try {
      const commitTool = createGitCommitTool(repo, { tracker });
      const direct = await commitTool.execute('call-commit-4', { message: 'feat: no identity' });
      const directDetails = direct.details as GitCommitDetails;

      assert.equal(directDetails.ok, false);
      if (!directDetails.ok) {
        assert.equal(directDetails.error.code, 'git_failed');
        assert.deepEqual(directDetails.error.args, ['commit', '-m', 'feat: no identity']);
        assert.equal(typeof directDetails.error.exitCode, 'number');
        assert.match(directDetails.error.stderr, /identity|email|name/i);
      }

      const loopResult = await executeViaLoop(
        repo,
        toPiAgentTool(commitTool),
        {
          type: 'tool_call',
          id: 'git-commit-1',
          name: 'git_commit',
          arguments: { message: 'feat: no identity' },
        },
        createToolRegistry(createGitCommitTools(repo, { tracker })).list(),
        gitMutationToolPolicyConfig,
        gitMutationAfterToolCall,
      );
      const toolResult = loopResult.messages.find(
        (message: any) => message.role === 'toolResult' && message.toolName === 'git_commit',
      ) as any;
      assert.ok(toolResult);
      assert.equal(toolResult.isError, true);
    } finally {
      if (previousEnv.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = previousEnv.HOME;
      if (previousEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousEnv.XDG_CONFIG_HOME;
      if (previousEnv.GIT_CONFIG_GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousEnv.GIT_CONFIG_GLOBAL;
      if (previousEnv.GIT_CONFIG_NOSYSTEM === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = previousEnv.GIT_CONFIG_NOSYSTEM;
      if (previousEnv.GIT_AUTHOR_NAME === undefined) delete process.env.GIT_AUTHOR_NAME;
      else process.env.GIT_AUTHOR_NAME = previousEnv.GIT_AUTHOR_NAME;
      if (previousEnv.GIT_AUTHOR_EMAIL === undefined) delete process.env.GIT_AUTHOR_EMAIL;
      else process.env.GIT_AUTHOR_EMAIL = previousEnv.GIT_AUTHOR_EMAIL;
      if (previousEnv.GIT_COMMITTER_NAME === undefined) delete process.env.GIT_COMMITTER_NAME;
      else process.env.GIT_COMMITTER_NAME = previousEnv.GIT_COMMITTER_NAME;
      if (previousEnv.GIT_COMMITTER_EMAIL === undefined) delete process.env.GIT_COMMITTER_EMAIL;
      else process.env.GIT_COMMITTER_EMAIL = previousEnv.GIT_COMMITTER_EMAIL;
      if (previousEnv.EMAIL === undefined) delete process.env.EMAIL;
      else process.env.EMAIL = previousEnv.EMAIL;
    }
  });
});

function createRepo(prefix: string): string {
  const repo = mkdtempSync(path.join(tmpdir(), prefix));
  reposToClean.add(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Test User']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  return repo;
}

function writeFile(repo: string, relativePath: string, contents: string): void {
  const filePath = path.join(repo, relativePath);
  const parent = path.dirname(filePath);
  execFileSync('mkdir', ['-p', parent]);
  writeFileSync(filePath, contents);
}

function writeBinaryFile(repo: string, relativePath: string, contents: Buffer): void {
  const filePath = path.join(repo, relativePath);
  const parent = path.dirname(filePath);
  execFileSync('mkdir', ['-p', parent]);
  writeFileSync(filePath, contents);
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8',
  }).trimEnd();
}

function repoSnapshot(repo: string): { head: string; status: string } {
  return {
    head: git(repo, ['rev-parse', 'HEAD']),
    status: git(repo, ['status', '--porcelain=v2', '--branch', '-z']),
  };
}

function assertRepoUnchanged(
  before: { head: string; status: string },
  afterState: { head: string; status: string },
): void {
  assert.deepEqual(afterState, before);
}

async function executeViaLoop(
  repo: string,
  tool: any,
  toolCall: { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> },
  registry = createToolRegistry(createGitTools(repo)).list(),
  config = gitToolPolicyConfig,
  afterToolCall = gitAfterToolCall,
) {
  const context = {
    systemPrompt: 'You are a test agent.',
    messages: [{ role: 'user', content: 'Inspect git.', timestamp: 0 }],
    tools: [tool],
  } as any;

  const { registerScriptedPiProvider } = await import('../provider.ts');
  const api = `git-tools-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  registerScriptedPiProvider({
    api,
    turns: [
      { content: [toolCall], stopReason: 'tool_calls' },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'stop' },
    ],
  });

  return await runWavemillLoop({
    model: { id: 'test-model', api, provider: 'test-provider' },
    context,
    convertToLlm: piIdentity,
    afterToolCall,
    toolPolicy: {
      phase: 'coding',
      worktreePath: repo,
      registry,
      config,
    },
  });
}
