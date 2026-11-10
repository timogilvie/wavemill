// wavemill-test-suite: custom
/**
 * Tests for task-context-analyzer (HOK-774).
 */

import { strict as assert } from 'node:assert';
import { errorMessage } from './error-utils.ts';
import {
  inferTaskType,
  inferChangeKind,
  estimateComplexity,
  extractConstraints,
  extractEstimates,
  detectDomainKnowledge,
  analyzeTaskContext,
  type IssueData,
} from './task-context-analyzer.ts';

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

// ────────────────────────────────────────────────────────────────
// Task Type Inference Tests
// ────────────────────────────────────────────────────────────────

testSection('Task Type Inference Tests');

test('Infers bugfix from title with "fix" keyword', () => {
  const issue: IssueData = { title: 'Fix authentication bug' };
  const result = inferTaskType(issue);
  assert.equal(result, 'bugfix');
});

test('Infers feature from title with "add" keyword', () => {
  const issue: IssueData = { title: 'Add dark mode support' };
  const result = inferTaskType(issue);
  assert.equal(result, 'feature');
});

test('Infers refactor from description', () => {
  const issue: IssueData = {
    title: 'Improve codebase',
    description: 'Refactor the authentication module to simplify the code structure',
  };
  const result = inferTaskType(issue);
  assert.equal(result, 'refactor');
});

test('Infers docs from title', () => {
  const issue: IssueData = { title: 'Update README documentation' };
  const result = inferTaskType(issue);
  assert.equal(result, 'docs');
});

test('Infers test from labels', () => {
  const issue: IssueData = {
    title: 'Add coverage',
    labels: ['test', 'quality'],
  };
  const result = inferTaskType(issue);
  assert.equal(result, 'test');
});

test('Infers infra from CI keywords', () => {
  const issue: IssueData = {
    title: 'Update deployment pipeline',
    description: 'Configure CI/CD for automated testing',
  };
  const result = inferTaskType(issue);
  assert.equal(result, 'infra');
});

test('Defaults to feature when ambiguous', () => {
  const issue: IssueData = { title: 'Something needs to happen' };
  const result = inferTaskType(issue);
  assert.equal(result, 'feature');
});

test('Handles empty issue data', () => {
  const result = inferTaskType();
  assert.equal(result, 'feature');
});

// ────────────────────────────────────────────────────────────────
// Change Kind Detection Tests
// ────────────────────────────────────────────────────────────────

testSection('Change Kind Detection Tests');

test('Detects create_new from new file mode markers', () => {
  const diff = `diff --git a/src/new-feature.ts b/src/new-feature.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/new-feature.ts`;
  const result = inferChangeKind(diff);
  assert.equal(result, 'create_new');
});

test('Detects modify_existing from regular diff', () => {
  const diff = `diff --git a/src/existing.ts b/src/existing.ts
index abc123..def456 100644
--- a/src/existing.ts
+++ b/src/existing.ts`;
  const result = inferChangeKind(diff);
  assert.equal(result, 'modify_existing');
});

