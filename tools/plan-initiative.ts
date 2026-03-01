#!/usr/bin/env -S npx tsx

/**
 * Plan Initiative Tool
 *
 * Fetches Linear initiatives, lets the user select one, decomposes it into
 * well-scoped issues using Claude, and creates them in Linear.
 *
 * Sub-commands:
 *   list [--project "Name"] [--max-display 9]
 *     Fetch and rank initiatives, output JSON to stdout
 *
 *   decompose --initiative <id> [--project "Name"] [--dry-run] [--research]
 *     Decompose an initiative into issues using Claude and create in Linear
 */

import '../shared/lib/env.js';
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getInitiatives,
  getInitiative,
  getProjects,
  getTeams,
  createIssue,
  createIssueRelation,
  getOrCreateProjectMilestone,
} from '../shared/lib/linear.js';
import { callClaude, parseJsonFromLLM } from '../shared/lib/llm-cli.ts';
import { toKebabCase } from '../shared/lib/string-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLAUDE_CMD = process.env.CLAUDE_CMD || 'claude';
const PLAN_MODEL = process.env.PLAN_MODEL || 'claude-opus-4-6';

if (!process.env.LINEAR_API_KEY) {
  console.error('Error: LINEAR_API_KEY not found in environment');
  process.exit(1);
}

// ============================================================================
// TYPES
// ============================================================================

interface PlanIssue {
  title: string;
  user_story: string;
  description: string;
  dependencies: number[];
  priority: string;
}

interface PlanMilestone {
  name: string;
  issues: PlanIssue[];
}

interface PlanOutput {
  epic_summary: string;
  milestones: PlanMilestone[];
}

// ============================================================================
// CLAUDE CLI INTEGRATION
// ============================================================================

async function decomposeWithClaude(systemPrompt: string, initiativeContext: string): Promise<string> {
  const fullPrompt = fillPromptTemplate(systemPrompt, initiativeContext);

  const result = await callClaude(fullPrompt, {
    mode: 'stream',
    model: PLAN_MODEL,
    cliFlags: [
      '--tools', '',
      '--append-system-prompt',
      'You have NO tools available. Do NOT output <tool_call> tags, XML markup, or attempt to call any tools. Your ENTIRE response must be valid JSON matching the specified schema. No conversational text, no preamble, no markdown code fences. Start directly with the opening { brace.',
    ],
  });

  return result.text;
}

async function runResearch(researchPrompt: string, initiativeContext: string): Promise<string> {
  const fullPrompt = fillPromptTemplate(researchPrompt, initiativeContext);

  const result = await callClaude(fullPrompt, {
    mode: 'stream',
    model: PLAN_MODEL,
    cliFlags: [
      '--tools', '',
      '--append-system-prompt',
      'You have NO tools available. Do NOT output <tool_call> tags, XML markup, or attempt to call any tools. Your ENTIRE response must be the structured markdown research summary and nothing else. No conversational text, no preamble. Start directly with the first markdown heading.',
    ],
  });

  return result.text;
}

/**
 * Fill the prompt template with context using placeholder substitution.
 *
 * Substitutes:
 * - {{INITIATIVE_CONTEXT}}
 */
function fillPromptTemplate(template: string, initiativeContext: string): string {
  return template.replace('{{INITIATIVE_CONTEXT}}', initiativeContext);
}

// ============================================================================
// VALIDATION
// ============================================================================

function validatePlanOutput(output: any): output is PlanOutput {
  if (!output || typeof output !== 'object') return false;
  if (!output.epic_summary || typeof output.epic_summary !== 'string') return false;
  if (!Array.isArray(output.milestones) || output.milestones.length === 0) return false;

  for (const milestone of output.milestones) {
    if (!milestone.name || typeof milestone.name !== 'string') return false;
    if (!Array.isArray(milestone.issues) || milestone.issues.length === 0) return false;

    for (const issue of milestone.issues) {
      if (!issue.title || typeof issue.title !== 'string') return false;
      if (!issue.description || typeof issue.description !== 'string') return false;
      if (!Array.isArray(issue.dependencies)) return false;
    }
  }

  return true;
}

