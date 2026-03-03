/**
 * Initiative Decomposer
 *
 * Orchestrates full initiative decomposition workflow:
 * 1. Fetch initiative details
 * 2. Optionally run research phase
 * 3. Decompose into structured plan
 * 4. Create Linear issues with dependencies
 *
 * @module initiative-decomposer
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  getInitiative,
  getProjects,
  getTeams,
  createIssue,
  createIssueRelation,
  getOrCreateProjectMilestone,
} from './linear.js';
import { parseJsonFromLLM } from './llm-cli.ts';
import { toKebabCase } from './string-utils.js';
import {
  decomposeWithClaude,
  runResearch,
  priorityToNumber,
  type PlanOutput,
  type PlanIssue,
} from './plan-decomposer.ts';
import { validatePlanOutput } from './plan-validator.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * Options for decomposing an initiative.
 */
export interface DecomposeOptions {
  /** Linear initiative ID */
  initiativeId: string;
  /** Target project name (optional, uses first project if not specified) */
  projectName?: string;
  /** System prompt template content */
  systemPrompt: string;
  /** Research prompt template content (optional, for research phase) */
  researchPrompt?: string;
  /** LLM model to use */
  model?: string;
  /** Repository root path for persisting research */
  repoRoot?: string;
  /**
   * Enable interactive mode (allows Claude to use tools).
   * When true: Claude can use WebFetch, AskUserQuestion, Read, etc.
   * When false: Claude has no tools, must output pure JSON/markdown.
   * Default: false (backward compatible)
   */
  interactive?: boolean;
}

/**
 * Result of decomposing an initiative.
 */
export interface DecomposeResult {
  /** Parsed plan output */
  plan: PlanOutput;
  /** Created Linear issues */
  createdIssues: any[];
  /** Research summary (if research phase was run) */
  researchSummary?: string;
}

// ────────────────────────────────────────────────────────────────
// Context Formatting
// ────────────────────────────────────────────────────────────────

/**
 * Format initiative data as context for LLM.
 */
