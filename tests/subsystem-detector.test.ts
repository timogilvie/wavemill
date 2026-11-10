// wavemill-test-suite: none (ran in no suite before HOK-3466; run it or delete it)
/**
 * Unit tests for subsystem-detector.ts
 *
 * Verifies subsystem detection logic without requiring a full repo setup.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { detectSubsystems, subsystemDetectorDeps } from '../shared/lib/subsystem-detector.ts';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

describe('subsystem-detector', () => {
  describe('detectSubsystems', () => {
    it('detects subsystems in wavemill repo', () => {
      const subsystems = detectSubsystems(REPO_ROOT, {
        minFiles: 3,
        useGitAnalysis: false, // Skip git for speed
        maxSubsystems: 20,
      });

      // Should detect at least some subsystems
      assert.ok(subsystems.length > 0, 'Should detect at least one subsystem');

      // Each subsystem should have required fields
      for (const subsystem of subsystems) {
        assert.ok(subsystem.id, 'Subsystem should have an ID');
        assert.ok(subsystem.name, 'Subsystem should have a name');
        assert.ok(subsystem.description, 'Subsystem should have a description');
        assert.ok(Array.isArray(subsystem.keyFiles), 'Subsystem should have keyFiles array');
        assert.ok(subsystem.keyFiles.length >= 3, `Subsystem ${subsystem.id} should have at least 3 key files`);
        assert.ok(typeof subsystem.confidence === 'number', 'Confidence should be a number');
        assert.ok(subsystem.confidence >= 0 && subsystem.confidence <= 1, 'Confidence should be 0-1');
      }
    });

    it('respects maxSubsystems limit', () => {
      const subsystems = detectSubsystems(REPO_ROOT, {
        minFiles: 1,
        useGitAnalysis: false,
        maxSubsystems: 3,
      });

      assert.ok(subsystems.length <= 3, 'Should respect maxSubsystems limit');
    });

    it('detects different subsystem types', () => {
      const subsystems = detectSubsystems(REPO_ROOT, {
        minFiles: 3,
        useGitAnalysis: false,
        maxSubsystems: 20,
      });

      // Should detect subsystems using different methods
      const methods = new Set(subsystems.map(s => s.detectionMethod));
      assert.ok(methods.size > 0, 'Should use at least one detection method');
    });

    it('detects package imports with shell-special dependency names and paths', () => {
      const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-subsystem-detector-'));
      const packageName = 'react"pkg$(touch owned);[x]*';
      const sourceDir = 'src/app/(auth)/onboarding';
      const sourcePath = join(repoDir, sourceDir);
      mkdirSync(sourcePath, { recursive: true });
      writeFileSync(join(repoDir, 'package.json'), JSON.stringify({
        dependencies: {
          [packageName]: '1.0.0',
        },
      }));

      for (const file of ['page.tsx', 'with space.tsx', '[tenant]*.tsx']) {
        writeFileSync(
          join(sourcePath, file),
          `import thing from '${packageName}';\nexport default thing;\n`
        );
      }

      const subsystems = detectSubsystems(repoDir, {
        minFiles: 1,
        useGitAnalysis: false,
        maxSubsystems: 10,
        sourceDirs: ['src'],
      });

      const subsystem = subsystems.find(s => s.keyFiles.includes(`${sourceDir}/page.tsx`));
      assert.ok(subsystem, 'Should detect subsystem containing shell-special import path');
      assert.ok(subsystem.keyFiles.includes(`${sourceDir}/with space.tsx`));
      assert.ok(subsystem.keyFiles.includes(`${sourceDir}/[tenant]*.tsx`));
    });

    it('passes grep package patterns and source paths as literal argv', (t) => {
      const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-subsystem-detector-argv-'));
      const packageName = 'react"pkg$(touch owned);[x]*';
      const sourceDir = 'src/app/(auth)';
      const sourcePath = join(repoDir, sourceDir);
      mkdirSync(sourcePath, { recursive: true });
      writeFileSync(join(repoDir, 'package.json'), JSON.stringify({
        dependencies: {
          [packageName]: '1.0.0',
        },
      }));

      const matchedFile = join(sourcePath, 'page.tsx');
      writeFileSync(matchedFile, `import thing from '${packageName}';\n`);

      const calls: Array<{ file: string; args: readonly string[] }> = [];
      t.mock.method(subsystemDetectorDeps, 'execArgvCommand', (file: string, args: readonly string[]) => {
        calls.push({ file, args });
        return { stdout: `${matchedFile}\n`, stderr: '', exitCode: 0, failed: false };
      });

      detectSubsystems(repoDir, {
        minFiles: 1,
        useGitAnalysis: false,
        maxSubsystems: 10,
        sourceDirs: ['src'],
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].file, 'grep');
      assert.deepEqual(calls[0].args, [
        '-r',
        '-l',
        '-F',
        '--include=*.ts',
        '--include=*.js',
        '--include=*.tsx',
        '--include=*.jsx',
        '-e',
        `from '${packageName}`,
        '-e',
        `from "${packageName}`,
        '--',
        join(repoDir, 'src'),
      ]);
    });
  });
});
