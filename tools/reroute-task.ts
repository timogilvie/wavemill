#!/usr/bin/env -S npx tsx
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { resolveModelAgent } from '../shared/lib/model-agent-resolution.ts';
import { isChallengerTaskId } from '../shared/lib/task-identity.ts';
import {
  appendRerouteAudit,
  providerForModel,
  readPersistedContract,
  validateContractLaunchable,
  writeChallengeEvidenceInvalid,
  writePersistedContract,
  type ChallengeSide,
  type ExecutionContract,
  type StageRole,
} from '../shared/lib/execution-contract.ts';

const STAGES = new Set(['planning', 'coding', 'review']);
const SIDES = new Set(['primary', 'challenger']);

function stage(value: string | undefined): StageRole {
  if (!value || !STAGES.has(value)) throw new Error('--phase must be planning, coding, or review');
  return value as StageRole;
}

function side(value: string | undefined): ChallengeSide | undefined {
  if (!value) return undefined;
  if (!SIDES.has(value)) throw new Error('--challenge-side must be primary or challenger');
  return value as ChallengeSide;
}

function readStateTask(repoDir: string, taskId: string): { featureDir: string; active: boolean; challengeSide?: ChallengeSide } {
  const statePath = path.join(repoDir, '.wavemill', 'workflow-state.json');
  if (!existsSync(statePath)) throw new Error(`workflow state not found at ${statePath}; pass --feature-dir`);
  const state = JSON.parse(readFileSync(statePath, 'utf-8')) as {
    tasks?: Record<string, {
      worktree?: string;
      slug?: string;
      status?: string;
      phase?: string;
      challengeRole?: string;
    }>;
  };
  const task = state.tasks?.[taskId];
  if (!task) throw new Error(`task ${taskId} not found in workflow state`);
  const featureDir = task.worktree && task.slug ? path.join(task.worktree, 'features', task.slug) : '';
  if (!featureDir) throw new Error(`task ${taskId} has no worktree/slug in workflow state; pass --feature-dir`);
  const taskSide = task.challengeRole === 'primary' || task.challengeRole === 'challenger' ? task.challengeRole : undefined;
  return {
    featureDir,
    active: task.status === 'active' || task.status === 'executing' || task.phase === 'planning' || task.phase === 'coding' || task.phase === 'review',
    ...(taskSide ? { challengeSide: taskSide } : {}),
  };
}

function materialChange(before: ExecutionContract | null, after: ExecutionContract): boolean {
  return !before || before.model !== after.model || before.agent !== after.agent || before.provider !== after.provider;
}

await runTool({
  name: 'reroute-task',
  description: 'Auditably replace a persisted Wavemill execution contract',
  positional: { name: 'task-id', description: 'Task id to reroute', required: true },
  options: {
    phase: { type: 'string', description: 'Phase to reroute: planning, coding, review' },
    model: { type: 'string', description: 'Replacement model' },
    agent: { type: 'string', description: 'Replacement agent' },
    'challenge-side': { type: 'string', description: 'Challenge side: primary or challenger' },
    'feature-dir': { type: 'string', description: 'Feature directory override' },
    repo: { type: 'string', description: 'Repository directory', default: process.cwd() },
    force: { type: 'boolean', description: 'Allow reroute for active tasks' },
  },
  async run({ args, positional }) {
    const taskId = positional[0];
    const phase = stage(args.phase);
    const repoDir = args.repo ?? process.cwd();
    const stateTask = args['feature-dir']
      ? { featureDir: args['feature-dir'], active: false, challengeSide: undefined }
      : readStateTask(repoDir, taskId);
    if (stateTask.active && !args.force) {
      throw new Error(`task ${taskId} is active; retry with --force to reroute anyway`);
    }

    const challengeSide = side(args['challenge-side']) ?? stateTask.challengeSide ?? (isChallengerTaskId(taskId) ? 'challenger' : undefined);
    const beforeRead = readPersistedContract({ featureDir: stateTask.featureDir, stageRole: phase, challengeSide });
    const before = beforeRead.ok ? beforeRead.contract : null;
    if (!before && !args.model) throw new Error(`no existing contract; --model is required to establish one`);

    const model = args.model ?? before!.model;
    let agent = args.agent ?? before?.agent;
    if (!agent) {
      const resolved = resolveModelAgent({ model, phase, repoDir });
      if (!resolved.ok) throw new Error(resolved.diagnostic);
      agent = resolved.agent;
    }
    const after: ExecutionContract = {
      model,
      agent,
      provider: providerForModel(model),
      stageRole: phase,
      challengeSide: challengeSide ?? before?.challengeSide ?? null,
      selectedAt: new Date().toISOString(),
    };

    const validation = validateContractLaunchable({ contract: after, repoDir });
    if (!validation.ok) {
      throw new Error(`${validation.reason}: ${validation.detail}`);
    }

    const changed = materialChange(before, after);
    await writePersistedContract({ featureDir: stateTask.featureDir, contract: after });
    await appendRerouteAudit({ featureDir: stateTask.featureDir, before, after, noop: !changed });
    if (changed && after.challengeSide) {
      await writeChallengeEvidenceInvalid(stateTask.featureDir, 'operator_reroute');
    }

    console.log(JSON.stringify({ ok: true, taskId, phase, changed, before, after }));
  },
});
