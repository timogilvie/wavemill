import assert from 'node:assert/strict';
import { it } from 'node:test';
import { checkGuardSource } from '../../tools/lib/source-guard.ts';
import { TASK_EVIDENCE_GUARD } from './task-evidence-guard.ts';

it('rejects retired copy helpers and a second shell stage whitelist', () => {
  for (const source of ['_wavemill_archive_copy() { cp "$1" "$2"; }', 'for stage in planning coding review; do echo "$stage"; done']) {
    assert.ok(checkGuardSource(TASK_EVIDENCE_GUARD, 'shared/lib/wavemill-common.sh', source).length > 0);
  }
  assert.deepEqual(checkGuardSource(TASK_EVIDENCE_GUARD, 'shared/lib/wavemill-common.sh', 'wavemill_run_tool archive-task-evidence.ts --issue "$issue"'), []);
});

it('rejects recursive JSON path guessing at the archive seam', () => {
  for (const source of ['jq ".. | strings | select(endswith(\\".jsonl\\"))" "$result"', 'jq \'.. | select(type == "string" and test("\\\\.jsonl$"))\' "$result"']) {
    const findings = checkGuardSource(TASK_EVIDENCE_GUARD, 'shared/lib/wavemill-common.sh', source);
    assert.ok(findings.some(f => f.pattern === 'json-path-guesser'));
  }
});
