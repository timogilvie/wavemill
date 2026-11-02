#!/usr/bin/env tsx
/**
 * validate-task-record-write — shell bridge to the HOK-3222 write guard.
 *
 * `state_mutate` (shared/lib/wavemill-common.sh) runs this with the lock held,
 * after jq has written the candidate state and before the atomic rename, for
 * every write to `workflow-state.json`. It validates the task records the
 * write added or changed (`--before` vs `--after`) with the same precompiled
 * validator `mutateJsonState` uses, and shadow-reports violations
 * (`state-schema-violations.jsonl` next to `--state-path`, stderr, observer).
 *
 * It also applies the HOK-3373 settlement gate: a control write against a
 * settled or non-current run (`--expected-run-id issue=runId`) is reverted in
 * the candidate, which this tool then rewrites in place, so `state_mutate`
 * installs the corrected state.
 *
 * Exit status: 0 = clean, 2 = schema violations found and reported, 3 = the
 * settlement gate reverted at least one control write (the candidate was
 * rewritten), anything else = the check itself could not run (unreadable
 * input). The write always proceeds with the (possibly rewritten) candidate.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { runTool } from '../shared/lib/tool-runner.ts';
import { prepareTaskRecordWriteCheck } from '../shared/lib/task-record-write-guard.ts';
import { parseExpectedRunIds } from '../shared/lib/task-settlement.ts';

/** Exit status for "violations found" (distinct from a crash's 1). */
const VIOLATIONS_EXIT_CODE = 2;
/** Exit status for "settlement gate rewrote the candidate". */
const GATE_REVERTED_EXIT_CODE = 3;

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw new Error(`--${label} ${path} is not readable JSON: ${(error as Error).message}`);
  }
}

runTool({
  name: 'validate-task-record-write',
  description: 'Validate task records a workflow-state.json write adds or changes (HOK-3222)',
  options: {
    before: { type: 'string', description: 'State file before the write (read under the lock)' },
    after: { type: 'string', description: 'Candidate state the write would install' },
    'state-path': { type: 'string', description: 'The real state file path (names the log location); defaults to --before' },
    'expected-run-id': { type: 'string', description: 'issue=runId[,issue=runId]: the run(s) this write acted for (HOK-3373)' },
  },
  examples: [
    'npx tsx tools/validate-task-record-write.ts --before .wavemill/workflow-state.json --after .wavemill/workflow-state.json.tmp.123',
  ],
  run({ args }) {
    const beforePath = args.before;
    const afterPath = args.after;
    if (!beforePath || !afterPath) throw new Error('--before and --after are required');
    const statePath = args['state-path'] || beforePath;
    const check = prepareTaskRecordWriteCheck(statePath, readJson(beforePath, 'before'), 'shell', {
      expectedRunIds: parseExpectedRunIds(args['expected-run-id']),
    });
    if (!check) return;
    const candidate = readJson(afterPath, 'after');
    const result = check(candidate);
    if (result.reverted) {
      writeFileSync(afterPath, `${JSON.stringify(candidate)}\n`, 'utf-8');
      process.exitCode = GATE_REVERTED_EXIT_CODE;
    } else if (result.violations.length > 0) {
      process.exitCode = VIOLATIONS_EXIT_CODE;
    }
  },
});
