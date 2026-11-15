#!/usr/bin/env -S npx tsx
import { exitOnHelp } from '../shared/lib/tool-runner.ts';
import { runControllerCli } from '../shared/lib/task-recovery-controller.ts';
exitOnHelp('task-recovery-controller --state-dir DIR --state-file FILE --evidence-id ID --snapshot FILE | --ack CLAIM');
await runControllerCli();
