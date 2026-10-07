// Policy Extension
// Mutation policy and output limits as beforeTool/afterTool hooks

import { Extension, ToolTask } from '@earendil-works/pi-durable';

/**
 * Create policy extension with beforeTool and afterTool hooks
 * @param options Policy options
 * @returns Extension with policy hooks
 */
export function createPolicyExtension(options: {
  worktreePath: string;
  wholeFileAllowlist?: string[];
}): Extension {
  return {
    name: 'wavemill-policy',
    beforeTool: async (toolCall, task) => {
      // Import and use the production mutation write policy
      // This would typically come from shared/lib/native-agent/tools/policies.ts
      // For the spike, we'll implement a simplified version
      
      if (toolCall.name === 'apply_patch') {
        // Check each target path in the patch operations
        const targetPaths = extractTargetPathsFromPatch(toolCall.arguments);
        for (const targetPath of targetPaths) {
          const decision = evaluateMutationWritePolicy({
            worktreePath: options.worktreePath,
            targetPath,
            writeKind: 'patch',
            wholeFileAllowlist: options.wholeFileAllowlist
          });
          
          if (decision.block) {
            return { block: decision.message };
          }
        }
      } else if (toolCall.name === 'write_artifact') {
        // Check write_artifact target path
        const targetPath = toolCall.arguments?.path;
        if (targetPath) {
          const decision = evaluateMutationWritePolicy({
            worktreePath: options.worktreePath,
            targetPath,
            writeKind: 'whole-file',
            wholeFileAllowlist: options.wholeFileAllowlist
          });
          
          if (decision.block) {
            return { block: decision.message };
          }
        }
      }
      
      // Also check the general tool call policy
      const toolCallDecision = evaluateBeforeToolCallPolicy(toolCall);
      if (toolCallDecision.block) {
        return { block: toolCallDecision.reason };
      }
      
      return undefined; // Allow the tool call
    },
    afterTool: async (result, toolCall, task) => {
      // Cap result text to the tool's policy.maxOutputBytes
      // Run redactSecrets on the result
      if (result.content && typeof result.content === 'string') {
        const cappedContent = capOutput(result.content, getToolMaxOutputBytes(toolCall.name));
        const redactedContent = redactSecrets(cappedContent);
        
        if (cappedContent !== result.content || redactedContent !== cappedContent) {
          return {
            ...result,
            content: redactedContent
          };
        }
      }
      
      return result;
    }
  };
}

// Simplified implementations of the policy functions
// In a real implementation, these would be imported from the production code

interface MutationPolicyDecision {
  block: boolean;
  message?: string;
}

function evaluateMutationWritePolicy(params: {
  worktreePath: string;
  targetPath: string;
  writeKind: 'patch' | 'whole-file';
  wholeFileAllowlist?: string[];
}): MutationPolicyDecision {
  // Placeholder implementation
  // In reality, this would check paths against allowlists, workspace boundaries, etc.
  return { block: false };
}

function evaluateBeforeToolCallPolicy(toolCall: any): { block: boolean; reason?: string } {
  // Placeholder implementation
  // In reality, this would check tool call arguments, paths, etc.
  return { block: false };
}

function extractTargetPathsFromPatch(args: any): string[] {
  // Placeholder implementation
  // In reality, this would extract target paths from patch operations
  return [];
}

function getToolMaxOutputBytes(toolName: string): number {
  // Default output limit
  return 100000; // 100KB
}

function capOutput(content: string, maxBytes: number): string {
  if (content.length <= maxBytes) {
    return content;
  }
  return content.substring(0, maxBytes) + '\n[output truncated]';
}

function redactSecrets(content: string): string {
  // Placeholder implementation
  // In reality, this would redact secrets using regex patterns
  return content;
}
