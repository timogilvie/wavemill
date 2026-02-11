#!/usr/bin/env node
// @ts-nocheck
import { getBacklog } from './linear-tasks.ts';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const projectName = process.argv[2] || null;

  try {
    const backlog = await getBacklog(projectName);
    console.log(JSON.stringify(backlog, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
