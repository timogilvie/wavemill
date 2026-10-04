/**
 * Fork identity producer — the envelope that proves a forked challenge pair
 * had matched pre-stage inputs (docs/arbiter/challenge-validity-contract.md §4).
 *
 * `foldAttestationsIntoStageAttribution` refuses a valid stage label unless the
 * pair carries a `ForkIdentity` with a commit and all four input hashes. Until
 * this module existed nothing produced one, so every forked pair was labelled
 * `missing_fork_identity` and reviewer-stage valid-label yield was structurally
 * zero.
 *
 * Each hash is computed independently from BOTH arms at fork time and recorded
 * only when the arms agree. A divergent or missing input yields `null`, which
 * the attribution folder reports as the specific `*_hash_mismatch` code rather
 * than silently passing. Hashes cannot be reconstructed after the fact, so the
 * identity must be captured by the materialiser, not backfilled.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ChallengeStage } from './challenge-mode.ts';
import type { ForkIdentity } from './challenge-execution-contract.ts';

export const FORK_IDENTITY_PRODUCER = 'wavemill-monitor@fork-materialize';
export const FORK_IDENTITY_PRODUCER_VERSION = '1';

/** Task-packet files, relative to an arm's feature dir. At least one is required. */
export const FORK_TASK_PACKET_FILES = ['task-packet.md', 'task-packet-header.md', 'task-packet-details.md'];
/** Plan artifact, relative to an arm's feature dir. Required. */
export const FORK_PLAN_FILES = ['plan.md'];
/** Per-arm prompt input (the selected task that seeds every stage prompt). */
export const FORK_PROMPT_ARM_FILES = ['selected-task.json'];
/** Installation-level prompt sources: templates plus the prompt builders. */
export const FORK_PROMPT_INSTALL_PATHS = ['tools/prompts', 'shared/lib/agent-adapters.sh'];
/** Per-arm tool config overlay, relative to an arm's worktree root. */
export const FORK_TOOL_CONFIG_ARM_FILES = ['.wavemill-config.local.json'];
/** Installation-level tool config: agent adapters, hook adapters, and allow lists. */
export const FORK_TOOL_CONFIG_INSTALL_PATHS = [
  'shared/lib/agent-adapters.sh',
  'shared/hooks',
  'shared/lib/permission-patterns.ts',
];
/** Repo-level tool config, relative to the repo root. */
export const FORK_TOOL_CONFIG_REPO_FILES = ['.wavemill-config.json', '.claude/settings.json'];

export interface ComputeForkIdentityInput {
  repoDir: string;
  /** Wavemill installation root (holds tools/prompts, shared/hooks, …). */
  installDir: string;
  forkStage: ChallengeStage;
  forkCommit: string;
  primaryWorktree: string;
  challengerWorktree: string;
  primaryFeatureDir: string;
  challengerFeatureDir: string;
  primaryInheritedStages?: ChallengeStage[];
  challengerInheritedStages?: ChallengeStage[];
  /** Injectable for tests; defaults to `git rev-parse <commit>^{tree}`. */
  resolveTree?: (repoDir: string, commit: string) => string | null;
}

/** Per-field agreement diagnostics, so the caller can log why a hash is null. */
export interface ForkIdentityDiagnostics {
  tree: 'ok' | 'unresolved';
  taskPacketHash: FieldAgreement;
  planHash: FieldAgreement;
  promptHash: FieldAgreement;
  toolConfigHash: FieldAgreement;
}

export type FieldAgreement = 'match' | 'missing' | 'divergent';

export interface ComputedForkIdentity {
  identity: ForkIdentity;
  diagnostics: ForkIdentityDiagnostics;
}

function listFilesUnder(root: string, relPath: string): string[] {
  const abs = path.join(root, relPath);
  if (!existsSync(abs)) return [];
  const stat = statSync(abs);
  if (stat.isFile()) return [relPath];
  if (!stat.isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs).sort()) {
    out.push(...listFilesUnder(root, path.join(relPath, entry)));
  }
  return out;
}

/**
 * SHA-256 over a named file set. Each present file contributes
 * `<relPath>\0<byteLength>\0<bytes>\0` in sorted path order, so renames and
 * content changes both move the hash. Returns null when no file is present.
 */
