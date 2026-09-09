import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMillConfig, loadWavemillBaseConfig } from './config.ts';
import { normalizeTaskLifecycle, type ConfigSource, type RemoteBranchDeletionPolicy } from './task-lifecycle.ts';

export type { ConfigSource } from './task-lifecycle.ts';

export interface EffectiveField<T> {
  value: T;
  source: ConfigSource;
  overriddenBy?: ConfigSource;
  driftFromRepoConfig?: T;
}

export interface RuntimeEnvSnapshot {
  issue?: string;
  session?: string;
  runEpoch?: string;
  baseBranch?: string;
  baseBranchSource?: ConfigSource;
  requireConfirm?: boolean;
  requireConfirmSource?: ConfigSource;
  mergeMethod?: string;
  mergeMethodSource?: ConfigSource;
  capturedAt?: string;
}

export interface EffectiveTaskConfig {
  issue: string;
  baseBranch: EffectiveField<string>;
  requireConfirm: EffectiveField<boolean>;
  mergeMethod?: EffectiveField<string>;
  remoteBranchDeletionPolicy?: EffectiveField<RemoteBranchDeletionPolicy>;
}

interface ResolverOptions {
  repoDir: string;
  issue: string;
  stateFile?: string;
  taskState?: Record<string, unknown>;
  runtimeEnvSnapshot?: RuntimeEnvSnapshot | null;
}

const DEFAULT_BASE_BRANCH = 'main';
const DEFAULT_REQUIRE_CONFIRM = true;
const DEFAULT_MERGE_METHOD = 'squash';

function readJsonObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function field<T>(value: T, source: ConfigSource, repoValue?: T): EffectiveField<T> {
  return {
    value,
    source,
    ...(source !== 'repo-config' && repoValue !== undefined && repoValue !== value ? { driftFromRepoConfig: repoValue } : {}),
  };
}

function taskFromState(stateFile: string | undefined, issue: string): Record<string, unknown> {
  const state = stateFile ? readJsonObject(stateFile) : undefined;
  const tasks = state?.tasks;
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) return {};
  const task = (tasks as Record<string, unknown>)[issue];
  return task && typeof task === 'object' && !Array.isArray(task) ? task as Record<string, unknown> : {};
}

function runtimeSnapshotPath(repoDir: string, issue: string): string {
  return join(repoDir, '.wavemill', 'runtime-env', `${issue}.json`);
}

function readRuntimeEnvSnapshot(repoDir: string, issue: string): RuntimeEnvSnapshot | null {
  const parsed = readJsonObject(runtimeSnapshotPath(repoDir, issue));
  if (!parsed) return null;
  return {
    ...(text(parsed.issue) ? { issue: text(parsed.issue) } : {}),
    ...(text(parsed.session) ? { session: text(parsed.session) } : {}),
    ...(text(parsed.runEpoch) ? { runEpoch: text(parsed.runEpoch) } : {}),
    ...(text(parsed.baseBranch) ? { baseBranch: text(parsed.baseBranch), baseBranchSource: 'runtime-env' as const } : {}),
    ...(bool(parsed.requireConfirm) !== undefined ? { requireConfirm: bool(parsed.requireConfirm), requireConfirmSource: 'runtime-env' as const } : {}),
    ...(text(parsed.mergeMethod) ? { mergeMethod: text(parsed.mergeMethod), mergeMethodSource: 'runtime-env' as const } : {}),
    ...(text(parsed.capturedAt) ? { capturedAt: text(parsed.capturedAt) } : {}),
  };
}

function userMillConfig(): { baseBranch?: string; requireConfirm?: boolean } {
  const userConfig = readJsonObject(join(process.env.HOME ?? '', '.wavemill', 'config.json'));
  const mill = userConfig?.mill;
  if (!mill || typeof mill !== 'object' || Array.isArray(mill)) return {};
  return {
    ...(text((mill as Record<string, unknown>).baseBranch) ? { baseBranch: text((mill as Record<string, unknown>).baseBranch) } : {}),
    ...(bool((mill as Record<string, unknown>).requireConfirm) !== undefined ? { requireConfirm: bool((mill as Record<string, unknown>).requireConfirm) } : {}),
  };
}

function repoMillConfig(repoDir: string): { baseBranch?: string; requireConfirm?: boolean } {
  try {
    const config = loadWavemillBaseConfig(repoDir);
    const baseConfig = config.mill ?? {};
    const integrationBranch = text(config.integration?.integrationBranch);
    return {
      ...(text(baseConfig.baseBranch) ? { baseBranch: baseConfig.baseBranch } : integrationBranch ? { baseBranch: integrationBranch } : {}),
      ...(typeof baseConfig.requireConfirm === 'boolean' ? { requireConfirm: baseConfig.requireConfirm } : {}),
    };
  } catch {
    try {
      const mill = getMillConfig(repoDir);
      return {
        ...(text(mill.baseBranch) ? { baseBranch: mill.baseBranch } : {}),
        ...(typeof mill.requireConfirm === 'boolean' ? { requireConfirm: mill.requireConfirm } : {}),
      };
    } catch {
      return {};
    }
  }
}

