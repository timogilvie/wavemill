#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
/**
 * HOK-3315 — thin CLI over the one semantic verdict (deps-drift.ts), so the
 * shell twin (deps-drift.sh) can delegate instead of re-implementing it.
 * Dependency-free: must run with plain `node --experimental-strip-types`
 * before `npm install` has ever completed.
 */
import { checkDepsDrift } from './deps-drift.ts';

const dir = process.argv[2] ?? '.';
const result = checkDepsDrift(dir);
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.status === 'ok' ? 0 : result.status === 'drift' ? 1 : 2);
