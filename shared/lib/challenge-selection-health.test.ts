import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ackLaunch,
  claimReservation,
  computeSelectionExclusions,
  emptySelectionHealthState,
  circuitKeyFor,
  readSelectionHealth,
  recordSelectionOutcome,
  releaseReservation,
  resolveSelectionHealthKey,
  resolveSelectionHealthPath,
  type SelectionHealthOwner,
} from './challenge-selection-health.ts';
import type { ChallengeStage } from './challenge-scheduler.ts';

let passed = 0;
let failed = 0;
const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];

function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

function repo(): string {
  return mkdtempSync(join(tmpdir(), 'challenge-selection-health-'));
}

function owner(issueId: string): SelectionHealthOwner {
  return { issueId, pairId: issueId };
}

const config = {
  enabled: true,
  reservation: {
    selectionTtlSeconds: 60,
    inflightTtlSeconds: 120,
  },
  circuit: {
    transientFailureThreshold: 2,
    windowSeconds: 300,
    cooldownSeconds: 60,
  },
};

async function selectAndClaim(input: {
  repoDir: string;
  owner: SelectionHealthOwner;
  now: () => number;
  candidates: string[];
  stage?: ChallengeStage;
}): Promise<string | null> {
  const excluded = new Set<string>();
  for (let attempt = 0; attempt < input.candidates.length; attempt += 1) {
    const snapshot = readSelectionHealth({ repoDir: input.repoDir, now: input.now, config });
    const result = computeSelectionExclusions({
      stage: input.stage ?? 'implementation',
      candidates: input.candidates,
      snapshot,
      owner: input.owner,
      now: input.now(),
      config,
      additionallyExcludedModels: excluded,
    });
    const model = result.eligible[0];
    if (!model) {
      return null;
    }
    const claim = await claimReservation({
      repoDir: input.repoDir,
      model,
      stage: input.stage ?? 'implementation',
      owner: input.owner,
      now: input.now,
      config,
    });
    if (claim.claimed) {
      return model;
    }
    excluded.add(model);
  }
  return null;
}

console.log('\n--- Challenge Selection Health Tests ---\n');

