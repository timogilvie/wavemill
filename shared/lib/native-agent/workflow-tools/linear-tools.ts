/**
 * Linear-facing native workflow tool executors (HOK-2356).
 *
 * Implements linear_get_issue, linear_comment, and expand_issue on top of the
 * contracts, policy matrix, and dedupe-key helpers from HOK-2355.
 *
 * All three tools are created via factory functions that accept injectable
 * dependencies so tests can supply fakes without hitting the network.
 */

import { createHash } from 'node:crypto';
import { buildTrustMetadata } from '../provenance.ts';
import {
  enforceNetworkPolicy,
  type NetworkDeniedDiagnostics,
  type NetworkPolicy,
} from '../network-policy.ts';
import {
  type WorkflowPhase,
  type LinearGetIssueResult,
  type LinearCommentResult,
  type ExpandIssueResult,
  type LinearCommentRef,
  type WavemillTaskPacketRef,
} from './contracts.ts';
import { getRedactionConfig } from '../../config.ts';
import { buildProfileFromConfig, redact } from '../../redaction-profiles.ts';
import { isMutationAllowed } from './mutation-policy.ts';
import { resolveLinearWriteTarget } from '../../linear-write-gate.ts';
import type { TaskIdentityMeta } from '../../task-identity.ts';
import {
  linearCommentKey,
  expandIssueKey,
  type DedupeRegistry,
  type DedupeRecord,
} from './dedupe.ts';

// ---------------------------------------------------------------------------
// Observable transcript + stage-artifact seams
// ---------------------------------------------------------------------------

export interface WorkflowToolTranscriptEvent {
  type: 'workflow_tool_call';
  tool: string;
  phase: WorkflowPhase;
  action: string;
  details?: Record<string, unknown>;
  idempotency?: {
    key: string;
    outcome: string;
    ref: { system: string; kind: string; id: string; url?: string } | null;
  };
  at: number;
}

export interface WorkflowToolStageArtifactEntry {
  tool: string;
  phase: WorkflowPhase;
  details?: Record<string, unknown>;
  idempotency: {
    key: string;
    outcome: string;
    ref: { system: string; kind: string; id: string; url?: string } | null;
  };
  at: number;
}

// ---------------------------------------------------------------------------
// Injectable Linear client interface
// ---------------------------------------------------------------------------

export interface LinearIssueData {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  state?: { name: string } | string;
  assignee?: { name: string; email?: string } | string;
  labels?: { nodes: Array<{ id: string; name: string }> } | string[];
  url?: string;
}

export interface LinearCommentData {
  id: string;
  url: string;
}

export interface LinearClient {
  getIssue(identifier: string): Promise<LinearIssueData>;
  createComment(issueId: string, body: string): Promise<LinearCommentData>;
  updateComment(commentId: string, body: string): Promise<LinearCommentData>;
}

// ---------------------------------------------------------------------------
// Expansion context injected into expand_issue
// ---------------------------------------------------------------------------

export interface ExpansionContext {
  sessionId: string;
  phase: WorkflowPhase;
  outputDir?: string;
}

export type ExpanderFn = (req: { issue: string; outputDir?: string }, ctx: ExpansionContext) => Promise<string>;

// ---------------------------------------------------------------------------
// Tool factory deps
// ---------------------------------------------------------------------------

export interface LinearToolsDeps {
  client: LinearClient;
  registry: DedupeRegistry;
  transcript: { append(event: WorkflowToolTranscriptEvent): void };
  stageArtifact: { append(entry: WorkflowToolStageArtifactEntry): void };
  sessionId: string;
  phase: WorkflowPhase;
  expander?: ExpanderFn;
  clock?: () => number;
  networkPolicy?: NetworkPolicy;
  getSecretEnvNames?: () => string[];
  /**
   * Task metadata for the linear_comment identity gate. Omitted: read from
   * the workflow-state file (see linear-write-gate.ts).
   */
  taskMeta?: TaskIdentityMeta | null;
}

