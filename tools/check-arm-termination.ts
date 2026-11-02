#!/usr/bin/env -S npx tsx
/** Preflight guard for the one arm-termination recorder (HOK-3358). */
import { resolve } from 'node:path';
import { runGuardCli } from './lib/source-guard.ts';
import { ARM_TERMINATION_GUARD } from '../shared/lib/arm-termination-guard.ts';

runGuardCli(ARM_TERMINATION_GUARD, resolve(process.argv[2] ?? '.'));
