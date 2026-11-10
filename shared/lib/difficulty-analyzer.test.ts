// wavemill-test-suite: custom
/**
 * Tests for difficulty-analyzer module (HOK-777).
 */

import assert from 'node:assert/strict';
import {
  analyzeDiffStats,
  detectTechStack,
  computeDifficultyBand,
  computeStratum,
  analyzePrDifficulty,
  fetchPrStatsFromApi,
} from './difficulty-analyzer.ts';

// ────────────────────────────────────────────────────────────────
// Test Helpers
// ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

// ────────────────────────────────────────────────────────────────
// Test Fixtures
// ────────────────────────────────────────────────────────────────

// Numstat format (from `git diff --numstat` or `gh pr diff`)
const numstatDiff = `10\t5\tsrc/file1.ts
2\t3\tsrc/file2.tsx
15\t0\tsrc/file3.js
0\t8\tsrc/file4.py`;

// Unified diff format (from regular `git diff`)
const unifiedDiff = `diff --git a/src/component.tsx b/src/component.tsx
index abc123..def456 100644
--- a/src/component.tsx
+++ b/src/component.tsx
@@ -1,5 +1,8 @@
 import React from 'react';

+export function NewComponent() {
+  return <div>Hello</div>;
+}
+
 export function OldComponent() {
-  return <div>Old</div>;
+  return <div>Updated</div>;
 }`;

const emptyDiff = '';

const largeDiff = Array(1500)
  .fill(0)
  .map((_, i) => `1\t1\tsrc/file${i}.ts`)
  .join('\n');

const multiLanguageDiff = `10\t5\tsrc/component.tsx
5\t3\tsrc/utils.ts
20\t10\tserver/api.py
2\t1\tgo.mod
1\t0\tCargo.toml`;

// ────────────────────────────────────────────────────────────────
// analyzeDiffStats Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- analyzeDiffStats Tests ---\n');

test('Parses numstat format correctly', () => {
  const result = analyzeDiffStats(numstatDiff);
  assert.ok(result !== null);
  assert.equal(result.locTouched, 10 + 5 + 2 + 3 + 15 + 0 + 0 + 8); // 43
  assert.equal(result.filesTouched, 4);
});

test('Parses unified diff format correctly', () => {
  const result = analyzeDiffStats(unifiedDiff);
  assert.ok(result !== null);
  assert.equal(result.filesTouched, 1);
  // Unified diff counts: +4 lines (including blank), -2 lines = 6 LOC
  assert.equal(result.locTouched, 6);
});

test('Returns null for empty diff', () => {
  const result = analyzeDiffStats(emptyDiff);
  assert.equal(result, null);
});

test('Handles large diffs correctly', () => {
  const result = analyzeDiffStats(largeDiff);
  assert.ok(result !== null);
  assert.equal(result.locTouched, 1500 * 2); // 1 addition + 1 deletion per file
  assert.equal(result.filesTouched, 1500);
});

test('Handles binary file markers (- -)', () => {
  const binaryDiff = `10\t5\tsrc/file.ts
-\t-\timages/logo.png`;
  const result = analyzeDiffStats(binaryDiff);
  assert.ok(result !== null);
  assert.equal(result.locTouched, 15); // Only counts the .ts file
  assert.equal(result.filesTouched, 2); // Still counts both files
});

// ────────────────────────────────────────────────────────────────
// detectTechStack Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- detectTechStack Tests ---\n');

test('Detects TypeScript React', () => {
  const diff = `10\t5\tsrc/component.tsx
2\t1\tsrc/utils.ts`;
  const stack = detectTechStack(diff);
  // Without package.json, falls back to ts_std
  assert.equal(stack, 'ts_std');
});

test('Detects Next.js', () => {
  const diff = `10\t5\tsrc/pages/index.tsx
2\t1\tnext.config.js`;
  const stack = detectTechStack(diff);
  assert.equal(stack, 'ts_nextjs');
});

