// HOK-3150 step 4: port the two loop-level policies the issue names
// (`mutation-policy` and `output-limits`) to pi-durable hooks, so we can
// estimate how much of `loop.ts` could move into extensions.
//
// Hook mapping:
// - beforeTool  ← evaluateMutationWritePolicy + evaluateBeforeToolCallPolicy
//                 (loop.ts:966-998 piece)
// - afterTool   ← output-limits cap + redactSecrets
//                 (loop.ts:999-1060 piece)
// - beforeRequest ← computeDynamicMaxTokens (loop.ts:806, 1169)
//
// Only pure functions from production are imported; no production file is
// modified. Imports are relative paths out of spike/pi-durable-crash-test.

import { Buffer } from 'node:buffer';

import type { JsonObject, JsonValue, Message } from '@earendil-works/pi-ai';
import {
  defineExtension,
  GenerationTask,
  hook,
  ToolTask,
  type Extension,
  type ToolExecutionResult,
} from '@earendil-works/pi-durable';

// Reused production code — the files these import must stay unmodified.
import { evaluateMutationWritePolicy } from '../../../shared/lib/native-agent/mutation-policy.ts';
import {
  computeDynamicMaxTokens,
  CODING_MAX_OUTPUT_TOKENS,
} from '../../../shared/lib/native-agent/output-limits.ts';
import { evaluateBeforeToolCallPolicy } from '../../../shared/lib/native-agent/tools/policies.ts';
import type { ToolMetadata, ToolPhase } from '../../../shared/lib/native-agent/tools/types.ts';
import { redactSecrets, redactSecretsInValue } from '../../../shared/lib/redaction-profiles.ts';

export interface PolicyExtensionOptions {
  readonly worktreePath: string;
  readonly phase: ToolPhase;
  /** Tool metadata the real registry would carry (name, class, allowedPhases). */
  readonly registry: readonly ToolMetadata[];
  /** Whole-file write allowlist for mutation-policy evaluation. */
  readonly wholeFileAllowlist?: Parameters<typeof evaluateMutationWritePolicy>[0]['wholeFileAllowlist'];
  /** Tool-name → field names whose values are paths; same shape as ToolPolicyConfig. */
  readonly pathFieldsByTool?: Readonly<Record<string, readonly string[]>>;
  /** Model context window (tokens); default is a conservative 200k. */
  readonly contextWindowTokens?: number;
  /** Per-tool output cap in bytes; applied in afterTool. */
  readonly maxOutputBytes?: number;
}

/** Serialisable decision record for parity testing. */
export interface PolicyDecisionRecord {
  readonly tool: string;
  readonly decision: 'allow' | 'block';
  readonly reason?: string;
  readonly message?: string;
}

/** Per-call decision log that policy-parity.ts asserts against. */
export const DECISION_LOG: PolicyDecisionRecord[] = [];

/** Reset the decision log before a parity run. */
export function resetDecisionLog(): void {
  DECISION_LOG.length = 0;
}

export function createPolicyExtension(options: PolicyExtensionOptions): Extension {
  const maxOutputBytes = options.maxOutputBytes ?? 65_536;
  const contextWindowTokens = options.contextWindowTokens ?? 200_000;

  return defineExtension({
    name: 'spike.policy',
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call) => {
          // 1) Phase + path-mode gate (loop.ts calls this at line 966).
          const phaseDecision = evaluateBeforeToolCallPolicy({
            phase: options.phase,
            config: { pathFieldsByTool: options.pathFieldsByTool },
            worktreePath: options.worktreePath,
            registry: options.registry,
            toolCall: {
              name: call.name,
              arguments: (call.arguments ?? {}) as Record<string, unknown>,
            },
          });
          if (phaseDecision.kind === 'deny') {
            DECISION_LOG.push({
              tool: call.name,
              decision: 'block',
              reason: phaseDecision.reason,
              message: phaseDecision.message,
            });
            return { block: phaseDecision.message };
          }

          // 2) Mutation write policy: for apply_patch and whole-file writes.
          const mutationBlock = evaluateMutationCall(call, options);
          if (mutationBlock !== undefined) {
            DECISION_LOG.push({
              tool: call.name,
              decision: 'block',
              reason: 'mutation_policy',
              message: mutationBlock,
            });
            return { block: mutationBlock };
          }

          DECISION_LOG.push({ tool: call.name, decision: 'allow' });
          return undefined;
        },

        afterTool: async (_call, result) => {
          return applyOutputLimits(result, maxOutputBytes);
        },
      }),

      hook(GenerationTask, {
        beforeRequest: async (request) => {
          // Approximate the input token count; a production port would use
          // the provider's tokeniser. Here we use the UTF-8 byte count / 4.
          const inputChars = countChars(request.messages);
          const inputTokens = Math.ceil(inputChars / 4);
          const maxTokens = computeDynamicMaxTokens({
            inputTokens,
            contextWindowTokens,
            phaseCeiling: CODING_MAX_OUTPUT_TOKENS,
          });
          // NOTE (gate 6 finding): pi-durable's `beforeRequest` is declared as
          // returning only `{ messages }`. Max-token reservation cannot be
          // expressed by this hook; it would need `settings.stream` or an
          // extension-level wrapper. We record the computed value for the
          // parity test and otherwise pass the messages through.
          (globalThis as any).__spike_last_maxTokens = maxTokens;
          return { messages: request.messages };
        },

        // Redact secrets from the model-visible assistant text immediately.
        afterResponse: async () => {
          // Pi-durable commits the assistant message before afterResponse runs,
          // so there is no in-place rewrite path here. Redaction of tool
          // output happens in afterTool above; redaction of model text would
          // need either a wrapTool on every output path or a post-commit
          // overlay. We record this as a finding for the eval doc.
        },
      }),
    ],
  });
}

