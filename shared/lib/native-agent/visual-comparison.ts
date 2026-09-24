/**
 * Visual comparison of image artifacts.
 *
 * Compares two PNG images (loaded via artifact refs) using pixelmatch to
 * detect pixel-level differences. Returns structured metrics including
 * diff image generation (optional). No verdict field — results are metrics only.
 */

import { createHash } from 'node:crypto';
import PNG from 'pngjs';
import pixelmatch from 'pixelmatch';
import {
  loadImageArtifact,
  storeImageArtifact,
  parseArtifactRef,
  type ImageArtifactError,
} from './image-artifacts.ts';

/**
 * Result of comparing two image artifacts.
 */
export interface VisualComparisonResult {
  comparable: boolean;
  reason?: 'dimension_mismatch' | 'invalid_ref' | 'artifact_not_found' | 'image_decode_failed' | 'comparison_too_large';
  error?: string;
  // Results when comparable=true and dimensions match
  width?: number;
  height?: number;
  totalPixels?: number;
  diffPixels?: number;
  diffRatio?: number; // 0-1, 6 decimal places
  threshold?: number;
  // Only present when diffPixels > 0 and emitDiffImage is true
  diffRef?: string;
  // Baseline/current dimensions when comparable=false (dimension_mismatch)
  baseline?: { width: number; height: number };
  current?: { width: number; height: number };
}

/**
 * Compare two image artifacts using pixelmatch.
 */
export async function compareImageArtifacts(options: {
  baselineRef: string;
  currentRef: string;
  repoDir?: string;
  options?: {
    diffThreshold?: number;
    emitDiffImage?: boolean;
    maxComparePixels?: number;
  };
}): Promise<VisualComparisonResult> {
  const { baselineRef, currentRef, repoDir } = options;
  const diffThreshold = options.options?.diffThreshold ?? 0.1;
  const emitDiffImage = options.options?.emitDiffImage !== false;
  const maxComparePixels = options.options?.maxComparePixels ?? 16_777_216;

  // Validate and parse refs
  const baselineDigest = parseArtifactRef(baselineRef);
  if (typeof baselineDigest !== 'string') {
    return {
      comparable: false,
      reason: 'invalid_ref',
      error: `Invalid baseline ref: ${baselineDigest.message}`,
    };
  }

  const currentDigest = parseArtifactRef(currentRef);
  if (typeof currentDigest !== 'string') {
    return {
      comparable: false,
      reason: 'invalid_ref',
      error: `Invalid current ref: ${currentDigest.message}`,
    };
  }

  // Load baseline
  const baselineResult = loadImageArtifact(baselineRef, repoDir);
  if ('code' in baselineResult) {
    return {
      comparable: false,
      reason: baselineResult.code === 'artifact_not_found' ? 'artifact_not_found' : 'image_decode_failed',
      error: baselineResult.message || baselineResult.code,
    };
  }

  // Load current
  const currentResult = loadImageArtifact(currentRef, repoDir);
  if ('code' in currentResult) {
    return {
      comparable: false,
      reason: currentResult.code === 'artifact_not_found' ? 'artifact_not_found' : 'image_decode_failed',
      error: currentResult.message || currentResult.code,
    };
  }

  // Decode PNGs
  let baselinePng: PNG;
  let currentPng: PNG;
  try {
    baselinePng = PNG.sync.read(baselineResult.bytes);
    currentPng = PNG.sync.read(currentResult.bytes);
  } catch (err) {
    return {
      comparable: false,
      reason: 'image_decode_failed',
      error: `PNG decode error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Check for dimension mismatch
  if (baselinePng.width !== currentPng.width || baselinePng.height !== currentPng.height) {
    return {
      comparable: false,
      reason: 'dimension_mismatch',
      baseline: { width: baselinePng.width, height: baselinePng.height },
      current: { width: currentPng.width, height: currentPng.height },
    };
  }

  // Check pixel budget
  const totalPixels = baselinePng.width * baselinePng.height;
  if (totalPixels > maxComparePixels) {
    return {
      comparable: false,
      reason: 'comparison_too_large',
      error: `Comparison exceeds pixel budget: ${totalPixels} > ${maxComparePixels}`,
    };
  }

  // Run pixelmatch
  const diffData = Buffer.alloc(baselinePng.data.length);
  const diffPixels = pixelmatch(
    baselinePng.data,
    currentPng.data,
    diffData,
    baselinePng.width,
    baselinePng.height,
    { threshold: diffThreshold },
  );

  const diffRatio = totalPixels > 0 ? parseFloat((diffPixels / totalPixels).toFixed(6)) : 0;

  // If no diff and no diff image requested, return early
  if (diffPixels === 0) {
    return {
      comparable: true,
      width: baselinePng.width,
      height: baselinePng.height,
      totalPixels,
      diffPixels: 0,
      diffRatio: 0,
      threshold: diffThreshold,
    };
  }

  // Build result with diff image if requested
  let diffRef: string | undefined;
  if (emitDiffImage && diffPixels > 0) {
    try {
      const diffPng = new PNG({
        width: baselinePng.width,
        height: baselinePng.height,
        data: diffData,
      });
      const diffBytes = PNG.sync.write(diffPng);
      const digestFromBytes = createHash('sha256')
        .update(diffBytes)
        .digest('hex');

      const stored = storeImageArtifact(
        diffBytes,
        {
          mediaType: 'image/png',
          width: baselinePng.width,
          height: baselinePng.height,
          kind: 'diff',
          digest: digestFromBytes,
          byteSize: diffBytes.length,
        },
        repoDir,
      );
      diffRef = stored.ref;
    } catch {
      // Fail gracefully if diff image storage fails
    }
  }

  return {
    comparable: true,
    width: baselinePng.width,
    height: baselinePng.height,
    totalPixels,
    diffPixels,
    diffRatio,
    threshold: diffThreshold,
    ...(diffRef ? { diffRef } : {}),
  };
}