test('Detects Python standard library', () => {
  const diff = `10\t5\tsrc/main.py
2\t1\tsrc/utils.py`;
  const stack = detectTechStack(diff);
  assert.equal(stack, 'py_std');
});

test('Detects Go', () => {
  const diff = `10\t5\tmain.go
2\t1\tgo.mod`;
  const stack = detectTechStack(diff);
  assert.equal(stack, 'go_std');
});

test('Detects Rust', () => {
  const diff = `10\t5\tsrc/main.rs
2\t1\tCargo.toml`;
  const stack = detectTechStack(diff);
  assert.equal(stack, 'rust_std');
});

test('Returns most common language for mixed stacks', () => {
  const stack = detectTechStack(multiLanguageDiff);
  // Has go.mod, so Go detection takes priority
  assert.equal(stack, 'go_std');
});

test('Returns unknown for no recognizable files', () => {
  const diff = `10\t5\tREADME.md
2\t1\t.gitignore`;
  const stack = detectTechStack(diff);
  assert.equal(stack, 'unknown');
});

// ────────────────────────────────────────────────────────────────
// computeDifficultyBand Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- computeDifficultyBand Tests ---\n');

test('Classifies trivial PR (5 LOC, 1 file)', () => {
  const band = computeDifficultyBand({
    locTouched: 5,
    filesTouched: 1,
  });
  assert.equal(band, 'trivial');
});

test('Classifies easy PR (80 LOC, 3 files)', () => {
  const band = computeDifficultyBand({
    locTouched: 80,
    filesTouched: 3,
  });
  assert.equal(band, 'easy');
});

test('Classifies medium PR (250 LOC, 7 files)', () => {
  const band = computeDifficultyBand({
    locTouched: 250,
    filesTouched: 7,
  });
  assert.equal(band, 'medium');
});

test('Classifies hard PR (800 LOC, 15 files)', () => {
  const band = computeDifficultyBand({
    locTouched: 800,
    filesTouched: 15,
  });
  assert.equal(band, 'hard');
});

test('Classifies very_hard PR (1500 LOC, 25 files)', () => {
  const band = computeDifficultyBand({
    locTouched: 1500,
    filesTouched: 25,
  });
  assert.equal(band, 'very_hard');
});

test('Classifies by LOC even with few files', () => {
  const band = computeDifficultyBand({
    locTouched: 1200,
    filesTouched: 5,
  });
  assert.equal(band, 'very_hard');
});

test('Classifies by file count even with few LOC', () => {
  const band = computeDifficultyBand({
    locTouched: 50,
    filesTouched: 25,
  });
  assert.equal(band, 'very_hard');
});

test('Boundary case: 20 LOC = easy (not trivial)', () => {
  const band = computeDifficultyBand({
    locTouched: 20,
    filesTouched: 1,
  });
  assert.equal(band, 'easy');
});

test('Boundary case: 100 LOC = medium (not easy)', () => {
  const band = computeDifficultyBand({
    locTouched: 100,
    filesTouched: 2,
  });
  assert.equal(band, 'medium');
});

// ────────────────────────────────────────────────────────────────
// computeStratum Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- computeStratum Tests ---\n');

test('Computes small stratum (< 100 LOC)', () => {
  const stratum = computeStratum('ts_nextjs', {
    locTouched: 50,
    filesTouched: 3,
  });
  assert.equal(stratum, 'ts_nextjs_small');
});

test('Computes med stratum (100-499 LOC)', () => {
  const stratum = computeStratum('py_django', {
    locTouched: 250,
    filesTouched: 8,
  });
  assert.equal(stratum, 'py_django_med');
});

test('Computes large stratum (>= 500 LOC)', () => {
  const stratum = computeStratum('go_std', {
    locTouched: 800,
    filesTouched: 20,
  });
  assert.equal(stratum, 'go_std_large');
});

