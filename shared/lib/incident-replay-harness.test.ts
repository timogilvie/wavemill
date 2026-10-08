/**
 * HOK-3177 — incident replay harness test suite.
 *
 * Registered in `tests/run-custom-tests.sh` (CUSTOM_TS_TESTS). Fails loud on
 * any fixture that does not converge within its tick budget.
 *
 * Uses the custom harness `process.exit(1)` style; each fixture is a
 * table-driven subtest.
 */

import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INCIDENT_REPLAY_FAULTS,
  runFixture,
  type IncidentReplayFault,
} from './incident-replay-harness.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Test lives in shared/lib/; fixtures live in tests/fixtures/incident-replay/.
const FIXTURES_DIR = resolve(__dirname, '..', '..', 'tests', 'fixtures', 'incident-replay');

interface SubtestFailure {
  fixture: string;
  reason: string;
}

function listFixtures(): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(FIXTURES_DIR)) {
    const abs = join(FIXTURES_DIR, name);
    if (!statSync(abs).isFile()) continue;
    if (!name.endsWith('.json')) continue;
    entries.push(abs);
  }
  return entries.sort();
}

function main(): void {
  const fixtures = listFixtures();
  if (fixtures.length === 0) {
    console.error(`[incident-replay-harness] no fixtures found under ${FIXTURES_DIR}`);
    process.exit(1);
  }

  const faultsCovered = new Set<IncidentReplayFault>();
  const failures: SubtestFailure[] = [];
  let passed = 0;

  for (const fixturePath of fixtures) {
    const label = basename(fixturePath);
    try {
      const { fixture, run, assertion } = runFixture(fixturePath);
      faultsCovered.add(fixture.fault);
      if (!assertion.ok) {
        failures.push({ fixture: label, reason: assertion.reason ?? 'assertion failed' });
        console.error(`  FAIL  ${label} — ${assertion.reason ?? 'assertion failed'} (ticks=${run.ticks})`);
      } else {
        passed += 1;
        console.log(`  PASS  ${label} — outcome=${run.outcome} ticks=${run.ticks}`);
      }
    } catch (err: unknown) {
      failures.push({ fixture: label, reason: err instanceof Error ? err.message : String(err) });
      console.error(`  FAIL  ${label} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Ensure every production fault class has at least one fixture.
  const expectedFaults = INCIDENT_REPLAY_FAULTS.filter((f) => f !== 'control_no_fault');
  const uncoveredFaults = expectedFaults.filter((f) => !faultsCovered.has(f));
  if (uncoveredFaults.length > 0) {
    console.error(`[incident-replay-harness] missing fixture for faults: ${uncoveredFaults.join(', ')}`);
    process.exit(1);
  }

  console.log('');
  console.log(`[incident-replay-harness] ${passed}/${fixtures.length} fixtures passed`);
  if (failures.length > 0) {
    console.error(`[incident-replay-harness] ${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f.fixture}: ${f.reason}`);
    process.exit(1);
  }
}

main();
