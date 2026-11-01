import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, formatGuardResult, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { HOOK_TTL_GUARD } from './hook-ttl-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const patternsOf = (file: string, source: string) =>
  checkGuardSource(HOOK_TTL_GUARD, file, source).map((finding) => finding.pattern);

describe('hook-ttl guard — forbidden shapes', () => {
  it('flags the TTL constant outside the primitive', () => {
    assert.deepEqual(patternsOf('a.sh', '(( age < WAVEMILL_HOOK_TTL_SECONDS ))\n'), ['hook-ttl-constant']);
    assert.deepEqual(patternsOf('a.ts', "import { HOOK_TTL_SECONDS } from './task-progress.ts';\n"), ['hook-ttl-constant']);
  });

  it('flags a raw jq timestamp read from a hook file', () => {
    assert.deepEqual(patternsOf('a.sh', 'hook_ts=$(jq -r \'.timestamp // 0\' "$hook_file" 2>/dev/null || echo 0)\n'), ['raw-hook-timestamp-read']);
    assert.deepEqual(patternsOf('a.sh', 'ts=$(jq -r \'.agentRecord.timestamp // 0\' "$hook" )\n'), ['raw-hook-timestamp-read']);
  });

  it('flags a hard-coded 300s freshness comparison', () => {
    assert.deepEqual(patternsOf('a.sh', '(( now - hook_ts < 300 )) || return 0\n'), ['hook-ttl-literal']);
    assert.deepEqual(patternsOf('a.sh', 'if (( staleness < 300 )); then\n'), ['hook-ttl-literal']);
    assert.deepEqual(patternsOf('a.sh', '[[ $hook_age -lt 300 ]] && echo fresh\n'), ['hook-ttl-literal']);
    assert.deepEqual(patternsOf('a.ts', 'const fresh = nowMs - hook.timestamp * 1000 < 300_000;\n'), ['hook-ttl-literal']);
  });
});

describe('hook-ttl guard — clean shapes', () => {
  it('ignores the primitive accessors and unrelated 300s', () => {
    const source = [
      'state=$(wavemill_hook_read "$SESSION" "$issue" state --fresh)',
      'progress=$(task_progress_json "$issue")',
      'jq -r \'.timestamp\' "$event_log"',
      'sleep 300',
      '(( elapsed < 300 ))',
      '',
    ].join('\n');
    assert.deepEqual(patternsOf('a.sh', source), []);
    assert.deepEqual(patternsOf('a.ts', 'const progress = getTaskProgress(opts);\nconst timeoutMs = 300;\n'), []);
  });

  it('honours the allow-hook-ttl suppression', () => {
    assert.deepEqual(patternsOf('a.sh', '# allow-hook-ttl: standalone fallback\n(( now - hook_ts < 300 ))\n'), []);
  });
});

describe('hook-ttl guard — repository', () => {
  it('passes at HEAD with the seeded count ratchet', () => {
    const result = runSourceGuard(HOOK_TTL_GUARD, repoRoot);
    assert.deepEqual(result.findings, [], formatGuardResult(HOOK_TTL_GUARD, result));
  });
});
