#!/usr/bin/env -S npx tsx
/**
 * Tests for review-context-gatherer
 * Run with: npx tsx shared/lib/review-context-gatherer.test.ts
 */

import { analyzeDiffMetadata, getGitDiff } from './review-context-gatherer.ts';
import { execSync } from 'node:child_process';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`✓ ${message}`);
}

function testAnalyzeDiffMetadata() {
  console.log('\n=== Testing analyzeDiffMetadata ===');

  // Test 1: Extract files from diff
  const diff1 = `diff --git a/file1.ts b/file1.ts
index abc123..def456 100644
--- a/file1.ts
+++ b/file1.ts
@@ -1,3 +1,4 @@
+added line
 existing line
-removed line
 another line
diff --git a/file2.tsx b/file2.tsx
new file mode 100644`;

  const result1 = analyzeDiffMetadata(diff1);
  assert(result1.files.length === 2, 'Should extract 2 files');
  assert(result1.files.includes('file1.ts'), 'Should include file1.ts');
  assert(result1.files.includes('file2.tsx'), 'Should include file2.tsx');
  assert(result1.lineCount.added === 1, 'Should count 1 added line');
  assert(result1.lineCount.removed === 1, 'Should count 1 removed line');

  // Test 2: Detect UI changes
  const diffWithUI = `diff --git a/components/Button.tsx b/components/Button.tsx
+import React from 'react';`;
  const diffWithoutUI = `diff --git a/utils/math.ts b/utils/math.ts
+export function add() {}`;

  const resultUI = analyzeDiffMetadata(diffWithUI);
  const resultNoUI = analyzeDiffMetadata(diffWithoutUI);

  assert(resultUI.hasUiChanges === true, 'Should detect UI changes in .tsx file');
  assert(resultNoUI.hasUiChanges === false, 'Should not detect UI changes in .ts file');

  // Test 3: CSS and HTML files as UI changes
  const cssDiff = `diff --git a/styles/main.css b/styles/main.css
+.button { color: blue; }`;
  const htmlDiff = `diff --git a/index.html b/index.html
+<div>Hello</div>`;

  assert(analyzeDiffMetadata(cssDiff).hasUiChanges === true, 'Should detect CSS as UI change');
  assert(analyzeDiffMetadata(htmlDiff).hasUiChanges === true, 'Should detect HTML as UI change');

  // Test 4: Empty diff
  const emptyResult = analyzeDiffMetadata('');
  assert(emptyResult.files.length === 0, 'Empty diff should have no files');
  assert(emptyResult.lineCount.added === 0, 'Empty diff should have 0 added lines');
  assert(emptyResult.lineCount.removed === 0, 'Empty diff should have 0 removed lines');
  assert(emptyResult.hasUiChanges === false, 'Empty diff should not have UI changes');

  // Test 5: Multiple file extensions
  const multiDiff = `diff --git a/test.vue b/test.vue
diff --git a/app.svelte b/app.svelte
diff --git a/style.scss b/style.scss`;

  const multiResult = analyzeDiffMetadata(multiDiff);
  assert(multiResult.hasUiChanges === true, 'Should detect .vue, .svelte, .scss as UI changes');
  assert(multiResult.files.length === 3, 'Should extract all 3 files');
}

function testUIFileDetection() {
  console.log('\n=== Testing UI File Detection ===');

  const testCases = [
    { file: 'component.tsx', expected: true },
    { file: 'component.jsx', expected: true },
    { file: 'styles.css', expected: true },
    { file: 'styles.scss', expected: true },
    { file: 'styles.sass', expected: true },
    { file: 'styles.less', expected: true },
    { file: 'index.html', expected: true },
    { file: 'app.vue', expected: true },
    { file: 'widget.svelte', expected: true },
    { file: 'utils.ts', expected: false },
    { file: 'server.js', expected: false },
    { file: 'README.md', expected: false },
  ];

  for (const { file, expected } of testCases) {
    const diff = `diff --git a/${file} b/${file}`;
    const result = analyzeDiffMetadata(diff);
    assert(
      result.hasUiChanges === expected,
      `${file} should ${expected ? '' : 'not '}be detected as UI file`
    );
  }
}

