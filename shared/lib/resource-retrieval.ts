import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OperatingMode } from './operating-mode.ts';
import type { ReviewerPersona } from './review-engine.ts';
import { recordUse } from './resource-manifest.ts';
import { getResource, type ResourceRef, type ResourceVersion, registerResource, toResourceRef } from './resource-registry.ts';
import { registerPromptTemplate, type PromptRegistrationOptions } from './resource-adapters/prompt-adapter.ts';
import { describeMemoryAsset, registerMemoryAsset } from './resource-adapters/memory-adapter.ts';
import { logPromptUsage } from './prompt-registry.ts';

const RUNTIME_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROMPTS_DIR = join(RUNTIME_REPO_ROOT, 'tools', 'prompts');

export type RuntimeResourceKind = 'prompt' | 'memory' | 'policy';
export type ResourceStability = 'stable' | 'canary' | 'experimental';
export type WorkflowStage = 'planning' | 'coding' | 'review';

interface RuntimeResourceQueryBase {
  kind: RuntimeResourceKind;
  repoDir?: string;
  stability?: ResourceStability;
  version?: string;
}

export interface PhasePromptQuery extends RuntimeResourceQueryBase {
  kind: 'prompt';
  role: 'phase-instructions';
  stage: WorkflowStage;
}

export interface ReviewerPromptQuery extends RuntimeResourceQueryBase {
  kind: 'prompt';
  role: 'reviewer';
  persona: ReviewerPersona;
  operatingMode?: OperatingMode;
}

export interface InitiativePlannerPromptQuery extends RuntimeResourceQueryBase {
  kind: 'prompt';
  role: 'initiative-planner';
  operatingMode?: OperatingMode;
}

export interface IssueWriterPromptQuery extends RuntimeResourceQueryBase {
  kind: 'prompt';
  role: 'issue-writer';
}

export interface EvalJudgePromptQuery extends RuntimeResourceQueryBase {
  kind: 'prompt';
  role: 'eval-judge';
}

export interface ProjectContextMemoryQuery extends RuntimeResourceQueryBase {
  kind: 'memory';
  role: 'project-context';
}

export interface SubsystemSpecMemoryQuery extends RuntimeResourceQueryBase {
  kind: 'memory';
  role: 'subsystem-spec';
  id: string;
}

export interface ConceptPageMemoryQuery extends RuntimeResourceQueryBase {
  kind: 'memory';
  role: 'concept-page';
  id: string;
}

export interface WavemillConfigPolicyQuery extends RuntimeResourceQueryBase {
  kind: 'policy';
  role: 'wavemill-config';
}

export type RuntimeResourceQuery =
  | PhasePromptQuery
  | ReviewerPromptQuery
  | InitiativePlannerPromptQuery
  | IssueWriterPromptQuery
  | EvalJudgePromptQuery
  | ProjectContextMemoryQuery
  | SubsystemSpecMemoryQuery
  | ConceptPageMemoryQuery
  | WavemillConfigPolicyQuery;

export type NormalizedRuntimeResourceQuery =
  | (PhasePromptQuery & { stability: ResourceStability; repoDir: string })
  | (ReviewerPromptQuery & { stability: ResourceStability; repoDir: string; operatingMode: OperatingMode })
  | (InitiativePlannerPromptQuery & { stability: ResourceStability; repoDir: string; operatingMode: OperatingMode })
  | (IssueWriterPromptQuery & { stability: ResourceStability; repoDir: string })
  | (EvalJudgePromptQuery & { stability: ResourceStability; repoDir: string })
  | (ProjectContextMemoryQuery & { stability: ResourceStability; repoDir: string })
  | (SubsystemSpecMemoryQuery & { stability: ResourceStability; repoDir: string })
  | (ConceptPageMemoryQuery & { stability: ResourceStability; repoDir: string })
  | (WavemillConfigPolicyQuery & { stability: ResourceStability; repoDir: string });

export interface ResolvedRuntimeResource {
  contract: NormalizedRuntimeResourceQuery;
  path: string;
  content?: string;
  resource: ResourceVersion | null;
  ref: ResourceRef | null;
}

function normalizeRepoDir(repoDir?: string): string {
  return resolve(repoDir || process.cwd());
}

