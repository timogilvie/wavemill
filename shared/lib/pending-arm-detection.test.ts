import assert from 'node:assert';
import { hasPendingArms, getPendingArms, isPrimaryWithPendingArm } from './pending-arm-detection.ts';

// Test: hasPendingArms detects awaiting_fork arms
{
  const task = {
    challengeArms: [
      { key: 'HOK-1_c', challengeArmState: 'awaiting_fork' },
    ],
  };
  assert.strictEqual(hasPendingArms(task), true, 'Should detect awaiting_fork arm');
}

// Test: hasPendingArms returns false when no arms
{
  const task = { challengeArms: [] };
  assert.strictEqual(hasPendingArms(task), false, 'Should return false for empty arms');
}

// Test: hasPendingArms returns false when no awaiting_fork arms
{
  const task = {
    challengeArms: [
      { key: 'HOK-1_c', challengeArmState: 'materialized' },
      { key: 'HOK-2_c', challengeArmState: 'cancelled' },
    ],
  };
  assert.strictEqual(hasPendingArms(task), false, 'Should ignore non-pending arms');
}

// Test: hasPendingArms handles undefined task
{
  assert.strictEqual(hasPendingArms(undefined), false, 'Should handle undefined task');
}

// Test: getPendingArms returns empty for no pending
{
  const task = { challengeArms: [{ key: 'HOK-1_c', challengeArmState: 'materialized' }] };
  const pending = getPendingArms(task);
  assert.strictEqual(pending.length, 0, 'Should return empty array for no pending arms');
}

// Test: getPendingArms returns pending arms only
{
  const task = {
    challengeArms: [
      { key: 'HOK-1_c', challengeArmState: 'awaiting_fork', slug: 'foo-1' },
      { key: 'HOK-2_c', challengeArmState: 'materialized', slug: 'foo-2' },
      { key: 'HOK-3_c', challengeArmState: 'awaiting_fork', slug: 'foo-3' },
    ],
  };
  const pending = getPendingArms(task);
  assert.strictEqual(pending.length, 2, 'Should return only pending arms');
  assert.strictEqual(pending[0].key, 'HOK-1_c', 'First pending arm matches');
  assert.strictEqual(pending[1].key, 'HOK-3_c', 'Second pending arm matches');
}

// Test: isPrimaryWithPendingArm delegates to hasPendingArms
{
  const task = {
    challengeArms: [{ key: 'HOK-1_c', challengeArmState: 'awaiting_fork' }],
  };
  assert.strictEqual(isPrimaryWithPendingArm(task), true, 'Should detect pending arm');
  assert.strictEqual(isPrimaryWithPendingArm(undefined), false, 'Should return false for undefined');
}

console.log('✓ All pending-arm-detection tests passed');
