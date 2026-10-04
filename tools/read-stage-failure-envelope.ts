#!/usr/bin/env -S npx tsx
/**
 * read-stage-failure-envelope — print typed evidence from a stage-failure envelope
 *
 * Thin CLI bridge (HOK-3064) between the shell failure classifier in
 * shared/lib/wavemill-monitor.sh and readStageFailureEnvelope. On a valid
 * envelope, one JSON line is printed to stdout:
 *
 *   {"failureKind":…,"cause":…,"provider":…,"model":…,"agent":…,"requestedModel":…}
 *
 * where failureKind is the single cause→kind conversion
 * (terminalFailureKindForEnvelope). A missing, malformed, or schema-invalid
 * file exits non-zero with the error on stderr, which the shell caller treats
 * as "no typed evidence" and falls back to substring matching.
 */
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  readStageFailureEnvelope,
  terminalFailureKindForEnvelope,
} from '../shared/lib/native-agent/stage-failure-envelope.ts';
import { errorMessage } from '../shared/lib/error-utils.ts';

runTool({
  name: 'read-stage-failure-envelope',
  description: 'Print validated typed evidence from a .{stage}-failure-envelope.json file',
  options: {},
  positional: {
    name: 'envelope-file',
    description: 'Path to the .{stage}-failure-envelope.json file',
    required: true,
  },
  examples: [
    'npx tsx tools/read-stage-failure-envelope.ts features/my-feature/.review-failure-envelope.json',
  ],
  async run({ positional }) {
    const filePath = positional[0];
    let result: Awaited<ReturnType<typeof readStageFailureEnvelope>>;
    try {
      result = await readStageFailureEnvelope(filePath);
    } catch (error) {
      throw new Error(`Cannot read stage failure envelope at ${filePath}: ${errorMessage(error)}`);
    }
    if (!result.ok) {
      throw new Error(`${result.code}: ${result.message}`);
    }
    const envelope = result.value;
    console.log(JSON.stringify({
      failureKind: terminalFailureKindForEnvelope(envelope),
      cause: envelope.cause,
      stage: envelope.stage,
      provider: envelope.provider,
      model: envelope.model,
      agent: envelope.agent,
      ...(envelope.requestedModel ? { requestedModel: envelope.requestedModel } : {}),
    }));
  },
});
