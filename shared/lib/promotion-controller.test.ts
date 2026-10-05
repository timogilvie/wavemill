import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { measureBranchBaseDistance, runPromotion, updateBranchWithBase } from './promotion-controller.ts';

function makeRepo(config: Record<string, unknown> = {}): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-promote-'));
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({
      integration: {
        integrationBranch: 'auto/integration',
        promotionBranch: 'main',
      },
      ...config,
    }),
  );
  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

function shellHarness(overrides: {
  baseIntegrated?: boolean;
  alreadyPromoted?: boolean;
  openPrs?: Array<{ number: number; url: string; body?: string }>;
  promotionHeadOpenPrs?: Array<{ number: number; url: string; body?: string }>;
  mergedPrs?: Array<{ number: number; title: string; labels?: Array<{ name: string }> }>;
  checks?: Array<{ name: string; state?: string; conclusion?: string | null; bucket?: string | null }>;
  integrationTreeLog?: string;
  recentCommitLogByRange?: Record<string, string>;
  recentPrCommitLogByRange?: Record<string, string>;
  diffNameStatusByRefs?: Record<string, string>;
  integrationTree?: string;
  promotionTree?: string;
  existingPathsByRef?: Record<string, string[]>;
  pushError?: string;
  promotionHeadPushError?: string;
  fetchError?: string;
  integrationFetchError?: string;
  mergeTreeResult?: 'clean' | 'conflicts' | 'unknown' | 'conflicts-exit-status';
  statusPorcelain?: string;
  branchProtection?:
    | 'unprotected'
    | 'force-push-disabled'
    | 'required-status-checks'
    | 'restricted-push'
    | 'protected-no-details'
    | 'unknown';
  localIntegrationTip?: string;
  remoteIntegrationTip?: string;
  integrationRelation?: 'equal' | 'behind' | 'ahead' | 'diverged';
  currentBranch?: string | null;
  integrationUpdateRefError?: string;
  integrationMergeFfError?: string;
} = {}): {
  shellRunner: (cmd: string, opts?: { encoding?: string; cwd?: string }) => string;
  calls: string[];
} {
  const calls: string[] = [];
  let tempFileCount = 0;
  let integrationTip = overrides.localIntegrationTip ?? 'integration-sha';
  let remoteIntegrationTip = overrides.remoteIntegrationTip ?? integrationTip;
  let remoteBaseMerged = overrides.baseIntegrated ?? true;
  const integrationRelation =
    overrides.integrationRelation ??
    (integrationTip === remoteIntegrationTip ? 'equal' : 'behind');

  const isIntegrationAncestor = (ancestor: string, descendant: string): boolean => {
    if (ancestor === descendant) {
      return true;
    }
    if (ancestor === integrationTip && descendant === remoteIntegrationTip) {
      return integrationRelation === 'behind';
    }
    if (ancestor === remoteIntegrationTip && descendant === integrationTip) {
      return integrationRelation === 'ahead';
    }
    return false;
  };

  return {
    calls,
    shellRunner: (cmd) => {
      calls.push(cmd);

      if (cmd === 'mktemp') {
        tempFileCount += 1;
        return tempFileCount === 1 ? '/tmp/promotion-body.txt' : `/tmp/promotion-body-${tempFileCount}.txt`;
      }

      if (cmd === "git fetch --quiet origin 'main'") {
        if (overrides.fetchError) throw new Error(overrides.fetchError);
        return '';
      }
      if (cmd === "git fetch --quiet origin 'auto/integration'") {
        if (overrides.integrationFetchError) throw new Error(overrides.integrationFetchError);
        return '';
      }
      if (cmd === "git fetch --quiet origin 'main' 'auto/integration'") {
        if (overrides.fetchError) throw new Error(overrides.fetchError);
        return '';
      }
      if (cmd === 'git status --porcelain --untracked-files=no') return `${overrides.statusPorcelain ?? ''}`;
      if (cmd === "git switch 'auto/integration'") return '';
      if (cmd === 'git symbolic-ref --quiet --short HEAD') {
        if (overrides.currentBranch === null) throw new Error('detached HEAD');
        return `${overrides.currentBranch ?? 'task/test'}\n`;
      }
      if (cmd === "git rev-parse --verify --quiet 'origin/auto/integration^{commit}'") {
        if (overrides.remoteIntegrationTip === '') {
          throw new Error('no remote ref');
        }
        return `${remoteIntegrationTip}\n`;
      }
      if (cmd === "git merge --ff-only 'origin/auto/integration'") {
        if (overrides.integrationMergeFfError) throw new Error(overrides.integrationMergeFfError);
        integrationTip = remoteIntegrationTip;
        return '';
      }
      if (cmd === "git merge --no-edit 'origin/main'") {
        remoteBaseMerged = true;
        integrationTip = 'updated-integration-sha';
        return '';
      }
      if (cmd === "git push origin 'auto/integration'") {
        if (overrides.pushError) throw new Error(overrides.pushError);
        return '';
      }

      if (cmd === "git rev-parse 'auto/integration' 2>/dev/null") return `${integrationTip}\n`;
      if (cmd === "git rev-parse 'origin/auto/integration' 2>/dev/null") return `${remoteIntegrationTip}\n`;
      if (cmd === "git rev-parse 'main' 2>/dev/null") return 'main-sha\n';
      if (cmd === "git rev-parse 'origin/main' 2>/dev/null") return 'origin-main-sha\n';
      if (cmd === "git rev-parse 'integration-sha^{tree}'") return `${overrides.integrationTree ?? 'integration-tree'}\n`;
      if (cmd === "git rev-parse 'stale-integration-sha^{tree}'") return `${overrides.integrationTree ?? 'integration-tree'}\n`;
      if (cmd === "git rev-parse 'origin-integration-sha^{tree}'") return `${overrides.integrationTree ?? 'integration-tree'}\n`;
      if (cmd === "git rev-parse 'updated-integration-sha^{tree}'") return `${overrides.integrationTree ?? 'integration-tree'}\n`;
      if (cmd === "git rev-parse 'reconciled-sha^{tree}'") return `${overrides.integrationTree ?? 'integration-tree'}\n`;
      if (cmd === "git rev-parse 'main-sha^{tree}'") return `${overrides.promotionTree ?? 'main-tree'}\n`;
      if (cmd === "git rev-parse 'origin-main-sha^{tree}'") return `${overrides.promotionTree ?? 'main-tree'}\n`;
      if (cmd === "git log --format='%H %T' 'auto/integration'") {
        const defaultLog = `${integrationTip} ${overrides.integrationTree ?? 'integration-tree'}\nold-sha old-tree\n`;
        return overrides.integrationTreeLog ?? defaultLog;
      }

      if (cmd === "git merge-base --is-ancestor 'origin-main-sha' 'integration-sha'") {
        if (remoteBaseMerged) return '';
        throw new Error('not ancestor');
      }
      if (cmd === "git merge-base --is-ancestor 'origin-main-sha' 'updated-integration-sha'") {
        if (remoteBaseMerged) return '';
        throw new Error('not ancestor');
      }
      if (cmd === "git merge-base --is-ancestor 'integration-sha' 'origin/main'") {
        if (overrides.alreadyPromoted) return '';
        throw new Error('not ancestor');
      }
      if (cmd === "git merge-base --is-ancestor 'updated-integration-sha' 'origin/main'") {
        if (overrides.alreadyPromoted) return '';
        throw new Error('not ancestor');
      }
      if (cmd === "git merge-base --is-ancestor 'origin-main-sha' 'main-sha'") {
        if (overrides.baseIntegrated ?? true) return '';
        throw new Error('not ancestor');
      }
      if (cmd === "git merge-base --is-ancestor 'origin-main-sha' 'reconciled-sha'") {
        if (overrides.baseIntegrated ?? true) return '';
        throw new Error('not ancestor');
      }
      if (cmd === `git merge-base --is-ancestor '${integrationTip}' '${remoteIntegrationTip}'`) {
        if (isIntegrationAncestor(integrationTip, remoteIntegrationTip)) return '';
        throw new Error('not ancestor');
      }
      if (cmd === `git merge-base --is-ancestor '${remoteIntegrationTip}' '${integrationTip}'`) {
        if (isIntegrationAncestor(remoteIntegrationTip, integrationTip)) return '';
        throw new Error('not ancestor');
      }
      if (cmd.includes("git merge-base --is-ancestor 'origin-main-sha'")) {
        if (overrides.baseIntegrated ?? true) return '';
        throw new Error('not ancestor');
      }
      if (cmd.includes("git merge-base --is-ancestor") && cmd.includes("'origin/main'")) {
        if (overrides.alreadyPromoted) return '';
        throw new Error('not ancestor');
      }

      if (cmd === "git merge-tree --write-tree 'auto/integration' 'origin/main'") {
        if (overrides.mergeTreeResult === 'conflicts') throw new Error('merge-tree conflict');
        if (overrides.mergeTreeResult === 'unknown') throw new Error('merge-tree unavailable');
        if (overrides.mergeTreeResult === 'conflicts-exit-status') {
          // Mirror real execSync behaviour: git merge-tree exits 1 on conflict but
          // writes the conflict list to stdout, so the error message has no "conflict".
          const err = new Error("Command failed: git merge-tree --write-tree 'auto/integration' 'origin/main'") as Error & { status: number };
          err.status = 1;
          throw err;
        }
        return 'merged-tree-sha\n';
      }

      if (cmd.includes('gh pr list --state merged')) {
        return JSON.stringify(overrides.mergedPrs ?? [
          { number: 101, title: 'Add release guardrails', labels: [{ name: 'wavemill' }] },
        ]);
      }

      const recentCommitsMatch = cmd.match(/^git log --first-parent --oneline -n 10 '([^']+\.\.auto\/integration)'$/);
      if (recentCommitsMatch) {
        const range = recentCommitsMatch[1];
        if (overrides.recentCommitLogByRange?.[range] !== undefined) {
          return overrides.recentCommitLogByRange[range];
        }
        if (range === 'origin/main..auto/integration') {
          return 'abc123 Add release guardrails (#101)\n';
        }
        if (range === 'previous-integration-sha..auto/integration') {
          return 'abc123 Add release guardrails (#101)\n';
        }
      }

      if (
        cmd.startsWith('git log --first-parent')
        && cmd.includes("--pretty=format:%H%x09%P%x09%s '")
        && cmd.endsWith("..auto/integration'")
      ) {
        const range = cmd.slice(cmd.indexOf("'") + 1, -1);
        return overrides.recentPrCommitLogByRange?.[range] ?? '';
      }

      const diffNameStatusMatch = cmd.match(/^git diff --name-status '([^']+)' '([^']+)'$/);
      if (diffNameStatusMatch) {
        const key = `${diffNameStatusMatch[1]}..${diffNameStatusMatch[2]}`;
        return overrides.diffNameStatusByRefs?.[key] ?? '';
      }

      const catFileMatch = cmd.match(/^git cat-file -e '([^:']+):(.+)'(?: 2>\/dev\/null)?$/);
      if (catFileMatch) {
        const ref = catFileMatch[1];
        const path = catFileMatch[2];
        const existingPaths = overrides.existingPathsByRef?.[ref] ?? [];
        if (existingPaths.includes(path)) {
          return '';
        }
        throw new Error('missing path');
      }

      if (cmd.includes("gh pr list --head 'auto/integration' --base 'main' --state open --json number,url,body")) {
        return JSON.stringify(overrides.openPrs ?? []);
      }
      if (cmd.includes("gh pr list --head 'auto/promotion' --base 'main' --state open --json number,url,body")) {
        return JSON.stringify(overrides.promotionHeadOpenPrs ?? []);
      }
      if (cmd.includes("gh pr list --head 'auto/release-transport' --base 'main' --state open --json number,url,body")) {
        return JSON.stringify(overrides.promotionHeadOpenPrs ?? []);
      }

      if (cmd === 'gh repo view --json nameWithOwner --jq .nameWithOwner') return 'example/repo\n';
      if (cmd === "gh api 'repos/example/repo/branches/auto/integration'") {
        switch (overrides.branchProtection) {
          case 'force-push-disabled':
            return JSON.stringify({
              protected: true,
              protection: {
                allow_force_pushes: { enabled: false },
                required_status_checks: null,
                restrictions: null,
              },
            });
          case 'required-status-checks':
            return JSON.stringify({
              protected: true,
              protection: {
                allow_force_pushes: { enabled: true },
                required_status_checks: { contexts: ['ci'] },
                restrictions: null,
              },
            });
          case 'restricted-push':
            return JSON.stringify({
              protected: true,
              protection: {
                allow_force_pushes: { enabled: true },
                required_status_checks: null,
                restrictions: { users: [{ login: 'octocat' }], teams: [], apps: [] },
              },
            });
          case 'protected-no-details':
            return JSON.stringify({ protected: true });
          case 'unknown':
            throw new Error('HTTP 403: Resource not accessible by integration');
          default:
            return JSON.stringify({ protected: false });
        }
      }
      if (cmd.includes("gh api --method PATCH 'repos/example/repo/pulls/77' --input")) return '';
      if (cmd.includes('gh pr create')) return 'https://github.com/example/repo/pull/88\n';
      if (cmd.includes("rm -f '/tmp/promotion-body.txt'")) return '';
      if (cmd.includes("rm -f '/tmp/promotion-body-")) return '';
      if (cmd.includes("git commit-tree 'integration-sha^{tree}'")) return 'reconciled-sha\n';
      if (cmd.includes("git commit-tree 'origin-integration-sha^{tree}'")) return 'reconciled-sha\n';
      const updateRefMatch = cmd.match(/^git update-ref 'refs\/heads\/auto\/integration' '([^']+)' '([^']+)'$/);
      if (updateRefMatch) {
        const [, nextTip, expectedTip] = updateRefMatch;
        if (overrides.integrationUpdateRefError && nextTip === remoteIntegrationTip && expectedTip === integrationTip) {
          throw new Error(overrides.integrationUpdateRefError);
        }
        if (integrationTip === expectedTip) {
          integrationTip = nextTip;
          return '';
        }
      }
      if (cmd === "git update-ref 'refs/heads/auto/integration' 'reconciled-sha' 'integration-sha'") {
        integrationTip = 'reconciled-sha';
        return '';
      }
      if (cmd === "git update-ref 'refs/heads/auto/integration' 'integration-sha' 'reconciled-sha'") return '';
      if (cmd === "git update-ref 'refs/heads/auto/integration' 'origin-main-sha' 'integration-sha'") {
        integrationTip = 'origin-main-sha';
        return '';
      }
      if (cmd === "git update-ref 'refs/heads/auto/integration' 'integration-sha' 'main-sha'") return '';
      const pushLeaseMatch = cmd.match(
        /^git push --force-with-lease='refs\/heads\/auto\/integration:([^']+)' origin 'refs\/heads\/auto\/integration:refs\/heads\/auto\/integration'$/,
      );
      if (pushLeaseMatch) {
        if (overrides.pushError) throw new Error(overrides.pushError);
        return '';
      }
      if (cmd === "git update-ref 'refs/heads/auto/promotion' 'reconciled-sha'") return '';
      if (cmd === "git update-ref 'refs/heads/auto/release-transport' 'reconciled-sha'") return '';
      if (cmd === "git push origin 'refs/heads/auto/promotion:refs/heads/auto/promotion'") {
        if (overrides.promotionHeadPushError) throw new Error(overrides.promotionHeadPushError);
        return '';
      }
      if (cmd === "git push origin 'refs/heads/auto/release-transport:refs/heads/auto/release-transport'") {
        if (overrides.promotionHeadPushError) throw new Error(overrides.promotionHeadPushError);
        return '';
      }

      if (cmd.includes('gh pr checks')) {
        return JSON.stringify(overrides.checks ?? [
          { name: 'ci', state: 'COMPLETED', bucket: 'pass' },
        ]);
      }

      throw new Error(`Unhandled command: ${cmd}`);
    },
  };
}

