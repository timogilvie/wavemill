import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import {
  evaluateMutationWritePolicy,
  type MutationPolicyReason,
} from '../mutation-policy.ts';
import { getRedactionConfig } from '../../config.ts';
import { buildProfileFromConfig, redact } from '../../redaction-profiles.ts';
import type {
  NormalizedWholeFileWriteAllowlistInput,
  WholeFileWriteAllowlistInput,
} from '../coding-artifacts.ts';
import {
  buildCompletionArtifactRetryGuidance,
  normalizeBlockedCompletionContent,
  normalizeCodingCompleteContent,
  noVerificationEvidenceError,
} from '../completion-normalizer.ts';
import type { MutationRecorder } from '../cleanup.ts';
import { evaluateCodingCompletionGate } from '../completion-gate.ts';
import { readTaskDirtyPaths, type TaskDirtyPaths } from '../../worktree-dirty-status.ts';
import { createApplyPatchTool } from './apply-patch-tool.ts';
import type { ToolDescriptor, ToolPhase, WavemillToolResult } from './types.ts';
import type { ApplyPatchDetails } from './apply-patch-tool.ts';

const DEFAULT_WHOLE_FILE_ALLOWLIST: NormalizedWholeFileWriteAllowlistInput = {
  generatedPaths: ['.wavemill/**'],
  wavemillOwnedPaths: ['features/**', 'bugs/**'],
};

const STATUS_STATES = ['working', 'idle', 'waiting', 'blocked', 'approval-needed', 'policy-denied', 'error'] as const;

type StatusState = (typeof STATUS_STATES)[number];
type MutationToolName = 'write_artifact' | 'create_marker' | 'update_status';

export interface WriteArtifactParams {
  path: string;
  content: string;
}

export interface CreateMarkerParams {
  path: string;
  content?: string;
}

export interface UpdateStatusParams {
  state: StatusState;
  message?: string;
  detail?: string;
}

export interface WholeFileWriteSuccessDetails {
  ok: true;
  tool: 'write_artifact' | 'create_marker';
  resolvedPath: string;
  bytesWritten: number;
}

export interface StatusSuccessDetails {
  ok: true;
  tool: 'update_status';
  state: StatusState;
  message?: string;
  detail?: string;
  statusPath: string;
}

export interface MutationToolErrorDetails {
  ok: false;
  tool: MutationToolName | 'apply_patch';
  error:
    | 'invalid_input'
    | MutationPolicyReason
    | 'io_error'
    | 'completion_artifact_validation_failed'
    | 'no_verification_evidence'
    | 'completion_blocked';
  message: string;
  retryHint?: string;
  diagnostics?: unknown;
}

export type WriteArtifactDetails = WholeFileWriteSuccessDetails | MutationToolErrorDetails;
export type CreateMarkerDetails = WholeFileWriteSuccessDetails | MutationToolErrorDetails;
export type UpdateStatusDetails = StatusSuccessDetails | MutationToolErrorDetails;
export type CodingMutationDetails = ApplyPatchDetails | WriteArtifactDetails | CreateMarkerDetails | UpdateStatusDetails;

export interface CodingMutationToolOptions {
  phase?: ToolPhase;
  wholeFileAllowlist?: WholeFileWriteAllowlistInput | NormalizedWholeFileWriteAllowlistInput;
  statusPath?: string;
  recorder?: MutationRecorder;
  /**
   * The task's dirty paths (Wavemill-owned output already excluded) for the
   * `.coding-complete` completion gate. Defaults to the worktree's porcelain
   * status through `readTaskDirtyPaths`.
   */
  readTaskDirtyPaths?: (slug: string) => TaskDirtyPaths;
}

interface AfterToolCallContext {
  toolCall: { name: string };
  result: { details: unknown };
}

const writeArtifactParameters = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['path', 'content'],
  additionalProperties: false,
};

const createMarkerParameters = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['path'],
  additionalProperties: false,
};

const updateStatusParameters = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: [...STATUS_STATES] },
    message: { type: 'string' },
    detail: { type: 'string' },
  },
  required: ['state'],
  additionalProperties: false,
};

export const codingMutationPolicyConfig = {
  pathFieldsByTool: {
    write_artifact: ['path'],
    create_marker: ['path'],
  },
} as const;

