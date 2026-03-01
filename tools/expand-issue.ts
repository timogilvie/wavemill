#!/usr/bin/env -S npx tsx
// @ts-nocheck

/**
 * Expand Linear Issue Tool
 *
 * Takes a Linear issue ID or URL, fetches the current issue details,
 * uses your local Claude CLI with the issue-writer.md prompt to expand it
 * into a comprehensive task packet, and optionally updates the Linear issue.
 *
 * Usage:
 *   npx tsx tools/expand-issue.ts LIN-123
 *   npx tsx tools/expand-issue.ts LIN-123 --update
 *   npx tsx tools/expand-issue.ts https://linear.app/team/issue/LIN-123
 */

import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import { getIssue, updateIssue } from '../shared/lib/linear.js';
import {
  validateTaskPacket,
  DEFAULT_VALIDATION_CONFIG,
  type ValidationConfig,
  type ValidationResult,
  type ValidationIssue,
} from '../shared/lib/task-packet-validator.js';
import { existsSync, readFileSync } from 'fs';
import { createInterface } from 'readline';
import { callClaude } from '../shared/lib/llm-cli.js';
import { detectSubsystems } from '../shared/lib/subsystem-detector.ts';
import { detectDriftForIssue, formatDriftWarning } from '../shared/lib/drift-detector.ts';
import { findRelevantSubsystems, type SubsystemSearchResult } from '../shared/lib/subsystem-search.ts';

