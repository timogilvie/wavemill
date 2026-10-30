#!/usr/bin/env -S node --experimental-strip-types
// HOK-3315: lightweight deps-drift CLI (plain Node, no deps)
import { checkDepsDrift } from '../shared/lib/deps-drift.ts';

const dir = process.argv[2] || '.';
const options: { os?: string; cpu?: string; libc?: string; omit?: string[] } = {};

for (let i = 3; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  const value = process.argv[i + 1];
  if (flag === '--os') options.os = value;
  else if (flag === '--cpu') options.cpu = value;
  else if (flag === '--libc') options.libc = value;
  else if (flag === '--omit') options.omit = value?.split(',');
}

const result = checkDepsDrift(dir, options);
console.log(JSON.stringify(result));
process.exit(result.status === 'ok' ? 0 : result.status === 'drift' ? 1 : 2);