export interface ExpandIssueDeps {
  registry: DedupeRegistry;
  transcript: { append(event: WorkflowToolTranscriptEvent): void };
  stageArtifact: { append(entry: WorkflowToolStageArtifactEntry): void };
  sessionId: string;
  phase: WorkflowPhase;
  expander?: ExpanderFn;
  clock?: () => number;
  networkPolicy?: NetworkPolicy;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(deps: Pick<LinearToolsDeps, 'clock'>): number {
  return deps.clock ? deps.clock() : Date.now();
}

/** Trim and collapse interior whitespace for stable body hashing. */
function normalizeBody(body: string): string {
  return body.trim().replace(/\s+/g, ' ');
}

function shortHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function flattenState(state: LinearIssueData['state']): string | undefined {
  if (!state) return undefined;
  if (typeof state === 'string') return state;
  return state.name;
}

function flattenAssignee(assignee: LinearIssueData['assignee']): string | undefined {
  if (!assignee) return undefined;
  if (typeof assignee === 'string') return assignee;
  return assignee.name;
}

function flattenLabels(labels: LinearIssueData['labels']): string[] | undefined {
  if (!labels) return undefined;
  if (Array.isArray(labels)) return labels as string[];
  return labels.nodes.map(l => l.name);
}

function actionDetails(input: {
  target: string;
  outcome: 'success' | 'error' | 'denied';
  diagnostics?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    target: input.target,
    outcome: input.outcome,
    diagnostics: input.diagnostics ?? {},
  };
}

function appendLinearDeniedRecord(
  deps: Pick<LinearToolsDeps, 'transcript' | 'stageArtifact'>,
  input: {
    tool: 'linear_comment';
    phase: WorkflowPhase;
    action: 'comment';
    at: number;
    key: string;
    diagnostics: NetworkDeniedDiagnostics;
  },
): void;
function appendLinearDeniedRecord(
  deps: Pick<LinearToolsDeps, 'transcript'>,
  input: {
    tool: 'linear_get_issue' | 'expand_issue';
    phase: WorkflowPhase;
    action: 'read';
    at: number;
    target: string;
    diagnostics: NetworkDeniedDiagnostics;
  },
): void;
function appendLinearDeniedRecord(
  deps: Pick<LinearToolsDeps, 'transcript' | 'stageArtifact'>,
  input: {
    tool: 'linear_get_issue' | 'linear_comment' | 'expand_issue';
    phase: WorkflowPhase;
    action: 'read' | 'comment';
    at: number;
    target?: string;
    key?: string;
    diagnostics: NetworkDeniedDiagnostics;
  },
): void {
  const target = input.target ?? input.diagnostics.target;
  deps.transcript.append({
    type: 'workflow_tool_call',
    tool: input.tool,
    phase: input.phase,
    action: input.action,
    details: actionDetails({
      target,
      outcome: 'denied',
      diagnostics: {
        error: 'policy_denied',
        message: `Network access denied for ${input.tool}`,
        ...input.diagnostics,
      },
    }),
    at: input.at,
  });
  if (input.tool === 'linear_comment' && 'stageArtifact' in deps) {
    deps.stageArtifact.append({
      tool: input.tool,
      phase: input.phase,
      details: actionDetails({
        target,
        outcome: 'denied',
        diagnostics: {
          error: 'policy_denied',
          message: `Network access denied for ${input.tool}`,
          ...input.diagnostics,
        },
      }),
      idempotency: { key: input.key ?? '', outcome: 'skipped', ref: null },
      at: input.at,
    });
  }
}

// ---------------------------------------------------------------------------
// linear_get_issue
// ---------------------------------------------------------------------------

export async function executeLinearGetIssue(
  params: { issue: string; includeRelations?: boolean; includeComments?: boolean },
  deps: LinearToolsDeps,
): Promise<LinearGetIssueResult> {
  const ts = now(deps);
  const network = enforceNetworkPolicy({
    policy: deps.networkPolicy,
    phase: deps.phase,
    tool: 'linear_get_issue',
    target: 'https://api.linear.app',
  });
  if (network.kind === 'deny') {
    appendLinearDeniedRecord(deps, {
      tool: 'linear_get_issue',
      phase: deps.phase,
      action: 'read',
      at: ts,
      target: 'https://api.linear.app',
      diagnostics: network.diagnostics,
    });
    return {
      ok: false,
      tool: 'linear_get_issue',
      error: network.error,
      message: network.message,
      diagnostics: network.diagnostics,
    };
  }
  try {
    const raw = await deps.client.getIssue(params.issue);
    const result: LinearGetIssueResult = {
      ok: true,
      tool: 'linear_get_issue',
      issue: {
        id: raw.id,
        identifier: raw.identifier,
        title: raw.title,
        description: raw.description,
        state: flattenState(raw.state),
        assignee: flattenAssignee(raw.assignee),
        labels: flattenLabels(raw.labels),
        url: raw.url,
      },
      metadata: {
        trust: buildTrustMetadata({
          sourceKind: 'issue',
          details: {
            title: raw.title,
            description: raw.description,
            state: flattenState(raw.state),
            assignee: flattenAssignee(raw.assignee),
            labels: flattenLabels(raw.labels),
            url: raw.url,
          },
        }),
      },
    };
    deps.transcript.append({
      type: 'workflow_tool_call',
      tool: 'linear_get_issue',
      phase: deps.phase,
      action: 'read',
      details: actionDetails({ target: 'https://api.linear.app', outcome: 'success' }),
      at: ts,
    });
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const isNotFound = msg.includes('not found') || msg.includes('not_found');
    const result: LinearGetIssueResult = {
      ok: false,
      tool: 'linear_get_issue',
      error: isNotFound ? 'not_found' : 'external_error',
      message: msg,
      metadata: { trust: buildTrustMetadata({ sourceKind: 'issue', details: msg }) },
    };
    deps.transcript.append({
      type: 'workflow_tool_call',
      tool: 'linear_get_issue',
      phase: deps.phase,
      action: 'read',
      details: actionDetails({
        target: 'https://api.linear.app',
        outcome: 'error',
        diagnostics: { error: result.error, message: msg },
      }),
      at: ts,
    });
    return result;
  }
}

// ---------------------------------------------------------------------------
// linear_comment
// ---------------------------------------------------------------------------

export async function executeLinearComment(
  params: { issue: string; body: string; sessionId: string; phase: WorkflowPhase; dedupeOverride?: string },
  deps: LinearToolsDeps,
): Promise<LinearCommentResult> {
  const ts = now(deps);
  const phase = params.phase;

  const policy = isMutationAllowed(phase, 'linear_comment', 'comment');
  if (!policy.allowed) {
    const result: LinearCommentResult = {
      ok: false,
      tool: 'linear_comment',
      error: 'policy_denied',
      message: policy.reason,
      metadata: { trust: buildTrustMetadata({ sourceKind: 'wavemill_artifact', details: policy.reason }) },
    };
    deps.transcript.append({ type: 'workflow_tool_call', tool: 'linear_comment', phase, action: 'comment', at: ts });
    deps.stageArtifact.append({ tool: 'linear_comment', phase, idempotency: { key: '', outcome: 'skipped', ref: null }, at: ts });
    return result;
  }

  // Task identity gate (HOK-3115): challengers never write Linear, and an
  // invalid or conflicting task ID fails closed before any network call.
  const target = resolveLinearWriteTarget(params.issue, deps.taskMeta !== undefined ? { meta: deps.taskMeta } : {});
  if (target.action !== 'write') {
    const skipped = target.action === 'skip';
    const idempotency = { key: '', outcome: 'skipped' as const, ref: null, reason: target.message };
    deps.transcript.append({
      type: 'workflow_tool_call',
      tool: 'linear_comment',
      phase,
      action: 'comment',
      details: { outcome: skipped ? 'skipped' : 'rejected', reason: target.message },
      idempotency,
      at: ts,
    });
    deps.stageArtifact.append({ tool: 'linear_comment', phase, idempotency, at: ts });
    if (skipped) {
      return {
        ok: true,
        tool: 'linear_comment',
        idempotency,
        metadata: { trust: buildTrustMetadata({ sourceKind: 'wavemill_artifact', details: target.message }) },
      };
    }
    return {
      ok: false,
      tool: 'linear_comment',
      error: 'invalid_input',
      message: target.message,
      metadata: { trust: buildTrustMetadata({ sourceKind: 'wavemill_artifact', details: target.message }) },
    };
  }

  // Redact secrets before the body is hashed for idempotency and posted externally.
  const profile = buildProfileFromConfig(deps.getSecretEnvNames ?? (() => getRedactionConfig().secretEnvNames));
  const safeBody = redact(params.body, profile);
  const normalizedBody = normalizeBody(safeBody);
  const key = params.dedupeOverride ?? linearCommentKey({
    issue: params.issue,
    phase,
    sessionId: params.sessionId,
    body: normalizedBody,
  });

  const existing = deps.registry.get(key);
  if (existing) {
    const ref = existing.ref as LinearCommentRef | null;
    const idempotency = { key, outcome: 'reused' as const, ref };
    const result: LinearCommentResult = {
      ok: true,
      tool: 'linear_comment',
      idempotency: { key, outcome: 'reused', ref },
      metadata: { trust: buildTrustMetadata({ sourceKind: 'wavemill_artifact', details: { key, ref } }) },
    };
    deps.transcript.append({ type: 'workflow_tool_call', tool: 'linear_comment', phase, action: 'comment', idempotency, at: ts });
    deps.stageArtifact.append({ tool: 'linear_comment', phase, idempotency, at: ts });
    return result;
  }

  const network = enforceNetworkPolicy({
    policy: deps.networkPolicy,
    phase,
    tool: 'linear_comment',
    target: 'https://api.linear.app',
  });
  if (network.kind === 'deny') {
    appendLinearDeniedRecord(deps, {
      tool: 'linear_comment',
      phase,
      action: 'comment',
      at: ts,
      key,
      diagnostics: network.diagnostics,
    });
    return {
      ok: false,
      tool: 'linear_comment',
      error: network.error,
      message: network.message,
      diagnostics: network.diagnostics,
    };
  }

  try {
    const issue = await deps.client.getIssue(target.linearId);
    const comment = await deps.client.createComment(issue.id, safeBody);
    const ref: LinearCommentRef = { system: 'linear', kind: 'comment', id: comment.id, url: comment.url };
    const rec: DedupeRecord<LinearCommentRef> = { key, outcome: 'created', ref };
    deps.registry.record(key, rec);
    const idempotency = { key, outcome: 'created' as const, ref };
    const result: LinearCommentResult = {
      ok: true,
      tool: 'linear_comment',
      idempotency: { key, outcome: 'created', ref },
      metadata: { trust: buildTrustMetadata({ sourceKind: 'wavemill_artifact', details: { key, ref } }) },
    };
    deps.transcript.append({
      type: 'workflow_tool_call',
      tool: 'linear_comment',
      phase,
      action: 'comment',
      details: actionDetails({ target: 'https://api.linear.app', outcome: 'success' }),
      idempotency,
      at: ts,
    });
    deps.stageArtifact.append({
      tool: 'linear_comment',
      phase,
      details: actionDetails({ target: 'https://api.linear.app', outcome: 'success' }),
      idempotency,
      at: ts,
    });
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const result: LinearCommentResult = {
      ok: false,
      tool: 'linear_comment',
      error: 'external_error',
      message: msg,
      metadata: { trust: buildTrustMetadata({ sourceKind: 'wavemill_artifact', details: msg }) },
    };
    deps.transcript.append({
      type: 'workflow_tool_call',
      tool: 'linear_comment',
      phase,
      action: 'comment',
      details: actionDetails({
        target: 'https://api.linear.app',
        outcome: 'error',
        diagnostics: { error: 'external_error', message: msg },
      }),
      at: ts,
    });
    deps.stageArtifact.append({
      tool: 'linear_comment',
      phase,
      details: actionDetails({
        target: 'https://api.linear.app',
        outcome: 'error',
        diagnostics: { error: 'external_error', message: msg },
      }),
      idempotency: { key, outcome: 'skipped', ref: null },
      at: ts,
    });
    return result;
  }
}

// ---------------------------------------------------------------------------
// expand_issue
// ---------------------------------------------------------------------------

export async function executeExpandIssue(
  params: { issue: string; outputDir?: string },
  deps: ExpandIssueDeps,
): Promise<ExpandIssueResult> {
  const ts = now(deps);
  const phase = deps.phase;

  const policy = isMutationAllowed(phase, 'expand_issue', 'read');
  if (!policy.allowed) {
    const result: ExpandIssueResult = {
      ok: false,
      tool: 'expand_issue',
      error: 'policy_denied',
      message: policy.reason,
      metadata: { trust: buildTrustMetadata({ sourceKind: 'wavemill_artifact', details: policy.reason }) },
    };
    deps.transcript.append({ type: 'workflow_tool_call', tool: 'expand_issue', phase, action: 'read', at: ts });
    return result;
  }

  const network = enforceNetworkPolicy({
    policy: deps.networkPolicy,
    phase,
    tool: 'expand_issue',
    target: 'command:expand_issue',
  });
  if (network.kind === 'deny') {
    appendLinearDeniedRecord(deps, {
      tool: 'expand_issue',
      phase,
      action: 'read',
      at: ts,
      target: 'command:expand_issue',
      diagnostics: network.diagnostics,
    });
    return {
      ok: false,
      tool: 'expand_issue',
      error: network.error,
      message: network.message,
      diagnostics: network.diagnostics,
    };
  }

  if (!deps.expander) {
    const result: ExpandIssueResult = {
      ok: false,
      tool: 'expand_issue',
      error: 'expansion_failed',
      message: 'No expander function provided to expand_issue tool',
      metadata: {
        trust: buildTrustMetadata({
          sourceKind: 'wavemill_artifact',
          details: 'No expander function provided to expand_issue tool',
        }),
      },
    };
    deps.transcript.append({ type: 'workflow_tool_call', tool: 'expand_issue', phase, action: 'read', at: ts });
    return result;
  }

  const intentKey = expandIssueKey({
    issue: params.issue,
    phase,
    sessionId: deps.sessionId,
    contentHash: '',
  });

  const existing = deps.registry.get(intentKey);
  if (existing) {
    const ref = existing.ref as WavemillTaskPacketRef | null;
    const taskPacketPath = ref?.id ?? '';
    const idempotency = { key: intentKey, outcome: 'reused' as const, ref };
    const result: ExpandIssueResult = {
      ok: true,
      tool: 'expand_issue',
      taskPacketPath,
      ref: ref ?? undefined,
      idempotency: { key: intentKey, outcome: 'reused', ref },
      metadata: { trust: buildTrustMetadata({ sourceKind: 'wavemill_artifact', details: { taskPacketPath, ref } }) },
    };
    deps.transcript.append({
      type: 'workflow_tool_call',
      tool: 'expand_issue',
      phase,
      action: 'read',
      details: actionDetails({ target: 'command:expand_issue', outcome: 'success' }),
      idempotency,
      at: ts,
    });
    return result;
  }

  try {
    const taskPacketPath = await deps.expander(params, { sessionId: deps.sessionId, phase, outputDir: params.outputDir });

    if (!taskPacketPath || taskPacketPath.trim() === '') {
      const result: ExpandIssueResult = {
        ok: false,
        tool: 'expand_issue',
        error: 'expansion_failed',
        message: 'Expander returned empty task packet path',
        metadata: {
          trust: buildTrustMetadata({
            sourceKind: 'wavemill_artifact',
            details: 'Expander returned empty task packet path',
          }),
        },
      };
      deps.transcript.append({
        type: 'workflow_tool_call',
        tool: 'expand_issue',
        phase,
        action: 'read',
        details: actionDetails({
          target: 'command:expand_issue',
          outcome: 'error',
          diagnostics: { error: 'expansion_failed', message: 'Expander returned empty task packet path' },
        }),
        at: ts,
      });
      return result;
    }

    const ref: WavemillTaskPacketRef = { system: 'wavemill', kind: 'task_packet', id: taskPacketPath };
    const rec: DedupeRecord<WavemillTaskPacketRef> = { key: intentKey, outcome: 'created', ref };
    deps.registry.record(intentKey, rec);
    const idempotency = { key: intentKey, outcome: 'created' as const, ref };
    const result: ExpandIssueResult = {
      ok: true,
      tool: 'expand_issue',
      taskPacketPath,
      ref,
      idempotency: { key: intentKey, outcome: 'created', ref },
      metadata: { trust: buildTrustMetadata({ sourceKind: 'wavemill_artifact', details: { taskPacketPath, ref } }) },
    };
    deps.transcript.append({
      type: 'workflow_tool_call',
      tool: 'expand_issue',
      phase,
      action: 'read',
      details: actionDetails({ target: 'command:expand_issue', outcome: 'success' }),
      idempotency,
      at: ts,
    });
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const result: ExpandIssueResult = {
      ok: false,
      tool: 'expand_issue',
      error: 'expansion_failed',
      message: msg,
      metadata: { trust: buildTrustMetadata({ sourceKind: 'wavemill_artifact', details: msg }) },
    };
    deps.transcript.append({
      type: 'workflow_tool_call',
      tool: 'expand_issue',
      phase,
      action: 'read',
      details: actionDetails({
        target: 'command:expand_issue',
        outcome: 'error',
        diagnostics: { error: 'expansion_failed', message: msg },
      }),
      at: ts,
    });
    return result;
  }
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

export function createLinearTools(deps: LinearToolsDeps) {
  return {
    linearGetIssue: (params: { issue: string; includeRelations?: boolean; includeComments?: boolean }) =>
      executeLinearGetIssue(params, deps),
    linearComment: (params: { issue: string; body: string; sessionId: string; phase: WorkflowPhase; dedupeOverride?: string }) =>
      executeLinearComment(params, deps),
    expandIssue: (params: { issue: string; outputDir?: string }) =>
      executeExpandIssue(params, deps),
  };
}
