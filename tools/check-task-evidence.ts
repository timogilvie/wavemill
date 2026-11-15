import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli } from './lib/source-guard.ts';
import { TASK_EVIDENCE_GUARD } from '../shared/lib/task-evidence-guard.ts';
const filename = fileURLToPath(import.meta.url);
if (process.argv[1] === filename) runGuardCli(TASK_EVIDENCE_GUARD, process.argv[2] ?? join(dirname(filename), '..'));
