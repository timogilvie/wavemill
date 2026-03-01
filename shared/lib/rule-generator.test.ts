#!/usr/bin/env -S npx tsx
/**
 * Tests for rule-generator
 * Run with: npx tsx shared/lib/rule-generator.test.ts
 */

import { generateRules } from './rule-generator.ts';
import type { Constraint } from './constraint-parser.ts';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`✓ ${message}`);
}

function testBasicRuleGeneration() {
  console.log('\n=== Testing Basic Rule Generation ===');

  const constraints: Constraint[] = [
    {
      id: 'CONSTRAINT-1',
      category: 'file',
      type: 'auto-validatable',
      description: 'Do not modify config.json',
      pattern: 'config.json',
      severity: 'error',
    },
    {
      id: 'CONSTRAINT-2',
      category: 'code-style',
      type: 'auto-validatable',
      description: 'Must use TypeScript strict mode',
      severity: 'error',
    },
  ];

  const result = generateRules(constraints, 'HOK-123', 'test task packet');

  assert(result.rules.length === 2, 'Should generate 2 rules');
  assert(result.manualReviewConstraints.length === 0, 'Should have no manual review constraints');
  assert(result.metadata.issueId === 'HOK-123', 'Should include issue ID in metadata');
  assert(!!result.metadata.generatedAt, 'Should include generation timestamp');
  assert(!!result.metadata.taskPacketHash, 'Should include task packet hash');
}

function testManualReviewSeparation() {
  console.log('\n=== Testing Manual Review Constraint Separation ===');

  const constraints: Constraint[] = [
    {
      id: 'CONSTRAINT-1',
      category: 'file',
      type: 'auto-validatable',
      description: 'Do not modify config.json',
      pattern: 'config.json',
      severity: 'error',
    },
    {
      id: 'CONSTRAINT-2',
      category: 'code-style',
      type: 'manual-review',
      description: 'Follow existing code conventions',
      severity: 'warning',
    },
    {
      id: 'CONSTRAINT-3',
      category: 'security',
      type: 'auto-validatable',
      description: 'Do not expose API keys',
      severity: 'error',
    },
  ];

  const result = generateRules(constraints, 'HOK-124', 'test task packet');

  assert(result.rules.length === 2, 'Should generate 2 auto-validatable rules');
  assert(result.manualReviewConstraints.length === 1, 'Should have 1 manual review constraint');
  assert(
    result.manualReviewConstraints[0].id === 'CONSTRAINT-2',
    'Manual review constraint should be CONSTRAINT-2'
  );
}

function testFileConstraintRule() {
  console.log('\n=== Testing File Constraint Rule Generation ===');

  const constraints: Constraint[] = [
    {
      id: 'CONSTRAINT-1',
      category: 'file',
      type: 'auto-validatable',
      description: "Don't modify shared/lib/config.ts",
      pattern: 'shared/lib/config.ts',
      severity: 'error',
    },
  ];

  const result = generateRules(constraints, 'HOK-125', 'test');

  assert(result.rules.length === 1, 'Should generate 1 rule');
  assert(result.rules[0].filename.includes('file'), 'Filename should include category');
  assert(result.rules[0].code.includes('CONSTRAINT-1'), 'Code should include constraint ID');
  assert(result.rules[0].code.includes('config.ts'), 'Code should include file pattern');
  assert(result.rules[0].code.includes('Remediation'), 'Code should include remediation guidance');
}

function testCodeStyleRule() {
  console.log('\n=== Testing Code Style Rule Generation ===');

  const constraints: Constraint[] = [
    {
      id: 'CONSTRAINT-1',
      category: 'code-style',
      type: 'auto-validatable',
      description: 'No "any" types allowed in new code',
      pattern: 'any',
      severity: 'error',
    },
  ];

  const result = generateRules(constraints, 'HOK-126', 'test');

  assert(result.rules.length === 1, 'Should generate 1 rule');
  assert(result.rules[0].filename.includes('code-style'), 'Filename should include category');
  assert(result.rules[0].code.includes('checkCodeStyleConstraint'), 'Code should have check function');
  assert(result.rules[0].code.includes('any'), 'Code should check for "any" pattern');
}

