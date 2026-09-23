import assert from 'node:assert/strict';
import type { ChallengeStage } from './challenge-scheduler.ts';
import {
  selectLeastUsedChallenger,
  type ChallengeLaunchPriorityMetadata,
} from './challenge-coverage-selector.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(error as Error).message}`);
  }
}

function makeCoverage(counts: Partial<Record<ChallengeStage, Record<string, number>>>) {
  return (model: string, stage: ChallengeStage) => counts[stage]?.[model] ?? 0;
}

const launchPriorityByAlias = new Map<string, ChallengeLaunchPriorityMetadata>([
  ['claude-sonnet-4-6', { family: 'claude', priorityTier: 1, isIncumbent: true }],
  ['gpt-5.4', { family: 'gpt', priorityTier: 1, isIncumbent: true }],
  ['qwen3-coder', { family: 'qwen', priorityTier: 1, isIncumbent: false }],
  ['glm-5.2', { family: 'glm', priorityTier: 1, isIncumbent: false }],
  ['kimi-k2.7-code', { family: 'kimi', priorityTier: 1, isIncumbent: false }],
  ['mistral-large', { family: 'mistral', priorityTier: 2, isIncumbent: false }],
]);

console.log('\n--- Challenge Coverage Selector Tests ---\n');

test('zero-record launch-priority model beats incumbent challengers', () => {
  const result = selectLeastUsedChallenger({
    stage: 'implementation',
    primaryModel: 'claude-sonnet-4-6',
    candidates: ['claude-sonnet-4-6', 'qwen3-coder', 'glm-5.2'],
    coverage: makeCoverage({
      implementation: {
        'claude-sonnet-4-6': 5,
        'qwen3-coder': 0,
        'glm-5.2': 3,
      },
    }),
    rotationSeed: 'HOK-2500|implementation',
    launchPriorityByAlias,
  });

  assert.equal(result.model, 'qwen3-coder');
  assert.equal(result.selectionReason, 'least-used-zero-record');
  assert.equal(result.coverageCount, 0);
});

test('least-used nonzero challenger wins when no zero-record candidates remain', () => {
  const result = selectLeastUsedChallenger({
    stage: 'implementation',
    primaryModel: 'claude-sonnet-4-6',
    candidates: ['claude-sonnet-4-6', 'qwen3-coder', 'glm-5.2', 'kimi-k2.7-code'],
    coverage: makeCoverage({
      implementation: {
        'qwen3-coder': 4,
        'glm-5.2': 2,
        'kimi-k2.7-code': 7,
      },
    }),
    rotationSeed: 'HOK-2500|implementation',
    launchPriorityByAlias,
  });

  assert.equal(result.model, 'glm-5.2');
  assert.equal(result.selectionReason, 'least-used-nonzero');
  assert.equal(result.coverageCount, 2);
});

test('honors a recommendation only when it is also the least-used eligible model', () => {
  const result = selectLeastUsedChallenger({
    stage: 'implementation',
    primaryModel: 'claude-sonnet-4-6',
    candidates: ['claude-sonnet-4-6', 'qwen3-coder', 'glm-5.2'],
    coverage: makeCoverage({
      implementation: {
        'qwen3-coder': 5,
        'glm-5.2': 2,
      },
    }),
    recommendedChallenger: 'glm-5.2',
    rotationSeed: 'HOK-2500|implementation',
    launchPriorityByAlias,
  });

  assert.equal(result.model, 'glm-5.2');
  assert.equal(result.selectionReason, 'recommendation-honored');
  assert.equal(result.coverageCount, 2);
});

test('falls forward when the recommendation is ineligible or not least-used', () => {
  const result = selectLeastUsedChallenger({
    stage: 'implementation',
    primaryModel: 'claude-sonnet-4-6',
    candidates: ['claude-sonnet-4-6', 'qwen3-coder', 'glm-5.2'],
    coverage: makeCoverage({
      implementation: {
        'qwen3-coder': 1,
        'glm-5.2': 3,
      },
    }),
    recommendedChallenger: 'mistral-large',
    rotationSeed: 'HOK-2500|implementation',
    launchPriorityByAlias,
  });

  assert.equal(result.model, 'qwen3-coder');
  assert.equal(result.selectionReason, 'least-used-fallforward');
  assert.equal(result.coverageCount, 1);
});

