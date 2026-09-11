import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildTrustMetadata } from '../provenance.ts';

import { gatherCodebaseContext } from '../../codebase-context-gatherer.ts';
import {
  expandIssue as expandIssueImpl,
  formatIssueContext,
  type ExpandIssueResult as IssueExpanderResult,
} from '../../issue-expander.ts';
import { getCurrentOperatingMode } from '../../operating-mode.ts';
import { loadPromptTemplate } from '../../prompt-utils.ts';
import { resolveWavemillPromptPath } from '../install-paths.ts';
import { formatReviewResult } from '../../review-formatter.ts';
import {
  reviewChanges,
  type ReviewOptions,
  type ReviewResult,
} from '../../review-runner.ts';
import { routeBatch } from '../../route-batch.ts';
import {
  getResultFilePath,
  readStageResult,
  updateStageResult,
  writeStageResult,
  type StageName,
  type StageResult,
  type StageStatus,
} from '../../stage-result.ts';
import {
  splitTaskPacket,
  writeTaskPacketArtifacts,
  type TaskPacketParts,
} from '../../task-packet-utils.ts';
import {
  enforceNetworkPolicy,
  type NetworkDeniedDiagnostics,
  type NetworkPolicy,
} from '../network-policy.ts';
import {
  type ReviewChangesResult,
  type RouteTaskResult,
  type WavemillRouteRef,
  type WavemillStageResultRef,
  type WorkflowPhase,
  type WriteStageResultResult,
} from './contracts.ts';
import {
  writeStageResultKey,
  type DedupeRecord,
  type DedupeRegistry,
} from './dedupe.ts';
import { executeExpandIssue, type ExpanderFn } from './linear-tools.ts';
import {
  type WorkflowToolStageArtifactEntry,
  type WorkflowToolTranscriptEvent,
} from './linear-tools.ts';
import { isMutationAllowed } from './mutation-policy.ts';
import { getCurrentBranch } from '../../review-context-gatherer.ts';
import {
  buildExecutedIdentity,
  loadChallengeIntentFromFeatureDir,
  resolveChallengedStageIntent,
} from '../../challenge-execution-contract.ts';

export interface CommandToolsDeps {
  registry: DedupeRegistry;
  transcript: { append(event: WorkflowToolTranscriptEvent): void };
  stageArtifact: { append(entry: WorkflowToolStageArtifactEntry): void };
  sessionId: string;
  phase: WorkflowPhase;
  repoDir?: string;
  clock?: () => number;
  agentName?: string;
  modelName?: string;
  expander?: ExpanderFn;
  reviewChangesImpl?: (options: ReviewOptions) => Promise<ReviewResult>;
  routeBatchImpl?: typeof routeBatch;
  readFileImpl?: typeof readFile;
  readStageResultImpl?: typeof readStageResult;
  writeStageResultImpl?: typeof writeStageResult;
  updateStageResultImpl?: typeof updateStageResult;
  networkPolicy?: NetworkPolicy;
}

export interface DefaultExpanderOptions {
  repoDir: string;
  loadPromptTemplateImpl?: typeof loadPromptTemplate;
  expandIssueImpl?: typeof expandIssueImpl;
  formatIssueContextImpl?: typeof formatIssueContext;
  gatherCodebaseContextImpl?: typeof gatherCodebaseContext;
  getOperatingModeImpl?: typeof getCurrentOperatingMode;
  splitTaskPacketImpl?: (text: string) => TaskPacketParts;
  writeTaskPacketArtifactsImpl?: typeof writeTaskPacketArtifacts;
  resolvePromptPath?: (repoDir: string) => string;
  resolveOutputPath?: (issue: string, outputDir?: string) => string;
  getIssueContext?: (issue: string) => Promise<{ identifier: string; title: string; description?: string } & Record<string, unknown>>;
}

const DEFAULT_AGENT_NAME = 'native-runtime';
const DEFAULT_MODEL_NAME = 'native-runtime';

function now(deps: Pick<CommandToolsDeps, 'clock'>): number {
  return deps.clock ? deps.clock() : Date.now();
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex').slice(0, 16);
}

