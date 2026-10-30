import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateArchivedStageArtifacts } from '../tools/migrate-archived-stage-artifacts.ts';

interface Logs {
  info: string[];
  warn: string[];
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'migrate-test-'));
  mkdirSync(join(root, '.wavemill'), { recursive: true });
  writeFileSync(join(root, '.wavemill-config.json'), '{}');
  return root;
}

function newLogs(): Logs {
  const info: string[] = [];
  const warn: string[] = [];
  return { info, warn };
}

function logger(logs: Logs) {
  return {
    info(msg: string) {
      logs.info.push(msg);
    },
    warn(msg: string) {
      logs.warn.push(msg);
    },
  };
}

function seedArchive(root: string, issue: string, name: string, content: string): string {
  const dir = join(root, '.wavemill', 'evals', 'artifacts', issue);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

// protects: a fresh dot-less archive tree is renamed to the dot-prefixed names.
test('migrateArchivedStageArtifacts renames pre-HOK-2891 archive names', () => {
  const repo = makeRepo();
  try {
    seedArchive(repo, 'HOK-100', 'coding-result.json', '{"stage":"coding"}');
    seedArchive(repo, 'HOK-100', 'planning-result.json', '{"stage":"planning"}');
    seedArchive(repo, 'HOK-100', 'operator-intervention.json', '{"type":"operator_recovery"}');
    seedArchive(repo, 'HOK-100', 'routing-complete.json', '{"routed":true}');

    const logs = newLogs();
    const report = migrateArchivedStageArtifacts({ repoDir: repo, logger: logger(logs) });

    assert.equal(report.issuesScanned, 1);
    assert.ok(report.renamed.length >= 4);

    const dir = join(repo, '.wavemill', 'evals', 'artifacts', 'HOK-100');
    assert.ok(existsSync(join(dir, '.coding-result.json')));
    assert.ok(existsSync(join(dir, '.planning-result.json')));
    assert.ok(existsSync(join(dir, '.operator-intervention.json')));
    assert.ok(existsSync(join(dir, '.routing-complete')));
    assert.ok(!existsSync(join(dir, 'coding-result.json')));
    assert.ok(!existsSync(join(dir, 'planning-result.json')));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// protects: an already-migrated tree is a no-op.
test('migrateArchivedStageArtifacts is idempotent', () => {
  const repo = makeRepo();
  try {
    seedArchive(repo, 'HOK-101', '.coding-result.json', '{"stage":"coding"}');
    const logs = newLogs();
    const report = migrateArchivedStageArtifacts({ repoDir: repo, logger: logger(logs) });
    assert.equal(report.issuesScanned, 1);
    assert.equal(report.renamed.length, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// protects: both-exist tree keeps the dot-prefixed one and leaves source in place with a warn.
test('migrateArchivedStageArtifacts keeps dot-prefixed when both names exist', () => {
  const repo = makeRepo();
  try {
    seedArchive(repo, 'HOK-102', 'coding-result.json', '{"from":"dotless"}');
    seedArchive(repo, 'HOK-102', '.coding-result.json', '{"from":"dotted"}');
    const logs = newLogs();
    const report = migrateArchivedStageArtifacts({ repoDir: repo, logger: logger(logs) });
    const dir = join(repo, '.wavemill', 'evals', 'artifacts', 'HOK-102');
    assert.equal(readFileSync(join(dir, '.coding-result.json'), 'utf8'), '{"from":"dotted"}');
    assert.ok(existsSync(join(dir, 'coding-result.json')), 'legacy left in place when both exist');
    assert.ok(report.skipped.find((row) => row.from === 'coding-result.json' && row.reason === 'both-exist'));
    assert.ok(logs.warn.some((msg) => msg.includes('coding-result.json') && msg.includes('.coding-result.json')));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// protects: unrelated files in the archive dir are left alone.
test('migrateArchivedStageArtifacts leaves unrelated files alone', () => {
  const repo = makeRepo();
  try {
    seedArchive(repo, 'HOK-103', 'something-else.json', '{"keep":true}');
    seedArchive(repo, 'HOK-103', 'plan.md', '# plan');
    const logs = newLogs();
    const report = migrateArchivedStageArtifacts({ repoDir: repo, logger: logger(logs) });
    const dir = join(repo, '.wavemill', 'evals', 'artifacts', 'HOK-103');
    assert.ok(existsSync(join(dir, 'something-else.json')));
    assert.ok(existsSync(join(dir, 'plan.md')));
    assert.equal(report.renamed.length, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// protects: dry-run mode reports but does not touch disk.
test('migrateArchivedStageArtifacts --dry-run leaves disk unchanged', () => {
  const repo = makeRepo();
  try {
    seedArchive(repo, 'HOK-104', 'coding-result.json', '{"stage":"coding"}');
    const logs = newLogs();
    const report = migrateArchivedStageArtifacts({ repoDir: repo, dryRun: true, logger: logger(logs) });
    assert.ok(report.renamed.length >= 1);
    const dir = join(repo, '.wavemill', 'evals', 'artifacts', 'HOK-104');
    assert.ok(existsSync(join(dir, 'coding-result.json')));
    assert.ok(!existsSync(join(dir, '.coding-result.json')));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
