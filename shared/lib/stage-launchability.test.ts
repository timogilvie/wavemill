/**
 * HOK-3142: the router's launchability predicate must be the launcher's own
 * resolver, so a workflow-certified model without a live coding canary is
 * refused for coding by both, with a certify command that actually fixes it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listCoderCanaryGaps } from './launchable-models.ts';
import { DEFAULT_CERTIFICATION_SUITE_VERSION } from './native-agent/certification/index.ts';
import { resolveModelAgent } from './model-agent-resolution.ts';
import { getEffectiveRegistry } from './model-registry.ts';
import {
  createLaunchabilityChecker,
  isDeterministicLaunchRefusal,
  isLaunchableForStage,
  isStageLaunchRefusal,
  ROLE_TO_LAUNCH_STAGE,
} from './stage-launchability.ts';
import { makeOpenRouterReadyRepo, writeCertArtifact } from './workflow-router-test-helpers.ts';

const NATIVE_MODEL = 'qwen-3-coder';

function withRepo(fn: (repoDir: string) => void): void {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo();
  try {
    fn(repoDir);
  } finally {
    cleanup();
  }
}

describe('isLaunchableForStage', () => {
  it('refuses coding for a workflow-certified model without a live canary, with a canary certify command', () => {
    withRepo((repoDir) => {
      writeCertArtifact(repoDir, 'qwen', 'qwen3-coder', DEFAULT_CERTIFICATION_SUITE_VERSION, {
        phase: 'workflow',
        liveCanary: undefined,
      });

      const result = isLaunchableForStage(NATIVE_MODEL, 'coding', { repoDir });
      assert.ok(isStageLaunchRefusal(result), 'expected a coding refusal');
      assert.equal(result.reason, 'uncertified');
      assert.equal(result.certification, 'missing_live_canary');
      assert.match(result.certifyCommand ?? '', /--phase patch/);
      assert.match(result.certifyCommand ?? '', /--live-coding-canary/);
      assert.match(result.diagnostic, /certification=missing_live_canary/);
    });
  });

  it('agrees with the launcher resolver for every stage (parity by construction)', () => {
    withRepo((repoDir) => {
      writeCertArtifact(repoDir, 'qwen', 'qwen3-coder', DEFAULT_CERTIFICATION_SUITE_VERSION, {
        phase: 'workflow',
        liveCanary: undefined,
      });
      const registry = getEffectiveRegistry(repoDir);
      for (const stage of ['planning', 'coding', 'review'] as const) {
        const predicate = isLaunchableForStage(NATIVE_MODEL, stage, { repoDir });
        const launcher = resolveModelAgent({ model: NATIVE_MODEL, phase: stage, repoDir, registry });
        assert.equal(predicate.ok, launcher.ok, `stage ${stage} disagrees with the launcher`);
        if (!launcher.ok && isStageLaunchRefusal(predicate)) {
          assert.equal(predicate.reason, launcher.reason);
          assert.equal(predicate.certification, launcher.certificationStatus);
          assert.equal(predicate.certifyCommand, launcher.certifyCommand);
        }
      }
    });
  });

  it('accepts coding for a patch certificate with a fresh live canary', () => {
    withRepo((repoDir) => {
      writeCertArtifact(repoDir, 'qwen', 'qwen3-coder', DEFAULT_CERTIFICATION_SUITE_VERSION, { phase: 'patch' });
      const result = isLaunchableForStage(NATIVE_MODEL, 'coding', { repoDir });
      assert.deepEqual(result, { ok: true, agent: 'native-openrouter' });
    });
  });

  it('accepts hosted Anthropic models without certification artifacts', () => {
    withRepo((repoDir) => {
      assert.deepEqual(
        isLaunchableForStage('claude-haiku-4-5-20251001', 'coding', { repoDir }),
        { ok: true, agent: 'claude' },
      );
    });
  });

  it('omits --live-coding-canary when the refusal is not a canary reason', () => {
    withRepo((repoDir) => {
      // No artifact at all: the deterministic suite must run first.
      const result = isLaunchableForStage(NATIVE_MODEL, 'coding', { repoDir });
      assert.ok(isStageLaunchRefusal(result));
      assert.equal(result.reason, 'uncertified');
      assert.notEqual(result.certification, 'missing_live_canary');
      assert.doesNotMatch(result.certifyCommand ?? '', /--live-coding-canary/);
    });
  });

  it('maps router roles onto launch stages', () => {
    assert.deepEqual(ROLE_TO_LAUNCH_STAGE, { planner: 'planning', coder: 'coding', reviewer: 'review' });
  });
});

describe('createLaunchabilityChecker', () => {
  it('memoizes per (model, stage) within one routing pass', () => {
    withRepo((repoDir) => {
      const check = createLaunchabilityChecker({ repoDir });
      const first = check(NATIVE_MODEL, 'coding');
      assert.equal(check(NATIVE_MODEL, 'coding'), first, 'same object for a repeated probe');
      assert.notEqual(check(NATIVE_MODEL, 'review'), first, 'stages are cached separately');
    });
  });
});

describe('isDeterministicLaunchRefusal', () => {
  const cases: Array<[string | undefined, boolean]> = [
    ['uncertified', true],
    ['no-native-capability', true],
    ['native-unsupported', true],
    ['lifecycle-blocked', true],
    ['role-ineligible', true],
    ['tool-support-insufficient', true],
    ['context-window-insufficient', true],
    ['codex-chatgpt-ineligible', true],
    ['unknown-model', true],
    ['invalid-model-id', false],
    ['resolver-failed', false],
    ['', false],
    [undefined, false],
  ];
  for (const [reason, expected] of cases) {
    it(`${String(reason)} → ${expected}`, () => {
      assert.equal(isDeterministicLaunchRefusal(reason), expected);
    });
  }
});

describe('listCoderCanaryGaps (mill preflight advisory)', () => {
  it('lists a router-eligible native coder that has a workflow cert but no live canary', () => {
    withRepo((repoDir) => {
      writeCertArtifact(repoDir, 'qwen', 'qwen3-coder', DEFAULT_CERTIFICATION_SUITE_VERSION, {
        phase: 'workflow',
        liveCanary: undefined,
      });
      const gap = listCoderCanaryGaps({ repoDir }).find((entry) => entry.modelId === NATIVE_MODEL);
      assert.ok(gap, 'qwen-3-coder is reported');
      assert.equal(gap?.certification, 'missing_live_canary');
      assert.match(gap?.certifyCommand ?? '', /--live-coding-canary/);
    });
  });

  it('omits coders with a passing canary and coders blocked for non-canary reasons', () => {
    withRepo((repoDir) => {
      writeCertArtifact(repoDir, 'qwen', 'qwen3-coder', DEFAULT_CERTIFICATION_SUITE_VERSION, { phase: 'patch' });
      const gaps = listCoderCanaryGaps({ repoDir });
      assert.equal(gaps.some((entry) => entry.modelId === NATIVE_MODEL), false);
      // Models with no artifact at all are a coverage problem, not a canary gap.
      assert.ok(gaps.every((entry) => entry.certification.includes('canary')));
    });
  });
});