function serializePayload(input: {
  status: StageStatus;
  notes: string;
  artifacts?: Record<string, unknown>;
  failureReason?: string | null;
}): string {
  return JSON.stringify({
    status: input.status,
    notes: input.notes,
    artifacts: input.artifacts ?? null,
    failureReason: input.failureReason ?? null,
  });
}

function payloadHash(input: {
  status: StageStatus;
  notes: string;
  artifacts?: Record<string, unknown>;
  failureReason?: string | null;
}): string {
  return createHash('sha256').update(serializePayload(input), 'utf8').digest('hex').slice(0, 16);
}

function payloadReason(hash: string): string {
  return `payload_hash:${hash}`;
}

function extractPayloadHash(reason?: string): string | null {
  if (!reason?.startsWith('payload_hash:')) {
    return null;
  }
  return reason.slice('payload_hash:'.length);
}

function normalizeReviewFindings(
  result: ReviewResult,
  json: boolean | undefined,
  maxOutputBytes: number | undefined,
): string {
  const text = json
    ? JSON.stringify(result, null, 2)
    : formatReviewResult(result, false);
  if (!Number.isInteger(maxOutputBytes) || (maxOutputBytes ?? 0) <= 0) {
    return text;
  }
  return Buffer.byteLength(text, 'utf8') <= maxOutputBytes
    ? text
    : Buffer.from(text, 'utf8').subarray(0, maxOutputBytes).toString('utf8');
}

function countFindings(result: ReviewResult): { findingCount: number; blockingCount: number } {
  const findings = [...result.codeReviewFindings, ...(result.uiFindings ?? [])];
  return {
    findingCount: findings.length,
    blockingCount: findings.filter((finding) => finding.severity === 'blocker').length,
  };
}

function resolveRepoDir(paramsRepoDir: string | undefined, depsRepoDir: string | undefined): string {
  return path.resolve(paramsRepoDir ?? depsRepoDir ?? process.cwd());
}

function actionDetails(input: {
  command: string;
  invocation: Record<string, unknown>;
  outcome: 'success' | 'error' | 'denied';
  diagnostics?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    command: input.command,
    invocation: input.invocation,
    outcome: input.outcome,
    diagnostics: input.diagnostics ?? {},
  };
}

function networkDeniedResult<T extends ReviewChangesResult | RouteTaskResult>(input: {
  tool: 'review_changes' | 'route_task';
  phase: WorkflowPhase;
  action: 'read';
  at: number;
  target: string;
  invocation: Record<string, unknown>;
  diagnostics: NetworkDeniedDiagnostics;
  deps: Pick<CommandToolsDeps, 'transcript'>;
}): T {
  input.deps.transcript.append({
    type: 'workflow_tool_call',
    tool: input.tool,
    phase: input.phase,
    action: input.action,
    details: actionDetails({
      command: input.tool,
      invocation: input.invocation,
      outcome: 'denied',
      diagnostics: {
        error: 'policy_denied',
        message: `Network access denied for ${input.tool}`,
        ...input.diagnostics,
      },
    }),
    at: input.at,
  });
  const reviewFailure = input.tool === 'review_changes'
    ? {
        exitCode: 2,
        verdict: 'error' as const,
        iterations: 1,
        blockerCount: 0,
        warningCount: 0,
      }
    : {};
  return {
    ok: false,
    tool: input.tool,
    error: 'policy_denied',
    message: `Network access denied for ${input.tool} in ${input.phase} phase: ${input.diagnostics.reason}`,
    diagnostics: input.diagnostics,
    ...reviewFailure,
  } as T;
}

function toStageResultRef(featureDir: string, stage: StageName): WavemillStageResultRef {
  return {
    system: 'wavemill',
    kind: 'stage_result',
    id: getResultFilePath(featureDir, stage),
  };
}

function routeRefFromDecision(decision: Record<string, unknown>): WavemillRouteRef {
  return {
    system: 'wavemill',
    kind: 'route',
    id: `route:${stableHash(decision)}`,
  };
}

