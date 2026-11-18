import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHALLENGE_SELECTION_SITE_GUARD } from './challenge-selection-site-guard.ts';
import { checkGuardSource, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

function findingsOf(file: string, source: string) {
  return checkGuardSource(CHALLENGE_SELECTION_SITE_GUARD, file, source).map((f) => f.pattern);
}

describe('challenge-selection-site guard', () => {
  it('flags a resolve-challenge-task.ts call without --resolve-sealed', () => {
    assert.deepEqual(
      findingsOf('shared/lib/wavemill-monitor.sh', 'refreshed_plan=$(_with_timeout "$API_TIMEOUT" wavemill_run_tool "resolve-challenge-task.ts" --issue "$issue")'),
      ['sh-run-tool-no-resolve-sealed'],
    );
  });

  it('allows a resolve-challenge-task.ts call with --resolve-sealed', () => {
    assert.deepEqual(
      findingsOf('shared/lib/wavemill-monitor.sh', 'resolution=$(_with_timeout "$API_TIMEOUT" wavemill_run_tool "resolve-challenge-task.ts" --resolve-sealed --sealed-intent "$existing_intent")'),
      [],
    );
  });

  it('allows an unsealed launch site when suppressed inline', () => {
    assert.deepEqual(
      // allow-template-curly: test fixture contains literal shell variable syntax
      findingsOf('shared/lib/wavemill-mill.sh', '# allow-challenge-selection-site: launch\nchallenge_plan=$(npx tsx "$TOOLS_DIR/resolve-challenge-task.ts" "${challenge_args[@]}")'),
      [],
    );
  });

  it('flags the challenger_never_launched symptom string', () => {
    assert.deepEqual(
      findingsOf('shared/lib/x.sh', 'reason="challenger_never_launched"'),
      ['sh-challenger-never-launched'],
    );
  });

  it('passes on a clean repo with an empty allowlist', () => {
    const result = runSourceGuard(CHALLENGE_SELECTION_SITE_GUARD, repoRoot);
    assert.equal(result.ok, true, `findings: ${JSON.stringify(result.findings)}`);
  });
});
