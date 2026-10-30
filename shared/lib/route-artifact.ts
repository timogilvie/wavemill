import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { getMaxCostUsd } from './config.ts';
import { getEffectiveRegistry, getModel } from './model-registry.ts';
import type { RoutePrediction } from './eval-schema.ts';
import type { WorkflowRouteDecision } from './workflow-router.ts';

export const ROUTE_ARTIFACT_SCHEMA_VERSION = '1.1';
export const POLICY_RESOLVER_VERSION = '1.0.0';

export type RouteSource =
  | 'bootstrap'
  | 'expanded'
  | 'startup-cache'
  | 'batch-cache'
  | 'live'
  | 'heuristic-fallback';

export type RouteInputKind = 'issue' | 'task-packet' | 'cache' | 'heuristic';

export type RouterPolicyVersion =
  | 'baseline'
  | 'heuristic'
  | 'stage-aware'
  | 'hokusai'
  | 'policy'
  | 'expanded-route'
  | 'heuristic-fallback';

export interface RouteProvenance {
  source: RouteSource;
  inputKind: RouteInputKind;
  inputPath: string;
  inputHash: string;
  routedAt: string;
  routerMode: 'normal' | 'constrained' | 'survival';
  requestId?: string;
  inferenceLogId?: string;
  estimatedDurationSeconds?: number;
  alternatives?: unknown;
  tradeoffs?: unknown;
  nearestNeighbors?: unknown;
  escalation?: RouteEscalationProvenance;
  hokusai?: {
    apiVersion?: string;
    inferenceMethod?: string;
    modelUri?: string;
    modelVersion?: string;
    schema?: string;
    objective?: string;
    rationale?: string;
    nearestNeighborCount?: number;
    exactRouteMatchCount?: number;
  };
  signalVector?: Record<string, unknown>;
}

export type RouteEscalationTriggerMetric = 'expectedSuccess' | 'confidence';
export type RouteEscalationOutcome =
  | 'escalated'
  | 'not_triggered'
  | 'no_stronger_candidate'
  | 'no_affordable_stronger_candidate'
  | 'retry_failed';

export interface RouteEscalationTrigger {
  metric: RouteEscalationTriggerMetric;
  value: number;
  threshold: number;
}

export interface RouteEscalationSummary {
  planner: string;
  coder: string;
  reviewer: string;
  cost: number;
  expectedSuccess: number;
  confidence: number;
}

export interface RouteEscalationProvenance {
  enabled: boolean;
  triggered: boolean;
  triggers: RouteEscalationTrigger[];
  outcome: RouteEscalationOutcome;
  initialRoute: RouteEscalationSummary;
  finalRoute: RouteEscalationSummary;
  candidateCount: number;
  thresholds: {
    expectedSuccessFloor: number;
    confidenceFloor: number;
    minCoderClassRankIncrease: number;
  };
  budget?: number | null;
  reason?: string;
}

export interface RouteDecisionWithProvenance extends WorkflowRouteDecision {
  provenance?: RouteProvenance;
  cache_hit?: boolean;
  route_source?: 'batch' | 'single' | 'cache';
  packet_hash?: string;
}

export interface RouterPolicyMetadataInput {
  routingMode?: string;
  source?: string;
  inputKind?: string;
  routerMode?: RouteProvenance['routerMode'];
}

export function resolveRouterPolicyVersion(
  metadata: RouterPolicyMetadataInput | null | undefined,
): RouterPolicyVersion {
  const routingMode = metadata?.routingMode?.trim();
  const source = metadata?.source?.trim();
  const inputKind = metadata?.inputKind?.trim();

  if (routingMode === 'hokusai') {
    return 'hokusai';
  }
  if (routingMode === 'policy') {
    return 'policy';
  }
  if (routingMode === 'stage-aware' || routingMode === 'stage-aware-partial') {
    return 'stage-aware';
  }
  if (routingMode === 'heuristic-fallback' || source === 'heuristic-fallback') {
    return 'heuristic-fallback';
  }
  if (routingMode === 'heuristic') {
    return 'heuristic';
  }
  if (source === 'expanded' || inputKind === 'task-packet') {
    return 'expanded-route';
  }

  return 'baseline';
}