function countChars(messages: readonly Message[]): number {
  let n = 0;
  for (const msg of messages) {
    const content = (msg as any).content;
    if (typeof content === 'string') {
      n += content.length;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === 'string') n += block.length;
        else if (block && typeof block === 'object' && typeof block.text === 'string') n += block.text.length;
      }
    }
  }
  return n;
}

function evaluateMutationCall(
  call: { name: string; arguments: JsonObject | null | undefined },
  options: PolicyExtensionOptions,
): string | undefined {
  const args = (call.arguments ?? {}) as Record<string, unknown>;

  if (call.name === 'apply_patch') {
    // Patch ops shape: a list of { path, kind: 'patch'|'whole-file', ... }.
    const ops = Array.isArray((args as any).files)
      ? (args as any).files
      : Array.isArray((args as any).operations)
        ? (args as any).operations
        : [];
    for (const op of ops as Array<{ path?: string; kind?: string }>) {
      const target = op?.path;
      if (typeof target !== 'string') continue;
      const writeKind = op?.kind === 'whole-file' ? 'whole-file' : 'patch';
      const decision = evaluateMutationWritePolicy({
        worktreePath: options.worktreePath,
        targetPath: target,
        writeKind,
        wholeFileAllowlist: options.wholeFileAllowlist,
      });
      if (decision.kind === 'deny') return decision.message;
    }
    return undefined;
  }

  if (call.name === 'write_artifact') {
    const target = typeof (args as any).path === 'string' ? (args as any).path : undefined;
    if (!target) return undefined;
    const decision = evaluateMutationWritePolicy({
      worktreePath: options.worktreePath,
      targetPath: target,
      writeKind: 'whole-file',
      wholeFileAllowlist: options.wholeFileAllowlist,
    });
    if (decision.kind === 'deny') return decision.message;
  }

  return undefined;
}

function applyOutputLimits(
  result: ToolExecutionResult,
  maxOutputBytes: number,
): ToolExecutionResult {
  let content = result.content;
  let truncated = false;
  if (Array.isArray(content)) {
    const next: typeof content = [];
    for (const block of content) {
      if (block && (block as any).type === 'text' && typeof (block as any).text === 'string') {
        const text: string = (block as any).text;
        const redacted = redactSecrets(text);
        const limited = capBytes(redacted.text, maxOutputBytes);
        if (limited.truncated) truncated = true;
        next.push({ ...(block as any), text: limited.text });
      } else {
        next.push(block as any);
      }
    }
    content = next;
  }

  const details = result.details === undefined ? undefined : redactSecretsInValue(result.details as JsonValue).value;

  const diagnostics = truncated
    ? [...(result.diagnostics ?? []), { severity: 'warn' as const, message: 'output capped by policy', code: 'spike.output.capped' }]
    : result.diagnostics;

  return {
    ...result,
    content,
    details: details as any,
    diagnostics,
  };
}

function capBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  const keep = buf.subarray(0, maxBytes).toString('utf8');
  return { text: `${keep}\n…[truncated by policy: ${buf.length - maxBytes} bytes]`, truncated: true };
}
