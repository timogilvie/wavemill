#!/usr/bin/env -S npx tsx
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { READY_REMEDIATION_DISPOSITION_GUARD } from '../shared/lib/ready-remediation-disposition-guard.ts';
const filename = fileURLToPath(import.meta.url);
if (process.argv[1] === filename) runGuardCli(READY_REMEDIATION_DISPOSITION_GUARD, process.argv[2] ?? join(dirname(filename), '..'));
