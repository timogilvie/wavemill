#!/usr/bin/env -S npx tsx
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { STATE_LOCK_GUARD } from '../shared/lib/state-lock-guard.ts';
const filename = fileURLToPath(import.meta.url);
if (process.argv[1] === filename) runGuardCli(STATE_LOCK_GUARD, process.argv[2] ?? join(dirname(filename), '..'));