test('never selects incumbents while an eligible launch-priority challenger is unused', () => {
  const result = selectLeastUsedChallenger({
    stage: 'implementation',
    primaryModel: 'claude-sonnet-4-6',
    candidates: ['claude-sonnet-4-6', 'gpt-5.4', 'qwen3-coder'],
    coverage: makeCoverage({
      implementation: {
        'gpt-5.4': 0,
        'qwen3-coder': 0,
      },
    }),
    rotationSeed: 'HOK-2500|implementation',
    launchPriorityByAlias,
  });

  assert.equal(result.model, 'qwen3-coder');
  assert.notEqual(result.selectionReason, 'last-resort-incumbent');
});

test('falls back to incumbents only when no launch-priority alternatives are eligible', () => {
  const result = selectLeastUsedChallenger({
    stage: 'implementation',
    primaryModel: 'claude-sonnet-4-6',
    candidates: ['claude-sonnet-4-6', 'gpt-5.4'],
    coverage: makeCoverage({
      implementation: {
        'gpt-5.4': 2,
      },
    }),
    rotationSeed: 'HOK-2500|implementation',
    launchPriorityByAlias,
  });

  assert.equal(result.model, 'gpt-5.4');
  assert.equal(result.selectionReason, 'last-resort-incumbent');
});

test('stage isolation uses the selected stage coverage only', () => {
  const result = selectLeastUsedChallenger({
    stage: 'plan',
    primaryModel: 'claude-sonnet-4-6',
    candidates: ['claude-sonnet-4-6', 'qwen3-coder', 'glm-5.2'],
    coverage: makeCoverage({
      plan: {
        'qwen3-coder': 0,
        'glm-5.2': 5,
      },
      implementation: {
        'qwen3-coder': 99,
        'glm-5.2': 1,
      },
    }),
    rotationSeed: 'HOK-2500|plan',
    launchPriorityByAlias,
  });

  assert.equal(result.model, 'qwen3-coder');
  assert.equal(result.coverageCount, 0);
});

test('lower launch-priority tiers lose ties to higher-priority launch models', () => {
  const result = selectLeastUsedChallenger({
    stage: 'implementation',
    primaryModel: 'claude-sonnet-4-6',
    candidates: ['claude-sonnet-4-6', 'glm-5.2', 'mistral-large'],
    coverage: makeCoverage({
      implementation: {
        'glm-5.2': 0,
        'mistral-large': 0,
      },
    }),
    rotationSeed: 'HOK-2500|implementation',
    launchPriorityByAlias,
  });

  assert.equal(result.model, 'glm-5.2');
});

test('family rotation is deterministic for a seed and varies across seeds', () => {
  const first = selectLeastUsedChallenger({
    stage: 'implementation',
    primaryModel: 'claude-sonnet-4-6',
    candidates: ['claude-sonnet-4-6', 'qwen3-coder', 'glm-5.2', 'kimi-k2.7-code'],
    coverage: makeCoverage({
      implementation: {
        'qwen3-coder': 0,
        'glm-5.2': 0,
        'kimi-k2.7-code': 0,
      },
    }),
    rotationSeed: 'seed-a',
    launchPriorityByAlias,
  });
  const second = selectLeastUsedChallenger({
    stage: 'implementation',
    primaryModel: 'claude-sonnet-4-6',
    candidates: ['claude-sonnet-4-6', 'qwen3-coder', 'glm-5.2', 'kimi-k2.7-code'],
    coverage: makeCoverage({
      implementation: {
        'qwen3-coder': 0,
        'glm-5.2': 0,
        'kimi-k2.7-code': 0,
      },
    }),
    rotationSeed: 'seed-a',
    launchPriorityByAlias,
  });
  const third = selectLeastUsedChallenger({
    stage: 'implementation',
    primaryModel: 'claude-sonnet-4-6',
    candidates: ['claude-sonnet-4-6', 'qwen3-coder', 'glm-5.2', 'kimi-k2.7-code'],
    coverage: makeCoverage({
      implementation: {
        'qwen3-coder': 0,
        'glm-5.2': 0,
        'kimi-k2.7-code': 0,
      },
    }),
    rotationSeed: 'seed-b',
    launchPriorityByAlias,
  });

  assert.equal(first.model, second.model);
  assert.equal(first.selectionReason, 'tie-break-family-rotation');
  assert.notEqual(first.model, third.model);
});

