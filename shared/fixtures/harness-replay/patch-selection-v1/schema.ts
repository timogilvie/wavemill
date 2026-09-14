/**
 * Patch Selection Replay Corpus Schema
 *
 * This schema defines the structure for ground-truth patch-selection instances
 * used in Phase 2 and 3 of the Hokusai Arbiter program. Each instance pairs
 * a task with multiple candidate patches (including known-good and known-bad)
 * to measure whether a selection strategy picks the known-good patch.
 *
 * @see https://linear.app/hokusai/document/hokusai-arbiter-plan-of-record-90de5fa36b75
 */

/**
 * Source provenance for a patch-selection instance.
 * Tracks where the instance came from and how it was curated.
 */
export interface ReplayPatchSelectionSource {
  /** Challenge pair id if sourced from challenge/swap-test */
  challengePairId?: string;
  /** Incident fingerprint if sourced from .wavemill/incidents */
  incidentFingerprint?: string;
  /** PR number and repo if sourced from public fix */
  prUrl?: string;
  prSha?: string;
  /** Curation rationale: "merged_winner", "incident_fix", "eval_implied", "survival_confirmed" */
  curationRationale: string;
  /** Whether task/diffs have been sanitized for privacy */
  sanitized: boolean;
}

/**
 * A single candidate patch for selection.
 */
export interface ReplayPatchCandidate {
  /** Stable identifier for this candidate within the instance */
  id: string;
  /** Patch content (inline) or reference to a patch file */
  patch: string;
  /** Optional SHA256 hash of the patch for integrity checking */
  patchHash?: string;
  /** Patch size in bytes */
  patchSizeBytes: number;
  /** Brief label (e.g., "known-good", "known-bad", "candidate-1") */
  label?: string;
}

/**
 * A single patch-selection replay instance with ground truth.
 */
export interface ReplayPatchSelectionInstance {
  /** Stable, unique identifier for this instance */
  id: string;
  /** Brief task title for human reference */
  taskTitle: string;
  /** Sanitized task description or task packet summary */
  taskDescription: string;
  /** Base commit SHA where the task was originally encountered (if available) */
  baseSha?: string;
  /** Candidate patches available for selection */
  candidates: ReplayPatchCandidate[];
  /** ID of the candidate that is known-good (must exist in candidates) */
  knownGoodCandidateId: string;
  /** IDs of candidates known to be bad/incorrect (may be empty) */
  knownBadCandidateIds: string[];
  /** Source and curation metadata */
  source: ReplayPatchSelectionSource;
  /** Whether this instance is part of the held-out evaluation set */
  heldOut: boolean;
  /** Unix timestamp of fixture creation or last curation */
  curatedAt: number;
  /** Notes on this instance (e.g., edge case description) */
  notes?: string;
}

/**
 * Held-out set definition for train/eval split.
 */
export interface ReplayPatchSelectionSplit {
  /** Instance IDs in the held-out set */
  heldOutIds: string[];
  /** Split strategy used (e.g., "hash_deterministic_20pct") */
  strategy: string;
}

/**
 * Manifest for the patch-selection corpus.
 */
export interface ReplayPatchSelectionManifest {
  /** Schema version for forward compatibility */
  schemaVersion: "1.0";
  /** All patch-selection instances in this corpus */
  instances: ReplayPatchSelectionInstance[];
  /** Held-out evaluation split */
  split: ReplayPatchSelectionSplit;
  /** Timestamp of manifest creation */
  createdAt: number;
  /** Timestamp of last modification */
  updatedAt: number;
}

/**
 * Validation result for manifest or instance checks.
 */
export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** List of error messages if invalid */
  errors: string[];
  /** Diagnostic info (counts, warnings, etc.) */
  diagnostics: Record<string, unknown>;
}

/**
 * Validate a patch-selection instance.
 * Checks for required fields, referential integrity, and constraints.
 */
