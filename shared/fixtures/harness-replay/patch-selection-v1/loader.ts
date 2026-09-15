/**
 * Loader for patch-selection replay corpus fixtures.
 * Handles manifest loading, split filtering, and validation.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type {
  ReplayPatchSelectionManifest,
  ReplayPatchSelectionInstance,
} from './schema.ts';
import { validateManifest } from './schema.ts';

export interface LoadPatchSelectionCorpusOptions {
  /** Path to the manifest.json file */
  manifestPath: string;
  /** Which instances to load: 'train' (default), 'held-out', or 'all' */
  split?: 'train' | 'held-out' | 'all';
}

export interface LoadPatchSelectionCorpusResult {
  manifest: ReplayPatchSelectionManifest;
  instances: ReplayPatchSelectionInstance[];
  splitInfo: {
    strategy: string;
    totalInstances: number;
    trainInstances: number;
    heldOutInstances: number;
    loadedInstances: number;
    requestedSplit: string;
  };
}

/**
 * Load and filter a patch-selection corpus manifest.
 * Validates the manifest and applies split filtering.
 */
export function loadPatchSelectionCorpus(
  options: LoadPatchSelectionCorpusOptions,
): LoadPatchSelectionCorpusResult {
  const { manifestPath, split = 'train' } = options;

  // Load manifest
  let manifest: ReplayPatchSelectionManifest;
  try {
    const rawContent = readFileSync(resolve(manifestPath), 'utf-8');
    manifest = JSON.parse(rawContent);
  } catch (error) {
    throw new Error(
      `Failed to load patch-selection manifest from ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Validate manifest
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    const errorList = validation.errors.join('; ');
    throw new Error(`Manifest validation failed: ${errorList}`);
  }

  // Count instances by split
  const allInstances = manifest.instances || [];
  const heldOutSet = new Set(manifest.split?.heldOutIds ?? []);
  const trainInstances = allInstances.filter((inst) => !inst.heldOut && !heldOutSet.has(inst.id));
  const heldOutInstances = allInstances.filter((inst) => inst.heldOut || heldOutSet.has(inst.id));

  // Apply split filter
  let instances: ReplayPatchSelectionInstance[] = [];
  switch (split) {
    case 'held-out':
      instances = heldOutInstances;
      break;
    case 'all':
      instances = allInstances;
      break;
    case 'train':
    default:
      instances = trainInstances;
      break;
  }

  return {
    manifest,
    instances,
    splitInfo: {
      strategy: manifest.split?.strategy ?? 'unknown',
      totalInstances: allInstances.length,
      trainInstances: trainInstances.length,
      heldOutInstances: heldOutInstances.length,
      loadedInstances: instances.length,
      requestedSplit: split,
    },
  };
}
