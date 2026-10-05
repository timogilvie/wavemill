import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  getRuntimeResourceSelectionConfig,
  type RuntimeResourceSurface,
  type RuntimeResourceSurfaceConfig,
  type RuntimeResourceVariantKind,
} from './config.ts';
import { recordUse } from './resource-manifest.ts';
import {
  getResource,
  registerResource,
  toResourceRef,
  type ResourceRef,
  type ResourceType,
} from './resource-registry.ts';
import { registerPromptTemplate } from './resource-adapters/prompt-adapter.ts';
import { registerDspyArtifact } from './resource-adapters/dspy-adapter.ts';
import { resolveWavemillAssetPath } from './native-agent/install-paths.ts';

export type ResourceSurface = RuntimeResourceSurface;
export type ResourceVariantKind = RuntimeResourceVariantKind;

export interface RuntimeResourceSelection {
  surface: ResourceSurface;
  variant: ResourceVariantKind;
  requestedVariant: ResourceVariantKind;
  resourceRef: ResourceRef | null;
  uri?: string;
  fallbackApplied: boolean;
  rejectionReason?: string;
}

export interface RuntimeResourceContentResult {
  selection: RuntimeResourceSelection;
  content: string | null;
  error?: string;
}

interface DspyStageArtifact {
  version?: string;
  stage?: string;
  created_at?: string;
  optimizer?: string;
  teacher_model?: string;
  optimized_instruction?: string;
  [key: string]: unknown;
}

interface SurfaceCandidate {
  kind: 'prompt-file' | 'dspy-artifact' | 'derived-prompt';
  uri: string;
  name: string;
  expectedType: ResourceType;
  loadContent: (repoDir?: string) => string;
  register: (repoDir?: string) => ResourceRef | null;
}

const DEFAULT_BASELINES: Record<ResourceSurface, string> = {
  router: 'dspy/artifacts/optimized-selector.json',
  planner: 'tools/prompts/planning-phase.md',
  reviewer: 'tools/prompts/review-phase.md',
};

const DEFAULT_OPTIMIZED: Partial<Record<ResourceSurface, string>> = {
  router: 'dspy/artifacts/optimized-selector.json',
  planner: 'dspy/artifacts/optimized-planner.json',
  reviewer: 'dspy/artifacts/optimized-reviewer.json',
};

const DEFAULT_CANARY: Partial<Record<ResourceSurface, string>> = {
  router: 'dspy/artifacts/optimized-selector-20260404.json',
};

function stableBucket(input: string): number {
  const hash = createHash('sha256').update(input, 'utf-8').digest('hex');
  const value = Number.parseInt(hash.slice(0, 8), 16);
  return value / 0xffffffff;
}

function normalizeRate(rate: number): number {
  return Math.max(0, Math.min(1, rate));
}

function selectSessionId(explicitSessionId?: string): string | undefined {
  return explicitSessionId || process.env.WAVEMILL_SESSION || undefined;
}

function makePromptFileCandidate(surface: Exclude<ResourceSurface, 'router'>, path: string): SurfaceCandidate {
  return {
    kind: 'prompt-file',
    uri: path,
    name: surface === 'planner' ? 'planning-phase' : 'review-phase',
    expectedType: 'prompt',
    loadContent(_repoDir?: string): string {
      return readFileSync(resolveWavemillAssetPath(path), 'utf-8');
    },
    register(repoDir?: string): ResourceRef | null {
      const content = this.loadContent(repoDir);
      return registerPromptTemplate(path, content, repoDir);
    },
  };
}

function makeRouterArtifactCandidate(path: string): SurfaceCandidate {
  return {
    kind: 'dspy-artifact',
    uri: path,
    name: 'optimized-selector',
    expectedType: 'optimizer-artifact',
    loadContent(_repoDir?: string): string {
      return readFileSync(resolveWavemillAssetPath(path), 'utf-8');
    },
    register(repoDir?: string): ResourceRef | null {
      const artifact = JSON.parse(this.loadContent(repoDir)) as Record<string, unknown>;
      return registerDspyArtifact(path, artifact, repoDir);
    },
  };
}

