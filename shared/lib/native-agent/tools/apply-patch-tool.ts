import { applyNativePatch, type NativePatchAppliedResult } from '../patch-runtime.ts';
import type { MutationRecorder } from '../cleanup.ts';
import {
  buildNativePatchGuidance,
  NATIVE_PATCH_PARAMETERS_SCHEMA,
  validateNativePatch,
  type NativePatch,
  type NativePatchRejectedResult,
  type NativePatchRuntimeRejection,
  type NativePatchValidationError,
} from '../patch-contract.ts';
import type { ToolDescriptor, ToolPhase, WavemillToolResult } from './types.ts';

export interface ApplyPatchParams {
  patch: NativePatch;
}

export interface ApplyPatchSuccessDetails extends NativePatchAppliedResult {
  tool: 'apply_patch';
}

export interface ApplyPatchErrorDetails {
  ok: false;
  tool: 'apply_patch';
  error: 'invalid_patch' | 'patch_rejected' | 'io_error';
  message: string;
  retryHint?: string;
  diagnostics?: NativePatchValidationError[] | NativePatchRuntimeRejection;
}

export type ApplyPatchDetails = ApplyPatchSuccessDetails | ApplyPatchErrorDetails;

export interface ApplyPatchToolOptions {
  phase?: ToolPhase;
  recorder?: MutationRecorder;
}

interface AfterToolCallContext {
  toolCall: { name: string };
  result: { details: unknown };
}

const applyPatchParameters = {
  type: 'object',
  properties: {
    patch: NATIVE_PATCH_PARAMETERS_SCHEMA,
  },
  required: ['patch'],
  additionalProperties: false,
};

export function createApplyPatchTool(
  worktreePath: string,
  options: ApplyPatchToolOptions = {},
): ToolDescriptor<ApplyPatchParams, ApplyPatchDetails> {
  const phase = options.phase ?? 'coding';
  return {
    metadata: {
      name: 'apply_patch',
      description: [
        'Apply an atomic native patch to source files inside the active worktree.',
        'See docs/native-workflow-tool-contracts.md for the full contract.',
        buildNativePatchGuidance(),
      ].join('\n\n'),
      class: 'mutation',
      allowedPhases: ['coding'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: applyPatchParameters,
    async execute(_toolCallId, params) {
      return executeApplyPatch(worktreePath, params, phase, options.recorder);
    },
  };
}

export async function applyPatchAfterToolCall(
  context: AfterToolCallContext,
): Promise<{ isError?: boolean } | undefined> {
  if (context.toolCall.name !== 'apply_patch') {
    return undefined;
  }
  const details = context.result.details as ApplyPatchDetails | undefined;
  if (!details || typeof details !== 'object' || !('ok' in details)) {
    return undefined;
  }
  return details.ok ? undefined : { isError: true };
}

async function executeApplyPatch(
  worktreePath: string,
  params: ApplyPatchParams,
  phase: ToolPhase,
  recorder?: MutationRecorder,
): Promise<WavemillToolResult<ApplyPatchDetails>> {
  const validation = validateNativePatch(params.patch);
  if (!validation.ok) {
    const details: ApplyPatchErrorDetails = {
      ok: false,
      tool: 'apply_patch',
      error: 'invalid_patch',
      message: 'Patch payload did not match the NativePatch contract.',
      retryHint: 'Fix the patch schema errors and retry with the valid NativePatch example shown in the tool result.',
      diagnostics: validation.errors,
    };
    return {
      content: [{ type: 'text', text: formatInvalidPatchMessage(details.message, validation.errors) }],
      details,
    };
  }

  try {
    const result = await applyNativePatch(worktreePath, validation.value, { phase });
    if (result.ok) {
      for (const changedFile of result.changedFiles) {
        recorder?.recordMutation({
          tool: 'apply_patch',
          status: 'completed',
          path: changedFile,
        });
      }
      recorder?.recordPatchSnapshots(result.snapshots);
      const details: ApplyPatchSuccessDetails = {
        ...result,
        tool: 'apply_patch',
      };
      return {
        content: [{ type: 'text', text: summarizeApplyPatch(details) }],
        details,
      };
    }
    recorder?.recordMutation({
      tool: 'apply_patch',
      status: 'failed',
      path: validation.value.operations[0]?.path,
      reason: result.rejection.message,
    });
    return rejectedPatchResult(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    recorder?.recordMutation({
      tool: 'apply_patch',
      status: 'failed',
      path: validation.value.operations[0]?.path,
      reason: message,
    });
    const details: ApplyPatchErrorDetails = {
      ok: false,
      tool: 'apply_patch',
      error: 'io_error',
      message: `Failed to apply patch: ${message}`,
      retryHint: 'Check filesystem state and retry the patch.',
    };
    return {
      content: [{ type: 'text', text: details.message }],
      details,
    };
  }
}

function rejectedPatchResult(
  result: NativePatchRejectedResult,
): WavemillToolResult<ApplyPatchDetails> {
  const details: ApplyPatchErrorDetails = {
    ok: false,
    tool: 'apply_patch',
    error: 'patch_rejected',
    message: result.rejection.message,
    retryHint: result.rejection.hint,
    diagnostics: result.rejection,
  };
  return {
    content: [{ type: 'text', text: `${result.rejection.code}: ${result.rejection.message}` }],
    details,
  };
}

function formatDiagnostic(diagnostic: NativePatchValidationError): string {
  if (diagnostic.keyword === 'additionalProperties' && diagnostic.params?.additionalProperty !== undefined) {
    return `- ${diagnostic.path}: unknown key received: '${diagnostic.params.additionalProperty}'`;
  }
  if (diagnostic.keyword === 'required' && diagnostic.params?.missingProperty !== undefined) {
    return `- ${diagnostic.path}: missing required key: '${diagnostic.params.missingProperty}'`;
  }
  return `- ${diagnostic.path}: ${diagnostic.message}`;
}

function formatInvalidPatchMessage(
  message: string,
  diagnostics: NativePatchValidationError[],
): string {
  const diagnosticText = diagnostics.map(formatDiagnostic).join('\n');
  return [
    message,
    '',
    'Validation errors:',
    diagnosticText || '- No diagnostics returned.',
    '',
    buildNativePatchGuidance(),
  ].join('\n');
}

function summarizeApplyPatch(result: ApplyPatchSuccessDetails): string {
  const fileSummary = result.fileChanges
    .map((change) => `${change.path} (+${change.linesAdded} -${change.linesRemoved})`)
    .join(', ');
  return `Applied patch to ${result.changedFiles.length} file(s); ${result.linesAdded} line(s) added, ${result.linesRemoved} removed${fileSummary ? `: ${fileSummary}` : ''}.`;
}