function normalizeQuery(query: RuntimeResourceQuery): NormalizedRuntimeResourceQuery {
  const stability = query.stability || 'stable';
  if (stability !== 'stable') {
    throw new Error(`Unsupported stability channel "${stability}" for ${query.kind}:${query.role}; only "stable" is available in phase one`);
  }
  if (query.version) {
    throw new Error(`Explicit version selection is not supported yet for ${query.kind}:${query.role}; versioned lookup will land with HOK-1379`);
  }

  const repoDir = normalizeRepoDir(query.repoDir);
  if (query.kind === 'prompt' && query.role === 'reviewer') {
    return { ...query, repoDir, stability, operatingMode: query.operatingMode || 'normal' };
  }
  if (query.kind === 'prompt' && query.role === 'initiative-planner') {
    return { ...query, repoDir, stability, operatingMode: query.operatingMode || 'normal' };
  }
  return { ...query, repoDir, stability } as NormalizedRuntimeResourceQuery;
}

function resolvePromptPath(query: NormalizedRuntimeResourceQuery): string {
  if (query.kind !== 'prompt') {
    throw new Error(`Expected a prompt query, received ${query.kind}:${query.role}`);
  }

  switch (query.role) {
    case 'phase-instructions':
      return join(PROMPTS_DIR, `${query.stage}-phase.md`);
    case 'reviewer':
      if (query.persona === 'general' && query.operatingMode !== 'normal') {
        return join(PROMPTS_DIR, 'review-general-scoped.md');
      }
      return join(PROMPTS_DIR, `review-${query.persona}.md`);
    case 'initiative-planner':
      return join(
        PROMPTS_DIR,
        query.operatingMode === 'normal'
          ? 'initiative-planner.md'
          : 'initiative-planner-compressed.md',
      );
    case 'issue-writer':
      return join(PROMPTS_DIR, 'issue-writer.md');
    case 'eval-judge':
      return join(PROMPTS_DIR, 'eval-judge.md');
  }
}

function requireNonEmptyId(role: string, id: string | undefined): string {
  const normalized = id?.trim();
  if (!normalized) {
    throw new Error(`Resource query for ${role} requires a non-empty id`);
  }
  return normalized;
}

function resolveBackingPath(query: NormalizedRuntimeResourceQuery): string {
  switch (query.kind) {
    case 'prompt':
      return resolvePromptPath(query);
    case 'memory':
      switch (query.role) {
        case 'project-context':
          return join(query.repoDir, '.wavemill', 'project-context.md');
        case 'subsystem-spec':
          return join(query.repoDir, '.wavemill', 'context', `${requireNonEmptyId(query.role, query.id)}.md`);
        case 'concept-page':
          return join(query.repoDir, '.wavemill', 'context', 'concepts', `${requireNonEmptyId(query.role, query.id)}.md`);
        default:
          throw new Error(`Unrecognized memory role: ${(query as { role: string }).role}`);
      }
    case 'policy':
      return join(query.repoDir, '.wavemill-config.json');
  }
}

function ensureBackingFileExists(query: NormalizedRuntimeResourceQuery, path: string): void {
  if (!existsSync(path)) {
    throw new Error(`Backing file not found for ${query.kind}:${query.role} at ${path}`);
  }
}

function buildContractMetadata(query: NormalizedRuntimeResourceQuery, path: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    resourceClass: query.kind,
    role: query.role,
    stability: query.stability,
    path,
  };

  if (query.kind === 'prompt') {
    if (query.role === 'phase-instructions') {
      base.stage = query.stage;
    }
    if (query.role === 'reviewer') {
      base.persona = query.persona;
      base.operatingMode = query.operatingMode;
    }
    if (query.role === 'initiative-planner') {
      base.operatingMode = query.operatingMode;
    }
    return base;
  }

  if (query.kind === 'memory') {
    if (query.role === 'subsystem-spec') {
      base.memoryRole = 'subsystem-spec';
      base.subsystemId = query.id;
    } else if (query.role === 'concept-page') {
      base.memoryRole = 'concept-page';
      base.conceptId = query.id;
    } else {
      base.memoryRole = 'project-context';
    }
    return base;
  }

  base.policyRole = 'wavemill-config';
  return base;
}

