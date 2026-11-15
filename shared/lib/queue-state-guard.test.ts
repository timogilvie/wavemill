import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUEUE_STATE_GUARD } from './queue-state-guard.ts';
import { checkGuardSource, runSourceGuard } from '../../tools/lib/source-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

function findingsOf(file: string, source: string) {
  return checkGuardSource(QUEUE_STATE_GUARD, file, source).map((f) => f.pattern);
}

describe('queue-state guard (HOK-3453)', () => {
  it('accepts every declared shell writer shape', () => {
    for (const source of [
      '        queueState: "ready-stale",',
      '        queueState: "merge-candidate",',
      `jq -cn --argjson base "$base_json" '$base + {queueState:"merge-needed", mergeExecutor:$executor}'`,
      `      extra_json='{"queueState":"ready"}'`,
      '          queueState: null,',
      '            queueState: (if $queue_state == "" then null else $queue_state end),',
      `queue_state=$(jq -r '.artifacts.queueState // empty' "$result_file")`,
    ]) {
      assert.deepEqual(findingsOf('shared/lib/wavemill-monitor.sh', source), [], source);
    }
  });

  it('flags a shell writer of an undeclared value', () => {
    for (const source of [
      '        queueState: "merged",',
      `jq -cn '$base + {queueState:"merge-pending"}'`,
      `      extra_json='{"queueState":"ready-later"}'`,
      `      extra_json="{\\"queueState\\":\\"parked\\"}"`,
    ]) {
      assert.deepEqual(findingsOf('shared/lib/wavemill-monitor.sh', source), ['sh-undeclared-queue-state-write'], source);
    }
  });

  it('honours inline suppression and skips comments', () => {
    assert.deepEqual(findingsOf('shared/lib/x.sh', '# allow-queue-state: legacy fixture\nqueueState: "merged"'), []);
    assert.deepEqual(findingsOf('shared/lib/x.sh', '# queueState: "merged" was the old name'), []);
  });

  it('fails a tracked fixture repo with an undeclared writer and passes once it is fixed', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'queue-state-guard-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture, stdio: 'ignore' });
      git('init', '-q');
      mkdirSync(join(fixture, 'shared', 'lib'), { recursive: true });
      const writer = join(fixture, 'shared', 'lib', 'writer.sh');
      writeFileSync(writer, `patch=$(jq -cn '{queueState: "merge-needed"}')\nbad=$(jq -cn '{queueState: "done"}')\n`);
      git('add', '.');

      const failing = runSourceGuard(QUEUE_STATE_GUARD, fixture);
      assert.equal(failing.ok, false);
      assert.deepEqual(
        failing.findings.map((f) => `${f.file}:${f.line}:${f.pattern}`),
        ['shared/lib/writer.sh:2:sh-undeclared-queue-state-write'],
      );

      writeFileSync(writer, `patch=$(jq -cn '{queueState: "merge-needed"}')\n`);
      const passing = runSourceGuard(QUEUE_STATE_GUARD, fixture);
      assert.equal(passing.ok, true, `findings: ${JSON.stringify(passing.findings)}`);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('passes on the repo with an empty allowlist', () => {
    const result = runSourceGuard(QUEUE_STATE_GUARD, repoRoot);
    assert.equal(result.ok, true, `findings: ${JSON.stringify(result.findings)}`);
  });
});
