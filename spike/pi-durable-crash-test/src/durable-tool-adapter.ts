// HOK-3150 step 1: adapt a Wavemill ToolDescriptor to a pi-durable
// ToolRegistration. Mirrors `shared/lib/native-agent/tools/pi-adapter.ts`
// (toPiAgentTool), but for the pi-durable `defineTool` surface. The real
// adapter stays untouched; this one lives only in the spike dir.

import type { JsonValue, TSchema } from '@earendil-works/pi-ai';
import { defineTool, type ToolExecutionApi, type ToolExecutionResult } from '@earendil-works/pi-durable';

import type { ToolDescriptor, WavemillToolResult } from '../../../shared/lib/native-agent/tools/types.ts';
import { replayLabelFor } from './replay-labels.ts';

export interface DurableToolHooks {
  /**
   * Called before the real execute. Lets the crash harness pause the tool
   * mid-execution. Return a Promise that resolves to continue.
   */
  readonly beforeExecute?: (name: string, callId: string) => Promise<void>;
  /**
   * Called after the real execute returns, before the ToolExecutionResult is
   * committed. Used for the C3 crash point (execute done, result not committed).
   */
  readonly afterExecute?: (name: string, callId: string) => Promise<void>;
  /**
   * Called around a safe tool for crash point B. Separate because B targets
   * safe tools specifically.
   */
  readonly duringSafeExecute?: (name: string, callId: string) => Promise<void>;
  /**
   * Record each (callId, name, pid, t) tuple to an append-only side log so
   * audit-transcript.ts can count executes per callId across both processes.
   */
  readonly recordExecute?: (name: string, callId: string) => void;
}

/**
 * Convert a Wavemill ToolDescriptor into a pi-durable ToolRegistration.
 *
 * - `replay` is looked up via replay-labels.ts and defaults to `"unsafe"`
 *   with a loud log when missing (the arm asserts coverage at startup, so
 *   this path is defence in depth).
 * - `WavemillToolResult.terminate` becomes `control: { terminate: true }`.
 * - The optional `hooks` are the spike's crash-injection surface. Production
 *   has no equivalent; they live only here.
 */
export function toDurableTool(
  descriptor: ToolDescriptor,
  hooks: DurableToolHooks = {},
) {
  const { metadata, parameters, execute } = descriptor;
  const labelReason = replayLabelFor(metadata.name);
  if (labelReason === undefined) {
    // The arm asserts coverage, but keep defence-in-depth: default to unsafe.
    // Operators notice the warning in the smoke run.
    console.warn(`[durable-tool-adapter] no replay label for "${metadata.name}" — defaulting to unsafe`);
  }
  const replay: 'safe' | 'unsafe' = labelReason?.label ?? 'unsafe';

  return defineTool({
    name: metadata.name,
    description: metadata.description,
    // pi-ai validates params against this schema; typebox cross-copy may
    // require a shape-only JSON clone — see §2.1 of plan.md. We attempt a
    // direct pass first and fall back to a JSON clone if the cross-copy
    // typebox refuses it (not caught here; registry install would fail).
    parameters: parameters as TSchema,
    replay,
    executionMode: metadata.executionMode,

    async execute(
      args: unknown,
      api: ToolExecutionApi,
    ): Promise<ToolExecutionResult> {
      hooks.recordExecute?.(metadata.name, api.callId);

      if (replay === 'safe') {
        await hooks.duringSafeExecute?.(metadata.name, api.callId);
      } else {
        await hooks.beforeExecute?.(metadata.name, api.callId);
      }

      const signal = (api as any)?.signal as AbortSignal | undefined;
      const result: WavemillToolResult = await execute(api.callId, args, signal);

      await hooks.afterExecute?.(metadata.name, api.callId);

      return {
        content: result.content as any,
        details: (result.details ?? null) as JsonValue,
        ...(result.terminate ? { control: { terminate: true as const } } : {}),
      };
    },
  });
}
