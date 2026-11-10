// wavemill-test-suite: custom
/**
 * Tests for repo-context-analyzer (HOK-774).
 *
 * These tests run against the actual wavemill repository for integration testing.
 */

import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { errorMessage } from './error-utils.ts';
import {
  detectLanguages,
  detectFrameworks,
  detectBuildSystem,
  detectPackageManager,
  detectTestFrameworks,
  detectCiProvider,
  computeRepoSize,
  isMonorepo,
  computeRepoId,
  detectRepoVisibility,
  analyzeRepoContext,
} from './repo-context-analyzer.ts';

// ────────────────────────────────────────────────────────────────
// Test Helpers
// ────────────────────────────────────────────────────────────────

function testSection(name: string) {
  console.log(`\n--- ${name} ---\n`);
}

function test(description: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${description}`);
  } catch (error) {
    console.error(`  FAIL  ${description}`);
    console.error(`    ${errorMessage(error)}`);
    process.exit(1);
  }
}

// Test against the wavemill repo (parent of shared/lib)
const REPO_DIR = resolve(import.meta.dirname, '../..');

// ────────────────────────────────────────────────────────────────
// Language Detection Tests
// ────────────────────────────────────────────────────────────────

testSection('Language Detection Tests');

test('Detects primary language in wavemill repo', () => {
  const result = detectLanguages(REPO_DIR);
  assert.ok(result.primaryLanguage);
  assert.ok(['TypeScript', 'JavaScript'].includes(result.primaryLanguage));
});

test('Returns language percentages', () => {
  const result = detectLanguages(REPO_DIR);
  if (result.languages) {
    assert.ok(Object.keys(result.languages).length > 0);
    const total = Object.values(result.languages).reduce((sum, pct) => sum + pct, 0);
    assert.ok(total > 0 && total <= 100);
  }
});

test('Primary language appears in languages map', () => {
  const result = detectLanguages(REPO_DIR);
  if (result.languages) {
    assert.ok(result.primaryLanguage in result.languages);
  }
});

// ────────────────────────────────────────────────────────────────
// Framework Detection Tests
// ────────────────────────────────────────────────────────────────

testSection('Framework Detection Tests');

test('Returns array of frameworks', () => {
  const result = detectFrameworks(REPO_DIR);
  assert.ok(Array.isArray(result));
});

test('Frameworks are non-empty strings', () => {
  const result = detectFrameworks(REPO_DIR);
  for (const framework of result) {
    assert.ok(typeof framework === 'string');
    assert.ok(framework.length > 0);
  }
});

// ────────────────────────────────────────────────────────────────
// Build System Detection Tests
// ────────────────────────────────────────────────────────────────

testSection('Build System Detection Tests');

test('Returns string or undefined', () => {
  const result = detectBuildSystem(REPO_DIR);
  assert.ok(result === undefined || typeof result === 'string');
});

// ────────────────────────────────────────────────────────────────
// Package Manager Detection Tests
// ────────────────────────────────────────────────────────────────

testSection('Package Manager Detection Tests');

test('Returns string or undefined', () => {
  const result = detectPackageManager(REPO_DIR);
  assert.ok(result === undefined || typeof result === 'string');
  if (result) {
    assert.ok(result.length > 0);
  }
});

// ────────────────────────────────────────────────────────────────
// Test Framework Detection Tests
// ────────────────────────────────────────────────────────────────

testSection('Test Framework Detection Tests');

test('Returns array of test frameworks', () => {
  const result = detectTestFrameworks(REPO_DIR);
  assert.ok(Array.isArray(result));
});

test('Test frameworks are non-empty strings', () => {
  const result = detectTestFrameworks(REPO_DIR);
  for (const framework of result) {
    assert.ok(typeof framework === 'string');
    assert.ok(framework.length > 0);
  }
});

test('Detects the built-in Node test runner from package scripts', () => {
  const result = detectTestFrameworks(REPO_DIR);
  assert.ok(result.includes('node:test'));
});

// ────────────────────────────────────────────────────────────────
// CI Provider Detection Tests
// ────────────────────────────────────────────────────────────────

testSection('CI Provider Detection Tests');

test('Detects CI provider or returns undefined', () => {
  const result = detectCiProvider(REPO_DIR);
  assert.ok(result === undefined || typeof result === 'string');
});

// ────────────────────────────────────────────────────────────────
// Repo Size Tests
// ────────────────────────────────────────────────────────────────

testSection('Repo Size Tests');

test('Computes file count', () => {
  const result = computeRepoSize(REPO_DIR);
  assert.ok(typeof result.fileCount === 'number');
  assert.ok(result.fileCount > 0);
});

test('Computes LOC', () => {
  const result = computeRepoSize(REPO_DIR);
  assert.ok(typeof result.loc === 'number');
  assert.ok(result.loc > 0);
});

test('Computes dependency count', () => {
  const result = computeRepoSize(REPO_DIR);
  assert.ok(typeof result.dependencyCount === 'number');
  assert.ok(result.dependencyCount >= 0);
});

test('File count is reasonable (not too small)', () => {
  const result = computeRepoSize(REPO_DIR);
  // Wavemill should have at least 10 files
  assert.ok(result.fileCount >= 10);
});

// ────────────────────────────────────────────────────────────────
// Monorepo Detection Tests
// ────────────────────────────────────────────────────────────────

testSection('Monorepo Detection Tests');

test('Returns boolean', () => {
  const result = isMonorepo(REPO_DIR);
  assert.ok(typeof result === 'boolean');
});

// ────────────────────────────────────────────────────────────────
// Repo ID Tests
// ────────────────────────────────────────────────────────────────

testSection('Repo ID Tests');

test('Generates stable repo ID', () => {
  const id1 = computeRepoId(REPO_DIR);
  const id2 = computeRepoId(REPO_DIR);
  assert.equal(id1, id2, 'Repo ID should be stable across calls');
});

test('Repo ID is non-empty string', () => {
  const result = computeRepoId(REPO_DIR);
  assert.ok(typeof result === 'string');
  assert.ok(result.length > 0);
});

// ────────────────────────────────────────────────────────────────
// Repo Visibility Tests
// ────────────────────────────────────────────────────────────────

testSection('Repo Visibility Tests');

test('Detects repo visibility', () => {
  const result = detectRepoVisibility(REPO_DIR);
  assert.ok(['oss', 'private'].includes(result));
});

// ────────────────────────────────────────────────────────────────
// Integration Tests
// ────────────────────────────────────────────────────────────────

testSection('Integration Tests');

test('analyzeRepoContext returns complete context', () => {
  const result = analyzeRepoContext(REPO_DIR);

  // Required fields
  assert.ok(result.repoId);
  assert.ok(['oss', 'private'].includes(result.repoVisibility));
  assert.ok(result.primaryLanguage);

  // Field types
  assert.ok(typeof result.repoId === 'string');
  assert.ok(typeof result.primaryLanguage === 'string');

  console.log(`\n  Detected context for wavemill repo:`);
  console.log(`    - Repo ID: ${result.repoId}`);
  console.log(`    - Visibility: ${result.repoVisibility}`);
  console.log(`    - Primary Language: ${result.primaryLanguage}`);
  if (result.languages) {
    console.log(
      `    - Languages: ${Object.entries(result.languages)
        .map(([lang, pct]) => `${lang} (${pct}%)`)
        .join(', ')}`
    );
  }
  if (result.frameworks && result.frameworks.length > 0) {
    console.log(`    - Frameworks: ${result.frameworks.join(', ')}`);
  }
  if (result.packageManager) {
    console.log(`    - Package Manager: ${result.packageManager}`);
  }
  if (result.buildSystem) {
    console.log(`    - Build System: ${result.buildSystem}`);
  }
  if (result.testFrameworks && result.testFrameworks.length > 0) {
    console.log(`    - Test Frameworks: ${result.testFrameworks.join(', ')}`);
  }
  if (result.ciProvider) {
    console.log(`    - CI Provider: ${result.ciProvider}`);
  }
  if (result.repoSize) {
    console.log(
      `    - Repo Size: ${result.repoSize.fileCount} files, ${result.repoSize.loc} LOC, ${result.repoSize.dependencyCount} deps`
    );
  }
  console.log(`    - Monorepo: ${result.monorepo || false}`);
});

test('analyzeRepoContext is performant (< 5 seconds)', () => {
  const start = Date.now();
  analyzeRepoContext(REPO_DIR);
  const duration = Date.now() - start;
  assert.ok(duration < 5000, `Analysis took ${duration}ms, should be < 5000ms`);
});

test('Required fields are always present', () => {
  const result = analyzeRepoContext(REPO_DIR);
  assert.ok('repoId' in result);
  assert.ok('repoVisibility' in result);
  assert.ok('primaryLanguage' in result);
});

console.log('\n✅ All repo context analyzer tests passed!\n');