export function validateInstance(instance: ReplayPatchSelectionInstance): ValidationResult {
  const errors: string[] = [];
  const diagnostics: Record<string, unknown> = {};

  // Check required fields
  if (!instance.id || typeof instance.id !== "string") {
    errors.push(`Instance missing or invalid id`);
  }

  if (!instance.taskTitle || typeof instance.taskTitle !== "string") {
    errors.push(`Instance ${instance.id}: invalid taskTitle`);
  }

  if (!instance.taskDescription || typeof instance.taskDescription !== "string") {
    errors.push(`Instance ${instance.id}: invalid taskDescription`);
  }

  if (!Array.isArray(instance.candidates) || instance.candidates.length < 2) {
    errors.push(`Instance ${instance.id}: must have at least 2 candidates`);
  }

  if (!instance.knownGoodCandidateId || typeof instance.knownGoodCandidateId !== "string") {
    errors.push(`Instance ${instance.id}: missing or invalid knownGoodCandidateId`);
  }

  if (!instance.source || !instance.source.curationRationale) {
    errors.push(`Instance ${instance.id}: missing source or curationRationale`);
  }

  // Check candidate integrity
  const candidateIds = new Set<string>();
  for (const candidate of instance.candidates || []) {
    if (!candidate.id || typeof candidate.id !== "string") {
      errors.push(`Instance ${instance.id}: candidate with invalid id`);
    } else {
      if (candidateIds.has(candidate.id)) {
        errors.push(`Instance ${instance.id}: duplicate candidate id "${candidate.id}"`);
      }
      candidateIds.add(candidate.id);
    }

    if (!candidate.patch || typeof candidate.patch !== "string") {
      errors.push(`Instance ${instance.id}: candidate ${candidate.id} has invalid patch`);
    }

    if (typeof candidate.patchSizeBytes !== "number" || candidate.patchSizeBytes <= 0) {
      errors.push(`Instance ${instance.id}: candidate ${candidate.id} has invalid patchSizeBytes`);
    }
  }

  // Check known-good exists in candidates
  if (instance.knownGoodCandidateId && !candidateIds.has(instance.knownGoodCandidateId)) {
    errors.push(
      `Instance ${instance.id}: knownGoodCandidateId "${instance.knownGoodCandidateId}" not found in candidates`
    );
  }

  // Check known-good not in known-bad
  if (
    instance.knownBadCandidateIds &&
    instance.knownBadCandidateIds.includes(instance.knownGoodCandidateId)
  ) {
    errors.push(
      `Instance ${instance.id}: knownGoodCandidateId cannot be in knownBadCandidateIds`
    );
  }

  // Check all known-bad ids exist
  for (const badId of instance.knownBadCandidateIds || []) {
    if (!candidateIds.has(badId)) {
      errors.push(`Instance ${instance.id}: knownBadCandidateId "${badId}" not found in candidates`);
    }
  }

  diagnostics.candidateCount = candidateIds.size;
  diagnostics.knownBadCount = instance.knownBadCandidateIds?.length ?? 0;

  return {
    valid: errors.length === 0,
    errors,
    diagnostics,
  };
}

/**
 * Validate an entire manifest.
 * Checks instance validity, uniqueness, and split integrity.
 */
export function validateManifest(manifest: ReplayPatchSelectionManifest): ValidationResult {
  const errors: string[] = [];
  const diagnostics: Record<string, unknown> = {
    totalInstances: 0,
    validInstances: 0,
    invalidInstances: 0,
    duplicateIds: 0,
    heldOutCount: 0,
    missingHeldOutIds: [] as string[],
  };

  if (!manifest.instances || !Array.isArray(manifest.instances)) {
    return {
      valid: false,
      errors: ["Manifest missing or invalid instances array"],
      diagnostics,
    };
  }

  const seenIds = new Set<string>();
  const instanceIds = new Set<string>();

  for (const instance of manifest.instances) {
    diagnostics.totalInstances = (diagnostics.totalInstances as number) + 1;

    // Check for duplicate ids
    if (seenIds.has(instance.id)) {
      errors.push(`Duplicate instance id: "${instance.id}"`);
      (diagnostics.duplicateIds as number)++;
    }
    seenIds.add(instance.id);
    instanceIds.add(instance.id);

    // Validate each instance
    const result = validateInstance(instance);
    if (result.valid) {
      (diagnostics.validInstances as number)++;
    } else {
      (diagnostics.invalidInstances as number)++;
      errors.push(...result.errors);
    }

    if (instance.heldOut) {
      (diagnostics.heldOutCount as number)++;
    }
  }

  // Check held-out split integrity
  if (manifest.split && manifest.split.heldOutIds) {
    for (const heldOutId of manifest.split.heldOutIds) {
      if (!instanceIds.has(heldOutId)) {
        (diagnostics.missingHeldOutIds as string[]).push(heldOutId);
        errors.push(`Held-out id not found in instances: "${heldOutId}"`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    diagnostics,
  };
}