dotenv.config({ quiet: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLAUDE_CMD = process.env.CLAUDE_CMD || 'claude';

if (!process.env.LINEAR_API_KEY) {
  console.error('Error: LINEAR_API_KEY not found in environment');
  process.exit(1);
}

// Split task packet into header and details
// Returns { header: string, details: string, fullContent: string }
function splitTaskPacket(text: string): { header: string; details: string; fullContent: string } {
  const splitMarker = '<!-- SPLIT: HEADER ABOVE, DETAILS BELOW -->';
  const splitIndex = text.indexOf(splitMarker);

  if (splitIndex === -1) {
    // No split marker found - treat entire content as details (backward compat)
    // Generate a simple header from the details
    const objectiveMatch = text.match(/##\s*1\.\s*Objective[\s\S]*?(?=##\s*2\.)/i);
    const keyFilesMatch = text.match(/###\s*Key Files[\s\S]*?(?=###|##)/i);

    const simpleHeader = `# Task Packet\n\n` +
      `## Objective\n\n${objectiveMatch ? objectiveMatch[0] : 'See details below'}\n\n` +
      `## Key Files\n\n${keyFilesMatch ? keyFilesMatch[0] : 'See details below'}\n\n` +
      `## Full Details\n\nComplete task packet with all sections available below.\n`;

    return {
      header: simpleHeader,
      details: text,
      fullContent: text
    };
  }

  // Split at marker
  const header = text.substring(0, splitIndex).trim();
  const details = text.substring(splitIndex + splitMarker.length).trim();

  // Full content for Linear (header + details without marker)
  const fullContent = `${header}\n\n---\n\n${details}`;

  return { header, details, fullContent };
}

// Validate that output looks like a structured task packet, not conversational text
function isValidTaskPacket(text: string): boolean {
  // Must contain at least one of the expected section headers
  return /##\s*(1\.|Objective|What|Technical Context|Success Criteria|Implementation)/i.test(text);
}

// Claude CLI helper - uses your local Claude subscription
async function expandWithClaude(promptTemplate: string, issueContext: string, codebaseContext: string = ''): Promise<string> {
  // Fill template with context using placeholder substitution
  const fullPrompt = fillPromptTemplate(promptTemplate, issueContext, codebaseContext);

  const result = await callClaude(fullPrompt, {
    mode: 'stream',
    claudeCmd: CLAUDE_CMD,
    cliFlags: [
      '--tools', '',
      '--append-system-prompt',
      'You have NO tools available. Do NOT output <tool_call> tags, XML markup, or attempt to call any tools. Your ENTIRE response must be the task packet markdown and nothing else. No conversational text, no preamble, no apologies, no questions. Start directly with the first markdown heading.',
    ],
  });

  return result.text;
}

// Extract issue identifier from various input formats
function parseIssueInput(input: string): string {
  // Handle full Linear URLs
  const urlMatch = input.match(/linear\.app\/[^/]+\/issue\/([A-Z]+-\d+)/);
  if (urlMatch) return urlMatch[1];

  // Handle direct identifier
  const idMatch = input.match(/^([A-Z]+-\d+)$/);
  if (idMatch) return idMatch[1];

  throw new Error(`Invalid issue identifier: ${input}. Expected format: LIN-123 or Linear URL`);
}

// Format issue context for Claude
function formatIssueContext(issue: any): string {
  let context = `# Issue Details\n\n`;
  context += `**Issue ID**: ${issue.identifier}\n`;
  context += `**Title**: ${issue.title}\n`;
  context += `**URL**: ${issue.url}\n`;
  context += `**State**: ${issue.state?.name || 'Unknown'}\n`;
  context += `**Project**: ${issue.project?.name || 'None'}\n`;
  context += `**Team**: ${issue.team?.name || 'Unknown'} (${issue.team?.key})\n`;

  if (issue.priority) {
    const priorities = ['No priority', 'Urgent', 'High', 'Normal', 'Low'];
    context += `**Priority**: ${priorities[issue.priority] || issue.priority}\n`;
  }

  if (issue.estimate) {
    context += `**Estimate**: ${issue.estimate} points\n`;
  }

  if (issue.assignee) {
    context += `**Assignee**: ${issue.assignee.name}\n`;
  }

  if (issue.labels?.nodes.length > 0) {
    context += `**Labels**: ${issue.labels.nodes.map((l: any) => l.name).join(', ')}\n`;
  }

  if (issue.parent) {
    context += `**Parent Issue**: ${issue.parent.identifier} - ${issue.parent.title}\n`;
  }

  if (issue.children?.nodes.length > 0) {
    context += `\n**Sub-tasks** (${issue.children.nodes.length}):\n`;
    issue.children.nodes.forEach((child: any) => {
      context += `- ${child.identifier}: ${child.title} (${child.state?.name})\n`;
    });
  }

  context += `\n## Current Description\n\n`;
  context += issue.description || '*(No description provided)*';

  return context;
}

/**
 * Fill the prompt template with context using placeholder substitution.
 *
 * Substitutes:
 * - {{ISSUE_CONTEXT}}
 * - {{CODEBASE_CONTEXT}}
 */
function fillPromptTemplate(
  template: string,
  issueContext: string,
  codebaseContext: string
): string {
  return template
    .replace('{{ISSUE_CONTEXT}}', issueContext)
    .replace('{{CODEBASE_CONTEXT}}', codebaseContext);
}

// Gather directory tree context (depth-limited)
async function getDirectoryTree(repoPath: string, maxDepth: number = 3): Promise<string> {
  try {
    // Use find with depth limit, exclude common noise
    const cmd = `cd "${repoPath}" && find . -type d -maxdepth ${maxDepth} \
      ! -path "*/node_modules/*" \
      ! -path "*/.git/*" \
      ! -path "*/dist/*" \
      ! -path "*/build/*" \
      | sort | head -100`;

    const result = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    return result.trim() || '(No directories found)';
  } catch (error) {
    return '(Directory tree unavailable)';
  }
}

// Load key files reference from .wavemill/project-context.md, codebase-context.md, or CLAUDE.md
async function getKeyFilesReference(repoPath: string): Promise<string> {
  const candidates = [
    { path: path.join(repoPath, '.wavemill', 'project-context.md'), maxLines: Infinity }, // Full content
    { path: path.join(repoPath, '.wavemill', 'codebase-context.md'), maxLines: 1000 },
    { path: path.join(repoPath, 'CLAUDE.md'), maxLines: 1000 },
  ];

  for (const { path: filePath, maxLines } of candidates) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      // Validate size for project-context.md
      if (filePath.includes('project-context.md')) {
        const sizeKB = Buffer.byteLength(content, 'utf-8') / 1024;
        if (sizeKB > 100) {
          console.warn(`⚠️  project-context.md is ${sizeKB.toFixed(0)}KB (>100KB limit)`);
          console.warn('   Consider archiving old "Recent Work" entries to project-context-archive.md');
          // Still proceed but warn
        } else if (sizeKB > 50) {
          console.warn(`⚠️  project-context.md is ${sizeKB.toFixed(0)}KB (approaching 100KB limit)`);
        }
      }

      // Extract relevant sections (full content for project-context, limited for others)
      const limitedLines = maxLines === Infinity ? lines : lines.slice(0, maxLines);
      return `Source: ${path.basename(filePath)}\n\n${limitedLines.join('\n')}`;
    } catch {
      continue;
    }
  }

  return '(No codebase context file found)';
}

// Get recent git activity to understand active areas
function getRecentGitActivity(repoPath: string, limit: number = 20): string {
  try {
    const cmd = `cd "${repoPath}" && git log --oneline --name-only -${limit}`;
    const result = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    return result.trim() || '(No recent commits found)';
  } catch (error) {
    return '(Git history unavailable)';
  }
}

// Find files matching keywords from issue title
async function findRelevantFiles(repoPath: string, issueTitle: string): Promise<string> {
  // Extract meaningful keywords (exclude common words)
  const stopWords = new Set(['add', 'fix', 'update', 'the', 'a', 'an', 'to', 'for', 'in', 'on', 'and', 'or', 'with']);
  const keywords = issueTitle
    .toLowerCase()
    .split(/\W+/)
    .filter(word => word.length > 3 && !stopWords.has(word))
    .slice(0, 3); // Top 3 keywords

  if (keywords.length === 0) {
    return '(No relevant keywords found)';
  }

  const results: string[] = [];

  for (const keyword of keywords) {
    try {
      const cmd = `cd "${repoPath}" && grep -r --include="*.{ts,js,tsx,jsx,md}" -l "${keyword}" . 2>/dev/null \
        | grep -v node_modules \
        | grep -v .git \
        | head -10`;

      const output = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
      if (output.trim()) {
        results.push(`Keyword: "${keyword}"\n${output.trim()}`);
      }
    } catch {
      // Grep returns non-zero if no matches, that's okay
    }
  }

  return results.length > 0 ? results.join('\n\n') : '(No matching files found)';
}

// Gather subsystem context for an issue
async function gatherSubsystemContext(
  repoPath: string,
  issueDescription: string,
  issueTitle: string
): Promise<string> {
  const contextDir = path.join(repoPath, '.wavemill', 'context');

  // Skip if no subsystem specs exist
  if (!existsSync(contextDir)) {
    return '';
  }

  try {
    console.log('Searching for relevant subsystem specs...');

    const subsystems = findRelevantSubsystems(
      issueDescription,
      issueTitle,
      repoPath,
      { limit: 10, includeFullSpecs: false }
    );

    if (subsystems.length === 0) {
      console.log('⚠️  No relevant subsystem specs found (potential knowledge gap)\n');
      return formatKnowledgeGapWarning();
    }

    console.log(`✓ Found ${subsystems.length} relevant subsystem spec(s)\n`);
    return formatSubsystemContext(subsystems);

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️  Subsystem search failed: ${message}`);
    return '';
  }
}

// Format subsystem context for inclusion in codebase context
function formatSubsystemContext(subsystems: SubsystemSearchResult[]): string {
  let context = '\n## Subsystem Specifications\n\n';
  context += 'The following subsystem specs are relevant to this issue:\n\n';

  for (const subsystem of subsystems.slice(0, 10)) { // Limit to 10 for token budget
    context += `### ${subsystem.subsystemName}\n\n`;
    context += `**Spec Path**: \`.wavemill/context/${subsystem.subsystemId}.md\`\n\n`;

    for (const section of subsystem.relevantSections) {
      context += `**${section.section}**:\n`;
      // Truncate long sections to stay within token budget
      const truncated = section.content.substring(0, 500);
      context += truncated;
      if (section.content.length > 500) context += '...';
      context += '\n\n';
    }

    context += '---\n\n';
  }

  return context;
}

// Format knowledge gap warning when no subsystem specs match
function formatKnowledgeGapWarning(): string {
  return `
## Subsystem Specifications

⚠️ **Knowledge Gap Detected**: No subsystem specs found for this issue.

This may indicate:
- A new subsystem is being introduced
- Existing subsystem specs are incomplete
- The issue description lacks file/pattern references

**Recommendation**: After implementing this issue, run:
\`\`\`bash
wavemill context init --force
\`\`\`

This will create or update subsystem specs, enabling "persistent downstream
acceleration" for future tasks (per Codified Context paper, Case Study 3).

---
`;
}

// Gather all codebase context
async function gatherCodebaseContext(repoPath: string, issueTitle: string, issueDescription: string = ''): Promise<string> {
  console.log('Gathering codebase context...');

  const [dirTree, keyFiles, gitActivity, relevantFiles, subsystemContext] = await Promise.all([
    getDirectoryTree(repoPath),
    getKeyFilesReference(repoPath),
    Promise.resolve(getRecentGitActivity(repoPath)),
    findRelevantFiles(repoPath, issueTitle),
    gatherSubsystemContext(repoPath, issueDescription, issueTitle),
  ]);

  return `
# Codebase Context

## Directory Structure
\`\`\`
${dirTree}
\`\`\`

## Key Files & Conventions
${keyFiles}

${subsystemContext}

## Recent Git Activity
\`\`\`
${gitActivity}
\`\`\`

## Relevant Files (keyword search)
${relevantFiles}
`.trim();
}

// Load validation configuration
function loadValidationConfig(): ValidationConfig {
  const configPath = path.resolve('.wavemill-config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.validation) {
        return {
          ...DEFAULT_VALIDATION_CONFIG,
          ...config.validation,
          layer1: { ...DEFAULT_VALIDATION_CONFIG.layer1, ...config.validation.layer1 },
          layer2: { ...DEFAULT_VALIDATION_CONFIG.layer2, ...config.validation.layer2 },
        };
      }
    } catch {
      // Malformed config — use defaults
    }
  }
  return DEFAULT_VALIDATION_CONFIG;
}

