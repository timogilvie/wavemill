#!/usr/bin/env -S npx tsx

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { resolveExecutedModelFromSessions, type ExecutedModelResolverAgent } from '../shared/lib/executed-model-resolver.ts';
import { isValidStage, readStageResult, type StageName } from '../shared/lib/stage-result.ts';

function resolverAgent(value: unknown): ExecutedModelResolverAgent | null {
  return value === 'claude' || value === 'codex' ? value : null;
}

function gitBranch(worktreePath: string): string | null {
  try {
    return execFileSync('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

runTool({
  name: 'resolve-executed-model',
  description: 'Resolve Claude/Codex executed model evidence from session telemetry for a stage window',
  options: {
    'feature-dir': { type: 'string', description: 'Feature directory containing .<stage>-result.json' },
    stage: { type: 'string', description: 'Stage name: planning, coding, review, or ready' },
    agent: { type: 'string', description: 'Override agent: claude or codex' },
    worktree: { type: 'string', description: 'Override worktree path' },
    branch: { type: 'string', description: 'Override git branch name' },
    'started-at': { type: 'string', description: 'Override stage start timestamp' },
    'finished-at': { type: 'string', description: 'Override stage finish timestamp' },
  },
  examples: [
    'npx tsx tools/resolve-executed-model.ts --feature-dir features/HOK-1234 --stage coding --finished-at 2026-09-15T12:00:00Z',
  ],
  async run({ args }) {
    const featureDir = typeof args['feature-dir'] === 'string' ? resolve(args['feature-dir']) : undefined;
    const stageArg = typeof args.stage === 'string' ? args.stage : undefined;
    const stage = stageArg && isValidStage(stageArg) ? stageArg as StageName : undefined;
    const existing = featureDir && stage ? await readStageResult(featureDir, stage) : null;

    const agent = resolverAgent(args.agent) ?? resolverAgent(existing?.agent);
    const worktreePath = typeof args.worktree === 'string'
      ? resolve(args.worktree)
      : featureDir
        ? resolve(featureDir, '..', '..')
        : undefined;
    const branchName = typeof args.branch === 'string'
      ? args.branch
      : worktreePath
        ? gitBranch(worktreePath)
        : null;
    const startedAt = typeof args['started-at'] === 'string' ? args['started-at'] : existing?.startedAt;
    const finishedAt = typeof args['finished-at'] === 'string' ? args['finished-at'] : existing?.finishedAt ?? undefined;

    if (!agent) throw new Error('Required: --agent claude|codex or a stage result with agent claude|codex');
    if (!worktreePath) throw new Error('Required: --worktree or --feature-dir');
    if (!branchName) throw new Error('Required: --branch or a git worktree from which branch can be derived');
    if (!startedAt || !finishedAt) throw new Error('Required: --started-at/--finished-at or a stage result with both timestamps');

    const result = resolveExecutedModelFromSessions({
      worktreePath,
      branchName,
      agent,
      startedAt,
      finishedAt,
    });
    console.log(JSON.stringify(result));
  },
});