function isFiniteNonNegativeBudget(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export interface ResolveRouteBudgetOptions {
  explicitMaxCostUsd?: number;
  repoDir?: string;
}

export function resolveRouteDecisionBudget(
  decision: Partial<WorkflowRouteDecision>,
  options: ResolveRouteBudgetOptions = {},
): number | null {
  if (isFiniteNonNegativeBudget(options.explicitMaxCostUsd)) {
    return options.explicitMaxCostUsd;
  }
  if (isFiniteNonNegativeBudget(decision.constraints?.maxCostUsd)) {
    return decision.constraints.maxCostUsd;
  }
  if (isFiniteNonNegativeBudget(decision.maxCostUsd)) {
    return decision.maxCostUsd;
  }

  const configured = getMaxCostUsd(options.repoDir);
  return isFiniteNonNegativeBudget(configured) ? configured : null;
}

export function withResolvedRouteBudget<T extends WorkflowRouteDecision>(
  decision: T,
  options: ResolveRouteBudgetOptions = {},
): T {
  const maxCostUsd = resolveRouteDecisionBudget(decision, options);
  if (maxCostUsd === null) {
    return {
      ...decision,
      maxCostUsd: null,
    };
  }

  return {
    ...decision,
    constraints: {
      ...(decision.constraints ?? {}),
      maxCostUsd,
    },
    maxCostUsd,
  };
}

export interface BuildRouteProvenanceParams {
  source: RouteSource;
  inputKind: RouteInputKind;
  inputPath?: string;
  inputBytes?: string | Buffer;
  routerMode: 'normal' | 'constrained' | 'survival';
  routedAt?: string;
}

export function buildRouteProvenance(params: BuildRouteProvenanceParams): RouteProvenance {
  const hasInputBytes = typeof params.inputBytes !== 'undefined';
  const isHeuristicFallbackWithoutInput = params.source === 'heuristic-fallback' && !hasInputBytes;
  const bytes = hasInputBytes
    ? (Buffer.isBuffer(params.inputBytes) ? params.inputBytes : Buffer.from(params.inputBytes, 'utf-8'))
    : null;

  return {
    source: params.source,
    inputKind: isHeuristicFallbackWithoutInput ? 'heuristic' : params.inputKind,
    inputPath: isHeuristicFallbackWithoutInput ? '' : (params.inputPath || ''),
    inputHash: bytes ? createHash('sha256').update(bytes).digest('hex') : '',
    routedAt: params.routedAt || new Date().toISOString(),
    routerMode: params.routerMode,
  };
}

export function withRouteProvenance<T extends WorkflowRouteDecision>(decision: T, provenance: RouteProvenance): T & {
  provenance: RouteProvenance;
} {
  return {
    ...decision,
    provenance: {
      ...(decision.provenance ?? {}),
      ...provenance,
    },
  };
}

export function withExpandedRouteMetadata<T extends WorkflowRouteDecision>(
  decision: T,
  metadata: Pick<RouteDecisionWithProvenance, 'cache_hit' | 'route_source' | 'packet_hash'>,
): T & Pick<RouteDecisionWithProvenance, 'cache_hit' | 'route_source' | 'packet_hash'> {
  return {
    ...decision,
    ...metadata,
  };
}

export function stringifyRouteArtifact(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  if (typeof serialized !== 'string') {
    throw new TypeError('Route artifact must serialize to a JSON document');
  }

  JSON.parse(serialized);
  return `${serialized}\n`;
}

export function writeRouteArtifact(path: string, value: unknown): void {
  const tmpPath = join(dirname(path), `.tmp-route-artifact-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    writeFileSync(tmpPath, stringifyRouteArtifact(value), 'utf-8');
    renameSync(tmpPath, path);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

export interface NormalizedExpandedRouteArtifact {
  coder: string;
  codeDepth: string;
  reviewer: string;
  reviewMode: string;
}

export interface RouteArtifactSnapshot extends NormalizedExpandedRouteArtifact {
  harnessId?: string;
  planDepth?: string;
  planner?: string;
  cache_hit?: boolean;
  route_source?: 'batch' | 'single' | 'cache';
  packet_hash?: string;
  artifactPath?: string;
  artifactHash?: string;
  inputHash?: string;
  source?: RouteSource;
  routerMode?: RouteProvenance['routerMode'];
  routingMode?: string;
  expectedMetrics?: Record<string, unknown>;
  challengeRecommendation?: unknown;
}

export interface RouteArtifactView {
  coder: string;
  codeDepth: string;
  reviewer: string;
  reviewMode: string;
  harnessId?: string;
  planner?: string;
  planDepth?: string;
  artifactPath?: string;
  artifactHash?: string;
  inputHash?: string;
  source?: RouteSource;
  cacheHit?: boolean;
  routeSource?: 'batch' | 'single' | 'cache';
  routerMode?: RouteProvenance['routerMode'];
  routingMode?: string;
  expectedMetrics?: Record<string, unknown>;
}

export interface RouteLifecycleArtifacts {
  bootstrap: RouteArtifactSnapshot | null;
  expanded: RouteArtifactSnapshot | null;
  active: RouteArtifactSnapshot | null;
  planningLaunch?: RouteArtifactSnapshot | null;
}

export interface RouteLifecycleProvenance {
  bootstrapRoute?: RouteArtifactView;
  expandedRoute?: RouteArtifactView;
  activeRoute?: RouteArtifactView;
  planningLaunchRoute?: RouteArtifactView;
  routeChanged?: boolean;
  decisionSource?: 'bootstrap' | 'expanded' | 'preserved';
  expandedCacheHit?: boolean;
  packetHash?: string;
  routeSource?: 'batch' | 'single' | 'cache';
  routerMode?: RouteProvenance['routerMode'];
  routingMode?: string;
  artifactPath?: string;
  artifactHash?: string;
}

export type ExpandedRouteValidation = {
  valid: boolean;
  missing: string[];
  invalid: string[];
  normalized?: NormalizedExpandedRouteArtifact;
};

export function validateExpandedRouteArtifact(value: unknown): ExpandedRouteValidation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      valid: false,
      missing: [],
      invalid: ['artifact'],
    };
  }

  const artifact = value as Record<string, unknown>;
  const missing: string[] = [];
  const invalid: string[] = [];

  const readStringField = (field: 'coder' | 'codeDepth' | 'reviewer'): string | undefined => {
    const raw = artifact[field];
    if (typeof raw === 'undefined') {
      missing.push(field);
      return undefined;
    }
    if (typeof raw !== 'string' || raw.trim() === '') {
      invalid.push(field);
      return undefined;
    }
    return raw;
  };

  const coder = readStringField('coder');
  const codeDepth = readStringField('codeDepth');
  const reviewer = readStringField('reviewer');

  const reviewModeCandidate = artifact.reviewMode ?? artifact.reviewRecommended;
  let reviewMode: string | undefined;
  if (typeof reviewModeCandidate === 'undefined') {
    missing.push('reviewMode');
  } else if (typeof reviewModeCandidate !== 'string' || reviewModeCandidate.trim() === '') {
    invalid.push('reviewMode');
  } else {
    reviewMode = reviewModeCandidate;
  }

  if (missing.length > 0 || invalid.length > 0 || !coder || !codeDepth || !reviewer || !reviewMode) {
    return {
      valid: false,
      missing,
      invalid,
    };
  }

  if (typeof artifact.cache_hit !== 'undefined' && typeof artifact.cache_hit !== 'boolean') {
    invalid.push('cache_hit');
  }

  if (
    typeof artifact.route_source !== 'undefined'
    && artifact.route_source !== 'batch'
    && artifact.route_source !== 'single'
    && artifact.route_source !== 'cache'
  ) {
    invalid.push('route_source');
  }

  if (
    typeof artifact.packet_hash !== 'undefined'
    && (typeof artifact.packet_hash !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.packet_hash))
  ) {
    invalid.push('packet_hash');
  }

  if (
    typeof artifact.harnessId !== 'undefined'
    && (typeof artifact.harnessId !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.harnessId))
  ) {
    invalid.push('harnessId');
  }

  if (invalid.length > 0) {
    return {
      valid: false,
      missing,
      invalid,
    };
  }

  return {
    valid: true,
    missing: [],
    invalid: [],
    normalized: {
      coder,
      codeDepth,
      reviewer,
      reviewMode,
    },
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  const numeric = readFiniteNumber(value);
  return typeof numeric === 'number' && numeric >= 0 ? numeric : undefined;
}

function readProbability(value: unknown): number | undefined {
  const numeric = readFiniteNumber(value);
  return typeof numeric === 'number' && numeric >= 0 && numeric <= 1 ? numeric : undefined;
}

function pushFeature(features: string[], value: unknown): void {
  if (typeof value !== 'string') {
    return;
  }
  const normalized = value.trim();
  if (!normalized || features.includes(normalized)) {
    return;
  }
  features.push(normalized);
}

function summarizeRationale(reasoning: string[]): string | undefined {
  const summary = reasoning
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  if (!summary) {
    return undefined;
  }
  return summary.length <= 280 ? summary : `${summary.slice(0, 277).trimEnd()}...`;
}

export function buildRoutePrediction(
  decisionOrArtifact: Partial<WorkflowRouteDecision> | Record<string, unknown> | null | undefined,
): RoutePrediction | undefined {
  if (!decisionOrArtifact || typeof decisionOrArtifact !== 'object' || Array.isArray(decisionOrArtifact)) {
    return undefined;
  }

  const artifact = decisionOrArtifact as Record<string, unknown>;
  const signals = artifact.signals && typeof artifact.signals === 'object' && !Array.isArray(artifact.signals)
    ? artifact.signals as Record<string, unknown>
    : undefined;
  const reasoning = Array.isArray(artifact.reasoning)
    ? artifact.reasoning.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  const expectedCostUsd = readNonNegativeNumber(artifact.expectedCost)
    ?? (() => {
      const stageCosts = [
        readNonNegativeNumber(artifact.expectedCostPlan),
        readNonNegativeNumber(artifact.expectedCostCode),
        readNonNegativeNumber(artifact.expectedCostReview),
      ];
      return stageCosts.every((value) => typeof value === 'number')
        ? Number((stageCosts[0]! + stageCosts[1]! + stageCosts[2]!).toFixed(6))
        : undefined;
    })();

  const features: string[] = [];
  for (const entry of reasoning) {
    pushFeature(features, entry);
    if (features.length >= 5) {
      break;
    }
  }
  if (features.length < 5 && signals) {
    pushFeature(features, readString(signals.taskType) ? `taskType=${String(signals.taskType)}` : undefined);
    pushFeature(features, readString(signals.taskDifficulty) ? `taskDifficulty=${String(signals.taskDifficulty)}` : undefined);
    const complexityScore = readNonNegativeNumber(signals.complexityScore);
    if (typeof complexityScore === 'number') {
      pushFeature(features, `complexityScore=${complexityScore}`);
    }
    const riskScore = readNonNegativeNumber(signals.riskScore);
    if (typeof riskScore === 'number') {
      pushFeature(features, `riskScore=${riskScore}`);
    }
  }

  const prediction: RoutePrediction = {
    ...(readProbability(artifact.expectedSuccess) != null
      ? { expectedSuccess: readProbability(artifact.expectedSuccess) }
      : {}),
    ...(typeof expectedCostUsd === 'number' ? { expectedCostUsd } : {}),
    ...(readProbability(artifact.confidence) != null
      ? { confidence: readProbability(artifact.confidence) }
      : {}),
    ...(readNonNegativeNumber(signals?.riskScore) != null
      ? { riskScore: readNonNegativeNumber(signals?.riskScore) }
      : {}),
    ...(readString(signals?.taskType) ? { taskType: readString(signals?.taskType) } : {}),
    ...(readString(signals?.taskDifficulty) ? { taskDifficulty: readString(signals?.taskDifficulty) } : {}),
    ...(features.length > 0 ? { topFeatures: features.slice(0, 5) } : {}),
    ...(summarizeRationale(reasoning) ? { rationaleSummary: summarizeRationale(reasoning) } : {}),
  };

  return Object.keys(prediction).length > 0 ? prediction : undefined;
}

function readExpectedMetrics(artifact: Record<string, unknown>): Record<string, unknown> | undefined {
  const metrics: Record<string, unknown> = {};
  const nested = artifact.expectedMetrics;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    Object.assign(metrics, nested as Record<string, unknown>);
  }
  const keys = [
    'expectedSuccess',
    'expectedCost',
    'confidence',
    'expectedCostPlan',
    'expectedCostCode',
    'expectedCostReview',
    'neighborCount',
    'neighborSimilarityRange',
    'maxCostUsd',
    'challengeRecommendation',
    'exploration',
    'signals',
    'reasoning',
  ] as const;
  for (const key of keys) {
    if (typeof artifact[key] !== 'undefined') {
      metrics[key] = artifact[key];
    }
  }
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

function resolveArtifactPath(filePath: string): string {
  const cwd = resolve(process.cwd());
  const absolute = resolve(filePath);
  const rel = relative(cwd, absolute);
  return rel.startsWith('..') ? absolute : rel;
}

function parseBootstrapRouteArtifact(
  value: unknown,
  metadata?: { artifactPath?: string; artifactHash?: string },
): RouteArtifactSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const artifact = value as Record<string, unknown>;
  const coder = readString(artifact.coder);
  const codeDepth = readString(artifact.codeDepth);
  const reviewer = readString(artifact.reviewer);
  const reviewMode = readString(artifact.reviewMode ?? artifact.reviewRecommended);

  if (!coder || !codeDepth || !reviewer || !reviewMode) {
    return null;
  }

  return {
    coder,
    codeDepth,
    reviewer,
    reviewMode,
    harnessId: readString(artifact.harnessId),
    planDepth: readString(artifact.planDepth),
    planner: readString(artifact.planner),
    cache_hit: typeof artifact.cache_hit === 'boolean' ? artifact.cache_hit : undefined,
    route_source: artifact.route_source === 'batch' || artifact.route_source === 'single' || artifact.route_source === 'cache'
      ? artifact.route_source
      : undefined,
    packet_hash: typeof artifact.packet_hash === 'string' ? artifact.packet_hash : undefined,
    artifactPath: metadata?.artifactPath,
    artifactHash: metadata?.artifactHash,
    inputHash: readString((artifact.provenance as Record<string, unknown> | undefined)?.inputHash),
    source: readString((artifact.provenance as Record<string, unknown> | undefined)?.source) as RouteSource | undefined,
    routerMode: readString((artifact.provenance as Record<string, unknown> | undefined)?.routerMode) as RouteProvenance['routerMode'] | undefined,
    routingMode: readString(artifact.routingMode),
    expectedMetrics: readExpectedMetrics(artifact),
    challengeRecommendation: artifact.challengeRecommendation,
  };
}

function loadJson(filePath: string): { value: unknown; artifactPath: string; artifactHash: string } | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath);
    return {
      value: JSON.parse(raw.toString('utf-8')),
      artifactPath: resolveArtifactPath(filePath),
      artifactHash: createHash('sha256').update(raw).digest('hex'),
    };
  } catch {
    return null;
  }
}

function parseExpandedRouteArtifact(
  value: unknown,
  metadata?: { artifactPath?: string; artifactHash?: string },
): RouteArtifactSnapshot | null {
  if (value === null) {
    return null;
  }

  const validation = validateExpandedRouteArtifact(value);
  if (!validation.valid || !validation.normalized) {
    return null;
  }

  const artifact = value as Record<string, unknown>;
  return {
    ...validation.normalized,
    harnessId: readString(artifact.harnessId),
    planDepth: readString(artifact.planDepth),
    planner: readString(artifact.planner),
    cache_hit: typeof artifact.cache_hit === 'boolean' ? artifact.cache_hit : undefined,
    route_source: artifact.route_source === 'batch' || artifact.route_source === 'single' || artifact.route_source === 'cache'
      ? artifact.route_source
      : undefined,
    packet_hash: typeof artifact.packet_hash === 'string' ? artifact.packet_hash : undefined,
    artifactPath: metadata?.artifactPath,
    artifactHash: metadata?.artifactHash,
    inputHash: readString((artifact.provenance as Record<string, unknown> | undefined)?.inputHash),
    source: readString((artifact.provenance as Record<string, unknown> | undefined)?.source) as RouteSource | undefined,
    routerMode: readString((artifact.provenance as Record<string, unknown> | undefined)?.routerMode) as RouteProvenance['routerMode'] | undefined,
    routingMode: readString(artifact.routingMode),
    expectedMetrics: readExpectedMetrics(artifact),
    challengeRecommendation: artifact.challengeRecommendation,
  };
}

function loadBootstrapRouteArtifact(filePath: string): RouteArtifactSnapshot | null {
  const payload = loadJson(filePath);
  return payload ? parseBootstrapRouteArtifact(payload.value, payload) : null;
}

function loadExpandedRouteArtifact(filePath: string): RouteArtifactSnapshot | null {
  const payload = loadJson(filePath);
  return payload ? parseExpandedRouteArtifact(payload.value, payload) : null;
}

function loadPlanningLaunchRouteArtifact(filePath: string): RouteArtifactSnapshot | null {
  const payload = loadJson(filePath);
  if (!payload || !payload.value || typeof payload.value !== 'object' || Array.isArray(payload.value)) {
    return null;
  }

  const phaseConfig = payload.value as Record<string, unknown>;
  const planning = phaseConfig.planning && typeof phaseConfig.planning === 'object' && !Array.isArray(phaseConfig.planning)
    ? phaseConfig.planning as Record<string, unknown>
    : undefined;
  const launchRoute = planning?.launchRoute && typeof planning.launchRoute === 'object' && !Array.isArray(planning.launchRoute)
    ? planning.launchRoute as Record<string, unknown>
    : undefined;
  const route = launchRoute?.route && typeof launchRoute.route === 'object' && !Array.isArray(launchRoute.route)
    ? launchRoute.route as Record<string, unknown>
    : undefined;
  if (!planning || !launchRoute || !route) {
    return null;
  }

  const planner = readString(route.planner) ?? readString(launchRoute.planner) ?? readString(planning.model);
  if (!planner) {
    return null;
  }

  return {
    planner,
    planDepth: readString(route.planDepth) ?? readString(launchRoute.planDepth) ?? readString(planning.depth),
    coder: readString(route.coder) ?? '',
    codeDepth: readString(route.codeDepth) ?? '',
    reviewer: readString(route.reviewer) ?? '',
    reviewMode: readString(route.reviewMode) ?? '',
    artifactPath: payload.artifactPath,
    artifactHash: payload.artifactHash,
    source: readString(launchRoute.source) as RouteSource | undefined,
  };
}

export function readBothRouteArtifacts(featureDir: string): {
  bootstrap: RouteArtifactSnapshot | null;
  expanded: RouteArtifactSnapshot | null;
} {
  return {
    bootstrap: loadBootstrapRouteArtifact(join(featureDir, '.initial-route.json')),
    expanded: loadExpandedRouteArtifact(join(featureDir, '.post-expansion-route.json')),
  };
}

function firstSnapshot<T>(loaders: Array<() => T | null>): T | null {
  for (const load of loaders) {
    const value = load();
    if (value) {
      return value;
    }
  }
  return null;
}

export function readRouteLifecycleArtifacts(
  featureDir?: string,
  archiveDir?: string,
): RouteLifecycleArtifacts {
  // HOK-2891: archive keeps live basenames (dot prefix), so one name per
  // artifact class is probed in both branches. The live branch is first.
  const bootstrap = firstSnapshot([
    () => featureDir ? loadBootstrapRouteArtifact(join(featureDir, '.initial-route.json')) : null,
    () => archiveDir ? loadBootstrapRouteArtifact(join(archiveDir, '.initial-route.json')) : null,
  ]);
  const expanded = firstSnapshot([
    () => featureDir ? loadExpandedRouteArtifact(join(featureDir, '.post-expansion-route.json')) : null,
    () => featureDir ? loadExpandedRouteArtifact(join(featureDir, '.expanded-route.json')) : null,
    () => archiveDir ? loadExpandedRouteArtifact(join(archiveDir, '.post-expansion-route.json')) : null,
  ]);
  const active = firstSnapshot([
    () => featureDir ? loadBootstrapRouteArtifact(join(featureDir, '.routing-complete')) : null,
    () => archiveDir ? loadBootstrapRouteArtifact(join(archiveDir, '.routing-complete')) : null,
  ]);
  const planningLaunch = firstSnapshot([
    () => featureDir ? loadPlanningLaunchRouteArtifact(join(featureDir, '.phase-config.json')) : null,
  ]);

  return { bootstrap, expanded, active, planningLaunch };
}

export function toRouteArtifactView(route: RouteArtifactSnapshot): RouteArtifactView {
  return {
    coder: route.coder,
    codeDepth: route.codeDepth,
    reviewer: route.reviewer,
    reviewMode: route.reviewMode,
    ...(route.harnessId ? { harnessId: route.harnessId } : {}),
    ...(route.planner ? { planner: route.planner } : {}),
    ...(route.planDepth ? { planDepth: route.planDepth } : {}),
    ...(route.artifactPath ? { artifactPath: route.artifactPath } : {}),
    ...(route.artifactHash ? { artifactHash: route.artifactHash } : {}),
    ...(route.inputHash ? { inputHash: route.inputHash } : {}),
    ...(route.source ? { source: route.source } : {}),
    ...(typeof route.cache_hit === 'boolean' ? { cacheHit: route.cache_hit } : {}),
    ...(route.route_source ? { routeSource: route.route_source } : {}),
    ...(route.routerMode ? { routerMode: route.routerMode } : {}),
    ...(route.routingMode ? { routingMode: route.routingMode } : {}),
    ...(route.expectedMetrics ? { expectedMetrics: route.expectedMetrics } : {}),
  };
}

export function formatRouteArtifactSignature(route: RouteArtifactView | RouteArtifactSnapshot): string {
  return `coder=${route.coder},codeDepth=${route.codeDepth},reviewer=${route.reviewer},reviewMode=${route.reviewMode}`;
}

function modelClassOrId(modelId: string, repoDir?: string): string {
  const registry = getEffectiveRegistry(repoDir);
  return getModel(registry, modelId)?.class || modelId;
}

export function routeChangedMaterially(
  bootstrap: RouteArtifactSnapshot,
  expanded: RouteArtifactSnapshot,
  repoDir?: string,
): { changed: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (modelClassOrId(bootstrap.coder, repoDir) !== modelClassOrId(expanded.coder, repoDir)) {
    reasons.push('coder_class');
  }

  if (
    bootstrap.planner
    && expanded.planner
    && modelClassOrId(bootstrap.planner, repoDir) !== modelClassOrId(expanded.planner, repoDir)
  ) {
    reasons.push('planner_class');
  }

  if (bootstrap.planDepth && expanded.planDepth && bootstrap.planDepth !== expanded.planDepth) {
    reasons.push('plan_depth');
  }

  if (bootstrap.codeDepth !== expanded.codeDepth) {
    reasons.push('code_depth');
  }

  if (modelClassOrId(bootstrap.reviewer, repoDir) !== modelClassOrId(expanded.reviewer, repoDir)) {
    reasons.push('reviewer_class');
  }

  return {
    changed: reasons.length > 0,
    reasons,
  };
}

function routesMatchExactly(
  left: RouteArtifactSnapshot | null | undefined,
  right: RouteArtifactSnapshot | null | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }

  return left.coder === right.coder
    && left.codeDepth === right.codeDepth
    && (left.planner || '') === (right.planner || '')
    && (left.planDepth || '') === (right.planDepth || '')
    && left.reviewer === right.reviewer
    && left.reviewMode === right.reviewMode;
}

export function deriveRouteDecisionSource(
  artifacts: RouteLifecycleArtifacts,
  repoDir?: string,
): 'bootstrap' | 'expanded' | 'preserved' | undefined {
  const { bootstrap, expanded, active } = artifacts;

  if (!bootstrap && !expanded && !active) {
    return undefined;
  }

  if (!expanded) {
    return 'bootstrap';
  }

  if (!bootstrap) {
    return 'expanded';
  }

  if (active && routesMatchExactly(active, bootstrap) && !routesMatchExactly(active, expanded)) {
    return 'preserved';
  }

  if (active && routesMatchExactly(active, expanded)) {
    return routeChangedMaterially(bootstrap, expanded, repoDir).changed ? 'expanded' : 'preserved';
  }

  return routeChangedMaterially(bootstrap, expanded, repoDir).changed ? 'expanded' : 'preserved';
}

export function buildRouteLifecycleProvenance(
  artifacts: RouteLifecycleArtifacts,
  repoDir?: string,
): RouteLifecycleProvenance | null {
  const decisionSource = deriveRouteDecisionSource(artifacts, repoDir);
  if (!decisionSource) {
    return null;
  }

  const active = artifacts.active
    ?? (decisionSource === 'expanded' ? artifacts.expanded : artifacts.bootstrap)
    ?? artifacts.expanded
    ?? artifacts.bootstrap;
  const routeChanged = artifacts.bootstrap && active
    ? routeChangedMaterially(artifacts.bootstrap, active, repoDir).changed
    : undefined;
  const metadataCarrier = artifacts.expanded ?? active ?? undefined;

  return {
    ...(artifacts.bootstrap ? { bootstrapRoute: toRouteArtifactView(artifacts.bootstrap) } : {}),
    ...(artifacts.expanded ? { expandedRoute: toRouteArtifactView(artifacts.expanded) } : {}),
    ...(active ? { activeRoute: toRouteArtifactView(active) } : {}),
    ...(artifacts.planningLaunch ? { planningLaunchRoute: toRouteArtifactView(artifacts.planningLaunch) } : {}),
    ...(typeof routeChanged === 'boolean' ? { routeChanged } : {}),
    decisionSource,
    ...(typeof metadataCarrier?.cache_hit === 'boolean' ? { expandedCacheHit: metadataCarrier.cache_hit } : {}),
    ...(metadataCarrier?.packet_hash ? { packetHash: metadataCarrier.packet_hash } : {}),
    ...(metadataCarrier?.route_source ? { routeSource: metadataCarrier.route_source } : {}),
    ...(metadataCarrier?.routerMode ? { routerMode: metadataCarrier.routerMode } : {}),
    ...(metadataCarrier?.routingMode ? { routingMode: metadataCarrier.routingMode } : {}),
    ...(metadataCarrier?.artifactPath ? { artifactPath: metadataCarrier.artifactPath } : {}),
    ...(metadataCarrier?.artifactHash ? { artifactHash: metadataCarrier.artifactHash } : {}),
  };
}

export function hasValidPostExpansionRoute(routeDir: string): { ok: boolean; reason?: string } {
  const routePath = join(routeDir, '.post-expansion-route.json');
  if (!existsSync(routePath)) {
    return { ok: false, reason: 'missing' };
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(routePath, 'utf-8'));
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }

  const validation = validateExpandedRouteArtifact(value);
  if (!validation.valid) {
    const fields = validation.missing.length > 0
      ? validation.missing.join(',')
      : validation.invalid.join(',');
    return { ok: false, reason: `missing-required-field:${fields}` };
  }

  return { ok: true };
}
