#!/usr/bin/env -S npx tsx
/**
 * Guard self-test for the world-lifetime guard (HOK-3329): parses a synthetic
 * shell source with each forbidden shape and asserts the guard reports exactly
 * those lines, plus one suppression-marker roundtrip.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, runSourceGuard } from './lib/source-guard.ts';
import { WORLD_LIFETIME_GUARD } from '../shared/lib/world-lifetime-guard.ts';

describe('world-lifetime guard', () => {
  it('flags each forbidden shape in test/shell code', () => {
    const source = [
      '#!/usr/bin/env bash',
      'tmux new-session -d -s s -n w "sleep 60"',
      'tmux -S "$sock" kill-server',
      'set -m',
      'cmd &',
      'sleep 86400',
      'real_tmux="$(type -P tmux || true)"',
      'FAKE_TMUX_REAL="$(command -v tmux || true)"',
      'while :; do sleep 1; done',
    ].join('\n');
    const findings = checkGuardSource(WORLD_LIFETIME_GUARD, 'tests/synthetic-journey.sh', source);
    const patterns = findings.map((f) => f.pattern).sort();
    assert.deepEqual(patterns, [
      'ad-hoc-kill-server',
      'ad-hoc-set-m',
      'ad-hoc-tmux-new-session',
      'private-command-v-tmux',
      'private-type-p-tmux',
      'sleep-86400-placeholder',
    ]);
    // The sleep-loop line is allowed; the placeholder itself fires (line 6).
    assert.equal(findings.find((f) => f.pattern === 'sleep-86400-placeholder')!.line, 6);
  });

  it('does not flag prose that merely names a shape in a comment', () => {
    const source = [
      '#!/usr/bin/env bash',
      '# fakes_setup owns tmux new-session and kill-server; never do it here.',
      'sleep 1',
    ].join('\n');
    const findings = checkGuardSource(WORLD_LIFETIME_GUARD, 'tests/synthetic-journey.sh', source);
    assert.deepEqual(findings.map((f) => f.pattern), []);
  });

  it('suppresses one line with the allow-world-lifetime marker', () => {
    const source = [
      '#!/usr/bin/env bash',
      "# allow-world-lifetime: replaying the refusal is this test's point.",
      '$WRAP kill-server',
    ].join('\n');
    const findings = checkGuardSource(WORLD_LIFETIME_GUARD, 'tests/synthetic-journey.sh', source);
    assert.deepEqual(findings.map((f) => f.pattern), []);
  });

  it('excludes the invariant source itself from the repo scan', () => {
    // runSourceGuard is what applies invariantPaths exclusion (checkGuardSource
    // is the per-file primitive, used above); scanning the real repo must be
    // clean and must never name an invariant path.
    const result = runSourceGuard(WORLD_LIFETIME_GUARD, join(dirname(fileURLToPath(import.meta.url)), '..'));
    assert.deepEqual(
      result.findings.filter((f) => WORLD_LIFETIME_GUARD.invariantPaths.includes(f.file)),
      [],
    );
    assert.equal(result.ok, true);
  });
});