#!/usr/bin/env -S npx tsx

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { planMergeQueueTick } from '../shared/lib/merge-queue.ts';
import type { MergeQueueConfigResolved, MergeQueuePr } from '../shared/lib/merge-queue.ts';
import { readValidTendAttemptFact } from '../shared/lib/tend-attempt-fact.ts';

interface MergeQueueSelectPr extends MergeQueuePr {
  stateDir?: string;
  integrationBaseSha?: string;
}

interface CliInput {
  readyPrs: MergeQueueSelectPr[];
  now: string;
  config: MergeQueueConfigResolved;
}

/** Feed tend's current rebase fact into the planner; fact validity stays in tend-attempt-fact.ts. */
export function enrichReadyPrsWithTendRebaseConflicts(readyPrs: MergeQueueSelectPr[]): MergeQueuePr[] {
  return readyPrs.map((pr) => {
    const { stateDir, integrationBaseSha, ...queuePr } = pr;
    const headSha = queuePr.ci?.headSha;
    if (!stateDir || !headSha) return queuePr;
    const fact = readValidTendAttemptFact(stateDir, { prHeadSha: headSha, integrationBaseSha });
    if (fact?.phase !== 'rebase') return queuePr;
    return { ...queuePr, tendRebaseConflictAt: fact.writtenAt };
  });
}

function readInput(path: string): CliInput {
  const raw = path === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path, 'utf8');
  return JSON.parse(raw) as CliInput;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args[0] !== '--input' || !args[1]) {
    console.error('Usage: merge-queue-select.ts --input <path|->');
    process.exit(1);
  }

  const input = readInput(args[1]);
  const readyPrs = enrichReadyPrsWithTendRebaseConflicts(input.readyPrs);
  console.log(JSON.stringify(planMergeQueueTick({ ...input, readyPrs }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