function mergeMethodFromConfig(repoDir: string): string | undefined {
  try {
    const config = loadWavemillBaseConfig(repoDir);
    return text(config.integration?.mergeMethod);
  } catch {
    return undefined;
  }
}

export function resolveEffectiveTaskConfig(opts: ResolverOptions): EffectiveTaskConfig {
  const stateFile = opts.stateFile ?? join(opts.repoDir, '.wavemill', 'workflow-state.json');
  const task = opts.taskState ?? taskFromState(stateFile, opts.issue);
  const normalized = normalizeTaskLifecycle(task);
  const contract = process.env.WAVEMILL_EFFECTIVE_CONFIG_LEGACY === '1'
    ? undefined
    : normalized.lifecycle.launchContract;
  const runtime = opts.runtimeEnvSnapshot === undefined ? readRuntimeEnvSnapshot(opts.repoDir, opts.issue) : opts.runtimeEnvSnapshot;
  const user = userMillConfig();
  const repo = repoMillConfig(opts.repoDir);
  const repoMergeMethod = mergeMethodFromConfig(opts.repoDir);

  const baseBranch = contract?.baseBranch
    ? field(contract.baseBranch, contract.provenance?.baseBranch ?? 'launch-contract', repo.baseBranch)
    : runtime?.baseBranch
      ? field(runtime.baseBranch, runtime.baseBranchSource ?? 'runtime-env', repo.baseBranch)
      : user.baseBranch
        ? field(user.baseBranch, 'user-config', repo.baseBranch)
        : repo.baseBranch
          ? field(repo.baseBranch, 'repo-config', repo.baseBranch)
          : field(DEFAULT_BASE_BRANCH, 'default', repo.baseBranch);

  const requireConfirm = contract?.requireConfirm !== undefined
    ? field(contract.requireConfirm, contract.provenance?.requireConfirm ?? 'launch-contract', repo.requireConfirm)
    : runtime?.requireConfirm !== undefined
      ? field(runtime.requireConfirm, runtime.requireConfirmSource ?? 'runtime-env', repo.requireConfirm)
      : user.requireConfirm !== undefined
        ? field(user.requireConfirm, 'user-config', repo.requireConfirm)
        : repo.requireConfirm !== undefined
          ? field(repo.requireConfirm, 'repo-config', repo.requireConfirm)
          : field(DEFAULT_REQUIRE_CONFIRM, 'default', repo.requireConfirm);

  const mergeMethod = contract?.mergeMethod
    ? field(contract.mergeMethod, contract.provenance?.mergeMethod ?? 'launch-contract', repoMergeMethod)
    : runtime?.mergeMethod
      ? field(runtime.mergeMethod, runtime.mergeMethodSource ?? 'runtime-env', repoMergeMethod)
      : repoMergeMethod
        ? field(repoMergeMethod, 'repo-config', repoMergeMethod)
        : field(DEFAULT_MERGE_METHOD, 'default', repoMergeMethod);

  return {
    issue: opts.issue,
    baseBranch,
    requireConfirm,
    mergeMethod,
    ...(contract?.remoteBranchDeletionPolicy
      ? {
        remoteBranchDeletionPolicy: field(
          contract.remoteBranchDeletionPolicy,
          contract.provenance?.remoteBranchDeletionPolicy ?? 'launch-contract',
        ),
      }
      : {}),
  };
}

export function runtimeEnvSnapshotForTask(input: {
  issue: string;
  session?: string;
  runEpoch?: string;
  baseBranch?: string;
  requireConfirm?: boolean;
  mergeMethod?: string;
  capturedAt?: string;
}): RuntimeEnvSnapshot {
  return {
    issue: input.issue,
    ...(input.session ? { session: input.session } : {}),
    ...(input.runEpoch ? { runEpoch: input.runEpoch } : {}),
    ...(input.baseBranch ? { baseBranch: input.baseBranch, baseBranchSource: 'runtime-env' } : {}),
    ...(input.requireConfirm !== undefined ? { requireConfirm: input.requireConfirm, requireConfirmSource: 'runtime-env' } : {}),
    ...(input.mergeMethod ? { mergeMethod: input.mergeMethod, mergeMethodSource: 'runtime-env' } : {}),
    capturedAt: input.capturedAt ?? new Date().toISOString(),
  };
}
