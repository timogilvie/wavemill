/**
 * Feature outcome consumer — read and validate materialized feature-state artifacts.
 *
 * Resolves feature-state.json (HOK-2258 artifact) from a feature directory or
 * archive directory, parses and validates the normalized outcome fields, and
 * returns a structured diagnostic object for use by eval eligibility and
 * Hokusai export paths.
 *
 * Design rules:
 * - Never throws for missing, malformed, invalid, incomplete, or unreadable artifacts.
 * - Does not call deriveFeatureState; reads only what is already on disk.
 * - feature-state.json takes priority over feature-outcome.json (alias).
 * - Both featureDir and archiveDir are tried in order before giving up.
 *
 * @module feature-outcome-consumer
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type {
  FeatureOutcomeDiagnostics,
  FeatureOutcomeDiagnosticReason,
  FeatureOutcomeEligibilityDiagnostic,
  FeatureOutcomeNormalizedFields,
} from './eval-schema.ts';

export type {
  FeatureOutcomeDiagnostics,
  FeatureOutcomeDiagnosticReason,
  FeatureOutcomeEligibilityDiagnostic,
  FeatureOutcomeNormalizedFields,
};

// ────────────────────────────────────────────────────────────────
// Reconstruction shape (local — avoids importing full eval internals)
// ────────────────────────────────────────────────────────────────

export interface FeatureOutcomeReconstruction {
  completed?: boolean;
  merged?: boolean | null;
  ciPassed?: boolean | null;
  reviewPassed?: boolean | null;
  readyPassed?: boolean | null;
  manualIntervention?: boolean | null;
  interventionCount?: number | null;
  reverted?: boolean | null;
  evalScore?: number | null;
  costUsd?: number | null;
  durationSeconds?: number | null;
}

// ────────────────────────────────────────────────────────────────
// Options
// ────────────────────────────────────────────────────────────────

export interface LoadFeatureOutcomeDiagnosticsOptions {
  featureDir?: string;
  archiveDir?: string;
  reconstructed?: FeatureOutcomeReconstruction;
}

// ────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────

const CANDIDATE_FILENAMES = ['feature-state.json', 'feature-outcome.json'] as const;

/** Required fields on the `outcome` object for completeness. */
const REQUIRED_OUTCOME_FIELDS: ReadonlyArray<keyof FeatureOutcomeNormalizedFields> = [
  'completed',
  'merged',
  'ciPassed',
  'reviewPassed',
  'readyPassed',
  'manualIntervention',
  'interventionCount',
  'evalScore',
  'costUsd',
  'durationSeconds',
];

/** Fields that may be null (per FeatureOutcome definition in feature-state.ts). */
const NULLABLE_FIELDS = new Set<string>([
  'merged',
  'ciPassed',
  'reviewPassed',
  'readyPassed',
  'manualIntervention',
  'interventionCount',
  'reverted',
  'evalScore',
  'costUsd',
  'durationSeconds',
]);

function computeHash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveCandidate(
  featureDir: string | undefined,
  archiveDir: string | undefined,
): { filePath: string; raw: Buffer; hash: string } | null {
  // HOK-2891: both feature-state.json and feature-outcome.json share one name
  // across live and archive; probe each candidate per directory in order.
  const dirs = [featureDir, archiveDir].filter(Boolean) as string[];

  for (const dir of dirs) {
    for (const filename of CANDIDATE_FILENAMES) {
      const filePath = path.join(dir, filename);
      if (!existsSync(filePath)) {
        continue;
      }
      try {
        const raw = readFileSync(filePath);
        return { filePath, raw, hash: computeHash(raw) };
      } catch {
        // Unreadable — try next candidate
      }
    }
  }

  return null;
}

