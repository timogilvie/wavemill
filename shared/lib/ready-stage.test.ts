import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  runReadyStage,
  checkMergeConflicts,
  checkCIStatus,
  checkSchemaMigrations,
  checkMigrationBaseFreshness,
  checkMigrationChainIntegrity,
  checkForbiddenDDL,
  checkMigrationReversibility,
  checkDeployPaths,
  computeVerdict,
  checkLegacyMarkers,
  controllerCheckReadiness,
  MIGRATION_IRREVERSIBLE_LABEL,
  type ReadyResult,
  type ReadyCheck,
  type LegacyMarkerResult,
  type ControllerReadinessResult,
  type ReadyStageConfig,
} from './ready-stage.ts';
import * as readyStage from './ready-stage.ts';
import { writeTendAttemptFact } from './tend-attempt-fact.ts';
import { mkdtempSync, rmSync } from 'node:fs';

const migrationFixturesDir = path.resolve(process.cwd(), 'tests/fixtures/migrations');

function assertIso8601(timestamp: string) {
  assert.match(
    timestamp,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    'timestamp should be ISO 8601 UTC format'
  );
  assert.ok(!Number.isNaN(new Date(timestamp).getTime()));
}

async function writeRepoFiles(repoDir: string, files: Record<string, string>) {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(repoDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  }
}

function makePrContext(changedFiles: string[], labels: string[] = []) {
  return {
    prNumber: 42,
    diff: '',
    changedFiles,
    labels,
    branch: 'feature-branch',
    baseBranch: 'main',
    url: 'https://github.com/test/repo/pull/42',
    ciStatus: 'configured',
  };
}

async function loadMigrationFixture(name: string): Promise<string> {
  return fs.readFile(path.join(migrationFixturesDir, name), 'utf-8');
}

function makeExecError(message: string, status: number, stderr?: string) {
  const error = new Error(message) as Error & { status?: number; stderr?: string };
  error.status = status;
  error.stderr = stderr ?? message;
  return error;
}

