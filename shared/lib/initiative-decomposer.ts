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
  getOrCreateProjectMilestone,
  getOrCreateLabel,
} from './linear.ts';
import { parseJsonFromLLM } from './llm-cli.ts';
import { toKebabCase } from './string-utils.ts';
import { errorMessage } from './error-utils.ts';
import {
  decomposeWithClaude,
  runResearch,
  priorityToNumber,
  createIssuesWithDependencies,
  type IssueCreationSpec,
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
  /**
   * Timeout in milliseconds for Claude calls.
   * Applies to both research and decomposition phases.
   * Default: set by plan-decomposer based on interactive mode.
   */
  timeout?: number;
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
      timeout: options.timeout,
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
    timeout: options.timeout,
  });
  console.log('─'.repeat(80));
  console.log('');

  // 7. Parse and validate JSON
  const suggestions = [
    'Add more detail to the initiative description in Linear',
    'If it references external content (PRs, docs), paste the key findings inline',
    'Ensure the initiative describes concrete goals, not just links',
  ];

  let plan: PlanOutput;
  try {
    plan = parseJsonFromLLM<PlanOutput>(rawOutput);
  } catch (e) {
    // Claude returned non-JSON — likely a plain-text explanation
    const trimmed = rawOutput.trim().substring(0, 1000);
    console.error('\n❌ Claude was unable to decompose this initiative.');
    console.error(`\nResponse:\n  ${trimmed.split('\n').join('\n  ')}`);
    console.error(`\nSuggestions:\n${suggestions.map((s) => `  - ${s}`).join('\n')}`);
    throw new Error('Claude did not return a valid plan. See details above.');
  }

  if (!validatePlanOutput(plan)) {
    // Claude returned valid JSON but not a plan — check if it's a refusal/explanation
    const summary = typeof (plan as any).epic_summary === 'string' ? (plan as any).epic_summary : '';
    const looksLikeRefusal =
      !(plan as any).milestones &&
      (summary.toLowerCase().includes('unable to') ||
        summary.toLowerCase().includes('cannot') ||
        summary.toLowerCase().includes('need') ||
        summary.toLowerCase().includes('missing') ||
        summary.length > 200);

    if (looksLikeRefusal) {
      console.error('\n❌ Claude was unable to decompose this initiative:');
      console.error(`\n  ${summary}`);
      console.error(`\nSuggestions:\n${suggestions.map((s) => `  - ${s}`).join('\n')}`);
      throw new Error('Initiative lacks sufficient detail for decomposition. See details above.');
    }

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

  // Since Linear has no direct issue→initiative link (only initiative→project),
  // tag every decomposed issue with an `initiative:<slug>` label so users can
  // filter/pivot by initiative even when a project spans multiple initiatives.
  const initiativeLabelName = `initiative:${toKebabCase(initiative.name)}`;
  let initiativeLabelId: string | undefined;
  try {
    const label = await getOrCreateLabel(initiativeLabelName, team.id, {
      description: `Auto-generated by wavemill plan for initiative "${initiative.name}"`,
    });
    initiativeLabelId = label.id;
    console.log(`Initiative label: ${initiativeLabelName}`);
  } catch (error) {
    console.warn(
      `  ⚠ Could not create initiative label "${initiativeLabelName}": ${errorMessage(error)}`
    );
  }

  // Flatten all issues for global index tracking
  const allIssues = plan.milestones.flatMap((m) => m.issues);

  // Describe every issue as data, then let the shared helper create the issues
  // and their `blocks` relations in one place (HOK-3469).
  const specs: IssueCreationSpec[] = plan.milestones.flatMap((milestone) =>
    milestone.issues.map((issue) => ({
      title: issue.title,
      description:
        `${issue.user_story}\n\n${issue.description}\n\n---\n` +
        `**Initiative:** ${initiative.name}\n` +
        `**Milestone:** ${milestone.name}\n` +
        `**Priority:** ${issue.priority}`,
      priority: priorityToNumber(issue.priority),
      milestone: milestone.name,
      ...(initiativeLabelId ? { labelIds: [initiativeLabelId] } : {}),
    })),
  );
  specs.forEach((spec, index) => {
    const dependencies = allIssues[index]?.dependencies ?? [];
    if (dependencies.length > 0) spec.blockedBy = dependencies;
  });

  const { created: createdIssues } = await createIssuesWithDependencies(specs, {
    teamId: team.id,
    projectId: targetProject.id,
    resolveMilestoneId: async (name) => {
      try {
        console.log(`\nCreating milestone: "${name}"...`);
        const milestoneId = await getOrCreateProjectMilestone(targetProject.id, name);
        console.log(`  ✓ Milestone: ${name}`);
        return milestoneId;
      } catch (error) {
        const errorMsg = errorMessage(error);
        console.warn(`  ⚠ Could not create milestone: ${errorMsg}`);
        return undefined;
      }
    },
    log: (message) => console.log(message),
  });

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
