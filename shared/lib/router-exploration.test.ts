// wavemill-test-suite: custom
/**
 * Tests for router exploration sampling primitives.
 */

import assert from 'node:assert/strict';
import {
  blendWithPrior,
  formatExplorationReasoning,
  isWithinRecencyWindow,
  recencyMultiplier,
  resolveExplorationConfig,
  sampleCandidateIndex,
  ucbBonus,
} from './router-exploration.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

function sequenceRandom(values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

console.log('\n--- router-exploration Tests ---\n');

test('resolveExplorationConfig applies defaults and clamps values', () => {
  const defaults = resolveExplorationConfig();
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.mode, 'epsilon');
  assert.equal(defaults.rate, 0.15);
  assert.equal(defaults.temperature, 0.7);
  assert.equal(defaults.topK, 3);
  assert.equal(defaults.ucbConstant, 0);
  assert.equal(defaults.priorsEnabled, false);
  assert.equal(defaults.priorBlendSamples, 10);

  const clamped = resolveExplorationConfig({
    enabled: true,
    mode: 'softmax',
    rate: 7,
    temperature: 100,
    topK: 1,
    ucbConstant: 5,
    priors: { enabled: true, blendSamples: 0 },
  });
  assert.equal(clamped.enabled, true);
  assert.equal(clamped.mode, 'softmax');
  assert.equal(clamped.rate, 1);
  assert.equal(clamped.temperature, 10);
  assert.equal(clamped.topK, 3);
  assert.equal(clamped.ucbConstant, 1);
  assert.equal(clamped.priorsEnabled, true);
  assert.equal(clamped.priorBlendSamples, 10);
});

test('ucbBonus decays with support and disables at zero constant', () => {
  assert.equal(ucbBonus(0, 100, 1), 0);
  const fresh = ucbBonus(0.3, 11, 1);
  const seasoned = ucbBonus(0.3, 11, 10);
  assert.ok(fresh > seasoned, 'low support should earn a larger bonus');
  assert.ok(seasoned > 0);
  // Zero support is treated as one trial, not infinity
  assert.equal(ucbBonus(0.3, 11, 0), fresh);
});

test('blendWithPrior interpolates from pure prior to pure empirical', () => {
  assert.equal(blendWithPrior(0.5, 0.99, 0, 10), 0.99);
  assert.equal(blendWithPrior(0.5, 0.99, 10, 10), 0.5);
  assert.equal(blendWithPrior(0.5, 0.99, 20, 10), 0.5);
  const half = blendWithPrior(0.5, 0.99, 5, 10);
  assert.ok(Math.abs(half - 0.745) < 1e-9, `expected 0.745, got ${half}`);
  // Result stays clamped to [0, 1]
  assert.equal(blendWithPrior(2, 2, 5, 10), 1);
});

test('sampleCandidateIndex returns argmax when disabled or trivial', () => {
  const enabled = resolveExplorationConfig({ enabled: true, rate: 1 });
  const disabled = resolveExplorationConfig({ enabled: false, rate: 1 });

  assert.deepEqual(sampleCandidateIndex([0.9, 0.8], disabled, () => 0), { index: 0, explored: false });
  assert.deepEqual(sampleCandidateIndex([0.9], enabled, () => 0), { index: 0, explored: false });
  assert.deepEqual(sampleCandidateIndex([], enabled, () => 0), { index: 0, explored: false });
});

test('epsilon mode explores at the configured rate within the top-K window', () => {
  const config = resolveExplorationConfig({ enabled: true, mode: 'epsilon', rate: 0.5, topK: 3 });
  const scores = [0.9, 0.8, 0.7, 0.6];

  // First roll above rate -> exploit
  assert.deepEqual(sampleCandidateIndex(scores, config, sequenceRandom([0.6])), { index: 0, explored: false });

  // First roll below rate -> explore; second roll picks among non-argmax in window
  assert.deepEqual(sampleCandidateIndex(scores, config, sequenceRandom([0.4, 0])), { index: 1, explored: true });
  assert.deepEqual(sampleCandidateIndex(scores, config, sequenceRandom([0.4, 0.99])), { index: 2, explored: true });

  // Index never escapes the top-K window
  const maxPick = sampleCandidateIndex(scores, config, sequenceRandom([0, 0.999999]));
  assert.ok(maxPick.index <= 2);
});

test('epsilon mode with rate 0 never explores', () => {
  const config = resolveExplorationConfig({ enabled: true, mode: 'epsilon', rate: 0 });
  for (const roll of [0, 0.5, 0.99]) {
    assert.deepEqual(sampleCandidateIndex([0.9, 0.5], config, () => roll), { index: 0, explored: false });
  }
});

test('softmax mode samples proportionally to exp(score / temperature)', () => {
  const config = resolveExplorationConfig({ enabled: true, mode: 'softmax', temperature: 0.7, topK: 3 });

  // Threshold at the very start of the cumulative mass -> argmax
  assert.deepEqual(sampleCandidateIndex([0.9, 0.5], config, () => 0), { index: 0, explored: false });

  // Threshold near the end of the cumulative mass -> last candidate
  const tail = sampleCandidateIndex([0.9, 0.5], config, () => 0.9999);
  assert.deepEqual(tail, { index: 1, explored: true });

  // Near-zero temperature concentrates all mass on the argmax
  const sharp = resolveExplorationConfig({ enabled: true, mode: 'softmax', temperature: 0.01 });
  assert.deepEqual(sampleCandidateIndex([0.9, 0.85], sharp, () => 0.99), { index: 0, explored: false });
});

