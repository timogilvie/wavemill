#!/usr/bin/env -S npx tsx
/**
 * Validate Constraints CLI Tool
 *
 * Usage:
 *   npx tsx tools/validate-constraints.ts <issue-id>
 *   npx tsx tools/validate-constraints.ts HOK-123
 *   npx tsx tools/validate-constraints.ts --issue-id HOK-123
 *
 * Options:
 *   --issue-id <id>    Issue ID to validate constraints for
 *   --no-parallel      Disable parallel rule execution
 *   --help            Show help message
 */

import { validateConstraints, formatValidationResult } from '../shared/lib/constraint-validator.ts';
import { constraintRulesExist } from '../shared/lib/constraint-storage.ts';

async function main() {
  const args = process.argv.slice(2);

  // Show help
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  // Parse arguments
  let issueId: string | null = null;
  let parallel = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--issue-id') {
      issueId = args[++i];
    } else if (arg === '--no-parallel') {
      parallel = false;
    } else if (!arg.startsWith('--')) {
      // Assume it's the issue ID
      issueId = arg;
    }
  }

  if (!issueId) {
    console.error('❌ Error: Issue ID is required\n');
    showHelp();
    process.exit(1);
  }

  // Check if constraints exist
  if (!constraintRulesExist(issueId)) {
    console.error(`❌ Error: No constraint rules found for issue ${issueId}`);
    console.error(`   Expected location: constraints/${issueId}/\n`);
    console.error('Did you generate the rules? Run:');
    console.error(`   npx tsx tools/generate-constraint-rules.ts ${issueId}\n`);
    process.exit(1);
  }

  // Validate constraints
  try {
    console.log(`\n🔍 Validating constraints for ${issueId}...\n`);

    const result = await validateConstraints(issueId, process.cwd(), { parallel });

    // Format and print result
    const formatted = formatValidationResult(result);
    console.log(formatted);

    // Exit with appropriate code
    if (!result.passed) {
      process.exit(1);
    }

    // Exit with warning if manual review required but auto-checks passed
    if (result.manualReviewRequired) {
      process.exit(0); // Don't fail on manual review, just notify
    }

    process.exit(0);
  } catch (error: any) {
    console.error(`\n❌ Validation error: ${error.message}\n`);
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
Validate Constraints CLI Tool

Usage:
  npx tsx tools/validate-constraints.ts <issue-id>
  npx tsx tools/validate-constraints.ts HOK-123
  npx tsx tools/validate-constraints.ts --issue-id HOK-123

Options:
  --issue-id <id>    Issue ID to validate constraints for
  --no-parallel      Disable parallel rule execution
  --help, -h         Show this help message

Examples:
  # Validate constraints for HOK-123
  npx tsx tools/validate-constraints.ts HOK-123

  # Validate with sequential execution
  npx tsx tools/validate-constraints.ts HOK-123 --no-parallel

Description:
  Executes constraint validation rules for a specific issue.
  Rules must be generated first using generate-constraint-rules.ts.

  Constraint rules are stored in: constraints/<issue-id>/

Exit Codes:
  0 - All constraints passed (or only manual review required)
  1 - One or more constraints failed
`);
}

main();
