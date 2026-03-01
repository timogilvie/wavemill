#!/usr/bin/env -S npx tsx
/**
 * Tests for constraint-parser
 * Run with: npx tsx shared/lib/constraint-parser.test.ts
 */

import { parseConstraints } from './constraint-parser.ts';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`✓ ${message}`);
}

function testBasicParsing() {
  console.log('\n=== Testing Basic Constraint Parsing ===');

  const markdown = `
# Task Packet

## 5. Implementation Constraints

- Code style: Must use TypeScript strict mode
- Testing: All new functions must have unit tests
- Security: Do not expose API keys in client code
- Performance: Keep bundle size under 100KB
- Backwards compatibility: Don't modify existing API endpoints
`;

  const result = parseConstraints(markdown);

  assert(result.constraints.length === 5, 'Should parse 5 constraints');
  assert(result.constraints[0].category === 'code-style', 'First constraint is code-style');
  assert(result.constraints[1].category === 'testing', 'Second constraint is testing');
  assert(result.constraints[2].category === 'security', 'Third constraint is security');
  assert(result.constraints[3].category === 'performance', 'Fourth constraint is performance');
  assert(result.constraints[4].category === 'compatibility', 'Fifth constraint is compatibility');
}

function testAutoValidatableClassification() {
  console.log('\n=== Testing Auto-Validatable Classification ===');

  const markdown = `
## Implementation Constraints

- File restrictions: Don't modify "config.json" or "package.json"
- Code patterns: Must use async/await for all API calls
- Testing: Should include integration tests
- Style: Follow existing code conventions
`;

  const result = parseConstraints(markdown);

  assert(result.constraints.length === 4, 'Should parse 4 constraints');

  // "Don't modify" is auto-validatable
  assert(
    result.constraints[0].type === 'auto-validatable',
    'File restriction should be auto-validatable'
  );

  // "Must use" is auto-validatable
  assert(
    result.constraints[1].type === 'auto-validatable',
    'Code pattern requirement should be auto-validatable'
  );

  // "Should include" is auto-validatable
  assert(
    result.constraints[2].type === 'auto-validatable',
    'Testing requirement should be auto-validatable'
  );

  // "Follow" is manual-review
  assert(
    result.constraints[3].type === 'manual-review',
    'Style guideline should be manual-review'
  );
}

function testPatternExtraction() {
  console.log('\n=== Testing Pattern Extraction ===');

  const markdown = `
## Implementation Constraints

- Files: Don't modify "shared/lib/config.ts"
- Patterns: No "any" types allowed in new code
- Glob: Avoid modifying "*.test.ts" files
`;

  const result = parseConstraints(markdown);

  assert(result.constraints.length === 3, 'Should parse 3 constraints');
  assert(
    result.constraints[0].pattern === 'shared/lib/config.ts',
    'Should extract file path pattern'
  );
  assert(result.constraints[2].pattern === '*.test.ts', 'Should extract glob pattern');
}

function testSeverityDetermination() {
  console.log('\n=== Testing Severity Determination ===');

  const markdown = `
## Implementation Constraints

- Security: Must validate all user inputs
- Style: Should use consistent naming
- Performance: Cannot block main thread
- Recommendation: Consider using caching
`;

  const result = parseConstraints(markdown);

  assert(result.constraints.length === 4, 'Should parse 4 constraints');
  assert(result.constraints[0].severity === 'error', 'Security "must" should be error');
  assert(result.constraints[1].severity === 'warning', 'Style "should" should be warning');
  assert(result.constraints[2].severity === 'error', 'Performance "cannot" should be error');
  assert(
    result.constraints[3].severity === 'warning',
    'Recommendation "consider" should be warning'
  );
}

function testMissingSection() {
  console.log('\n=== Testing Missing Constraints Section ===');

  const markdown = `
# Task Packet

## Objective
Build a feature

## Success Criteria
It works
`;

  const result = parseConstraints(markdown);

  assert(result.constraints.length === 0, 'Should find no constraints');
  assert(result.warnings.length === 1, 'Should have 1 warning');
  assert(
    result.warnings[0].includes('No "Implementation Constraints" section found'),
    'Warning should mention missing section'
  );
}

function testEmptyConstraints() {
  console.log('\n=== Testing Empty Constraints ===');

  const markdown = `
## Implementation Constraints

- Code style: ...
- Testing: N/A
- Security: TBD
`;

  const result = parseConstraints(markdown);

  assert(result.constraints.length === 0, 'Should skip empty/placeholder constraints');
  assert(result.warnings.length === 1, 'Should warn about no parseable constraints');
}

function testVariedHeadingFormats() {
  console.log('\n=== Testing Varied Heading Formats ===');

  const markdown1 = `
## 5. Implementation Constraints
- Code: Must use TypeScript
`;

  const markdown2 = `
### Implementation Constraints
- Code: Must use TypeScript
`;

  const markdown3 = `
# Implementation Constraints
- Code: Must use TypeScript
`;

  const result1 = parseConstraints(markdown1);
  const result2 = parseConstraints(markdown2);
  const result3 = parseConstraints(markdown3);

  assert(result1.constraints.length === 1, 'Should parse with numbered heading (##)');
  assert(result2.constraints.length === 1, 'Should parse with ### heading');
  assert(result3.constraints.length === 1, 'Should parse with # heading');
}

// Run all tests
try {
  testBasicParsing();
  testAutoValidatableClassification();
  testPatternExtraction();
  testSeverityDetermination();
  testMissingSection();
  testEmptyConstraints();
  testVariedHeadingFormats();

  console.log('\n✅ All tests passed!\n');
  process.exit(0);
} catch (error) {
  console.error('\n❌ Test suite failed:', error);
  process.exit(1);
}
