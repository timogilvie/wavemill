// Fixture Task
// Builds the scratch repo + seed task (packet, plan) in mkdtemp

import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Create a fixture task in a temporary directory
 * @returns Path to the scratch repository and task details
 */
export async function createFixtureTask(): Promise<{
  scratchRepoPath: string;
  taskPacket: any;
  taskPlan: any;
}> {
  // Create temporary directory
  const scratchRepoPath = await mkdtemp(join(tmpdir(), 'hok3150-fixtures-'));
  
  // Create basic project structure
  await mkdir(join(scratchRepoPath, 'src'), { recursive: true });
  await mkdir(join(scratchRepoPath, 'test'), { recursive: true });
  
  // Create sample files
  await writeFile(
    join(scratchRepoPath, 'src', 'a.ts'),
    `// Module A
export function hello(name: string): string {
  return `Hello, ${name}!`;
}
`
  );
  
  await writeFile(
    join(scratchRepoPath, 'src', 'index.ts'),
    `// Entry point
export { hello } from './a';
`
  );
  
  await writeFile(
    join(scratchRepoPath, 'test', 'a.test.ts'),
    `// Test file
import { hello } from '../src/a';

test('hello should return greeting', () => {
  expect(hello('world')).toBe('Hello, world!');
});
`
  );
  
  // Create task packet
  const taskPacket = {
    title: 'Add function X in a.ts, export it from index.ts, add a test in a.test.ts',
    description: 'Create a new function X in a.ts, export it from index.ts, and add a corresponding test.',
    slug: 'hok3150-fixture-task'
  };
  
  // Create task plan
  const taskPlan = {
    steps: [
      {
        description: 'Add function X to src/a.ts',
        file: 'src/a.ts'
      },
      {
        description: 'Export function X from src/index.ts',
        file: 'src/index.ts'
      },
      {
        description: 'Add test for function X in test/a.test.ts',
        file: 'test/a.test.ts'
      },
      {
        description: 'Run tests to verify implementation',
        file: null
      }
    ]
  };
  
  // Write packet and plan to features directory like the mill does
  const featureDir = join(scratchRepoPath, 'features', taskPacket.slug);
  await mkdir(featureDir, { recursive: true });
  
  await writeFile(
    join(featureDir, 'task-packet.json'),
    JSON.stringify(taskPacket, null, 2)
  );
  
  await writeFile(
    join(featureDir, 'plan.json'),
    JSON.stringify(taskPlan, null, 2)
  );
  
  return {
    scratchRepoPath,
    taskPacket,
    taskPlan
  };
}
