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

import { runTool } from '../shared/lib/tool-runner.ts';
import { validateConstraints, formatValidationResult } from '../shared/lib/constraint-validator.ts';
import { constraintRulesExist } from '../shared/lib/constraint-storage.ts';

runTool({
  name: 'validate-constraints',
  description: 'Validate constraint rules for a specific Linear issue',
  options: {
    'issue-id': {
      type: 'string',
      description: 'Issue ID to validate constraints for'
    },
    'no-parallel': {
      type: 'boolean',
      description: 'Disable parallel rule execution'
    },
    help: {
      type: 'boolean',
      short: 'h',
      description: 'Show help message'
    },
  },
  positional: {
    name: 'issue-id',
    description: 'Issue ID (e.g., HOK-123)',
    required: false, // Can use --issue-id instead
  },
  examples: [
    '# Validate constraints for HOK-123',
    'npx tsx tools/validate-constraints.ts HOK-123',
    '',
    '# Validate with sequential execution',
    'npx tsx tools/validate-constraints.ts HOK-123 --no-parallel',
    '',
    '# Use --issue-id flag',
    'npx tsx tools/validate-constraints.ts --issue-id HOK-123',
  ],
  additionalHelp: `Description:
  Executes constraint validation rules for a specific issue.
  Rules must be generated first using generate-constraint-rules.ts.

  Constraint rules are stored in: constraints/<issue-id>/

Exit Codes:
  0 - All constraints passed (or only manual review required)
  1 - One or more constraints failed`,
  async run({ args, positional }) {
    // Get issue ID from positional arg or --issue-id flag
    const issueId = positional[0] || args['issue-id'];
    const parallel = !args['no-parallel'];

    if (!issueId) {
      console.error('❌ Error: Issue ID is required\n');
      console.error('Provide as argument or use --issue-id flag');
      console.error('Run with --help for usage information');
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
  },
});
