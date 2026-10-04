/**
 * Unit tests for protected image artifact storage and retrieval.
 *
 * Tests:
 * - Ref validation (strict format, reject filesystem paths)
 * - Store/load round-trip with sidecar
 * - Content-address integrity verification
 * - File permissions (0o600)
 * - Metadata handling
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  parseArtifactRef,
  formatArtifactRef,
  storeImageArtifact,
  loadImageArtifact,
  type ImageArtifactMetadata,
  type ImageArtifactError,
} from './image-artifacts.ts';

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
    console.log(`        ${err}`);
  }
}

function cleanUp(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

// Type guard for error results
function isError(value: unknown): value is ImageArtifactError {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && 'code' in value
  );
}

// ────────────────────────────────────────────────────────────────
// Ref validation tests
// ────────────────────────────────────────────────────────────────

test('parseArtifactRef: valid ref with lowercase hex digest', () => {
  const digest = 'a'.repeat(64);
  const ref = `artifact://${digest}`;
  const result = parseArtifactRef(ref);
  assert(!isError(result));
  assert.equal(result, digest);
});

test('parseArtifactRef: rejects uppercase hex', () => {
  const ref = `artifact://${'A'.repeat(64)}`;
  const result = parseArtifactRef(ref);
  assert(isError(result));
  assert.equal(result.code, 'invalid_artifact_ref');
});

test('parseArtifactRef: rejects bare digest (no scheme)', () => {
  const ref = 'a'.repeat(64);
  const result = parseArtifactRef(ref);
  assert(isError(result));
  assert.equal(result.code, 'invalid_artifact_ref');
});

test('parseArtifactRef: rejects short hex', () => {
  const ref = 'artifact://abc123';
  const result = parseArtifactRef(ref);
  assert(isError(result));
});

test('parseArtifactRef: rejects traversal path', () => {
  const ref = `artifact://../${'a'.repeat(60)}`;
  const result = parseArtifactRef(ref);
  assert(isError(result));
});

test('parseArtifactRef: rejects absolute path', () => {
  const ref = `/tmp/${'a'.repeat(64)}`;
  const result = parseArtifactRef(ref);
  assert(isError(result));
});

test('parseArtifactRef: rejects file:// URL', () => {
  const ref = `file:///${'a'.repeat(64)}`;
  const result = parseArtifactRef(ref);
  assert(isError(result));
});

test('parseArtifactRef: rejects relative path', () => {
  const ref = `./artifacts/${'a'.repeat(64)}`;
  const result = parseArtifactRef(ref);
  assert(isError(result));
});

test('formatArtifactRef: produces valid ref from digest', () => {
  const digest = 'b'.repeat(64);
  const ref = formatArtifactRef(digest);
  assert.equal(ref, `artifact://${digest}`);
  // Verify it round-trips
  const parsed = parseArtifactRef(ref);
  assert(!isError(parsed));
  assert.equal(parsed, digest);
});

// ────────────────────────────────────────────────────────────────
// Round-trip and sidecar tests
// ────────────────────────────────────────────────────────────────

test('store/load round-trip: bytes identical and meta intact', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'image-artifacts-'));
  try {
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
    const meta: ImageArtifactMetadata = {
      mediaType: 'image/png',
      width: 100,
      height: 200,
      kind: 'screenshot',
      capturedAt: '2026-09-24T12:34:56Z',
      url: 'http://localhost:3000/test',
      origin: 'http://localhost:3000',
      viewport: { width: 1024, height: 768 },
      browser: { name: 'chromium', version: '123.0' },
      digest: createHash('sha256')
        .update(imageBytes)
        .digest('hex'),
      byteSize: imageBytes.length,
    };

    const stored = storeImageArtifact(imageBytes, meta, tmp);
    assert(stored.ref.startsWith('artifact://'));
    assert.equal(stored.digest, meta.digest);
    assert.equal(stored.byteSize, imageBytes.length);

    const loaded = loadImageArtifact(stored.ref, tmp);
    assert(!isError(loaded));
    assert.deepEqual(loaded.bytes, imageBytes);
    assert(loaded.meta);
    assert.equal(loaded.meta.width, meta.width);
    assert.equal(loaded.meta.height, meta.height);
    assert.equal(loaded.meta.kind, 'screenshot');
  } finally {
    cleanUp(tmp);
  }
});

test('store/load: sidecar absent when metadata not provided', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'image-artifacts-'));
  try {
    const imageBytes = Buffer.from([1, 2, 3, 4, 5]);
    const digest = createHash('sha256')
      .update(imageBytes)
      .digest('hex');
    const meta: ImageArtifactMetadata = {
      mediaType: 'image/png',
      width: 50,
      height: 50,
      kind: 'diff',
      digest,
      byteSize: imageBytes.length,
    };

    const stored = storeImageArtifact(imageBytes, meta, tmp);
    const loaded = loadImageArtifact(stored.ref, tmp);
    assert(!isError(loaded));
    assert(loaded.meta);
  } finally {
    cleanUp(tmp);
  }
});

test('file permissions: blob and sidecar are 0o600', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'image-artifacts-'));
  try {
    const imageBytes = Buffer.from([10, 20, 30]);
    const digest = createHash('sha256')
      .update(imageBytes)
      .digest('hex');
    const meta: ImageArtifactMetadata = {
      mediaType: 'image/png',
      width: 1,
      height: 1,
      kind: 'screenshot',
      digest,
      byteSize: imageBytes.length,
    };

    const stored = storeImageArtifact(imageBytes, meta, tmp);
    const parsed = parseArtifactRef(stored.ref);
    assert(!isError(parsed));

    const blobPath = join(tmp, '.wavemill', 'artifacts', parsed);
    const metaPath = `${blobPath}.meta.json`;

    const blobStat = statSync(blobPath);
    const metaStat = statSync(metaPath);

    // Mode 0o600 = rw-------
    assert.equal(blobStat.mode & 0o777, 0o600);
    assert.equal(metaStat.mode & 0o777, 0o600);
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Integrity tests
// ────────────────────────────────────────────────────────────────

test('integrity: tampered blob triggers mismatch error', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'image-artifacts-'));
  try {
    const imageBytes = Buffer.from([1, 2, 3]);
    const digest = createHash('sha256')
      .update(imageBytes)
      .digest('hex');
    const meta: ImageArtifactMetadata = {
      mediaType: 'image/png',
      width: 1,
      height: 1,
      kind: 'screenshot',
      digest,
      byteSize: imageBytes.length,
    };

    const stored = storeImageArtifact(imageBytes, meta, tmp);

    // Manually corrupt the blob
    const parsed = parseArtifactRef(stored.ref);
    assert(!isError(parsed));
    const blobPath = join(tmp, '.wavemill', 'artifacts', parsed);
    writeFileSync(blobPath, Buffer.from([0xff, 0xff, 0xff]));

    // Load should fail with integrity error
    const result = loadImageArtifact(stored.ref, tmp);
    assert(isError(result));
    assert.equal(result.code, 'artifact_integrity_mismatch');
  } finally {
    cleanUp(tmp);
  }
});

test('artifact not found: returns error when blob missing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'image-artifacts-'));
  try {
    const ref = `artifact://${'a'.repeat(64)}`;
    const result = loadImageArtifact(ref, tmp);
    assert(isError(result));
    assert.equal(result.code, 'artifact_not_found');
  } finally {
    cleanUp(tmp);
  }
});

test('downscale metadata: stored and loaded correctly', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'image-artifacts-'));
  try {
    const imageBytes = Buffer.from([5, 6, 7]);
    const digest = createHash('sha256')
      .update(imageBytes)
      .digest('hex');
    const meta: ImageArtifactMetadata = {
      mediaType: 'image/png',
      width: 1024,
      height: 768,
      kind: 'screenshot',
      digest,
      byteSize: imageBytes.length,
      downscaled: true,
      factor: 2,
      originalWidth: 2048,
      originalHeight: 1536,
    };

    const stored = storeImageArtifact(imageBytes, meta, tmp);
    const loaded = loadImageArtifact(stored.ref, tmp);
    assert(!isError(loaded));
    assert(loaded.meta);
    assert.equal(loaded.meta.downscaled, true);
    assert.equal(loaded.meta.factor, 2);
    assert.equal(loaded.meta.originalWidth, 2048);
  } finally {
    cleanUp(tmp);
  }
});

// ────────────────────────────────────────────────────────────────
// Print results
// ────────────────────────────────────────────────────────────────

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) process.exit(1);
