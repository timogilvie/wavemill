// HOK-3151 §3.5: usage-probe extension that captures per-request usage metrics.
// Records: convId, requestIndex, requested model, provider-reported model,
// sessionId, prompt chars, message/tool hashes, and usage stats.

import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import type { Extension } from '@earendil-works/pi-durable';

export interface UsageRecord {
  convId: string;
  requestIndex: number;
  model: string; // Requested model
  responseModel?: string; // Provider-reported model
  sessionId?: string; // pi.provider sessionId
  promptChars: number;
  messagesHash: string;
  toolsHash: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: number;
  };
  timestamp: number;
  constraints: string[];
}

/**
 * Create a usage probe extension that logs to a JSONL file.
 * Hooks beforeRequest (captures request context) and afterResponse (captures usage).
 */
export function createUsageProbe(outputPath: string): Extension {
  const requestContext = new Map<
    string,
    {
      promptChars: number;
      messagesHash: string;
      toolsHash: string;
      requestIndex: number;
    }
  >();

  return {
    name: 'usage-probe',
    description: 'Captures per-request usage metrics for fork comparison',

    beforeRequest: async (ctx) => {
      const constraints: string[] = [];
      const convId = ctx.conversation?.id;
      if (!convId) {
        constraints.push('beforeRequest: no conversation id');
        return;
      }

      // Capture request context
      const messages = (ctx.request as any).messages || [];
      const tools = (ctx.request as any).tools || [];
      const systemSections = (ctx.request as any).system || [];

      const promptText = JSON.stringify({ messages, system: systemSections });
      const promptChars = promptText.length;
      const messagesHash = createHash('sha256').update(promptText).digest('hex').slice(0, 16);
      const toolsHash = createHash('sha256')
        .update(JSON.stringify(tools))
        .digest('hex')
        .slice(0, 16);

      // Request index: count existing records for this conversation
      const requestIndex = requestContext.size;

      requestContext.set(convId, {
        promptChars,
        messagesHash,
        toolsHash,
        requestIndex,
      });
    },

    afterResponse: async (ctx) => {
      const constraints: string[] = [];
      const convId = ctx.conversation?.id;
      if (!convId) {
        constraints.push('afterResponse: no conversation id');
        return;
      }

      const reqCtx = requestContext.get(convId);
      if (!reqCtx) {
        constraints.push('afterResponse: no beforeRequest context');
        return;
      }

      // Extract usage from response
      const response = (ctx.response as any) || {};
      const message = response.message || {};
      const usage = response.usage || {};

      // Provider-reported model
      const responseModel = message.model || undefined;
      if (!responseModel) {
        constraints.push('afterResponse: no response.message.model');
      }

      // Session ID from pi.provider (if accessible)
      let sessionId: string | undefined;
      try {
        const provider = (ctx as any).provider || (ctx.conversation as any)?.provider;
        sessionId = provider?.sessionId;
        if (!sessionId) {
          constraints.push('afterResponse: no sessionId in provider');
        }
      } catch {
        constraints.push('afterResponse: cannot access provider');
      }

      const record: UsageRecord = {
        convId,
        requestIndex: reqCtx.requestIndex,
        model: (ctx.request as any).model || 'unknown',
        responseModel,
        sessionId,
        promptChars: reqCtx.promptChars,
        messagesHash: reqCtx.messagesHash,
        toolsHash: reqCtx.toolsHash,
        usage: {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          cost: usage.cost,
        },
        timestamp: Date.now(),
        constraints,
      };

      // Write to JSONL
      await appendFile(outputPath, JSON.stringify(record) + '\n', 'utf8');
    },
  };
}

/**
 * Read usage records from a JSONL file.
 */
export async function readUsageRecords(path: string): Promise<UsageRecord[]> {
  try {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(path, 'utf8');
    return content
      .trim()
      .split('\n')
      .filter((line) => line)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
