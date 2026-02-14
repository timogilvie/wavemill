#!/usr/bin/env node
// @ts-nocheck
import { getBacklog, getTeams, createIssue, createIssueRelation, getOrCreateProjectMilestone } from '../shared/lib/linear.js';
import dotenv from 'dotenv';
import readline from 'readline';
import { writeFileSync, readFileSync, existsSync } from 'fs';

dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (prompt: string): Promise<string> => {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
};

interface SubIssue {
  title: string;
  description: string;
  dependencies: number[];
  estimate?: number;
  priority?: number;
}

interface DecompositionPlan {
  masterDocumentPath?: string;
  relevantFiles: string[];
  subIssues: SubIssue[];
}

async function selectIssueFromBacklog(projectName?: string): Promise<any> {
  console.log('Fetching backlog items...\n');
  const issues = await getBacklog(projectName);

  if (issues.length === 0) {
    console.log('No backlog issues found.');
    return null;
  }

  console.log('Available backlog issues:');
  issues.forEach((issue, index) => {
    console.log(`\n${index + 1}. ${issue.title}`);
    console.log(`   Project: ${issue.project?.name || 'None'}`);
    console.log(`   Description: ${issue.description?.substring(0, 150) || 'No description'}...`);
  });

  const selection = await question('\nSelect an issue to decompose (number): ');
  const index = parseInt(selection) - 1;

  if (index >= 0 && index < issues.length) {
    return issues[index];
  }

  console.log('Invalid selection.');
  return null;
}