test('Detects mixed when both new and modified files', () => {
  const diff = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/new.ts
diff --git a/src/existing.ts b/src/existing.ts
index abc123..def456 100644
--- a/src/existing.ts
+++ b/src/existing.ts`;
  const result = inferChangeKind(diff);
  assert.equal(result, 'mixed');
});

test('Defaults to modify_existing for empty diff', () => {
  const result = inferChangeKind('');
  assert.equal(result, 'modify_existing');
});

// ────────────────────────────────────────────────────────────────
// Complexity Estimation Tests
// ────────────────────────────────────────────────────────────────

testSection('Complexity Estimation Tests');

test('Estimates xs complexity for small changes', () => {
  const result = estimateComplexity({
    locTouched: 5,
    filesTouched: 1,
    taskType: 'docs',
  });
  assert.equal(result, 'xs');
});

test('Estimates s complexity for minor changes', () => {
  const result = estimateComplexity({
    locTouched: 30,
    filesTouched: 2,
    taskType: 'bugfix',
  });
  assert.equal(result, 's');
});

test('Estimates m complexity for moderate changes', () => {
  const result = estimateComplexity({
    locTouched: 150,
    filesTouched: 5,
    taskType: 'feature',
  });
  assert.equal(result, 'm');
});

test('Estimates l complexity for large changes', () => {
  const result = estimateComplexity({
    locTouched: 400,
    filesTouched: 8,
    taskType: 'refactor',
  });
  assert.equal(result, 'l');
});

test('Estimates xl complexity for very large changes', () => {
  const result = estimateComplexity({
    locTouched: 600,
    filesTouched: 15,
    taskType: 'infra',
  });
  assert.equal(result, 'xl');
});

test('Increases complexity for refactor/infra tasks', () => {
  const infraResult = estimateComplexity({
    locTouched: 50,
    filesTouched: 3,
    taskType: 'infra',
  });
  const docsResult = estimateComplexity({
    locTouched: 50,
    filesTouched: 3,
    taskType: 'docs',
  });
  // infra should score higher complexity than docs for same LOC/files
  const infraScore = ['xs', 's', 'm', 'l', 'xl'].indexOf(infraResult);
  const docsScore = ['xs', 's', 'm', 'l', 'xl'].indexOf(docsResult);
  assert.ok(infraScore >= docsScore);
});

test('Decreases complexity for "simple" keyword in issue', () => {
  const withKeyword = estimateComplexity({
    locTouched: 100,
    filesTouched: 3,
    issue: { description: 'This is a simple typo fix' },
  });
  const withoutKeyword = estimateComplexity({
    locTouched: 100,
    filesTouched: 3,
    issue: { description: 'Regular change' },
  });
  const withScore = ['xs', 's', 'm', 'l', 'xl'].indexOf(withKeyword);
  const withoutScore = ['xs', 's', 'm', 'l', 'xl'].indexOf(withoutKeyword);
  assert.ok(withScore <= withoutScore);
});

// ────────────────────────────────────────────────────────────────
// Constraints Detection Tests
// ────────────────────────────────────────────────────────────────

testSection('Constraints Detection Tests');

test('Detects hasStrictStyle constraint', () => {
  const issue: IssueData = {
    description: 'Follow the strict style guide for this change',
  };
  const result = extractConstraints(issue);
  assert.equal(result?.hasStrictStyle, true);
});

test('Detects mustNotTouchX constraint', () => {
  const issue: IssueData = {
    description: 'Fix the bug but do not modify the legacy module',
  };
  const result = extractConstraints(issue);
  assert.equal(result?.mustNotTouchX, true);
});

test('Detects timeboxed constraint', () => {
  const issue: IssueData = {
    description: 'Urgent: deadline is tomorrow',
  };
  const result = extractConstraints(issue);
  assert.equal(result?.timeboxed, true);
});

test('Detects noNetAccess constraint', () => {
  const issue: IssueData = {
    description: 'This must work offline with no network access',
  };
  const result = extractConstraints(issue);
  assert.equal(result?.noNetAccess, true);
});

test('Returns undefined when no constraints found', () => {
  const issue: IssueData = {
    description: 'Regular task with no special constraints',
  };
  const result = extractConstraints(issue);
  assert.equal(result, undefined);
});

// ────────────────────────────────────────────────────────────────
// Estimates Extraction Tests
// ────────────────────────────────────────────────────────────────

testSection('Estimates Extraction Tests');

test('Extracts files estimate from description', () => {
  const issue: IssueData = {
    description: 'This will touch approximately 5 files',
  };
  const result = extractEstimates(issue);
  assert.equal(result.filesTouchedEstimate, 5);
});

test('Extracts LOC estimate from description', () => {
  const issue: IssueData = {
    description: 'Expected to change about 200 lines of code',
  };
  const result = extractEstimates(issue);
  assert.equal(result.expectedLoCChange, 200);
});

test('Extracts both estimates', () => {
  const issue: IssueData = {
    description: 'Will modify 3 files with approximately 150 lines',
  };
  const result = extractEstimates(issue);
  assert.equal(result.filesTouchedEstimate, 3);
  assert.equal(result.expectedLoCChange, 150);
});

test('Returns empty object when no estimates found', () => {
  const issue: IssueData = {
    description: 'No specific estimates provided',
  };
  const result = extractEstimates(issue);
  assert.deepEqual(result, {});
});

// ────────────────────────────────────────────────────────────────
// Domain Knowledge Detection Tests
// ────────────────────────────────────────────────────────────────

testSection('Domain Knowledge Detection Tests');

test('Detects payment domain knowledge', () => {
  const issue: IssueData = {
    description: 'Implement payment processing with Stripe',
  };
  const result = detectDomainKnowledge(issue);
  assert.equal(result, 'payment');
});

test('Detects auth domain knowledge', () => {
  const issue: IssueData = {
    title: 'Add OAuth authentication',
  };
  const result = detectDomainKnowledge(issue);
  assert.equal(result, 'auth');
});

test('Detects kubernetes domain knowledge', () => {
  const issue: IssueData = {
    description: 'Deploy to k8s cluster',
  };
  const result = detectDomainKnowledge(issue);
  assert.equal(result, 'k8s');
});

test('Detects database domain knowledge', () => {
  const issue: IssueData = {
    description: 'Optimize postgres query performance',
  };
  const result = detectDomainKnowledge(issue);
  assert.equal(result, 'postgres');
});

test('Returns true for generic domain knowledge markers', () => {
  const issue: IssueData = {
    description: 'This requires specialized domain knowledge',
  };
  const result = detectDomainKnowledge(issue);
  assert.equal(result, true);
});

test('Returns false when no domain knowledge required', () => {
  const issue: IssueData = {
    description: 'Simple UI tweak',
  };
  const result = detectDomainKnowledge(issue);
  assert.equal(result, false);
});

// ────────────────────────────────────────────────────────────────
// Integration Tests
// ────────────────────────────────────────────────────────────────

testSection('Integration Tests');

test('analyzeTaskContext produces complete context for feature task', () => {
  const issue: IssueData = {
    title: 'Add user profile page',
    description: 'Create a new user profile page with bio and avatar',
  };
  const prDiff = `diff --git a/src/pages/profile.tsx b/src/pages/profile.tsx
new file mode 100644
index 0000000..abc123`;

  const result = analyzeTaskContext({
    issue,
    prDiff,
    locTouched: 150,
    filesTouched: 3,
  });

  assert.equal(result.taskType, 'feature');
  assert.equal(result.changeKind, 'create_new');
  assert.ok(['xs', 's', 'm', 'l', 'xl'].includes(result.complexity as string));
});

test('analyzeTaskContext produces complete context for bugfix task', () => {
  const issue: IssueData = {
    title: 'Fix authentication error',
    description: 'Fix the bug in auth module',
    labels: ['bug'],
  };
  const prDiff = `diff --git a/src/auth.ts b/src/auth.ts
index abc123..def456 100644`;

  const result = analyzeTaskContext({
    issue,
    prDiff,
    locTouched: 20,
    filesTouched: 1,
  });

  assert.equal(result.taskType, 'bugfix');
  assert.equal(result.changeKind, 'modify_existing');
  assert.ok(['xs', 's'].includes(result.complexity as string));
});

test('analyzeTaskContext includes constraints when present', () => {
  const issue: IssueData = {
    title: 'Urgent refactor',
    description: 'Refactor code with strict style compliance. Deadline is Friday.',
  };

  const result = analyzeTaskContext({
    issue,
    locTouched: 200,
    filesTouched: 5,
  });

  assert.equal(result.taskType, 'refactor');
  assert.ok(result.constraints?.hasStrictStyle);
  assert.ok(result.constraints?.timeboxed);
});

test('analyzeTaskContext includes domain knowledge when detected', () => {
  const issue: IssueData = {
    title: 'Integrate Stripe payments',
    description: 'Add payment processing with Stripe API',
  };

  const result = analyzeTaskContext({
    issue,
    locTouched: 300,
    filesTouched: 8,
  });

  assert.equal(result.taskType, 'feature');
  assert.ok(result.requiresDomainKnowledge);
});

test('analyzeTaskContext works with minimal input', () => {
  const result = analyzeTaskContext({});
  assert.equal(result.taskType, 'feature');
  assert.equal(result.changeKind, 'modify_existing');
  assert.ok(result.complexity);
});

console.log('\n✅ All task context analyzer tests passed!\n');
