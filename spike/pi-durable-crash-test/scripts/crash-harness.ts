// Crash Harness Script
// Parent: spawn child, wait for crash signal, kill -9, restart, audit

import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const program = new Command();

program
  .option('-p, --point <point>', 'Crash point (A|B|C1|C2|C3)')
  .option('-t, --trials <number>', 'Number of trials', '3')
  .option('--faux', 'Use faux model instead of real model')
  .parse();

async function main() {
  const options = program.opts();
  
  if (!options.point) {
    console.error('Crash point is required');
    process.exit(1);
  }
  
  const validPoints = ['A', 'B', 'C1', 'C2', 'C3'];
  if (!validPoints.includes(options.point)) {
    console.error('Invalid crash point. Valid points:', validPoints.join(', '));
    process.exit(1);
  }
  
  const trials = parseInt(options.trials);
  if (isNaN(trials) || trials <= 0) {
    console.error('Invalid number of trials');
    process.exit(1);
  }
  
  console.log(`Running crash harness for point ${options.point} with ${trials} trials`);
  
  for (let i = 1; i <= trials; i++) {
    console.log(`\n=== Trial ${i} ===`);
    await runTrial(options.point, i, options.faux);
  }
  
  console.log('\nAll trials completed');
}

async function runTrial(point: string, trialNum: number, useFaux: boolean) {
  // Create temporary directory for this trial
  const trialDir = `/tmp/hok3150-trial-${point}-${trialNum}`;
  
  // Spawn child process
  const env = {
    ...process.env,
    HOK3150_CRASH_POINT: point
  };
  
  const args = ['scripts/run-arm.ts'];
  if (useFaux) {
    args.push('--faux');
  }
  
  const child = spawn('npx', args, {
    env,
    cwd: process.cwd(),
    stdio: 'inherit'
  });
  
  console.log('Spawned child process with PID:', child.pid);
  
  // Wait for crash signal file
  const signalFile = join(trialDir, '.crash-ready');
  let crashed = false;
  
  // Poll for signal file
  while (!crashed) {
    try {
      await stat(signalFile);
      crashed = true;
    } catch (err) {
      // File doesn't exist yet, wait and retry
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  // Read the signal file to confirm the crash point
  const signalContent = await readFile(signalFile, 'utf8');
  console.log('Received crash signal for point:', signalContent);
  
  // Kill the child process with SIGKILL
  console.log('Sending SIGKILL to child process');
  child.kill('SIGKILL');
  
  // Wait a bit for the process to terminate
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Restart without crash point
  console.log('Restarting process without crash point');
  const restartArgs = ['scripts/run-arm.ts', '--resume'];
  if (useFaux) {
    restartArgs.push('--faux');
  }
  
  const restartChild = spawn('npx', restartArgs, {
    cwd: process.cwd(),
    stdio: 'inherit'
  });
  
  // Wait for restart to complete
  await new Promise((resolve, reject) => {
    restartChild.on('close', (code) => {
      if (code === 0) {
        resolve(code);
      } else {
        reject(new Error(`Restart process exited with code ${code}`));
      }
    });
  });
  
  console.log('Trial completed successfully');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
