#!/usr/bin/env -S npx tsx
/**
 * Basic unit tests for task-packet-validator
 * Run with: npx tsx shared/lib/task-packet-validator.test.ts
 */

import {
  validateFileExistence,
  validateValidationSteps,
  validateScopeBoundaries,
  validateAcceptanceCriteria,
} from './task-packet-validator.ts';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`✓ ${message}`);
}

function testFileExistence() {
  console.log('\n=== Testing File Existence Validation ===');

  const taskPacket = `
## Key Files
- \`shared/lib/linear.js\` - Linear API client
- \`tools/expand-issue.ts\` - Issue expansion tool
- \`nonexistent/file.ts\` - This doesn't exist
  `;

  const issues = validateFileExistence(taskPacket, process.cwd());

  assert(issues.length === 1, 'Should find 1 non-existent file');
  assert(issues[0].type === 'file-not-found', 'Issue type should be file-not-found');
  assert(issues[0].description.includes('nonexistent/file.ts'), 'Should mention the missing file');
}

function testValidationSteps() {
  console.log('\n=== Testing Validation Steps ===');

  const boilerplatePacket = `
## Validation Steps
\`\`\`bash
pnpm lint
pnpm test
pnpm build
\`\`\`
  `;

  const issues = validateValidationSteps(boilerplatePacket);
  assert(issues.length === 1, 'Should flag boilerplate validation');
  assert(issues[0].type === 'boilerplate-validation', 'Issue type should be boilerplate-validation');

  const goodPacket = `
## Validation Steps
\`\`\`bash
pnpm lint
pnpm test
curl -X POST http://localhost:3000/api/test -d '{"test": true}'
# Expected: 200 OK with {"success": true}
\`\`\`
  `;

  const goodIssues = validateValidationSteps(goodPacket);
  if (goodIssues.length > 0) {
    console.log('Debug: Good packet validation issues:', JSON.stringify(goodIssues, null, 2));
  }
  assert(goodIssues.length === 0, 'Should pass with custom validation steps');
}

function testScopeBoundaries() {
  console.log('\n=== Testing Scope Boundaries ===');

  const insufficientScope = `
## Scope In
- Add feature

## Scope Out
- Don't break things
  `;

  const issues = validateScopeBoundaries(insufficientScope);
  assert(issues.length === 2, 'Should flag both scopes with only 1 item (need 2+)');
  assert(issues[0].type === 'empty-scope', 'Issue type should be empty-scope');

  const emptyScope = `
## Scope In

## Scope Out
  `;

  const emptyIssues = validateScopeBoundaries(emptyScope);
  assert(emptyIssues.length === 2, 'Should flag both empty scopes');

  const goodScope = `
## Scope In
- Add login endpoint
- Add token validation
- Add error handling

## Scope Out
- No registration endpoint
- No password reset
- No OAuth providers
  `;

  const goodIssues = validateScopeBoundaries(goodScope);
  assert(goodIssues.length === 0, 'Should pass with sufficient scope items (2+)');
}

function testAcceptanceCriteria() {
  console.log('\n=== Testing Acceptance Criteria ===');

  const insufficientCriteria = `
## Functional Requirements
- [ ] Feature works
- [ ] Tests pass
  `;

  const issues = validateAcceptanceCriteria(insufficientCriteria);
  assert(issues.length === 1, 'Should flag insufficient criteria (< 3)');
  assert(issues[0].type === 'insufficient-criteria', 'Issue type should be insufficient-criteria');

  const goodCriteria = `
## Functional Requirements
- [ ] POST /api/login returns 200 with token
- [ ] Invalid credentials return 401
- [ ] Network errors show retry button
- [ ] Token stored in localStorage
  `;

  const goodIssues = validateAcceptanceCriteria(goodCriteria);
  assert(goodIssues.length === 0, 'Should pass with sufficient criteria (>= 3)');
}

async function main() {
  console.log('Running task-packet-validator tests...\n');

  try {
    testFileExistence();
    testValidationSteps();
    testScopeBoundaries();
    testAcceptanceCriteria();

    console.log('\n✅ All tests passed!');
  } catch (error) {
    console.error('\n❌ Tests failed:', error);
    process.exit(1);
  }
}

main();
