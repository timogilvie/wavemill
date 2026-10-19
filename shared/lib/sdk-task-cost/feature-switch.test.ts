import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  COST_METERING_LEGACY_ENV,
  isSdkTaskCostShadowEnabled,
  resolveCostMeteringEngine,
  resolveSdkTaskCostShadowMode,
  SDK_TASK_COST_SHADOW_ENV,
} from './feature-switch.ts';

const env = (value: string | undefined) => ({ [SDK_TASK_COST_SHADOW_ENV]: value });
const legacyEnv = (value: string | undefined) => ({ [COST_METERING_LEGACY_ENV]: value });

describe('WAVEMILL_COST_METERING_LEGACY', () => {
  it('defaults to the SDK engine', () => {
    assert.equal(resolveCostMeteringEngine({}), 'sdk');
  });

  it('rolls back to legacy on on-values, case-insensitively', () => {
    for (const value of ['1', 'true', 'on', 'TRUE', ' On ']) {
      assert.equal(resolveCostMeteringEngine(legacyEnv(value)), 'legacy', value);
    }
  });

  it('keeps the SDK engine for off-values', () => {
    for (const value of ['', '0', 'false', 'off', ' OFF ']) {
      assert.equal(resolveCostMeteringEngine(legacyEnv(value)), 'sdk', value);
    }
  });

  it('treats unrecognised values as the gated SDK default', () => {
    for (const value of ['yes', '2', 'legacy', 'sdk']) {
      assert.equal(resolveCostMeteringEngine(legacyEnv(value)), 'sdk', value);
    }
  });

  it('is independent of the shadow switch', () => {
    assert.equal(resolveCostMeteringEngine(env('1')), 'sdk');
    assert.equal(resolveSdkTaskCostShadowMode(legacyEnv('1')), 'off');
  });
});

describe('WAVEMILL_SDK_COST_METERING_SHADOW', () => {
  it('defaults to off', () => {
    assert.equal(resolveSdkTaskCostShadowMode({}), 'off');
    assert.equal(isSdkTaskCostShadowEnabled({}), false);
  });

  it('resolves explicit off values', () => {
    for (const value of ['', '0', 'false', 'off', ' OFF ']) {
      assert.equal(resolveSdkTaskCostShadowMode(env(value)), 'off', value);
    }
  });

  it('resolves on values case-insensitively', () => {
    for (const value of ['1', 'true', 'on', 'TRUE', ' On ']) {
      assert.equal(resolveSdkTaskCostShadowMode(env(value)), 'on', value);
      assert.equal(isSdkTaskCostShadowEnabled(env(value)), true, value);
    }
  });

  it('resolves strict', () => {
    assert.equal(resolveSdkTaskCostShadowMode(env('strict')), 'strict');
    assert.equal(isSdkTaskCostShadowEnabled(env('Strict')), true);
  });

  it('treats unrecognised values as off', () => {
    for (const value of ['yes', '2', 'shadow', 'cutover']) {
      assert.equal(resolveSdkTaskCostShadowMode(env(value)), 'off', value);
    }
  });
});