test('three concurrent claimants reserve distinct candidates', async () => {
  const repoDir = repo();
  try {
    let now = Date.parse('2026-09-03T00:00:00.000Z');
    const candidates = ['scout', 'maverick', 'kimi'];
    const results = await Promise.all([
      selectAndClaim({ repoDir, candidates, owner: owner('HOK-1'), now: () => now }),
      selectAndClaim({ repoDir, candidates, owner: owner('HOK-2'), now: () => now }),
      selectAndClaim({ repoDir, candidates, owner: owner('HOK-3'), now: () => now }),
    ]);
    assert.deepEqual(new Set(results).size, 3);
    const state = readSelectionHealth({ repoDir, now: () => now, config });
    assert.equal(Object.keys(state.reservations).length, 3);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('single active candidate causes a second selector to defer', async () => {
  const repoDir = repo();
  try {
    const now = Date.parse('2026-09-03T00:00:00.000Z');
    assert.equal(await selectAndClaim({
      repoDir,
      candidates: ['scout'],
      owner: owner('HOK-1'),
      now: () => now,
    }), 'scout');
    assert.equal(await selectAndClaim({
      repoDir,
      candidates: ['scout'],
      owner: owner('HOK-2'),
      now: () => now,
    }), null);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('reservation excludes before TTL and reclaims at expiry', async () => {
  const repoDir = repo();
  try {
    const start = Date.parse('2026-09-03T00:00:00.000Z');
    await claimReservation({
      repoDir,
      model: 'scout',
      stage: 'implementation',
      owner: owner('HOK-1'),
      now: () => start,
      config,
    });
    const beforeExpiry = start + 60_000 - 1;
    const before = computeSelectionExclusions({
      stage: 'implementation',
      candidates: ['scout'],
      snapshot: readSelectionHealth({ repoDir, now: () => beforeExpiry, config }),
      owner: owner('HOK-2'),
      now: beforeExpiry,
      config,
    });
    assert.equal(before.eligible.length, 0);

    const atExpiry = start + 60_000;
    const after = await claimReservation({
      repoDir,
      model: 'scout',
      stage: 'implementation',
      owner: owner('HOK-2'),
      now: () => atExpiry,
      config,
    });
    assert.equal(after.claimed, true);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('owner idempotency, owner-scoped release, and launch ack', async () => {
  const repoDir = repo();
  try {
    let now = Date.parse('2026-09-03T00:00:00.000Z');
    await claimReservation({ repoDir, model: 'scout', stage: 'implementation', owner: owner('HOK-1'), now: () => now, config });
    now += 10_000;
    const refreshed = await claimReservation({ repoDir, model: 'scout', stage: 'implementation', owner: owner('HOK-1'), now: () => now, config });
    assert.equal(refreshed.claimed, true);
    await releaseReservation({ repoDir, model: 'scout', stage: 'implementation', owner: owner('HOK-2'), now: () => now, config });
    assert.equal(Object.keys(readSelectionHealth({ repoDir, now: () => now, config }).reservations).length, 1);
    await ackLaunch({ repoDir, model: 'scout', stage: 'implementation', owner: owner('HOK-1'), now: () => now, config });
    const launched = Object.values(readSelectionHealth({ repoDir, now: () => now, config }).reservations)[0];
    assert.equal(launched?.status, 'launched');
    assert.equal(launched?.expiresAt, new Date(now + 120_000).toISOString());
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('provider-fault threshold opens circuit while other categories do not count', async () => {
  const repoDir = repo();
  try {
    let now = Date.parse('2026-09-03T00:00:00.000Z');
    await recordSelectionOutcome({
      repoDir,
      model: 'scout',
      stage: 'implementation',
      owner: owner('HOK-1'),
      failureKind: 'provider-config-error',
      faultClass: 'harness-fault',
      now: () => now,
      config,
    });
    assert.equal(Object.keys(readSelectionHealth({ repoDir, now: () => now, config }).circuits).length, 0);

    await recordSelectionOutcome({
      repoDir,
      model: 'scout',
      stage: 'implementation',
      owner: owner('HOK-1'),
      failureKind: 'provider-transient-error',
      faultClass: 'provider-fault',
      now: () => now,
      config,
    });
    now += 1000;
    await recordSelectionOutcome({
      repoDir,
      model: 'scout',
      stage: 'implementation',
      owner: owner('HOK-2'),
      failureKind: 'provider-rate-limited',
      faultClass: 'provider-fault',
      now: () => now,
      config,
    });

    const exclusions = computeSelectionExclusions({
      stage: 'implementation',
      candidates: ['scout'],
      snapshot: readSelectionHealth({ repoDir, now: () => now, config }),
      owner: owner('HOK-3'),
      now,
      config,
    });
    assert.equal(exclusions.excludedByCircuit[0]?.reason, 'circuit-open');
    assert.equal(exclusions.excludedByCircuit[0]?.recentTransientCount, 2);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('half-open permits exactly one probe and probe outcomes transition deterministically', async () => {
  const repoDir = repo();
  try {
    let now = Date.parse('2026-09-03T00:00:00.000Z');
    await recordSelectionOutcome({ repoDir, model: 'scout', stage: 'implementation', owner: owner('HOK-1'), failureKind: 'provider-transient-error', faultClass: 'provider-fault', now: () => now, config });
    now += 1000;
    await recordSelectionOutcome({ repoDir, model: 'scout', stage: 'implementation', owner: owner('HOK-2'), failureKind: 'provider-transient-error', faultClass: 'provider-fault', now: () => now, config });
    now += 60_000;
    const [first, second] = await Promise.all([
      claimReservation({ repoDir, model: 'scout', stage: 'implementation', owner: owner('HOK-3'), now: () => now, config }),
      claimReservation({ repoDir, model: 'scout', stage: 'implementation', owner: owner('HOK-4'), now: () => now, config }),
    ]);
    assert.equal([first, second].filter((claim) => claim.claimed).length, 1);
    const probeOwner = first.claimed ? owner('HOK-3') : owner('HOK-4');
    await recordSelectionOutcome({ repoDir, model: 'scout', stage: 'implementation', owner: probeOwner, success: true, now: () => now, config });
    assert.equal(Object.keys(readSelectionHealth({ repoDir, now: () => now, config }).circuits).length, 0);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('missing file reads empty and corrupt JSON fails closed without repair', () => {
  const repoDir = repo();
  try {
    assert.deepEqual(readSelectionHealth({ repoDir, config }), emptySelectionHealthState());
    const path = resolveSelectionHealthPath({ repoDir });
    mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
    writeFileSync(path, '{bad json', 'utf-8');
    assert.throws(() => readSelectionHealth({ repoDir, config }), /corrupt/);
    assert.equal(readFileSync(path, 'utf-8'), '{bad json');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('typed review-timeout provider faults open the model circuit (HOK-3064)', async () => {
  const repoDir = repo();
  const circuitConfig = { ...config, circuit: { transientFailureThreshold: 3, windowSeconds: 300, cooldownSeconds: 60 } };
  try {
    let now = Date.parse('2026-09-22T00:00:00.000Z');
    // Three terminal review-timeout attempts, recorded as provider-fault via
    // the typed native-review-timeout kind, must open the circuit.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await recordSelectionOutcome({
        repoDir,
        model: 'kimi-k2',
        stage: 'review',
        owner: owner(`HOK-${attempt}`),
        failureKind: 'native-review-timeout',
        faultClass: 'provider-fault',
        now: () => now,
        config: circuitConfig,
      });
      now += 1000;
    }
    const exclusions = computeSelectionExclusions({
      stage: 'review',
      candidates: ['kimi-k2'],
      snapshot: readSelectionHealth({ repoDir, now: () => now, config: circuitConfig }),
      owner: owner('HOK-new'),
      now,
      config: circuitConfig,
    });
    assert.equal(exclusions.eligible.length, 0);
    assert.equal(exclusions.excludedByCircuit.length, 1);
    assert.equal(exclusions.excludedByCircuit[0]?.reason, 'circuit-open');
    assert.equal(exclusions.excludedByCircuit[0]?.provider, 'openrouter');
    assert.equal(exclusions.excludedByCircuit[0]?.canonicalModel, 'kimi-k2');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('provider identity normalizes across native/native-openrouter/bare forms (HOK-3064)', async () => {
  // A single OpenRouter execution can surface under bare, provider/model, and
  // native-provider/model forms across intent, stage result, and abort marker.
  // All three must key to one circuit rather than diluting across health rows.
  assert.deepEqual(resolveSelectionHealthKey('kimi-k2'), { provider: 'openrouter', canonicalModel: 'kimi-k2' });
  assert.deepEqual(resolveSelectionHealthKey('openrouter/kimi-k2'), { provider: 'openrouter', canonicalModel: 'kimi-k2' });
  assert.deepEqual(resolveSelectionHealthKey('native-openrouter/kimi-k2'), { provider: 'openrouter', canonicalModel: 'kimi-k2' });
  assert.equal(circuitKeyFor('native-openrouter/kimi-k2'), circuitKeyFor('kimi-k2'));

  const repoDir = repo();
  const circuitConfig = { ...config, circuit: { transientFailureThreshold: 3, windowSeconds: 300, cooldownSeconds: 60 } };
  try {
    let now = Date.parse('2026-09-22T00:00:00.000Z');
    for (const model of ['native-openrouter/kimi-k2', 'openrouter/kimi-k2', 'kimi-k2']) {
      await recordSelectionOutcome({
        repoDir,
        model,
        stage: 'review',
        owner: owner('HOK-shared'),
        failureKind: 'native-review-timeout',
        faultClass: 'provider-fault',
        now: () => now,
        config: circuitConfig,
      });
      now += 1000;
    }
    const state = readSelectionHealth({ repoDir, now: () => now, config: circuitConfig });
    assert.deepEqual(Object.keys(state.circuits), ['openrouter|kimi-k2']);
    assert.equal(state.circuits['openrouter|kimi-k2']?.recentTransientAt.length, 3);
    assert.equal(state.circuits['openrouter|kimi-k2']?.state, 'open');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

for (const entry of tests) {
  try {
    await entry.fn();
    passed++;
    console.log(`  PASS  ${entry.name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${entry.name}`);
    console.log(`        ${(error as Error).message}`);
  }
}

if (failed > 0) {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`\n${passed} passed, ${failed} failed`);