test('Boundary case: 100 LOC = med', () => {
  const stratum = computeStratum('ts_react', {
    locTouched: 100,
    filesTouched: 5,
  });
  assert.equal(stratum, 'ts_react_med');
});

test('Boundary case: 500 LOC = large', () => {
  const stratum = computeStratum('rust_std', {
    locTouched: 500,
    filesTouched: 15,
  });
  assert.equal(stratum, 'rust_std_large');
});

// ────────────────────────────────────────────────────────────────
// analyzePrDifficulty Integration Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- analyzePrDifficulty Integration Tests ---\n');

test('Returns null for empty diff', () => {
  const result = analyzePrDifficulty({ prDiff: emptyDiff });
  assert.equal(result, null);
});

test('Analyzes trivial TypeScript PR', () => {
  const diff = `5\t3\tsrc/utils.ts`;
  const result = analyzePrDifficulty({ prDiff: diff });
  assert.ok(result !== null);
  assert.equal(result.difficultyBand, 'trivial');
  assert.equal(result.difficultySignals.locTouched, 8);
  assert.equal(result.difficultySignals.filesTouched, 1);
  assert.equal(result.stratum, 'ts_std_small');
});

test('Analyzes medium Python PR', () => {
  const diff = `50\t30\tsrc/main.py
10\t5\tsrc/utils.py
5\t3\trequirements.txt`;
  const result = analyzePrDifficulty({ prDiff: diff });
  assert.ok(result !== null);
  // 103 LOC >= 100, so it's medium (not easy)
  assert.equal(result.difficultyBand, 'medium');
  assert.equal(result.difficultySignals.locTouched, 103); // 50+30+10+5+5+3
  assert.equal(result.difficultySignals.filesTouched, 3);
  // 103 LOC = med size band
  assert.equal(result.stratum, 'py_std_med');
});

test('Analyzes medium Next.js PR', () => {
  const diff = `100\t50\tsrc/pages/index.tsx
30\t20\tsrc/components/Header.tsx
10\t5\tnext.config.ts`;
  const result = analyzePrDifficulty({ prDiff: diff });
  assert.ok(result !== null);
  assert.equal(result.difficultyBand, 'medium');
  assert.equal(result.difficultySignals.locTouched, 215);
  assert.equal(result.difficultySignals.filesTouched, 3);
  assert.equal(result.stratum, 'ts_nextjs_med');
});

test('Analyzes very_hard Go PR', () => {
  const diff = Array(15)
    .fill(0)
    .map((_, i) => `50\t30\tsrc/module${i}.go`)
    .join('\n');
  const result = analyzePrDifficulty({ prDiff: diff });
  assert.ok(result !== null);
  // 1200 LOC >= 1000, so it's very_hard (not hard)
  assert.equal(result.difficultyBand, 'very_hard');
  assert.equal(result.difficultySignals.locTouched, 15 * 80); // 1200
  assert.equal(result.difficultySignals.filesTouched, 15);
  assert.equal(result.stratum, 'go_std_large');
});

test('Analyzes very_hard Rust PR', () => {
  const result = analyzePrDifficulty({ prDiff: largeDiff });
  assert.ok(result !== null);
  assert.equal(result.difficultyBand, 'very_hard');
  assert.equal(result.difficultySignals.locTouched, 3000);
  assert.equal(result.difficultySignals.filesTouched, 1500);
  assert.equal(result.stratum, 'ts_std_large'); // largeDiff uses .ts files
});

test('Handles unified diff format', () => {
  const result = analyzePrDifficulty({ prDiff: unifiedDiff });
  assert.ok(result !== null);
  assert.equal(result.difficultyBand, 'trivial');
  assert.equal(result.difficultySignals.filesTouched, 1);
  // Should detect .tsx extension
  assert.ok(result.stratum.startsWith('ts_'));
});