describe('runPromotion', () => {
  it('updates a branch with its base in fetch switch ff-only merge push order', () => {
    const repo = makeRepo();
    const shell = shellHarness();

    try {
      const result = updateBranchWithBase('auto/integration', 'main', repo.repoDir, shell.shellRunner);
      assert.equal(result.status, 'success');
      assert.deepEqual(
        shell.calls.slice(0, 7),
        [
          'git status --porcelain --untracked-files=no',
          "git fetch --quiet origin 'main' 'auto/integration'",
          "git switch 'auto/integration'",
          "git rev-parse --verify --quiet 'origin/auto/integration^{commit}'",
          "git merge --ff-only 'origin/auto/integration'",
          "git merge-tree --write-tree 'auto/integration' 'origin/main'",
          "git merge --no-edit 'origin/main'",
        ],
      );
      assert(shell.calls.includes("git push origin 'auto/integration'"));
    } finally {
      repo.cleanup();
    }
  });

  it('fast-forwards local from origin and merges from the origin tip', () => {
    const repo = makeRepo();
    const shell = shellHarness({
      localIntegrationTip: 'stale-integration-sha',
      remoteIntegrationTip: 'origin-integration-sha',
      integrationRelation: 'behind',
    });
    try {
      const result = updateBranchWithBase('auto/integration', 'main', repo.repoDir, shell.shellRunner);
      assert.equal(result.status, 'success', JSON.stringify(result));
      assert(shell.calls.includes("git merge --ff-only 'origin/auto/integration'"), 'must ff-only from origin');
    } finally {
      repo.cleanup();
    }
  });

  it('returns unknown-failed when local branch has diverged from origin', () => {
    const repo = makeRepo();
    const shell = shellHarness({
      localIntegrationTip: 'diverged-local-sha',
      remoteIntegrationTip: 'origin-integration-sha',
      integrationRelation: 'diverged',
      integrationMergeFfError: 'fatal: Not possible to fast-forward, aborting.',
    });
    try {
      const result = updateBranchWithBase('auto/integration', 'main', repo.repoDir, shell.shellRunner);
      assert.equal(result.status, 'unknown-failed');
      assert.match(result.detail ?? '', /diverged/);
      assert(!shell.calls.some((cmd) => cmd === "git merge --no-edit 'origin/main'"), 'must not merge base into diverged branch');
      assert(!shell.calls.some((cmd) => cmd === "git push origin 'auto/integration'"), 'must not push a diverged branch');
    } finally {
      repo.cleanup();
    }
  });

  it('returns conflict when merge-tree predicts conflicts and does not push', () => {
    const repo = makeRepo();
    const shell = shellHarness({ mergeTreeResult: 'conflicts' });

    try {
      const result = updateBranchWithBase('auto/integration', 'main', repo.repoDir, shell.shellRunner);
      assert.equal(result.status, 'conflict');
      assert(shell.calls.includes("git merge-tree --write-tree 'auto/integration' 'origin/main'"));
      assert(!shell.calls.some((cmd) => cmd === "git merge --no-edit 'origin/main'"));
      assert(!shell.calls.some((cmd) => cmd === "git push origin 'auto/integration'"));
    } finally {
      repo.cleanup();
    }
  });

  it('aborts merge and returns conflict when merge reports conflicts', () => {
    const repo = makeRepo();
    const shell = shellHarness();
    const shellRunner = (cmd: string, opts?: { encoding?: string; cwd?: string }) => {
      if (cmd === "git merge --no-edit 'origin/main'") {
        shell.calls.push(cmd);
        throw new Error('CONFLICT (content): merge conflict');
      }
      if (cmd === 'git merge --abort') {
        shell.calls.push(cmd);
        return '';
      }
      return shell.shellRunner(cmd, opts);
    };

    try {
      const result = updateBranchWithBase('auto/integration', 'main', repo.repoDir, shellRunner);
      assert.equal(result.status, 'conflict');
      assert(shell.calls.includes('git merge --abort'));
      assert(!shell.calls.some((cmd) => cmd === "git push origin 'auto/integration'"));
    } finally {
      repo.cleanup();
    }
  });

  // HOK-3092: conflictingFiles is captured before `git merge --abort` runs,
  // so operator-facing surfaces (the ready needs-attention marker) can list
  // the exact paths that need a hand.
  it('populates conflictingFiles from the unmerged file list before aborting', () => {
    const repo = makeRepo();
    const shell = shellHarness();
    const observedOrder: string[] = [];
    const shellRunner = (cmd: string, opts?: { encoding?: string; cwd?: string }) => {
      if (cmd === "git merge --no-edit 'origin/main'") {
        shell.calls.push(cmd);
        observedOrder.push(cmd);
        throw new Error('CONFLICT (content): merge conflict');
      }
      if (cmd === 'git diff --name-only --diff-filter=U') {
        shell.calls.push(cmd);
        observedOrder.push(cmd);
        return 'README.md\nsrc/util.ts\n';
      }
      if (cmd === 'git merge --abort') {
        shell.calls.push(cmd);
        observedOrder.push(cmd);
        return '';
      }
      return shell.shellRunner(cmd, opts);
    };

    try {
      const result = updateBranchWithBase('auto/integration', 'main', repo.repoDir, shellRunner);
      assert.equal(result.status, 'conflict');
      assert.deepEqual(result.conflictingFiles, ['README.md', 'src/util.ts']);
      // Enumerate before aborting — an abort clears the unmerged index.
      const diffIndex = observedOrder.indexOf('git diff --name-only --diff-filter=U');
      const abortIndex = observedOrder.indexOf('git merge --abort');
      assert(diffIndex >= 0 && abortIndex >= 0);
      assert(diffIndex < abortIndex, 'conflictingFiles must be enumerated before merge --abort');
    } finally {
      repo.cleanup();
    }
  });

  // A failing `git diff --name-only --diff-filter=U` never masks the merge
  // failure — the caller falls back to `detail` alone.
  it('returns conflict with an empty file list when enumeration fails', () => {
    const repo = makeRepo();
    const shell = shellHarness();
    const shellRunner = (cmd: string, opts?: { encoding?: string; cwd?: string }) => {
      if (cmd === "git merge --no-edit 'origin/main'") {
        shell.calls.push(cmd);
        throw new Error('CONFLICT (content): merge conflict');
      }
      if (cmd === 'git diff --name-only --diff-filter=U') {
        shell.calls.push(cmd);
        throw new Error('index unreadable');
      }
      if (cmd === 'git merge --abort') {
        shell.calls.push(cmd);
        return '';
      }
      return shell.shellRunner(cmd, opts);
    };

    try {
      const result = updateBranchWithBase('auto/integration', 'main', repo.repoDir, shellRunner);
      assert.equal(result.status, 'conflict');
      assert.deepEqual(result.conflictingFiles, []);
      assert(shell.calls.includes('git merge --abort'));
    } finally {
      repo.cleanup();
    }
  });

  it('returns push-failed with the original push error', () => {
    const repo = makeRepo();
    const shell = shellHarness({ pushError: 'remote rejected push' });

    try {
      const result = updateBranchWithBase('auto/integration', 'main', repo.repoDir, shell.shellRunner);
      assert.equal(result.status, 'push-failed');
      assert.match(result.detail, /remote rejected push/);
    } finally {
      repo.cleanup();
    }
  });

  it('refuses to update when the worktree is dirty', () => {
    const repo = makeRepo();
    const shell = shellHarness({ statusPorcelain: ' M shared/lib/ready-watchdog.ts' });

    try {
      const result = updateBranchWithBase('auto/integration', 'main', repo.repoDir, shell.shellRunner);
      assert.equal(result.status, 'dirty-worktree');
      assert.equal(shell.calls.length, 1);
      assert.equal(shell.calls[0], 'git status --porcelain --untracked-files=no');
    } finally {
      repo.cleanup();
    }
  });

  it('proceeds when only untracked files are present (wavemill state must not block auto-update)', () => {
    const repo = makeRepo();
    const shell = shellHarness({ statusPorcelain: '' });

    try {
      const result = updateBranchWithBase('auto/integration', 'main', repo.repoDir, shell.shellRunner);
      assert.equal(result.status, 'success');
      assert.equal(shell.calls[0], 'git status --porcelain --untracked-files=no');
    } finally {
      repo.cleanup();
    }
  });

  it('returns fetch-failed when the initial fetch fails', () => {
    const repo = makeRepo();
    const shell = shellHarness({ fetchError: 'fatal: no such remote' });

    try {
      const result = updateBranchWithBase('auto/integration', 'main', repo.repoDir, shell.shellRunner);
      assert.equal(result.status, 'fetch-failed');
      assert.match(result.detail, /fatal: no such remote/);
    } finally {
      repo.cleanup();
    }
  });

  it('escapes branch and base names in all shell commands', () => {
    const repo = makeRepo();
    const calls: string[] = [];
    const shellRunner = (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'git status --porcelain --untracked-files=no') return '';
      return '';
    };

    try {
      const result = updateBranchWithBase("topic/it's", "main branch", repo.repoDir, shellRunner);
      assert.equal(result.status, 'success');
      assert(calls.some((cmd) => cmd.includes("git fetch --quiet origin 'main branch'") && cmd.includes("'topic/it'\\''s'")));
      assert(calls.includes("git switch 'topic/it'\\''s'"));
      assert(calls.includes("git merge-tree --write-tree 'topic/it'\\''s' 'origin/main branch'"));
      assert(calls.includes("git merge --no-edit 'origin/main branch'"));
      assert(calls.includes("git push origin 'topic/it'\\''s'"));
    } finally {
      repo.cleanup();
    }
  });

  it('updates the existing promotion PR body with a fresh summary', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: 'Existing context' }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        healthChecker: async () => ({ state: 'healthy' }),
      });

      assert.equal(result.status, 'updated');
      assert.equal(result.prUrl, 'https://github.com/example/repo/pull/77');
      assert.match(result.checkSummary ?? '', /^passing:/);
      assert(shell.calls.some((cmd) => cmd.includes("gh api --method PATCH 'repos/example/repo/pulls/77' --input")));
      assert(!shell.calls.some((cmd) => cmd.includes('gh pr create')));
      // Body is written directly via writeFileSync; rm -f is mocked so file persists
      const writtenBody = readFileSync('/tmp/promotion-body.txt', 'utf-8');
      const parsedBody = JSON.parse(writtenBody).body;
      assert.match(parsedBody, /Promotion Summary/);
      assert.match(parsedBody, /PR #101: Add release guardrails/);
      assert.doesNotMatch(parsedBody, /Surviving changes warnings/);
    } finally {
      repo.cleanup();
    }
  });

  it('adds surviving-change warnings when a recent integration PR is missing from the promoted tree', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
      recentPrCommitLogByRange: {
        'origin/main..auto/integration':
          'merge437\tparent436 branch437\tMerge pull request #437 from test/pr-437',
      },
      diffNameStatusByRefs: {
        'parent436..merge437': 'A\tstrategy.txt\n',
      },
      mergedPrs: [{ number: 437, title: 'Restore strategy explorer', labels: [{ name: 'wavemill' }] }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        healthChecker: async () => ({ state: 'healthy' }),
      });

      assert.equal(result.status, 'updated');
      const writtenBody = readFileSync('/tmp/promotion-body.txt', 'utf-8');
      const parsedBody = JSON.parse(writtenBody).body;
      assert.match(parsedBody, /Surviving changes warnings:/);
      assert.match(parsedBody, /PR #437 is in integration history, but added files are absent from promoted tree/);
    } finally {
      repo.cleanup();
    }
  });

  it('returns noop when promotion branch already contains integration', async () => {
    const repo = makeRepo();
    const shell = shellHarness({ alreadyPromoted: true });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
      });

      assert.deepEqual(result, { status: 'noop' });
      assert(!shell.calls.some((cmd) => cmd.includes('gh pr create')));
      assert(!shell.calls.some((cmd) => cmd.includes('gh api --method PATCH')));
    } finally {
      repo.cleanup();
    }
  });

  it('fast-forwards a stale local integration ref before continuing', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      localIntegrationTip: 'stale-integration-sha',
      remoteIntegrationTip: 'origin-integration-sha',
      integrationRelation: 'behind',
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        healthChecker: async () => ({ state: 'healthy' }),
      });

      assert.equal(result.status, 'updated');
      assert(shell.calls.includes("git fetch --quiet origin 'auto/integration'"));
      assert(shell.calls.includes("git rev-parse 'origin/auto/integration' 2>/dev/null"));
      assert(shell.calls.includes("git update-ref 'refs/heads/auto/integration' 'origin-integration-sha' 'stale-integration-sha'"));
      assert(!shell.calls.some((cmd) => cmd === "git merge --ff-only 'origin/auto/integration'"));
    } finally {
      repo.cleanup();
    }
  });

  it('rewrites integration onto main when a prior squash promotion is present by tree', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      baseIntegrated: false,
      integrationTree: 'current-integration-tree',
      promotionTree: 'promoted-tree',
      integrationTreeLog: [
        'integration-sha current-integration-tree',
        'previous-integration-sha promoted-tree',
        'older-sha old-tree',
      ].join('\n'),
      recentCommitLogByRange: {
        'origin/main..auto/integration': 'old111 Already promoted change (#11)\n',
        'previous-integration-sha..auto/integration': 'new222 New integration work (#22)\n',
      },
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
      mergedPrs: [{ number: 22, title: 'New integration work', labels: [{ name: 'wavemill' }] }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        healthChecker: async () => ({ state: 'healthy' }),
      });

      assert.equal(result.status, 'updated');
      assert.equal(result.headBranch, 'auto/integration');
      assert.deepEqual(result.squashRecovery, {
        status: 'applied-in-place',
        detail: 'matched promoted snapshot previous-integration-sha on auto/integration',
      });
      assert.match(result.infoSummary ?? '', /Applied squash reconciliation to auto\/integration/);
      assert(shell.calls.some((cmd) => cmd.includes("git commit-tree 'integration-sha^{tree}' -p 'origin-main-sha'")));
      assert(shell.calls.includes("gh api 'repos/example/repo/branches/auto/integration'"));
      assert(shell.calls.some((cmd) => cmd === "git update-ref 'refs/heads/auto/integration' 'reconciled-sha' 'integration-sha'"));
      assert(shell.calls.some((cmd) => cmd.includes("git push --force-with-lease='refs/heads/auto/integration:integration-sha'")));
      assert(shell.calls.some((cmd) => cmd.includes("git merge-base --is-ancestor 'reconciled-sha' 'origin/main'")));
      assert(shell.calls.some((cmd) => cmd === "git log --first-parent --oneline -n 10 'previous-integration-sha..auto/integration'"));
      assert(!shell.calls.some((cmd) => cmd === "git log --first-parent --oneline -n 10 'origin/main..auto/integration'"));
      const writtenBody = readFileSync('/tmp/promotion-body.txt', 'utf-8');
      const parsedBody = JSON.parse(writtenBody).body;
      assert.match(parsedBody, /Promotion path: Squash reconciliation applied to auto\/integration/);
      assert.match(parsedBody, /New integration work/);
      assert.match(parsedBody, /new222 New integration work/);
      assert.doesNotMatch(parsedBody, /Already promoted change/);
    } finally {
      repo.cleanup();
    }
  });

  it('uses the freshly fetched remote integration tip for reconciliation lease checks', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      baseIntegrated: false,
      localIntegrationTip: 'stale-integration-sha',
      remoteIntegrationTip: 'origin-integration-sha',
      integrationRelation: 'behind',
      integrationTree: 'current-integration-tree',
      promotionTree: 'promoted-tree',
      integrationTreeLog: [
        'origin-integration-sha current-integration-tree',
        'previous-integration-sha promoted-tree',
        'older-sha old-tree',
      ].join('\n'),
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        healthChecker: async () => ({ state: 'healthy' }),
      });

      assert.equal(result.status, 'updated');
      assert(shell.calls.some((cmd) => cmd.includes("git commit-tree 'origin-integration-sha^{tree}' -p 'origin-main-sha'")));
      assert(shell.calls.some((cmd) => cmd.includes("git push --force-with-lease='refs/heads/auto/integration:origin-integration-sha'")));
      assert(!shell.calls.some((cmd) => cmd.includes("git push --force-with-lease='refs/heads/auto/integration:stale-integration-sha'")));
    } finally {
      repo.cleanup();
    }
  });

  it('blocks when the local integration branch diverged from the freshly fetched remote', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      localIntegrationTip: 'stale-integration-sha',
      remoteIntegrationTip: 'origin-integration-sha',
      integrationRelation: 'diverged',
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        interactive: false,
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.blockReason, 'integration-diverged');
      assert.match(result.blockSummary ?? '', /auto\/integration diverged from origin\/auto\/integration/);
      assert.match(result.blockSummary ?? '', /local=stale-integration-sha/);
      assert.match(result.blockSummary ?? '', /remote=origin-integration-sha/);
      assert.match(result.blockSummary ?? '', /git fetch origin && git branch -f auto\/integration origin\/auto\/integration/);
      assert(!shell.calls.some((cmd) => cmd.includes("git push --force-with-lease")));
      assert(!shell.calls.some((cmd) => cmd.includes('gh pr create')));
      assert(!shell.calls.some((cmd) => cmd.includes("gh api --method PATCH")));
    } finally {
      repo.cleanup();
    }
  });

  it('blocks when fetching the integration remote fails', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      integrationFetchError: 'fatal: unable to access origin/auto/integration',
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        interactive: false,
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.blockReason, 'integration-unknown');
      assert.match(result.blockSummary ?? '', /failed to fetch origin\/auto\/integration/);
      assert(!shell.calls.some((cmd) => cmd.includes("git push --force-with-lease")));
      assert(!shell.calls.some((cmd) => cmd.includes('gh pr create')));
    } finally {
      repo.cleanup();
    }
  });

  it('blocks when fast-forwarding the checked out integration branch fails', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      localIntegrationTip: 'stale-integration-sha',
      remoteIntegrationTip: 'origin-integration-sha',
      integrationRelation: 'behind',
      currentBranch: 'auto/integration',
      integrationMergeFfError: 'fatal: Not possible to fast-forward',
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        interactive: false,
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.blockReason, 'integration-unknown');
      assert.match(result.blockSummary ?? '', /failed to fast-forward local integration ref auto\/integration/);
      assert(shell.calls.includes("git merge --ff-only 'origin/auto/integration'"));
      assert(!shell.calls.some((cmd) => cmd.includes("git push --force-with-lease")));
    } finally {
      repo.cleanup();
    }
  });

  it('blocks when the integration branch is behind the fetched remote promotion base', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      baseIntegrated: false,
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        interactive: false,
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.blockReason, 'base-behind');
      assert.match(result.blockSummary ?? '', /behind protected base/);
      assert.equal(result.prUrl, 'https://github.com/example/repo/pull/77');
      assert.match(result.checkSummary ?? '', /^passing:/);
      assert(shell.calls.includes("git fetch --quiet origin 'main'"));
      assert(shell.calls.includes("git rev-parse 'origin/main' 2>/dev/null"));
      assert(!shell.calls.some((cmd) => cmd.includes("git rev-parse 'main' 2>/dev/null")));
      assert(!shell.calls.some((cmd) => cmd.includes('gh api --method PATCH')));
      assert(!shell.calls.some((cmd) => cmd.includes('gh pr create')));
    } finally {
      repo.cleanup();
    }
  });

  it('blocks with base-unknown when fetching the remote promotion branch fails', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      fetchError: 'fatal: no such remote',
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        interactive: false,
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.blockReason, 'base-unknown');
      assert.match(result.blockSummary ?? '', /failed to fetch origin\/main/);
      assert(!shell.calls.some((cmd) => cmd.includes("git rev-parse 'main' 2>/dev/null")));
      assert(!shell.calls.some((cmd) => cmd.includes("git merge-base --is-ancestor 'main-sha'")));
    } finally {
      repo.cleanup();
    }
  });

  it('does not update the integration branch when the user declines a clean base update', async () => {
    const repo = makeRepo();
    const shell = shellHarness({ baseIntegrated: false });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        interactive: true,
        confirmUpdate: async () => false,
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.blockReason, 'base-behind');
      assert(shell.calls.includes("git merge-tree --write-tree 'auto/integration' 'origin/main'"));
      assert(!shell.calls.some((cmd) => cmd === "git switch 'auto/integration'"));
      assert(!shell.calls.some((cmd) => cmd === "git push origin 'auto/integration'"));
    } finally {
      repo.cleanup();
    }
  });

  it('updates the integration branch when the user accepts a clean base update', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      baseIntegrated: false,
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        healthChecker: async () => ({ state: 'healthy' }),
        interactive: true,
        confirmUpdate: async () => true,
      });

      assert.equal(result.status, 'updated');
      assert(shell.calls.includes("git fetch --quiet origin 'main' 'auto/integration'"));
      assert(shell.calls.includes("git switch 'auto/integration'"));
      assert(shell.calls.includes("git merge --no-edit 'origin/main'"));
      assert(shell.calls.includes("git push origin 'auto/integration'"));
      assert(shell.calls.filter((cmd) => cmd === "git rev-parse 'auto/integration' 2>/dev/null").length >= 2);
      assert(shell.calls.some((cmd) => cmd.includes("gh api --method PATCH 'repos/example/repo/pulls/77' --input")));
    } finally {
      repo.cleanup();
    }
  });

  it('auto-updates the integration branch in non-interactive mode when configured and clean', async () => {
    const repo = makeRepo({
      integration: {
        integrationBranch: 'auto/integration',
        promotionBranch: 'main',
        autoUpdatePromotionBranch: true,
      },
    });
    const shell = shellHarness({
      baseIntegrated: false,
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        healthChecker: async () => ({ state: 'healthy' }),
        interactive: false,
      });

      assert.equal(result.status, 'updated');
      assert(shell.calls.includes("git fetch --quiet origin 'main' 'auto/integration'"));
      assert(shell.calls.includes("git merge --no-edit 'origin/main'"));
      assert(shell.calls.includes("git push origin 'auto/integration'"));
    } finally {
      repo.cleanup();
    }
  });

  it('blocks with conflict guidance when merging the protected base would conflict', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      baseIntegrated: false,
      mergeTreeResult: 'conflicts',
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        interactive: true,
        confirmUpdate: async () => true,
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.blockReason, 'base-behind-conflicts');
      assert.match(result.blockSummary ?? '', /expected to conflict/);
      assert(!shell.calls.some((cmd) => cmd === "git switch 'auto/integration'"));
      assert(!shell.calls.some((cmd) => cmd === "git push origin 'auto/integration'"));
    } finally {
      repo.cleanup();
    }
  });

  it('classifies merge-tree exit status 1 as a conflict, not base-unknown', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      baseIntegrated: false,
      mergeTreeResult: 'conflicts-exit-status',
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        interactive: false,
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.blockReason, 'base-behind-conflicts');
      assert.match(result.blockSummary ?? '', /expected to conflict/);
      // The actionable remediation should be surfaced, not the cryptic
      // "unable to verify or update protected base" message.
      assert.match(result.blockSummary ?? '', /remediation:/);
      assert.doesNotMatch(result.blockSummary ?? '', /unable to verify/);
    } finally {
      repo.cleanup();
    }
  });

  it('blocks with base-unknown when merge prediction is unavailable', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      baseIntegrated: false,
      mergeTreeResult: 'unknown',
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        interactive: false,
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.blockReason, 'base-unknown');
      assert.match(result.blockSummary ?? '', /merge-tree unavailable/);
      assert(!shell.calls.some((cmd) => cmd === "git switch 'auto/integration'"));
    } finally {
      repo.cleanup();
    }
  });

  it('blocks instead of opening a direct conflicted PR on a protected integration branch by default', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      baseIntegrated: false,
      integrationTree: 'current-integration-tree',
      promotionTree: 'promoted-tree',
      integrationTreeLog: [
        'integration-sha current-integration-tree',
        'previous-integration-sha promoted-tree',
        'older-sha old-tree',
      ].join('\n'),
      branchProtection: 'force-push-disabled',
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        healthChecker: async () => ({ state: 'healthy' }),
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.blockReason, 'protected-integration-reconciliation-required');
      assert.equal(result.headBranch, 'auto/integration');
      assert.deepEqual(result.squashRecovery, {
        status: 'blocked',
        detail: 'matched promoted snapshot previous-integration-sha on auto/integration',
      });
      assert.match(result.blockSummary ?? '', /known-conflicted by ancestry/);
      assert.match(result.blockSummary ?? '', /use-promotion-head/);
      assert(!shell.calls.some((cmd) => cmd === "git update-ref 'refs/heads/auto/integration' 'reconciled-sha' 'integration-sha'"));
      assert(!shell.calls.some((cmd) => cmd.includes("git push --force-with-lease='refs/heads/auto/integration:integration-sha'")));
      assert(!shell.calls.some((cmd) => cmd.includes("gh api --method PATCH 'repos/example/repo/pulls/77' --input")));
      assert(!shell.calls.some((cmd) => cmd.includes('gh pr create')));
    } finally {
      repo.cleanup();
    }
  });

  it('blocks when protected-branch reconciliation policy is block', async () => {
    const repo = makeRepo({
      promotion: {
        protectedIntegrationStrategy: 'block',
      },
    });
    const shell = shellHarness({
      baseIntegrated: false,
      integrationTree: 'current-integration-tree',
      promotionTree: 'promoted-tree',
      integrationTreeLog: [
        'integration-sha current-integration-tree',
        'previous-integration-sha promoted-tree',
      ].join('\n'),
      branchProtection: 'required-status-checks',
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.blockReason, 'protected-integration-reconciliation-required');
      assert.deepEqual(result.squashRecovery, {
        status: 'blocked',
        detail: 'matched promoted snapshot previous-integration-sha on auto/integration',
      });
      assert.match(result.blockSummary ?? '', /reason=required-status-checks/);
      assert.match(result.blockSummary ?? '', /manual\/admin reconciliation required/);
      assert.equal(result.prUrl, 'https://github.com/example/repo/pull/77');
      assert(!shell.calls.some((cmd) => cmd.includes('git update-ref')));
      assert(!shell.calls.some((cmd) => cmd.includes('--force-with-lease')));
    } finally {
      repo.cleanup();
    }
  });

  it('blocks when branch protection cannot be verified even if skip is configured', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      baseIntegrated: false,
      integrationTree: 'current-integration-tree',
      promotionTree: 'promoted-tree',
      integrationTreeLog: [
        'integration-sha current-integration-tree',
        'previous-integration-sha promoted-tree',
      ].join('\n'),
      branchProtection: 'unknown',
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.blockReason, 'protected-integration-reconciliation-required');
      assert.deepEqual(result.squashRecovery, {
        status: 'blocked',
        detail: 'matched promoted snapshot previous-integration-sha on auto/integration',
      });
      assert.match(result.blockSummary ?? '', /reason=protection-unknown/);
      assert.match(result.blockSummary ?? '', /could not verify/);
      assert(!shell.calls.some((cmd) => cmd.includes('git update-ref')));
      assert(!shell.calls.some((cmd) => cmd.includes('--force-with-lease')));
    } finally {
      repo.cleanup();
    }
  });

  it('uses a dedicated promotion head when configured', async () => {
    const repo = makeRepo({
      promotion: {
        protectedIntegrationStrategy: 'use-promotion-head',
        promotionHeadBranch: 'auto/release-transport',
      },
    });
    const shell = shellHarness({
      baseIntegrated: false,
      integrationTree: 'current-integration-tree',
      promotionTree: 'promoted-tree',
      integrationTreeLog: [
        'integration-sha current-integration-tree',
        'previous-integration-sha promoted-tree',
      ].join('\n'),
      branchProtection: 'restricted-push',
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        healthChecker: async () => ({ state: 'healthy' }),
      });

      assert.equal(result.status, 'opened');
      assert.equal(result.headBranch, 'auto/release-transport');
      assert.deepEqual(result.squashRecovery, {
        status: 'applied-via-promotion-head',
        detail: 'matched promoted snapshot previous-integration-sha on auto/integration; head=auto/release-transport',
      });
      assert.match(result.infoSummary ?? '', /using dedicated promotion head auto\/release-transport/);
      assert(shell.calls.some((cmd) => cmd === "git update-ref 'refs/heads/auto/release-transport' 'reconciled-sha'"));
      assert(shell.calls.some((cmd) => cmd === "git push origin 'refs/heads/auto/release-transport:refs/heads/auto/release-transport'"));
      assert(!shell.calls.some((cmd) => cmd === "git update-ref 'refs/heads/auto/integration' 'reconciled-sha' 'integration-sha'"));
      assert(shell.calls.some((cmd) => cmd.includes("gh pr list --head 'auto/release-transport' --base 'main'")));
      assert(shell.calls.some((cmd) => cmd.includes("gh pr create --head 'auto/release-transport' --base 'main'")));
      const writtenBody = readFileSync('/tmp/promotion-body.txt', 'utf-8');
      assert.match(writtenBody, /auto\/release-transport/);
    } finally {
      repo.cleanup();
    }
  });

  it('blocks with manual cleanup guidance when the promotion head push is non-fast-forward', async () => {
    const repo = makeRepo({
      promotion: {
        protectedIntegrationStrategy: 'use-promotion-head',
      },
    });
    const shell = shellHarness({
      baseIntegrated: false,
      integrationTree: 'current-integration-tree',
      promotionTree: 'promoted-tree',
      integrationTreeLog: [
        'integration-sha current-integration-tree',
        'previous-integration-sha promoted-tree',
      ].join('\n'),
      branchProtection: 'protected-no-details',
      promotionHeadPushError: '[rejected] non-fast-forward',
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.blockReason, 'promotion-head-update-failed');
      assert.equal(result.headBranch, 'auto/promotion');
      assert.match(result.blockSummary ?? '', /Resolve or delete origin\/auto\/promotion/);
      assert(!shell.calls.some((cmd) => cmd.includes('gh pr create')));
    } finally {
      repo.cleanup();
    }
  });

  it('restores the local integration ref when an unprotected reconciliation push fails', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      baseIntegrated: false,
      integrationTree: 'current-integration-tree',
      promotionTree: 'promoted-tree',
      integrationTreeLog: [
        'integration-sha current-integration-tree',
        'previous-integration-sha promoted-tree',
        'older-sha old-tree',
      ].join('\n'),
      branchProtection: 'unprotected',
      pushError: 'remote hung up unexpectedly',
    });

    try {
      await assert.rejects(
        runPromotion({
          repoDir: repo.repoDir,
          shellRunner: shell.shellRunner,
          healthChecker: async () => ({ state: 'healthy' }),
        }),
        /failed to push reconciled integration branch: remote hung up unexpectedly/,
      );
      assert(shell.calls.some((cmd) => cmd === "git update-ref 'refs/heads/auto/integration' 'reconciled-sha' 'integration-sha'"));
      assert(shell.calls.some((cmd) => cmd === "git update-ref 'refs/heads/auto/integration' 'integration-sha' 'reconciled-sha'"));
      assert(!shell.calls.some((cmd) => cmd.includes('gh pr create')));
    } finally {
      repo.cleanup();
    }
  });

  it('reports pending checks without merging', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
      checks: [{ name: 'ci', state: 'IN_PROGRESS', conclusion: null }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
      });

      assert.equal(result.status, 'updated');
      assert.match(result.checkSummary ?? '', /^pending:/);
      assert(!shell.calls.some((cmd) => cmd.includes('pr merge')));
    } finally {
      repo.cleanup();
    }
  });

  it('reports pending checks when gh has not created checks yet', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
    });
    const shellRunner = (cmd: string, opts?: { encoding?: string; cwd?: string }) => {
      if (cmd.includes('gh pr checks')) {
        shell.calls.push(cmd);
        return "no checks reported on the 'auto/integration' branch";
      }
      return shell.shellRunner(cmd, opts);
    };

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner,
      });

      assert.equal(result.status, 'updated');
      assert.equal(result.checkSummary, 'pending: No PR checks reported.');
      assert(!shell.calls.some((cmd) => cmd.includes('pr merge')));
    } finally {
      repo.cleanup();
    }
  });

  it('reports failing checks without merging', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
      checks: [{ name: 'ci', state: 'COMPLETED', conclusion: 'failure' }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
      });

      assert.equal(result.status, 'updated');
      assert.match(result.checkSummary ?? '', /^failing:/);
      assert(!shell.calls.some((cmd) => cmd.includes('pr merge')));
    } finally {
      repo.cleanup();
    }
  });

  it('reports failing checks from gh bucket output without merging', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
      checks: [{ name: 'ci', state: 'COMPLETED', bucket: 'fail' }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
      });

      assert.equal(result.status, 'updated');
      assert.match(result.checkSummary ?? '', /^failing:/);
      assert.match(result.checkSummary ?? '', /ci: fail/);
      assert(!shell.calls.some((cmd) => cmd.includes('pr merge')));
    } finally {
      repo.cleanup();
    }
  });

  it('does not contain auto-merge logic', () => {
    const source = readFileSync(new URL('./promotion-controller.ts', import.meta.url), 'utf-8');
    assert(!source.includes('gh pr merge'));
  });
});

