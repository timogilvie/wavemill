#!/usr/bin/env -S npx tsx

import { publishReadyHandoff, recordHandoffFailure, type HandoffFailureStage } from './ready-tend-handoff.ts';

const args = process.argv.slice(2);
const command = args[0];

function getArg(name: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return '';
  return args[idx + 1];
}

async function main(): Promise<void> {
  if (command === 'publish') {
    const stateDir = getArg('state-dir');
    const pr = Number(getArg('pr'));
    const head = getArg('head');
    if (!stateDir || !pr || !head) {
      process.exit(1);
    }
    await publishReadyHandoff(stateDir, pr, head);
  } else if (command === 'record-failure') {
    const stateDir = getArg('state-dir');
    const stage = getArg('stage') as HandoffFailureStage;
    const diagnostic = getArg('diagnostic');
    if (!stateDir || !stage) {
      process.exit(1);
    }
    await recordHandoffFailure(stateDir, stage, diagnostic);
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

main().catch(() => process.exit(1));