function priorityToNumber(priority: string): number {
  switch (priority) {
    case 'P0': return 1; // Urgent
    case 'P1': return 2; // High
    case 'P2': return 3; // Normal
    case 'P3': return 4; // Low
    default: return 3;   // Normal
  }
}

// ============================================================================
// LIST SUB-COMMAND
// ============================================================================

async function listInitiatives(args: string[]) {
  const projectIdx = args.indexOf('--project');
  const projectName = projectIdx >= 0 ? args[projectIdx + 1] : '';

  const maxDisplayIdx = args.indexOf('--max-display');
  const maxDisplay = maxDisplayIdx >= 0 ? parseInt(args[maxDisplayIdx + 1]) : 9;

  const initiatives = await getInitiatives();

  // Filter by project if specified
  let filtered = initiatives;
  if (projectName) {
    filtered = initiatives.filter((init: any) =>
      init.projects?.nodes?.some((p: any) => p.name === projectName)
    );
  }

  // Compute issue count per initiative (from associated projects)
  const ranked = filtered.map((init: any) => {
    const issueCount = (init.projects?.nodes || []).reduce((sum: number, p: any) => {
      return sum + (p.issues?.nodes?.length || 0);
    }, 0);

    return {
      id: init.id,
      name: init.name,
      description: init.description || '',
      status: init.status,
      issueCount,
      targetDate: init.targetDate || null,
      owner: init.owner?.name || null,
      projectNames: (init.projects?.nodes || []).map((p: any) => p.name),
    };
  });

  // Sort: zero-issue first, then Active before Planned, then by name
  ranked.sort((a: any, b: any) => {
    // Prioritize those without issues
    if (a.issueCount === 0 && b.issueCount > 0) return -1;
    if (a.issueCount > 0 && b.issueCount === 0) return 1;

    // Then by status: Active > Planned
    const statusOrder: Record<string, number> = { Active: 0, Planned: 1, Completed: 2 };
    const sa = statusOrder[a.status] ?? 9;
    const sb = statusOrder[b.status] ?? 9;
    if (sa !== sb) return sa - sb;

    // Then alphabetically
    return a.name.localeCompare(b.name);
  });

  // Truncate to maxDisplay
  const result = ranked.slice(0, maxDisplay);

  // Output JSON to stdout
  console.log(JSON.stringify(result, null, 2));
}

// ============================================================================
// DECOMPOSE SUB-COMMAND
// ============================================================================

