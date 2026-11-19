#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  readPersistedContract,
  serializeContract,
  readValidatedContract,
  writePersistedContract,
  type ChallengeSide,
  type StageContractSpec,
  type StageRole,
} from '../shared/lib/execution-contract.ts';
import type { RouteOverrideInput } from '../shared/lib/route-override-record.ts';

const STAGES = new Set(['planning', 'coding', 'review']);
const SIDES = new Set(['primary', 'challenger']);
const STAGE_BY_SKIP_NAME: Record<string, StageRole> = {
  plan: 'planning', planning: 'planning',
  implementation: 'coding', coding: 'coding',
  review: 'review',
};

function requireStage(value: string | undefined): StageRole {
  if (!value || !STAGES.has(value)) {
    throw new Error(`--stage must be one of: planning, coding, review`);
  }
  return value as StageRole;
}

function parseSide(value: string | undefined): ChallengeSide | undefined {
  if (!value) return undefined;
  if (!SIDES.has(value)) throw new Error(`--challenge-side must be primary or challenger`);
  return value as ChallengeSide;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

await runTool({
  name: 'recovery-contract',
  description: 'Read, validate and write persisted Wavemill execution contracts',
  positional: {
    name: 'command',
    description: 'read, validate, read-and-validate, serialize, write',
    required: true,
  },
  options: {
    'feature-dir': { type: 'string', description: 'Feature directory containing .phase-config.json' },
    stage: { type: 'string', description: 'Stage role: planning, coding, or review' },
    'challenge-side': { type: 'string', description: 'Challenge side: primary or challenger' },
    repo: { type: 'string', description: 'Repository directory for provider/cert checks' },
    planner: { type: 'string', description: 'write: planner model' },
    'plan-depth': { type: 'string', description: 'write: planning depth' },
    coder: { type: 'string', description: 'write: coder model' },
    'code-depth': { type: 'string', description: 'write: coding depth' },
    reviewer: { type: 'string', description: 'write: reviewer model' },
    'review-mode': { type: 'string', description: 'write: review mode' },
    'skip-stages': { type: 'string', description: 'write: comma list of stages to leave untouched (plan,implementation,review)' },
    'keep-selected-at': { type: 'boolean', description: 'write: keep each existing selectedAt' },
    reset: { type: 'boolean', description: 'write: reset each written stage block instead of merging' },
    replace: { type: 'boolean', description: 'write: start from a fresh phase config' },
    'force-model': { type: 'string', description: 'write: forceModel recorded on a --replace write' },
    'override-source': { type: 'string', description: 'write: append a route override from this source (HOK-3363)' },
    'pair-id': { type: 'string', description: 'write: challenge pair id for the route override' },
    side: { type: 'string', description: 'write: challenge side for the route override' },
    reason: { type: 'string', description: 'write: route override reason' },
    json: { type: 'boolean', description: 'Emit JSON' },
  },
  async run({ args, positional }) {
    const command = positional[0];
    const featureDir = args['feature-dir'];
    if (!featureDir) throw new Error('--feature-dir is required');

    if (command === 'write') {
      const skipped = new Set(
        (args['skip-stages'] ?? '').split(',').map((name) => STAGE_BY_SKIP_NAME[name.trim()]).filter(Boolean),
      );
      const challengeSide = parseSide(args['challenge-side']);
      const stages: StageContractSpec[] = [];
      const add = (stageRole: StageRole, model: string | undefined, extra: Record<string, unknown>): void => {
        if (model === undefined || skipped.has(stageRole)) return;
        stages.push({
          stageRole,
          model,
          ...(challengeSide ? { challengeSide } : {}),
          ...(Object.keys(extra).length > 0 ? { extra } : {}),
          ...(args['keep-selected-at'] ? { selectedAt: 'keep' as const } : {}),
          ...(args.reset ? { reset: true } : {}),
        });
      };
      add('planning', args.planner, args['plan-depth'] ? { depth: args['plan-depth'] } : {});
      add('coding', args.coder, args['code-depth'] ? { depth: args['code-depth'] } : {});
      add('review', args.reviewer, args['review-mode'] ? { mode: args['review-mode'] } : {});
      if (stages.length === 0) {
        printJson({ ok: true, stages: {} });
        return;
      }
      const overrideSource = args['override-source'];
      const result = await writePersistedContract({
        featureDir,
        repoDir: args.repo,
        stages,
        ...(args.replace ? { replace: true } : {}),
        ...(args['force-model'] !== undefined ? { forceModel: args['force-model'] || null } : {}),
        ...(overrideSource
          ? {
            routeOverride: {
              source: overrideSource,
              reason: args.reason ?? 'route_write',
              ...(args['pair-id'] ? { pairId: args['pair-id'] } : {}),
              ...(args.side ? { side: args.side } : {}),
            } as RouteOverrideInput,
          }
          : {}),
      });
      const refused = Object.values(result.stages).filter((stage) => stage.refusal);
      printJson({ ok: true, stages: result.stages });
      for (const stage of refused) {
        console.error(stage.refusal?.diagnostic ?? `model ${stage.model} did not resolve`);
      }
      return;
    }

    const stageRole = requireStage(args.stage);
    const challengeSide = parseSide(args['challenge-side']);
    if (command === 'validate' || command === 'read-and-validate') {
      printJson(readValidatedContract({ featureDir, stageRole, challengeSide, repoDir: args.repo }));
      return;
    }
    const read = readPersistedContract({ featureDir, stageRole, challengeSide });

    if (command === 'read') {
      printJson(read);
      return;
    }

    if (command === 'serialize') {
      if (!read.ok) {
        printJson(read);
        return;
      }
      printJson({ ok: true, serialized: serializeContract(read.contract) });
      return;
    }

    throw new Error(`unknown command '${command}'`);
  },
});