test('signals no eligible candidate after primary removal and dedupe', () => {
  const result = selectLeastUsedChallenger({
    stage: 'implementation',
    primaryModel: 'claude-sonnet-4-6',
    candidates: ['claude-sonnet-4-6', 'claude-sonnet-4-6', ''],
    coverage: makeCoverage({}),
    rotationSeed: 'HOK-2500|implementation',
    launchPriorityByAlias,
  });

  assert.equal(result.model, null);
  assert.equal(result.selectionReason, 'no-eligible-candidate');
});

function makeAttempts(evidence: Record<string, {
  attemptCount: number;
  lastAttemptAt?: string;
  cooldownActive?: boolean;
}>) {
  return (model: string) => evidence[model];
}

test('failed zero-coverage challenger yields to a zero-attempt peer (HOK-3066)', () => {
  const result = selectLeastUsedChallenger({
    stage: 'review',
    primaryModel: 'claude-sonnet-4-6',
    candidates: ['claude-sonnet-4-6', 'kimi-k2.7-code', 'qwen3-coder', 'glm-5.2'],
    coverage: makeCoverage({}),
    attemptEvidence: makeAttempts({
      'kimi-k2.7-code': { attemptCount: 1, lastAttemptAt: '2026-09-23T10:00:00.000Z' },
    }),
    rotationSeed: 'HOK-3066|review',
    launchPriorityByAlias,
  });

  assert.notEqual(result.model, 'kimi-k2.7-code');
  assert.equal(result.coverageCount, 0);
  assert.equal(result.attemptCount, 0);
});

test('fewest recent terminal attempts breaks equal successful coverage', () => {
  const result = selectLeastUsedChallenger({
    stage: 'implementation',
    primaryModel: 'claude-sonnet-4-6',
    candidates: ['qwen3-coder', 'glm-5.2'],
    coverage: makeCoverage({
      implementation: { 'qwen3-coder': 2, 'glm-5.2': 2 },
    }),
    attemptEvidence: makeAttempts({
      'qwen3-coder': { attemptCount: 3, lastAttemptAt: '2026-09-23T10:00:00.000Z' },
      'glm-5.2': { attemptCount: 1, lastAttemptAt: '2026-09-23T11:00:00.000Z' },
    }),
    rotationSeed: 'HOK-3066|implementation',
    launchPriorityByAlias,
  });

  assert.equal(result.model, 'glm-5.2');
  assert.equal(result.selectionReason, 'least-attempted');
  assert.equal(result.attemptCount, 1);
  assert.equal(result.lastAttemptAt, '2026-09-23T11:00:00.000Z');
});

test('oldest last attempt breaks equal attempt counts', () => {
  const result = selectLeastUsedChallenger({
    stage: 'implementation',
    primaryModel: 'claude-sonnet-4-6',
    candidates: ['qwen3-coder', 'glm-5.2'],
    coverage: makeCoverage({}),
    attemptEvidence: makeAttempts({
      'qwen3-coder': { attemptCount: 1, lastAttemptAt: '2026-09-23T08:00:00.000Z' },
      'glm-5.2': { attemptCount: 1, lastAttemptAt: '2026-09-23T11:00:00.000Z' },
    }),
    rotationSeed: 'HOK-3066|implementation',
    launchPriorityByAlias,
  });

  assert.equal(result.model, 'qwen3-coder');
  assert.equal(result.selectionReason, 'least-attempted');
});