function mapRouteDecision(decision: {
  coder: string;
  routingMode?: string;
  reasoning: string[];
  signals: { taskType: string };
}): RouteTaskResult {
  const ref = routeRefFromDecision(decision as Record<string, unknown>);
  return {
    ok: true,
    tool: 'route_task',
    route: {
      model: decision.coder,
      mode: decision.routingMode ?? decision.signals.taskType,
      rationale: decision.reasoning.join('\n'),
    },
    ref,
  };
}

function stageResultBody(
  params: {
    stage: StageName;
    status: StageStatus;
    notes?: string;
    artifacts?: Record<string, unknown>;
  },
  deps: CommandToolsDeps,
  existing: StageResult | null,
  isoNow: string,
): StageResult {
  const isTerminal = params.status === 'completed' || params.status === 'aborted' || params.status === 'failed';
  return {
    stage: params.stage,
    status: params.status,
    startedAt: existing?.startedAt ?? isoNow,
    finishedAt: isTerminal ? isoNow : null,
    agent: existing?.agent || deps.agentName || DEFAULT_AGENT_NAME,
    model: existing?.model || deps.modelName || DEFAULT_MODEL_NAME,
    notes: params.notes ?? '',
    ...(params.artifacts !== undefined ? { artifacts: params.artifacts as StageResult['artifacts'] } : {}),
    ...(existing?.failureReason !== undefined ? { failureReason: existing.failureReason } : {}),
  };
}

function classifyIoError(error: unknown): 'io_error' | 'route_failed' {
  if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code) {
    return 'io_error';
  }
  return 'route_failed';
}

/**
 * Build the orchestrator + substantive-analysis identity pair for one
 * `review_changes` call (HOK-2969, Arbiter P2.4f).
 *
 * The orchestrator is this calling agent (`deps.modelName`/`deps.agentName`)
 * — the "outer" identity per the reviewer-execution-identity contract.
 * The substantive-analysis identity is bubbled up from whatever
 * `review-runner.ts`/`review-engine.ts` actually resolved for the internal
 * analysis call; a defensive fallback covers test doubles that stub
 * `reviewChangesImpl` without setting it, so `executedIdentity` is never
 * fabricated as trustworthy when the real producer did not run.
 */
function buildReviewExecutedIdentity(input: {
  params: { featureDir?: string };
  deps: CommandToolsDeps;
  repoDir: string;
  reviewResult: ReviewResult;
}): { orchestrator: ReturnType<typeof buildExecutedIdentity>; substantiveAnalysis: ReturnType<typeof buildExecutedIdentity> } {
  const orchestratorModel = input.deps.modelName || DEFAULT_MODEL_NAME;
  const orchestratorAgent = input.deps.agentName || DEFAULT_AGENT_NAME;

  // Only resolve the current branch (a git shell-out) when a review-stage
  // challenge intent actually exists to pin against — most runs (and most
  // unit tests, which use non-git temp directories) have none, and this
  // avoids noisy git-not-found errors on every call (HOK-2969).
  const intent = input.params.featureDir ? loadChallengeIntentFromFeatureDir(input.params.featureDir) : undefined;
  let requestedModel: string | undefined;
  if (intent && input.params.featureDir) {
    try {
      const challenged = resolveChallengedStageIntent({
        repoDir: input.repoDir,
        featureDir: input.params.featureDir,
        branchName: getCurrentBranch(input.repoDir),
        stage: 'review',
      });
      requestedModel = challenged?.model;
    } catch {
      // Branch resolution can fail outside a git worktree; fall through with
      // no pin rather than fail the review call.
      requestedModel = undefined;
    }
  }

  const orchestrator = buildExecutedIdentity({
    role: 'review_orchestrator',
    requestedModel: requestedModel ?? orchestratorModel,
    resolvedModel: orchestratorModel,
    agent: orchestratorAgent,
    source: 'route',
  });

  const substantiveAnalysis = input.reviewResult.substantiveAnalysisIdentity ?? buildExecutedIdentity({
    role: 'substantive_analysis',
    requestedModel: requestedModel ?? orchestratorModel,
    resolvedModel: orchestratorModel,
    agent: orchestratorAgent,
    source: 'unknown',
  });

  return { orchestrator, substantiveAnalysis };
}

