#!/usr/bin/env -S npx tsx

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runTool } from '../shared/lib/tool-runner.ts';
import { resolveExecutedModelFromSessions, type ExecutedModelResolverAgent } from '../shared/lib/executed-model-resolver.ts';
import { executionTruthFields, isValidStage, type StageName, type StageResult } from '../shared/lib/stage-result.ts';

type BackfillAction =
  | 're-derived'
  | 'unchanged'
  | 'no-session-evidence'
  | 'malformed'
  | 'missing-input'
  | 'skipped';

export interface BackfillStageExecutedModelResult {
  file: string;
  stage: StageName;
  action: BackfillAction;
  applied: boolean;
  executedModel?: string;
  reason?: string;
}

export interface BackfillStageExecutedModelOptions {
  artifactDirs?: string[];
  featureDir?: string;
  stage?: StageName;
  worktree?: string;
  branch?: string;
  apply?: boolean;
}

const STAGES: readonly StageName[] = ['planning', 'coding', 'review'] as const;

function parseJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function resolverAgent(value: unknown): ExecutedModelResolverAgent | null {
  return value === 'claude' || value === 'codex' ? value : null;
}

function terminalString(record: unknown, paths: string[][]): string | undefined {
  for (const path of paths) {
    let value: unknown = record;
    for (const key of path) {
      if (!value || typeof value !== 'object') {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[key];
    }
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function gitBranch(worktreePath: string): string | undefined {
  try {
    return execFileSync('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const tempDir = mkdtempSync(join(dirname(filePath), '.tmp-stage-executed-model-'));
  const tempFile = join(tempDir, 'result.json');
  try {
    writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tempFile, filePath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function deriveTruth(result: StageResult, executedModel: string, source: string, detail: string): Partial<StageResult> {
  return executionTruthFields({
    status: result.status,
    existing: result,
    now: new Date().toISOString(),
    flags: {
      model: result.model ?? '',
      'intended-model': result.intendedModel ?? result.model ?? '',
      'executed-model': executedModel,
      'execution-evidence-status': 'direct',
      'execution-evidence-source': source,
      'execution-evidence-detail': `backfill:session-jsonl; ${detail}`,
    },
  });
}

function processStageFile(input: {
  filePath: string;
  stage: StageName;
  worktreePath?: string;
  branchName?: string;
  apply: boolean;
}): BackfillStageExecutedModelResult {
  if (!existsSync(input.filePath)) {
    return { file: input.filePath, stage: input.stage, action: 'missing-input', applied: false };
  }

  const result = parseJsonFile<StageResult>(input.filePath);
  if (!result || result.stage !== input.stage) {
    return { file: input.filePath, stage: input.stage, action: 'malformed', applied: false };
  }
  if (result.status !== 'completed') {
    return { file: input.filePath, stage: input.stage, action: 'skipped', applied: false, reason: 'stage_not_completed' };
  }

  const agent = resolverAgent(result.agent);
  if (!agent) {
    return { file: input.filePath, stage: input.stage, action: 'skipped', applied: false, reason: 'unsupported_agent' };
  }
  if (!input.worktreePath || !input.branchName || !result.startedAt || !result.finishedAt) {
    return { file: input.filePath, stage: input.stage, action: 'missing-input', applied: false, reason: 'missing_worktree_branch_or_window' };
  }

  const resolved = resolveExecutedModelFromSessions({
    worktreePath: input.worktreePath,
    branchName: input.branchName,
    agent,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
  });
  if (!resolved.executedModel || resolved.evidenceStatus !== 'direct') {
    return {
      file: input.filePath,
      stage: input.stage,
      action: 'no-session-evidence',
      applied: false,
      reason: resolved.evidenceDetail,
    };
  }

  const truth = deriveTruth(result, resolved.executedModel, resolved.evidenceSource, resolved.evidenceDetail);
  const next: StageResult = {
    ...result,
    ...truth,
  };
  if (!('modelAttributionIneligibleReason' in truth)) {
    delete next.modelAttributionIneligibleReason;
  }
  if (sameJson(result, next)) {
    return {
      file: input.filePath,
      stage: input.stage,
      action: 'unchanged',
      applied: false,
      executedModel: resolved.executedModel,
    };
  }

  if (input.apply) {
    atomicWriteJson(input.filePath, next);
  }
  return {
    file: input.filePath,
    stage: input.stage,
    action: 're-derived',
    applied: input.apply,
    executedModel: resolved.executedModel,
  };
}

function artifactContext(artifactDir: string, overrides: Pick<BackfillStageExecutedModelOptions, 'worktree' | 'branch'>) {
  const terminal = parseJsonFile<Record<string, unknown>>(join(artifactDir, 'terminal-record.json'));
  const worktreePath = overrides.worktree
    ?? terminalString(terminal, [['worktree'], ['worktreePath'], ['terminal', 'worktree'], ['task', 'worktree'], ['state', 'worktree']]);
  const branchName = overrides.branch
    ?? terminalString(terminal, [['branch'], ['branchName'], ['terminal', 'branch'], ['task', 'branch'], ['state', 'branch']]);
  return { worktreePath, branchName };
}

export function backfillStageExecutedModel(options: BackfillStageExecutedModelOptions): BackfillStageExecutedModelResult[] {
  const apply = Boolean(options.apply);
  const results: BackfillStageExecutedModelResult[] = [];

  for (const artifactDirRaw of options.artifactDirs ?? []) {
    const artifactDir = resolve(artifactDirRaw);
    const context = artifactContext(artifactDir, options);
    for (const stage of STAGES) {
      results.push(processStageFile({
        filePath: join(artifactDir, `${stage}-result.json`),
        stage,
        worktreePath: context.worktreePath,
        branchName: context.branchName,
        apply,
      }));
    }
  }

  if (options.featureDir && options.stage) {
    const featureDir = resolve(options.featureDir);
    const worktreePath = options.worktree ?? resolve(featureDir, '..', '..');
    const branchName = options.branch ?? gitBranch(worktreePath);
    results.push(processStageFile({
      filePath: join(featureDir, `.${options.stage}-result.json`),
      stage: options.stage,
      worktreePath,
      branchName,
      apply,
    }));
  }

  return results;
}

function collectRepeated(rawArgv: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < rawArgv.length; i++) {
    if (rawArgv[i] === `--${name}` && rawArgv[i + 1]) {
      values.push(rawArgv[i + 1]);
      i++;
    }
  }
  return values;
}

function printResults(results: BackfillStageExecutedModelResult[], apply: boolean): void {
  for (const result of results) {
    const prefix = apply ? '[apply]' : '[dry-run]';
    const model = result.executedModel ? ` executedModel=${result.executedModel}` : '';
    const reason = result.reason ? ` reason=${result.reason}` : '';
    console.log(`${prefix} ${result.action} ${result.file}${model}${reason}`);
  }
  const changed = results.filter((result) => result.action === 're-derived').length;
  const applied = results.filter((result) => result.applied).length;
  if (apply) {
    console.log(`Applied ${applied}/${changed} re-derived stage result update(s).`);
  } else {
    console.log(`Would apply ${changed} re-derived stage result update(s).`);
  }
}

if (import.meta.main) {
  runTool({
    name: 'backfill-stage-executed-model',
    description: 'Re-derive executedModel for completed Claude/Codex stage results from retained session JSONL',
    options: {
      'artifact-dir': { type: 'string', multiple: true, description: 'Archived eval artifact directory' },
      'feature-dir': { type: 'string', description: 'Live feature directory' },
      stage: { type: 'string', description: 'Stage for --feature-dir mode' },
      worktree: { type: 'string', description: 'Override worktree path' },
      branch: { type: 'string', description: 'Override branch name' },
      apply: { type: 'boolean', description: 'Write updates; default is dry-run' },
    },
    examples: [
      'npx tsx tools/backfill-stage-executed-model.ts --artifact-dir .wavemill/evals/artifacts/HOK-2807 --apply',
      'npx tsx tools/backfill-stage-executed-model.ts --feature-dir features/my-task --stage coding',
    ],
    run({ args, rawArgv }) {
      const artifactDirs = collectRepeated(rawArgv, 'artifact-dir');
      const stageArg = typeof args.stage === 'string' ? args.stage : undefined;
      const stage = stageArg && isValidStage(stageArg) ? stageArg as StageName : undefined;
      const featureDir = typeof args['feature-dir'] === 'string' ? args['feature-dir'] : undefined;
      if (featureDir && !stage) {
        throw new Error('--feature-dir requires --stage planning|coding|review|ready');
      }
      if (artifactDirs.length === 0 && !featureDir) {
        throw new Error('Required: --artifact-dir or --feature-dir');
      }
      const results = backfillStageExecutedModel({
        artifactDirs,
        featureDir,
        stage,
        worktree: typeof args.worktree === 'string' ? args.worktree : undefined,
        branch: typeof args.branch === 'string' ? args.branch : undefined,
        apply: Boolean(args.apply),
      });
      printResults(results, Boolean(args.apply));
    },
  });
}
