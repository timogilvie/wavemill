#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { isTaskPacketContent } from '../shared/lib/task-packet-utils.ts';
import { exitOnHelp } from '../shared/lib/tool-runner.ts';

function main(): number {
  exitOnHelp(
    'Usage: npx tsx tools/classify-packet.ts <packet-file>\n'
      + 'Prints "task-packet" (exit 0) or "raw" (exit 1) for the given file.',
  );
  const packetPath = process.argv[2];
  if (!packetPath) {
    console.error('Usage: classify-packet <packet-file>');
    return 2;
  }

  let content = '';
  try {
    content = readFileSync(packetPath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to read packet file: ${message}`);
    return 2;
  }

  if (isTaskPacketContent(content)) {
    console.log('task-packet');
    return 0;
  }

  console.log('raw');
  return 1;
}

process.exit(main());
