#!/usr/bin/env tsx
/**
 * Resend a captured native request body, optionally edited (HOK-3261).
 *
 * Operator tool only: the mill must never invoke it. It spends real provider
 * tokens on the operator's own API key.
 */
import {
  readCapturedPayload,
  replayNativeRequest,
  ReplayInputError,
} from '../shared/lib/native-agent/request-replay.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

await runTool({
  name: 'replay-native-request',
  description: 'Resend a captured native request (native-payloads/<stage>/payload-*.json or its failure-evidence copy) through the same transport and print the reply shape and usage as JSON',
  options: {
    patch: {
      type: 'string',
      description: 'jq expression applied to the request body before it is sent',
    },
    'base-url': {
      type: 'string',
      description: 'Override the provider endpoint (required for providers other than openai/openrouter)',
    },
  },
  positional: {
    name: 'payload.json',
    description: 'Captured payload file',
    required: true,
  },
  examples: [
    'npx tsx tools/replay-native-request.ts features/<slug>/native-payloads/review/payload-<...>.json',
    'npx tsx tools/replay-native-request.ts <payload.json> --patch \'.messages[0].content += "\\nAlways cite the file."\'',
  ],
  async run({ args, positional }) {
    process.stderr.write('replay-native-request: operator tool, sends a real provider request on your API key\n');
    try {
      const result = await replayNativeRequest({
        record: readCapturedPayload(positional[0]),
        patch: args.patch,
        baseUrl: args['base-url'],
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      if (error instanceof ReplayInputError) {
        process.stderr.write(`replay-native-request: ${error.message}\n`);
        process.exit(2);
      }
      throw error;
    }
  },
});
