#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import '../shared/lib/env.js';
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { getIssue, updateIssue } from '../shared/lib/linear.js';
import {
  validateTaskPacket,
  DEFAULT_VALIDATION_CONFIG,
  type ValidationConfig,
  type ValidationResult,
} from '../shared/lib/task-packet-validator.ts';
import { getValidationConfig } from '../shared/lib/config.ts';
import { createInterface } from "node:readline";
import {
  parseIssueInput,
  formatIssueContext,
  expandIssueWithClaude,
  checkSubsystemDrift,
} from '../shared/lib/issue-expander.ts';
import { gatherCodebaseContext } from '../shared/lib/codebase-context-gatherer.ts';
import { splitTaskPacket, isValidTaskPacket } from '../shared/lib/task-packet-utils.ts';
import { formatValidationIssues } from '../shared/lib/validation-formatter.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!process.env.LINEAR_API_KEY) {
  console.error('Error: LINEAR_API_KEY not found in environment');
  process.exit(1);
}

// Ask user for confirmation
async function promptUser(question: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}

runTool({
  name: 'expand-issue',
  description: 'Expand Linear issue into comprehensive task packet',
  options: {
    update: { type: 'boolean', description: 'Update the Linear issue with expanded content' },
    'skip-validation': { type: 'boolean', description: 'Skip quality gate validation' },
    output: { type: 'string', description: 'Save expanded description to file' },
    'repo-path': { type: 'string', description: 'Path to target repository' },
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  positional: {
    name: 'issueId',
    description: 'Linear issue ID (e.g., LIN-123) or URL',
  },
  examples: [
    'npx tsx tools/expand-issue.ts LIN-123',
    'npx tsx tools/expand-issue.ts LIN-123 --update',
    'npx tsx tools/expand-issue.ts LIN-123 --output expanded-issue.md',
  ],
  additionalHelp: `Environment Variables:
  LINEAR_API_KEY   Required: Linear API key
  CLAUDE_CMD       Optional: Claude CLI command (default: 'claude')`,
  async run({ args, positional }) {
    const issueInput = positional[0];
    if (!issueInput) {
      console.error('Error: Issue ID is required');
      process.exit(1);
    }

    const shouldUpdate = !!args.update;
    const skipValidation = !!args['skip-validation'];
    const outputFile = args.output as string | null;
    const repoPath = (args['repo-path'] as string) || process.cwd();

    try {
      // Parse and fetch issue
      console.log('Fetching issue details...');
      const identifier = parseIssueInput(issueInput);
      const issue = await getIssue(identifier);

      if (!issue) {
        console.error(`Issue not found: ${identifier}`);
        process.exit(1);
      }

      console.log(`Found: ${issue.identifier} - ${issue.title}`);
      console.log(`Project: ${issue.project?.name || 'None'}`);
      console.log(`State: ${issue.state?.name}\n`);

      // Load issue-writer prompt
      console.log('Loading issue-writer prompt...');
      const promptPath = path.join(__dirname, 'prompts/issue-writer.md');
      const promptTemplate = await fs.readFile(promptPath, 'utf-8');

      // Format issue context
      const issueContext = formatIssueContext(issue);

      // Gather codebase context
      const codebaseContext = await gatherCodebaseContext({
        repoPath,
        issueTitle: issue.title,
        issueDescription: issue.description || '',
      });

      // Check for subsystem drift before expansion
      await checkSubsystemDrift(repoPath, issue.description || '');

      // Expand with Claude
      console.log('Expanding issue with Claude...\n');
      console.log('─'.repeat(80));
      const expandedDescription = await expandIssueWithClaude(
        promptTemplate,
        issueContext,
        codebaseContext
      );
      console.log('─'.repeat(80));
      console.log('\n');

      // Split into header and details
      const { header, details, fullContent } = splitTaskPacket(expandedDescription);
      console.log(`Split task packet: header (${header.length} chars), details (${details.length} chars)\n`);

      // Handle output (don't let file write failure block Linear update)
      if (outputFile) {
        try {
          // Write header file
          const headerFile = outputFile.replace(/\.md$/, '-header.md');
          await fs.writeFile(headerFile, header, 'utf-8');
          console.log(`✓ Header saved to: ${headerFile}`);

          // Write details file
          const detailsFile = outputFile.replace(/\.md$/, '-details.md');
          await fs.writeFile(detailsFile, details, 'utf-8');
          console.log(`✓ Details saved to: ${detailsFile}`);

          // Also write full content for reference
          await fs.writeFile(outputFile, fullContent, 'utf-8');
          console.log(`✓ Full content saved to: ${outputFile}`);
        } catch (writeError) {
          const errorMsg = writeError instanceof Error ? writeError.message : String(writeError);
          console.warn(`⚠️  Failed to write output files: ${errorMsg}`);
        }
      } else {
        console.log('Expanded Description (Header):\n');
        console.log(header);
        console.log('\n');
        console.log('(Full details available in details section)\n');
      }

      // Validate output before updating Linear (use full content for validation)
      if (!isValidTaskPacket(fullContent)) {
        console.error('✗ Claude output is not a valid task packet (missing expected section headers).');
        console.error('  First 200 chars:', fullContent.substring(0, 200));
        console.error('  Skipping Linear update to avoid overwriting with bad content.');
        process.exit(1);
      }

      // Run quality gate validation (unless skipped) - validate full content
      let validationResult: ValidationResult | null = null;
      if (!skipValidation) {
        console.log('\nRunning quality gate validation...');

        const configValidation = getValidationConfig();
        const validationConfig: ValidationConfig = {
          ...DEFAULT_VALIDATION_CONFIG,
          ...configValidation,
          layer1: { ...DEFAULT_VALIDATION_CONFIG.layer1, ...configValidation.layer1 },
          layer2: { ...DEFAULT_VALIDATION_CONFIG.layer2, ...configValidation.layer2 },
        };

        try {
          validationResult = await validateTaskPacket(fullContent, repoPath, validationConfig);

          console.log(formatValidationIssues(validationResult.issues));

          if (!validationResult.passed) {
            console.error('\n❌ Validation FAILED');

            if (shouldUpdate) {
              // Ask user whether to proceed
              console.log('\nThe task packet has quality issues that may cause problems for autonomous agents.');
              const proceed = await promptUser('Do you want to update Linear anyway? (y/N): ');

              if (!proceed) {
                console.log('✗ Cancelled. Fix the issues and try again.');
                process.exit(1);
              } else {
                console.log('⚠️  Proceeding with update despite validation failures...');
              }
            } else {
              console.log('\nℹ This is a dry-run. Use --update to save to Linear (with confirmation).');
              console.log('  Or use --skip-validation to bypass quality gate.');
            }
          } else {
            console.log('\n✓ Validation PASSED');
          }
        } catch (validationError) {
          const errorMsg = validationError instanceof Error ? validationError.message : String(validationError);
          console.warn(`\n⚠️  Validation failed with error: ${errorMsg}`);
          console.warn('   Proceeding without validation...');
        }
      } else {
        console.log('\n⚠️  Skipping validation (--skip-validation flag)');
      }

      // Update Linear if requested (with full content for backward compatibility)
      if (shouldUpdate) {
        console.log(`Updating Linear issue ${issue.identifier}...`);
        const result = await updateIssue(issue.id, { description: fullContent });

        if (result.success) {
          console.log(`✓ Successfully updated: ${result.issue.url}`);

          // Auto-label the issue based on expanded content
          console.log(`\nAuto-labeling issue ${issue.identifier}...`);
          try {
            const autoLabel = spawn('npx', ['tsx', path.join(__dirname, 'auto-label-issue.ts'), issue.identifier], {
              stdio: 'inherit'
            });

            await new Promise((resolve, reject) => {
              autoLabel.on('close', (code) => {
                if (code === 0) {
                  resolve(true);
                } else {
                  reject(new Error(`Auto-labeling exited with code ${code}`));
                }
              });
              autoLabel.on('error', reject);
            });
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.warn(`⚠️  Auto-labeling failed: ${errorMsg}`);
            console.warn('   Issue was updated but labels were not applied');
          }
        } else {
          console.error('Failed to update issue');
          process.exit(1);
        }
      } else {
        console.log('ℹ Dry-run mode (use --update to save to Linear)');
      }

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('Error:', errorMsg);
      process.exit(1);
    }
  },
});
