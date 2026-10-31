#!/usr/bin/env -S npx tsx

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { resolveStageExecutedModel } from '../shared/lib/executed-model-resolver.ts';
import { isValidStage, readStageResult, type StageName } from '../shared/lib/stage-result.ts';
import { OWNERSHIP_STAGES, type OwnershipStage } from '../shared/lib/session-ownership.ts';

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

function repoDirFor(worktreePath: string): string | undefined {
  try {
    const commonDir = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return commonDir ? resolve(commonDir, '..') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * HOK-3369: operator wrapper over the one resolver. Nothing in shell calls
 * this any more — the CLI write path resolves in-process. Use this to debug
 * a stage's attribution without rewriting its result file.
 */
runTool({
  name: 'resolve-executed-model',
  description: 'Resolve a stage\'s executed-model evidence from the ownership record and session telemetry (every harness).',
  options: {
    'feature-dir': { type: 'string', description: 'Feature directory containing .<stage>-result.json and .session-ownership.jsonl' },
    stage: { type: 'string', description: 'Stage name: planning, coding, review, or ready' },
    agent: { type: 'string', description: 'Agent hint (legacy fallback: claude | codex | native)' },
    worktree: { type: 'string', description: 'Override worktree path' },
    branch: { type: 'string', description: 'Override git branch name' },
    'repo-dir': { type: 'string', description: 'Milled repo root; defaults to WAVEMILL_MILLED_REPO_DIR / REPO_DIR / the worktree\'s git common dir' },
  },
  examples: [
    'npx tsx tools/resolve-executed-model.ts --feature-dir features/HOK-1234 --stage coding',
  ],
  async run({ args }) {
    const featureDir = typeof args['feature-dir'] === 'string' ? resolve(args['feature-dir']) : undefined;
    const stageArg = typeof args.stage === 'string' ? args.stage : undefined;
    const stage = stageArg && isValidStage(stageArg) ? stageArg as StageName : undefined;
    const existing = featureDir && stage ? await readStageResult({ featureDir, stage }) : null;

    const agentHint = typeof args.agent === 'string'
      ? args.agent
      : existing?.agent ?? undefined;
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
    const repoDir = typeof args['repo-dir'] === 'string'
      ? resolve(args['repo-dir'])
      : (process.env.WAVEMILL_MILLED_REPO_DIR ?? process.env.REPO_DIR ?? (worktreePath ? repoDirFor(worktreePath) : undefined));

    if (!featureDir) throw new Error('Required: --feature-dir (holds the stage\'s .session-ownership.jsonl)');
    if (!stage || !(OWNERSHIP_STAGES as readonly string[]).includes(stage)) {
      throw new Error('Required: --stage planning|coding|review');
    }
    if (!worktreePath) throw new Error('Required: --worktree or --feature-dir');
    if (!branchName) throw new Error('Required: --branch or a git worktree from which branch can be derived');

    const result = resolveStageExecutedModel({
      featureDir,
      stage: stage as OwnershipStage,
      worktreePath,
      branchName,
      repoDir,
      existing,
      agentHint,
    });
    console.log(JSON.stringify(result));
  },
});
