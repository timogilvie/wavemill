import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import fc from 'fast-check';
import { buildWorkflowState } from './lib/task-builder.ts';
import { resolveSeed } from '../shared/lib/fast-check-utils.ts';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
type Event = 'failure' | 'output' | 'input' | 'reconcile' | 'unavailable' | 'available';
type Stage = 'planning' | 'coding' | 'review' | 'ready';
type Observation = {event: Event; verdict: string; count: number; exhausted: boolean};
const incident = JSON.parse(readFileSync(join(repo, 'tests/fixtures/retry-contract/hok-3491.json'), 'utf8'));

function execute(stage: Stage, events: Event[]): Observation[] {
  const root = mkdtempSync(join(tmpdir(), 'wm-retry-contract-'));
  try {
    writeFileSync(join(root, 'state.json'), JSON.stringify(buildWorkflowState({
      'HOK-3491': {phase: stage, runId: 'contract-run', lifecycle: {
        schemaVersion: 1, workflowOutcome: 'active', resourceDisposition: 'allocated',
        launchContract: {baseSha: '25cc3cb9', remoteBranchDeletionPolicy: {allowed: true}},
      }},
    })));
    writeFileSync(join(root, 'events.json'), JSON.stringify(events));
    const output = execFileSync('bash', [join(repo, 'tests/lib/stage-retry-contract.sh'), root, stage, join(root, 'events.json'),
      process.env.RETRY_CONTRACT_MONITOR_SOURCE ?? join(repo, 'shared/lib/wavemill-monitor.sh')], {
      encoding: 'utf8', timeout: 30_000,
    });
    return output.trim().split('\n').map(line => JSON.parse(line));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

// Independent oracle: count authorized launches for the SAME INPUT, not the
// helper's counter or its key formula. Output is input only to review/Ready.
function assertContract(stage: Stage, observations: Observation[]): void {
  let launches = 0;
  for (const step of observations) {
    if (step.event === 'output') {
      if (stage === 'review' || stage === 'ready') launches = 0;
    }
    if (step.event === 'input' && (stage === 'coding' || stage === 'planning')) {
      launches = 0;
    }
    if (step.event !== 'failure') continue;
    if (launches < 3) {
      assert.equal(step.verdict, 'proceed', `${stage}: unchanged input still has allowance`);
      launches++;
    } else {
      assert.match(step.verdict, /^exhausted/, `${stage}: output cannot refill an exhausted input`);
    }
    assert.equal(step.count, launches, `${stage}: persisted accounting matches authorized launches`);
  }
}

test('HOK-3491: two output commits cannot buy extra coding relaunches', () => {
  const observations = execute('coding', incident.events);
  assertContract('coding', observations);
  assert.equal(observations.filter(x => x.verdict === 'proceed').length, incident.expectedRelaunches);
});

test('exhaustion survives reconciliation after an output commit', () => {
  assertContract('coding', execute('coding', ['input', 'failure', 'failure', 'failure', 'failure', 'output', 'reconcile', 'failure']));
});

test('review and Ready receive a fresh allowance for changed input', () => {
  const events: Event[] = ['failure', 'failure', 'failure', 'failure', 'output', 'reconcile', 'failure'];
  for (const stage of ['review', 'ready'] as const) assertContract(stage, execute(stage, events));
});

test('planning and coding reset on explicitly replaced input', () => {
  const events: Event[] = ['failure', 'failure', 'failure', 'failure', 'output', 'input', 'failure'];
  for (const stage of ['planning', 'coding'] as const) assertContract(stage, execute(stage, events));
});

test('temporarily unavailable input evidence never replenishes retries', () => {
  assertContract('coding', execute('coding', ['failure', 'unavailable', 'failure', 'available', 'failure', 'failure']));
});

test('generated failure/output/input/reconcile sequences obey the input contract', () => {
  const seed = resolveSeed();
  console.error(`[retry-contract] seed=${seed}`);
  const result = fc.check(fc.property(
    fc.constantFrom<Stage>('planning', 'coding', 'review', 'ready'),
    fc.array(fc.constantFrom<Event>('failure', 'output', 'input', 'reconcile'), {minLength: 0, maxLength: 5}),
    (stage, prefix) => {
      // Every trace includes enough failures to exercise the ceiling; prefix
      // generation varies the state before that suffix and shrinks on failure.
      const events: Event[] = [...prefix, 'failure', 'output', 'reconcile', 'failure', 'failure', 'failure', 'failure'];
      assertContract(stage, execute(stage, events));
    },
  ), {seed, numRuns: 12});
  assert.equal(result.failed, false, JSON.stringify({
    seed, path: result.counterexamplePath, counterexample: result.counterexample,
    error: result.error, replay: `FAST_CHECK_SEED=${seed} node --test tests/stage-retry-contract.test.ts`,
  }, null, 2));
});
