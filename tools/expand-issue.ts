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
import { spawn } from 'child_process';
import { getIssue, updateIssue } from '../shared/lib/linear.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLAUDE_CMD = process.env.CLAUDE_CMD || 'claude';

if (!process.env.LINEAR_API_KEY) {
  console.error('Error: LINEAR_API_KEY not found in environment');
  process.exit(1);
}

// Validate that output looks like a structured task packet, not conversational text
function isValidTaskPacket(text: string): boolean {
  // Must contain at least one of the expected section headers
  return /##\s*(1\.|Objective|What|Technical Context|Success Criteria|Implementation)/i.test(text);
}

// Strip tool_call XML, conversational narration, and other non-markdown noise
// that Claude may emit in --print mode
function cleanOutput(text: string): string {
  // Remove <tool_call>...</tool_call> blocks (including multiline)
  let cleaned = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');

  // Remove any other XML-style tags that aren't standard markdown
  cleaned = cleaned.replace(/<\/?(?:tool_name|parameters|prompt|command|subagent_type|pattern|file_path|include|path|output_mode|context)[^>]*>[\s\S]*?(?:<\/(?:tool_name|parameters|prompt|command|subagent_type|pattern|file_path|include|path|output_mode|context)>)?/g, '');

  // Strip conversational preamble before the first markdown heading
  const firstHeading = cleaned.search(/^#\s/m);
  if (firstHeading > 0) {
    cleaned = cleaned.substring(firstHeading);
  }

  // Collapse runs of 3+ blank lines into 2
  cleaned = cleaned.replace(/\n{4,}/g, '\n\n\n');

  return cleaned.trim();
}

// Claude CLI helper - uses your local Claude subscription
async function expandWithClaude(prompt: string, issueContext: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const fullPrompt = `${prompt}\n\n---\n\n${issueContext}`;

    const claude = spawn(CLAUDE_CMD, [
      '--print',
      '--tools', '',
      '--append-system-prompt',
      'You have NO tools available. Do NOT output <tool_call> tags, XML markup, or attempt to call any tools. Your ENTIRE response must be the task packet markdown and nothing else. No conversational text, no preamble, no apologies, no questions. Start directly with the first markdown heading.',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    claude.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    claude.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    claude.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
      } else {
        resolve(cleanOutput(stdout));
      }
    });

    claude.on('error', (error) => {
      reject(new Error(`Failed to spawn Claude CLI: ${error.message}`));
    });

    // Send prompt to Claude via stdin
    claude.stdin.write(fullPrompt);
    claude.stdin.end();
  });
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
  --update       Update the Linear issue with the expanded description
  --dry-run      Show what would be updated without making changes (default)
  --output FILE  Save expanded description to file instead of stdout
  --help, -h     Show this help message

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
  const outputFileIndex = args.indexOf('--output');
  const outputFile = outputFileIndex >= 0 ? args[outputFileIndex + 1] : null;

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

    // Expand with Claude
    console.log('Expanding issue with Claude...\n');
    console.log('─'.repeat(80));
    const expandedDescription = await expandWithClaude(promptTemplate, issueContext);
    console.log('─'.repeat(80));
    console.log('\n');

    // Handle output (don't let file write failure block Linear update)
    if (outputFile) {
      try {
        await fs.writeFile(outputFile, expandedDescription, 'utf-8');
        console.log(`✓ Expanded description saved to: ${outputFile}`);
      } catch (writeError) {
        console.warn(`⚠️  Failed to write output file: ${writeError.message}`);
      }
    } else {
      console.log('Expanded Description:\n');
      console.log(expandedDescription);
      console.log('\n');
    }

    // Validate output before updating Linear
    if (!isValidTaskPacket(expandedDescription)) {
      console.error('✗ Claude output is not a valid task packet (missing expected section headers).');
      console.error('  First 200 chars:', expandedDescription.substring(0, 200));
      console.error('  Skipping Linear update to avoid overwriting with bad content.');
      process.exit(1);
    }

    // Update Linear if requested
    if (shouldUpdate) {
      console.log(`Updating Linear issue ${issue.identifier}...`);
      const result = await updateIssue(issue.id, { description: expandedDescription });

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