async function createIssuesInLinear(
  parentIssue: any,
  plan: DecompositionPlan,
  teamId: string
): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('CREATING ISSUES IN LINEAR');
  console.log('='.repeat(60));

  const projectId = parentIssue.project?.id;
  const createdIssues: any[] = [];

  // Get or create milestone based on parent issue title
  let milestoneId: string | undefined;
  if (projectId) {
    console.log(`\nCreating/finding milestone: "${parentIssue.title}"...`);
    try {
      milestoneId = await getOrCreateProjectMilestone(projectId, parentIssue.title);
      console.log(`✓ Using milestone: ${parentIssue.title}`);
    } catch (error) {
      console.warn(`⚠ Could not create milestone: ${error.message}`);
    }
  }

  // Check if parent ID is a valid UUID
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const hasValidParentId = parentIssue.id && uuidRegex.test(parentIssue.id);

  if (!hasValidParentId) {
    console.log(`\n⚠ Parent issue ID "${parentIssue.id}" is not a valid UUID`);
    console.log('Creating sub-issues without parent link (they will be standalone issues)');
  }

  // Create all sub-issues first
  console.log('\nCreating sub-issues...');
  for (let i = 0; i < plan.subIssues.length; i++) {
    const subIssue = plan.subIssues[i];

    // Enhance description with context
    const enhancedDescription = `${subIssue.description}

---
**Parent Epic:** ${parentIssue.title}${parentIssue.id ? ` (${parentIssue.id})` : ''}
${plan.masterDocumentPath ? `**Master Document:** ${plan.masterDocumentPath}` : ''}
${plan.relevantFiles.length > 0 ? `**Relevant Files:**
${plan.relevantFiles.map(f => `- \`${f}\``).join('\n')}` : ''}

This is issue ${i + 1} of ${plan.subIssues.length} for the parent epic.`;

    console.log(`  Creating: ${subIssue.title}`);

    const issueData: any = {
      title: subIssue.title,
      description: enhancedDescription,
      teamId,
      projectId,
      priority: subIssue.priority,
      estimate: subIssue.estimate,
      projectMilestoneId: milestoneId
    };

    // Only add parentId if it's a valid UUID
    if (hasValidParentId) {
      issueData.parentId = parentIssue.id;
    }

    const created = await createIssue(issueData);

    createdIssues.push(created);
    console.log(`    ✓ Created: ${created.identifier} - ${created.url}`);
  }

  // Create dependency relationships
  console.log('\nCreating dependency relationships...');
  for (let i = 0; i < plan.subIssues.length; i++) {
    const subIssue = plan.subIssues[i];
    if (subIssue.dependencies && subIssue.dependencies.length > 0) {
      for (const depIndex of subIssue.dependencies) {
        if (depIndex >= 0 && depIndex < createdIssues.length && depIndex !== i) {
          console.log(`  ${createdIssues[i].identifier} blocked by ${createdIssues[depIndex].identifier}`);
          // IMPORTANT: createIssueRelation(A, B, 'blocks') means "A blocks B"
          // Since issue i depends on depIndex, we want "depIndex blocks i"
          await createIssueRelation(
            createdIssues[depIndex].id,  // The dependency (blocker)
            createdIssues[i].id,         // The current issue (blocked)
            'blocks'
          );
        }
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ PLAN DECOMPOSITION COMPLETE');
  console.log('='.repeat(60));
  console.log(`\nParent Issue: ${parentIssue.title}`);
  console.log(`Created ${createdIssues.length} sub-issues:\n`);
  createdIssues.forEach((issue, i) => {
    const deps = plan.subIssues[i].dependencies || [];
    const depStr = deps.length > 0
      ? ` (depends on: ${deps.map(d => createdIssues[d].identifier).join(', ')})`
      : '';
    console.log(`  ${issue.identifier}: ${issue.title}${depStr}`);
    console.log(`    ${issue.url}`);
  });
}

async function main() {
  try {
    const projectName = process.argv[2];
    const mode = process.argv[3]; // 'select' or 'create'

    if (mode === 'create') {
      // Step 2: Read the plan and create issues (NON-INTERACTIVE)
      const requestPath = '/tmp/linear-decomposition-request.json';
      const planPath = '/tmp/linear-decomposition-plan.json';

      if (!existsSync(requestPath) || !existsSync(planPath)) {
        console.error('Missing required files. Run "select" mode first.');
        process.exit(1);
      }

      const request = JSON.parse(readFileSync(requestPath, 'utf-8'));
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

      console.log('='.repeat(60));
      console.log('CREATING ISSUES FROM PLAN (AUTO)');
      console.log('='.repeat(60));

      // Get team ID - AUTO-SELECT
      console.log('\nFetching teams...');
      const teams = await getTeams();

      if (teams.length === 0) {
        console.log('No teams found. Exiting.');
        process.exit(1);
      }

      // Auto-select team: prefer "Hokusai" team, otherwise use first team
      let selectedTeam = teams.find(t => t.name.toLowerCase().includes('hokusai'));
      if (!selectedTeam) {
        selectedTeam = teams[0];
      }

      console.log(`✓ Auto-selected team: ${selectedTeam.name} (${selectedTeam.key})`);
      console.log(`\nCreating ${plan.subIssues.length} sub-issues for: ${request.issue.title}`);

      await createIssuesInLinear(request.issue, plan, selectedTeam.id);
      return;
    }

    // Step 1: Select issue and save request (default mode)
    console.log('='.repeat(60));
    console.log('PLAN DECOMPOSITION WORKFLOW - STEP 1');
    console.log('='.repeat(60));
    console.log('\nSelect a backlog issue to decompose:\n');

    const selectedIssue = await selectIssueFromBacklog(projectName);
    if (!selectedIssue) {
      console.log('No issue selected. Exiting.');
      rl.close();
      process.exit(0);
    }

    console.log(`\n✓ Selected: ${selectedIssue.title}`);

    // Save the request to a file
    const requestPath = '/tmp/linear-decomposition-request.json';
    const request = {
      issue: {
        id: selectedIssue.id,
        title: selectedIssue.title,
        description: selectedIssue.description || 'No description provided',
        projectName: selectedIssue.project?.name || 'None',
        projectId: selectedIssue.project?.id || null
      }
    };

    writeFileSync(requestPath, JSON.stringify(request, null, 2));

    console.log('\n' + '='.repeat(60));
    console.log('✅ REQUEST SAVED');
    console.log('='.repeat(60));
    console.log(`\nRequest saved to: ${requestPath}`);
    console.log('\n📋 Next step: In Claude Code, read the request and generate a decomposition plan.');
    console.log('   Save the plan JSON to: /tmp/linear-decomposition-plan.json');
    console.log('\n   Then run: npx tsx ~/.claude/tools/plan-workflow.ts [project] create');

    rl.close();
  } catch (error) {
    console.error('Error:', error);
    rl.close();
    process.exit(1);
  }
}

main();