test('softmax mode respects the top-K window', () => {
  const config = resolveExplorationConfig({ enabled: true, mode: 'softmax', temperature: 10, topK: 2 });
  for (const roll of [0, 0.3, 0.6, 0.9999]) {
    const pick = sampleCandidateIndex([0.9, 0.8, 0.7, 0.6], config, () => roll);
    assert.ok(pick.index <= 1, `expected index within top-2, got ${pick.index}`);
  }
});

test('formatExplorationReasoning describes sampled roles and cost-guard reverts', () => {
  const epsilon = resolveExplorationConfig({ enabled: true, mode: 'epsilon', rate: 0.2 });
  const sampledLine = formatExplorationReasoning(
    { mode: 'epsilon', explored: [{ role: 'coder', sampled: 'gpt-5.4', argmax: 'claude-fable-5' }] },
    epsilon,
  );
  assert.ok(sampledLine.includes('exploration(epsilon, rate=0.2)'));
  assert.ok(sampledLine.includes('coder=gpt-5.4 (argmax claude-fable-5)'));

  const reverted = formatExplorationReasoning(
    { mode: 'epsilon', explored: [], costGuardReverted: true },
    epsilon,
  );
  assert.ok(reverted.includes('reverted'));
  assert.ok(reverted.includes('maxCostUsd'));
});


test('resolveExplorationConfig resolves newModelBoost with defaults and clamping', () => {
  const defaults = resolveExplorationConfig();
  assert.equal(defaults.boostWindowDays, 45);
  assert.equal(defaults.boostMultiplier, 1);

  const custom = resolveExplorationConfig({ newModelBoost: { windowDays: 30, multiplier: 3 } });
  assert.equal(custom.boostWindowDays, 30);
  assert.equal(custom.boostMultiplier, 3);

  const invalid = resolveExplorationConfig({ newModelBoost: { windowDays: 0, multiplier: 50 } });
  assert.equal(invalid.boostWindowDays, 45);
  assert.equal(invalid.boostMultiplier, 10);
  assert.equal(resolveExplorationConfig({ newModelBoost: { multiplier: 0.5 } }).boostMultiplier, 1);
});

test('recencyMultiplier decays from multiplier to 1.0 across the window', () => {
  const config = resolveExplorationConfig({ newModelBoost: { windowDays: 40, multiplier: 3 } });
  const now = Date.parse('2026-06-13T00:00:00Z');
  const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString().slice(0, 10);

  // At release: full multiplier (within rounding of date truncation)
  assert.ok(recencyMultiplier(daysAgo(0), config, now) > 2.9);
  // Halfway: midpoint
  const half = recencyMultiplier(daysAgo(20), config, now);
  assert.ok(Math.abs(half - 2) < 0.01, `expected ~2, got ${half}`);
  // Outside the window: exactly 1
  assert.equal(recencyMultiplier(daysAgo(40), config, now), 1);
  assert.equal(recencyMultiplier(daysAgo(400), config, now), 1);
  // Unset / future / garbage dates: 1
  assert.equal(recencyMultiplier(undefined, config, now), 1);
  assert.equal(recencyMultiplier(daysAgo(-5), config, now), 1);
  assert.equal(recencyMultiplier('not-a-date', config, now), 1);
  // Boost configured off: 1 even inside the window
  const off = resolveExplorationConfig({ newModelBoost: { windowDays: 40, multiplier: 1 } });
  assert.equal(recencyMultiplier(daysAgo(1), off, now), 1);
});

test('isWithinRecencyWindow handles edges', () => {
  const now = Date.parse('2026-06-13T00:00:00Z');
  const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
  assert.equal(isWithinRecencyWindow(daysAgo(10), 45, now), true);
  assert.equal(isWithinRecencyWindow(daysAgo(45), 45, now), false);
  assert.equal(isWithinRecencyWindow(daysAgo(-1), 45, now), false);
  assert.equal(isWithinRecencyWindow(undefined, 45, now), false);
  assert.equal(isWithinRecencyWindow(daysAgo(10), 0, now), false);
});

test('epsilon explore branch samples alternatives proportionally to multipliers', () => {
  const config = resolveExplorationConfig({ enabled: true, mode: 'epsilon', rate: 1, topK: 3 });
  const scores = [0.9, 0.8, 0.7];

  // Equal weights: threshold 0.6 * 2 = 1.2 lands in the second alternative
  assert.deepEqual(sampleCandidateIndex(scores, config, sequenceRandom([0, 0.6])), { index: 2, explored: true });
  // Boosted first alternative (weight 5 vs 1): the same roll lands in it
  assert.deepEqual(
    sampleCandidateIndex(scores, config, sequenceRandom([0, 0.6]), [1, 5, 1]),
    { index: 1, explored: true },
  );
});

test('softmax sampling respects multipliers', () => {
  const config = resolveExplorationConfig({ enabled: true, mode: 'softmax', temperature: 0.7, topK: 2 });
  // Without a boost this threshold stays on the argmax
  assert.deepEqual(sampleCandidateIndex([0.9, 0.5], config, () => 0.6), { index: 0, explored: false });
  // A strong recency multiplier on the runner-up shifts the same threshold
  assert.deepEqual(sampleCandidateIndex([0.9, 0.5], config, () => 0.6, [1, 10]), { index: 1, explored: true });
});

test('formatExplorationReasoning marks recency-boosted picks', () => {
  const config = resolveExplorationConfig({ enabled: true, mode: 'epsilon', rate: 0.2 });
  const line = formatExplorationReasoning(
    { mode: 'epsilon', explored: [{ role: 'planner', sampled: 'claude-fable-5', argmax: 'gpt-5.5', recencyBoosted: true }] },
    config,
  );
  assert.ok(line.includes('[recency-boosted]'));
});


process.on('exit', () => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
});
