import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTaskArtifact, resolveTaskArtifactDirs } from './task-artifact-lookup.ts';

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'tal-test-'));
  // Fake main repo: a .wavemill marker so resolveFromMainRepo stays here.
  mkdirSync(join(root, '.wavemill'), { recursive: true });
  // Minimal config so loadWavemillConfig returns a defaulted shape.
  writeFileSync(join(root, '.wavemill-config.json'), '{}');
  return root;
}

// protects: live `.coding-result.json` under features/<slug> is preferred over the archive copy.
test('resolveTaskArtifact prefers the live feature dir over the archive', () => {
  const repo = makeRepo();
  try {
    const slug = 'hok-9999-add-x';
    const liveDir = join(repo, 'features', slug);
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(join(liveDir, '.coding-result.json'), '{"from":"live"}');

    const archiveDir = join(repo, '.wavemill', 'evals', 'artifacts', 'HOK-9999');
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, '.coding-result.json'), '{"from":"archive"}');

    const resolved = resolveTaskArtifact({
      issueId: 'HOK-9999',
      slug,
      artifactName: '.coding-result.json',
      repoDir: repo,
    });
    assert.ok(resolved);
    assert.equal(resolved!.source, 'live');
    assert.equal(resolved!.path, join(liveDir, '.coding-result.json'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// protects: an archived `.coding-result.json` resolves when the worktree is gone (HOK-2885).
test('resolveTaskArtifact falls back to the archive when no live dir exists', () => {
  const repo = makeRepo();
  try {
    const archiveDir = join(repo, '.wavemill', 'evals', 'artifacts', 'HOK-2885_c');
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(
      join(archiveDir, '.coding-result.json'),
      '{"model":"openrouter:devstral-small","status":"completed"}',
    );

    const resolved = resolveTaskArtifact({
      issueId: 'HOK-2885_c',
      slug: 'hok-2885-c-missing',
      artifactName: '.coding-result.json',
      repoDir: repo,
    });
    assert.ok(resolved);
    assert.equal(resolved!.source, 'archive');
    assert.equal(resolved!.path, join(archiveDir, '.coding-result.json'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// protects: a reader asked for a missing artifact gets null, not an error.
test('resolveTaskArtifact returns null when neither live nor archive has the file', () => {
  const repo = makeRepo();
  try {
    const resolved = resolveTaskArtifact({
      issueId: 'HOK-1',
      slug: 'absent',
      artifactName: '.planning-result.json',
      repoDir: repo,
    });
    assert.equal(resolved, null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// protects: `bugs/<slug>` is probed after `features/<slug>` and resolves correctly.
test('resolveTaskArtifact probes bugs/<slug> when features/<slug> has nothing', () => {
  const repo = makeRepo();
  try {
    const slug = 'hok-7-bug';
    const bugsDir = join(repo, 'bugs', slug);
    mkdirSync(bugsDir, { recursive: true });
    writeFileSync(join(bugsDir, '.review-result.json'), '{"stage":"review"}');

    const resolved = resolveTaskArtifact({
      issueId: 'HOK-7',
      slug,
      artifactName: '.review-result.json',
      repoDir: repo,
    });
    assert.ok(resolved);
    assert.equal(resolved!.source, 'live');
    assert.equal(resolved!.featureDir, bugsDir);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// protects: resolveTaskArtifactDirs returns only directories that exist.
test('resolveTaskArtifactDirs returns live feature dirs and archive dir that exist', () => {
  const repo = makeRepo();
  try {
    const slug = 'hok-8-dirs';
    const liveDir = join(repo, 'features', slug);
    mkdirSync(liveDir, { recursive: true });

    const archiveDir = join(repo, '.wavemill', 'evals', 'artifacts', 'HOK-8');
    mkdirSync(archiveDir, { recursive: true });

    const dirs = resolveTaskArtifactDirs({
      issueId: 'HOK-8',
      slug,
      repoDir: repo,
    });
    assert.ok(dirs.liveFeatureDirs.includes(liveDir));
    assert.equal(dirs.archiveDir, archiveDir);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// protects: artifactName must be a bare basename — a reader cannot escape via `..`.
test('resolveTaskArtifact rejects artifactName with path separators', () => {
  assert.throws(
    () =>
      resolveTaskArtifact({
        issueId: 'HOK-9',
        slug: 'slug',
        artifactName: '../etc/passwd',
      }),
    /must be a basename/,
  );
});