export async function executeReviewChanges(
  params: {
    base: string;
    worktree?: string;
    json?: boolean;
    maxOutputBytes?: number;
    featureDir?: string;
    additionalContext?: string;
  },
  deps: CommandToolsDeps,
): Promise<ReviewChangesResult> {
  const ts = now(deps);
  const phase = deps.phase;
  const policy = isMutationAllowed(phase, 'review_changes', 'read');

  if (!policy.allowed) {
    const result: ReviewChangesResult = {
      ok: false,
      tool: 'review_changes',
      error: 'policy_denied',
      message: policy.reason,
      exitCode: 2,
      verdict: 'error',
      iterations: 1,
      blockerCount: 0,
      warningCount: 0,
      metadata: { trust: buildTrustMetadata({ sourceKind: 'wavemill_artifact', details: policy.reason }) },
    };
    deps.transcript.append({
      type: 'workflow_tool_call',
      tool: 'review_changes',
      phase,
      action: 'read',
      details: actionDetails({
        command: 'review_changes',
        invocation: { base: params.base, worktree: params.worktree ?? null, json: !!params.json },
        outcome: 'denied',
        diagnostics: { error: 'policy_denied', message: policy.reason },
      }),
      at: ts,
    });
    return result;
  }

  const network = enforceNetworkPolicy({
    policy: deps.networkPolicy,
    phase,
    tool: 'review_changes',
    target: 'command:review_changes',
  });
  if (network.kind === 'deny') {
    return networkDeniedResult<ReviewChangesResult>({
      tool: 'review_changes',
      phase,
      action: 'read',
      at: ts,
      target: 'command:review_changes',
      invocation: { base: params.base, worktree: params.worktree ?? null, json: !!params.json },
      diagnostics: network.diagnostics,
      deps,
    });
  }

  const repoDir = resolveRepoDir(params.worktree, deps.repoDir);
  const reviewImpl = deps.reviewChangesImpl ?? reviewChanges;

  try {
    const reviewResult = await reviewImpl({
      targetBranch: params.base,
      repoDir,
      featureDir: params.featureDir,
      additionalContext: params.additionalContext,
    });
    const counts = countFindings(reviewResult);
    const findings = normalizeReviewFindings(reviewResult, params.json, params.maxOutputBytes);
    const executedIdentity = buildReviewExecutedIdentity({ params, deps, repoDir, reviewResult });
    const result: ReviewChangesResult = {
      ok: true,
      tool: 'review_changes',
      findings,
      findingCount: counts.findingCount,
      blockingCount: counts.blockingCount,
      exitCode: 0,
      verdict: reviewResult.verdict,
      iterations: 1,
      blockerCount: counts.blockingCount,
      warningCount: Math.max(0, counts.findingCount - counts.blockingCount),
      failureCategory: reviewResult.failureCategory,
      ...(executedIdentity ? { executedIdentity } : {}),
      metadata: { trust: buildTrustMetadata({ sourceKind: 'wavemill_artifact', details: findings }) },
    };
    deps.transcript.append({
      type: 'workflow_tool_call',
      tool: 'review_changes',
      phase,
      action: 'read',
      details: actionDetails({
        command: 'review_changes',
        invocation: { base: params.base, repoDir, json: !!params.json },
        outcome: 'success',
        diagnostics: {
          verdict: reviewResult.verdict,
          findingCount: counts.findingCount,
          blockingCount: counts.blockingCount,
          needsStrongerReviewer: reviewResult.needsStrongerReviewer ?? false,
        },
      }),
      at: ts,
    });
    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const result: ReviewChangesResult = {
      ok: false,
      tool: 'review_changes',
      error: 'review_failed',
      message,
      exitCode: 2,
      verdict: 'error',
      iterations: 1,
      blockerCount: 0,
      warningCount: 0,
      diagnostics: { error: 'review_failed', message },
      metadata: { trust: buildTrustMetadata({ sourceKind: 'wavemill_artifact', details: message }) },
    };
    deps.transcript.append({
      type: 'workflow_tool_call',
      tool: 'review_changes',
      phase,
      action: 'read',
      details: actionDetails({
        command: 'review_changes',
        invocation: { base: params.base, repoDir, json: !!params.json },
        outcome: 'error',
        diagnostics: { error: 'review_failed', message },
      }),
      at: ts,
    });
    return result;
  }
}

