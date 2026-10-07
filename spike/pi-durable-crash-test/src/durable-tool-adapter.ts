// Durable Tool Adapter
// Mirrors tools/pi-adapter.ts but adapts to pi-durable defineTool

import { defineTool } from '@earendil-works/pi-durable';
import { Type } from '@sinclair/typebox';

// Type definitions for Wavemill tool results
interface WavemillToolResult {
  content: string;
  details?: Record<string, any>;
  control?: { terminate: boolean } | { yield: boolean };
}

// Tool descriptor interface (mirroring wavemill structures)
interface ToolDescriptor {
  name: string;
  description: string;
  parameters: any;
  execute: (args: any, taskId: string, signal: AbortSignal) => Promise<WavemillToolResult>;
}

/**
 * Convert a Wavemill tool descriptor to a pi-durable tool
 * @param descriptor Wavemill tool descriptor
 * @param replay Replay safety label ('safe' or 'unsafe')
 * @returns pi-durable tool definition
 */
export function toDurableTool(descriptor: ToolDescriptor, replay: 'safe' | 'unsafe') {
  return defineTool({
    name: descriptor.name,
    description: descriptor.description,
    parameters: descriptor.parameters,
    replay: replay === 'safe' ? 'safe' : 'unsafe',
    execute: async (args, api, ctx) => {
      try {
        // Call the Wavemill tool implementation
        const result = await descriptor.execute(args, api.taskId, ctx.signal);
        
        // Map WavemillToolResult to pi-durable result format
        return {
          content: result.content,
          details: result.details,
          control: result.control?.terminate ? { terminate: true } : undefined
        };
      } catch (error) {
        // Handle errors appropriately
        return {
          content: `Error executing tool ${descriptor.name}: ${error instanceof Error ? error.message : String(error)}`,
          isError: true
        };
      }
    }
  });
}

// Schema bridging function for typebox compatibility
export function bridgeSchema(schema: any): any {
  // If the schema validation fails, try JSON serialization/deserialization
  try {
    return JSON.parse(JSON.stringify(schema));
  } catch (error) {
    console.warn('Failed to bridge schema:', error);
    return schema;
  }
}