function makeDerivedPromptCandidate(surface: Exclude<ResourceSurface, 'router'>, path: string): SurfaceCandidate {
  return {
    kind: 'derived-prompt',
    uri: path,
    name: `${surface}-optimized`,
    expectedType: 'prompt',
    loadContent(_repoDir?: string): string {
      const artifact = JSON.parse(readFileSync(resolveWavemillAssetPath(path), 'utf-8')) as DspyStageArtifact;
      if (typeof artifact.optimized_instruction !== 'string' || !artifact.optimized_instruction.trim()) {
        throw new Error(`Missing optimized_instruction in ${path}`);
      }
      return artifact.optimized_instruction;
    },
    register(repoDir?: string): ResourceRef | null {
      const artifactPath = resolveWavemillAssetPath(path);
      const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8')) as DspyStageArtifact;
      const artifactRef = registerDspyArtifact(path, artifact as Record<string, unknown>, repoDir);
      const content = this.loadContent(repoDir);
      return registerResource({
        type: 'prompt',
        name: `${surface}-optimized`,
        content,
        uri: path,
        lineage: {
          source: path,
          optimizer: typeof artifact.optimizer === 'string' ? artifact.optimizer : undefined,
          generatedFrom: artifactRef ? [artifactRef] : undefined,
        },
        dependencies: artifactRef ? [artifactRef] : undefined,
        metadata: {
          path,
          sourceSurface: surface,
          sourceArtifact: path,
          stage: artifact.stage,
          teacherModel: artifact.teacher_model,
          createdAt: artifact.created_at,
        },
      }, { repoDir });
    },
  };
}

function getVariantPath(
  surface: ResourceSurface,
  variant: ResourceVariantKind,
  surfaceConfig?: RuntimeResourceSurfaceConfig,
): string | undefined {
  if (surfaceConfig?.path) {
    return surfaceConfig.path;
  }
  if (variant === 'baseline') {
    return DEFAULT_BASELINES[surface];
  }
  if (variant === 'optimized') {
    return DEFAULT_OPTIMIZED[surface];
  }
  return DEFAULT_CANARY[surface];
}

function buildCandidate(
  surface: ResourceSurface,
  variant: ResourceVariantKind,
  surfaceConfig?: RuntimeResourceSurfaceConfig,
): SurfaceCandidate | null {
  const path = getVariantPath(surface, variant, surfaceConfig);
  if (!path) {
    return null;
  }

  if (surface === 'router') {
    return makeRouterArtifactCandidate(path);
  }
  if (variant === 'baseline') {
    return makePromptFileCandidate(surface, path);
  }
  return makeDerivedPromptCandidate(surface, path);
}

function verifyExpectedResource(
  resource: ResourceRef | null,
  candidate: SurfaceCandidate,
  surfaceConfig?: RuntimeResourceSurfaceConfig,
  repoDir?: string,
): string | undefined {
  if (!resource) {
    return undefined;
  }
  const resolvedResource = getResource(resource.id, resource.version, repoDir);
  if (!resolvedResource) {
    return `resource ${resource.id} was not persisted to the registry`;
  }
  if (resolvedResource.type !== candidate.expectedType) {
    return `resource type mismatch: expected ${candidate.expectedType}, got ${resolvedResource.type}`;
  }
  if (!surfaceConfig?.resourceId) {
    return undefined;
  }

  const expected = getResource(surfaceConfig.resourceId, surfaceConfig.version, repoDir);
  if (!expected) {
    return `configured resource ${surfaceConfig.resourceId} was not found`;
  }
  if (expected.id !== resource.id || (surfaceConfig.version && expected.version !== resource.version)) {
    return `selected resource did not match configured resource ${surfaceConfig.resourceId}`;
  }
  return undefined;
}

