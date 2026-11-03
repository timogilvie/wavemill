#!/usr/bin/env -S npx tsx
/**
 * Thin CLI wrapper for the single arm-termination recorder
 * (`shared/lib/arm-termination.ts`, HOK-3358).
 *
 * Used by the monitor's `challenge_abort_pair` to replace the inline tail
 * (state stamp + `.challenge-aborted.json` write + reliability record +
 * circuit) with one call. The operator CLI (`tools/abort-task.ts`) calls the
 * recorder directly from TS.
 */
import { fileURLToPath } from 'node:url';
import { runTool, resolveRepoDir, type ParsedArgs } from '../shared/lib/tool-runner.ts';
import {
  recordArmTermination,
  type ArmTerminationActor,
  type ArmTerminationScope,
} from '../shared/lib/arm-termination.ts';

const options = {
  issue: { type: 'string', description: 'Task issue id (e.g. HOK-3315 or HOK-3315_c)' },
  kind: { type: 'string', description: 'Typed arm-failure kind (ArmFailureKind union)' },
  actor: { type: 'string', description: 'Who terminated the arm: operator | monitor | pair-resolver' },
  detail: { type: 'string', description: 'Free-text detail (challengeAbortedDetail)' },
  evidence: { type: 'string', description: 'Path to a stage artifact; required for operator aborts with a model-fault kind' },
  stage: { type: 'string', description: 'Phase string: planning | coding | review | ready | eval' },
  model: { type: 'string', description: 'Executed model id (from the stage result or ownership row)' },
  scope: { type: 'string', description: 'pair (default) stamps the sibling; single stamps only this arm' },
  'next-action': { type: 'string', description: 'Operator-facing hint' },
  'feature-dir': { type: 'string', description: 'Where .challenge-aborted.json is written' },
  'repo-dir': { type: 'string', description: 'Repository root; defaults to cwd' },
  'state-file': { type: 'string', description: 'Workflow state file (default .wavemill/workflow-state.json)' },
  'budget-exhausted-json': { type: 'string', description: 'Budget fact JSON (HOK-3362)' },
  'skip-state-mutation': { type: 'boolean', description: 'Backfill mode: do not touch workflow-state.json' },
} as const;

type CliArgs = ParsedArgs<typeof options>;

function parseActor(value: string | undefined): ArmTerminationActor {
  const trimmed = (value ?? '').trim();
  if (trimmed === 'operator' || trimmed === 'monitor' || trimmed === 'pair-resolver') return trimmed;
  throw new Error(`invalid --actor '${value}': must be operator | monitor | pair-resolver`);
}

function parseScope(value: string | undefined): ArmTerminationScope | undefined {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return undefined;
  if (trimmed === 'pair' || trimmed === 'single') return trimmed;
  throw new Error(`invalid --scope '${value}': must be pair | single`);
}

async function runRecordArmTerminationCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  await runTool({
    name: 'record-arm-termination',
    description: 'Record an arm termination (one entry point for operator/monitor/resolver paths, HOK-3358)',
    options,
    examples: [
      'record-arm-termination --issue HOK-3315 --kind completion-protocol --actor operator --evidence features/<slug>/.coding-complete',
      'record-arm-termination --issue HOK-3315_c --kind ready-exhausted --actor monitor --stage ready --model claude-haiku-4-5 --feature-dir features/<slug>',
    ],
    async run({ args }: { args: CliArgs }): Promise<void> {
      const issue = args.issue;
      const kind = args.kind;
      const actor = parseActor(args.actor);
      if (!issue) throw new Error('--issue is required');
      if (!kind) throw new Error('--kind is required');
      const repoDir = resolveRepoDir(args['repo-dir']);
      const result = await recordArmTermination({
        issueId: issue,
        kind: kind as never,
        actor,
        detail: args.detail,
        evidencePath: args.evidence,
        stage: args.stage,
        model: args.model,
        scope: parseScope(args.scope),
        nextAction: args['next-action'],
        featureDir: args['feature-dir'],
        repoDir,
        stateFile: args['state-file'],
        budgetExhausted: args['budget-exhausted-json'] || null,
        skipStateMutation: Boolean(args['skip-state-mutation']),
      });
      console.log(JSON.stringify({
        issue,
        kind,
        actor,
        abortReason: result.abortReason,
        faultClass: result.faultClass,
        qualitySignalEligible: result.qualitySignalEligible,
        evalRecordId: result.evalRecordId,
        stateMutated: result.stateMutated,
        reliabilityId: result.reliability.id,
        artifact: result.artifact?.path ?? null,
      }));
    },
  }, argv);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  await runRecordArmTerminationCli();
}

export { runRecordArmTerminationCli };