export function hashFileSet(root: string, relPaths: string[]): string | null {
  const files = relPaths.flatMap((rel) => listFilesUnder(root, rel)).sort();
  if (files.length === 0) return null;
  const hash = createHash('sha256');
  for (const rel of files) {
    const bytes = readFileSync(path.join(root, rel));
    hash.update(rel.split(path.sep).join('/'));
    hash.update('\0');
    hash.update(String(bytes.length));
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function combine(parts: Array<string | null>): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part ?? '-');
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Compare one arm-local input across both arms.
 * `required` inputs are `missing` when absent from both arms; optional inputs
 * absent from both arms agree trivially (contributing nothing to the hash).
 */
function agreeAcrossArms(
  primaryRoot: string,
  challengerRoot: string,
  relPaths: string[],
  required: boolean,
): { agreement: FieldAgreement; hash: string | null } {
  const primary = hashFileSet(primaryRoot, relPaths);
  const challenger = hashFileSet(challengerRoot, relPaths);
  if (primary === null && challenger === null) {
    return required ? { agreement: 'missing', hash: null } : { agreement: 'match', hash: null };
  }
  if (primary === null || challenger === null) return { agreement: 'missing', hash: null };
  if (primary !== challenger) return { agreement: 'divergent', hash: null };
  return { agreement: 'match', hash: primary };
}

function defaultResolveTree(repoDir: string, commit: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', `${commit}^{tree}`], {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Compute the fork identity for a pair at materialisation time.
 *
 * Call after the challenger's feature dir and config overlay have been copied
 * from the primary, and before either arm runs its varied stage.
 */
export function computeForkIdentity(input: ComputeForkIdentityInput): ComputedForkIdentity {
  const tree = (input.resolveTree ?? defaultResolveTree)(input.repoDir, input.forkCommit);

  const taskPacket = agreeAcrossArms(input.primaryFeatureDir, input.challengerFeatureDir, FORK_TASK_PACKET_FILES, true);
  const plan = agreeAcrossArms(input.primaryFeatureDir, input.challengerFeatureDir, FORK_PLAN_FILES, true);

  const promptArm = agreeAcrossArms(input.primaryFeatureDir, input.challengerFeatureDir, FORK_PROMPT_ARM_FILES, false);
  const promptInstall = hashFileSet(input.installDir, FORK_PROMPT_INSTALL_PATHS);
  const promptAgreement: FieldAgreement = promptArm.agreement !== 'match'
    ? promptArm.agreement
    : promptInstall === null ? 'missing' : 'match';
  const promptHash = promptAgreement === 'match' ? combine([promptInstall, promptArm.hash]) : null;

  const toolArm = agreeAcrossArms(input.primaryWorktree, input.challengerWorktree, FORK_TOOL_CONFIG_ARM_FILES, false);
  const toolInstall = hashFileSet(input.installDir, FORK_TOOL_CONFIG_INSTALL_PATHS);
  const toolRepo = hashFileSet(input.repoDir, FORK_TOOL_CONFIG_REPO_FILES);
  const toolAgreement: FieldAgreement = toolArm.agreement !== 'match'
    ? toolArm.agreement
    : toolInstall === null ? 'missing' : 'match';
  const toolConfigHash = toolAgreement === 'match' ? combine([toolInstall, toolRepo, toolArm.hash]) : null;

  return {
    identity: {
      stage: input.forkStage,
      commit: input.forkCommit,
      tree,
      taskPacketHash: taskPacket.hash,
      planHash: plan.hash,
      promptHash,
      toolConfigHash,
      sharedPrefix: true,
      primaryInheritedStages: input.primaryInheritedStages ?? [],
      challengerInheritedStages: input.challengerInheritedStages ?? [],
      producer: FORK_IDENTITY_PRODUCER,
      producerVersion: FORK_IDENTITY_PRODUCER_VERSION,
    },
    diagnostics: {
      tree: tree ? 'ok' : 'unresolved',
      taskPacketHash: taskPacket.agreement,
      planHash: plan.agreement,
      promptHash: promptAgreement,
      toolConfigHash: toolAgreement,
    },
  };
}

const CHALLENGE_STAGES = new Set<string>(['plan', 'implementation', 'review']);

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

function stageList(value: unknown): ChallengeStage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((stage): stage is ChallengeStage => typeof stage === 'string' && CHALLENGE_STAGES.has(stage));
}

/**
 * Parse a persisted fork identity (from an intent file, workflow state, or an
 * eval record). Returns undefined for anything that is not a recognisable
 * envelope — callers treat that the same as an absent identity.
 */
export function readForkIdentity(value: unknown): ForkIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const commit = nullableString(raw.commit);
  if (commit === undefined) return undefined;
  const stage = raw.stage === null
    ? null
    : typeof raw.stage === 'string' && CHALLENGE_STAGES.has(raw.stage)
      ? raw.stage as ChallengeStage
      : undefined;
  if (stage === undefined) return undefined;
  const identity: ForkIdentity = {
    stage,
    commit,
    tree: nullableString(raw.tree) ?? null,
    taskPacketHash: nullableString(raw.taskPacketHash) ?? null,
    planHash: nullableString(raw.planHash) ?? null,
    promptHash: nullableString(raw.promptHash) ?? null,
    toolConfigHash: nullableString(raw.toolConfigHash) ?? null,
  };
  if (typeof raw.sharedPrefix === 'boolean') identity.sharedPrefix = raw.sharedPrefix;
  const primaryInherited = stageList(raw.primaryInheritedStages);
  if (primaryInherited) identity.primaryInheritedStages = primaryInherited;
  const challengerInherited = stageList(raw.challengerInheritedStages);
  if (challengerInherited) identity.challengerInheritedStages = challengerInherited;
  if (typeof raw.producer === 'string') identity.producer = raw.producer;
  if (typeof raw.producerVersion === 'string') identity.producerVersion = raw.producerVersion;
  return identity;
}

/** Fork descriptor fields persisted on comparison records. */
export interface ForkDescriptorFields {
  forkStage?: ChallengeStage | null;
  forkCommit?: string | null;
  sharedPrefix?: boolean;
  primaryInheritedStages?: ChallengeStage[];
  challengerInheritedStages?: ChallengeStage[];
}

/**
 * Fill descriptor fields the intents left empty from the recorded fork
 * identity. Eval records persist a projected intent without fork fields, so
 * once the arms' feature dirs are gone the identity is the only durable copy.
 * Fields the intents did set always win.
 */
export function applyForkIdentityFallback<T extends ForkDescriptorFields>(
  descriptor: T,
  identity: ForkIdentity | undefined,
): T {
  if (!identity) return descriptor;
  return {
    ...descriptor,
    forkStage: descriptor.forkStage ?? identity.stage,
    forkCommit: descriptor.forkCommit ?? identity.commit,
    sharedPrefix: descriptor.sharedPrefix === true || identity.sharedPrefix === true,
    primaryInheritedStages: descriptor.primaryInheritedStages?.length
      ? descriptor.primaryInheritedStages
      : identity.primaryInheritedStages ?? [],
    challengerInheritedStages: descriptor.challengerInheritedStages?.length
      ? descriptor.challengerInheritedStages
      : identity.challengerInheritedStages ?? [],
  };
}
