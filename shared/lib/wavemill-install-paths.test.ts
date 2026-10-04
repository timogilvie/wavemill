import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { TERMINAL_RECONCILER_SCRIPT, WAVEMILL_COMMON_SCRIPT } from './terminal-inbox-cleanup.ts';
import {
  resolveWavemillAssetPath,
  resolveWavemillInstallDir,
  resolveWavemillPromptPath,
  resolveWavemillToolPath,
  resolveWavemillToolsDir,
} from './native-agent/install-paths.ts';
import { resolveWavemillInstallDir as resolveWavemillInstallDirFromEvals } from './evals-paths.ts';

// Wavemill's shell libraries and prompts ship with the install. Joining them
// onto the milled repo's dir only works when the mill runs on wavemill itself;
// in any other repo `wavemill cleanup` and native heartbeats silently break.

test('terminal inbox cleanup sources shell libs from the wavemill install', () => {
  for (const script of [WAVEMILL_COMMON_SCRIPT, TERMINAL_RECONCILER_SCRIPT]) {
    assert.ok(isAbsolute(script), script);
    assert.ok(existsSync(script), script);
  }
});

test('no shared/lib module resolves wavemill shell libs or prompts under a repo dir', () => {
  const offenders: string[] = [];
  const pattern = /join\(\s*[\w.]*repoDir\s*,\s*'(shared\/lib|tools\/prompts)\//i;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith('.ts') && !file.endsWith('.test.ts') && pattern.test(readFileSync(file, 'utf-8'))) {
        offenders.push(file);
      }
    }
  };
  walk('shared/lib');
  assert.deepEqual(offenders, []);
});

test('resolveWavemillInstallDir resolves this checkout and contains tools/route-task.ts', () => {
  const installDir = resolveWavemillInstallDir();
  assert.ok(isAbsolute(installDir), installDir);
  assert.ok(existsSync(join(installDir, 'tools', 'route-task.ts')), installDir);
});

test('install-paths resolvers ignore cwd (simulated milled repo)', () => {
  const originalCwd = process.cwd();
  const tempRepo = mkdtempSync(join(tmpdir(), 'wm-install-paths-cwd-'));
  try {
    process.chdir(tempRepo);
    const tool = resolveWavemillToolPath('route-task.ts');
    const prompt = resolveWavemillPromptPath('planning-phase.md');
    const asset = resolveWavemillAssetPath('tools/prompts/planning-phase.md');
    for (const path of [tool, prompt, asset]) {
      assert.ok(isAbsolute(path), `expected absolute: ${path}`);
      assert.ok(existsSync(path), `expected to exist: ${path}`);
      assert.ok(!path.startsWith(tempRepo), `expected not under temp cwd: ${path}`);
    }
    assert.equal(resolveWavemillToolsDir(), join(resolveWavemillInstallDir(), 'tools'));
  } finally {
    process.chdir(originalCwd);
    rmSync(tempRepo, { recursive: true, force: true });
  }
});

test('resolveWavemillAssetPath returns absolute paths unchanged', () => {
  const abs = '/absolute/path/to/x.json';
  assert.equal(resolveWavemillAssetPath(abs), abs);
});

test('WAVEMILL_DIR env override re-roots asset resolution', () => {
  const originalEnv = process.env.WAVEMILL_DIR;
  const tempDir = mkdtempSync(join(tmpdir(), 'wm-install-paths-env-'));
  try {
    process.env.WAVEMILL_DIR = tempDir;
    assert.equal(resolveWavemillInstallDir(), tempDir);
    assert.equal(resolveWavemillToolPath('x.ts'), join(tempDir, 'tools', 'x.ts'));
    assert.equal(resolveWavemillAssetPath('dspy/artifacts/x.json'), join(tempDir, 'dspy/artifacts/x.json'));
  } finally {
    if (originalEnv === undefined) delete process.env.WAVEMILL_DIR;
    else process.env.WAVEMILL_DIR = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('evals-paths re-exports the same resolveWavemillInstallDir', () => {
  assert.equal(resolveWavemillInstallDirFromEvals, resolveWavemillInstallDir);
});

test('scanning shared/lib finds no join(repoDir|cwd, "tools/" | "dspy/" | "shared/" | "claude/" | "codex/")', () => {
  // Narrow TS backstop that complements tests/check-install-paths.test.sh:
  // this catches the exact `join/resolve(... , 'tools/' | 'dspy/' | ...)`
  // shape in shared/lib, independent of the shell scanner.
  const offenders: string[] = [];
  const pattern = /(?:join|resolve)\(\s*[\w.]*(?:repoDir|repoRoot|cwd|worktreeDir)[^,)]*,\s*['"`](tools|dspy|shared|claude|codex)(?:\/|['"`])/;
  const allowMarker = /install-paths: allow/;
  const commentLine = /^\s*(?:\/\/|\*|\/\*)/;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith('.ts') && !file.endsWith('.test.ts')) {
        const lines = readFileSync(file, 'utf-8').split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i]!;
          if (commentLine.test(line)) continue;
          if (allowMarker.test(line)) continue;
          if (pattern.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }
  };
  walk(resolve('shared/lib'));
  assert.deepEqual(offenders, [], offenders.join('\n'));
});
