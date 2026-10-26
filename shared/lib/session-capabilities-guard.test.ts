import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, formatGuardResult, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { SESSION_CAPABILITIES_GUARD } from './session-capabilities-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const patternsOf = (file: string, source: string) =>
  checkGuardSource(SESSION_CAPABILITIES_GUARD, file, source).map((finding) => finding.pattern);

describe('session-capabilities guard — forbidden shapes', () => {
  it('flags raw capability inputs read from config in TS', () => {
    assert.deepEqual(patternsOf('a.ts', 'if (config.integration?.enabled) produce();\n'), ['capability-config-read']);
    assert.deepEqual(patternsOf('a.ts', 'const on = cfg.useMillSession === true;\n'), ['capability-config-read']);
    assert.deepEqual(patternsOf('a.ts', 'if (config.mergeQueue.enabled) release();\n'), ['capability-config-read']);
    assert.deepEqual(patternsOf('a.ts', 'const obs = config.observer?.enabled !== false;\n'), ['capability-config-read']);
  });

  it('flags jq re-derivations and the env override in shell', () => {
    assert.deepEqual(patternsOf('a.sh', "on=$(jq -r '.integration.enabled // false' \"$cfg\")\n"), ['capability-config-read']);
    assert.deepEqual(patternsOf('a.sh', 'if [[ "$MERGE_QUEUE_ENABLED" == "true" ]]; then\n'), ['merge-queue-env']);
    assert.deepEqual(patternsOf('a.ts', "const on = process.env.MERGE_QUEUE_ENABLED === '1';\n"), ['merge-queue-env']);
  });
});

describe('session-capabilities guard — clean shapes', () => {
  it('ignores the resolver API and prose without a member access', () => {
    const source = [
      "const caps = resolveSessionCapabilities(repoDir);",
      "if (caps.mergeExecutor === 'tend') handoff();",
      "const hint = 'enable integration (integration enabled + useMillSession)';",
      '',
    ].join('\n');
    assert.deepEqual(patternsOf('a.ts', source), []);
    assert.deepEqual(patternsOf('a.sh', 'if wavemill_session_has merge-queue; then\n'), []);
  });

  it('honours the allow-session-capabilities suppression', () => {
    assert.deepEqual(patternsOf('a.sh', 'x="$MERGE_QUEUE_ENABLED"  # allow-session-capabilities: passthrough\n'), []);
  });
});

describe('session-capabilities guard — repository', () => {
  it('passes at HEAD', () => {
    const result = runSourceGuard(SESSION_CAPABILITIES_GUARD, repoRoot);
    assert.deepEqual(result.findings, [], formatGuardResult(SESSION_CAPABILITIES_GUARD, result));
  });
});