export async function executeRouteTask(
  params: { taskPacketPath: string; repoDir?: string; routeMode?: string; modelsAvailable?: string[] },
  deps: CommandToolsDeps,
): Promise<RouteTaskResult> {
  const ts = now(deps);
  const phase = deps.phase;
  const policy = isMutationAllowed(phase, 'route_task', 'read');

  if (!policy.allowed) {
    const result: RouteTaskResult = {
      ok: false,
      tool: 'route_task',
      error: 'policy_denied',
      message: policy.reason,
      metadata: { trust: buildTrustMetadata({ sourceKind: 'wavemill_artifact', details: policy.reason }) },
    };
    deps.transcript.append({
      type: 'workflow_tool_call',
      tool: 'route_task',
      phase,
      action: 'read',
      details: actionDetails({
        command: 'route_task',
        invocation: {
          taskPacketPath: params.taskPacketPath,
          routeMode: params.routeMode ?? null,
          modelsAvailable: params.modelsAvailable ?? null,
        },
        outcome: 'denied',
        diagnostics: { error: 'policy_denied', message: policy.reason },
      }),
      at: ts,
    });
    return result;
  }

  const network = enforceNetworkPolicy({
    policy: deps.networkPolicy,
    phase,
    tool: 'route_task',
    target: 'command:route_task',
  });
  if (network.kind === 'deny') {
    return networkDeniedResult<RouteTaskResult>({
      tool: 'route_task',
      phase,
      action: 'read',
      at: ts,
      target: 'command:route_task',
      invocation: {
        taskPacketPath: params.taskPacketPath,
        routeMode: params.routeMode ?? null,
        modelsAvailable: params.modelsAvailable ?? null,
      },
      diagnostics: network.diagnostics,
      deps,
    });
  }

  const repoDir = resolveRepoDir(params.repoDir, deps.repoDir);
  const readFileImpl = deps.readFileImpl ?? readFile;
  const routeBatchImpl = deps.routeBatchImpl ?? routeBatch;

  try {
    const prompt = await readFileImpl(params.taskPacketPath, 'utf8');
    const [routed] = await routeBatchImpl(
      [{ prompt, file: params.taskPacketPath, source: 'expanded', inputKind: 'task-packet' }],
      {
        repoDir,
        mode: (params.routeMode as 'auto' | 'stage-aware' | 'heuristic' | 'hokusai' | undefined) ?? 'auto',
        modelsAvailable: params.modelsAvailable,
      },
    );
    if (!routed?.decision) {
      throw new Error('Routing returned no decision');
    }
    const result = mapRouteDecision(routed.decision);
    result.metadata = {
      trust: buildTrustMetadata({ sourceKind: 'wavemill_artifact', details: routed.decision }),
    };
    deps.transcript.append({
      type: 'workflow_tool_call',
      tool: 'route_task',
      phase,
      action: 'read',
      details: actionDetails({
        command: 'route_task',
        invocation: {
          taskPacketPath: params.taskPacketPath,
          repoDir,
          routeMode: params.routeMode ?? 'auto',
          modelsAvailable: params.modelsAvailable ?? null,
        },
        outcome: 'success',
        diagnostics: {
          routeDecision: routed.decision,
          routeRef: result.ref ?? null,
        },
      }),
      at: ts,
    });
    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = classifyIoError(error);
    const result: RouteTaskResult = {
      ok: false,
      tool: 'route_task',
      error: errorCode,
      message,
      metadata: { trust: buildTrustMetadata({ sourceKind: 'wavemill_artifact', details: message }) },
    };
    deps.transcript.append({
      type: 'workflow_tool_call',
      tool: 'route_task',
      phase,
      action: 'read',
      details: actionDetails({
        command: 'route_task',
        invocation: {
          taskPacketPath: params.taskPacketPath,
          repoDir,
          routeMode: params.routeMode ?? 'auto',
          modelsAvailable: params.modelsAvailable ?? null,
        },
        outcome: 'error',
        diagnostics: { error: errorCode, message },
      }),
      at: ts,
    });
    return result;
  }
}

