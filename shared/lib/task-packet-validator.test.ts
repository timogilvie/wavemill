#!/usr/bin/env -S npx tsx
// wavemill-test-suite: custom
/**
 * Basic unit tests for task-packet-validator
 * Run with: npx tsx shared/lib/task-packet-validator.test.ts
 */

import {
  validateFileExistence,
  validateValidationSteps,
  validateScopeBoundaries,
  validateAcceptanceCriteria,
  validateReleaseReadiness,
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
- \`shared/lib/linear.ts\` - Linear API client
- \`tools/expand-issue.ts\` - Issue expansion tool
- \`nonexistent/file.ts\` - This doesn't exist
  `;

  const issues = validateFileExistence(taskPacket, process.cwd());

  assert(issues.length === 1, 'Should find 1 non-existent file');
  assert(issues[0].type === 'file-not-found', 'Issue type should be file-not-found');
  assert(issues[0].description.includes('nonexistent/file.ts'), 'Should mention the missing file');

  const plannedPacket = `
## Key Files
- \`shared/lib/linear.ts\` - Existing file
- \`new/feature.ts\` (new) - Planned file
- helpers/new-util.ts (planned) - Planned helper
- \`missing/unmarked.ts\` - Missing file without marker
  `;

  const plannedIssues = validateFileExistence(plannedPacket, process.cwd());
  assert(plannedIssues.length === 1, 'Should only flag missing unmarked key files');
  assert(plannedIssues[0].description.includes('missing/unmarked.ts'), 'Should flag unmarked missing path');

  const traversalPacket = `
## Key Files
- \`../outside/repo.ts\` - Invalid traversal path
  `;

  const traversalIssues = validateFileExistence(traversalPacket, process.cwd());
  assert(traversalIssues.length === 1, 'Should block out-of-repo paths');
  assert(traversalIssues[0].description.includes('../outside/repo.ts'), 'Should mention out-of-repo path');
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

  const numberedPacket = `
## 6. Validation Steps
\`\`\`bash
pnpm lint
pnpm test
pnpm --filter wavemill test -- task-packet-validator
\`\`\`
  `;
  const numberedIssues = validateValidationSteps(numberedPacket);
  assert(numberedIssues.length === 0, 'Should accept numbered Validation Steps heading');

  const missingSectionPacket = `
## Functional Requirements
- [ ] **[REQ-F1]** Example requirement
  `;
  const missingSectionIssues = validateValidationSteps(missingSectionPacket);
  assert(missingSectionIssues.length === 1, 'Should fail when Validation Steps heading is missing');
  assert(
    missingSectionIssues[0].description === 'Validation Steps section is missing',
    'Should use explicit missing section message'
  );

  const emptyValidationPacket = `
## 6. Validation Steps
  `;
  const emptyValidationIssues = validateValidationSteps(emptyValidationPacket);
  assert(emptyValidationIssues.length === 1, 'Should fail when Validation Steps content is empty');
  assert(
    emptyValidationIssues[0].type === 'boilerplate-validation',
    'Empty Validation Steps should still be boilerplate-validation'
  );
}

function testRegressionShapedPackets() {
  console.log('\n=== Testing Regression-Shaped Packets ===');

  const hok1554LikePacket = `
## Key Files
- \`apps/site/src/routes/new-page.tsx\` (planned) - New route
- \`apps/site/src/components/nav/Menu.tsx\` (planned) - New menu component
- \`tools/expand-issue.ts\` - Existing expander

## 6. Validation Steps
\`\`\`bash
pnpm --filter site test -- menu
pnpm --filter site lint
\`\`\`
  `;
  const hok1554Issues = [
    ...validateFileExistence(hok1554LikePacket, process.cwd()),
    ...validateValidationSteps(hok1554LikePacket),
  ];
  assert(hok1554Issues.length === 0, 'HOK-1554-like packet should avoid template-only errors');

  const hok1567LikePacket = `
## Key Files
- \`shared/lib/task-packet-validator.ts\` - Existing validator
- \`tests/task-packet-utils.test.ts\` (new) - Planned test helper

## 6. Validation Steps
\`\`\`bash
pnpm test
pnpm --filter wavemill test -- task-packet-validator
\`\`\`
  `;
  const hok1567FileIssues = validateFileExistence(hok1567LikePacket, process.cwd());
  assert(hok1567FileIssues.length === 0, 'HOK-1567-like packet should allow explicit new test files');

  const hok1261LikePacket = `
## Key Files
- \`shared/lib/task-packet-validator.ts\` - Existing file
- \`apps/site/src/lib/generated.ts\` (planned) - Planned generated file
- \`apps/site/src/lib/missing-unmarked.ts\` - Should fail

## 6. Validation Steps
\`\`\`bash
pnpm --filter wavemill lint
pnpm --filter wavemill test -- task-packet-validator
\`\`\`
  `;
  const hok1261Issues = validateFileExistence(hok1261LikePacket, process.cwd());
  assert(hok1261Issues.length === 1, 'HOK-1261-like packet should still flag unmarked missing files');
  assert(
    hok1261Issues[0].description.includes('apps/site/src/lib/missing-unmarked.ts'),
    'Should specifically report unmarked missing file in mixed packet'
  );
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

function testReleaseReadiness() {
  console.log('\n=== Testing Release Readiness Validation ===');

  // Valid section produces no warnings
  const validPacket = `
## Release Readiness
- **database_change_risk**: required
- **env_changes**: NEW_API_KEY
- **config_changes**: none
- **manual_steps**: Run migration
  `;

  const validIssues = validateReleaseReadiness(validPacket);
  assert(validIssues.length === 0, 'Should pass with valid release readiness section');

  // Missing section produces no warnings (optional)
  const missingPacket = `
## Objective

Build something
  `;

  const missingIssues = validateReleaseReadiness(missingPacket);
  assert(missingIssues.length === 0, 'Should produce no issues when section is absent');

  // Invalid database_change_risk value
  const invalidDbRisk = `
## Release Readiness
- **database_change_risk**: maybe
- **env_changes**: none
- **config_changes**: none
- **manual_steps**: none
  `;

  const dbRiskIssues = validateReleaseReadiness(invalidDbRisk);
  assert(dbRiskIssues.length === 1, 'Should flag invalid database_change_risk value');
  assert(dbRiskIssues[0].type === 'invalid-release-readiness', 'Issue type should be invalid-release-readiness');
  assert(dbRiskIssues[0].description.includes('maybe'), 'Should mention the invalid value');

  // Missing fields produce warnings
  const missingFields = `
## Release Readiness
- **database_change_risk**: none
  `;

  const fieldIssues = validateReleaseReadiness(missingFields);
  assert(fieldIssues.length === 3, 'Should flag 3 missing fields (env_changes, config_changes, manual_steps)');
  assert(fieldIssues.every(i => i.type === 'invalid-release-readiness'), 'All issues should be invalid-release-readiness');
}

async function main() {
  console.log('Running task-packet-validator tests...\n');

  try {
    testFileExistence();
    testValidationSteps();
    testRegressionShapedPackets();
    testScopeBoundaries();
    testAcceptanceCriteria();
    testReleaseReadiness();

    console.log('\n✅ All tests passed!');
  } catch (error) {
    console.error('\n❌ Tests failed:', error);
    process.exit(1);
  }
}

main();
