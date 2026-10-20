#!/usr/bin/env node
/**
 * CLI entry for the related-test selector. Takes a list of changed files as
 * `--files <path>` arguments (newline-separated via `--files-from <path>`
 * works too), returns the selected test plan as JSON.
 *
 * Invoked by `tests/run-related.sh` through `npx tsx`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { selectRelatedTests } from './select-core.ts';

interface Args {
  repoRoot: string;
  changedPaths: string[];
  noJourneys: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let repoRoot = process.cwd();
  const changedPaths: string[] = [];
  let noJourneys = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === '--repo-root') {
      repoRoot = argv[++i] ?? repoRoot;
    } else if (token === '--files-from') {
      const file = argv[++i];
      if (file) {
        const content = readFileSync(file, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) changedPaths.push(trimmed);
        }
      }
    } else if (token === '--no-journeys') {
      noJourneys = true;
    } else if (token.startsWith('--')) {
      throw new Error(`unknown argument: ${token}`);
    } else {
      changedPaths.push(token);
    }
  }
  return { repoRoot: path.resolve(repoRoot), changedPaths, noJourneys };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const plan = selectRelatedTests({
    repoRoot: args.repoRoot,
    changedPaths: args.changedPaths,
    noJourneys: args.noJourneys,
  });
  process.stdout.write(JSON.stringify(plan) + '\n');
}

try {
  main();
} catch (err) {
  process.stderr.write(`[run-related:select] error: ${(err as Error).message}\n`);
  process.exit(2);
}
