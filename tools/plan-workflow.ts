#!/usr/bin/env node
// @ts-nocheck
import { getBacklog, getTeams, createIssue, createIssueRelation } from './linear-tasks.ts';
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

  // Create all sub-issues first
  console.log('\nCreating sub-issues...');
  for (let i = 0; i < plan.subIssues.length; i++) {
    const subIssue = plan.subIssues[i];

    // Enhance description with context
    const enhancedDescription = `${subIssue.description}

---
**Parent Issue:** ${parentIssue.title} (${parentIssue.id})
${plan.masterDocumentPath ? `**Master Document:** ${plan.masterDocumentPath}` : ''}
${plan.relevantFiles.length > 0 ? `**Relevant Files:**
${plan.relevantFiles.map(f => `- \`${f}\``).join('\n')}` : ''}

This is issue ${i + 1} of ${plan.subIssues.length} for the parent epic.`;

    console.log(`  Creating: ${subIssue.title}`);

    const created = await createIssue({
      title: subIssue.title,
      description: enhancedDescription,
      teamId,
      projectId,
      parentId: parentIssue.id,
      priority: subIssue.priority,
      estimate: subIssue.estimate
    });

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
          await createIssueRelation(
            createdIssues[i].id,
            createdIssues[depIndex].id,
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
      // Step 2: Read the plan and create issues
      const requestPath = '/tmp/linear-decomposition-request.json';
      const planPath = '/tmp/linear-decomposition-plan.json';

      if (!existsSync(requestPath) || !existsSync(planPath)) {
        console.error('Missing required files. Run "select" mode first.');
        process.exit(1);
      }

      const request = JSON.parse(readFileSync(requestPath, 'utf-8'));
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

      console.log('='.repeat(60));
      console.log('CREATING ISSUES FROM PLAN');
      console.log('='.repeat(60));

      // Get team ID
      console.log('\nSelect team for issues:');
      const teams = await getTeams();

      if (teams.length === 0) {
        console.log('No teams found. Exiting.');
        rl.close();
        process.exit(1);
      }

      console.log('\nAvailable teams:');
      teams.forEach((team, index) => {
        console.log(`${index + 1}. ${team.name} (${team.key})`);
      });

      const teamSelection = await question('\nSelect team (number): ');
      const teamIndex = parseInt(teamSelection) - 1;

      if (teamIndex < 0 || teamIndex >= teams.length) {
        console.log('Invalid team selection. Exiting.');
        rl.close();
        process.exit(1);
      }

      const selectedTeam = teams[teamIndex];
      console.log(`✓ Selected team: ${selectedTeam.name}`);

      const confirm = await question('\nProceed with creating issues? (y/n): ');

      if (confirm.toLowerCase() !== 'y') {
        console.log('Cancelled. No issues created.');
        rl.close();
        process.exit(0);
      }

      await createIssuesInLinear(request.issue, plan, selectedTeam.id);
      rl.close();
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
