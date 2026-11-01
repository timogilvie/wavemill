#!/usr/bin/env -S npx tsx
/**
 * read-coding-failure-handoff — print the typed reason from a coding failure handoff
 *
 * Thin CLI bridge (HOK-2933) between the shell failure classifier in
 * shared/lib/wavemill-monitor.sh and readCodingFailureHandoff. On a valid
 * handoff the reason ("no_completion_artifact" | "invalid_completion_artifact"
 * | "provider_error" | "budget_exhausted" (HOK-3362)) is printed to stdout and
 * the tool exits 0. A missing,
 * malformed, or schema-invalid file exits non-zero with the error on stderr,
 * which the shell caller treats as "no typed evidence".
 */
import { runTool } from '../shared/lib/tool-runner.ts';
import { readCodingFailureHandoff } from '../shared/lib/native-agent/coding-failure-handoff.ts';
import { errorMessage } from '../shared/lib/error-utils.ts';

runTool({
  name: 'read-coding-failure-handoff',
  description: 'Print the validated reason from a .coding-failure-handoff.json file',
  options: {},
  positional: {
    name: 'handoff-file',
    description: 'Path to the .coding-failure-handoff.json file',
    required: true,
  },
  examples: [
    'npx tsx tools/read-coding-failure-handoff.ts features/my-feature/.coding-failure-handoff.json',
  ],
  async run({ positional }) {
    const filePath = positional[0];
    let result: Awaited<ReturnType<typeof readCodingFailureHandoff>>;
    try {
      result = await readCodingFailureHandoff(filePath);
    } catch (error) {
      throw new Error(`Cannot read coding failure handoff at ${filePath}: ${errorMessage(error)}`);
    }
    if (!result.ok) {
      throw new Error(`${result.code}: ${result.message}`);
    }
    console.log(result.value.reason);
  },
});
