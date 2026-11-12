/**
 * Refused-publish fixture for the handoff-publish-refused journey (HOK-3450).
 *
 * The journey's shadow TOOLS_DIR resolves `ready-tend-handoff.ts` to this
 * wrapper (every other tool stays a symlink to the real one). While the hold
 * file exists every `publish` call is refused: it exits non-zero with a
 * refusal on stderr and writes nothing, leaving the record Ready just wrote
 * at `checked`. Once the journey removes the hold file, `publish` runs the
 * real tool. `checked` and `claim` always run the real tool.
 *
 * Env (exported by the journey):
 *   FAKE_HANDOFF_REAL_TOOL  - the real tools/ready-tend-handoff.ts (required)
 *   FAKE_HANDOFF_CALLS_FILE - scratch log, one line per publish call (required)
 *   FAKE_HANDOFF_HOLD_FILE  - publish is refused while this file exists (required)
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';

const realTool = process.env.FAKE_HANDOFF_REAL_TOOL ?? '';
const callsFile = process.env.FAKE_HANDOFF_CALLS_FILE ?? '';
const holdFile = process.env.FAKE_HANDOFF_HOLD_FILE ?? '';
if (realTool === '' || callsFile === '' || holdFile === '') {
  process.stderr.write('ready-tend-handoff-fixture.ts: FAKE_HANDOFF_REAL_TOOL, FAKE_HANDOFF_CALLS_FILE and FAKE_HANDOFF_HOLD_FILE are required\n');
  process.exit(2);
}

const args = process.argv.slice(2);
if (args[0] === 'publish') {
  const refused = existsSync(holdFile);
  appendFileSync(callsFile, `${new Date().toISOString()} ${refused ? 'refused' : 'delegated'}\n`);
  if (refused) {
    process.stderr.write('ready handoff publish refused: handoff record is held by another writer\n');
    process.exit(1);
  }
}

const result = spawnSync(process.execPath, [...process.execArgv, realTool, ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);
