// @ts-nocheck
import { getBacklog, getProjects } from '../shared/lib/linear.js';
import dotenv from 'dotenv';
import readline from 'readline';

// Load environment variables
dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (prompt) => {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
};

async function selectProject() {
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
    console.error('Error in selectProject:', error.message);
    return null;
  }
}

async function displayBacklog(projectName) {
  try {
    const backlog = await getBacklog(projectName);

    if (backlog.length === 0) {
      console.log(`No issues found${projectName ? ` for project "${projectName}"` : ''}.`);
      return;
    }

    // Filter to show only parent issues (issues without a parent)
    const parentIssues = backlog.filter(issue => !issue.parent);

    console.log(`\nBacklog State Items${projectName ? ` for "${projectName}"` : ''} (only showing items in "Backlog" state):`);
    parentIssues.forEach((issue, index) => {
      console.log(`\n${index + 1}. ---`);
      console.log(`Title: ${issue.title}`);
      console.log(`Project: ${issue.project?.name || 'Unknown'}`);
      console.log(`State: ${issue.state?.name || 'Unknown'}`);
      console.log(`Description: ${issue.description || 'No description'}`);
      console.log('Labels:', issue.labels.nodes.map((label) => label.name).join(', ') || 'None');

      // Display child issues if they exist
      if (issue.children?.nodes && issue.children.nodes.length > 0) {
        console.log(`\n   Sub-tasks (${issue.children.nodes.length}):`);
        issue.children.nodes.forEach((child, childIndex) => {
          console.log(`\n   ${index + 1}.${childIndex + 1}. ${child.identifier}: ${child.title}`);
          console.log(`   State: ${child.state?.name || 'Unknown'}`);
          if (child.description) {
            // Show first 100 chars of description
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

async function main() {
  // Get project name from command line argument
  const projectName = process.argv[2];
  
  try {
    if (projectName) {
      // Use the provided project name - no need for readline
      console.log(`Fetching backlog for project: ${projectName}`);
      await displayBacklog(projectName);
      process.exit(0);
    } else {
      // No argument provided, show project selection
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
}

main();