async function decompose(args: string[]) {
  const initiativeIdx = args.indexOf('--initiative');
  if (initiativeIdx < 0 || !args[initiativeIdx + 1]) {
    console.error('Error: --initiative <id> is required');
    process.exit(1);
  }
  const initiativeId = args[initiativeIdx + 1];

  const projectIdx = args.indexOf('--project');
  const projectName = projectIdx >= 0 ? args[projectIdx + 1] : '';

  const dryRun = args.includes('--dry-run');
  const research = args.includes('--research');

  // 1. Fetch initiative details
  console.log('Fetching initiative details...');
  const initiative = await getInitiative(initiativeId);
  if (!initiative) {
    console.error(`Initiative not found: ${initiativeId}`);
    process.exit(1);
  }

  console.log(`Initiative: ${initiative.name}`);
  console.log(`Status: ${initiative.status}`);
  console.log(`Projects: ${(initiative.projects?.nodes || []).map((p: any) => p.name).join(', ') || 'None'}`);
  console.log('');

  // 2. Resolve target project
  let targetProject = null;
  if (projectName) {
    const projects = await getProjects();
    targetProject = projects.find((p: any) => p.name === projectName);
    if (!targetProject) {
      console.error(`Project not found: ${projectName}`);
      console.error(`Available projects: ${projects.map((p: any) => p.name).join(', ')}`);
      process.exit(1);
    }
  } else if (initiative.projects?.nodes?.length > 0) {
    targetProject = initiative.projects.nodes[0];
  }

  if (!targetProject) {
    console.error('No project found. Specify --project or link a project to the initiative in Linear.');
    process.exit(1);
  }
  console.log(`Target project: ${targetProject.name}`);

  // 3. Resolve team
  const teams = await getTeams();
  if (teams.length === 0) {
    console.error('No teams found in Linear.');
    process.exit(1);
  }
  const team = teams[0];
  console.log(`Team: ${team.name} (${team.key})`);
  console.log('');

  // 4. Load system prompt
  const promptPath = path.join(__dirname, 'prompts/initiative-planner.md');
  const systemPrompt = await fs.readFile(promptPath, 'utf-8');

  // 5. Format initiative context
  let context = `# Initiative Details\n\n`;
  context += `**Name**: ${initiative.name}\n`;
  context += `**Status**: ${initiative.status}\n`;
  if (initiative.targetDate) {
    context += `**Target Date**: ${initiative.targetDate}\n`;
  }
  if (initiative.owner?.name) {
    context += `**Owner**: ${initiative.owner.name}\n`;
  }
  context += `**Project**: ${targetProject.name}\n`;
  context += `\n## Description\n\n`;
  context += initiative.description || '*(No description provided)*';
  if (initiative.content && initiative.content !== initiative.description) {
    context += `\n\n## Content\n\n`;
    context += initiative.content;
  }

  // 5b. Research phase (optional)
  if (research) {
    console.log('Running research phase...');
    console.log('─'.repeat(80));

    const researchPromptPath = path.join(__dirname, 'prompts/research-phase.md');
    const researchPrompt = await fs.readFile(researchPromptPath, 'utf-8');
    const researchOutput = await runResearch(researchPrompt, context);

    console.log(researchOutput);
    console.log('─'.repeat(80));
    console.log('');

    // Persist research summary
    const repoRoot = path.resolve(__dirname, '..');
    const slug = toKebabCase(initiative.name);
    const epicsDir = path.join(repoRoot, 'epics', slug);
    await fs.mkdir(epicsDir, { recursive: true });
    const researchPath = path.join(epicsDir, 'research-summary.md');
    await fs.writeFile(researchPath, researchOutput, 'utf-8');
    console.log(`Research summary saved to: epics/${slug}/research-summary.md`);
    console.log('');

    // Inject research into initiative context
    context += `\n\n## Research Summary\n\n${researchOutput}`;
  }

  // 6. Call Claude
  console.log('Decomposing initiative with Claude...');
  console.log('─'.repeat(80));
  const rawOutput = await decomposeWithClaude(systemPrompt, context);
  console.log('─'.repeat(80));
  console.log('');

  // 7. Parse and validate JSON
  let plan: PlanOutput;
  try {
    plan = parseJsonFromLLM<PlanOutput>(rawOutput);
  } catch (e) {
    console.error('Failed to parse Claude output as JSON.');
    console.error('Error:', (e as Error).message);
    process.exit(1);
  }

  if (!validatePlanOutput(plan)) {
    console.error('Claude output does not match expected schema.');
    console.error('Parsed:', JSON.stringify(plan, null, 2).substring(0, 500));
    process.exit(1);
  }

  // 8. Display plan summary
  const totalIssues = plan.milestones.reduce((sum, m) => sum + m.issues.length, 0);
  console.log(`Epic Summary: ${plan.epic_summary}`);
  console.log(`Milestones: ${plan.milestones.length}`);
  console.log(`Total Issues: ${totalIssues}`);
  console.log('');

  for (const milestone of plan.milestones) {
    console.log(`  ${milestone.name} (${milestone.issues.length} issues):`);
    for (const issue of milestone.issues) {
      console.log(`    - [${issue.priority}] ${issue.title}`);
    }
  }
  console.log('');

  if (dryRun) {
    console.log('Dry-run mode -- skipping issue creation.');
    console.log('\nFull plan JSON:');
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  // 9. Create milestones and issues in Linear
  console.log('='.repeat(60));
  console.log('CREATING ISSUES IN LINEAR');
  console.log('='.repeat(60));

  // Flatten all issues for global index tracking
  const allIssues = plan.milestones.flatMap(m => m.issues);
  const createdIssues: any[] = [];

  for (const milestone of plan.milestones) {
    // Create milestone
    let milestoneId: string | undefined;
    try {
      console.log(`\nCreating milestone: "${milestone.name}"...`);
      milestoneId = await getOrCreateProjectMilestone(targetProject.id, milestone.name);
      console.log(`  ✓ Milestone: ${milestone.name}`);
    } catch (error) {
      console.warn(`  ⚠ Could not create milestone: ${error.message}`);
    }

    // Create issues in this milestone
    for (const issue of milestone.issues) {
      const enhancedDescription = `${issue.user_story}\n\n${issue.description}\n\n---\n**Initiative:** ${initiative.name}\n**Milestone:** ${milestone.name}\n**Priority:** ${issue.priority}`;

      console.log(`  Creating: ${issue.title}`);

      const created = await createIssue({
        title: issue.title,
        description: enhancedDescription,
        teamId: team.id,
        projectId: targetProject.id,
        projectMilestoneId: milestoneId,
        priority: priorityToNumber(issue.priority),
      });

      createdIssues.push(created);
      console.log(`    ✓ ${created.identifier} - ${created.url}`);
    }
  }

  // 10. Create dependency relationships
  console.log('\nCreating dependency relationships...');
  for (let i = 0; i < allIssues.length; i++) {
    const issue = allIssues[i];
    if (issue.dependencies && issue.dependencies.length > 0) {
      for (const depIndex of issue.dependencies) {
        if (depIndex >= 0 && depIndex < createdIssues.length && depIndex !== i) {
          console.log(`  ${createdIssues[i].identifier} blocked by ${createdIssues[depIndex].identifier}`);
          await createIssueRelation(
            createdIssues[depIndex].id,
            createdIssues[i].id,
            'blocks'
          );
        }
      }
    }
  }

  // 11. Summary
  console.log('\n' + '='.repeat(60));
  console.log('PLAN DECOMPOSITION COMPLETE');
  console.log('='.repeat(60));
  console.log(`\nInitiative: ${initiative.name}`);
  console.log(`Created ${createdIssues.length} issues:\n`);
  createdIssues.forEach((created, i) => {
    const deps = allIssues[i].dependencies || [];
    const depStr = deps.length > 0
      ? ` (depends on: ${deps.map((d: number) => createdIssues[d]?.identifier).filter(Boolean).join(', ')})`
      : '';
    console.log(`  ${created.identifier}: ${allIssues[i].title}${depStr}`);
    console.log(`    ${created.url}`);
  });
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const subCommand = args[0];

  if (!subCommand || subCommand === '--help' || subCommand === '-h') {
    console.log(`
Plan Initiative Tool

Usage:
  npx tsx tools/plan-initiative.ts <sub-command> [options]

Sub-commands:
  list       Fetch and rank initiatives, output JSON to stdout
  decompose  Decompose an initiative into issues using Claude

Options (list):
  --project "Name"   Filter by Linear project name
  --max-display N    Maximum initiatives to return (default: 9)

Options (decompose):
  --initiative <id>  Linear initiative ID (required)
  --project "Name"   Target project for created issues
  --dry-run          Show plan without creating issues
  --research         Run research phase before decomposition

Examples:
  npx tsx tools/plan-initiative.ts list
  npx tsx tools/plan-initiative.ts list --project "My Project"
  npx tsx tools/plan-initiative.ts decompose --initiative abc-123 --dry-run
  npx tsx tools/plan-initiative.ts decompose --initiative abc-123 --research
  npx tsx tools/plan-initiative.ts decompose --initiative abc-123 --project "My Project"

Environment Variables:
  LINEAR_API_KEY   Required: Linear API key
  CLAUDE_CMD       Optional: Claude CLI command (default: 'claude')
    `);
    process.exit(0);
  }

  try {
    switch (subCommand) {
      case 'list':
        await listInitiatives(args.slice(1));
        break;
      case 'decompose':
        await decompose(args.slice(1));
        break;
      default:
        console.error(`Unknown sub-command: ${subCommand}`);
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
