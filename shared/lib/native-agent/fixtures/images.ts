/**
 * Deterministic PNG fixture builders for testing screenshot and comparison.
 *
 * All fixtures are generated programmatically (no committed binaries).
 * Output is byte-identical across runs for stable assertions.
 */

import { PNG } from 'pngjs';

/**
 * Build a baseline PNG with a known fixed pattern.
 * 100x100 pixels, red background with green square.
 */
export function buildBaselinePng(): Buffer {
  const png = new PNG({ width: 100, height: 100 });

  // Red background
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 255; // R
    png.data[i + 1] = 0; // G
    png.data[i + 2] = 0; // B
    png.data[i + 3] = 255; // A
  }

  // Green square (25x25 at 25,25)
  for (let y = 25; y < 50; y++) {
    for (let x = 25; x < 50; x++) {
      const idx = (y * png.width + x) * 4;
      png.data[idx] = 0; // R
      png.data[idx + 1] = 255; // G
      png.data[idx + 2] = 0; // B
      png.data[idx + 3] = 255; // A
    }
  }

  return PNG.sync.write(png);
}

/**
 * Build an identical PNG to the baseline (byte-identical).
 */
export function buildIdenticalPng(): Buffer {
  return buildBaselinePng();
}

/**
 * Build a PNG with changes: remove the green square, add blue square.
 * This creates a known number of changed pixels for stable testing.
 */
export function buildChangedPng(): Buffer {
  const png = new PNG({ width: 100, height: 100 });

  // Red background
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 255; // R
    png.data[i + 1] = 0; // G
    png.data[i + 2] = 0; // B
    png.data[i + 3] = 255; // A
  }

  // Blue square (25x25 at 25,25) — same position as green in baseline
  for (let y = 25; y < 50; y++) {
    for (let x = 25; x < 50; x++) {
      const idx = (y * png.width + x) * 4;
      png.data[idx] = 0; // R
      png.data[idx + 1] = 0; // G
      png.data[idx + 2] = 255; // B
      png.data[idx + 3] = 255; // A
    }
  }

  return PNG.sync.write(png);
}

/**
 * Build an oversized PNG for testing size limits.
 */
export function buildOversizedPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });

  // Fill with a pattern
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = (i / 4) % 256; // R
    png.data[i + 1] = ((i / 4) >> 8) % 256; // G
    png.data[i + 2] = ((i / 4) >> 16) % 256; // B
    png.data[i + 3] = 255; // A
  }

  return PNG.sync.write(png);
}
