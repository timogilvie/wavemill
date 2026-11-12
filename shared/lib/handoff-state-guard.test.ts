import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HANDOFF_STATE_GUARD } from './handoff-state-guard.ts';
import { checkGuardSource, runSourceGuard } from '../../tools/lib/source-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

function findingsOf(file: string, source: string) {
  return checkGuardSource(HANDOFF_STATE_GUARD, file, source).map((f) => f.pattern);
}

describe('handoff-state guard (HOK-3450)', () => {
  it('flags a private TS comparison against a handoff state', () => {
    for (const source of [
      "if (record.state === 'ready-published') grant();",
      "const taken = handoff.state !== 'tend-claimed';",
      "if ('tend-claimed' === record.state) skip();",
      "if (handoffRecord.state === 'checked') wait();",
    ]) {
      assert.deepEqual(findingsOf('shared/lib/x.ts', source), ['ts-private-handoff-state-equality'], source);
    }
  });

  it('flags a private shell/jq comparison against a handoff state', () => {
    for (const source of [
      'if [[ "$(jq -r .state "$f")" == "ready-published" ]]; then',
      "jq -e '.state == \"tend-claimed\"' \"$f\"",
      "jq -e '.state != \"checked\"' \"$f\"",
    ]) {
      assert.deepEqual(findingsOf('shared/lib/x.sh', source), ['sh-private-handoff-state-equality'], source);
    }
  });

  it('leaves non-comparisons and the shared predicate alone', () => {
    for (const source of [
      'if (handoffStateIsPublished(record.state)) grant();',
      "const record = { state: 'ready-published' };",
      "const result = action === 'checked' ? a : b;",
      "log('no ready-published handoff for live head');",
    ]) {
      assert.deepEqual(findingsOf('shared/lib/x.ts', source), [], source);
    }
  });

  it('honours inline suppression', () => {
    assert.deepEqual(
      findingsOf('shared/lib/x.ts', "// allow-handoff-state: legacy reader\nif (record.state === 'ready-published') grant();"),
      [],
    );
  });

  it('passes on the repo with an empty allowlist', () => {
    const result = runSourceGuard(HANDOFF_STATE_GUARD, repoRoot);
    assert.equal(result.ok, true, `findings: ${JSON.stringify(result.findings)}`);
  });
});
