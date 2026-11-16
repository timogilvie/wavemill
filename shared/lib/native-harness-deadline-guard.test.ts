import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, formatGuardResult, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { NATIVE_HARNESS_DEADLINE_GUARD } from './native-harness-deadline-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const patternsOf = (file: string, source: string) =>
  checkGuardSource(NATIVE_HARNESS_DEADLINE_GUARD, file, source).map((finding) => finding.pattern);

describe('native-harness-deadlines guard — private stage deadlines', () => {
  it('flags an abort timer in a native stage file', () => {
    assert.ok(
      patternsOf('shared/lib/native-agent/scratch.ts', 'setTimeout(() => controller.abort(), 60_000);\n')
        .includes('elapsed-stage-deadline'),
    );
  });

  it('flags AbortSignal.timeout in a native stage file', () => {
    assert.ok(
      patternsOf('shared/lib/native-agent/scratch.ts', 'const signal = AbortSignal.timeout(600_000);\n')
        .includes('elapsed-stage-deadline'),
    );
  });

  it('flags an elapsed-since-start comparison that gates a stage', () => {
    assert.ok(
      patternsOf('shared/lib/native-agent/scratch.ts', 'if (Date.now() - startedAt > deadlineMs) stop();\n')
        .includes('elapsed-stage-deadline'),
    );
    assert.ok(
      patternsOf('shared/lib/native-agent/scratch.ts', 'if (millClockNowMs() - launchedAtMs >= limitMs) stop();\n')
        .includes('elapsed-stage-deadline'),
    );
  });

  it('does not flag a duration recorded for measurement', () => {
    assert.deepEqual(
      patternsOf('shared/lib/native-agent/scratch.ts', 'const elapsedMs = Date.now() - startedAt;\n'),
      [],
    );
  });

  it('honours the suppression marker on the line and above', () => {
    assert.deepEqual(
      patternsOf(
        'shared/lib/native-agent/scratch.ts',
        'setTimeout(() => controller.abort(), 1_000); // allow-native-harness-deadline: per-call tool timeout\n',
      ),
      [],
    );
    assert.deepEqual(
      patternsOf(
        'shared/lib/native-agent/scratch.ts',
        "// allow-native-harness-deadline: per-call process timeout\nconst signal = AbortSignal.timeout(5_000);\n",
      ),
      [],
    );
  });

  it('ignores whole-line comments naming the forbidden shape', () => {
    assert.deepEqual(
      patternsOf('shared/lib/native-agent/scratch.ts', '// setTimeout(() => controller.abort(), 60_000) is now the controller\'s job\n'),
      [],
    );
  });
});

describe('native-harness-deadlines guard — retired budget name', () => {
  it('flags the misleading wall-clock budget name', () => {
    assert.ok(
      patternsOf('shared/lib/native-agent/scratch.ts', 'const budget = { maxWallClockMs: 1_000 };\n')
        .includes('legacy-wall-clock-budget'),
    );
    assert.ok(
      patternsOf('shared/lib/native-agent/scratch.ts', "const kind = 'wall_clock';\n")
        .includes('legacy-wall-clock-budget'),
    );
  });

  it('is scoped to native stage sources', () => {
    assert.deepEqual(
      patternsOf('shared/lib/eval-schema.ts', "type Stop = 'wall_clock_limit';\n"),
      [],
    );
  });
});

describe('native-harness-deadlines guard — repository', () => {
  it('passes at HEAD with a reasoned, ratcheted allowlist', () => {
    const result = runSourceGuard(NATIVE_HARNESS_DEADLINE_GUARD, repoRoot);
    assert.deepEqual(result.findings, [], formatGuardResult(NATIVE_HARNESS_DEADLINE_GUARD, result));
  });
});