function testTestingRule() {
  console.log('\n=== Testing Testing Rule Generation ===');

  const constraints: Constraint[] = [
    {
      id: 'CONSTRAINT-1',
      category: 'testing',
      type: 'auto-validatable',
      description: 'All new functions must have unit tests',
      severity: 'warning',
    },
  ];

  const result = generateRules(constraints, 'HOK-127', 'test');

  assert(result.rules.length === 1, 'Should generate 1 rule');
  assert(result.rules[0].code.includes('checkTestingConstraint'), 'Code should have check function');
  assert(result.rules[0].code.includes('.test.'), 'Code should check for test files');
}

function testSecurityRule() {
  console.log('\n=== Testing Security Rule Generation ===');

  const constraints: Constraint[] = [
    {
      id: 'CONSTRAINT-1',
      category: 'security',
      type: 'auto-validatable',
      description: 'Do not expose API keys in client code',
      severity: 'error',
    },
  ];

  const result = generateRules(constraints, 'HOK-128', 'test');

  assert(result.rules.length === 1, 'Should generate 1 rule');
  assert(result.rules[0].code.includes('checkSecurityConstraint'), 'Code should have check function');
  assert(result.rules[0].code.includes('API_KEY'), 'Code should check for API_KEY pattern');
  assert(result.rules[0].code.includes('SECRET'), 'Code should check for SECRET pattern');
}

function testFilenameGeneration() {
  console.log('\n=== Testing Filename Generation ===');

  const constraints: Constraint[] = [
    {
      id: 'CONSTRAINT-1',
      category: 'file',
      type: 'auto-validatable',
      description: 'Do not modify configuration files',
      severity: 'error',
    },
    {
      id: 'CONSTRAINT-10',
      category: 'security',
      type: 'auto-validatable',
      description: 'No hardcoded passwords allowed',
      severity: 'error',
    },
  ];

  const result = generateRules(constraints, 'HOK-129', 'test');

  assert(result.rules.length === 2, 'Should generate 2 rules');
  assert(result.rules[0].filename.startsWith('01-'), 'First rule should start with 01-');
  assert(result.rules[1].filename.startsWith('10-'), 'Second rule should start with 10-');
  assert(result.rules[0].filename.endsWith('.cjs'), 'Filename should end with .cjs');
}

function testExecutableRules() {
  console.log('\n=== Testing Generated Rules Are Valid JavaScript ===');

  const constraints: Constraint[] = [
    {
      id: 'CONSTRAINT-1',
      category: 'file',
      type: 'auto-validatable',
      description: "Don't modify package.json",
      pattern: 'package.json',
      severity: 'error',
    },
  ];

  const result = generateRules(constraints, 'HOK-130', 'test');

  assert(result.rules.length === 1, 'Should generate 1 rule');

  // Check that generated code has proper structure
  const code = result.rules[0].code;
  assert(code.includes('#!/usr/bin/env node'), 'Should have shebang');
  assert(code.includes('function check'), 'Should have check function');
  assert(code.includes('process.exit'), 'Should have exit calls');
  assert(code.includes('console.log') || code.includes('console.error'), 'Should have output');
}

// Run all tests
try {
  testBasicRuleGeneration();
  testManualReviewSeparation();
  testFileConstraintRule();
  testCodeStyleRule();
  testTestingRule();
  testSecurityRule();
  testFilenameGeneration();
  testExecutableRules();

  console.log('\n✅ All tests passed!\n');
  process.exit(0);
} catch (error) {
  console.error('\n❌ Test suite failed:', error);
  process.exit(1);
}
