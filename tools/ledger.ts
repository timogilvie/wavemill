#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { Ledger, type TaskKind, type TaskState, type SettledAs, type SideEffectKind } from '../shared/lib/ledger.ts';

const required = (value: string | undefined, name: string): string => { if (!value) throw new Error(`missing ${name}`); return value; };
const parseJson = (value: string | undefined, name: string): unknown => { try { return value === undefined ? null : JSON.parse(value); } catch { throw new Error(`invalid JSON for ${name}`); } };
runTool({
  name: 'ledger',
  description: 'Inspect and update the durable task ledger.',
  options: {
    'repo-dir': { type: 'string', description: 'Milled repository directory' },
    json: { type: 'boolean', description: 'Print JSON' },
    parent: { type: 'string', description: 'Parent task ID' },
    kind: { type: 'string', description: 'Task or side effect kind' },
    state: { type: 'string', description: 'Task state' },
    as: { type: 'string', description: 'Terminal state' },
    reason: { type: 'string', description: 'Settlement reason' },
    step: { type: 'string', description: 'Step task ID' },
    key: { type: 'string', description: 'Side effect idempotency key' },
    apply: { type: 'boolean', description: 'Mark side effect applied' },
    result: { type: 'string', description: 'JSON result' },
    task: { type: 'string', description: 'Task ID for operator event' },
    payload: { type: 'string', description: 'JSON event payload' },
  },
  examples: [
    'npx tsx tools/ledger.ts list --json',
    'npx tsx tools/ledger.ts inspect <id>',
    'npx tsx tools/ledger.ts transition <id> running',
    'npx tsx tools/ledger.ts settle <id> --as done',
    'npx tsx tools/ledger.ts side-effect record --step <id> --kind git-push --key <key>',
    'npx tsx tools/ledger.ts event abort --task <id>',
  ],
  run({ args, positional }) {
    const [command, arg1, arg2] = positional;
    if (command === 'resume' || (command === 'view' && arg1 === 'workflow-state')) {
      console.error(`not yet implemented: ${command === 'view' ? 'view workflow-state' : command}`);
      process.exitCode = 2;
      return;
    }
    const ledger = Ledger.open({ repoDir: args['repo-dir'] });
    try {
      let output: unknown;
      switch (command) {
        case 'list': output = ledger.listTasks({ parentId: args.parent, kind: args.kind as TaskKind | undefined, state: args.state as TaskState | undefined }); break;
        case 'inspect': {
          const id = required(arg1, 'task id');
          const task = ledger.getTask(id);
          if (!task) throw new Error(`task not found: ${id}`);
          output = { task, waiting_on: ledger.listWaitingOn(id), evidence: ledger.listEvidence(id), side_effects: ledger.listSideEffects(id), operator_events: ledger.listOperatorEvents(id) };
          break;
        }
        case 'transition': ledger.transaction(tx => tx.transitionState(required(arg1, 'task id'), required(arg2, 'state') as Exclude<TaskState, SettledAs>)); output = { id: arg1, state: arg2 }; break;
        case 'settle': ledger.transaction(tx => tx.settleTask(required(arg1, 'task id'), required(args.as, '--as') as SettledAs, args.reason)); output = { id: arg1, settled_as: args.as }; break;
        case 'side-effect': {
          if (arg1 !== 'record') throw new Error('expected side-effect record');
          output = ledger.transaction(tx => {
            const recorded = tx.recordSideEffect({ stepId: required(args.step, '--step'), kind: required(args.kind, '--kind') as SideEffectKind, idempotencyKey: required(args.key, '--key') });
            return { ...recorded, row: args.apply && recorded.isNew ? tx.applySideEffect(recorded.row.id, parseJson(args.result, '--result')) : recorded.row };
          });
          break;
        }
        case 'event': output = ledger.transaction(tx => tx.recordOperatorEvent({ taskId: required(args.task, '--task'), kind: required(arg1, 'event kind'), payload: args.payload === undefined ? undefined : parseJson(args.payload, '--payload') })); break;
        default: throw new Error(`unknown subcommand: ${command ?? '(none)'}`);
      }
      if (args.json) console.log(JSON.stringify(output, null, 2));
      else if (Array.isArray(output)) for (const row of output) console.log(`${row.id}\t${row.kind}\t${row.state}\t${row.slug}`);
      else console.log(JSON.stringify(output));
    } finally { ledger.close(); }
  },
});
