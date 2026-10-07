// Coding Arm
// Minimal arm: packet+plan in → tools → completion artifact out

import { Harness, openNodeSqliteStorage, Models, Registry, Settings } from '@earendil-works/pi-durable';
import { createContext, Context } from 'node:async_hooks';
import { NodeExecutionEnv } from '@earendil-works/pi-ai/env/node';

/**
 * Coding arm configuration
 */
export interface CodingArmConfig {
  dbPath: string;
  model: string;
  worktreePath: string;
  taskPacket: any;
  taskPlan: any;
}

/**
 * Run the coding arm - first launch
 */
export async function runCodingArm(config: CodingArmConfig): Promise<void> {
  const ctx = createContext();
  
  // Open SQLite storage
  const storage = await openNodeSqliteStorage(config.dbPath);
  
  // Create harness (would need to import models, registry, env, settings)
  // This is a simplified version - in practice would need full setup
  const harness = await Harness.open(storage, {}, ctx as Context);
  
  // Root the harness
  const root = await harness.root({
    agent: {
      model: config.model,
      cwd: config.worktreePath
    }
  }, ctx as Context);
  
  // Submit the task
  const submission = await root.submit({
    type: 'input',
    content: generateUserPrompt(config.taskPacket, config.taskPlan),
    requestId: 'hok3150:first-run'
  });
  
  // Wait for completion (simplified)
  // await submission.wait();
  console.log('Submission created - would wait for completion in full implementation');
}

/**
 * Resume the coding arm - restart after crash
 */
export async function resumeCodingArm(config: CodingArmConfig): Promise<void> {
  const ctx = createContext();
  
  // Open SQLite storage  
  const storage = await openNodeSqliteStorage(config.dbPath);
  
  // Create harness
  const harness = await Harness.open(storage, {}, ctx as Context);
  
  // Resume the existing submission
  const root = await harness.root({
    agent: { model: config.model, cwd: config.worktreePath }
  }, ctx as Context);
  const submission = await root.resume('hok3150:first-run');
  
  // Wait for completion (simplified)
  // await submission.wait();
  console.log('Resumed submission - would wait for completion in full implementation');
}

/**
 * Generate user prompt from task packet and plan
 */
function generateUserPrompt(taskPacket: any, taskPlan: any): string {
  return `Task: ${taskPacket.title}

Plan:
${taskPlan.steps.map((step: any, i: number) => `${i + 1}. ${step.description}`).join('\n')}

Please implement this task following the plan above.`;
}

/**
 * Check if completion artifact exists
 */
export async function hasCompletionArtifact(worktreePath: string): Promise<boolean> {
  // This would use the production coding-artifacts.ts loader
  // For now, just return false as a placeholder
  return false;
}
