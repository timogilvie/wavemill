/**
 * Tests for permission-patterns module
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  matchesPattern,
  matchesAnyPattern,
  isSafePattern,
  getDefaultPatterns,
  getPatternsByCategory,
  getCategoryNames,
  FILE_SYSTEM_READ,
  GIT_READ,
  GITHUB_CLI_READ,
} from './permission-patterns.ts';

// ────────────────────────────────────────────────────────────────
// Pattern Matching Tests
// ────────────────────────────────────────────────────────────────

test('matchesPattern - exact match', () => {
  assert(matchesPattern('pwd', 'pwd'));
  assert(matchesPattern('env', 'env'));
  assert(matchesPattern('whoami', 'whoami'));
});

test('matchesPattern - wildcard match', () => {
  assert(matchesPattern('git status', 'git status*'));
  assert(matchesPattern('git status --short', 'git status*'));
  assert(matchesPattern('git status --porcelain', 'git status*'));
  assert(matchesPattern('ls -la', 'ls *'));
  assert(matchesPattern('find . -name "*.ts"', 'find *'));
});

test('matchesPattern - no match', () => {
  assert(!matchesPattern('git commit', 'git status*'));
  assert(!matchesPattern('rm file.txt', 'ls *'));
  assert(!matchesPattern('npm install', 'npm list*'));
});

test('matchesPattern - case sensitive', () => {
  assert(matchesPattern('git status', 'git status*'));
  assert(!matchesPattern('GIT STATUS', 'git status*'));
  assert(!matchesPattern('Git Status', 'git status*'));
});

test('matchesPattern - special characters', () => {
  // Patterns should handle special regex characters
  assert(matchesPattern('echo $HOME', 'echo *'));
  assert(matchesPattern('grep "pattern" file.txt', 'grep *'));
  assert(matchesPattern('find . -name "*.ts"', 'find *'));
});

test('matchesAnyPattern - matches one pattern', () => {
  const patterns = ['git status*', 'git log*', 'git show*'];
  assert(matchesAnyPattern('git status', patterns));
  assert(matchesAnyPattern('git log --oneline', patterns));
  assert(matchesAnyPattern('git show HEAD', patterns));
});

test('matchesAnyPattern - no matches', () => {
  const patterns = ['git status*', 'git log*', 'git show*'];
  assert(!matchesAnyPattern('git commit', patterns));
  assert(!matchesAnyPattern('git push', patterns));
  assert(!matchesAnyPattern('ls -la', patterns));
});

test('matchesAnyPattern - empty pattern list', () => {
  assert(!matchesAnyPattern('git status', []));
});

// ────────────────────────────────────────────────────────────────
// Safety Validation Tests
// ────────────────────────────────────────────────────────────────

test('isSafePattern - safe patterns', () => {
  assert(isSafePattern('git status*'));
  assert(isSafePattern('git log*'));
  assert(isSafePattern('ls *'));
  assert(isSafePattern('cat *'));
  assert(isSafePattern('gh pr view*'));
  assert(isSafePattern('npm list*'));
});

test('isSafePattern - dangerous patterns', () => {
  assert(!isSafePattern('rm *'));
  assert(!isSafePattern('git push*'));
  assert(!isSafePattern('git commit*'));
  assert(!isSafePattern('git reset*'));
  assert(!isSafePattern('npm install*'));
  assert(!isSafePattern('sudo *'));
  assert(!isSafePattern('chmod *'));
});

test('isSafePattern - case insensitive check', () => {
  assert(!isSafePattern('RM *'));
  assert(!isSafePattern('Git Push*'));
  assert(!isSafePattern('SUDO *'));
});

test('isSafePattern - git branch destructive variants', () => {
  assert(!isSafePattern('git branch -d*'));
  assert(!isSafePattern('git branch -D*'));
  assert(!isSafePattern('git branch -m*'));
  assert(!isSafePattern('git branch -M*'));
  // Read-only variants should be safe
  assert(isSafePattern('git branch --list*'));
  assert(isSafePattern('git branch -l*'));
});

// ────────────────────────────────────────────────────────────────
// Category Management Tests
// ────────────────────────────────────────────────────────────────

test('getDefaultPatterns - returns all patterns', () => {
  const patterns = getDefaultPatterns();
  assert(patterns.length > 0);
  assert(patterns.includes('git status*'));
  assert(patterns.includes('ls *'));
  assert(patterns.includes('gh pr view*'));
});

test('getCategoryNames - returns all category names', () => {
  const names = getCategoryNames();
  assert(names.includes('File System Read'));
  assert(names.includes('Git Read'));
  assert(names.includes('GitHub CLI Read'));
  assert(names.includes('Process & System Read'));
  assert(names.includes('Package Manager Read'));
  assert(names.includes('Text Search'));
});

test('getPatternsByCategory - returns patterns for valid category', () => {
  const gitPatterns = getPatternsByCategory('Git Read');
  assert(gitPatterns.length > 0);
  assert(gitPatterns.includes('git status*'));
  assert(gitPatterns.includes('git log*'));
});

test('getPatternsByCategory - returns empty for invalid category', () => {
  const patterns = getPatternsByCategory('Nonexistent Category');
  assert.equal(patterns.length, 0);
});

// ────────────────────────────────────────────────────────────────
// Category Content Tests
// ────────────────────────────────────────────────────────────────

test('FILE_SYSTEM_READ - contains expected patterns', () => {
  assert(FILE_SYSTEM_READ.patterns.includes('find *'));
  assert(FILE_SYSTEM_READ.patterns.includes('ls *'));
  assert(FILE_SYSTEM_READ.patterns.includes('cat *'));
  assert(FILE_SYSTEM_READ.patterns.includes('pwd'));
});

test('GIT_READ - contains expected patterns', () => {
  assert(GIT_READ.patterns.includes('git status*'));
  assert(GIT_READ.patterns.includes('git log*'));
  assert(GIT_READ.patterns.includes('git diff*'));
  assert(GIT_READ.patterns.includes('git show*'));
});

test('GITHUB_CLI_READ - contains expected patterns', () => {
  assert(GITHUB_CLI_READ.patterns.includes('gh pr view*'));
  assert(GITHUB_CLI_READ.patterns.includes('gh pr list*'));
  assert(GITHUB_CLI_READ.patterns.includes('gh issue view*'));
});

// ────────────────────────────────────────────────────────────────
// Integration Tests
// ────────────────────────────────────────────────────────────────

test('integration - real world git commands', () => {
  const patterns = getDefaultPatterns();

  // Should match
  assert(matchesAnyPattern('git status', patterns));
  assert(matchesAnyPattern('git status --short', patterns));
  assert(matchesAnyPattern('git log --oneline --graph', patterns));
  assert(matchesAnyPattern('git diff HEAD~1', patterns));
  assert(matchesAnyPattern('git show abc123', patterns));
  assert(matchesAnyPattern('git branch --list', patterns));
  assert(matchesAnyPattern('git worktree list', patterns));

  // Should not match
  assert(!matchesAnyPattern('git commit -m "message"', patterns));
  assert(!matchesAnyPattern('git push origin main', patterns));
  assert(!matchesAnyPattern('git reset --hard', patterns));
});

test('integration - real world gh commands', () => {
  const patterns = getDefaultPatterns();

  // Should match
  assert(matchesAnyPattern('gh pr view 123', patterns));
  assert(matchesAnyPattern('gh pr list --state open', patterns));
  assert(matchesAnyPattern('gh issue view 456', patterns));
  assert(matchesAnyPattern('gh repo view owner/repo', patterns));

  // Should not match
  assert(!matchesAnyPattern('gh pr create', patterns));
  assert(!matchesAnyPattern('gh pr merge 123', patterns));
  assert(!matchesAnyPattern('gh issue close 456', patterns));
});

test('integration - real world file system commands', () => {
  const patterns = getDefaultPatterns();

  // Should match
  assert(matchesAnyPattern('find . -name "*.ts"', patterns));
  assert(matchesAnyPattern('ls -la', patterns));
  assert(matchesAnyPattern('cat README.md', patterns));
  assert(matchesAnyPattern('head -n 10 file.txt', patterns));
  assert(matchesAnyPattern('tail -f log.txt', patterns));
  assert(matchesAnyPattern('wc -l file.txt', patterns));

  // Should not match
  assert(!matchesAnyPattern('rm file.txt', patterns));
  assert(!matchesAnyPattern('chmod 755 script.sh', patterns));
});

test('integration - all default patterns are safe', () => {
  const patterns = getDefaultPatterns();
  for (const pattern of patterns) {
    assert(
      isSafePattern(pattern),
      `Pattern "${pattern}" should be safe but failed safety check`
    );
  }
});
