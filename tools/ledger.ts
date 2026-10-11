#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { Ledger, type TaskKind, type TaskState, type SettledAs, type SideEffectKind } from '../shared/lib/ledger.ts';
import {
  canonicalConditionJson,
  clearWaitingOnFromMarker,
  computeStepInputsHash,
  findActiveStep,
  markRetryExhausted,
  parseWaitingTrigger,
  recordAgentEvidence,
  recordRetryAttempt,
  settleStep,
  setWaitingOnFromMarker,
  stepInputsFromCliArgs,
  upsertStep,
  withShadowSuppressing,
  ensurePair,
  ensureArm,
  settleArmAbort,
  readPairIntent,
  readPairIntentWithFallback,
  type StepKind,
} from '../shared/lib/ledger-shadow.ts';
import { runConsistencyCheck, appendConsistencyLog } from '../shared/lib/ledger-consistency.ts';
import { attemptPairAbortWalk } from '../shared/lib/ledger-pair-abort.ts';

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
    issue: { type: 'string', description: 'Linear issue key (step shadow commands)' },
    head: { type: 'string', description: 'Head SHA for step inputs' },
    base: { type: 'string', description: 'Base SHA for step inputs' },
    pr: { type: 'string', description: 'PR number for step inputs' },
    pair: { type: 'string', description: 'Challenge pair ID for eval step' },
    side: { type: 'string', description: 'primary|challenger (eval step)' },
    prompt: { type: 'string', description: 'Prompt identity hash or key' },
    owner: { type: 'string', description: 'Step owner identifier' },
    'next-action': { type: 'string', description: 'Next-action hint for step' },
    deadline: { type: 'string', description: 'ISO deadline for step' },
    'max-attempts': { type: 'string', description: 'Max attempts for step retry bucket' },
    id: { type: 'string', description: 'Target step/task id for shadow commands' },
    bucket: { type: 'string', description: 'Retry bucket name' },
    event: { type: 'string', description: 'Evidence event name' },
    detail: { type: 'string', description: 'Evidence detail' },
    trigger: { type: 'string', description: 'Waiting-on trigger (HOK-3172)' },
    condition: { type: 'string', description: 'JSON condition for waiting-on' },
    'recheck-after': { type: 'string', description: 'ISO recheckAfter for waiting-on' },
    'state-dir': { type: 'string', description: 'State directory for consistency check' },
    'hook-file': { type: 'string', description: 'Override hook file path' },
    'session-id': { type: 'string', description: 'Override session id (hook file resolver)' },
    'evidence-window-ms': { type: 'string', description: 'Window for agent-hook evidence check' },
    strict: { type: 'boolean', description: 'Fail with non-zero exit on shadow error (default: swallow)' },
    intent: { type: 'string', description: 'JSON execution intent for pair/arm' },
    role: { type: 'string', description: 'Arm role (primary|challenger)' },
    'arm-local': { type: 'string', description: 'JSON local arm intent for compat shim' },
  },
  examples: [
    'npx tsx tools/ledger.ts list --json',
    'npx tsx tools/ledger.ts inspect <id>',
    'npx tsx tools/ledger.ts transition <id> running',
    'npx tsx tools/ledger.ts settle <id> --as done',
    'npx tsx tools/ledger.ts side-effect record --step <id> --kind git-push --key <key>',
    'npx tsx tools/ledger.ts event abort --task <id>',
    'npx tsx tools/ledger.ts step-upsert --issue HOK-1234 --kind review --head abc1 --base def2',
    'npx tsx tools/ledger.ts step-settle --id <step-id> --as done',
    'npx tsx tools/ledger.ts retry-attempt --id <step-id>',
    'npx tsx tools/ledger.ts retry-exhaust --id <step-id> --bucket review-infra-recovery',
    'npx tsx tools/ledger.ts waiting-on-set --id <id> --trigger head --condition \'{"head":"abc1"}\'',
    'npx tsx tools/ledger.ts waiting-on-clear --id <id> --trigger head',
    'npx tsx tools/ledger.ts evidence-insert --issue HOK-1234 --event Stop',
    'npx tsx tools/ledger.ts check-consistency --issue HOK-1234 --state-dir /path/to/state',
    'npx tsx tools/ledger.ts pair-ensure --pair HOK-1234 --intent \'{"stage":"review"}\'',
    'npx tsx tools/ledger.ts arm-ensure --pair HOK-1234 --issue HOK-1234 --role primary',
    'npx tsx tools/ledger.ts arm-settle-abort --id <arm-id> --reason sibling-stalled',
    'npx tsx tools/ledger.ts pair-walk --pair HOK-1234',
    'npx tsx tools/ledger.ts pair-intent-read --pair HOK-1234',
  ],
  run({ args, positional }) {
    const [command, arg1, arg2] = positional;
    if (command === 'resume' || (command === 'view' && arg1 === 'workflow-state')) {
      console.error(`not yet implemented: ${command === 'view' ? 'view workflow-state' : command}`);
      process.exitCode = 2;
      return;
    }
    const strict = args.strict === true;
    const shadowCommands = new Set([
      'step-upsert',
      'step-settle',
      'retry-attempt',
      'retry-exhaust',
      'waiting-on-set',
      'waiting-on-clear',
      'evidence-insert',
      'check-consistency',
      'pair-ensure',
      'arm-ensure',
      'arm-settle-abort',
      'pair-walk',
      'pair-intent-read',
    ]);
    const isShadow = shadowCommands.has(command ?? '');
    const runImpl = (): unknown => {
      const ledger = Ledger.open({ repoDir: args['repo-dir'] });
      try {
        switch (command) {
          case 'list':
            return ledger.listTasks({ parentId: args.parent, kind: args.kind as TaskKind | undefined, state: args.state as TaskState | undefined });
          case 'inspect': {
            const id = required(arg1, 'task id');
            const task = ledger.getTask(id);
            if (!task) throw new Error(`task not found: ${id}`);
            return { task, waiting_on: ledger.listWaitingOn(id), evidence: ledger.listEvidence(id), side_effects: ledger.listSideEffects(id), operator_events: ledger.listOperatorEvents(id) };
          }
          case 'transition':
            ledger.transaction((tx) => tx.transitionState(required(arg1, 'task id'), required(arg2, 'state') as Exclude<TaskState, SettledAs>));
            return { id: arg1, state: arg2 };
          case 'settle':
            ledger.transaction((tx) => tx.settleTask(required(arg1, 'task id'), required(args.as, '--as') as SettledAs, args.reason));
            return { id: arg1, settled_as: args.as };
          case 'side-effect': {
            if (arg1 !== 'record') throw new Error('expected side-effect record');
            return ledger.transaction((tx) => {
              const recorded = tx.recordSideEffect({ stepId: required(args.step, '--step'), kind: required(args.kind, '--kind') as SideEffectKind, idempotencyKey: required(args.key, '--key') });
              return { ...recorded, row: args.apply && recorded.isNew ? tx.applySideEffect(recorded.row.id, parseJson(args.result, '--result')) : recorded.row };
            });
          }
          case 'event':
            return ledger.transaction((tx) => tx.recordOperatorEvent({ taskId: required(args.task, '--task'), kind: required(arg1, 'event kind'), payload: args.payload === undefined ? undefined : parseJson(args.payload, '--payload') }));
          case 'step-upsert': {
            const kind = required(args.kind, '--kind') as StepKind;
            if (!['review', 'ready', 'eval'].includes(kind)) throw new Error(`invalid --kind for step-upsert: ${kind}`);
            const issueKey = required(args.issue, '--issue');
            const inputsHash = computeStepInputsHash(stepInputsFromCliArgs({
              head: args.head, base: args.base, pr: args.pr, pair: args.pair, side: args.side, prompt: args.prompt,
            }));
            const maxAttempts = args['max-attempts'] ? Number.parseInt(args['max-attempts'], 10) : undefined;
            return upsertStep(ledger, {
              issueKey,
              kind,
              inputsHash,
              owner: args.owner,
              nextAction: args['next-action'],
              deadline: args.deadline,
              maxAttempts: Number.isFinite(maxAttempts) ? maxAttempts : undefined,
            });
          }
          case 'step-settle': {
            const stepId = required(args.id, '--id');
            const as = required(args.as, '--as') as SettledAs;
            settleStep(ledger, stepId, as, args.reason);
            return { id: stepId, settled_as: as };
          }
          case 'retry-attempt': {
            const stepId = required(args.id, '--id');
            const attempt = recordRetryAttempt(ledger, stepId);
            return { id: stepId, attempt };
          }
          case 'retry-exhaust': {
            const stepId = required(args.id, '--id');
            const bucket = required(args.bucket, '--bucket');
            markRetryExhausted(ledger, stepId, bucket, args.reason);
            return { id: stepId, bucket, settled_as: 'aborted' };
          }
          case 'waiting-on-set': {
            const id = required(args.id, '--id');
            const trigger = parseWaitingTrigger(required(args.trigger, '--trigger'));
            const condition = parseJson(args.condition ?? '{}', '--condition');
            setWaitingOnFromMarker(ledger, id, trigger, condition, args['recheck-after']);
            return { id, trigger, condition_hash: canonicalConditionJson(condition) };
          }
          case 'waiting-on-clear': {
            const id = required(args.id, '--id');
            const trigger = args.trigger ? parseWaitingTrigger(args.trigger) : undefined;
            clearWaitingOnFromMarker(ledger, id, trigger);
            return { id, trigger: trigger ?? null };
          }
          case 'evidence-insert': {
            const issueKey = required(args.issue, '--issue');
            const event = required(args.event, '--event');
            const result = recordAgentEvidence(ledger, issueKey, event, args.detail);
            return result ?? { skipped: 'no active step' };
          }
          case 'check-consistency': {
            const stateDir = required(args['state-dir'], '--state-dir');
            const issue = required(args.issue, '--issue');
            const evidenceWindowMs = args['evidence-window-ms']
              ? Number.parseInt(args['evidence-window-ms'], 10)
              : undefined;
            const result = runConsistencyCheck({
              stateDir,
              issue,
              ledger,
              hookFilePath: args['hook-file'],
              sessionId: args['session-id'],
              evidenceWindowMs: Number.isFinite(evidenceWindowMs) ? evidenceWindowMs : undefined,
            });
            appendConsistencyLog(stateDir, result);
            return result;
          }
          case 'pair-ensure': {
            const pairId = required(args.pair, '--pair');
            const intent = args.intent ? parseJson(args.intent, '--intent') : undefined;
            const row = ensurePair(ledger, pairId, intent);
            return { id: row.id, slug: row.slug, kind: row.kind };
          }
          case 'arm-ensure': {
            const pairId = required(args.pair, '--pair');
            const issueKey = required(args.issue, '--issue');
            const role = required(args.role, '--role');
            if (role !== 'primary' && role !== 'challenger') {
              throw new Error(`invalid --role: ${role} (expected primary|challenger)`);
            }
            const intent = args.intent ? parseJson(args.intent, '--intent') : undefined;
            const row = ensureArm(ledger, pairId, issueKey, role, intent);
            return { id: row.id, slug: row.slug, kind: row.kind, parent_id: row.parent_id, owner: row.owner };
          }
          case 'arm-settle-abort': {
            const armId = required(args.id, '--id');
            const reason = required(args.reason, '--reason');
            settleArmAbort(ledger, armId, reason);
            return { id: armId, settled_as: 'aborted', settled_reason: reason };
          }
          case 'pair-walk': {
            const pairId = required(args.pair, '--pair');
            const result = attemptPairAbortWalk(ledger, pairId);
            return result;
          }
          case 'pair-intent-read': {
            const pairId = required(args.pair, '--pair');
            const armLocal = args['arm-local'] ? parseJson(args['arm-local'], '--arm-local') : undefined;
            const intent = readPairIntentWithFallback(ledger, pairId, armLocal);
            return { pairId, intent };
          }
          default:
            throw new Error(`unknown subcommand: ${command ?? '(none)'}`);
        }
      } finally {
        ledger.close();
      }
    };
    let output: unknown;
    if (isShadow && !strict) {
      output = withShadowSuppressing(runImpl);
      if (output === null) {
        if (args.json) console.log(JSON.stringify({ shadow: 'suppressed' }));
        return;
      }
    } else {
      output = runImpl();
    }
    if (args.json) console.log(JSON.stringify(output, null, 2));
    else if (Array.isArray(output)) for (const row of output as Array<Record<string, unknown>>) console.log(`${row.id}\t${row.kind}\t${row.state}\t${row.slug}`);
    else console.log(JSON.stringify(output));
  },
});
