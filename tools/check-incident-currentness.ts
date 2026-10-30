#!/usr/bin/env -S npx tsx
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { INCIDENT_CURRENTNESS_GUARD } from '../shared/lib/incident-currentness-guard.ts';
const filename = fileURLToPath(import.meta.url);
if (process.argv[1] === filename) runGuardCli(INCIDENT_CURRENTNESS_GUARD, process.argv[2] ?? join(dirname(filename), '..'));
