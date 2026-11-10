// wavemill-test-suite: none (ran in no suite before HOK-3466; run it or delete it)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateSubsystemSpec,
  subsystemSpecGeneratorDeps,
} from '../shared/lib/subsystem-spec-generator.ts';
import type { Subsystem } from '../shared/lib/subsystem-detector.ts';

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function writeTemplate(repoDir: string): string {
  const templatePath = join(repoDir, 'subsystem-template.md');
  writeFileSync(templatePath, [
    '# Subsystem: {NAME}',
    'Files touched: {FILE_COUNT}',
    '{KEY_FILES_TABLE}',
    'Recent:',
    '{RECENT_CHANGES}',
    '{TIMESTAMP}',
    '{ID}',
    '{DESCRIPTION}',
    '{DO_RULES}',
    '{DONT_RULES}',
    '{FAILURE_MODES}',
    '{TEST_PATTERNS}',
    '{TEST_SCENARIOS}',
    '{DEPENDENCIES}',
    '{DEPENDENTS}',
    '{RELATED_SUBSYSTEMS}',
    '{RELATED_CONCEPTS}',
  ].join('\n'));
  return templatePath;
}

describe('subsystem-spec-generator', () => {
  it('does not misclassify implementation files containing spec in their names', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-subsystem-spec-role-'));
    const subsystem: Subsystem = {
      id: 'generator',
      name: 'Generator',
      description: 'Generator files',
      keyFiles: ['shared/lib/subsystem-spec-generator.ts', 'shared/lib/example.test.ts'],
      testPatterns: [],
      dependencies: [],
      confidence: 1,
      detectionMethod: 'pattern',
    };

    const spec = generateSubsystemSpec(subsystem, {
      repoDir,
      includeGitHistory: false,
    });

    assert.match(spec, /subsystem-spec-generator\.ts` \| Implementation \| TypeScript/);
    assert.match(spec, /example\.test\.ts` \| Test \| Unit tests/);
  });

  it('queries git history for shell-special paths literally', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-subsystem-spec-git-'));
    const keyFiles = [
      'app/(auth)/dashboard/page.tsx',
      'app/with space/page.tsx',
      "app/quote'path/page.tsx",
      'app/[tenant]/star*.tsx',
      '--leading-dash.ts',
    ];

    git(repoDir, ['init']);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test User']);

    for (const file of keyFiles) {
      mkdirSync(join(repoDir, file, '..'), { recursive: true });
      writeFileSync(join(repoDir, file), `export const value = ${JSON.stringify(file)};\n`);
    }

    git(repoDir, ['add', '--', ...keyFiles]);
    git(repoDir, ['commit', '-m', 'add shell special files']);

    const subsystem: Subsystem = {
      id: 'special-paths',
      name: 'Special Paths',
      description: 'Files with shell-special paths',
      keyFiles,
      testPatterns: [],
      dependencies: [],
      confidence: 1,
      detectionMethod: 'directory',
    };

    const spec = generateSubsystemSpec(subsystem, {
      repoDir,
      templatePath: writeTemplate(repoDir),
      includeGitHistory: true,
    });

    assert.match(spec, /Files touched: [1-9]\d*/);
    assert.match(spec, /- [0-9a-f]+ add shell special files/);
  });

  it('passes git pathspecs as separate argv entries after --', (t) => {
    const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-subsystem-spec-argv-'));
    const keyFiles = [
      'app/(auth)/dashboard/page.tsx',
      'app/with space/page.tsx',
      "app/quote'path/page.tsx",
      'app/[tenant]/star*.tsx',
      '--leading-dash.ts',
    ];
    const calls: Array<{ file: string; args: readonly string[] }> = [];

    t.mock.method(subsystemSpecGeneratorDeps, 'execArgvCommand', (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      return {
        stdout: calls.length === 1 ? 'abc123 touched files\n' : 'abc123 recent change\n',
        stderr: '',
        exitCode: 0,
        failed: false,
      };
    });

    const subsystem: Subsystem = {
      id: 'special-paths',
      name: 'Special Paths',
      description: 'Files with shell-special paths',
      keyFiles,
      testPatterns: [],
      dependencies: [],
      confidence: 1,
      detectionMethod: 'directory',
    };

    const spec = generateSubsystemSpec(subsystem, {
      repoDir,
      templatePath: writeTemplate(repoDir),
      includeGitHistory: true,
    });

    assert.match(spec, /Files touched: 1/);
    assert.match(spec, /- abc123 recent change/);
    assert.equal(calls.length, 2);

    for (const call of calls) {
      assert.equal(call.file, 'git');
      const separatorIndex = call.args.indexOf('--');
      assert.notEqual(separatorIndex, -1);
      assert.deepEqual(call.args.slice(separatorIndex + 1), keyFiles);
    }
  });
});