function validateNormalizedFields(outcome: Record<string, unknown>): {
  normalizedFields: FeatureOutcomeNormalizedFields;
  missingFields: string[];
  invalidFields: string[];
} {
  const normalizedFields: FeatureOutcomeNormalizedFields = {};
  const missingFields: string[] = [];
  const invalidFields: string[] = [];

  for (const field of REQUIRED_OUTCOME_FIELDS) {
    if (!(field in outcome)) {
      missingFields.push(field);
      continue;
    }

    const value = outcome[field];
    const nullable = NULLABLE_FIELDS.has(field);

    if (field === 'completed') {
      if (typeof value !== 'boolean') {
        invalidFields.push(field);
        continue;
      }
      normalizedFields.completed = value;
    } else if (field === 'interventionCount') {
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
        invalidFields.push(field);
        continue;
      }
      normalizedFields.interventionCount = value as number | null;
    } else if (field === 'evalScore' || field === 'costUsd' || field === 'durationSeconds') {
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
        invalidFields.push(field);
        continue;
      }
      (normalizedFields as Record<string, unknown>)[field] = value;
    } else {
      // Boolean or null fields
      if (value !== null && typeof value !== 'boolean') {
        if (nullable) {
          invalidFields.push(field);
          continue;
        } else {
          invalidFields.push(field);
          continue;
        }
      }
      (normalizedFields as Record<string, unknown>)[field] = value;
    }
  }

  // Include optional `reverted` if present
  if ('reverted' in outcome) {
    const r = outcome['reverted'];
    if (r !== null && typeof r !== 'boolean') {
      invalidFields.push('reverted');
    } else {
      normalizedFields.reverted = r as boolean | null;
    }
  }

  return { normalizedFields, missingFields, invalidFields };
}

function computeEligibilityDiagnostic(
  present: boolean,
  reason: FeatureOutcomeDiagnosticReason,
  missingFields: string[],
  invalidFields: string[],
  normalizedFields: FeatureOutcomeNormalizedFields,
): FeatureOutcomeEligibilityDiagnostic {
  if (!present) {
    return 'unknown';
  }

  // Structurally invalid artifacts: can't determine eligibility at all
  if (reason === 'malformed_json' || reason === 'invalid_root' || reason === 'invalid_outcome') {
    return 'unknown';
  }

  // Artifact is structurally valid but missing required outcome fields
  if (missingFields.length > 0 || invalidFields.length > 0) {
    return 'ineligible_missing_outcome';
  }

  // Determine if the outcome indicates failure
  // A completed=false is a clear failure signal
  if (normalizedFields.completed === false) {
    return 'ineligible_failed_outcome';
  }

  return 'eligible';
}