function maybeRecordManifest(ref: ResourceRef | null, repoDir: string): void {
  const sessionId = process.env.WAVEMILL_SESSION;
  if (!sessionId || !ref) {
    return;
  }
  try {
    recordUse(sessionId, process.env.WAVEMILL_PHASE || 'unknown', ref, repoDir);
  } catch (error) {
    console.warn(`[resource-retrieval] Failed to record manifest use: ${(error as Error).message}`);
  }
}

function loadRegisteredPrompt(
  query: NormalizedRuntimeResourceQuery & { kind: 'prompt' },
  path: string,
  content: string,
): { resource: ResourceVersion | null; ref: ResourceRef | null } {
  const metadata = buildContractMetadata(query, path);
  const promptOptions: PromptRegistrationOptions = { metadata };

  let ref: ResourceRef | null = null;
  try {
    ref = logPromptUsage(path, content, { repoDir: query.repoDir }, promptOptions);
  } catch (error) {
    console.warn(`[resource-retrieval] Failed to log prompt usage: ${(error as Error).message}`);
    ref = registerPromptTemplate(path, content, query.repoDir, promptOptions);
    maybeRecordManifest(ref, query.repoDir);
  }

  return {
    ref,
    resource: ref ? getResource(ref.id, ref.version, query.repoDir) : null,
  };
}

function loadRegisteredNonPrompt(
  query: Exclude<NormalizedRuntimeResourceQuery, { kind: 'prompt' }>,
  path: string,
  content: string,
): { resource: ResourceVersion | null; ref: ResourceRef | null } {
  const metadata = buildContractMetadata(query, path);

  if (query.kind === 'memory') {
    const ref = registerMemoryAsset(path, content, query.repoDir, metadata);
    maybeRecordManifest(ref, query.repoDir);
    return {
      ref,
      resource: ref ? getResource(ref.id, ref.version, query.repoDir) : null,
    };
  }

  const resource = registerResource({
    type: 'agent-config',
    name: relative(query.repoDir, path).replace(/[\\/]/g, '__').replace(/\.[^.]+$/, ''),
    content,
    uri: path,
    metadata,
  }, { repoDir: query.repoDir });
  const ref = toResourceRef(resource);
  maybeRecordManifest(ref, query.repoDir);
  return { resource, ref };
}

function buildLoadedResult(
  query: NormalizedRuntimeResourceQuery,
  path: string,
  content: string,
): ResolvedRuntimeResource {
  const loaded = query.kind === 'prompt'
    ? loadRegisteredPrompt(query, path, content)
    : loadRegisteredNonPrompt(query, path, content);
  return {
    contract: query,
    path,
    content,
    resource: loaded.resource,
    ref: loaded.ref,
  };
}

export function resolveRuntimeResource(query: RuntimeResourceQuery): ResolvedRuntimeResource {
  const normalized = normalizeQuery(query);
  const path = resolveBackingPath(normalized);
  ensureBackingFileExists(normalized, path);
  return {
    contract: normalized,
    path,
    resource: null,
    ref: null,
  };
}

export async function loadRuntimeResource(query: RuntimeResourceQuery): Promise<ResolvedRuntimeResource> {
  const resolved = resolveRuntimeResource(query);
  const content = await readFile(resolved.path, 'utf-8');
  return buildLoadedResult(resolved.contract, resolved.path, content);
}

export function loadRuntimeResourceSync(query: RuntimeResourceQuery): ResolvedRuntimeResource {
  const resolved = resolveRuntimeResource(query);
  const content = readFileSync(resolved.path, 'utf-8');
  return buildLoadedResult(resolved.contract, resolved.path, content);
}

export function loadPromptResourceSync(
  query: Extract<RuntimeResourceQuery, { kind: 'prompt' }>,
): ResolvedRuntimeResource {
  return loadRuntimeResourceSync(query);
}

export async function loadPromptResource(
  query: Extract<RuntimeResourceQuery, { kind: 'prompt' }>,
): Promise<ResolvedRuntimeResource> {
  return loadRuntimeResource(query);
}

export function describeMemoryResourcePath(repoDir: string, path: string): { name: string; metadata: Record<string, unknown> } {
  return describeMemoryAsset(normalizeRepoDir(repoDir), path);
}