// Format validation issues for display
function formatValidationIssues(issues: ValidationIssue[]): string {
  if (issues.length === 0) {
    return '✓ No validation issues found';
  }

  // Group by severity
  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');

  let output = '';

  if (errors.length > 0) {
    output += `\n❌ ERRORS (${errors.length}):\n`;
    errors.forEach((issue, idx) => {
      output += `\n${idx + 1}. [${issue.type}] ${issue.section}\n`;
      output += `   ${issue.description}\n`;
      output += `   → ${issue.suggestedFix}\n`;
    });
  }

  if (warnings.length > 0) {
    output += `\n⚠️  WARNINGS (${warnings.length}):\n`;
    warnings.forEach((issue, idx) => {
      output += `\n${idx + 1}. [${issue.type}] ${issue.section}\n`;
      output += `   ${issue.description}\n`;
      output += `   → ${issue.suggestedFix}\n`;
    });
  }

  return output;
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

// Check for subsystem drift before expansion
async function checkSubsystemDrift(repoPath: string, issueDescription: string): Promise<void> {
  const contextDir = path.join(repoPath, '.wavemill', 'context');

  // Skip if no subsystem specs exist
  if (!existsSync(contextDir)) {
    return;
  }

  try {
    console.log('Checking for subsystem drift...');

    // Detect subsystems
    const subsystems = detectSubsystems(repoPath, {
      minFiles: 3,
      useGitAnalysis: false, // Skip git analysis for speed
      maxSubsystems: 20,
    });

    if (subsystems.length === 0) {
      return;
    }

    // Check for drift
    const driftResult = detectDriftForIssue(issueDescription, subsystems, repoPath);

    if (driftResult.hasDrift) {
      console.log('');
      console.log(formatDriftWarning(driftResult));
      console.log('');
    } else {
      console.log(`✓ All ${driftResult.totalChecked} subsystem spec(s) are up to date\n`);
    }
  } catch (error) {
    // Drift detection is non-blocking
    console.warn(`⚠️  Drift detection failed: ${error.message}`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Expand Linear Issue Tool

Usage:
  npx tsx tools/expand-issue.ts <issue-id> [options]

Arguments:
  <issue-id>     Linear issue identifier (e.g., LIN-123) or full Linear URL

Options:
  --update            Update the Linear issue with the expanded description
  --repo-path         Path to target repository (default: current directory)
  --dry-run           Show what would be updated without making changes (default)
  --output FILE       Save expanded description to file instead of stdout
  --skip-validation   Skip quality gate validation (not recommended)
  --help, -h          Show this help message

Examples:
  # Preview expanded issue (dry-run)
  npx tsx tools/expand-issue.ts LIN-123

  # Update Linear issue with expanded description
  npx tsx tools/expand-issue.ts LIN-123 --update

  # Save to file without updating Linear
  npx tsx tools/expand-issue.ts LIN-123 --output expanded-issue.md

  # Use Linear URL
  npx tsx tools/expand-issue.ts https://linear.app/myteam/issue/LIN-123 --update

Environment Variables:
  LINEAR_API_KEY   Required: Linear API key
  CLAUDE_CMD       Optional: Claude CLI command (default: 'claude')
    `);
    process.exit(0);
  }

  const issueInput = args[0];
  const shouldUpdate = args.includes('--update');
  const skipValidation = args.includes('--skip-validation');
  const outputFileIndex = args.indexOf('--output');
  const outputFile = outputFileIndex >= 0 ? args[outputFileIndex + 1] : null;
  const repoPathIndex = args.indexOf('--repo-path');
  const repoPath = repoPathIndex >= 0 ? args[repoPathIndex + 1] : process.cwd();

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
    const codebaseContext = await gatherCodebaseContext(repoPath, issue.title, issue.description || '');

    // Check for subsystem drift before expansion
    await checkSubsystemDrift(repoPath, issue.description || '');

    // Expand with Claude
    console.log('Expanding issue with Claude...\n');
    console.log('─'.repeat(80));
    const expandedDescription = await expandWithClaude(promptTemplate, issueContext, codebaseContext);
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
        console.warn(`⚠️  Failed to write output files: ${writeError.message}`);
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

      const validationConfig = loadValidationConfig();

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
        console.warn(`\n⚠️  Validation failed with error: ${validationError.message}`);
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
          console.warn(`⚠️  Auto-labeling failed: ${error.message}`);
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
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