function computeConflicts(
  normalizedFields: FeatureOutcomeNormalizedFields,
  reconstructed: FeatureOutcomeReconstruction,
): { conflictsWithReconstruction: boolean; conflictingFields: string[] } {
  const conflictingFields: string[] = [];

  const fieldPairs: Array<[keyof FeatureOutcomeNormalizedFields, unknown]> = [
    ['completed', reconstructed.completed],
    ['merged', reconstructed.merged],
    ['ciPassed', reconstructed.ciPassed],
    ['reviewPassed', reconstructed.reviewPassed],
    ['readyPassed', reconstructed.readyPassed],
    ['manualIntervention', reconstructed.manualIntervention],
    ['interventionCount', reconstructed.interventionCount],
    ['reverted', reconstructed.reverted],
    ['evalScore', reconstructed.evalScore],
    ['costUsd', reconstructed.costUsd],
    ['durationSeconds', reconstructed.durationSeconds],
  ];

  for (const [field, reconstructedValue] of fieldPairs) {
    const artifactValue = normalizedFields[field];

    // Only compare when both sides have a defined, non-null value
    if (
      artifactValue === undefined
      || artifactValue === null
      || reconstructedValue === undefined
      || reconstructedValue === null
    ) {
      continue;
    }

    // For numbers, allow small floating-point tolerances (e.g. rounding differences)
    if (typeof artifactValue === 'number' && typeof reconstructedValue === 'number') {
      if (Math.abs(artifactValue - reconstructedValue) > 0.001) {
        conflictingFields.push(field);
      }
      continue;
    }

    if (artifactValue !== reconstructedValue) {
      conflictingFields.push(field);
    }
  }

  return {
    conflictsWithReconstruction: conflictingFields.length > 0,
    conflictingFields,
  };
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Load and validate a feature outcome artifact from disk.
 *
 * Resolution order:
 * 1. `<featureDir>/feature-state.json`
 * 2. `<featureDir>/feature-outcome.json`
 * 3. `<archiveDir>/feature-state.json`
 * 4. `<archiveDir>/feature-outcome.json`
 *
 * Returns a structured diagnostic. Never throws.
 */
export function loadFeatureOutcomeDiagnostics(
  options: LoadFeatureOutcomeDiagnosticsOptions,
): FeatureOutcomeDiagnostics {
  const { featureDir, archiveDir, reconstructed } = options;

  // 1. Resolve candidate file
  const candidate = resolveCandidate(featureDir, archiveDir);

  if (!candidate) {
    return {
      present: false,
      valid: false,
      used: false,
      reason: 'artifact_absent' as FeatureOutcomeDiagnosticReason,
      eligibilityDiagnostic: 'unknown' as FeatureOutcomeEligibilityDiagnostic,
    };
  }

  const { filePath, raw, hash } = candidate;
  const sourceFile = path.basename(filePath);

  // 2. Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf-8'));
  } catch {
    return {
      present: true,
      valid: false,
      used: false,
      sourceFile,
      sourceHash: hash,
      reason: 'malformed_json' as FeatureOutcomeDiagnosticReason,
      eligibilityDiagnostic: 'unknown' as FeatureOutcomeEligibilityDiagnostic,
    };
  }

  // 3. Validate root object
  if (!isPlainObject(parsed)) {
    return {
      present: true,
      valid: false,
      used: false,
      sourceFile,
      sourceHash: hash,
      reason: 'invalid_root' as FeatureOutcomeDiagnosticReason,
      eligibilityDiagnostic: 'unknown' as FeatureOutcomeEligibilityDiagnostic,
    };
  }

  const root = parsed;
  const schemaVersion = typeof root['schemaVersion'] === 'string'
    ? root['schemaVersion']
    : undefined;

  // 4. Validate outcome object
  if (!isPlainObject(root['outcome'])) {
    return {
      present: true,
      valid: false,
      used: false,
      sourceFile,
      sourceHash: hash,
      schemaVersion,
      reason: 'invalid_outcome' as FeatureOutcomeDiagnosticReason,
      eligibilityDiagnostic: 'unknown' as FeatureOutcomeEligibilityDiagnostic,
    };
  }

  const outcome = root['outcome'] as Record<string, unknown>;

  // 5. Validate normalized fields
  const { normalizedFields, missingFields, invalidFields } = validateNormalizedFields(outcome);

  const isComplete = missingFields.length === 0 && invalidFields.length === 0;
  const reason: FeatureOutcomeDiagnosticReason = isComplete ? 'loaded' : 'incomplete_outcome';
  const valid = isComplete;

  // 6. Compute eligibility diagnostic
  const eligibilityDiagnostic = computeEligibilityDiagnostic(
    true,
    reason,
    missingFields,
    invalidFields,
    normalizedFields,
  );

  // 7. Compute conflicts with reconstruction
  let conflictsWithReconstruction: boolean | undefined;
  let conflictingFields: string[] | undefined;

  if (reconstructed) {
    const conflicts = computeConflicts(normalizedFields, reconstructed);
    if (conflicts.conflictsWithReconstruction) {
      conflictsWithReconstruction = true;
      conflictingFields = conflicts.conflictingFields;
    }
  }

  const diagnostics: FeatureOutcomeDiagnostics = {
    present: true,
    valid,
    used: valid,
    sourceFile,
    sourceHash: hash,
    schemaVersion,
    reason,
    normalizedFields,
    eligibilityDiagnostic,
  };

  if (missingFields.length > 0) {
    diagnostics.missingFields = missingFields;
  }
  if (invalidFields.length > 0) {
    diagnostics.invalidFields = invalidFields;
  }
  if (conflictsWithReconstruction !== undefined) {
    diagnostics.conflictsWithReconstruction = conflictsWithReconstruction;
  }
  if (conflictingFields !== undefined && conflictingFields.length > 0) {
    diagnostics.conflictingFields = conflictingFields;
  }

  return diagnostics;
}