export function createCodingMutationTools(
  worktreePath: string,
  options: CodingMutationToolOptions = {},
): readonly ToolDescriptor[] {
  return [
    createApplyPatchTool(worktreePath, { phase: options.phase, recorder: options.recorder }),
    createWriteArtifactTool(worktreePath, options),
    createCreateMarkerTool(worktreePath, options),
    createUpdateStatusTool(worktreePath, options),
  ];
}

export function createWriteArtifactTool(
  worktreePath: string,
  options: CodingMutationToolOptions = {},
): ToolDescriptor<WriteArtifactParams, WriteArtifactDetails> {
  return {
    metadata: {
      name: 'write_artifact',
      description: 'Write a Wavemill-owned artifact file through the whole-file mutation policy.',
      class: 'mutation',
      allowedPhases: ['coding'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: writeArtifactParameters,
    async execute(_toolCallId, params) {
      return executeWholeFileWrite('write_artifact', worktreePath, params.path, params.content, options);
    },
  };
}

export function createCreateMarkerTool(
  worktreePath: string,
  options: CodingMutationToolOptions = {},
): ToolDescriptor<CreateMarkerParams, CreateMarkerDetails> {
  return {
    metadata: {
      name: 'create_marker',
      description: 'Create a Wavemill-owned marker file through the whole-file mutation policy.',
      class: 'mutation',
      allowedPhases: ['coding'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: createMarkerParameters,
    async execute(_toolCallId, params) {
      return executeWholeFileWrite('create_marker', worktreePath, params.path, params.content ?? '', options);
    },
  };
}

export function createUpdateStatusTool(
  worktreePath: string,
  options: CodingMutationToolOptions = {},
): ToolDescriptor<UpdateStatusParams, UpdateStatusDetails> {
  return {
    metadata: {
      name: 'update_status',
      description: 'Durably persist native coding status updates for transcript and orchestration consumers.',
      class: 'mutation',
      allowedPhases: ['coding'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: updateStatusParameters,
    async execute(_toolCallId, params) {
      return executeUpdateStatus(worktreePath, params, options);
    },
  };
}

export async function codingMutationAfterToolCall(
  context: AfterToolCallContext,
): Promise<{ isError?: boolean } | undefined> {
  if (!['apply_patch', 'write_artifact', 'create_marker', 'update_status'].includes(context.toolCall.name)) {
    return undefined;
  }
  const details = context.result.details as CodingMutationDetails | undefined;
  if (!details || typeof details !== 'object' || !('ok' in details)) {
    return undefined;
  }
  return details.ok ? undefined : { isError: true };
}

async function executeWholeFileWrite(
  tool: 'write_artifact' | 'create_marker',
  worktreePath: string,
  targetPath: string,
  content: string,
  options: CodingMutationToolOptions,
): Promise<WavemillToolResult<WriteArtifactDetails | CreateMarkerDetails>> {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') {
    options.recorder?.recordMutation({ tool, status: 'failed', reason: 'path must be a non-empty string' });
    return errorResult(tool, 'invalid_input', 'path must be a non-empty string');
  }
  if (typeof content !== 'string') {
    options.recorder?.recordMutation({ tool, status: 'failed', path: targetPath, reason: 'content must be a string' });
    return errorResult(tool, 'invalid_input', 'content must be a string');
  }

  const decision = evaluateMutationWritePolicy({
    worktreePath,
    targetPath,
    writeKind: 'whole-file',
    wholeFileAllowlist: options.wholeFileAllowlist ?? DEFAULT_WHOLE_FILE_ALLOWLIST,
  });

  if (decision.kind === 'deny') {
    options.recorder?.recordMutation({
      tool,
      status: 'failed',
      path: targetPath,
      reason: decision.message,
    });
    return deniedWriteResult(tool, decision.reason, decision.message);
  }

  // Redact secrets before writing to disk (artifact-write redaction chokepoint).
  const profile = buildProfileFromConfig(() => getRedactionConfig(worktreePath).secretEnvNames);
  let safeContent = redact(content, profile);
  const absolutePath = join(worktreePath, decision.resolvedPath);
  const completionArtifactValidation = validateCompletionArtifactWrite(
    basename(decision.resolvedPath),
    safeContent,
  );
  if (!completionArtifactValidation.ok) {
    options.recorder?.recordMutation({
      tool,
      status: 'failed',
      path: decision.resolvedPath,
      reason: completionArtifactValidation.message,
    });
    return errorResult(
      tool,
      completionArtifactValidation.error,
      completionArtifactValidation.message,
      completionArtifactValidation.retryHint,
    );
  }
  safeContent = completionArtifactValidation.content;

  if (basename(decision.resolvedPath) === '.coding-complete') {
    const refusal = codingCompleteGateRefusal(worktreePath, decision.resolvedPath, options);
    if (refusal) {
      options.recorder?.recordMutation({ tool, status: 'failed', path: decision.resolvedPath, reason: refusal.message });
      return errorResult(tool, 'completion_blocked', refusal.message, refusal.retryHint, { dirtyPaths: refusal.dirtyPaths });
    }
  }

  try {
    atomicWriteText(absolutePath, safeContent);
    const details: WholeFileWriteSuccessDetails = {
      ok: true,
      tool,
      resolvedPath: decision.resolvedPath,
      bytesWritten: Buffer.byteLength(safeContent, 'utf-8'),
    };
    options.recorder?.recordMutation({
      tool,
      status: 'completed',
      path: decision.resolvedPath,
    });
    return {
      content: [{
        type: 'text',
        text: [
          `${tool} wrote ${decision.resolvedPath}`,
          ...completionArtifactValidation.warnings,
        ].join('\n'),
      }],
      details,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    options.recorder?.recordMutation({
      tool,
      status: 'failed',
      path: decision.resolvedPath,
      reason: message,
    });
    return errorResult(tool, 'io_error', `Failed to write ${decision.resolvedPath}: ${message}`);
  }
}

/**
 * HOK-3514: the one native completion decision. `.coding-complete` is refused
 * while the task still has dirty paths, so the agent hears about them while it
 * still holds its full tools instead of the monitor parking the handoff.
 */
function codingCompleteGateRefusal(
  worktreePath: string,
  markerPath: string,
  options: CodingMutationToolOptions,
): { message: string; retryHint: string; dirtyPaths: string[] } | null {
  const slug = basename(dirname(markerPath));
  const dirty = options.readTaskDirtyPaths
    ? options.readTaskDirtyPaths(slug)
    : readTaskDirtyPaths({ worktree: worktreePath, slug });
  if (dirty.state === 'unreadable') {
    return {
      message: '.coding-complete refused: git status could not be read, so the worktree cannot be shown clean.',
      retryHint: 'Run git_status, fix the repository state, then write .coding-complete again.',
      dirtyPaths: [],
    };
  }
  // Commit and checks policy are judged downstream (review / Ready); this gate
  // owns the dirty-tree decision only.
  const decision = evaluateCodingCompletionGate({
    dirtyPaths: dirty.paths,
    commitPolicySatisfied: true,
    checksPolicySatisfied: true,
  });
  if (decision.status === 'accepted') return null;
  const retryHint = 'For each dirty path, commit it (git_add + git_commit) when it belongs to the task, '
    + 'or discard it with discard_owned_path. Then write .coding-complete again.';
  return {
    message: `.coding-complete refused: ${decision.message} Dirty: ${dirty.paths.join(', ')}. ${retryHint}`,
    retryHint,
    dirtyPaths: dirty.paths,
  };
}

function validateCompletionArtifactWrite(
  filename: string,
  content: string,
):
  | { ok: true; content: string; warnings: string[] }
  | {
    ok: false;
    error: 'completion_artifact_validation_failed' | 'no_verification_evidence';
    message: string;
    retryHint: string;
  } {
  if (filename === '.coding-complete') {
    const normalized = normalizeCodingCompleteContent(content);
    if (normalized.ok) {
      return {
        ok: true,
        content: normalized.canonicalContent,
        warnings: normalized.warnings,
      };
    }
    return {
      ok: false,
      error: 'completion_artifact_validation_failed',
      message: `Invalid .coding-complete: ${formatSeamValidationErrors(normalized.errors)}`,
      retryHint: buildCompletionArtifactRetryGuidance('coding-complete', normalized.errors),
    };
  }

  if (filename === '.coding-blocked-completion.json') {
    const normalized = normalizeBlockedCompletionContent(content);
    if (normalized.ok) {
      if (normalized.coercedUnverifiedClaim) {
        const evidenceError = noVerificationEvidenceError();
        return {
          ok: false,
          error: 'no_verification_evidence',
          message: evidenceError.message,
          retryHint: buildCompletionArtifactRetryGuidance('blocked-completion', [evidenceError]),
        };
      }
      return {
        ok: true,
        content: normalized.canonicalContent,
        warnings: normalized.warnings,
      };
    }
    return {
      ok: false,
      error: 'completion_artifact_validation_failed',
      message: `Invalid .coding-blocked-completion.json: ${formatSeamValidationErrors(normalized.errors)}`,
      retryHint: buildCompletionArtifactRetryGuidance('blocked-completion', normalized.errors),
    };
  }

  return { ok: true, content, warnings: [] };
}

function formatSeamValidationErrors(errors: readonly { code: string; path: string; message: string }[]): string {
  return errors.map((error) => `${error.code} at ${error.path}: ${error.message}`).join('; ');
}

async function executeUpdateStatus(
  worktreePath: string,
  params: UpdateStatusParams,
  options: CodingMutationToolOptions,
): Promise<WavemillToolResult<UpdateStatusDetails>> {
  if (!isStatusState(params.state)) {
    options.recorder?.recordMutation({ tool: 'update_status', status: 'failed', reason: 'invalid state' });
    return errorResult('update_status', 'invalid_input', 'state must be one of: working, idle, waiting, blocked, approval-needed, policy-denied, error');
  }
  if (params.message !== undefined && typeof params.message !== 'string') {
    options.recorder?.recordMutation({ tool: 'update_status', status: 'failed', reason: 'message must be a string when provided' });
    return errorResult('update_status', 'invalid_input', 'message must be a string when provided');
  }
  if (params.detail !== undefined && typeof params.detail !== 'string') {
    options.recorder?.recordMutation({ tool: 'update_status', status: 'failed', reason: 'detail must be a string when provided' });
    return errorResult('update_status', 'invalid_input', 'detail must be a string when provided');
  }

  const statusPath = options.statusPath ?? defaultStatusPath(worktreePath);
  const payload = buildStatusPayload(statusPath, params);
  try {
    atomicWriteText(statusPath, `${JSON.stringify(payload)}\n`);
    const details: StatusSuccessDetails = {
      ok: true,
      tool: 'update_status',
      state: params.state,
      ...(params.message !== undefined ? { message: params.message } : {}),
      ...(params.detail !== undefined ? { detail: params.detail } : {}),
      statusPath,
    };
    options.recorder?.recordMutation({
      tool: 'update_status',
      status: 'completed',
      path: normalizeRecorderPath(worktreePath, statusPath),
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(details) }],
      details,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    options.recorder?.recordMutation({
      tool: 'update_status',
      status: 'failed',
      path: normalizeRecorderPath(worktreePath, statusPath),
      reason: message,
    });
    return errorResult('update_status', 'io_error', `Failed to persist status: ${message}`);
  }
}

function normalizeRecorderPath(worktreePath: string, absoluteOrRelativePath: string): string {
  if (!isAbsolute(absoluteOrRelativePath)) {
    return absoluteOrRelativePath;
  }
  return relative(worktreePath, absoluteOrRelativePath).split('\\').join('/');
}

function buildStatusPayload(
  statusPath: string,
  params: UpdateStatusParams,
): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  try {
    base = JSON.parse(readFileSync(statusPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    base = {};
  }
  return {
    ...base,
    state: params.state,
    event: 'update_status',
    agent: 'native',
    timestamp: Math.floor(Date.now() / 1000),
    ...(params.message !== undefined ? { message: params.message } : {}),
    ...(params.detail !== undefined ? { detail: params.detail } : {}),
  };
}

function deniedWriteResult(
  tool: 'write_artifact' | 'create_marker',
  error: MutationPolicyReason,
  message: string,
): WavemillToolResult<WriteArtifactDetails | CreateMarkerDetails> {
  const retryHint = error === 'whole_file_source_write_denied'
    ? 'use apply_patch for source edits'
    : 'write to a path inside the active worktree';
  return errorResult(tool, error, message, retryHint);
}

function errorResult(
  tool: MutationToolErrorDetails['tool'],
  error: MutationToolErrorDetails['error'],
  message: string,
  retryHint?: string,
  diagnostics?: unknown,
): WavemillToolResult<any> {
  const details: MutationToolErrorDetails = {
    ok: false,
    tool,
    error,
    message,
    ...(retryHint !== undefined ? { retryHint } : {}),
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  };
  return {
    content: [{ type: 'text', text: message }],
    details,
  };
}

function atomicWriteText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, path);
}

function defaultStatusPath(worktreePath: string): string {
  const runDir = process.env.WAVEMILL_RUN_DIR;
  return runDir ? join(runDir, 'native-status.json') : join(worktreePath, '.wavemill', 'native-status.json');
}

function isStatusState(value: string): value is StatusState {
  return (STATUS_STATES as readonly string[]).includes(value);
}