test('Returns correct structure with all required fields', () => {
  const diff = `100\t50\tsrc/file.ts`;
  const result = analyzePrDifficulty({ prDiff: diff });
  assert.ok(result !== null);
  assert.ok('difficultyBand' in result);
  assert.ok('difficultySignals' in result);
  assert.ok('stratum' in result);
  assert.ok('locTouched' in result.difficultySignals);
  assert.ok('filesTouched' in result.difficultySignals);
});

// ────────────────────────────────────────────────────────────────
// Edge Cases
// ────────────────────────────────────────────────────────────────

console.log('\n--- Edge Case Tests ---\n');

test('Handles whitespace-only diff', () => {
  const result = analyzePrDifficulty({ prDiff: '   \n\n   ' });
  assert.equal(result, null);
});

test('Handles malformed diff gracefully', () => {
  const result = analyzePrDifficulty({ prDiff: 'not a real diff' });
  assert.equal(result, null);
});

test('Handles diff with only deleted files', () => {
  const diff = `0\t100\tsrc/old-file.ts
0\t50\tsrc/deprecated.ts`;
  const result = analyzePrDifficulty({ prDiff: diff });
  assert.ok(result !== null);
  assert.equal(result.difficultySignals.locTouched, 150);
  assert.equal(result.difficultySignals.filesTouched, 2);
});

test('Handles diff with only added files', () => {
  const diff = `100\t0\tsrc/new-feature.ts
50\t0\tsrc/new-utils.ts`;
  const result = analyzePrDifficulty({ prDiff: diff });
  assert.ok(result !== null);
  assert.equal(result.difficultySignals.locTouched, 150);
  assert.equal(result.difficultySignals.filesTouched, 2);
});

test('Handles very small PR (1 LOC, 1 file)', () => {
  const diff = `1\t0\tREADME.md`;
  const result = analyzePrDifficulty({ prDiff: diff });
  assert.ok(result !== null);
  assert.equal(result.difficultyBand, 'trivial');
  assert.equal(result.difficultySignals.locTouched, 1);
  assert.equal(result.difficultySignals.filesTouched, 1);
});

// ────────────────────────────────────────────────────────────────
// Diff Uncertainty / API Fallback Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- Diff Uncertainty Tests ---\n');

test('Marks as uncertain when unified diff has 0 LOC but files present (no API fallback)', () => {
  // Simulate a file-mode-only change: diff --git header present but no +/- content lines
  const modeOnlyDiff = `diff --git a/src/service.py b/src/service.py
old mode 100644
new mode 100755`;
  const result = analyzePrDifficulty({ prDiff: modeOnlyDiff });
  assert.ok(result !== null);
  assert.equal(result.difficultySignals.locTouched, 0);
  assert.equal(result.difficultySignals.filesTouched, 1);
  assert.equal(result.difficultySignals.diffUncertain, true);
});

test('Does not mark as uncertain when diff has real LOC', () => {
  const diff = `50\t30\tsrc/main.py`;
  const result = analyzePrDifficulty({ prDiff: diff });
  assert.ok(result !== null);
  assert.equal(result.difficultySignals.locTouched, 80);
  assert.equal(result.difficultySignals.diffUncertain, undefined);
});

test('Does not mark as uncertain for trivial PR with real LOC', () => {
  const diff = `3\t1\tsrc/config.ts`;
  const result = analyzePrDifficulty({ prDiff: diff });
  assert.ok(result !== null);
  assert.equal(result.difficultyBand, 'trivial');
  assert.equal(result.difficultySignals.diffUncertain, undefined);
});

test('fetchPrStatsFromApi returns null for invalid PR number', () => {
  // This calls gh with a nonexistent PR in a non-repo directory — should return null gracefully
  const result = fetchPrStatsFromApi('999999', '/tmp');
  assert.equal(result, null);
});

// ────────────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────────────

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);

if (failed > 0) {
  process.exit(1);
}
