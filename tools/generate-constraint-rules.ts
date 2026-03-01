#!/usr/bin/env -S npx tsx
/**
 * Generate Constraint Rules CLI Tool
 *
 * Parses constraints from task packets or plans and generates executable
 * validation rules. Rules are saved to constraints/<issue-id>/ directory.
 *
 * Usage:
 *   npx tsx tools/generate-constraint-rules.ts <issue-id>
 *   npx tsx tools/generate-constraint-rules.ts HOK-123
 *   npx tsx tools/generate-constraint-rules.ts --issue-id HOK-123 --file path/to/task-packet.md
 *   npx tsx tools/generate-constraint-rules.ts --task-packet path/to/file.md
 *
 * Options:
 *   --issue-id <id>          Issue ID for the constraints
 *   --file, --task-packet    Path to task packet or plan markdown file
 *   --force                  Overwrite existing constraint rules
 *   --help                   Show help message
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseConstraints } from '../shared/lib/constraint-parser.ts';
import { generateRules } from '../shared/lib/rule-generator.ts';
import { saveConstraintRules, constraintRulesExist } from '../shared/lib/constraint-storage.ts';
import { toKebabCase } from '../shared/lib/string-utils.js';

async function main() {
  const args = process.argv.slice(2);

  // Show help
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  // Parse arguments
  let issueId: string | null = null;
  let taskPacketPath: string | null = null;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--issue-id') {
      issueId = args[++i];
    } else if (arg === '--file' || arg === '--task-packet') {
      taskPacketPath = args[++i];
    } else if (arg === '--force') {
      force = true;
    } else if (!arg.startsWith('--')) {
      // Assume it's the issue ID
      issueId = arg;
    }
  }

  // Validate inputs
  if (!issueId) {
    console.error('❌ Error: Issue ID is required\n');
    showHelp();
    process.exit(1);
  }

  // Check if rules already exist
  if (constraintRulesExist(issueId) && !force) {
    console.error(`❌ Error: Constraint rules already exist for ${issueId}`);
    console.error(`   Location: constraints/${issueId}/\n`);
    console.error('Use --force to overwrite existing rules\n');
    process.exit(1);
  }

  // Determine task packet path
  if (!taskPacketPath) {
    // Try to find task packet in standard locations
    const possiblePaths = [
      `features/${issueId.toLowerCase()}/selected-task.json`,
      `features/${toKebabCase(issueId)}/selected-task.json`,
      `features/${issueId}/task-packet.md`,
      `bugs/${issueId}/selected-task.json`,
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf-8');
        try {
          const json = JSON.parse(content);
          if (json.description) {
            taskPacketPath = p;
            console.log(`📄 Found task packet: ${taskPacketPath}`);
            break;
          }
        } catch {
          // Not JSON, might be markdown
          if (p.endsWith('.md')) {
            taskPacketPath = p;
            console.log(`📄 Found task packet: ${taskPacketPath}`);
            break;
          }
        }
      }
    }

    if (!taskPacketPath) {
      console.error(`❌ Error: Could not find task packet for ${issueId}`);
      console.error('   Searched locations:');
      possiblePaths.forEach(p => console.error(`     - ${p}`));
      console.error('\nSpecify path explicitly with --file option\n');
      process.exit(1);
    }
  }

  // Read task packet
  let taskPacketContent: string;
  try {
    const content = fs.readFileSync(taskPacketPath, 'utf-8');

    // If JSON, extract description field
    try {
      const json = JSON.parse(content);
      taskPacketContent = json.description || content;
    } catch {
      // Not JSON, use as-is
      taskPacketContent = content;
    }
  } catch (error: any) {
    console.error(`❌ Error reading task packet: ${error.message}\n`);
    process.exit(1);
  }

  // Parse constraints
  console.log(`\n🔍 Parsing constraints from task packet...`);
  const parseResult = parseConstraints(taskPacketContent);

  if (parseResult.warnings.length > 0) {
    console.log(`\n⚠️  Warnings:`);
    parseResult.warnings.forEach(w => console.log(`   - ${w}`));
  }

  if (parseResult.constraints.length === 0) {
    console.error(`\n❌ Error: No constraints found in task packet`);
    console.error('   Make sure the task packet includes an "Implementation Constraints" section\n');
    process.exit(1);
  }

  console.log(`\n✓ Found ${parseResult.constraints.length} constraints:`);
  parseResult.constraints.forEach(c => {
    console.log(`   - ${c.id}: ${c.description.substring(0, 60)}${c.description.length > 60 ? '...' : ''}`);
  });

  // Generate rules
  console.log(`\n⚙️  Generating constraint rules...`);
  const ruleGenResult = generateRules(parseResult.constraints, issueId, taskPacketContent);

  console.log(`\n✓ Generated ${ruleGenResult.rules.length} auto-validatable rules`);
  if (ruleGenResult.manualReviewConstraints.length > 0) {
    console.log(`✓ ${ruleGenResult.manualReviewConstraints.length} constraints require manual review`);
  }

  // Save rules
  console.log(`\n💾 Saving rules to constraints/${issueId}/...`);
  const savedPath = saveConstraintRules(issueId, ruleGenResult);

  console.log(`\n✅ Constraint rules generated successfully!`);
  console.log(`\n📁 Location: ${savedPath}/`);
  console.log(`   - ${ruleGenResult.rules.length} executable rules in rules/`);
  console.log(`   - metadata.json`);
  if (ruleGenResult.manualReviewConstraints.length > 0) {
    console.log(`   - manual-review.md (${ruleGenResult.manualReviewConstraints.length} constraints)`);
  }

  console.log(`\n🔍 To validate constraints, run:`);
  console.log(`   npx tsx tools/validate-constraints.ts ${issueId}\n`);

  process.exit(0);
}

function showHelp() {
  console.log(`
Generate Constraint Rules CLI Tool

Usage:
  npx tsx tools/generate-constraint-rules.ts <issue-id>
  npx tsx tools/generate-constraint-rules.ts HOK-123
  npx tsx tools/generate-constraint-rules.ts --issue-id HOK-123 --file path/to/task-packet.md

Options:
  --issue-id <id>           Issue ID for the constraints
  --file, --task-packet     Path to task packet or plan markdown file
  --force                   Overwrite existing constraint rules
  --help, -h                Show this help message

Examples:
  # Generate rules for HOK-123 (auto-detect task packet)
  npx tsx tools/generate-constraint-rules.ts HOK-123

  # Generate rules with explicit file path
  npx tsx tools/generate-constraint-rules.ts HOK-123 --file features/my-feature/plan.md

  # Overwrite existing rules
  npx tsx tools/generate-constraint-rules.ts HOK-123 --force

Description:
  Parses "Implementation Constraints" section from task packets or plans
  and generates executable validation rules. Rules are saved to version
  control in constraints/<issue-id>/ directory.

  Auto-validatable constraints become Node.js scripts that check the code.
  Manual-review constraints are documented in manual-review.md.

  Rules are generated at plan creation time and validated before PR creation.
`);
}

main();
