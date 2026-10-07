#!/usr/bin/env tsx
import { join } from "node:path";

// Run Arm Script
// Child process: open SQLite storage, root(), submit or resume()

import { Command } from 'commander';
import { createFixtureTask } from '../src/fixture-task';
import { runCodingArm, resumeCodingArm, hasCompletionArtifact } from '../src/coding-arm';

const program = new Command();

program
  .option('--faux', 'Use faux model instead of real model')
  .option('--resume', 'Resume from existing database')
  .option('--db-path <path>', 'Path to SQLite database file')
  .parse();

async function main() {
  const options = program.opts();
  
  if (options.faux) {
    console.log('Running with faux model');
    // Implementation for faux model would go here
  }
  
  // Create fixture task
  const { scratchRepoPath, taskPacket, taskPlan } = await createFixtureTask();
  console.log('Created fixture task in:', scratchRepoPath);
  
  // Determine database path
  const dbPath = options.dbPath || join(scratchRepoPath, 'session.sqlite');
  
  if (options.resume) {
    console.log('Resuming from database:', dbPath);
    // Resume coding arm
    await resumeCodingArm({
      dbPath,
      model: 'openrouter:anthropic/claude-3-haiku', // Placeholder
      worktreePath: scratchRepoPath,
      taskPacket,
      taskPlan
    });
  } else {
    console.log('Starting new session with database:', dbPath);
    // Run coding arm
    await runCodingArm({
      dbPath,
      model: 'openrouter:anthropic/claude-3-haiku', // Placeholder
      worktreePath: scratchRepoPath,
      taskPacket,
      taskPlan
    });
  }
  
  // Check for completion artifact
  const hasArtifact = await hasCompletionArtifact(scratchRepoPath);
  console.log('Completion artifact found:', hasArtifact);
  
  console.log('Run completed');
}

main().catch(console.error);
