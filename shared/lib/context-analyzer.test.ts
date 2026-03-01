/**
 * Tests for context-analyzer.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from 'os';
import {
  detectStateManagement,
  detectApiClient,
  detectStyling,
  detectTestPatterns,
  analyzeDirectoryStructure,
  extractGotchas,
  analyzeCodeConventions,
} from './context-analyzer.ts';

describe('context-analyzer', () => {
  let testRepoDir: string;

  beforeEach(() => {
    // Create a temporary test repository
    testRepoDir = join(tmpdir(), `test-repo-${Date.now()}`);
    mkdirSync(testRepoDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test repository
    if (existsSync(testRepoDir)) {
      rmSync(testRepoDir, { recursive: true, force: true });
    }
  });

  describe('detectStateManagement', () => {
    it('detects Redux Toolkit', () => {
      const packageJson = {
        dependencies: {
          '@reduxjs/toolkit': '^1.9.0',
        },
      };
      writeFileSync(join(testRepoDir, 'package.json'), JSON.stringify(packageJson));

      const result = detectStateManagement(testRepoDir);
      assert.equal(result, 'Redux Toolkit');
    });

    it('detects Zustand', () => {
      const packageJson = {
        dependencies: {
          zustand: '^4.0.0',
        },
      };
      writeFileSync(join(testRepoDir, 'package.json'), JSON.stringify(packageJson));

      const result = detectStateManagement(testRepoDir);
      assert.equal(result, 'Zustand');
    });

    it('returns undefined when no state management is detected', () => {
      const packageJson = {
        dependencies: {},
      };
      writeFileSync(join(testRepoDir, 'package.json'), JSON.stringify(packageJson));

      const result = detectStateManagement(testRepoDir);
      assert.equal(result, undefined);
    });
  });

  describe('detectApiClient', () => {
    it('detects Axios', () => {
      const packageJson = {
        dependencies: {
          axios: '^1.0.0',
        },
      };
      writeFileSync(join(testRepoDir, 'package.json'), JSON.stringify(packageJson));

      const result = detectApiClient(testRepoDir);
      assert.equal(result, 'Axios');
    });

    it('detects React Query', () => {
      const packageJson = {
        dependencies: {
          '@tanstack/react-query': '^4.0.0',
        },
      };
      writeFileSync(join(testRepoDir, 'package.json'), JSON.stringify(packageJson));

      const result = detectApiClient(testRepoDir);
      assert.equal(result, 'React Query + fetch');
    });
  });

  describe('detectStyling', () => {
    it('detects Tailwind CSS', () => {
      const packageJson = {
        devDependencies: {
          tailwindcss: '^3.0.0',
        },
      };
      writeFileSync(join(testRepoDir, 'package.json'), JSON.stringify(packageJson));

      const result = detectStyling(testRepoDir);
      assert.equal(result, 'Tailwind CSS');
    });

    it('detects styled-components', () => {
      const packageJson = {
        dependencies: {
          'styled-components': '^5.0.0',
        },
      };
      writeFileSync(join(testRepoDir, 'package.json'), JSON.stringify(packageJson));

      const result = detectStyling(testRepoDir);
      assert.equal(result, 'styled-components');
    });
  });

  describe('analyzeDirectoryStructure', () => {
    it('identifies top-level directories', () => {
      mkdirSync(join(testRepoDir, 'src'));
      mkdirSync(join(testRepoDir, 'tests'));
      mkdirSync(join(testRepoDir, 'docs'));

      const result = analyzeDirectoryStructure(testRepoDir);

      assert.ok(result.topLevelDirs.includes('src'));
      assert.ok(result.topLevelDirs.includes('tests'));
      assert.ok(result.topLevelDirs.includes('docs'));
    });

    it('identifies source directory', () => {
      mkdirSync(join(testRepoDir, 'src'));

      const result = analyzeDirectoryStructure(testRepoDir);

      assert.equal(result.sourceDir, 'src');
    });

    it('identifies test directory', () => {
      mkdirSync(join(testRepoDir, 'tests'));

      const result = analyzeDirectoryStructure(testRepoDir);

      assert.equal(result.testDir, 'tests');
    });

    it('tracks config files', () => {
      writeFileSync(join(testRepoDir, 'package.json'), '{}');
      writeFileSync(join(testRepoDir, 'tsconfig.json'), '{}');
      writeFileSync(join(testRepoDir, 'jest.config.js'), '');

      const result = analyzeDirectoryStructure(testRepoDir);

      assert.ok(result.configFiles.includes('package.json'));
      assert.ok(result.configFiles.includes('tsconfig.json'));
      assert.ok(result.configFiles.includes('jest.config.js'));
    });
  });

  describe('extractGotchas', () => {
    it('extracts gotchas from CLAUDE.md', () => {
      const claudeMd = `
# Project

## Known Issues

- Database migrations must be run manually
- API rate limiting is strict (100 req/min)
`;
      writeFileSync(join(testRepoDir, 'CLAUDE.md'), claudeMd);

      const result = extractGotchas(testRepoDir);

      assert.deepEqual(result, [
        'Database migrations must be run manually',
        'API rate limiting is strict (100 req/min)',
      ]);
    });

    it('returns empty array when no gotchas found', () => {
      const claudeMd = `
# Project

Some basic documentation without gotchas.
`;
      writeFileSync(join(testRepoDir, 'CLAUDE.md'), claudeMd);

      const result = extractGotchas(testRepoDir);

      assert.deepEqual(result, []);
    });
  });

  describe('analyzeCodeConventions', () => {
    it('performs full convention analysis', () => {
      // Set up a realistic test repo
      mkdirSync(join(testRepoDir, 'src'));
      mkdirSync(join(testRepoDir, 'tests'));

      const packageJson = {
        dependencies: {
          react: '^18.0.0',
          zustand: '^4.0.0',
          axios: '^1.0.0',
        },
        devDependencies: {
          tailwindcss: '^3.0.0',
          jest: '^29.0.0',
        },
      };
      writeFileSync(join(testRepoDir, 'package.json'), JSON.stringify(packageJson));

      const result = analyzeCodeConventions(testRepoDir);

      assert.equal(result.patterns.stateManagement, 'Zustand');
      assert.equal(result.patterns.apiClient, 'Axios');
      assert.equal(result.patterns.styling, 'Tailwind CSS');
      assert.equal(result.structure.sourceDir, 'src');
      assert.equal(result.structure.testDir, 'tests');
    });
  });
});