function formatInitiativeContext(initiative: any, targetProject: any): string {
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

  return context;
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Decompose a Linear initiative into issues.
 *
 * Complete workflow:
 * 1. Fetch initiative from Linear
 * 2. Resolve target project and team
 * 3. Optionally run research phase
 * 4. Call LLM to decompose into structured plan
 * 5. Create milestones and issues in Linear
 * 6. Set up dependency relationships
 *
 * @param options - Decomposition options
 * @returns Decomposition result with plan and created issues
 *
 * @example
 * ```typescript
 * const result = await decomposeInitiative({
 *   initiativeId: 'abc-123',
 *   projectName: 'My Project',
 *   systemPrompt: await fs.readFile('prompts/initiative-planner.md', 'utf-8'),
 *   researchPrompt: await fs.readFile('prompts/research-phase.md', 'utf-8'),
 * });
 * console.log(`Created ${result.createdIssues.length} issues`);
 * ```
 */
export async function decomposeInitiative(
  options: DecomposeOptions
): Promise<DecomposeResult> {
  const {
    initiativeId,
    projectName,
    systemPrompt,
    researchPrompt,
    model,
    repoRoot = process.cwd(),
  } = options;

  // 1. Fetch initiative details
  console.log('Fetching initiative details...');
  const initiative = await getInitiative(initiativeId);
  if (!initiative) {
    throw new Error(`Initiative not found: ${initiativeId}`);
  }

  console.log(`Initiative: ${initiative.name}`);
  console.log(`Status: ${initiative.status}`);
  console.log(
    `Projects: ${(initiative.projects?.nodes || []).map((p: any) => p.name).join(', ') || 'None'}`
  );
  console.log('');

  // 2. Resolve target project
  let targetProject = null;
  if (projectName) {
    const projects = await getProjects();
    targetProject = projects.find((p: any) => p.name === projectName);
    if (!targetProject) {
      throw new Error(
        `Project not found: ${projectName}\nAvailable: ${projects.map((p: any) => p.name).join(', ')}`
      );
    }
  } else if (initiative.projects?.nodes?.length > 0) {
    targetProject = initiative.projects.nodes[0];
  }

  if (!targetProject) {
    throw new Error(
      'No project found. Specify projectName or link a project to the initiative in Linear.'
    );
  }
  console.log(`Target project: ${targetProject.name}`);

  // 3. Resolve team
  const teams = await getTeams();
  if (teams.length === 0) {
    throw new Error('No teams found in Linear.');
  }
  const team = teams[0];
  console.log(`Team: ${team.name} (${team.key})`);
  console.log('');

  // 4. Format initiative context
  let context = formatInitiativeContext(initiative, targetProject);

  // 5. Research phase (optional)
  let researchSummary: string | undefined;
  if (researchPrompt) {
    console.log('Running research phase...');
    console.log('─'.repeat(80));

    researchSummary = await runResearch({
      researchPrompt,
      initiativeContext: context,
      model,
      interactive: options.interactive,
    });

    console.log(researchSummary);
    console.log('─'.repeat(80));
    console.log('');

    // Persist research summary
    const slug = toKebabCase(initiative.name);
    const epicsDir = path.join(repoRoot, 'epics', slug);
    await fs.mkdir(epicsDir, { recursive: true });
    const researchPath = path.join(epicsDir, 'research-summary.md');
    await fs.writeFile(researchPath, researchSummary, 'utf-8');
    console.log(`Research summary saved to: epics/${slug}/research-summary.md`);
    console.log('');

    // Inject research into initiative context
    context += `\n\n## Research Summary\n\n${researchSummary}`;
  }

  // 6. Call Claude to decompose
  console.log('Decomposing initiative with Claude...');
  console.log('─'.repeat(80));
  const rawOutput = await decomposeWithClaude({
    systemPrompt,
    initiativeContext: context,
    model,
    interactive: options.interactive,
  });
  console.log('─'.repeat(80));
  console.log('');

  // 7. Parse and validate JSON
  let plan: PlanOutput;
  try {
    plan = parseJsonFromLLM<PlanOutput>(rawOutput);
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    console.error('\n❌ Failed to parse JSON from Claude output');
    console.error('\nExpected format:');
    console.error('```json');
    console.error('{\n  "epic_summary": "...",\n  "milestones": [...]');
    console.error('\n}');
    console.error('```');
    console.error('\nRaw output preview (first 500 chars):');
    console.error(rawOutput.substring(0, 500));
    throw new Error(`Failed to parse Claude output as JSON: ${errorMsg}`);
  }

  if (!validatePlanOutput(plan)) {
    console.error('\n❌ Claude output does not match expected schema');
    console.error('\nRequired fields:');
    console.error('  - epic_summary (string)');
    console.error('  - milestones (array)');
    console.error('    - Each milestone: name (string), issues (array)');
    console.error('    - Each issue: title, description, dependencies (array), priority');
    console.error('\nParsed output:');
    console.error(JSON.stringify(plan, null, 2).substring(0, 500));
    throw new Error(
      `Claude output does not match expected schema. See details above.`
    );
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

  // 9. Create milestones and issues in Linear
  console.log('='.repeat(60));
  console.log('CREATING ISSUES IN LINEAR');
  console.log('='.repeat(60));

  // Flatten all issues for global index tracking
  const allIssues = plan.milestones.flatMap((m) => m.issues);
  const createdIssues: any[] = [];

  for (const milestone of plan.milestones) {
    // Create milestone
    let milestoneId: string | undefined;
    try {
      console.log(`\nCreating milestone: "${milestone.name}"...`);
      milestoneId = await getOrCreateProjectMilestone(
        targetProject.id,
        milestone.name
      );
      console.log(`  ✓ Milestone: ${milestone.name}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn(`  ⚠ Could not create milestone: ${errorMsg}`);
    }

    // Create issues in this milestone
    for (const issue of milestone.issues) {
      const enhancedDescription =
        `${issue.user_story}\n\n${issue.description}\n\n---\n` +
        `**Initiative:** ${initiative.name}\n` +
        `**Milestone:** ${milestone.name}\n` +
        `**Priority:** ${issue.priority}`;

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
          console.log(
            `  ${createdIssues[i].identifier} blocked by ${createdIssues[depIndex].identifier}`
          );
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
    const depStr =
      deps.length > 0
        ? ` (depends on: ${deps.map((d: number) => createdIssues[d]?.identifier).filter(Boolean).join(', ')})`
        : '';
    console.log(`  ${created.identifier}: ${allIssues[i].title}${depStr}`);
    console.log(`    ${created.url}`);
  });

  return {
    plan,
    createdIssues,
    researchSummary,
  };
}
