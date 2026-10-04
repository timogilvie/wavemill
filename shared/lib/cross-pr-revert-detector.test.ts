import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  detectCrossPrReverts,
  detectSurvivingChangeWarnings,
  filterUnacknowledgedReverts,
  parseRevertAcknowledgements,
} from './cross-pr-revert-detector.ts';

function git(repoDir: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
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

function mergePrBranch(
  repoDir: string,
  branch: string,
  prNumber: number,
  title: string,
): string {
  git(repoDir, `merge --no-ff ${shellQuote(branch)} -m ${shellQuote(`Merge pull request #${prNumber} from test/${branch}`)} -m ${shellQuote(title)}`);
  return git(repoDir, 'rev-parse HEAD');
}

function makeRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'cross-pr-revert-'));
  git(repoDir, 'init -b main');
  git(repoDir, 'config user.name "Test User"');
  git(repoDir, 'config user.email "test@example.com"');
  writeFileSync(join(repoDir, '.wavemill-config.json'), '{}');
  commitFile(repoDir, 'README.md', 'base\n', 'Initial commit');
  git(repoDir, 'checkout -b auto/integration');
  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

test('detectCrossPrReverts flags deletion of a file added by a recent integration PR', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    git(repoDir, 'checkout -b pr-437');
    commitFile(repoDir, 'strategy.txt', 'live integration\n', 'Restore strategy explorer');
    git(repoDir, 'checkout auto/integration');
    const mergeCommit = mergePrBranch(repoDir, 'pr-437', 437, 'Restore strategy explorer');
    git(repoDir, 'checkout -b task/remove-strategy auto/integration');
    const baseRef = git(repoDir, 'merge-base auto/integration HEAD');
    const headRef = removeFile(repoDir, 'strategy.txt', 'Remove unrelated diff');

    const { findings, evidence } = detectCrossPrReverts({
      repoDir,
      baseRef,
      headRef,
      integrationRef: 'auto/integration',
    });

    assert.deepEqual(findings, [
      {
        prNumber: 437,
        title: 'Merge pull request #437 from test/pr-437',
        mergeCommit,
        files: [
          {
            path: 'strategy.txt',
            status: 'deleted',
            confidence: 'deleted',
          },
        ],
      },
    ]);
    assert.match(evidence.baseSha, /^[0-9a-f]{40}$/);
    assert.match(evidence.headSha, /^[0-9a-f]{40}$/);
    assert.match(evidence.mergeBaseSha, /^[0-9a-f]{40}$/);
  } finally {
    cleanup();
  }
});

test('detectSurvivingChangeWarnings reports history-only PRs whose added files are absent from the promoted tree', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const mainBase = git(repoDir, 'rev-parse main');
    git(repoDir, 'checkout -b pr-437');
    commitFile(repoDir, 'strategy.txt', 'live integration\n', 'Restore strategy explorer');
    git(repoDir, 'checkout auto/integration');
    mergePrBranch(repoDir, 'pr-437', 437, 'Restore strategy explorer');
    const findings = detectSurvivingChangeWarnings({
      repoDir,
      baseRef: mainBase,
      headRef: 'main',
      integrationRef: 'auto/integration',
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].prNumber, 437);
    assert.equal(findings[0].files[0].path, 'strategy.txt');
    assert.equal(findings[0].files[0].confidence, 'missing-survivor');
  } finally {
    cleanup();
  }
});

test('detectCrossPrReverts flags restoring the parent version of a file modified by a recent integration PR', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    commitFile(repoDir, 'router.ts', 'export const timeout = 30;\n', 'Add router');
    git(repoDir, 'checkout -b pr-438');
    commitFile(repoDir, 'router.ts', 'export const timeout = 5;\n', 'Bound fallback timeout');
    git(repoDir, 'checkout auto/integration');
    const mergeCommit = mergePrBranch(repoDir, 'pr-438', 438, 'Bound queue classifier fallback ladder');
    const integrationTip = git(repoDir, 'rev-parse auto/integration');

    // Cut the task branch from the integration tip (router.ts = v2 = 5) and
    // actively reset it to the pre-PR blob v1 = 30. The branch must have
    // *touched* the file for the reverted-blob classifier to fire — this is
    // the true-positive case the guard exists to catch.
    git(repoDir, `checkout -b task/stale-review ${integrationTip}`);
    commitFile(repoDir, 'router.ts', 'export const timeout = 30;\n', 'Restore router timeout');
    const { findings } = detectCrossPrReverts({
      repoDir,
      baseRef: integrationTip,
      headRef: 'HEAD',
      integrationRef: 'auto/integration',
    });

    assert.deepEqual(findings, [
      {
        prNumber: 438,
        title: 'Merge pull request #438 from test/pr-438',
        mergeCommit,
        files: [
          {
            path: 'router.ts',
            status: 'modified',
            confidence: 'reverted',
          },
        ],
      },
    ]);
  } finally {
    cleanup();
  }
});