// ---------------------------------------------------------------------------
// HOK-3096: measureBranchBaseDistance (the HOK-3092 behind-base predicate,
// reused by the observer's stale-base detector)
// ---------------------------------------------------------------------------

type CountingShellRunner = (cmd: string, opts?: { encoding?: string; cwd?: string }) => string;

function countingShellRunner(counts: {
  originBehind?: string;
  originAhead?: string;
  localBehind?: string;
  localAhead?: string;
}): CountingShellRunner {
  return (cmd: string) => {
    if (cmd === "git rev-list --count 'task/foo'..'origin/main'") {
      if (counts.originBehind === undefined) throw new Error("fatal: ambiguous argument 'origin/main': unknown revision");
      return counts.originBehind;
    }
    if (cmd === "git rev-list --count 'origin/main'..'task/foo'") {
      if (counts.originAhead === undefined) throw new Error("fatal: ambiguous argument 'origin/main': unknown revision");
      return counts.originAhead;
    }
    if (cmd === "git rev-list --count 'task/foo'..'main'") {
      if (counts.localBehind === undefined) throw new Error("fatal: ambiguous argument 'main': unknown revision");
      return counts.localBehind;
    }
    if (cmd === "git rev-list --count 'main'..'task/foo'") {
      if (counts.localAhead === undefined) throw new Error("fatal: ambiguous argument 'main': unknown revision");
      return counts.localAhead;
    }
    throw new Error(`Unhandled command: ${cmd}`);
  };
}

