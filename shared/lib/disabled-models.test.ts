import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { DISABLED_MODEL_IDS, filterDisabledModels, isDisabledModel } from './disabled-models.ts';

test('disabled models are excluded from any candidate pool', () => {
  assert.equal(isDisabledModel('gpt-5.3-codex'), true);
  assert.equal(isDisabledModel('gpt-5.5'), false);
  assert.deepEqual(
    filterDisabledModels(['gpt-5.5', 'gpt-5.3-codex', 'kimi-k2.7-code']),
    ['gpt-5.5', 'kimi-k2.7-code'],
  );
});

test('llama-4-maverick is held out of automatic selection (HOK-2885)', () => {
  // Stalled on 5 of 7 recent challenger launches with a provider-side idle
  // timeout. This is the lever every routing path honours; the registry's
  // routingEligible flag does NOT gate challenger selection, which draws its
  // pool from filterDisabledModels instead.
  assert.equal(isDisabledModel('llama-4-maverick'), true);
  assert.equal(filterDisabledModels(['llama-4-maverick']).length, 0);
});

test('gemini-3.1-pro-preview variants are held out pending HOK-3158 data retention', () => {
  assert.equal(isDisabledModel('gemini-3.1-pro-preview'), true);
  assert.equal(isDisabledModel('gemini-3.1-pro-preview-customtools'), true);
  assert.deepEqual(
    filterDisabledModels(['gemini-3.1-pro-preview', 'gemini-3.1-pro-preview-customtools', 'gemini-2.5-pro']),
    ['gemini-2.5-pro'],
  );
});

test('llama-4-scout is held out after live coding challenge failures', () => {
  assert.equal(isDisabledModel('llama-4-scout'), true);
  assert.deepEqual(
    filterDisabledModels(['llama-4-scout', 'kimi-k2.7-code']),
    ['kimi-k2.7-code'],
  );
});

test('the hold list stays deliberate', () => {
  // Every entry costs the fleet a model, so keep the set small and reviewed.
  assert.ok(DISABLED_MODEL_IDS.size <= 5, `unexpectedly large hold list: ${DISABLED_MODEL_IDS.size}`);
});

test('non-string input is not treated as disabled', () => {
  assert.equal(isDisabledModel(undefined), false);
  assert.equal(isDisabledModel(null), false);
  assert.equal(isDisabledModel(''), false);
});
