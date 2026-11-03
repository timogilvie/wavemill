#!/usr/bin/env -S npx tsx

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mutateJsonState } from '../shared/lib/state-mutex.ts';
import { errorMessage } from '../shared/lib/error-utils.ts';

function usage(): never {
  console.error('Usage: state mutate <path> --jq <filter>');
  process.exit(2);
}

function parseMutateArgs(argv: string[]): { path: string; jqFilter: string } {
  // allow-command-parse: CLI argv for the `state` tool, unrelated to run_tests parsing (HOK-3383)
  if (argv[0] !== 'mutate') {
    usage();
  }

  const path = argv[1];
  let jqFilter = '';

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--jq') {
      jqFilter = argv[index + 1] ?? '';
      index += 1;
    } else {
      usage();
    }
  }

  if (!path || !jqFilter) {
    usage();
  }

  return { path, jqFilter };
}

function applyJqFilter(current: unknown, jqFilter: string): unknown {
  const result = spawnSync('jq', [jqFilter], {
    input: JSON.stringify(current),
    encoding: 'utf-8',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `jq exited with status ${result.status}`);
  }

  return JSON.parse(result.stdout) as unknown;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  const { path, jqFilter } = parseMutateArgs(process.argv.slice(2));
  try {
    await mutateJsonState<unknown>(path, (current) => applyJqFilter(current, jqFilter));
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }
}
