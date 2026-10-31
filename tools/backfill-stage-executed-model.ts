#!/usr/bin/env -S npx tsx

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { resolveStageExecutedModel, type ResolvedStageExecutedModel } from '../shared/lib/executed-model-resolver.ts';
import {
  executionTruthFields,
  isValidStage,
  type StageExecutionEvidence,
  type StageName,
  type StageResult,
} from '../shared/lib/stage-result.ts';
import { type OwnershipStage } from '../shared/lib/session-ownership.ts';

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
  /** HOK-3369: scan every archived eval artifact dir under this repo. */
  allArchivedUnder?: string;
  /** HOK-3369: scan every live feature dir under this repo (worktrees/*). */
  liveUnder?: string;
  /** HOK-3369: milled repo root, forwarded to the resolver for native streams. */
  repoDir?: string;
}

const STAGES: readonly StageName[] = ['planning', 'coding', 'review'] as const;

/**
 * HOK-3369: archive files use `.<stage>-result.json` on recent runs and the
 * dot-less `<stage>-result.json` on older ones (HOK-3322_c for example).
 */
function existingResultFilename(dir: string, stage: StageName): string | null {
  const dotted = join(dir, `.${stage}-result.json`);
  if (existsSync(dotted)) return dotted;
  const bare = join(dir, `${stage}-result.json`);
  if (existsSync(bare)) return bare;
  return null;
}

function parseJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
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

function deriveTruth(
  result: StageResult,
  resolved: ResolvedStageExecutedModel,
  repoDir?: string,
): { truth: Partial<StageResult>; evidence: StageExecutionEvidence } {
  const truth = executionTruthFields({
    status: result.status,
    existing: result,
    now: new Date().toISOString(),
    repoDir,
    flags: {
      model: result.model ?? '',
      'intended-model': result.intendedModel ?? result.model ?? '',
      'executed-model': resolved.executedModel ?? '',
      'execution-evidence-status': resolved.evidenceStatus,
      'execution-evidence-source': resolved.evidenceSource,
      'execution-evidence-detail': `backfill:session-jsonl; ${resolved.evidenceDetail}`,
    },
  });
  const evidence: StageExecutionEvidence = { ...(truth.executionEvidence as StageExecutionEvidence) };
  if (resolved.providerEvidence) {
    for (const [key, value] of Object.entries(resolved.providerEvidence)) {
      if (value !== undefined && (evidence as Record<string, unknown>)[key] === undefined) {
        (evidence as Record<string, unknown>)[key] = value;
      }
    }
  }
  return { truth, evidence };
}

