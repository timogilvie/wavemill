/**
 * Protected image artifact storage and retrieval.
 *
 * Screenshot and comparison images are stored through the existing artifact
 * layer but with enhanced protection: strict ref validation (reject filesystem
 * paths), deterministic storage with content-address integrity verification,
 * and sidecar metadata in JSON. Refs are always in the format `artifact://<digest>`.
 */

import { existsSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  computeDigest,
  resolveArtifactPath,
  resolveArtifactsDir,
  storeArtifact,
  retrieveArtifact,
} from './session-stream.ts';

// Protected artifact reference format: artifact://[a-f0-9]{64}
const ARTIFACT_REF_REGEX = /^artifact:\/\/([a-f0-9]{64})$/;

/**
 * Metadata sidecar for stored image artifacts.
 * Stored as `<digest>.meta.json` in the artifacts directory.
 */
export interface ImageArtifactMetadata {
  mediaType: string; // 'image/png' etc.
  width: number;
  height: number;
  kind: 'screenshot' | 'diff'; // screenshot for captures, diff for pixelmatch output
  capturedAt?: string; // ISO 8601 timestamp
  url?: string; // Page URL (page-derived, untrusted)
  origin?: string; // Page origin (page-derived, untrusted)
  viewport?: {
    width: number;
    height: number;
  };
  browser?: {
    name?: string;
    version?: string;
  };
  // Content-address integrity
  digest: string;
  byteSize: number;
  // Downscaling metadata (when downscale policy was applied)
  downscaled?: boolean;
  factor?: number; // Downscale factor
  originalWidth?: number;
  originalHeight?: number;
}

/**
 * Result of storing an image artifact.
 */
export interface StoredImageArtifact {
  ref: string; // artifact://<digest>
  digest: string;
  byteSize: number;
}

/**
 * Result of loading an image artifact.
 */
export interface LoadedImageArtifact {
  bytes: Buffer;
  meta: ImageArtifactMetadata | null; // null if sidecar not found
}

/**
 * Error result for image artifact operations.
 */
export interface ImageArtifactError {
  code: string;
  message: string;
}

/**
 * Parse and validate an artifact reference. Returns the digest if valid,
 * or an error if the format is invalid.
 */
export function parseArtifactRef(ref: string): string | ImageArtifactError {
  const match = ref.match(ARTIFACT_REF_REGEX);
  if (!match) {
    return {
      code: 'invalid_artifact_ref',
      message: `Invalid artifact reference format: ${ref}. Expected artifact://<64-hex-lowercase>`,
    };
  }
  return match[1];
}

/**
 * Format an artifact reference from a digest.
 */
export function formatArtifactRef(digest: string): string {
  return `artifact://${digest}`;
}

/**
 * Store an image artifact with protected ref format and sidecar metadata.
 * Sets file mode to 0o600 (read-write owner, no other access).
 */
export function storeImageArtifact(
  bytes: Buffer,
  meta: ImageArtifactMetadata,
  repoDir?: string,
): StoredImageArtifact {
  // Recompute digest from bytes to ensure integrity
  const digest = computeDigest(bytes);

  // Verify the digest in metadata matches
  if (meta.digest !== digest) {
    throw new Error(`Digest mismatch: metadata ${meta.digest} != computed ${digest}`);
  }

  // Store the blob using the existing layer
  const blobPath = resolveArtifactPath(digest, repoDir);
  const blobDir = dirname(blobPath);
  mkdirSync(blobDir, { recursive: true });

  if (!existsSync(blobPath)) {
    writeFileSync(blobPath, bytes);
    chmodSync(blobPath, 0o600);
  }

  // Store sidecar metadata
  const metaPath = `${blobPath}.meta.json`;
  const metaJson = JSON.stringify(meta, null, 2);
  if (!existsSync(metaPath)) {
    writeFileSync(metaPath, metaJson);
    chmodSync(metaPath, 0o600);
  }

  return {
    ref: formatArtifactRef(digest),
    digest,
    byteSize: bytes.length,
  };
}

/**
 * Load an image artifact by ref. Returns the bytes and metadata (if present).
 * Verifies content-address integrity: re-hashes the loaded bytes against the
 * digest derived from the ref.
 */
export function loadImageArtifact(
  ref: string,
  repoDir?: string,
): LoadedImageArtifact | ImageArtifactError {
  // Parse and validate ref first — no filesystem access before this
  const digestOrError = parseArtifactRef(ref);
  if (typeof digestOrError !== 'string') {
    return digestOrError;
  }
  const digest = digestOrError;

  // Retrieve the blob
  const bytes = retrieveArtifact(digest, repoDir);
  if (!bytes) {
    return {
      code: 'artifact_not_found',
      message: `Artifact not found: ${ref}`,
    };
  }

  // Verify content-address integrity: re-hash and compare
  const rehashedDigest = computeDigest(bytes);
  if (rehashedDigest !== digest) {
    return {
      code: 'artifact_integrity_mismatch',
      message: `Integrity check failed for ${ref}: content hash ${rehashedDigest} != ref digest ${digest}`,
    };
  }

  // Try to load sidecar metadata
  let meta: ImageArtifactMetadata | null = null;
  const metaPath = `${resolveArtifactPath(digest, repoDir)}.meta.json`;
  if (existsSync(metaPath)) {
    try {
      const metaJson = readFileSync(metaPath, 'utf-8');
      meta = JSON.parse(metaJson) as ImageArtifactMetadata;
    } catch {
      // Metadata sidecar corrupt or unreadable — proceed with null meta
    }
  }

  return { bytes, meta };
}
