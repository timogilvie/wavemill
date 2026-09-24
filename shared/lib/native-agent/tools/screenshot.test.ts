/**
 * Minimal test file for screenshot tools.
 * Full tests to be implemented in Phase 6.
 */

import assert from 'node:assert/strict';
import { createScreenshotTools } from './screenshot.ts';

console.log('Testing screenshot tools...');

const { descriptors } = createScreenshotTools();
assert.equal(descriptors.length, 0, 'Screenshot tools should be disabled by default');

console.log('Screenshot tools test passed');