function processStageFile(input: {
  filePath: string;
  stage: StageName;
  worktreePath?: string;
  branchName?: string;
  repoDir?: string;
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
  if (!input.worktreePath || !input.branchName) {
    return { file: input.filePath, stage: input.stage, action: 'missing-input', applied: false, reason: 'missing_worktree_or_branch' };
  }

  // HOK-3369: one resolver for every harness, reading the ownership record
  // beside the archived stage result (HOK-3328).
  const stateDir = dirname(input.filePath);
  const resolved = resolveStageExecutedModel({
    featureDir: stateDir,
    stage: input.stage as OwnershipStage,
    worktreePath: input.worktreePath,
    branchName: input.branchName,
    repoDir: input.repoDir,
    existing: result,
    agentHint: result.agent,
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

  const { truth, evidence } = deriveTruth(result, resolved, input.repoDir);
  const next: StageResult = {
    ...result,
    ...truth,
    executionEvidence: evidence,
  };
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

function discoverArchivedArtifacts(repoDir: string): string[] {
  const artifactsRoot = join(repoDir, '.wavemill', 'evals', 'artifacts');
  if (!existsSync(artifactsRoot)) return [];
  try {
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    return readdirSync(artifactsRoot)
      .map((name) => join(artifactsRoot, name))
      .filter((path) => {
        try {
          const { statSync } = require('node:fs') as typeof import('node:fs');
          return statSync(path).isDirectory();
        } catch { return false; }
      });
  } catch {
    return [];
  }
}

function discoverLiveFeatureDirs(repoDir: string): string[] {
  const worktreesRoot = join(repoDir, 'worktrees');
  if (!existsSync(worktreesRoot)) return [];
  const found: string[] = [];
  try {
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
    for (const wt of readdirSync(worktreesRoot)) {
      const featuresRoot = join(worktreesRoot, wt, 'features');
      if (!existsSync(featuresRoot)) continue;
      try {
        for (const slug of readdirSync(featuresRoot)) {
          const dir = join(featuresRoot, slug);
          try {
            if (statSync(dir).isDirectory()) found.push(dir);
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch {
    // repo dir unreadable
  }
  return found;
}

export function backfillStageExecutedModel(options: BackfillStageExecutedModelOptions): BackfillStageExecutedModelResult[] {
  const apply = Boolean(options.apply);
  const results: BackfillStageExecutedModelResult[] = [];
  const repoDir = options.repoDir
    ?? process.env.WAVEMILL_MILLED_REPO_DIR
    ?? process.env.REPO_DIR
    ?? undefined;

  const artifactDirs: string[] = [...(options.artifactDirs ?? [])];
  if (options.allArchivedUnder) {
    artifactDirs.push(...discoverArchivedArtifacts(resolve(options.allArchivedUnder)));
  }

  for (const artifactDirRaw of artifactDirs) {
    const artifactDir = resolve(artifactDirRaw);
    const context = artifactContext(artifactDir, options);
    // Prefer the artifact's own repo dir when the caller passed one via
    // --all-archived; otherwise fall back to any explicit --repo-dir / env.
    const perArtifactRepoDir = options.allArchivedUnder
      ? resolve(options.allArchivedUnder)
      : repoDir;
    for (const stage of STAGES) {
      // HOK-2891 / HOK-3369: archive keeps `.<stage>-result.json` on recent
      // runs and the dot-less `<stage>-result.json` on older ones.
      const filePath = existingResultFilename(artifactDir, stage)
        ?? join(artifactDir, `.${stage}-result.json`);
      results.push(processStageFile({
        filePath,
        stage,
        worktreePath: context.worktreePath,
        branchName: context.branchName,
        repoDir: perArtifactRepoDir,
        apply,
      }));
    }
  }

  if (options.liveUnder) {
    for (const featureDir of discoverLiveFeatureDirs(resolve(options.liveUnder))) {
      const worktreePath = resolve(featureDir, '..', '..');
      const branchName = gitBranch(worktreePath) ?? undefined;
      for (const stage of STAGES) {
        const filePath = existingResultFilename(featureDir, stage);
        if (!filePath) continue;
        results.push(processStageFile({
          filePath,
          stage,
          worktreePath,
          branchName,
          repoDir: resolve(options.liveUnder),
          apply,
        }));
      }
    }
  }

  if (options.featureDir && options.stage) {
    const featureDir = resolve(options.featureDir);
    const worktreePath = options.worktree ?? resolve(featureDir, '..', '..');
    const branchName = options.branch ?? gitBranch(worktreePath);
    results.push(processStageFile({
      filePath: existingResultFilename(featureDir, options.stage)
        ?? join(featureDir, `.${options.stage}-result.json`),
      stage: options.stage,
      worktreePath,
      branchName,
      repoDir,
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
  // HOK-3369: per-harness summary. The resolver's reports are per-file, so
  // we count by what we can tell from the file's agent + the resolver's
  // recovered/still-missing split.
  const bucket = (action: BackfillStageExecutedModelResult['action']): 're-derived' | 'still-missing' | 'other' => {
    if (action === 're-derived') return 're-derived';
    if (action === 'no-session-evidence') return 'still-missing';
    return 'other';
  };
  const stageCounts = new Map<StageName, { recovered: number; stillMissing: number }>();
  for (const result of results) {
    const b = bucket(result.action);
    if (b === 'other') continue;
    const entry = stageCounts.get(result.stage) ?? { recovered: 0, stillMissing: 0 };
    if (b === 're-derived') entry.recovered++;
    else entry.stillMissing++;
    stageCounts.set(result.stage, entry);
  }
  if (stageCounts.size > 0) {
    console.log('--- Summary by stage ---');
    for (const [stage, entry] of stageCounts) {
      console.log(`  ${stage}: recovered=${entry.recovered}, still-missing=${entry.stillMissing}`);
    }
  }
  if (apply) {
    console.log(`Applied ${applied}/${changed} re-derived stage result update(s).`);
  } else {
    console.log(`Would apply ${changed} re-derived stage result update(s).`);
  }
}

if (import.meta.main) {
  runTool({
    name: 'backfill-stage-executed-model',
    description: 'Re-derive executedModel for completed stage results (every harness) from retained session JSONL',
    options: {
      'artifact-dir': { type: 'string', multiple: true, description: 'Archived eval artifact directory' },
      'feature-dir': { type: 'string', description: 'Live feature directory' },
      stage: { type: 'string', description: 'Stage for --feature-dir mode' },
      worktree: { type: 'string', description: 'Override worktree path' },
      branch: { type: 'string', description: 'Override branch name' },
      'all-archived': { type: 'string', description: 'Repo root; scan every .wavemill/evals/artifacts/* under it' },
      live: { type: 'string', description: 'Repo root; scan every worktrees/*/features/* under it' },
      'repo-dir': { type: 'string', description: 'Milled repo root for native-session resolution' },
      apply: { type: 'boolean', description: 'Write updates; default is dry-run' },
    },
    examples: [
      'npx tsx tools/backfill-stage-executed-model.ts --artifact-dir .wavemill/evals/artifacts/HOK-2807 --apply',
      'npx tsx tools/backfill-stage-executed-model.ts --feature-dir features/my-task --stage coding',
      'npx tsx tools/backfill-stage-executed-model.ts --all-archived ~/Dropbox/wavemill',
    ],
    run({ args, rawArgv }) {
      const artifactDirs = collectRepeated(rawArgv, 'artifact-dir');
      const stageArg = typeof args.stage === 'string' ? args.stage : undefined;
      const stage = stageArg && isValidStage(stageArg) ? stageArg as StageName : undefined;
      const featureDir = typeof args['feature-dir'] === 'string' ? args['feature-dir'] : undefined;
      const allArchivedUnder = typeof args['all-archived'] === 'string' ? args['all-archived'] : undefined;
      const liveUnder = typeof args.live === 'string' ? args.live : undefined;
      if (featureDir && !stage) {
        throw new Error('--feature-dir requires --stage planning|coding|review|ready');
      }
      if (artifactDirs.length === 0 && !featureDir && !allArchivedUnder && !liveUnder) {
        throw new Error('Required: --artifact-dir, --feature-dir, --all-archived, or --live');
      }
      const results = backfillStageExecutedModel({
        artifactDirs,
        featureDir,
        stage,
        worktree: typeof args.worktree === 'string' ? args.worktree : undefined,
        branch: typeof args.branch === 'string' ? args.branch : undefined,
        apply: Boolean(args.apply),
        allArchivedUnder,
        liveUnder,
        repoDir: typeof args['repo-dir'] === 'string' ? args['repo-dir'] : undefined,
      });
      printResults(results, Boolean(args.apply));
    },
  });
}
