import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isSdkTaskCostShadowEnabled,
  resolveSdkTaskCostShadowMode,
  SDK_TASK_COST_SHADOW_ENV,
} from './feature-switch.ts';

const env = (value: string | undefined) => ({ [SDK_TASK_COST_SHADOW_ENV]: value });

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