test('detectCrossPrReverts ignores a revert that already landed on the integration branch', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    git(repoDir, 'checkout -b pr-440');
    commitFile(repoDir, 'liveness.test.sh', 'liveness\n', 'Add liveness test');
    commitFile(repoDir, 'common.sh', 'patched\n', 'Patch common');
    git(repoDir, 'checkout auto/integration');
    mergePrBranch(repoDir, 'pr-440', 440, 'Fix blocked-completion liveness check');

    // A later commit on integration itself drops PR #440's work. Every branch cut from
    // this tip inherits the removal without having authored it.
    git(repoDir, 'rm liveness.test.sh');
    commitFile(repoDir, 'common.sh', 'base\n', 'revert: drop duplicated liveness work');

    git(repoDir, 'checkout -b task/unrelated auto/integration');
    const baseRef = git(repoDir, 'rev-parse auto/integration');
    commitFile(repoDir, 'unrelated.ts', 'unrelated work\n', 'Unrelated task work');

    const { findings } = detectCrossPrReverts({
      repoDir,
      baseRef,
      headRef: 'HEAD',
      integrationRef: 'auto/integration',
    });

    assert.deepEqual(findings, []);
  } finally {
    cleanup();
  }
});

test('detectCrossPrReverts ignores non-merge integration commits even when their subject mentions a PR number', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    commitFile(repoDir, 'strategy.txt', 'live integration\n', 'Restore strategy explorer (#437)');
    git(repoDir, 'checkout -b task/remove-strategy auto/integration');
    const baseRef = git(repoDir, 'merge-base auto/integration HEAD');
    const headRef = removeFile(repoDir, 'strategy.txt', 'Remove unrelated diff');

    const { findings } = detectCrossPrReverts({
      repoDir,
      baseRef,
      headRef,
      integrationRef: 'auto/integration',
    });

    assert.deepEqual(findings, []);
  } finally {
    cleanup();
  }
});

// HOK-3091 acceptance 1: a behind-base branch that adds one file must produce
// no findings even when the caller passes the base *tip* (as
// wavemill-monitor.sh does). This is the exact shape of PR #89 in HOK-2788.
test('detectCrossPrReverts does not flag a behind-base branch when called with the base tip', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    // A recent integration PR adds 3 files (the "23 files" of HOK-2788 in miniature).
    git(repoDir, 'checkout -b pr-86');
    commitFile(repoDir, 'recon-a.md', 'a\n', 'Add recon a');
    commitFile(repoDir, 'recon-b.md', 'b\n', 'Add recon b');
    commitFile(repoDir, 'recon-c.md', 'c\n', 'Add recon c');
    git(repoDir, 'checkout auto/integration');
    mergePrBranch(repoDir, 'pr-86', 86, 'Recon docs');
    const baseTip = git(repoDir, 'rev-parse auto/integration');

    // Cut a branch from BEFORE the recon PR merged — behind base by one merge.
    // Use the pre-merge tip: reset auto/integration temporarily to find it.
    // Simpler: cut from HEAD~1 relative to current auto/integration tip.
    const behindPoint = git(repoDir, 'rev-parse auto/integration~1');
    git(repoDir, `checkout -b task/behind-base ${behindPoint}`);
    // Branch adds exactly one file (mirrors PR #89).
    commitFile(repoDir, 'my-work.md', 'branch work\n', 'Add one file');
    const headRef = git(repoDir, 'rev-parse HEAD');

    // Caller passes the base TIP, not the merge base. Without HOK-3091 this
    // reports every recon-*.md file as "deleted by branch"; with it, none.
    const { findings, evidence } = detectCrossPrReverts({
      repoDir,
      baseRef: baseTip,
      headRef,
      integrationRef: 'auto/integration',
    });

    assert.deepEqual(findings, []);
    assert.equal(evidence.baseSha, baseTip);
    assert.equal(evidence.headSha, headRef);
    assert.equal(evidence.mergeBaseSha, behindPoint);
  } finally {
    cleanup();
  }
});

