#!/usr/bin/env -S npx tsx
/**
 * Tests for constraint-storage
 * Run with: npx tsx shared/lib/constraint-storage.test.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  saveConstraintRules,
  loadConstraintRules,
  constraintRulesExist,
  deleteConstraintRules,
  listConstraintIssues,
} from './constraint-storage.ts';
import type { RuleGenerationResult } from './rule-generator.ts';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`✓ ${message}`);
}

// Create temp directory for tests
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'constraint-storage-test-'));

function cleanup() {
  if (fs.existsSync(testRoot)) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

function testSaveConstraintRules() {
  console.log('\n=== Testing Save Constraint Rules ===');

  const ruleGenResult: RuleGenerationResult = {
    rules: [
      {
        id: 'CONSTRAINT-1',
        filename: '01-file-no-modify-config.cjs',
        code: '#!/usr/bin/env node\nconsole.log("Rule 1");',
        constraint: {
          id: 'CONSTRAINT-1',
          category: 'file',
          type: 'auto-validatable',
          description: 'Do not modify config.json',
          severity: 'error',
        },
      },
      {
        id: 'CONSTRAINT-2',
        filename: '02-code-style-use-typescript.cjs',
        code: '#!/usr/bin/env node\nconsole.log("Rule 2");',
        constraint: {
          id: 'CONSTRAINT-2',
          category: 'code-style',
          type: 'auto-validatable',
          description: 'Must use TypeScript',
          severity: 'error',
        },
      },
    ],
    manualReviewConstraints: [
      {
        id: 'CONSTRAINT-3',
        category: 'code-style',
        type: 'manual-review',
        description: 'Follow existing conventions',
        severity: 'warning',
      },
    ],
    metadata: {
      issueId: 'HOK-123',
      generatedAt: '2026-02-26T12:00:00Z',
      taskPacketHash: 'abc123',
    },
  };

  const savedDir = saveConstraintRules('HOK-123', ruleGenResult, testRoot);

  assert(fs.existsSync(savedDir), 'Constraint directory should be created');
  assert(
    fs.existsSync(path.join(savedDir, 'rules')),
    'Rules subdirectory should be created'
  );
  assert(
    fs.existsSync(path.join(savedDir, 'rules', '01-file-no-modify-config.cjs')),
    'First rule file should be saved'
  );
  assert(
    fs.existsSync(path.join(savedDir, 'rules', '02-code-style-use-typescript.cjs')),
    'Second rule file should be saved'
  );
  assert(
    fs.existsSync(path.join(savedDir, 'metadata.json')),
    'Metadata file should be saved'
  );
  assert(
    fs.existsSync(path.join(savedDir, 'manual-review.md')),
    'Manual review document should be saved'
  );

  // Check that rule files are executable
  const stat = fs.statSync(path.join(savedDir, 'rules', '01-file-no-modify-config.cjs'));
  assert((stat.mode & 0o111) !== 0, 'Rule files should be executable');
}

function testLoadConstraintRules() {
  console.log('\n=== Testing Load Constraint Rules ===');

  const loaded = loadConstraintRules('HOK-123', testRoot);

  assert(loaded !== null, 'Should load constraint rules');
  assert(loaded!.issueId === 'HOK-123', 'Should have correct issue ID');
  assert(loaded!.ruleFiles.length === 2, 'Should load 2 rule files');
  assert(loaded!.metadata !== null, 'Should load metadata');
  assert(loaded!.metadata!.totalRules === 2, 'Metadata should show 2 total rules');
  assert(
    loaded!.metadata!.autoValidatableCount === 2,
    'Metadata should show 2 auto-validatable rules'
  );
  assert(
    loaded!.metadata!.manualReviewCount === 1,
    'Metadata should show 1 manual review constraint'
  );
  assert(loaded!.manualReviewContent !== null, 'Should load manual review content');
  assert(
    loaded!.manualReviewContent!.includes('CONSTRAINT-3'),
    'Manual review should include constraint ID'
  );
}

function testConstraintRulesExist() {
  console.log('\n=== Testing Constraint Rules Exist ===');

  assert(
    constraintRulesExist('HOK-123', testRoot),
    'Should return true for existing constraints'
  );
  assert(
    !constraintRulesExist('HOK-999', testRoot),
    'Should return false for non-existent constraints'
  );
}

function testListConstraintIssues() {
  console.log('\n=== Testing List Constraint Issues ===');

  const issues = listConstraintIssues(testRoot);

  assert(issues.length === 1, 'Should list 1 issue');
  assert(issues.includes('HOK-123'), 'Should include HOK-123');
}

function testDeleteConstraintRules() {
  console.log('\n=== Testing Delete Constraint Rules ===');

  const deleted = deleteConstraintRules('HOK-123', testRoot);

  assert(deleted, 'Should return true when deleting existing constraints');
  assert(
    !fs.existsSync(path.join(testRoot, 'constraints', 'HOK-123')),
    'Constraint directory should be deleted'
  );

  const deletedAgain = deleteConstraintRules('HOK-123', testRoot);
  assert(!deletedAgain, 'Should return false when deleting non-existent constraints');
}

function testLoadNonExistentConstraints() {
  console.log('\n=== Testing Load Non-Existent Constraints ===');

  const loaded = loadConstraintRules('HOK-999', testRoot);

  assert(loaded === null, 'Should return null for non-existent constraints');
}

function testSaveWithoutManualReview() {
  console.log('\n=== Testing Save Without Manual Review Constraints ===');

  const ruleGenResult: RuleGenerationResult = {
    rules: [
      {
        id: 'CONSTRAINT-1',
        filename: '01-file-test.cjs',
        code: '#!/usr/bin/env node\nconsole.log("Test");',
        constraint: {
          id: 'CONSTRAINT-1',
          category: 'file',
          type: 'auto-validatable',
          description: 'Test constraint',
          severity: 'error',
        },
      },
    ],
    manualReviewConstraints: [],
    metadata: {
      issueId: 'HOK-456',
      generatedAt: '2026-02-26T12:00:00Z',
      taskPacketHash: 'def456',
    },
  };

  const savedDir = saveConstraintRules('HOK-456', ruleGenResult, testRoot);

  assert(fs.existsSync(savedDir), 'Constraint directory should be created');
  assert(
    !fs.existsSync(path.join(savedDir, 'manual-review.md')),
    'Manual review document should not be created when there are no manual constraints'
  );

  // Cleanup
  deleteConstraintRules('HOK-456', testRoot);
}

// Run all tests
try {
  testSaveConstraintRules();
  testLoadConstraintRules();
  testConstraintRulesExist();
  testListConstraintIssues();
  testDeleteConstraintRules();
  testLoadNonExistentConstraints();
  testSaveWithoutManualReview();

  console.log('\n✅ All tests passed!\n');
  cleanup();
  process.exit(0);
} catch (error) {
  console.error('\n❌ Test suite failed:', error);
  cleanup();
  process.exit(1);
}