describe('measureBranchBaseDistance', () => {
  it('reports counts against origin/<base> when the remote-tracking ref resolves', () => {
    const shellRunner = countingShellRunner({ originBehind: '7\n', originAhead: '2\n' });
    const distance = measureBranchBaseDistance('task/foo', 'main', '/repo', shellRunner);
    assert.deepEqual(distance, { behindBase: 7, aheadOfBase: 2, baseRef: 'origin/main' });
  });

  it('falls back to the local base ref when origin/<base> cannot be resolved', () => {
    const shellRunner = countingShellRunner({ localBehind: '3\n', localAhead: '0\n' });
    const distance = measureBranchBaseDistance('task/foo', 'main', '/repo', shellRunner);
    assert.deepEqual(distance, { behindBase: 3, aheadOfBase: 0, baseRef: 'main' });
  });

  it('degrades to an empty result when neither ref resolves, never throwing', () => {
    const shellRunner = countingShellRunner({});
    assert.doesNotThrow(() => {
      const distance = measureBranchBaseDistance('task/foo', 'main', '/repo', shellRunner);
      assert.deepEqual(distance, {});
    });
  });

  it('never fetches', () => {
    const source = readFileSync(new URL('./promotion-controller.ts', import.meta.url), 'utf-8');
    const start = source.indexOf('export function measureBranchBaseDistance');
    const end = source.indexOf('\nconst PROMOTION_SECTION_BEGIN', start);
    assert(start >= 0 && end > start, 'could not locate measureBranchBaseDistance body');
    const fnSource = source.slice(start, end);
    assert(!fnSource.includes('git fetch'));
  });
});
