// wavemill-test-suite: custom
/**
 * HOK-3177 — incident replay harness test suite.
 *
 * Runs in the custom suite (`tests/run-custom-tests.sh`). Fails loud on
 * any fixture that does not converge within its tick budget.
 *
 * Uses the custom harness `process.exit(1)` style; each fixture is a
 * table-driven subtest. Every fixture is driven by the real recovery loop
 * (HOK-3185). The `--mode=legacy` simulator was retired in HOK-3235.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INCIDENT_REPLAY_FAULTS,
  runFixture,
  runRealFixture,
  type IncidentReplayFault,
} from './incident-replay-harness.ts';
import { loadIncidentFixture } from './incident-fixture-converter.ts';
import { classifyArmFault } from './arm-failure-taxonomy.ts';
import { buildBudgetExhaustions } from './stage-eval-evidence.ts';
import { claimRecoveryAction, decideTaskRecovery } from './task-recovery-controller.ts';
import { classifyFailure } from './failure-policy.ts';
import { validateContractLaunchable, type ExecutionContract } from './execution-contract.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Test lives in shared/lib/; fixtures live in tests/fixtures/incident-replay/.
const FIXTURES_DIR = resolve(__dirname, '..', '..', 'tests', 'fixtures', 'incident-replay');
const REAL_FIXTURES_DIR = join(FIXTURES_DIR, 'real');
const JOURNEYS_DIR = resolve(__dirname, '..', '..', 'tests', 'journeys');
const JOURNEY_RUNNER = join(JOURNEYS_DIR, 'run-journeys.sh');
const MIN_REAL_FIXTURES = 15;

interface SubtestFailure {
  fixture: string;
  reason: string;
}

function listFixtures(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entries: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (!statSync(abs).isFile()) continue;
    if (!name.endsWith('.json')) continue;
    entries.push(abs);
  }
  return entries.sort();
}

/** Read the runner's executable registry rather than inferring registration from files. */
function registeredJourneys(): Set<string> {
  return new Set(execFileSync('bash', [JOURNEY_RUNNER, '--list'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean));
}

function journeyRegistrationError(journey: string, registered: ReadonlySet<string>): string | null {
  return registered.has(journey) ? null : `journey is not registered by ${JOURNEY_RUNNER}: ${journey}`;
}

async function main(): Promise<void> {
  const registered = registeredJourneys();
  // Regression check: a fixture cannot be accepted merely because a matching
  // file exists; an absent runner registration must fail the guard.
  if (!journeyRegistrationError('__unregistered_incident_fixture_journey__', registered)) {
    throw new Error('journey registration regression guard accepted an unregistered journey');
  }
  const syntheticFixtures = listFixtures(FIXTURES_DIR);
  if (syntheticFixtures.length === 0) {
    console.error(`[incident-replay-harness] no fixtures found under ${FIXTURES_DIR}`);
    process.exit(1);
  }

  const faultsCovered = new Set<IncidentReplayFault>();
  const failures: SubtestFailure[] = [];
  let passed = 0;
  let runs = 0;

  for (const fixturePath of syntheticFixtures) {
    const label = basename(fixturePath);
    runs += 1;
    try {
      const { fixture, run, assertion } = runFixture(fixturePath);
      if (fixture.fault) faultsCovered.add(fixture.fault);
      // The no-fault control must never trigger recovery.
      const controlReason = fixture.fault === 'control_no_fault' && run.actions?.some((a) => a !== 'skip')
        ? `control fixture triggered recovery: ${run.actions?.join(',')}`
        : undefined;
      if (!assertion.ok || controlReason) {
        const reason = controlReason ?? assertion.reason ?? 'assertion failed';
        failures.push({ fixture: label, reason });
        console.error(`  FAIL  ${label} — ${reason} (ticks=${run.ticks})`);
      } else {
        passed += 1;
        const actions = run.actions ? ` actions=${run.actions.join(',')}` : '';
        console.log(`  PASS  ${label} — outcome=${run.outcome} ticks=${run.ticks}${actions}`);
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

  // Real fixtures (HOK-3231): drive each through runRealFixture.
  const realFixtures = listFixtures(REAL_FIXTURES_DIR);
  if (realFixtures.length < MIN_REAL_FIXTURES) {
    console.error(`[incident-replay-harness] need ≥ ${MIN_REAL_FIXTURES} real fixtures, found ${realFixtures.length} under ${REAL_FIXTURES_DIR}`);
    process.exit(1);
  }

  const seenClasses = new Set<string>();
  for (const fixturePath of realFixtures) {
    const label = `real/${basename(fixturePath)}`;
    runs += 1;
    try {
      const fixture = loadIncidentFixture(fixturePath);
      if (seenClasses.has(fixture.chain)) {
        failures.push({ fixture: label, reason: `duplicate class ${fixture.chain}` });
        continue;
      }
      seenClasses.add(fixture.chain);
      if (fixture.journey) {
        const journeyPath = join(JOURNEYS_DIR, `${fixture.journey}.journey.sh`);
        if (!existsSync(journeyPath)) {
          failures.push({ fixture: label, reason: `journey file not found: ${journeyPath}` });
          console.error(`  FAIL  ${label} — journey file not found: ${journeyPath}`);
          continue;
        }
        const registrationError = journeyRegistrationError(fixture.journey, registered);
        if (registrationError) {
          failures.push({ fixture: label, reason: registrationError });
          console.error(`  FAIL  ${label} — ${registrationError}`);
          continue;
        }
      } else if (!fixture.journeyNullReason) {
        failures.push({ fixture: label, reason: 'journey:null requires journeyNullReason' });
        console.error(`  FAIL  ${label} — journey:null requires journeyNullReason`);
        continue;
      }
      const result = await runRealFixture(fixturePath);
      if (!result.ok) {
        failures.push({ fixture: label, reason: result.reason ?? 'assertion failed' });
        console.error(`  FAIL  ${label} — ${result.reason ?? 'assertion failed'}`);
      } else {
        passed += 1;
        console.log(`  PASS  ${label} — final=${result.cycle.finalLifecycle} occ=${result.cycle.occurrenceCount}${result.recovery ? ` recovery=${result.recovery.outcome}` : ''}`);
      }
    } catch (err: unknown) {
      failures.push({ fixture: label, reason: err instanceof Error ? err.message : String(err) });
      console.error(`  FAIL  ${label} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // HOK-3382: the hung-harness replay must retry through the controller,
  // attribute the failure to the harness, and never write a model-fault row.
  {
    runs += 1;
    const hungPath = join(FIXTURES_DIR, 'native-harness-hang.json');
    try {
      const { fixture, run, assertion } = runFixture(hungPath);
      const hold = fixture.failure?.harnessHold;
      const faultClass = classifyArmFault({
        failureKind: 'coding-exited-without-result',
        exitEvidence: hold ? { reason: 'harness-hung', harnessHold: hold } : null,
      });
      const emptyFeatureDir = mkdtempSync(join(tmpdir(), 'wm-hang-eval-'));
      let budgetRows: unknown;
      try {
        budgetRows = buildBudgetExhaustions({ stageResultsDir: emptyFeatureDir });
      } finally {
        rmSync(emptyFeatureDir, { recursive: true, force: true });
      }
      const reason = !assertion.ok
        ? assertion.reason ?? 'assertion failed'
        : run.actions?.[0] !== 'bounded-relaunch'
          ? `expected the first action to be bounded-relaunch, got ${run.actions?.join(',')}`
          : run.outcome !== 'merged'
            ? `expected merged, got ${run.outcome}`
            : faultClass !== 'harness-fault'
              ? `expected harness-fault attribution, got ${faultClass}`
              : budgetRows !== undefined
                ? 'a hung harness produced a budget-exhaustion (model-fault) row'
                : null;
      if (reason) {
        failures.push({ fixture: 'native-harness-hang.json', reason });
        console.error(`  FAIL  native-harness-hang.json — ${reason}`);
      } else {
        passed += 1;
        console.log(`  PASS  native-harness-hang.json — retried=${run.actions?.join(',')} faultClass=${faultClass} modelRows=none`);
      }
    } catch (err: unknown) {
      failures.push({ fixture: 'native-harness-hang.json', reason: err instanceof Error ? err.message : String(err) });
      console.error(`  FAIL  native-harness-hang.json — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // HOK-3512: HOK-3500's stored-agent refusal was repaired by HOK-3511, so
  // preserve that source artifact and replay a currently valid launch refusal
  // (a disabled saved model) through the real controller and atomic claim.
  {
    runs += 1;
    const label = 'hok-3500-route-agent-mismatch/live-launch-refusal.json';
    const dir = mkdtempSync(join(tmpdir(), 'wm-route-refusal-'));
    try {
      const recorded = JSON.parse(readFileSync(join(FIXTURES_DIR, 'hok-3500-route-agent-mismatch', 'live-launch-refusal.json'), 'utf8')) as { contract: ExecutionContract };
      const refusal = { ...validateContractLaunchable({ contract: recorded.contract }), contract: recorded.contract };
      if (refusal.reason !== 'model_disabled' || !('detail' in refusal)) throw new Error('fixture contract no longer exercises a launch refusal');
      const snapshot = {
        issue: 'HOK-3500_c', stage: 'coding' as const,
        attempt: { currentRunId: null, controlRunId: null }, disposition: null,
        stageResult: { kind: 'failed' as const }, recoveryContract: refusal,
        outstandingEffect: null, wait: null,
        failure: { decision: classifyFailure({ stage: 'coding', failureKind: 'native-stage-timeout' }), retry: 'proceed' as const },
      };
      const decision = decideTaskRecovery(snapshot);
      const args = { stateDir: dir, decision, runId: null, evidenceId: 'saved-route-refusal' };
      const first = claimRecoveryAction(args);
      const duplicate = claimRecoveryAction(args);
      const reason = decision.action !== 'escalate'
        ? `expected controller escalation, got ${decision.action}`
        : decision.escalationBasis?.kind !== 'policy-terminal'
          ? 'expected policy-terminal escalation basis'
          : !decision.rationale.includes('model_disabled') || !decision.rationale.includes('gpt-5.3-codex') || !decision.rationale.includes(refusal.detail ?? '')
            ? 'validator reason or saved model was lost'
            : !first.claimed || duplicate.claimed
              ? 'expected exactly one claimed escalation'
              : null;
      if (reason) {
        failures.push({ fixture: label, reason });
        console.error(`  FAIL  ${label} — ${reason}`);
      } else {
        passed += 1;
        console.log(`  PASS  ${label} — one policy-terminal claim; no retry dispatch`);
      }
    } catch (err: unknown) {
      failures.push({ fixture: label, reason: err instanceof Error ? err.message : String(err) });
      console.error(`  FAIL  ${label} — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log('');
  console.log(`[incident-replay-harness] ${passed}/${runs} fixture runs passed`);
  if (failures.length > 0) {
    console.error(`[incident-replay-harness] ${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f.fixture}: ${f.reason}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[incident-replay-harness] unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