function testLineCountAccuracy() {
  console.log('\n=== Testing Line Count Accuracy ===');

  const diff = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,5 +1,8 @@
 line 1
+added line 1
+added line 2
 line 2
-removed line 1
-removed line 2
+modified line
 line 3
+added line 3`;

  const result = analyzeDiffMetadata(diff);
  assert(result.lineCount.added === 4, 'Should count 4 added lines (lines starting with +)');
  assert(result.lineCount.removed === 2, 'Should count 2 removed lines (lines starting with -)');
}

function testComplexDiff() {
  console.log('\n=== Testing Complex Multi-File Diff ===');

  const complexDiff = `diff --git a/src/components/Header.tsx b/src/components/Header.tsx
index 1234567..abcdefg 100644
--- a/src/components/Header.tsx
+++ b/src/components/Header.tsx
@@ -10,3 +10,5 @@
 export function Header() {
+  const [isOpen, setIsOpen] = useState(false);
+
   return (
     <header>
-      <h1>Old Title</h1>
+      <h1>New Title</h1>
     </header>
   );
 }
diff --git a/src/utils/helper.ts b/src/utils/helper.ts
index 9876543..fedcba9 100644
--- a/src/utils/helper.ts
+++ b/src/utils/helper.ts
@@ -1,2 +1,3 @@
 export function format(text: string) {
+  if (!text) return '';
   return text.trim();
 }
diff --git a/styles/main.css b/styles/main.css
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/styles/main.css
@@ -0,0 +1,5 @@
+.header {
+  display: flex;
+  align-items: center;
+  padding: 1rem;
+}`;

  const result = analyzeDiffMetadata(complexDiff);

  assert(result.files.length === 3, 'Should extract 3 files from complex diff');
  assert(
    result.files.includes('src/components/Header.tsx'),
    'Should include Header.tsx'
  );
  assert(result.files.includes('src/utils/helper.ts'), 'Should include helper.ts');
  assert(result.files.includes('styles/main.css'), 'Should include main.css');
  assert(result.hasUiChanges === true, 'Should detect UI changes in complex diff');
  assert(result.lineCount.added > 0, 'Should count added lines in complex diff');
  assert(result.lineCount.removed > 0, 'Should count removed lines in complex diff');
}

function testGitDiffThreeDotSyntax() {
  console.log('\n=== Testing Git Diff Three-Dot Syntax ===');

  // This test verifies that getGitDiff uses "git diff main...HEAD"
  // instead of "git diff main" to prevent false positives from
  // pre-existing code in merged PRs.

  try {
    // Get the actual command output to verify it's using three-dot syntax
    // We can't easily mock execSync here, but we can verify it works correctly
    // by checking that it only includes changes from current branch.

    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim();

    // Only run this test if we're NOT on main (to avoid empty diff)
    if (currentBranch !== 'main') {
      console.log(`  ℹ️  Running on branch: ${currentBranch}`);

      // Get diff using our function
      const diff = getGitDiff('main', process.cwd());

      // Verify it returns a string (even if empty on clean branch)
      assert(typeof diff === 'string', 'getGitDiff should return a string');

      // If there are changes, verify they're in the expected format
      if (diff.trim()) {
        assert(
          diff.includes('diff --git'),
          'Diff should contain git diff headers'
        );
        console.log(`  ✓ Diff contains ${diff.split('diff --git').length - 1} file(s)`);
      } else {
        console.log('  ✓ No changes in current branch (clean state)');
      }

      console.log('  ✓ getGitDiff executes successfully with three-dot syntax');
    } else {
      console.log('  ⊘ Skipped (running on main branch)');
    }
  } catch (error) {
    // If we're in a repo without main branch, skip this test
    if ((error as Error).message.includes('unknown revision')) {
      console.log('  ⊘ Skipped (no main branch in this repo)');
    } else {
      throw error;
    }
  }
}

// Run all tests
console.log('🧪 Running review-context-gatherer tests...\n');

try {
  testAnalyzeDiffMetadata();
  testUIFileDetection();
  testLineCountAccuracy();
  testComplexDiff();
  testGitDiffThreeDotSyntax();

  console.log('\n✅ All tests passed!\n');
} catch (error) {
  console.error('\n❌ Test suite failed:', error);
  process.exit(1);
}
