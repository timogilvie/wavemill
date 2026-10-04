import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  getBranchOwnChanges,
  parseNameStatusOutput,
  resolveBranchDiffBase,
} from './git-branch-changes.ts';

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

function commitFile(repoDir: string, path: string, contents: string, message: string): string {
  writeFileSync(join(repoDir, path), contents);
  git(repoDir, `add ${shellQuote(path)}`);
  git(repoDir, `commit -m ${shellQuote(message)}`);
  return git(repoDir, 'rev-parse HEAD');
}

function removeFile(repoDir: string, path: string, message: string): string {
  git(repoDir, `rm ${shellQuote(path)}`);
  git(repoDir, `commit -m ${shellQuote(message)}`);
  return git(repoDir, 'rev-parse HEAD');
}

function makeRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'git-branch-changes-'));
  git(repoDir, 'init -b main');
  git(repoDir, 'config user.name "Test User"');
  git(repoDir, 'config user.email "test@example.com"');
  commitFile(repoDir, 'README.md', 'base\n', 'Initial commit');
  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

test('getBranchOwnChanges reports only branch commits when the branch is behind base', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const branchPoint = git(repoDir, 'rev-parse HEAD');
    // Base advances with a new file after the branch point.
    commitFile(repoDir, 'base-added.txt', 'base advance\n', 'Add file on base');
    const baseTip = git(repoDir, 'rev-parse HEAD');

    // Branch cut from the earlier branch point, adding a single unrelated file.
    git(repoDir, `checkout -b task/one ${branchPoint}`);
    const headSha = commitFile(repoDir, 'branch.txt', 'branch work\n', 'Branch adds one file');

    const { entries, evidence } = getBranchOwnChanges({
      repoDir,
      baseRef: baseTip,
      headRef: headSha,
    });

    assert.deepEqual(entries, [{ status: 'A', path: 'branch.txt', previousPath: undefined }]);
    assert.equal(evidence.baseSha, baseTip);
    assert.equal(evidence.headSha, headSha);
    assert.equal(evidence.mergeBaseSha, branchPoint);
  } finally {
    cleanup();
  }
});

test('getBranchOwnChanges reports a deletion the branch itself introduces', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    commitFile(repoDir, 'doomed.txt', 'goodbye\n', 'Add file that will be deleted');
    const branchPoint = git(repoDir, 'rev-parse HEAD');

    git(repoDir, `checkout -b task/delete ${branchPoint}`);
    const headSha = removeFile(repoDir, 'doomed.txt', 'Delete doomed');

    const { entries, evidence } = getBranchOwnChanges({
      repoDir,
      baseRef: branchPoint,
      headRef: headSha,
    });

    assert.deepEqual(entries, [{ status: 'D', path: 'doomed.txt', previousPath: undefined }]);
    assert.equal(evidence.mergeBaseSha, branchPoint);
  } finally {
    cleanup();
  }
});

test('getBranchOwnChanges returns mergeBaseSha === baseSha for an up-to-date branch', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const branchPoint = git(repoDir, 'rev-parse HEAD');
    git(repoDir, `checkout -b task/up-to-date ${branchPoint}`);
    const headSha = commitFile(repoDir, 'work.txt', 'work\n', 'Branch work');

    const { entries, evidence } = resolveBranchDiffBaseAsHelper({
      repoDir,
      baseRef: branchPoint,
      headRef: headSha,
    });
    assert.equal(evidence.mergeBaseSha, evidence.baseSha);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, 'work.txt');
    assert.equal(entries[0].status, 'A');
  } finally {
    cleanup();
  }
});

function resolveBranchDiffBaseAsHelper(input: {
  repoDir: string;
  baseRef: string;
  headRef: string;
}) {
  const evidence = resolveBranchDiffBase(input);
  const changes = getBranchOwnChanges(input);
  return { evidence, entries: changes.entries };
}

test('getBranchOwnChanges throws with git stderr when the ref does not exist', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    assert.throws(
      () => getBranchOwnChanges({
        repoDir,
        baseRef: 'no-such-ref',
        headRef: 'HEAD',
      }),
      /no-such-ref|unknown revision|bad revision/i,
    );
  } finally {
    cleanup();
  }
});

test('parseNameStatusOutput captures rename previousPath', () => {
  const entries = parseNameStatusOutput('R100\told.txt\tnew.txt\nM\tunchanged.txt\n');
  assert.deepEqual(entries, [
    { status: 'R', path: 'new.txt', previousPath: 'old.txt' },
    { status: 'M', path: 'unchanged.txt', previousPath: undefined },
  ]);
});