export async function executeWriteStageResult(
  params: {
    featureDir: string;
    issueId: string;
    stage: StageName;
    status: StageStatus;
    notes?: string;
    artifacts?: Record<string, unknown>;
  },
  deps: CommandToolsDeps,
): Promise<WriteStageResultResult> {
  const ts = now(deps);
  const phase = deps.phase;
  const policy = isMutationAllowed(phase, 'write_stage_result', 'write_stage_result');
  const key = writeStageResultKey({
    issueOrFeature: params.issueId || params.featureDir,
    stage: params.stage,
    status: params.status,
  });

  if (!policy.allowed) {
    const result: WriteStageResultResult = {
      ok: false,
      tool: 'write_stage_result',
      error: 'policy_denied',
      message: policy.reason,
      metadata: { trust: buildTrustMetadata({ sourceKind: 'wavemill_artifact', details: policy.reason }) },
    };
    const idempotency = { key, outcome: 'skipped' as const, ref: null, reason: policy.reason };
    const details = actionDetails({
      command: 'write_stage_result',
      invocation: { featureDir: params.featureDir, issueId: params.issueId, stage: params.stage, status: params.status },
      outcome: 'denied',
      diagnostics: { error: 'policy_denied', message: policy.reason },
    });
    deps.transcript.append({
      type: 'workflow_tool_call',
      tool: 'write_stage_result',
      phase,
      action: 'write_stage_result',
      details,
      idempotency,
      at: ts,
    });
    deps.stageArtifact.append({
      tool: 'write_stage_result',
      phase,
      details,
      idempotency,
      at: ts,
    });
    return result;
  }

  const readStageResultImpl = deps.readStageResultImpl ?? readStageResult;
  const writeStageResultImpl = deps.writeStageResultImpl ?? writeStageResult;
  const updateStageResultImpl = deps.updateStageResultImpl ?? updateStageResult;
  const payload = {
    status: params.status,
    notes: params.notes ?? '',
    artifacts: params.artifacts,
    failureReason: null,
  };
  const hash = payloadHash(payload);
  const existingRecord = deps.registry.get(key);
  const existingHash = extractPayloadHash(existingRecord?.reason);

  try {
    const existing = await readStageResultImpl(params.featureDir, params.stage);
    const ref = toStageResultRef(params.featureDir, params.stage);
    let outcome: 'created' | 'reused' | 'updated';

    if (existingRecord && existing && existingHash === hash) {
      outcome = 'reused';
    } else if (existing) {
      outcome = 'updated';
      const body = stageResultBody(params, deps, existing, new Date(ts).toISOString());
      await updateStageResultImpl(params.featureDir, params.stage, body);
    } else {
      outcome = 'created';
      const body = stageResultBody(params, deps, null, new Date(ts).toISOString());
      await writeStageResultImpl(params.featureDir, body);
    }

    const rec: DedupeRecord<WavemillStageResultRef> = {
      key,
      outcome,
      ref,
      reason: payloadReason(hash),
    };
    deps.registry.record(key, rec);
    const idempotency = { key, outcome, ref, reason: payloadReason(hash) };
    const details = actionDetails({
      command: 'write_stage_result',
      invocation: { featureDir: params.featureDir, issueId: params.issueId, stage: params.stage, status: params.status },
      outcome: 'success',
      diagnostics: { resultPath: ref.id, payloadHash: hash },
    });
    deps.transcript.append({
      type: 'workflow_tool_call',
      tool: 'write_stage_result',
      phase,
      action: 'write_stage_result',
      details,
      idempotency,
      at: ts,
    });
    deps.stageArtifact.append({
      tool: 'write_stage_result',
      phase,
      details,
      idempotency,
      at: ts,
    });
    return {
      ok: true,
      tool: 'write_stage_result',
      idempotency,
      metadata: { trust: buildTrustMetadata({ sourceKind: 'wavemill_artifact', details: { ref, outcome, hash } }) },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const result: WriteStageResultResult = {
      ok: false,
      tool: 'write_stage_result',
      error: 'io_error',
      message,
      metadata: { trust: buildTrustMetadata({ sourceKind: 'wavemill_artifact', details: message }) },
    };
    const idempotency = { key, outcome: 'skipped' as const, ref: null, reason: payloadReason(hash) };
    const details = actionDetails({
      command: 'write_stage_result',
      invocation: { featureDir: params.featureDir, issueId: params.issueId, stage: params.stage, status: params.status },
      outcome: 'error',
      diagnostics: { error: 'io_error', message, payloadHash: hash },
    });
    deps.transcript.append({
      type: 'workflow_tool_call',
      tool: 'write_stage_result',
      phase,
      action: 'write_stage_result',
      details,
      idempotency,
      at: ts,
    });
    deps.stageArtifact.append({
      tool: 'write_stage_result',
      phase,
      details,
      idempotency,
      at: ts,
    });
    return result;
  }
}

export function createDefaultExpander(options: DefaultExpanderOptions): ExpanderFn {
  const loadPromptTemplateImpl = options.loadPromptTemplateImpl ?? loadPromptTemplate;
  const formatIssueContextImpl = options.formatIssueContextImpl ?? formatIssueContext;
  const expandIssueDelegate = options.expandIssueImpl ?? expandIssueImpl;
  const gatherCodebaseContextImpl = options.gatherCodebaseContextImpl ?? gatherCodebaseContext;
  const getOperatingModeImpl = options.getOperatingModeImpl ?? getCurrentOperatingMode;
  const splitTaskPacketImpl = options.splitTaskPacketImpl ?? splitTaskPacket;
  const writeTaskPacketArtifactsImpl = options.writeTaskPacketArtifactsImpl ?? writeTaskPacketArtifacts;
  // tools/prompts/ is wavemill-owned and ships with the installation. The
  // non-native path already resolves it install-relative via
  // resolvePromptPath(import.meta.url, ...) in tools/expand-issue.ts; this
  // resolved it against the repo being worked on, which only exists when
  // wavemill drives itself.
  const resolvePromptPath = options.resolvePromptPath
    ?? (() => resolveWavemillPromptPath('issue-writer.md'));
  const resolveOutputPath = options.resolveOutputPath
    ?? ((issue: string, outputDir?: string) => path.join(outputDir ?? path.join(options.repoDir, 'features', issue.toLowerCase()), 'task-packet.md'));

  return async (req) => {
    if (!options.getIssueContext) {
      throw new Error('createDefaultExpander requires getIssueContext');
    }

    const issue = await options.getIssueContext(req.issue);
    const repoDir = path.resolve(options.repoDir);
    const promptTemplate = await loadPromptTemplateImpl(resolvePromptPath(repoDir));
    const issueContext = formatIssueContextImpl(issue);
    const codebaseContext = await gatherCodebaseContextImpl({
      repoPath: repoDir,
      issueTitle: issue.title,
      issueDescription: issue.description ?? '',
    });
    const operatingMode = getOperatingModeImpl(repoDir);
    const expanded = await expandIssueDelegate({
      promptTemplate,
      issueContext,
      codebaseContext,
      mode: operatingMode,
      repoDir,
      issueId: issue.identifier,
    });
    const outputFile = resolveOutputPath(req.issue, req.outputDir);
    const parts = splitTaskPacketImpl((expanded as IssueExpanderResult).text);
    await writeTaskPacketArtifactsImpl(outputFile, parts);
    return outputFile;
  };
}

export function createCommandTools(deps: CommandToolsDeps) {
  return {
    reviewChanges: (params: { base: string; worktree?: string; json?: boolean; maxOutputBytes?: number }) =>
      executeReviewChanges(params, deps),
    routeTask: (params: { taskPacketPath: string; repoDir?: string; routeMode?: string; modelsAvailable?: string[] }) =>
      executeRouteTask(params, deps),
    expandIssue: (params: { issue: string; outputDir?: string }) =>
      executeExpandIssue(params, deps),
    writeStageResult: (params: {
      featureDir: string;
      issueId: string;
      stage: StageName;
      status: StageStatus;
      notes?: string;
      artifacts?: Record<string, unknown>;
    }) => executeWriteStageResult(params, deps),
  };
}
