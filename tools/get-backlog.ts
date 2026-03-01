#!/usr/bin/env -S npx tsx
import '../shared/lib/env.js';
import { runTool } from '../shared/lib/tool-runner.ts';
import { getBacklog, getProjects } from '../shared/lib/linear.js';
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (prompt: string): Promise<string> => {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
};

async function selectProject(): Promise<string | null> {
  try {
    console.log('Fetching available projects...\n');
    const projects = await getProjects();

    if (projects.length === 0) {
      console.log('No projects found.');
      return null;
    }

    console.log('Available projects:');
    projects.forEach((project, index) => {
      console.log(`${index + 1}. ${project.name}${project.description ? ` - ${project.description}` : ''}`);
    });

    const selection = await question('\nSelect a project by number: ');
    const index = parseInt(selection) - 1;

    if (index >= 0 && index < projects.length) {
      return projects[index].name;
    } else {
      console.log('Invalid selection.');
      return null;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error in selectProject:', message);
    return null;
  }
}

async function displayBacklog(projectName: string | null): Promise<void> {
  try {
    const backlog = await getBacklog(projectName);

    if (backlog.length === 0) {
      console.log(`No issues found${projectName ? ` for project "${projectName}"` : ''}.`);
      return;
    }

    const parentIssues = backlog.filter(issue => !issue.parent);

    console.log(`\nBacklog State Items${projectName ? ` for "${projectName}"` : ''} (only showing items in "Backlog" state):`);
    parentIssues.forEach((issue, index) => {
      console.log(`\n${index + 1}. ---`);
      console.log(`Title: ${issue.title}`);
      console.log(`Project: ${issue.project?.name || 'Unknown'}`);
      console.log(`State: ${issue.state?.name || 'Unknown'}`);
      console.log(`Description: ${issue.description || 'No description'}`);
      console.log('Labels:', issue.labels.nodes.map((label) => label.name).join(', ') || 'None');

      if (issue.children?.nodes && issue.children.nodes.length > 0) {
        console.log(`\n   Sub-tasks (${issue.children.nodes.length}):`);
        issue.children.nodes.forEach((child, childIndex) => {
          console.log(`\n   ${index + 1}.${childIndex + 1}. ${child.identifier}: ${child.title}`);
          console.log(`   State: ${child.state?.name || 'Unknown'}`);
          if (child.description) {
            const desc = child.description.length > 100
              ? child.description.substring(0, 100) + '...'
              : child.description;
            console.log(`   Description: ${desc}`);
          }
          console.log('   Labels:', child.labels.nodes.map((label) => label.name).join(', ') || 'None');
        });
      }
    });
  } catch (error) {
    console.error('Error fetching backlog:', error);
  }
}

runTool({
  name: 'get-backlog',
  description: 'Fetch and display Linear backlog (interactive or by project name)',
  options: {
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  positional: {
    name: 'project',
    description: 'Project name (optional, interactive if not provided)',
  },
  examples: [
    'npx tsx tools/get-backlog.ts',
    'npx tsx tools/get-backlog.ts "My Project"',
  ],
  async run({ positional }) {
    const projectName = positional[0];

    try {
      if (projectName) {
        console.log(`Fetching backlog for project: ${projectName}`);
        await displayBacklog(projectName);
      } else {
        const selectedProject = await selectProject();
        if (selectedProject) {
          await displayBacklog(selectedProject);
        }
        rl.close();
      }
    } catch (error) {
      console.error('Error:', error);
      if (!projectName) {
        rl.close();
      }
      process.exit(1);
    }
  },
});
