#!/usr/bin/env -S npx tsx
/**
 * Guard self-test for the journey-wall-clock-budget guard (HOK-3425): a journey
 * is bound by monitor ticks, never wall-clock seconds.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, runSourceGuard } from './lib/source-guard.ts';
import { JOURNEY_WALL_CLOCK_BUDGET_GUARD } from '../shared/lib/journey-wall-clock-budget-guard.ts';

describe('journey-wall-clock-budget guard', () => {
  // protects: a journey that reads or rescales a wall-clock budget must fail
  // preflight (the JOURNEY_BUDGET_SECONDS / private BUDGET regression class).
  it('flags JOURNEY_BUDGET_SECONDS and a bare BUDGET inside tests/journeys/', () => {
    const source = [
      '#!/usr/bin/env bash',
      'JOURNEY_BUDGET_SECONDS=$(( ${JOURNEY_BUDGET_SECONDS:-0} * 2 ))',
      'BUDGET="${JOURNEY_BUDGET_SECONDS:-90}"',
      '(( $(date +%s) - STARTED_AT < BUDGET )) || fail "past budget"',
    ].join('\n');
    const findings = checkGuardSource(JOURNEY_WALL_CLOCK_BUDGET_GUARD, 'tests/journeys/synthetic.journey.sh', source);
    const patterns = findings.map((f) => f.pattern).sort();
    assert.deepEqual(patterns, [
      // line 2 has JOURNEY_BUDGET_SECONDS twice but the per-line scan reports
      // one finding per pattern per line; line 3 adds both patterns.
      'journey-wall-clock-budget-var',
      'journey-wall-clock-budget-var',
      'retired-journey-budget-seconds',
      'retired-journey-budget-seconds',
    ]);
  });

  // protects: the monitor-tick budget primitive (journey_set_tick_budget /
  // JOURNEY_TICK_BUDGET) is the allowed replacement and must never fire.
  it('does not flag the tick-budget primitive', () => {
    const source = [
      '#!/usr/bin/env bash',
      'journey_set_tick_budget 85',
      'JOURNEY_TICK_BUDGET=0',
      'journey_set_tick_budget "${JOURNEY_TICK_BUDGET:-170}"',
    ].join('\n');
    const findings = checkGuardSource(JOURNEY_WALL_CLOCK_BUDGET_GUARD, 'tests/journeys/synthetic.journey.sh', source);
    assert.deepEqual(findings.map((f) => f.pattern), []);
  });

  // protects: the generic BUDGET noun stays scoped to journeys; production
  // shell may keep an unrelated BUDGET variable without tripping the guard.
  it('scopes the generic BUDGET pattern to tests/journeys/ only', () => {
    const source = [
      '#!/usr/bin/env bash',
      'BUDGET=1000  # a token budget, unrelated to journeys',
    ].join('\n');
    const outside = checkGuardSource(JOURNEY_WALL_CLOCK_BUDGET_GUARD, 'shared/lib/some-tool.sh', source);
    assert.deepEqual(outside.map((f) => f.pattern), []);
    // JOURNEY_BUDGET_SECONDS, by contrast, is forbidden everywhere.
    const global = checkGuardSource(
      JOURNEY_WALL_CLOCK_BUDGET_GUARD,
      'shared/lib/some-tool.sh',
      'JOURNEY_BUDGET_SECONDS=5',
    );
    assert.deepEqual(global.map((f) => f.pattern), ['retired-journey-budget-seconds']);
  });

  // protects: comment prose naming a shape is not an occurrence of it.
  it('does not flag prose in a comment', () => {
    const source = [
      '#!/usr/bin/env bash',
      '# JOURNEY_BUDGET_SECONDS is retired; use a BUDGET of monitor ticks instead.',
      'journey_set_tick_budget 60',
    ].join('\n');
    const findings = checkGuardSource(JOURNEY_WALL_CLOCK_BUDGET_GUARD, 'tests/journeys/synthetic.journey.sh', source);
    assert.deepEqual(findings.map((f) => f.pattern), []);
  });

  // protects: a justified exception can be suppressed on one line.
  it('suppresses one line with the allow-journey-wall-clock-budget marker', () => {
    const source = [
      '#!/usr/bin/env bash',
      '# allow-journey-wall-clock-budget: replaying the retired shape on purpose.',
      'JOURNEY_BUDGET_SECONDS=5',
    ].join('\n');
    const findings = checkGuardSource(JOURNEY_WALL_CLOCK_BUDGET_GUARD, 'tests/journeys/synthetic.journey.sh', source);
    assert.deepEqual(findings.map((f) => f.pattern), []);
  });

  // protects: the live repo already satisfies the invariant and the guard
  // never names its own spec file.
  it('passes on the real repo and excludes the invariant source', () => {
    const result = runSourceGuard(JOURNEY_WALL_CLOCK_BUDGET_GUARD, join(dirname(fileURLToPath(import.meta.url)), '..'));
    assert.deepEqual(
      result.findings.filter((f) => JOURNEY_WALL_CLOCK_BUDGET_GUARD.invariantPaths.includes(f.file)),
      [],
    );
    assert.equal(result.ok, true);
  });
});