test('active cooldowns are excluded while a non-cooled candidate exists', () => {
  const result = selectLeastUsedChallenger({
    stage: 'implementation',
    primaryModel: 'claude-sonnet-4-6',
    candidates: ['kimi-k2.7-code', 'mistral-large'],
    coverage: makeCoverage({
      implementation: { 'mistral-large': 9 },
    }),
    attemptEvidence: makeAttempts({
      'kimi-k2.7-code': { attemptCount: 1, lastAttemptAt: '2026-09-23T12:00:00.000Z', cooldownActive: true },
    }),
    rotationSeed: 'HOK-3066|implementation',
    launchPriorityByAlias,
  });

  // Even a much-better-covered candidate wins over one in an active cooldown.
  assert.equal(result.model, 'mistral-large');
  assert.equal(result.cooldownActive, false);
});

test('cooldown fallback is explicit when every candidate is cooled', () => {
  const result = selectLeastUsedChallenger({
    stage: 'implementation',
    primaryModel: 'claude-sonnet-4-6',
    candidates: ['kimi-k2.7-code', 'qwen3-coder'],
    coverage: makeCoverage({}),
    attemptEvidence: makeAttempts({
      'kimi-k2.7-code': { attemptCount: 2, lastAttemptAt: '2026-09-23T12:00:00.000Z', cooldownActive: true },
      'qwen3-coder': { attemptCount: 1, lastAttemptAt: '2026-09-23T12:30:00.000Z', cooldownActive: true },
    }),
    rotationSeed: 'HOK-3066|implementation',
    launchPriorityByAlias,
  });

  assert.equal(result.model, 'qwen3-coder');
  assert.equal(result.selectionReason, 'cooldown-fallback');
  assert.equal(result.cooldownActive, true);
});

test('a recommendation cannot override a lower-attempt candidate outside its bucket', () => {
  const result = selectLeastUsedChallenger({
    stage: 'implementation',
    primaryModel: 'claude-sonnet-4-6',
    candidates: ['qwen3-coder', 'glm-5.2'],
    coverage: makeCoverage({
      implementation: { 'qwen3-coder': 1, 'glm-5.2': 1 },
    }),
    attemptEvidence: makeAttempts({
      'qwen3-coder': { attemptCount: 4, lastAttemptAt: '2026-09-23T12:00:00.000Z' },
    }),
    recommendedChallenger: 'qwen3-coder',
    rotationSeed: 'HOK-3066|implementation',
    launchPriorityByAlias,
  });

  assert.equal(result.model, 'glm-5.2');
  assert.notEqual(result.selectionReason, 'recommendation-honored');
});

test('attempt evidence and priority tier are reported for the selected challenger', () => {
  const result = selectLeastUsedChallenger({
    stage: 'implementation',
    primaryModel: 'claude-sonnet-4-6',
    candidates: ['mistral-large'],
    coverage: makeCoverage({ implementation: { 'mistral-large': 1 } }),
    attemptEvidence: makeAttempts({
      'mistral-large': { attemptCount: 2, lastAttemptAt: '2026-09-23T09:00:00.000Z' },
    }),
    rotationSeed: 'HOK-3066|implementation',
    launchPriorityByAlias,
  });

  assert.equal(result.model, 'mistral-large');
  assert.equal(result.attemptCount, 2);
  assert.equal(result.lastAttemptAt, '2026-09-23T09:00:00.000Z');
  assert.equal(result.cooldownActive, false);
  assert.equal(result.priorityTier, 2);
});

test('ranking without attempt evidence matches the legacy coverage selector', () => {
  const base = {
    stage: 'implementation' as ChallengeStage,
    primaryModel: 'claude-sonnet-4-6',
    candidates: ['qwen3-coder', 'glm-5.2', 'kimi-k2.7-code'],
    coverage: makeCoverage({
      implementation: { 'qwen3-coder': 4, 'glm-5.2': 2, 'kimi-k2.7-code': 7 },
    }),
    rotationSeed: 'HOK-2500|implementation',
    launchPriorityByAlias,
  };
  const legacy = selectLeastUsedChallenger(base);
  const withEmptyEvidence = selectLeastUsedChallenger({ ...base, attemptEvidence: () => undefined });

  assert.equal(legacy.model, withEmptyEvidence.model);
  assert.equal(legacy.selectionReason, withEmptyEvidence.selectionReason);
});

if (failed > 0) {
  console.error(`\n${failed} challenge coverage selector test(s) failed.`);
  process.exit(1);
}

console.log(`\n${passed} challenge coverage selector test(s) passed.`);