function resolveSelectionInternal(
  surface: ResourceSurface,
  options: {
    repoDir?: string;
    sessionId?: string;
  } = {},
): { candidate: SurfaceCandidate | null; selection: RuntimeResourceSelection; error?: string } {
  const runtimeConfig = getRuntimeResourceSelectionConfig(options.repoDir);
  const surfaceConfig = runtimeConfig.surfaces[surface];
  const requestedVariant = surfaceConfig?.variant || runtimeConfig.defaultVariant;

  const baselineCandidate = buildCandidate(surface, 'baseline', {
    ...surfaceConfig,
    path: DEFAULT_BASELINES[surface],
  });
  let baselineRef: ResourceRef | null = null;
  if (baselineCandidate) {
    try {
      const baselinePath = resolveWavemillAssetPath(baselineCandidate.uri);
      if (existsSync(baselinePath)) {
        baselineRef = toResourceRef(baselineCandidate.register(options.repoDir));
      }
    } catch {
      baselineRef = null;
    }
  }

  if (!runtimeConfig.enabled || surfaceConfig?.enabled === false) {
    return {
      candidate: baselineCandidate,
      selection: {
        surface,
        variant: 'baseline',
        requestedVariant,
        resourceRef: baselineRef,
        uri: baselineCandidate?.uri,
        fallbackApplied: requestedVariant !== 'baseline',
        ...(requestedVariant !== 'baseline' ? { rejectionReason: 'runtime selection disabled by policy' } : {}),
      },
    };
  }

  let resolvedVariant = requestedVariant;
  if (requestedVariant === 'canary') {
    const sessionId = selectSessionId(options.sessionId);
    if (!sessionId) {
      return {
        candidate: baselineCandidate,
        selection: {
          surface,
          variant: 'baseline',
          requestedVariant,
          resourceRef: baselineRef,
          uri: baselineCandidate?.uri,
          fallbackApplied: true,
          rejectionReason: 'canary requested without a stable session id',
        },
      };
    }
    const bucket = stableBucket(`${surface}:${sessionId}`);
    if (bucket >= normalizeRate(runtimeConfig.canaryRate)) {
      return {
        candidate: baselineCandidate,
        selection: {
          surface,
          variant: 'baseline',
          requestedVariant,
          resourceRef: baselineRef,
          uri: baselineCandidate?.uri,
          fallbackApplied: true,
          rejectionReason: `session not selected for canary rollout (${runtimeConfig.canaryRate})`,
        },
      };
    }
  }

  const candidate = buildCandidate(surface, resolvedVariant, surfaceConfig);
  if (!candidate) {
    if (!runtimeConfig.fallbackToBaseline) {
      return {
        candidate: null,
        selection: {
          surface,
          variant: requestedVariant,
          requestedVariant,
          resourceRef: null,
          fallbackApplied: false,
          rejectionReason: 'no candidate configured for requested variant',
        },
        error: 'no candidate configured for requested variant',
      };
    }
    return {
      candidate: baselineCandidate,
        selection: {
          surface,
          variant: 'baseline',
          requestedVariant,
          resourceRef: baselineRef,
          uri: baselineCandidate?.uri,
          fallbackApplied: true,
          rejectionReason: 'no candidate configured for requested variant',
      },
    };
  }

  const absPath = resolveWavemillAssetPath(candidate.uri);
  if (!existsSync(absPath)) {
    if (!runtimeConfig.fallbackToBaseline) {
      return {
        candidate: null,
        selection: {
          surface,
          variant: resolvedVariant,
          requestedVariant,
          resourceRef: null,
          uri: candidate.uri,
          fallbackApplied: false,
          rejectionReason: `candidate file not found: ${candidate.uri}`,
        },
        error: `candidate file not found: ${candidate.uri}`,
      };
    }
    return {
      candidate: baselineCandidate,
        selection: {
          surface,
          variant: 'baseline',
          requestedVariant,
          resourceRef: baselineRef,
          uri: baselineCandidate?.uri,
          fallbackApplied: true,
          rejectionReason: `candidate file not found: ${candidate.uri}`,
      },
    };
  }

  try {
    const resource = candidate.register(options.repoDir);
    const mismatch = verifyExpectedResource(resource, candidate, surfaceConfig, options.repoDir);
    if (mismatch) {
      throw new Error(mismatch);
    }
    return {
      candidate,
      selection: {
        surface,
        variant: resolvedVariant,
        requestedVariant,
        resourceRef: toResourceRef(resource),
        uri: candidate.uri,
        fallbackApplied: false,
      },
    };
  } catch (error) {
    if (!runtimeConfig.fallbackToBaseline) {
      return {
        candidate: null,
        selection: {
          surface,
          variant: resolvedVariant,
          requestedVariant,
          resourceRef: null,
          uri: candidate.uri,
          fallbackApplied: false,
          rejectionReason: (error as Error).message,
        },
        error: (error as Error).message,
      };
    }

    return {
      candidate: baselineCandidate,
        selection: {
          surface,
          variant: 'baseline',
          requestedVariant,
          resourceRef: baselineRef,
          uri: baselineCandidate?.uri,
          fallbackApplied: true,
          rejectionReason: (error as Error).message,
      },
    };
  }
}

export function resolveRuntimeResource(
  surface: ResourceSurface,
  options: {
    repoDir?: string;
    sessionId?: string;
  } = {},
): RuntimeResourceSelection {
  return resolveSelectionInternal(surface, options).selection;
}

export function resolveRuntimeResourceContent(
  surface: ResourceSurface,
  options: {
    repoDir?: string;
    sessionId?: string;
  } = {},
): RuntimeResourceContentResult {
  const { candidate, selection, error } = resolveSelectionInternal(surface, options);
  if (!candidate) {
    return { selection, content: null, ...(error ? { error } : {}) };
  }

  try {
    return {
      selection,
      content: candidate.loadContent(options.repoDir),
    };
  } catch (loadError) {
    return {
      selection: {
        ...selection,
        fallbackApplied: selection.fallbackApplied || selection.variant !== 'baseline',
        rejectionReason: (loadError as Error).message,
      },
      content: null,
      error: (loadError as Error).message,
    };
  }
}

export function recordRuntimeResourceSelection(
  selection: RuntimeResourceSelection,
  options: {
    repoDir?: string;
    sessionId?: string;
    phase?: string;
  } = {},
): void {
  const sessionId = selectSessionId(options.sessionId);
  if (!sessionId || !selection.resourceRef) {
    return;
  }
  recordUse(sessionId, options.phase || process.env.WAVEMILL_PHASE || 'unknown', selection.resourceRef, options.repoDir);
}