// HOK-3091 acceptance 2: a branch whose own commit deletes a file a recent PR
// added is still flagged even when called with the base tip.
test('detectCrossPrReverts still flags a branch that deletes a recently-PR-added file when called with the base tip', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    // PR #86 adds recon-a.md (the file the branch will delete).
    git(repoDir, 'checkout -b pr-86');
    commitFile(repoDir, 'recon-a.md', 'live\n', 'Add recon a');
    git(repoDir, 'checkout auto/integration');
    mergePrBranch(repoDir, 'pr-86', 86, 'Recon docs');

    // PR #87 adds an unrelated file after the branch point.
    git(repoDir, 'checkout -b pr-87');
    commitFile(repoDir, 'later.md', 'later\n', 'Add later');
    git(repoDir, 'checkout auto/integration');
    mergePrBranch(repoDir, 'pr-87', 87, 'Later work');
    const baseTip = git(repoDir, 'rev-parse auto/integration');

    // Cut a branch from BEFORE PR #87 merged (behind base by one merge) that
    // still has recon-a.md, then have the branch's own commit delete it.
    const behindPoint = git(repoDir, 'rev-parse auto/integration~1');
    git(repoDir, `checkout -b task/delete-recon ${behindPoint}`);
    removeFile(repoDir, 'recon-a.md', 'Drop recon a');
    const headRef = git(repoDir, 'rev-parse HEAD');

    const { findings } = detectCrossPrReverts({
      repoDir,
      baseRef: baseTip,
      headRef,
      integrationRef: 'auto/integration',
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].prNumber, 86);
    assert.equal(findings[0].files[0].path, 'recon-a.md');
    assert.equal(findings[0].files[0].confidence, 'deleted');
  } finally {
    cleanup();
  }
});

// HOK-3091 vector 3 regression: a PR modifies file X after the branch point;
// the branch never touches X. The behind-base branch still carries the PR's
// parent version at head, but that is inherited staleness, not a revert.
test('detectCrossPrReverts does not flag an inherited-stale file the branch never touched', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    commitFile(repoDir, 'router.ts', 'export const timeout = 30;\n', 'Add router');
    const branchPoint = git(repoDir, 'rev-parse HEAD');
    // Push branchPoint onto auto/integration so we have a valid pre-PR base.
    git(repoDir, 'checkout -b pr-438');
    commitFile(repoDir, 'router.ts', 'export const timeout = 5;\n', 'Bound timeout');
    git(repoDir, 'checkout auto/integration');
    mergePrBranch(repoDir, 'pr-438', 438, 'Bound timeout');
    const baseTip = git(repoDir, 'rev-parse auto/integration');

    // Branch cut from before PR #438 merged; branch never touches router.ts.
    git(repoDir, `checkout -b task/inherited-stale ${branchPoint}`);
    commitFile(repoDir, 'unrelated.ts', 'unrelated\n', 'Unrelated work');
    const headRef = git(repoDir, 'rev-parse HEAD');

    const { findings } = detectCrossPrReverts({
      repoDir,
      baseRef: baseTip,
      headRef,
      integrationRef: 'auto/integration',
    });

    // Head's router.ts blob equals the PR's parent blob, but the branch never
    // touched router.ts — this must NOT be flagged as reverted.
    assert.deepEqual(findings, []);
  } finally {
    cleanup();
  }
});

test('parseRevertAcknowledgements accepts only explicit acknowledgement phrases', () => {
  const acknowledgements = parseRevertAcknowledgements(`
    Intentionally reverts #437
    removes unrelated diff from this PR
    reverts #438
  `);

  assert.deepEqual([...acknowledgements].sort((a, b) => a - b), [437, 438]);
});

test('filterUnacknowledgedReverts removes findings that were explicitly acknowledged', () => {
  const findings = [
    {
      prNumber: 437,
      files: [{ path: 'strategy.txt', status: 'deleted' as const, confidence: 'deleted' as const }],
    },
    {
      prNumber: 438,
      files: [{ path: 'router.ts', status: 'deleted' as const, confidence: 'deleted' as const }],
    },
  ];

  const remaining = filterUnacknowledgedReverts(findings, new Set([438]));
  assert.deepEqual(remaining, [findings[0]]);
});
