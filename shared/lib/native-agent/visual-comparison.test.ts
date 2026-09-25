/**
 * Unit tests for visual comparison of image artifacts.
 *
 * Tests:
 * - Identical fixtures → zero diff
 * - Changed fixtures → stable diff metrics
 * - Dimension mismatch detection
 * - Pixel budget enforcement
 * - Diff image generation
 * - Invalid ref rejection
 * - Missing artifact handling
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  compareImageArtifacts,
  type VisualComparisonResult,
} from './visual-comparison.ts';
import {
  storeImageArtifact,
  formatArtifactRef,
} from './image-artifacts.ts';
import {
  buildBaselinePng,
  buildIdenticalPng,
  buildChangedPng,
  buildOversizedPng,
} from './fixtures/images.ts';
import { createHash } from 'node:crypto';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result.then(() => {
        passed++;
        console.log(`  PASS  ${name}`);
      }).catch((err) => {
        failed++;
        console.log(`  FAIL  ${name}`);
        console.log(`        ${err}`);
      });
    } else {
      passed++;
      console.log(`  PASS  ${name}`);
    }
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err}`);
  }
}

function cleanUp(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

// ────────────────────────────────────────────────────────────────
// Identical and changed image tests
// ────────────────────────────────────────────────────────────────

test('identical fixtures yield zero diff with no diff artifact', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'visual-comparison-'));
  try {
    const bytes = buildBaselinePng();
    const digest = createHash('sha256').update(bytes).digest('hex');
    const stored1 = storeImageArtifact(
      bytes,
      { mediaType: 'image/png', width: 100, height: 100, kind: 'screenshot', digest, byteSize: bytes.length },
      tmp,
    );
    const stored2 = storeImageArtifact(
      buildIdenticalPng(),
      {
        mediaType: 'image/png',
        width: 100,
        height: 100,
        kind: 'screenshot',
        digest: createHash('sha256').update(buildIdenticalPng()).digest('hex'),
        byteSize: buildIdenticalPng().length,
      },
      tmp,
    );

    const result = await compareImageArtifacts({
      baselineRef: stored1.ref,
      currentRef: stored2.ref,
      repoDir: tmp,
    });

    assert(result.comparable);
    assert.equal(result.diffPixels, 0);
    assert.equal(result.diffRatio, 0);
    assert(!result.diffRef); // No diff artifact for zero diff
  } finally {
    cleanUp(tmp);
  }
});

test('changed fixtures yield stable diff metrics', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'visual-comparison-'));
  try {
    const baselineBytes = buildBaselinePng();
    const baselineDigest = createHash('sha256').update(baselineBytes).digest('hex');
    const changedBytes = buildChangedPng();
    const changedDigest = createHash('sha256').update(changedBytes).digest('hex');

    const stored1 = storeImageArtifact(
      baselineBytes,
      { mediaType: 'image/png', width: 100, height: 100, kind: 'screenshot', digest: baselineDigest, byteSize: baselineBytes.length },
      tmp,
    );
    const stored2 = storeImageArtifact(
      changedBytes,
      { mediaType: 'image/png', width: 100, height: 100, kind: 'screenshot', digest: changedDigest, byteSize: changedBytes.length },
      tmp,
    );

    const result = await compareImageArtifacts({
      baselineRef: stored1.ref,
      currentRef: stored2.ref,
      repoDir: tmp,
    });

    assert(result.comparable);
    assert(result.diffPixels && result.diffPixels > 0);
    assert.equal(typeof result.diffRatio, 'number');
    assert(result.diffRef); // Diff artifact should be generated
  } finally {
    cleanUp(tmp);
  }
});

test('zero diff runs produce identical results', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'visual-comparison-'));
  try {
    const baselineBytes = buildBaselinePng();
    const baselineDigest = createHash('sha256').update(baselineBytes).digest('hex');
    const changedBytes = buildChangedPng();
    const changedDigest = createHash('sha256').update(changedBytes).digest('hex');

    const stored1 = storeImageArtifact(
      baselineBytes,
      { mediaType: 'image/png', width: 100, height: 100, kind: 'screenshot', digest: baselineDigest, byteSize: baselineBytes.length },
      tmp,
    );
    const stored2 = storeImageArtifact(
      changedBytes,
      { mediaType: 'image/png', width: 100, height: 100, kind: 'screenshot', digest: changedDigest, byteSize: changedBytes.length },
      tmp,
    );

    const result1 = await compareImageArtifacts({
      baselineRef: stored1.ref,
      currentRef: stored2.ref,
      repoDir: tmp,
    });

    const result2 = await compareImageArtifacts({
      baselineRef: stored1.ref,
      currentRef: stored2.ref,
      repoDir: tmp,
    });

    assert.deepEqual(result1, result2);
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Dimension mismatch tests
// ────────────────────────────────────────────────────────────────

test('dimension mismatch returns comparable:false with per-image dims', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'visual-comparison-'));
  try {
    const baseline100x100 = buildBaselinePng();
    const changed200x200 = buildOversizedPng(200, 200);

    const digest1 = createHash('sha256').update(baseline100x100).digest('hex');
    const digest2 = createHash('sha256').update(changed200x200).digest('hex');

    const stored1 = storeImageArtifact(
      baseline100x100,
      { mediaType: 'image/png', width: 100, height: 100, kind: 'screenshot', digest: digest1, byteSize: baseline100x100.length },
      tmp,
    );
    const stored2 = storeImageArtifact(
      changed200x200,
      { mediaType: 'image/png', width: 200, height: 200, kind: 'screenshot', digest: digest2, byteSize: changed200x200.length },
      tmp,
    );

    const result = await compareImageArtifacts({
      baselineRef: stored1.ref,
      currentRef: stored2.ref,
      repoDir: tmp,
    });

    assert(!result.comparable);
    assert.equal(result.reason, 'dimension_mismatch');
    assert.deepEqual(result.baseline, { width: 100, height: 100 });
    assert.deepEqual(result.current, { width: 200, height: 200 });
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Pixel budget tests
// ────────────────────────────────────────────────────────────────

test('comparison exceeding pixel budget returns error', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'visual-comparison-'));
  try {
    // 5000x5000 = 25M pixels, exceeds 16M default
    const large = buildOversizedPng(5000, 5000);
    const digest = createHash('sha256').update(large).digest('hex');

    const stored = storeImageArtifact(
      large,
      { mediaType: 'image/png', width: 5000, height: 5000, kind: 'screenshot', digest, byteSize: large.length },
      tmp,
    );

    const result = await compareImageArtifacts({
      baselineRef: stored.ref,
      currentRef: stored.ref,
      repoDir: tmp,
    });

    assert(!result.comparable);
    assert.equal(result.reason, 'comparison_too_large');
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Error handling
// ────────────────────────────────────────────────────────────────

test('invalid baseline ref returns error without filesystem access', async () => {
  const result = await compareImageArtifacts({
    baselineRef: '/tmp/evil/path',
    currentRef: `artifact://${'a'.repeat(64)}`,
  });

  assert(!result.comparable);
  assert.equal(result.reason, 'invalid_ref');
});

test('missing artifact returns error', async () => {
  const result = await compareImageArtifacts({
    baselineRef: `artifact://${'a'.repeat(64)}`,
    currentRef: `artifact://${'b'.repeat(64)}`,
  });

  assert(!result.comparable);
  assert.equal(result.reason, 'artifact_not_found');
});

// ────────────────────────────────────────────────────────────────
// Print results
// ────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exit(1);
}, 1000);