describe('ready-stage', () => {
  describe('ReadyCheck contract', () => {
    it('accepts passing check objects', () => {
      const check = {
        name: 'ci-status',
        status: 'pass',
        message: 'All required checks passed',
      } satisfies ReadyCheck;

      assert.deepEqual(check, {
        name: 'ci-status',
        status: 'pass',
        message: 'All required checks passed',
      });
    });

    it('accepts failing check objects with details', () => {
      const check = {
        name: 'merge-conflicts',
        status: 'fail',
        message: 'PR has merge conflicts with main',
        details: {
          state: 'conflicted',
          conflictedFiles: ['src/app.ts'],
        },
      } satisfies ReadyCheck;

      assert.equal(check.status, 'fail');
      assert.deepEqual(check.details, {
        state: 'conflicted',
        conflictedFiles: ['src/app.ts'],
      });
    });

    it('accepts warning check objects', () => {
      const check = {
        name: 'release-notes',
        status: 'warn',
        message: 'Manual release notes update required',
      } satisfies ReadyCheck;

      assert.equal(check.status, 'warn');
      assert.equal(check.message, 'Manual release notes update required');
    });

    it('accepts skipped check objects', () => {
      const check = {
        name: 'manual-steps',
        status: 'skip',
        message: 'No manual steps detected',
      } satisfies ReadyCheck;

      assert.equal(check.status, 'skip');
      assert.equal(check.name, 'manual-steps');
    });

    it('accepts pending check objects', () => {
      const check = {
        name: 'ci-status',
        status: 'pending',
        message: 'CI checks are still running',
      } satisfies ReadyCheck;

      assert.equal(check.status, 'pending');
      assert.equal(check.name, 'ci-status');
    });
  });

  describe('ReadyResult contract', () => {
    it('accepts passing results with multiple checks', () => {
      const result = {
        prNumber: 42,
        verdict: 'pass',
        checks: [
          {
            name: 'ci-status',
            status: 'pass',
            message: 'All required checks passed',
          },
          {
            name: 'approvals',
            status: 'pass',
            message: 'Required approvals are present',
          },
        ],
        timestamp: '2026-04-08T12:00:00.000Z',
        summary: 'PR is ready to merge',
      } satisfies ReadyResult;

      assert.equal(result.verdict, 'pass');
      assert.equal(result.prNumber, 42);
      assert.equal(result.checks.length, 2);
      assertIso8601(result.timestamp);
    });

    it('accepts failing results', () => {
      const result = {
        prNumber: 77,
        verdict: 'fail',
        checks: [
          {
            name: 'merge-conflicts',
            status: 'fail',
            message: 'PR has merge conflicts',
          },
        ],
        timestamp: '2026-04-08T12:00:00.000Z',
        summary: 'Merge is blocked until conflicts are resolved',
      } satisfies ReadyResult;

      assert.equal(result.verdict, 'fail');
      assert.equal(result.checks[0]?.status, 'fail');
    });

    it('accepts warning results', () => {
      const result = {
        prNumber: 99,
        verdict: 'warn',
        checks: [
          {
            name: 'manual-steps',
            status: 'warn',
            message: 'Post-merge release checklist still required',
          },
        ],
        timestamp: '2026-04-08T12:00:00.000Z',
        summary: 'Ready with manual follow-up',
      } satisfies ReadyResult;

      assert.equal(result.verdict, 'warn');
      assert.equal(result.summary, 'Ready with manual follow-up');
    });

    it('accepts pending results', () => {
      const result = {
        prNumber: 100,
        verdict: 'pending',
        checks: [
          {
            name: 'ci-status',
            status: 'pending',
            message: 'CI checks are still running',
          },
        ],
        timestamp: '2026-04-08T12:00:00.000Z',
        summary: 'CI checks still in progress - will retry',
      } satisfies ReadyResult;

      assert.equal(result.verdict, 'pending');
      assert.equal(result.checks[0]?.status, 'pending');
    });
  });

  describe('ReadyStageConfig contract', () => {
    it('supports specific checks lists', () => {
      const config = {
        checks: ['ci-status', 'approvals', 'merge-conflicts'],
      } satisfies ReadyStageConfig;

      assert.deepEqual(config.checks, ['ci-status', 'approvals', 'merge-conflicts']);
    });

    it('supports required checks as a subset', () => {
      const config = {
        checks: ['ci-status', 'approvals', 'release-notes'],
        requiredChecks: ['ci-status', 'approvals'],
      } satisfies ReadyStageConfig;

      assert.deepEqual(config.requiredChecks, ['ci-status', 'approvals']);
    });

    it('supports backwards-compatible missing ready config', () => {
      const config = {} satisfies ReadyStageConfig;

      assert.deepEqual(config, {});
    });
  });

  describe('checkSchemaMigrations', () => {
    it('returns skip when no schema files changed', () => {
      const result = checkSchemaMigrations(['src/app.ts', 'README.md'], '/tmp/test');
      assert.equal(result.status, 'skip');
      assert.equal(result.name, 'schema-migrations');
      assert.match(result.message, /No schema changes/);
    });

    it('returns fail when schema changed without migration', () => {
      const result = checkSchemaMigrations(['prisma/schema.prisma', 'src/app.ts'], '/tmp/test');
      assert.equal(result.status, 'fail');
      assert.equal(result.name, 'schema-migrations');
      assert.match(result.message, /without migration/);
      assert.ok(result.details?.schemaFiles);
    });

    it('returns pass when both schema and migration changed', () => {
      const result = checkSchemaMigrations(
        ['prisma/schema.prisma', 'prisma/migrations/001_init.sql', 'src/app.ts'],
        '/tmp/test'
      );
      assert.equal(result.status, 'pass');
      assert.equal(result.name, 'schema-migrations');
      assert.match(result.message, /corresponding migrations/);
    });

    it('detects Django models.py as schema file', () => {
      const result = checkSchemaMigrations(['app/models.py'], '/tmp/test');
      assert.equal(result.status, 'fail');
    });

    it('detects alembic migrations', () => {
      const result = checkSchemaMigrations(
        ['app/models.py', 'alembic/versions/001_init.py'],
        '/tmp/test'
      );
      assert.equal(result.status, 'pass');
    });
  });

  describe('checkDeployPaths', () => {
    it('always returns skip for v1', () => {
      const result = checkDeployPaths(['src/app.ts'], {});
      assert.equal(result.status, 'skip');
      assert.equal(result.name, 'deploy-paths');
      assert.match(result.message, /not configured/);
    });
  });

  describe('checkMigrationChainIntegrity', () => {
    let repoDir: string;

    beforeEach(async () => {
      repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-migrations-'));
    });

    afterEach(async () => {
      await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('passes on a valid linear chain', async () => {
      await writeRepoFiles(repoDir, {
        'migrations/versions/001_base.py': 'revision = "001"\ndown_revision = None\n',
        'migrations/versions/002_next.py': 'revision = "002"\ndown_revision = "001"\n',
      });

      const result = await checkMigrationChainIntegrity(repoDir);
      assert.equal(result.status, 'pass');
      assert.equal(result.name, 'migration-chain-integrity');
    });

    it('supports annotated Alembic revision identifiers', async () => {
      await writeRepoFiles(repoDir, {
        'migrations/versions/001_base.py': [
          'revision: str = "001"',
          'down_revision: Union[str, None] = None',
          '',
        ].join('\n'),
        'migrations/versions/002_next.py': [
          'revision: str = "002"',
          'down_revision: Union[str, None] = "001"',
          '',
        ].join('\n'),
      });

      const result = await checkMigrationChainIntegrity(repoDir);
      assert.equal(result.status, 'pass');
      assert.equal(result.name, 'migration-chain-integrity');
    });

    it('supports Alembic merge revisions with multiple down revisions', async () => {
      await writeRepoFiles(repoDir, {
        'migrations/versions/001_base.py': 'revision = "001"\ndown_revision = None\n',
        'migrations/versions/002_a.py': 'revision = "002_a"\ndown_revision = "001"\n',
        'migrations/versions/002_b.py': 'revision = "002_b"\ndown_revision = "001"\n',
        'migrations/versions/003_merge.py': 'revision = "003"\ndown_revision = ("002_a", "002_b")\n',
      });

      const result = await checkMigrationChainIntegrity(repoDir);
      assert.equal(result.status, 'pass');
      assert.equal(result.name, 'migration-chain-integrity');
    });

    it('ignores Alembic support files outside the versions directory', async () => {
      await writeRepoFiles(repoDir, {
        'migrations/env.py': 'from alembic import context\n',
        // allow-template-curly: Mako migration template syntax, not JavaScript interpolation.
        'migrations/script.py.mako': '${upgrades if upgrades else "pass"}\n',
        'migrations/versions/001_base.py': 'revision = "001"\ndown_revision = None\n',
        'migrations/versions/002_next.py': 'revision = "002"\ndown_revision = "001"\n',
      });

      const result = await checkMigrationChainIntegrity(repoDir);
      assert.equal(result.status, 'pass');
      assert.deepEqual(result.details?.migrationFiles, [
        'migrations/versions/001_base.py',
        'migrations/versions/002_next.py',
      ]);
    });

    it('ignores non-Alembic Python helpers that match broad migration patterns', async () => {
      await writeRepoFiles(repoDir, {
        'shared/db/migrations/apply_ttl_migration.py': 'def apply():\n    pass\n',
        'shared/db/migrations/004_add_user_org_to_leads.py': 'print("apply migration")\n',
      });

      const result = await checkMigrationChainIntegrity(repoDir);
      assert.equal(result.status, 'skip');
      assert.match(result.message, /No Alembic revision files/);
      const skipped = result.details?.skippedFiles as Array<Record<string, unknown>>;
      assert.equal(skipped.length, 2);
    });

    it('fails on duplicate revision IDs', async () => {
      await writeRepoFiles(repoDir, {
        'migrations/versions/001_base.py': 'revision = "001"\ndown_revision = None\n',
        'migrations/versions/001_duplicate.py': 'revision = "001"\ndown_revision = None\n',
      });

      const result = await checkMigrationChainIntegrity(repoDir);
      assert.equal(result.status, 'fail');
      assert.match(result.message, /Duplicate migration revision IDs/);
      assert.match(result.message, /001 .*001_base\.py, migrations\/versions\/001_duplicate\.py/);
      assert.ok(Array.isArray(result.details?.duplicateRevisions));
    });

    it('fails on dangling down_revision', async () => {
      await writeRepoFiles(repoDir, {
        'migrations/versions/002_next.py': 'revision = "002"\ndown_revision = "001"\n',
      });

      const result = await checkMigrationChainIntegrity(repoDir);
      assert.equal(result.status, 'fail');
      assert.match(result.message, /unresolved down_revision/);
    });

    it('fails when the graph has two heads', async () => {
      await writeRepoFiles(repoDir, {
        'migrations/versions/001_base.py': 'revision = "001"\ndown_revision = None\n',
        'migrations/versions/002_a.py': 'revision = "002_a"\ndown_revision = "001"\n',
        'migrations/versions/002_b.py': 'revision = "002_b"\ndown_revision = "001"\n',
      });

      const result = await checkMigrationChainIntegrity(repoDir);
      assert.equal(result.status, 'fail');
      assert.match(result.message, /exactly one head/);
      assert.match(result.message, /002_a \(migrations\/versions\/002_a\.py\)/);
      assert.match(result.message, /002_b \(migrations\/versions\/002_b\.py\)/);
      assert.equal((result.details?.heads as unknown[])?.length, 2);
    });

    it('fails when the graph has a cycle', async () => {
      await writeRepoFiles(repoDir, {
        'migrations/versions/001_a.py': 'revision = "001"\ndown_revision = "003"\n',
        'migrations/versions/002_b.py': 'revision = "002"\ndown_revision = "001"\n',
        'migrations/versions/003_c.py': 'revision = "003"\ndown_revision = "002"\n',
      });

      const result = await checkMigrationChainIntegrity(repoDir);
      assert.equal(result.status, 'fail');
      assert.match(result.message, /contains a cycle/);
      assert.ok(result.details?.cycle);
    });

    it('skips when the repository has no migration files', async () => {
      await writeRepoFiles(repoDir, {
        'src/app.ts': 'export const ok = true;\n',
      });

      const result = await checkMigrationChainIntegrity(repoDir);
      assert.equal(result.status, 'skip');
      assert.match(result.message, /No migration files/);
    });

    it('honors configured migration patterns', async () => {
      await writeRepoFiles(repoDir, {
        '.wavemill-config.json': JSON.stringify({
          ready: {
            migrationPatterns: ['db/revisions/'],
            checks: ['migration-chain-integrity'],
          },
        }),
        'db/revisions/001_base.py': 'revision = "001"\ndown_revision = None\n',
        'db/revisions/002_next.py': 'revision = "002"\ndown_revision = "001"\n',
      });

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd.includes('gh pr view')) {
          if (cmd.includes('mergeable,mergeStateStatus')) {
            return JSON.stringify({
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'CLEAN',
            });
          }

          return JSON.stringify({
            number: 42,
            headRefName: 'feature-branch',
            baseRefName: 'main',
            url: 'https://github.com/test/repo/pull/42',
            files: [],
          });
        }
        if (cmd.includes('gh pr diff')) {
          return '';
        }
        if (cmd.includes('gh pr checks')) {
          return JSON.stringify([]);
        }
        return '';
      });

      try {
        const result = await runReadyStage({ prNumber: 42, repoDir });
        assert.equal(result.verdict, 'warn');
        assert.equal(result.checks.find((check) => check.name === 'migration-base-refresh')?.status, 'warn');
        const migrationCheck = result.checks.find((check) => check.name === 'migration-chain-integrity');
        assert.equal(migrationCheck?.status, 'pass');
      } finally {
        execMock.mock.restore();
      }
    });

    it('skips for sql migration kind', async () => {
      const result = await checkMigrationChainIntegrity(repoDir, ['migrations/.*\\.sql$'], 'sql');
      assert.equal(result.status, 'skip');
      assert.match(result.message, /unsupported.*sql/i);
    });

    it('evaluates against the merge tree and names both heads', async () => {
      const commands: string[] = [];
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        commands.push(cmd);
        if (cmd === "git fetch --quiet origin 'main'") return '';
        if (cmd === "git merge-tree --write-tree 'origin/main' HEAD") return 'merge-tree-oid\n';
        if (cmd === "git ls-tree -r --name-only 'merge-tree-oid'") {
          return [
            'alembic/versions/043_base.py',
            'alembic/versions/044_main.py',
            'alembic/versions/045_branch.py',
          ].join('\n');
        }
        if (cmd === "git show 'merge-tree-oid:alembic/versions/043_base.py'") {
          return 'revision = "043"\ndown_revision = None\n';
        }
        if (cmd === "git show 'merge-tree-oid:alembic/versions/044_main.py'") {
          return 'revision = "044"\ndown_revision = "043"\n';
        }
        if (cmd === "git show 'merge-tree-oid:alembic/versions/045_branch.py'") {
          return 'revision = "045"\ndown_revision = "043"\n';
        }
        throw new Error(`unexpected command: ${cmd}`);
      });

      try {
        const result = await checkMigrationChainIntegrity(
          repoDir,
          ['alembic/versions/.*\\.py$'],
          'alembic',
          { baseRef: 'main' }
        );
        assert.equal(result.status, 'fail');
        assert.equal(result.details?.evaluatedAgainst, 'merge-tree');
        assert.equal(result.details?.baseRef, 'main');
        assert.equal(result.details?.treeOid, 'merge-tree-oid');
        assert.match(result.message, /found 2: 044 \(alembic\/versions\/044_main\.py\), 045 \(alembic\/versions\/045_branch\.py\)/);
        assert.ok(commands.some(cmd => cmd.includes("git merge-tree --write-tree 'origin/main' HEAD")));
      } finally {
        execMock.mock.restore();
      }
    });

    it('falls back to the worktree when merge-tree reports conflicts', async () => {
      await writeRepoFiles(repoDir, {
        'migrations/versions/001_base.py': 'revision = "001"\ndown_revision = None\n',
        'migrations/versions/002_next.py': 'revision = "002"\ndown_revision = "001"\n',
      });

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd === "git fetch --quiet origin 'main'") return '';
        if (cmd === "git merge-tree --write-tree 'origin/main' HEAD") {
          throw makeExecError('merge conflict', 1, 'merge conflict');
        }
        throw new Error(`unexpected command: ${cmd}`);
      });

      try {
        const result = await checkMigrationChainIntegrity(
          repoDir,
          ['migrations/versions/.*\\.py$'],
          'alembic',
          { baseRef: 'main' }
        );
        assert.equal(result.status, 'pass');
        assert.equal(result.details?.evaluatedAgainst, 'worktree');
        assert.deepEqual(result.details?.mergeContext, {
          source: 'worktree-fallback',
          reason: 'merge-conflict',
        });
      } finally {
        execMock.mock.restore();
      }
    });

    it('falls back to the worktree when merge-tree is unavailable', async () => {
      await writeRepoFiles(repoDir, {
        'migrations/versions/001_base.py': 'revision = "001"\ndown_revision = None\n',
        'migrations/versions/002_next.py': 'revision = "002"\ndown_revision = "001"\n',
      });

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd === "git fetch --quiet origin 'main'") return '';
        if (cmd === "git merge-tree --write-tree 'origin/main' HEAD") {
          throw makeExecError('git merge-tree unsupported', 128, 'git: merge-tree unsupported');
        }
        throw new Error(`unexpected command: ${cmd}`);
      });

      try {
        const result = await checkMigrationChainIntegrity(
          repoDir,
          ['migrations/versions/.*\\.py$'],
          'alembic',
          { baseRef: 'main' }
        );
        assert.equal(result.status, 'pass');
        assert.equal(result.details?.evaluatedAgainst, 'worktree');
        assert.deepEqual(result.details?.mergeContext, {
          source: 'worktree-fallback',
          reason: 'git-unavailable',
        });
      } finally {
        execMock.mock.restore();
      }
    });

    it('keeps the old worktree-only behavior when baseRef is omitted', async () => {
      await writeRepoFiles(repoDir, {
        'migrations/versions/001_base.py': 'revision = "001"\ndown_revision = None\n',
        'migrations/versions/002_next.py': 'revision = "002"\ndown_revision = "001"\n',
      });

      const commands: string[] = [];
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        commands.push(cmd);
        throw new Error(`unexpected command: ${cmd}`);
      });

      try {
        const result = await checkMigrationChainIntegrity(repoDir);
        assert.equal(result.status, 'pass');
        assert.equal(result.details?.evaluatedAgainst, 'worktree');
        assert.deepEqual(commands, []);
      } finally {
        execMock.mock.restore();
      }
    });
  });

  describe('checkMigrationBaseFreshness', () => {
    let repoDir: string;

    beforeEach(async () => {
      repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-migration-freshness-'));
    });

    afterEach(async () => {
      await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('detects when the base branch advanced after branch creation', async () => {
      await writeRepoFiles(repoDir, {
        'alembic/versions/043_base.py': 'revision = "043"\ndown_revision = None\n',
        'alembic/versions/045_branch.py': 'revision = "045"\ndown_revision = "043"\n',
      });

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd === "git fetch --quiet origin 'main'") return '';
        if (cmd === "git ls-tree -r --name-only 'origin/main'") {
          return 'alembic/versions/043_base.py\nalembic/versions/044_main.py\n';
        }
        if (cmd === "git show 'origin/main:alembic/versions/043_base.py'") {
          return 'revision = "043"\ndown_revision = None\n';
        }
        if (cmd === "git show 'origin/main:alembic/versions/044_main.py'") {
          return 'revision = "044"\ndown_revision = "043"\n';
        }
        throw new Error(`unexpected command: ${cmd}`);
      });

      try {
        const result = await checkMigrationBaseFreshness({
          repoDir,
          changedFiles: ['alembic/versions/045_branch.py'],
          baseBranch: 'main',
          migrationPatternSources: ['alembic/versions/.*\\.py$'],
          migrationKind: 'alembic',
        });
        assert.equal(result.status, 'fail');
        assert.match(result.message, /044/);
        assert.match(result.message, /045/);
        assert.equal(result.details?.baseHead, '044');
        assert.equal(result.details?.branchHead, '045');
      } finally {
        execMock.mock.restore();
      }
    });

    it('names both revisions verbatim in the remediation prompt', async () => {
      await writeRepoFiles(repoDir, {
        'alembic/versions/a1b2c3d4e5f6_base.py': 'revision = "a1b2c3d4e5f6"\ndown_revision = None\n',
        'alembic/versions/9f8e7d6c5b4a_branch.py': 'revision = "9f8e7d6c5b4a"\ndown_revision = "a1b2c3d4e5f6"\n',
      });

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd === "git fetch --quiet origin 'main'") return '';
        if (cmd === "git ls-tree -r --name-only 'origin/main'") {
          return 'alembic/versions/a1b2c3d4e5f6_base.py\nalembic/versions/0aaabbbcccdd_main.py\n';
        }
        if (cmd === "git show 'origin/main:alembic/versions/a1b2c3d4e5f6_base.py'") {
          return 'revision = "a1b2c3d4e5f6"\ndown_revision = None\n';
        }
        if (cmd === "git show 'origin/main:alembic/versions/0aaabbbcccdd_main.py'") {
          return 'revision = "0aaabbbcccdd"\ndown_revision = "a1b2c3d4e5f6"\n';
        }
        throw new Error(`unexpected command: ${cmd}`);
      });

      try {
        const result = await checkMigrationBaseFreshness({
          repoDir,
          changedFiles: ['alembic/versions/9f8e7d6c5b4a_branch.py'],
          baseBranch: 'main',
          migrationPatternSources: ['alembic/versions/.*\\.py$'],
          migrationKind: 'alembic',
        });
        assert.equal(result.status, 'fail');
        assert.match(result.message, /0aaabbbcccdd/);
        assert.match(result.message, /9f8e7d6c5b4a/);
      } finally {
        execMock.mock.restore();
      }
    });

    it('passes when the branch head is based on the current base head', async () => {
      await writeRepoFiles(repoDir, {
        'alembic/versions/043_base.py': 'revision = "043"\ndown_revision = None\n',
        'alembic/versions/044_main.py': 'revision = "044"\ndown_revision = "043"\n',
        'alembic/versions/045_branch.py': 'revision = "045"\ndown_revision = "044"\n',
      });

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd === "git fetch --quiet origin 'main'") return '';
        if (cmd === "git ls-tree -r --name-only 'origin/main'") {
          return 'alembic/versions/043_base.py\nalembic/versions/044_main.py\n';
        }
        if (cmd === "git show 'origin/main:alembic/versions/043_base.py'") {
          return 'revision = "043"\ndown_revision = None\n';
        }
        if (cmd === "git show 'origin/main:alembic/versions/044_main.py'") {
          return 'revision = "044"\ndown_revision = "043"\n';
        }
        throw new Error(`unexpected command: ${cmd}`);
      });

      try {
        const result = await checkMigrationBaseFreshness({
          repoDir,
          changedFiles: ['alembic/versions/045_branch.py'],
          baseBranch: 'main',
          migrationPatternSources: ['alembic/versions/.*\\.py$'],
          migrationKind: 'alembic',
        });
        assert.equal(result.status, 'pass');
        assert.match(result.message, /based on the current base head/);
      } finally {
        execMock.mock.restore();
      }
    });

    it('passes when the branch migration head matches the base head', async () => {
      await writeRepoFiles(repoDir, {
        'alembic/versions/043_base.py': 'revision = "043"\ndown_revision = None\n',
        'alembic/versions/044_main.py': 'revision = "044"\ndown_revision = "043"\n',
      });

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd === "git fetch --quiet origin 'main'") return '';
        if (cmd === "git ls-tree -r --name-only 'origin/main'") {
          return 'alembic/versions/043_base.py\nalembic/versions/044_main.py\n';
        }
        if (cmd === "git show 'origin/main:alembic/versions/043_base.py'") {
          return 'revision = "043"\ndown_revision = None\n';
        }
        if (cmd === "git show 'origin/main:alembic/versions/044_main.py'") {
          return 'revision = "044"\ndown_revision = "043"\n';
        }
        throw new Error(`unexpected command: ${cmd}`);
      });

      try {
        const result = await checkMigrationBaseFreshness({
          repoDir,
          changedFiles: ['alembic/versions/044_main.py'],
          baseBranch: 'main',
          migrationPatternSources: ['alembic/versions/.*\\.py$'],
          migrationKind: 'alembic',
        });
        assert.equal(result.status, 'pass');
        assert.equal(result.details?.baseHead, '044');
        assert.equal(result.details?.branchHead, '044');
      } finally {
        execMock.mock.restore();
      }
    });

    it('does not fetch when no migration files changed', async () => {
      const commands: string[] = [];
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        commands.push(cmd);
        throw new Error(`unexpected command: ${cmd}`);
      });

      try {
        const result = await checkMigrationBaseFreshness({
          repoDir,
          changedFiles: ['src/app.ts'],
          baseBranch: 'main',
          migrationPatternSources: ['alembic/versions/.*\\.py$'],
          migrationKind: 'alembic',
        });
        assert.equal(result.status, 'skip');
        assert.match(result.message, /No migration files changed/i);
        assert.equal(commands.filter(cmd => cmd.startsWith('git fetch')).length, 0);
      } finally {
        execMock.mock.restore();
      }
    });

    it('fetches exactly once when migration files changed', async () => {
      await writeRepoFiles(repoDir, {
        'alembic/versions/043_base.py': 'revision = "043"\ndown_revision = None\n',
        'alembic/versions/044_branch.py': 'revision = "044"\ndown_revision = "043"\n',
      });

      const commands: string[] = [];
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        commands.push(cmd);
        if (cmd === "git fetch --quiet origin 'main'") return '';
        if (cmd === "git ls-tree -r --name-only 'origin/main'") {
          return 'alembic/versions/043_base.py\n';
        }
        if (cmd === "git show 'origin/main:alembic/versions/043_base.py'") {
          return 'revision = "043"\ndown_revision = None\n';
        }
        throw new Error(`unexpected command: ${cmd}`);
      });

      try {
        const result = await checkMigrationBaseFreshness({
          repoDir,
          changedFiles: ['alembic/versions/044_branch.py'],
          baseBranch: 'main',
          migrationPatternSources: ['alembic/versions/.*\\.py$'],
          migrationKind: 'alembic',
        });
        assert.equal(result.status, 'pass');
        assert.equal(commands.filter(cmd => cmd.startsWith('git fetch --quiet origin')).length, 1);
      } finally {
        execMock.mock.restore();
      }
    });

    it('warns gracefully when fetch fails', async () => {
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd === "git fetch --quiet origin 'main'") {
          throw makeExecError('fetch denied', 128);
        }
        throw new Error(`unexpected command: ${cmd}`);
      });

      try {
        const result = await checkMigrationBaseFreshness({
          repoDir,
          changedFiles: ['alembic/versions/045_branch.py'],
          baseBranch: 'main',
          migrationPatternSources: ['alembic/versions/.*\\.py$'],
          migrationKind: 'alembic',
        });
        assert.equal(result.status, 'warn');
        assert.match(result.message, /could not verify base migration head/i);
      } finally {
        execMock.mock.restore();
      }
    });

    it('warns when the base branch has ambiguous heads', async () => {
      await writeRepoFiles(repoDir, {
        'alembic/versions/043_base.py': 'revision = "043"\ndown_revision = None\n',
        'alembic/versions/045_branch.py': 'revision = "045"\ndown_revision = "043"\n',
      });

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd === "git fetch --quiet origin 'main'") return '';
        if (cmd === "git ls-tree -r --name-only 'origin/main'") {
          return [
            'alembic/versions/043_base.py',
            'alembic/versions/044_a.py',
            'alembic/versions/044_b.py',
          ].join('\n');
        }
        if (cmd === "git show 'origin/main:alembic/versions/043_base.py'") {
          return 'revision = "043"\ndown_revision = None\n';
        }
        if (cmd === "git show 'origin/main:alembic/versions/044_a.py'") {
          return 'revision = "044_a"\ndown_revision = "043"\n';
        }
        if (cmd === "git show 'origin/main:alembic/versions/044_b.py'") {
          return 'revision = "044_b"\ndown_revision = "043"\n';
        }
        throw new Error(`unexpected command: ${cmd}`);
      });

      try {
        const result = await checkMigrationBaseFreshness({
          repoDir,
          changedFiles: ['alembic/versions/045_branch.py'],
          baseBranch: 'main',
          migrationPatternSources: ['alembic/versions/.*\\.py$'],
          migrationKind: 'alembic',
        });
        assert.equal(result.status, 'warn');
        assert.equal((result.details?.baseHeads as unknown[])?.length, 2);
      } finally {
        execMock.mock.restore();
      }
    });

    it('warns when a branch migration cannot be parsed', async () => {
      await writeRepoFiles(repoDir, {
        'alembic/versions/043_base.py': 'revision = "043"\ndown_revision = None\n',
        'alembic/versions/045_branch.py': 'revision = "045"\n',
      });

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd === "git fetch --quiet origin 'main'") return '';
        if (cmd === "git ls-tree -r --name-only 'origin/main'") {
          return 'alembic/versions/043_base.py\nalembic/versions/044_main.py\n';
        }
        if (cmd === "git show 'origin/main:alembic/versions/043_base.py'") {
          return 'revision = "043"\ndown_revision = None\n';
        }
        if (cmd === "git show 'origin/main:alembic/versions/044_main.py'") {
          return 'revision = "044"\ndown_revision = "043"\n';
        }
        throw new Error(`unexpected command: ${cmd}`);
      });

      try {
        const result = await checkMigrationBaseFreshness({
          repoDir,
          changedFiles: ['alembic/versions/045_branch.py'],
          baseBranch: 'main',
          migrationPatternSources: ['alembic/versions/.*\\.py$'],
          migrationKind: 'alembic',
        });
        assert.equal(result.status, 'warn');
        assert.equal(result.details?.file, 'alembic/versions/045_branch.py');
      } finally {
        execMock.mock.restore();
      }
    });

    it('skips for non-alembic migration kinds', async () => {
      const result = await checkMigrationBaseFreshness({
        repoDir,
        changedFiles: ['migrations/001.sql'],
        baseBranch: 'main',
        migrationPatternSources: ['migrations/.*\\.sql$'],
        migrationKind: 'sql',
      });
      assert.equal(result.status, 'skip');
      assert.match(result.message, /unsupported.*sql/i);
    });

    it('wires migration-base-freshness through runReadyStage', async () => {
      await writeRepoFiles(repoDir, {
        '.wavemill-config.json': JSON.stringify({
          ready: {
            checks: ['migration-base-freshness'],
            requiredChecks: ['migration-base-freshness'],
            migrationKind: 'alembic',
            migrationPatterns: ['alembic/versions/.*\\.py$'],
          },
        }),
        'alembic/versions/043_base.py': 'revision = "043"\ndown_revision = None\n',
        'alembic/versions/045_branch.py': 'revision = "045"\ndown_revision = "043"\n',
      });

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd.includes('gh pr view') && !cmd.includes('mergeable,mergeStateStatus')) {
          return JSON.stringify({
            number: 42,
            headRefName: 'feature-branch',
            baseRefName: 'main',
            url: 'https://github.com/test/repo/pull/42',
            files: [{ path: 'alembic/versions/045_branch.py' }],
            labels: [],
          });
        }
        if (cmd.includes('gh pr checks')) {
          return JSON.stringify([]);
        }
        if (cmd === "git fetch --quiet origin 'main'") return '';
        if (cmd === "git ls-tree -r --name-only 'origin/main'") {
          return 'alembic/versions/043_base.py\nalembic/versions/044_main.py\n';
        }
        if (cmd === "git show 'origin/main:alembic/versions/043_base.py'") {
          return 'revision = "043"\ndown_revision = None\n';
        }
        if (cmd === "git show 'origin/main:alembic/versions/044_main.py'") {
          return 'revision = "044"\ndown_revision = "043"\n';
        }
        throw new Error(`unexpected command: ${cmd}`);
      });

      try {
        const result = await runReadyStage({ prNumber: 42, repoDir });
        const check = result.checks.find(entry => entry.name === 'migration-base-freshness');
        assert.ok(check);
        assert.equal(check.status, 'fail');
        assert.match(check.message, /044/);
        assert.match(check.message, /045/);
      } finally {
        execMock.mock.restore();
      }
    });
  });

  describe('checkForbiddenDDL', () => {
    let repoDir: string;
    const fixtureDir = path.join(process.cwd(), 'tests/fixtures/forbidden-ddl');

    async function writeFixture(relativeName: string, targetName = relativeName) {
      const content = await fs.readFile(path.join(fixtureDir, relativeName), 'utf-8');
      await writeRepoFiles(repoDir, {
        [`alembic/versions/${targetName}`]: content,
      });
    }

    beforeEach(async () => {
      repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forbidden-ddl-'));
      const analyzer = await fs.readFile(path.join(process.cwd(), 'shared/lib/forbidden-ddl-analyzer.py'), 'utf-8');
      await writeRepoFiles(repoDir, {
        'shared/lib/forbidden-ddl-analyzer.py': analyzer,
      });
    });

    afterEach(async () => {
      await fs.rm(repoDir, { recursive: true, force: true });
    });

    it('skips when no migration files changed', () => {
      const spawnMock = mock.method(readyStage.readyStageDeps, 'spawnPython', () => {
        throw new Error('should not be called');
      });

      try {
        const result = checkForbiddenDDL(makePrContext(['src/app.ts']), repoDir);
        assert.equal(result.status, 'skip');
        assert.equal(result.message, 'No migration files changed');
      } finally {
        spawnMock.mock.restore();
      }
    });

    it('fails on add_column(nullable=False) without server_default', async () => {
      await writeFixture('add_column_non_nullable_no_default.py');
      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/add_column_non_nullable_no_default.py']),
        repoDir
      );
      assert.equal(result.status, 'fail');
      assert.match(result.message, /require changes|acknowledgment/);
    });

    it('passes on add_column(nullable=False) with server_default', async () => {
      await writeFixture('add_column_non_nullable_with_default.py');
      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/add_column_non_nullable_with_default.py']),
        repoDir
      );
      assert.equal(result.status, 'pass');
    });

    it('fails on destructive drops without label', async () => {
      await writeFixture('drop_column.py');
      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/drop_column.py']),
        repoDir
      );
      assert.equal(result.status, 'fail');
      assert.deepEqual((result.details?.labels as string[]) ?? [], []);
    });

    it('passes destructive drops when the required label is present', async () => {
      await writeFixture('drop_table.py');
      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/drop_table.py'], ['migration:destructive']),
        repoDir
      );
      assert.equal(result.status, 'pass');
      assert.equal((result.details?.acknowledgedFindings as unknown[])?.length, 1);
    });

    it('warns on alter_column(type_=...) without label', async () => {
      await writeFixture('alter_column_type.py');
      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/alter_column_type.py']),
        repoDir
      );
      assert.equal(result.status, 'warn');
      assert.match(JSON.stringify(result.details), /migration:long-running/);
    });

    it('passes alter_column(type_=...) with label acknowledgment', async () => {
      await writeFixture('alter_column_type.py', 'alter_column_type_ack.py');
      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/alter_column_type_ack.py'], ['migration:long-running']),
        repoDir
      );
      assert.equal(result.status, 'pass');
    });

    it('warns on execute update statements', async () => {
      await writeFixture('execute_update.py');
      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/execute_update.py']),
        repoDir
      );
      assert.equal(result.status, 'warn');
      assert.match(JSON.stringify(result.details), /online job/);
    });

    it('does not trigger on dangerous strings inside literals', async () => {
      await writeFixture('string_literal_false_positive.py');
      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/string_literal_false_positive.py']),
        repoDir
      );
      assert.equal(result.status, 'pass');
    });

    it('fails closed on syntax errors', async () => {
      await writeFixture('syntax_error.py');
      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/syntax_error.py']),
        repoDir
      );
      assert.equal(result.status, 'fail');
      assert.match(result.message, /could not parse/);
    });

    it('passes alter_column without type_ (no finding)', async () => {
      await writeFixture('alter_column_no_type.py');
      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/alter_column_no_type.py']),
        repoDir
      );
      assert.equal(result.status, 'pass');
    });

    it('passes execute with CREATE INDEX CONCURRENTLY (no execute_dml finding)', async () => {
      await writeFixture('execute_create_index.py');
      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/execute_create_index.py']),
        repoDir
      );
      assert.equal(result.status, 'pass');
    });

    it('uses Wavemill analyzer when the target repo does not contain one', async () => {
      await fs.rm(path.join(repoDir, 'shared/lib/forbidden-ddl-analyzer.py'), { force: true });
      await writeRepoFiles(repoDir, {
        'migrations/001_create_table.sql': 'CREATE TABLE contacts (id uuid PRIMARY KEY);\n',
      });

      const result = checkForbiddenDDL(
        makePrContext(['migrations/001_create_table.sql']),
        repoDir
      );
      assert.equal(result.status, 'pass');
    });

    it('detects destructive SQL migrations', async () => {
      await writeRepoFiles(repoDir, {
        'migrations/002_drop_table.sql': 'DROP TABLE contacts;\n',
      });

      const result = checkForbiddenDDL(
        makePrContext(['migrations/002_drop_table.sql']),
        repoDir
      );
      assert.equal(result.status, 'fail');
      assert.match(result.message, /forbidden migration pattern/);
    });

    it('honors custom migration danger labels', async () => {
      await writeFixture('drop_table.py');
      await writeRepoFiles(repoDir, {
        '.wavemill-config.json': JSON.stringify({
          ready: {
            migrationDangerLabels: {
              drop_table: 'db-risk-approved',
            },
          },
        }),
      });

      const result = checkForbiddenDDL(
        makePrContext(['alembic/versions/drop_table.py'], ['db-risk-approved']),
        repoDir
      );
      assert.equal(result.status, 'pass');
      assert.match(JSON.stringify(result.details), /db-risk-approved/);
    });
  });

  describe('checkMigrationReversibility', () => {
    let repoDir: string;

    beforeEach(async () => {
      repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-reversibility-'));
    });

    afterEach(async () => {
      await fs.rm(repoDir, { recursive: true, force: true });
    });

    async function copyFixtureInto(repoSubdir: string, fixtureName: string, asName?: string) {
      const fixturePath = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '..',
        '..',
        'tests',
        'fixtures',
        'migrations',
        fixtureName
      );
      const content = await fs.readFile(fixturePath, 'utf-8');
      const target = path.join(repoDir, repoSubdir, asName ?? fixtureName);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf-8');
      return path.relative(repoDir, target);
    }

    it('skips when no migration files are in the change set', async () => {
      const result = await checkMigrationReversibility(
        ['src/app.ts', 'README.md'],
        repoDir,
        []
      );
      assert.equal(result.status, 'skip');
      assert.equal(result.name, 'migration-reversibility');
    });

    it('fails on pass-only downgrade', async () => {
      const file = await copyFixtureInto(
        'migrations/versions',
        'empty_pass_downgrade.py'
      );
      const result = await checkMigrationReversibility([file], repoDir, []);
      assert.equal(result.status, 'fail');
      assert.match(result.message, /executable downgrade/);
      const failures = result.details?.failures as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(failures) && failures.length === 1);
      assert.equal(failures[0].reason, 'empty-pass');
    });

    it('fails on docstring-only downgrade', async () => {
      const file = await copyFixtureInto(
        'migrations/versions',
        'docstring_only_downgrade.py'
      );
      const result = await checkMigrationReversibility([file], repoDir, []);
      assert.equal(result.status, 'fail');
      const failures = result.details?.failures as Array<Record<string, unknown>>;
      assert.equal(failures[0].reason, 'empty-docstring');
    });

    it('fails on docstring + pass downgrade', async () => {
      const file = await copyFixtureInto(
        'migrations/versions',
        'docstring_pass_downgrade.py'
      );
      const result = await checkMigrationReversibility([file], repoDir, []);
      assert.equal(result.status, 'fail');
      const failures = result.details?.failures as Array<Record<string, unknown>>;
      assert.equal(failures[0].reason, 'empty-pass');
    });

    it('fails on bare raise NotImplementedError', async () => {
      const file = await copyFixtureInto(
        'migrations/versions',
        'not_implemented_bare_downgrade.py'
      );
      const result = await checkMigrationReversibility([file], repoDir, []);
      assert.equal(result.status, 'fail');
      const failures = result.details?.failures as Array<Record<string, unknown>>;
      assert.equal(failures[0].reason, 'not-implemented');
    });

    it('fails on raise NotImplementedError(...)', async () => {
      const file = await copyFixtureInto(
        'migrations/versions',
        'not_implemented_called_downgrade.py'
      );
      const result = await checkMigrationReversibility([file], repoDir, []);
      assert.equal(result.status, 'fail');
      const failures = result.details?.failures as Array<Record<string, unknown>>;
      assert.equal(failures[0].reason, 'not-implemented');
    });

    it('fails when downgrade() is missing', async () => {
      const file = await copyFixtureInto(
        'migrations/versions',
        'missing_downgrade.py'
      );
      const result = await checkMigrationReversibility([file], repoDir, []);
      assert.equal(result.status, 'fail');
      const failures = result.details?.failures as Array<Record<string, unknown>>;
      assert.equal(failures[0].reason, 'missing-downgrade');
    });

    it('passes when downgrade() is non-trivial', async () => {
      const file = await copyFixtureInto(
        'migrations/versions',
        'non_trivial_downgrade.py'
      );
      const result = await checkMigrationReversibility([file], repoDir, []);
      assert.equal(result.status, 'pass');
      assert.match(result.message, /non-trivial downgrade/);
    });

    it('passes SQL migrations with a matching rollback file', async () => {
      await writeRepoFiles(repoDir, {
        'migrations/028_add_tables.sql': 'CREATE TABLE contacts (id uuid PRIMARY KEY);\n',
        'migrations/028_add_tables_rollback.sql': 'DROP TABLE contacts;\n',
      });

      const result = await checkMigrationReversibility(
        ['migrations/028_add_tables.sql', 'migrations/028_add_tables_rollback.sql'],
        repoDir,
        []
      );
      assert.equal(result.status, 'pass');
      assert.match(result.message, /matching SQL rollback/);
      assert.deepEqual(result.details?.rollbackFiles, [
        'migrations/028_add_tables_rollback.sql',
      ]);
    });

    it('fails SQL migrations without a matching rollback file', async () => {
      await writeRepoFiles(repoDir, {
        'migrations/029_add_tables.sql': 'CREATE TABLE contacts (id uuid PRIMARY KEY);\n',
      });

      const result = await checkMigrationReversibility(
        ['migrations/029_add_tables.sql'],
        repoDir,
        []
      );
      assert.equal(result.status, 'fail');
      const failures = result.details?.failures as Array<Record<string, unknown>>;
      assert.equal(failures[0].reason, 'missing-downgrade');
      assert.match(String(failures[0].message), /rollback/);
    });

    it('migration:irreversible label converts a hard failure into pass with overrides recorded', async () => {
      const file = await copyFixtureInto(
        'migrations/versions',
        'empty_pass_downgrade.py'
      );
      const result = await checkMigrationReversibility(
        [file],
        repoDir,
        [MIGRATION_IRREVERSIBLE_LABEL]
      );
      assert.equal(result.status, 'pass');
      assert.match(result.message, /overridden/);
      assert.equal(result.details?.overrideApplied, true);
      const overridden = result.details?.overriddenFailures as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(overridden) && overridden.length === 1);
      assert.equal(overridden[0].reason, 'empty-pass');
    });

    it('migration:irreversible label match is case-insensitive', async () => {
      const file = await copyFixtureInto(
        'migrations/versions',
        'empty_pass_downgrade.py'
      );
      const result = await checkMigrationReversibility(
        [file],
        repoDir,
        ['Migration:Irreversible']
      );
      assert.equal(result.status, 'pass');
      assert.equal(result.details?.overrideApplied, true);
    });

    it('soft-warns when upgrade() drops data even with non-trivial downgrade', async () => {
      const file = await copyFixtureInto(
        'migrations/versions',
        'destructive_upgrade.py'
      );
      const result = await checkMigrationReversibility([file], repoDir, []);
      assert.equal(result.status, 'pass');
      const warnings = result.details?.warnings as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(warnings) && warnings.length === 1);
      const ops = warnings[0].destructiveOperations as string[];
      assert.deepEqual(new Set(ops), new Set(['op.drop_column', 'op.drop_table']));
    });

    it('returns a hard failure for malformed Python rather than throwing', async () => {
      const file = await copyFixtureInto(
        'migrations/versions',
        'malformed_syntax.py'
      );
      const result = await checkMigrationReversibility([file], repoDir, []);
      assert.equal(result.status, 'fail');
      const failures = result.details?.failures as Array<Record<string, unknown>>;
      assert.equal(failures[0].reason, 'parse-error');
    });

    it('honors configured ready.migrationPatterns', async () => {
      const file = await copyFixtureInto(
        'db/revisions',
        'empty_pass_downgrade.py'
      );

      const skipped = await checkMigrationReversibility([file], repoDir, []);
      assert.equal(skipped.status, 'skip', 'default patterns should skip db/revisions');

      const result = await checkMigrationReversibility(
        [file],
        repoDir,
        [],
        ['db/revisions/']
      );
      assert.equal(result.status, 'fail');
    });

    it('reports multiple failures across migration files', async () => {
      const fileA = await copyFixtureInto(
        'migrations/versions',
        'empty_pass_downgrade.py',
        '001_a.py'
      );
      const fileB = await copyFixtureInto(
        'migrations/versions',
        'not_implemented_bare_downgrade.py',
        '002_b.py'
      );
      const result = await checkMigrationReversibility([fileA, fileB], repoDir, []);
      assert.equal(result.status, 'fail');
      const failures = result.details?.failures as Array<Record<string, unknown>>;
      assert.equal(failures.length, 2);
      const reasons = failures.map(f => f.reason).sort();
      assert.deepEqual(reasons, ['empty-pass', 'not-implemented']);
    });
  });

  describe('runReadyStage migration-reversibility integration', () => {
    it('omits migration-reversibility when ready.checks restricts to ci-status', async () => {
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-stage-rev-allowlist-'));
      const fixtureSrc = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '..',
        '..',
        'tests',
        'fixtures',
        'migrations',
        'empty_pass_downgrade.py'
      );
      const fixtureContent = await fs.readFile(fixtureSrc, 'utf-8');
      await writeRepoFiles(repoDir, {
        '.wavemill-config.json': JSON.stringify({
          ready: { checks: ['ci-status'], requiredChecks: ['ci-status'] },
        }),
        'migrations/versions/001_pass.py': fixtureContent,
      });

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd.includes('gh pr view')) {
          if (cmd.includes('mergeable,mergeStateStatus')) {
            return JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
          }
          return JSON.stringify({
            number: 42,
            headRefName: 'feature-branch',
            baseRefName: 'main',
            url: 'https://github.com/test/repo/pull/42',
            files: [{ path: 'migrations/versions/001_pass.py' }],
            labels: [],
          });
        }
        if (cmd.includes('gh pr diff')) return '';
        if (cmd.includes('gh pr checks')) {
          return JSON.stringify([{ name: 'Shell and Unit Tests', state: 'SUCCESS' }]);
        }
        return '';
      });

      try {
        const result = await runReadyStage({ prNumber: 42, repoDir });
        assert.deepEqual(result.checks.map(c => c.name), ['ci-status']);
      } finally {
        execMock.mock.restore();
        await fs.rm(repoDir, { recursive: true, force: true });
      }
    });

    it('runs only migration-reversibility when ready.checks restricts to it and uses PR labels', async () => {
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-stage-rev-only-'));
      const fixtureSrc = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '..',
        '..',
        'tests',
        'fixtures',
        'migrations',
        'empty_pass_downgrade.py'
      );
      const fixtureContent = await fs.readFile(fixtureSrc, 'utf-8');
      await writeRepoFiles(repoDir, {
        '.wavemill-config.json': JSON.stringify({
          ready: { checks: ['migration-reversibility'] },
        }),
        'migrations/versions/001_pass.py': fixtureContent,
      });

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd.includes('gh pr view')) {
          if (cmd.includes('mergeable,mergeStateStatus')) {
            return JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
          }
          return JSON.stringify({
            number: 42,
            headRefName: 'feature-branch',
            baseRefName: 'main',
            url: 'https://github.com/test/repo/pull/42',
            files: [{ path: 'migrations/versions/001_pass.py' }],
            labels: [{ name: MIGRATION_IRREVERSIBLE_LABEL }],
          });
        }
        if (cmd.includes('gh pr diff')) return '';
        if (cmd.includes('gh pr checks')) return JSON.stringify([]);
        return '';
      });

      try {
        const result = await runReadyStage({ prNumber: 42, repoDir });
        assert.equal(result.checks.some((check) => check.name === 'migration-base-refresh'), true);
        const reversibilityCheck = result.checks.find((check) => check.name === 'migration-reversibility');
        assert.equal(reversibilityCheck?.status, 'pass');
        assert.equal(reversibilityCheck?.details?.overrideApplied, true);
      } finally {
        execMock.mock.restore();
        await fs.rm(repoDir, { recursive: true, force: true });
      }
    });

    it('treats missing labels in gh pr view payload as no override', async () => {
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-stage-rev-nolabels-'));
      const fixtureSrc = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '..',
        '..',
        'tests',
        'fixtures',
        'migrations',
        'empty_pass_downgrade.py'
      );
      const fixtureContent = await fs.readFile(fixtureSrc, 'utf-8');
      await writeRepoFiles(repoDir, {
        '.wavemill-config.json': JSON.stringify({
          ready: { checks: ['migration-reversibility'] },
        }),
        'migrations/versions/001_pass.py': fixtureContent,
      });

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd.includes('gh pr view')) {
          if (cmd.includes('mergeable,mergeStateStatus')) {
            return JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
          }
          return JSON.stringify({
            number: 42,
            headRefName: 'feature-branch',
            baseRefName: 'main',
            url: 'https://github.com/test/repo/pull/42',
            files: [{ path: 'migrations/versions/001_pass.py' }],
            // labels intentionally omitted to simulate older mocks
          });
        }
        if (cmd.includes('gh pr diff')) return '';
        if (cmd.includes('gh pr checks')) return JSON.stringify([]);
        return '';
      });

      try {
        const result = await runReadyStage({ prNumber: 42, repoDir });
        assert.equal(result.checks.some((check) => check.name === 'migration-base-refresh'), true);
        assert.equal(result.checks.find((check) => check.name === 'migration-reversibility')?.status, 'fail');
        assert.equal(result.verdict, 'fail');
      } finally {
        execMock.mock.restore();
        await fs.rm(repoDir, { recursive: true, force: true });
      }
    });
  });

  describe('computeVerdict', () => {
    it('returns pass for empty checks array', () => {
      const result = computeVerdict([]);
      assert.equal(result, 'pass');
    });

    it('returns pass when all checks pass', () => {
      const checks: ReadyCheck[] = [
        { name: 'check1', status: 'pass', message: 'ok' },
        { name: 'check2', status: 'pass', message: 'ok' },
      ];
      const result = computeVerdict(checks);
      assert.equal(result, 'pass');
    });

    it('returns pass when checks are skipped', () => {
      const checks: ReadyCheck[] = [
        { name: 'check1', status: 'skip', message: 'skipped' },
        { name: 'check2', status: 'pass', message: 'ok' },
      ];
      const result = computeVerdict(checks);
      assert.equal(result, 'pass');
    });

    it('returns warn when any check warns', () => {
      const checks: ReadyCheck[] = [
        { name: 'check1', status: 'pass', message: 'ok' },
        { name: 'check2', status: 'warn', message: 'warning' },
      ];
      const result = computeVerdict(checks);
      assert.equal(result, 'warn');
    });

    it('returns pending when checks are still running', () => {
      const checks: ReadyCheck[] = [
        { name: 'check1', status: 'pass', message: 'ok' },
        { name: 'check2', status: 'pending', message: 'still running' },
      ];
      const result = computeVerdict(checks);
      assert.equal(result, 'pending');
    });

    it('returns fail when any check fails', () => {
      const checks: ReadyCheck[] = [
        { name: 'check1', status: 'pass', message: 'ok' },
        { name: 'check2', status: 'fail', message: 'failed' },
      ];
      const result = computeVerdict(checks);
      assert.equal(result, 'fail');
    });

    it('returns fail even with warnings when one fails', () => {
      const checks: ReadyCheck[] = [
        { name: 'check1', status: 'warn', message: 'warning' },
        { name: 'check2', status: 'fail', message: 'failed' },
      ];
      const result = computeVerdict(checks);
      assert.equal(result, 'fail');
    });

    it('returns fail even when pending checks are present', () => {
      const checks: ReadyCheck[] = [
        { name: 'check1', status: 'pending', message: 'still running' },
        { name: 'check2', status: 'fail', message: 'failed' },
      ];
      const result = computeVerdict(checks);
      assert.equal(result, 'fail');
    });

    it('uses required checks for blocking decisions', () => {
      const checks: ReadyCheck[] = [
        { name: 'ci-status', status: 'pass', message: 'ok' },
        { name: 'forbidden-ddl', status: 'fail', message: 'optional fail' },
      ];
      const result = computeVerdict(checks, ['ci-status']);
      assert.equal(result, 'warn');
    });
  });

  describe('checkCIStatus', () => {
    it('suppresses gh stderr when fetching checks', async () => {
      let receivedCommand = '';
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        receivedCommand = cmd;
        return JSON.stringify([]);
      });

      try {
        await checkCIStatus(42, '/tmp/test');
        assert.match(receivedCommand, /gh pr checks '?42'? --json state,name 2>\/dev\/null$/);
      } finally {
        execMock.mock.restore();
      }
    });

    it('returns pending for queued checks', async () => {
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () =>
        JSON.stringify([{ name: 'Shell and Unit Tests', state: 'QUEUED' }])
      );

      try {
        const result = await checkCIStatus(42, '/tmp/test');
        assert.equal(result.status, 'pending');
        assert.match(result.message, /still running/);
        assert.deepEqual(result.details?.pendingChecks, ['Shell and Unit Tests']);
        assert.equal(result.details?.observed, 1);
      } finally {
        execMock.mock.restore();
      }
    });

    it('returns pending for in-progress checks', async () => {
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () =>
        JSON.stringify([{ name: 'Check Lifecycle Paths', state: 'IN_PROGRESS' }])
      );

      try {
        const result = await checkCIStatus(42, '/tmp/test');
        assert.equal(result.status, 'pending');
        assert.deepEqual(result.details?.pendingChecks, ['Check Lifecycle Paths']);
        assert.equal(result.details?.observed, 1);
      } finally {
        execMock.mock.restore();
      }
    });

    it('returns fail for failed checks', async () => {
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () =>
        JSON.stringify([{ name: 'Shell and Unit Tests', state: 'FAILURE' }])
      );

      try {
        const result = await checkCIStatus(42, '/tmp/test');
        assert.equal(result.status, 'fail');
        assert.match(result.message, /failing/);
        assert.deepEqual(result.details?.failingChecks, ['Shell and Unit Tests']);
        assert.equal(result.details?.observed, 1);
      } finally {
        execMock.mock.restore();
      }
    });

    it('returns fail when failed and queued checks are mixed', async () => {
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () =>
        JSON.stringify([
          { name: 'Shell and Unit Tests', state: 'FAILURE' },
          { name: 'Check Lifecycle Paths', state: 'QUEUED' },
        ])
      );

      try {
        const result = await checkCIStatus(42, '/tmp/test');
        assert.equal(result.status, 'fail');
        assert.deepEqual(result.details?.failingChecks, ['Shell and Unit Tests']);
        assert.deepEqual(result.details?.pendingChecks, ['Check Lifecycle Paths']);
        assert.equal(result.details?.observed, 2);
      } finally {
        execMock.mock.restore();
      }
    });

    it('returns pass for success and skipped checks', async () => {
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () =>
        JSON.stringify([
          { name: 'Shell and Unit Tests', state: 'SUCCESS' },
          { name: 'Lifecycle Tests', state: 'SKIPPED' },
        ])
      );

      try {
        const result = await checkCIStatus(42, '/tmp/test');
        assert.equal(result.status, 'pass');
        assert.equal(result.message, 'All required CI checks passing');
        assert.equal(result.details?.observed, 2);
        assert.equal(result.details?.passing, 2);
      } finally {
        execMock.mock.restore();
      }
    });

    it('includes cancelled CI as a failing check', async () => {
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () =>
        JSON.stringify([{ name: 'Lifecycle Tests', state: 'CANCELLED' }])
      );

      try {
        const result = await checkCIStatus(42, '/tmp/test');
        assert.equal(result.status, 'fail');
        assert.deepEqual(result.details?.failingChecks, ['Lifecycle Tests']);
      } finally {
        execMock.mock.restore();
      }
    });

    it('returns pending when no checks are reported by default', async () => {
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () => JSON.stringify([]));

      try {
        const result = await checkCIStatus(42, '/tmp/test');
        assert.equal(result.status, 'pending');
      } finally {
        execMock.mock.restore();
      }
    });
  });

  describe('checkMergeConflicts', () => {
    it('reports tend\'s per-commit rebase conflict at the live head as CONFLICTED even when GitHub says MERGEABLE (HOK-3316)', async () => {
      const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ready-tend-fact-'));
      writeTendAttemptFact(stateDir, {
        phase: 'rebase',
        prNumber: 42,
        headSha: 'head-42',
        // No recorded base: the fact holds on the head alone.
        baseSha: '',
        excerpt: 'CONFLICT (content): Merge conflict in shared/validators/wavemill-config.validator.cjs',
        failureClass: 'code-failure',
      });
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () =>
        JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: 'head-42' })
      );

      try {
        const conflicted = await checkMergeConflicts(42, stateDir, { stateDir });
        assert.equal(conflicted.status, 'CONFLICTED');
        assert.match(conflicted.message, /commit by commit/);
        assert.match(conflicted.message, /wavemill-config\.validator\.cjs/);
        // Without the state dir (tend's own in-lane re-check) the GitHub view stands.
        assert.equal((await checkMergeConflicts(42, stateDir)).status, 'CLEAN');
      } finally {
        execMock.mock.restore();
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it('ignores a tend rebase fact for another head or an unverifiable base (HOK-3316)', async () => {
      const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ready-tend-fact-'));
      writeTendAttemptFact(stateDir, {
        phase: 'rebase',
        prNumber: 42,
        headSha: 'head-42',
        baseSha: 'base-recorded',
        excerpt: 'CONFLICT',
        failureClass: 'code-failure',
      });
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () =>
        JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: 'head-42' })
      );

      try {
        // stateDir is not a git checkout, so the live base cannot be proven equal.
        assert.equal((await checkMergeConflicts(42, stateDir, { stateDir })).status, 'CLEAN');
      } finally {
        execMock.mock.restore();
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it('returns CLEAN when GitHub reports a mergeable PR', async () => {
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () =>
        JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })
      );

      try {
        const result = await checkMergeConflicts(42, '/tmp/test');
        assert.equal(result.status, 'CLEAN');
        assert.equal(result.attempts, 1);
        assert.equal(result.mergeStateStatus, 'CLEAN');
      } finally {
        execMock.mock.restore();
      }
    });

    it('returns CONFLICTED when GitHub reports a dirty merge state', async () => {
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () =>
        JSON.stringify({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })
      );

      try {
        const result = await checkMergeConflicts(42, '/tmp/test');
        assert.equal(result.status, 'CONFLICTED');
        assert.equal(result.attempts, 1);
        assert.equal(result.mergeable, 'CONFLICTING');
      } finally {
        execMock.mock.restore();
      }
    });

    it('retries UNKNOWN status and returns UNKNOWN after the final attempt', async () => {
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () =>
        JSON.stringify({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })
      );
      const sleepMock = mock.method(readyStage.readyStageDeps, 'sleep', async () => undefined);

      try {
        const result = await checkMergeConflicts(42, '/tmp/test');
        assert.equal(result.status, 'UNKNOWN');
        assert.equal(result.attempts, 3);
        assert.equal(execMock.mock.callCount(), 3);
        assert.equal(sleepMock.mock.callCount(), 2);
      } finally {
        execMock.mock.restore();
        sleepMock.mock.restore();
      }
    });

    it('returns ERROR when the gh command fails', async () => {
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', () => {
        throw new Error('gh failed');
      });
      const sleepMock = mock.method(readyStage.readyStageDeps, 'sleep', async () => undefined);

      try {
        const result = await checkMergeConflicts(42, '/tmp/test');
        assert.equal(result.status, 'ERROR');
        assert.equal(result.attempts, 3);
        assert.match(result.error ?? '', /gh failed/);
        assert.equal(execMock.mock.callCount(), 3);
        assert.equal(sleepMock.mock.callCount(), 2);
      } finally {
        execMock.mock.restore();
        sleepMock.mock.restore();
      }
    });
  });

  describe('checkLegacyMarkers', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-stage-test-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('returns empty checks when no markers present', async () => {
      const result = await checkLegacyMarkers(tmpDir);
      assert.equal(result.checks.length, 0);
      assert.equal(result.markers.length, 3);
      assert.ok(result.markers.every(m => !m.present));
    });

    it('detects .plan-approved marker', async () => {
      await fs.writeFile(path.join(tmpDir, '.plan-approved'), '');
      const result = await checkLegacyMarkers(tmpDir);
      assert.equal(result.checks.length, 1);
      assert.equal(result.checks[0].name, 'legacy-plan-approved');
      assert.equal(result.checks[0].status, 'pass');
    });

    it('detects .coding-complete marker', async () => {
      await fs.writeFile(path.join(tmpDir, '.coding-complete'), '');
      const result = await checkLegacyMarkers(tmpDir);
      assert.equal(result.checks.length, 1);
      assert.equal(result.checks[0].name, 'legacy-coding-complete');
      assert.equal(result.checks[0].status, 'pass');
    });

    it('detects .workflow-aborted marker as fail', async () => {
      await fs.writeFile(path.join(tmpDir, '.workflow-aborted'), '');
      const result = await checkLegacyMarkers(tmpDir);
      assert.equal(result.checks.length, 1);
      assert.equal(result.checks[0].name, 'legacy-workflow-aborted');
      assert.equal(result.checks[0].status, 'fail');
    });

    it('detects multiple markers simultaneously', async () => {
      await fs.writeFile(path.join(tmpDir, '.plan-approved'), '');
      await fs.writeFile(path.join(tmpDir, '.coding-complete'), '');
      const result = await checkLegacyMarkers(tmpDir);
      assert.equal(result.checks.length, 2);
      const names = result.checks.map(c => c.name);
      assert.ok(names.includes('legacy-plan-approved'));
      assert.ok(names.includes('legacy-coding-complete'));
    });
  });

  describe('controllerCheckReadiness', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-stage-test-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('returns not ready when feature directory does not exist', async () => {
      const result = await controllerCheckReadiness('/nonexistent/path');
      assert.equal(result.ready, false);
      assert.equal(result.phase, 'unknown');
      assert.equal(result.checks[0].status, 'fail');
      assert.match(result.checks[0].message, /does not exist/);
    });

    it('returns unknown phase for empty feature directory', async () => {
      const result = await controllerCheckReadiness(tmpDir);
      assert.equal(result.ready, true);
      assert.equal(result.phase, 'unknown');
      assert.match(result.summary, /No stage results/);
    });

    it('returns unknown phase when only .plan-approved exists', async () => {
      await fs.writeFile(path.join(tmpDir, '.plan-approved'), '');
      const result = await controllerCheckReadiness(tmpDir);
      assert.equal(result.phase, 'unknown');
      assert.equal(result.ready, true);
    });

    it('returns unknown phase when only .coding-complete exists', async () => {
      await fs.writeFile(path.join(tmpDir, '.plan-approved'), '');
      await fs.writeFile(path.join(tmpDir, '.coding-complete'), '');
      const result = await controllerCheckReadiness(tmpDir);
      assert.equal(result.phase, 'unknown');
      assert.equal(result.ready, true);
    });

    it('returns unknown phase for legacy abort marker alone', async () => {
      await fs.writeFile(path.join(tmpDir, '.workflow-aborted'), '');
      const result = await controllerCheckReadiness(tmpDir);
      assert.equal(result.phase, 'unknown');
      assert.equal(result.ready, true);
    });

    it('reports task packet presence', async () => {
      await fs.writeFile(path.join(tmpDir, 'task-packet.md'), '# Task');
      const result = await controllerCheckReadiness(tmpDir);
      const taskCheck = result.checks.find(c => c.name === 'task-packet');
      assert.ok(taskCheck);
      assert.equal(taskCheck.status, 'pass');
    });

    it('warns on missing task packet', async () => {
      const result = await controllerCheckReadiness(tmpDir);
      const taskCheck = result.checks.find(c => c.name === 'task-packet');
      assert.ok(taskCheck);
      assert.equal(taskCheck.status, 'warn');
    });

    it('reports plan presence', async () => {
      await fs.writeFile(path.join(tmpDir, 'plan.md'), '# Plan');
      const result = await controllerCheckReadiness(tmpDir);
      const planCheck = result.checks.find(c => c.name === 'plan');
      assert.ok(planCheck);
      assert.equal(planCheck.status, 'pass');
    });

    it('includes correct featureDir and timestamp in result', async () => {
      const result = await controllerCheckReadiness(tmpDir);
      assert.equal(result.featureDir, tmpDir);
      assert.ok(result.timestamp);
      // Verify ISO 8601 format
      assert.ok(!isNaN(Date.parse(result.timestamp)));
    });

    it('reports ready pass from stage artifacts', async () => {
      await fs.writeFile(path.join(tmpDir, '.ready-result.json'), JSON.stringify({
        stage: 'ready',
        status: 'completed',
        startedAt: '2026-04-09T12:00:00.000Z',
        finishedAt: '2026-04-09T12:10:00.000Z',
        agent: 'claude',
        model: 'claude-opus-4-6',
        notes: 'verdict: pass',
        artifacts: { type: 'ready', verdict: 'pass', checksRun: 4, checksPassed: 4, mergeConflict: 'CLEAN' },
      }));

      const result = await controllerCheckReadiness(tmpDir);
      assert.equal(result.phase, 'ready');
      assert.equal(result.ready, true);
      assert.equal(result.checks.find(c => c.name === 'ready-outcome')?.status, 'pass');
    });

    it('reports ready fail from stage artifacts', async () => {
      await fs.writeFile(path.join(tmpDir, '.ready-result.json'), JSON.stringify({
        stage: 'ready',
        status: 'completed',
        startedAt: '2026-04-09T12:00:00.000Z',
        finishedAt: '2026-04-09T12:10:00.000Z',
        agent: 'claude',
        model: 'claude-opus-4-6',
        notes: 'verdict: fail',
        artifacts: { type: 'ready', verdict: 'fail', checksRun: 4, checksPassed: 2, mergeConflict: 'CLEAN' },
      }));

      const result = await controllerCheckReadiness(tmpDir);
      assert.equal(result.phase, 'ready');
      assert.equal(result.ready, false);
      assert.equal(result.checks.find(c => c.name === 'ready-outcome')?.status, 'fail');
    });

    it('reports ready remediation in progress from running stage result', async () => {
      await fs.writeFile(path.join(tmpDir, '.ready-result.json'), JSON.stringify({
        stage: 'ready',
        status: 'running',
        startedAt: '2026-04-09T12:00:00.000Z',
        finishedAt: null,
        agent: 'claude',
        model: 'claude-opus-4-6',
        notes: 'Conflict remediation in progress',
        artifacts: { type: 'ready', mergeConflict: 'CONFLICTED' },
      }));

      const result = await controllerCheckReadiness(tmpDir);
      assert.equal(result.phase, 'ready');
      assert.equal(result.ready, true);
      assert.match(result.summary, /remediation in progress/);
      assert.equal(result.checks.find(c => c.name === 'ready-outcome')?.status, 'warn');
    });

    it('reports ready needs attention from failed stage result', async () => {
      await fs.writeFile(path.join(tmpDir, '.ready-result.json'), JSON.stringify({
        stage: 'ready',
        status: 'failed',
        startedAt: '2026-04-09T12:00:00.000Z',
        finishedAt: '2026-04-09T12:10:00.000Z',
        agent: 'claude',
        model: 'claude-opus-4-6',
        notes: 'Ready checks failed',
      }));

      const result = await controllerCheckReadiness(tmpDir);
      assert.equal(result.phase, 'ready');
      assert.equal(result.ready, false);
      assert.match(result.summary, /needs attention/);
      assert.equal(result.checks.find(c => c.name === 'ready-outcome')?.status, 'fail');
    });
  });

  describe('runReadyStage - integration', () => {
    it('defaults to universal checks when ready config is missing', async () => {
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-stage-defaults-'));
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd.includes('gh pr view')) {
          if (cmd.includes('mergeable,mergeStateStatus')) {
            return JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
          }
          return JSON.stringify({
            number: 42,
            headRefName: 'feature-branch',
            baseRefName: 'main',
            url: 'https://github.com/test/repo/pull/42',
            files: [{ path: 'src/app.ts' }],
          });
        }
        if (cmd.includes('gh pr diff')) return '';
        if (cmd.includes('gh pr checks')) return JSON.stringify([]);
        return '';
      });

      try {
        const result = await runReadyStage({ prNumber: 42, repoDir });
        const names = result.checks.map(check => check.name);
        assert.ok(names.includes('pr-exists'));
        assert.ok(names.includes('merge-conflict'));
        assert.ok(names.includes('ci-status'));
        assert.ok(!names.includes('schema-migrations'));
        assert.ok(!names.includes('forbidden-ddl'));
      } finally {
        execMock.mock.restore();
        await fs.rm(repoDir, { recursive: true, force: true });
      }
    });

    it('adds migration freshness and reversibility to Alembic baseline suggestions', async () => {
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-stage-baseline-'));
      await writeRepoFiles(repoDir, {
        'alembic/versions/001_base.py': 'revision = "001"\ndown_revision = None\n',
      });

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd.includes('gh pr view')) {
          if (cmd.includes('mergeable,mergeStateStatus')) {
            return JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
          }
          return JSON.stringify({
            number: 42,
            headRefName: 'feature-branch',
            baseRefName: 'main',
            url: 'https://github.com/test/repo/pull/42',
            files: [{ path: 'src/app.ts' }],
          });
        }
        if (cmd.includes('gh pr checks')) return JSON.stringify([]);
        if (cmd.includes('git fetch --quiet origin')) return '';
        if (cmd.includes('git merge-tree --write-tree')) return '';
        return '';
      });

      try {
        const result = await runReadyStage({ prNumber: 42, repoDir });
        const baseline = result.checks.find(check => check.name === 'baseline-discovery');
        assert.equal(baseline?.status, 'warn');
        assert.deepEqual((baseline?.details?.suggestions as string[]) ?? [], [
          'ready.checks: schema-migrations, migration-base-freshness, migration-reversibility, forbidden-ddl',
          'ready.requiredChecks: schema-migrations, migration-base-freshness',
        ]);
      } finally {
        execMock.mock.restore();
        await fs.rm(repoDir, { recursive: true, force: true });
      }
    });

    it('suppresses gh stderr while gathering PR context CI metadata', async () => {
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-stage-'));
      await fs.writeFile(
        path.join(repoDir, '.wavemill-config.json'),
        JSON.stringify({ ready: { checks: [], requiredChecks: [] } }),
        'utf-8'
      );

      const commands: string[] = [];
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        commands.push(cmd);

        if (cmd.includes('gh pr view')) {
          if (cmd.includes('mergeable,mergeStateStatus')) {
            return JSON.stringify({
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'CLEAN',
            });
          }

          return JSON.stringify({
            number: 42,
            headRefName: 'feature-branch',
            baseRefName: 'main',
            url: 'https://github.com/test/repo/pull/42',
            files: [],
          });
        }
        if (cmd.includes('gh pr diff')) {
          return '';
        }
        if (cmd.includes('gh pr checks')) {
          return JSON.stringify([]);
        }
        return '';
      });

      try {
        await runReadyStage({
          prNumber: 42,
          repoDir,
        });

        assert.ok(
          commands.some((cmd) => /gh pr checks '?42'? --json state 2>\/dev\/null$/.test(cmd)),
          'expected gatherPRContext to suppress gh stderr'
        );
        assert.ok(
          commands.every((cmd) => !cmd.includes('gh pr diff')),
          'expected gatherPRContext not to fetch the full PR diff'
        );
      } finally {
        execMock.mock.restore();
        await fs.rm(repoDir, { recursive: true, force: true });
      }
    });

    it('includes merge conflict status independently from the readiness verdict', async () => {
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-stage-'));
      await fs.writeFile(
        path.join(repoDir, '.wavemill-config.json'),
        JSON.stringify({ ready: { checks: [], requiredChecks: [] } }),
        'utf-8'
      );

      // Mock gh CLI commands to test the success path
      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd.includes('gh pr view')) {
          if (cmd.includes('mergeable,mergeStateStatus')) {
            return JSON.stringify({
              mergeable: 'CONFLICTING',
              mergeStateStatus: 'DIRTY',
            });
          }

          return JSON.stringify({
            number: 42,
            headRefName: 'feature-branch',
            baseRefName: 'main',
            url: 'https://github.com/test/repo/pull/42',
            files: [
              { path: 'src/app.ts' },
              { path: 'README.md' }
            ]
          });
        }
        if (cmd.includes('gh pr diff')) {
          return 'diff --git a/src/app.ts b/src/app.ts\n+new code';
        }
        if (cmd.includes('gh pr checks')) {
          return JSON.stringify([{ state: 'SUCCESS' }]);
        }
        return '';
      });

      try {
        const result = await runReadyStage({
          prNumber: 42,
          repoDir,
        });

        // Verify structure
        assert.equal(typeof result.prNumber, 'number');
        assert.equal(result.prNumber, 42);
        assert.ok(['pass', 'fail', 'warn', 'pending'].includes(result.verdict));
        assert.ok(Array.isArray(result.checks));
        assert.equal(typeof result.timestamp, 'string');
        assert.equal(typeof result.summary, 'string');
        assert.equal(result.branch, 'feature-branch');
        assert.equal(result.verdict, 'fail');
        assert.equal(result.mergeConflict?.status, 'CONFLICTED');
      } finally {
        execMock.mock.restore();
        await fs.rm(repoDir, { recursive: true, force: true });
      }
    });

    it('returns pending when CI checks are queued but nothing failed', async () => {
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-stage-'));
      await fs.writeFile(
        path.join(repoDir, '.wavemill-config.json'),
        JSON.stringify({ ready: { checks: ['ci-status'], requiredChecks: ['ci-status'] } }),
        'utf-8'
      );

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd.includes('gh pr view')) {
          if (cmd.includes('mergeable,mergeStateStatus')) {
            return JSON.stringify({
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'UNSTABLE',
            });
          }

          return JSON.stringify({
            number: 42,
            headRefName: 'feature-branch',
            baseRefName: 'main',
            url: 'https://github.com/test/repo/pull/42',
            files: [],
          });
        }
        if (cmd.includes('gh pr diff')) {
          return '';
        }
        if (cmd.includes('gh pr checks')) {
          return JSON.stringify([{ name: 'Shell and Unit Tests', state: 'QUEUED' }]);
        }
        return '';
      });

      try {
        const result = await runReadyStage({
          prNumber: 42,
          repoDir,
        });

        assert.equal(result.verdict, 'pending');
        assert.equal(result.summary, 'CI checks still in progress - will retry');
        assert.equal(result.checks[0]?.status, 'pending');
      } finally {
        execMock.mock.restore();
        await fs.rm(repoDir, { recursive: true, force: true });
      }
    });

    it('honors the ready.checks allowlist for migration-chain-integrity', async () => {
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-stage-'));
      await writeRepoFiles(repoDir, {
        '.wavemill-config.json': JSON.stringify({
          ready: {
            checks: ['ci-status'],
            requiredChecks: ['ci-status'],
          },
        }),
        'migrations/versions/001_base.py': 'revision = "001"\ndown_revision = None\n',
        'migrations/versions/002_next.py': 'revision = "002"\ndown_revision = "001"\n',
      });

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd.includes('gh pr view')) {
          if (cmd.includes('mergeable,mergeStateStatus')) {
            return JSON.stringify({
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'CLEAN',
            });
          }

          return JSON.stringify({
            number: 42,
            headRefName: 'feature-branch',
            baseRefName: 'main',
            url: 'https://github.com/test/repo/pull/42',
            files: [],
          });
        }
        if (cmd.includes('gh pr diff')) {
          return '';
        }
        if (cmd.includes('gh pr checks')) {
          return JSON.stringify([{ name: 'Shell and Unit Tests', state: 'SUCCESS' }]);
        }
        return '';
      });

      try {
        const result = await runReadyStage({ prNumber: 42, repoDir });
        assert.deepEqual(result.checks.map(check => check.name), ['ci-status']);
      } finally {
        execMock.mock.restore();
        await fs.rm(repoDir, { recursive: true, force: true });
      }
    });

    it('auto-enables alembic migration-chain checks when no ready checks are configured', async () => {
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-stage-'));
      await writeRepoFiles(repoDir, {
        'alembic/versions/001_base.py': 'revision = "001"\ndown_revision = None\n',
        'alembic/versions/002_a.py': 'revision = "002_a"\ndown_revision = "001"\n',
        'alembic/versions/002_b.py': 'revision = "002_b"\ndown_revision = "001"\n',
      });

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd.includes('gh pr view')) {
          if (cmd.includes('mergeable,mergeStateStatus')) {
            return JSON.stringify({
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'CLEAN',
            });
          }

          return JSON.stringify({
            number: 42,
            headRefName: 'feature-branch',
            baseRefName: 'main',
            url: 'https://github.com/test/repo/pull/42',
            files: [],
          });
        }
        if (cmd.includes('gh pr diff')) {
          return '';
        }
        if (cmd.includes('gh pr checks')) {
          return JSON.stringify([{ name: 'Shell and Unit Tests', state: 'SUCCESS' }]);
        }
        return '';
      });

      try {
        const result = await runReadyStage({ prNumber: 42, repoDir });
        assert.equal(result.verdict, 'fail');
        assert.equal(result.checks.some((check) => check.name === 'migration-chain-auto-enabled'), true);
        assert.equal(result.checks.some((check) => check.name === 'migration-base-refresh'), true);
        assert.equal(result.checks.find((check) => check.name === 'migration-chain-integrity')?.status, 'fail');
      } finally {
        execMock.mock.restore();
        await fs.rm(repoDir, { recursive: true, force: true });
      }
    });

    it('skips alembic auto-detection when migration checks are disabled', async () => {
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-stage-'));
      await writeRepoFiles(repoDir, {
        '.wavemill-config.json': JSON.stringify({
          ready: {
            migrationChecks: {
              enabled: false,
            },
          },
        }),
        'alembic/versions/001_base.py': 'revision = "001"\ndown_revision = None\n',
        'alembic/versions/002_next.py': 'revision = "002"\ndown_revision = "001"\n',
      });

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd.includes('gh pr view')) {
          if (cmd.includes('mergeable,mergeStateStatus')) {
            return JSON.stringify({
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'CLEAN',
            });
          }

          return JSON.stringify({
            number: 42,
            headRefName: 'feature-branch',
            baseRefName: 'main',
            url: 'https://github.com/test/repo/pull/42',
            files: [],
          });
        }
        if (cmd.includes('gh pr diff')) {
          return '';
        }
        if (cmd.includes('gh pr checks')) {
          return JSON.stringify([{ name: 'Shell and Unit Tests', state: 'SUCCESS' }]);
        }
        return '';
      });

      try {
        const result = await runReadyStage({ prNumber: 42, repoDir });
        assert.equal(result.checks.some((check) => check.name === 'migration-chain-integrity'), false);
        assert.equal(result.checks.some((check) => check.name === 'migration-chain-auto-enabled'), false);
      } finally {
        execMock.mock.restore();
        await fs.rm(repoDir, { recursive: true, force: true });
      }
    });

    it('can run only the migration-reversibility check through the allowlist', async () => {
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-stage-'));
      await writeRepoFiles(repoDir, {
        '.wavemill-config.json': JSON.stringify({
          ready: {
            checks: ['migration-reversibility'],
            requiredChecks: ['migration-reversibility'],
          },
        }),
        'alembic/versions/001_bad.py': await loadMigrationFixture('downgrade_pass.py'),
      });

      const execMock = mock.method(readyStage.readyStageDeps, 'execShellCommand', (cmd: string) => {
        if (cmd.includes('gh pr view')) {
          if (cmd.includes('mergeable,mergeStateStatus')) {
            return JSON.stringify({
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'CLEAN',
            });
          }

          return JSON.stringify({
            number: 42,
            headRefName: 'feature-branch',
            baseRefName: 'main',
            url: 'https://github.com/test/repo/pull/42',
            files: [{ path: 'alembic/versions/001_bad.py' }],
            labels: [],
          });
        }
        if (cmd.includes('gh pr diff')) {
          return '';
        }
        if (cmd.includes('gh pr checks')) {
          return JSON.stringify([{ name: 'Shell and Unit Tests', state: 'SUCCESS' }]);
        }
        return '';
      });

      try {
        const result = await runReadyStage({ prNumber: 42, repoDir });
        assert.equal(result.checks.some((check) => check.name === 'migration-base-refresh'), true);
        assert.equal(result.checks.find((check) => check.name === 'migration-reversibility')?.status, 'fail');
      } finally {
        execMock.mock.restore();
        await fs.rm(repoDir, { recursive: true, force: true });
      }
    });
  });
});
