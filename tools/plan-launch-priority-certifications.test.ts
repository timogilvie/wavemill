import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LaunchPriorityAudit } from '../shared/lib/launch-priority-audit.ts';
import type { LaunchPriorityModel } from '../shared/lib/openrouter-catalog.ts';
import { buildCertificationPlan } from './plan-launch-priority-certifications.ts';

const catalog: LaunchPriorityModel[] = [
  {
    wavemillAlias: 'qwen-3-coder',
    openrouterId: 'qwen/qwen3-coder',
    family: 'qwen',
    status: 'active',
    priorityTier: 1,
    roleEligibility: ['coding', 'review'],
  },
  {
    wavemillAlias: 'gemini-3.1-pro-preview',
    openrouterId: 'google/gemini-3.1-pro-preview',
    family: 'gemini',
    status: 'active',
    priorityTier: 1,
    roleEligibility: ['planning'],
  },
  {
    wavemillAlias: 'ox-alpha',
    openrouterId: 'stealth/ox-alpha',
    family: 'gpt',
    status: 'watchlist',
    priorityTier: 9,
    roleEligibility: ['coding'],
  },
];

function makeAudit(): LaunchPriorityAudit {
  return {
    generatedAt: '2026-07-16T00:00:00.000Z',
    schemaVersion: '1',
    coverageTargetPerRole: 3,
    excludedRecords: 0,
    exclusionReasonCounts: {},
    zeroEvidence: ['qwen-3-coder'],
    belowTarget: ['gemini-3.1-pro-preview'],
    samplingPlan: [],
    summary: {
      totalLaunchPriority: 2,
      blockedCount: 0,
      sampledCount: 0,
      byRole: {
        planning: { zero: 1, below: 0, at: 0 },
        coding: { zero: 1, below: 0, at: 0 },
        review: { zero: 1, below: 0, at: 0 },
      },
    },
    models: [
      {
        wavemillAlias: 'qwen-3-coder',
        openrouterId: 'qwen/qwen3-coder',
        family: 'qwen',
        launchPriorityStatus: 'active',
        priorityTier: 1,
        role: 'coding',
        directEvidenceCount: 0,
        availablePoolExposureCount: 10,
        evalAttempts: 0,
        evalSuccesses: 0,
        blockers: [],
        status: 'zero-evidence',
      },
      {
        wavemillAlias: 'qwen-3-coder',
        openrouterId: 'qwen/qwen3-coder',
        family: 'qwen',
        launchPriorityStatus: 'active',
        priorityTier: 1,
        role: 'review',
        directEvidenceCount: 1,
        availablePoolExposureCount: 10,
        evalAttempts: 1,
        evalSuccesses: 0,
        blockers: [],
        status: 'below-target',
      },
      {
        wavemillAlias: 'gemini-3.1-pro-preview',
        openrouterId: 'google/gemini-3.1-pro-preview',
        family: 'gemini',
        launchPriorityStatus: 'active',
        priorityTier: 1,
        role: 'planning',
        directEvidenceCount: 1,
        availablePoolExposureCount: 10,
        evalAttempts: 1,
        evalSuccesses: 0,
        blockers: [],
        status: 'below-target',
      },
    ],
  };
}

describe('plan-launch-priority-certifications', () => {
  it('groups zero-evidence aliases by family Linear ticket', () => {
    const plan = buildCertificationPlan({
      audit: makeAudit(),
      catalog,
      target: 3,
      now: new Date('2026-07-16T00:00:00.000Z'),
    });

    assert.equal(plan.totals.aliases, 1);
    assert.equal(plan.totals.plannedEvalRuns, 3);
    assert.equal(plan.groups[0]?.issue, 'HOK-2532');
    assert.equal(plan.groups[0]?.aliases[0]?.wavemillAlias, 'qwen-3-coder');
    assert.match(plan.groups[0]?.aliases[0]?.commands.certify ?? '', /--issue HOK-2532/);
  });

  it('can include below-target aliases when requested', () => {
    const plan = buildCertificationPlan({
      audit: makeAudit(),
      catalog,
      target: 3,
      includeBelowTarget: true,
    });

    assert.equal(plan.totals.aliases, 2);
    assert.equal(plan.groups.some((group) => group.issue === 'HOK-2528'), true);
  });

  it('omits persist from provisional certification commands and surfaces the blocker', () => {
    const audit = makeAudit();
    audit.zeroEvidence = ['ox-alpha'];
    audit.belowTarget = [];
    audit.models = [{
      wavemillAlias: 'ox-alpha',
      openrouterId: 'stealth/ox-alpha',
      family: 'gpt',
      launchPriorityStatus: 'watchlist',
      priorityTier: 9,
      role: 'coding',
      directEvidenceCount: 0,
      availablePoolExposureCount: 0,
      evalAttempts: 0,
      evalSuccesses: 0,
      blockers: [],
      status: 'zero-evidence',
    }];

    const plan = buildCertificationPlan({
      audit,
      catalog,
      target: 3,
    });
    const alias = plan.groups[0]?.aliases[0];

    assert.equal(alias?.wavemillAlias, 'ox-alpha');
    assert.match(alias?.commands.certify ?? '', /certify-launch-priority-model/);
    assert.doesNotMatch(alias?.commands.certify ?? '', /--persist/);
    assert.deepEqual(alias?.preflightBlockers, ['provisional-observation-only']);
  });
});
