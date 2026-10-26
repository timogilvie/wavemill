import { normalizePatchPath } from './patch-contract.ts';
import {
  validateSeamArtifactContent,
  validateSeamSubschemaValue,
  type SeamValidationError,
} from '../seam-artifacts.ts';
import type { StageExecutionUsage } from '../stage-result.ts';

export type CodingCompleteConfidence = 'high' | 'medium' | 'low';

export interface CodingComplete {
  stage: 'coding';
  confidence: CodingCompleteConfidence;
  commit?: string;
  notes?: string;
  source?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface CodingArtifacts {
  type: 'coding';
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  commitCount: number;
  /** Native coding loop usage, including prompt-cache fields (HOK-3260). */
  usage?: StageExecutionUsage;
  [futureField: string]: unknown;
}

/**
 * Whole-file write allowlist inputs are kept separate from mutation policy so
 * later enforcement can distinguish generated output from Wavemill-owned files.
 */
export interface WholeFileWriteAllowlistInput {
  generatedPaths?: string[];
  wavemillOwnedPaths?: string[];
}

export interface NormalizedWholeFileWriteAllowlistInput {
  generatedPaths: string[];
  wavemillOwnedPaths: string[];
}

export type CodingArtifactsValidationError = SeamValidationError;

export interface WholeFileAllowlistValidationError {
  code: 'invalid_allowlist';
  path: string;
  message: string;
}

export type ValidateCodingArtifactsResult =
  | { ok: true; value: CodingArtifacts }
  | { ok: false; errors: CodingArtifactsValidationError[] };

export type ParseCodingCompleteResult =
  | { ok: true; value: CodingComplete }
  | { ok: false; errors: CodingArtifactsValidationError[] };

export type ValidateWholeFileWriteAllowlistResult =
  | { ok: true; value: NormalizedWholeFileWriteAllowlistInput }
  | { ok: false; errors: WholeFileAllowlistValidationError[] };

const CODING_COMPLETE_CONFIDENCE_VALUES: readonly CodingCompleteConfidence[] = ['high', 'medium', 'low'] as const;

export function isCodingCompleteConfidence(value: string): value is CodingCompleteConfidence {
  return (CODING_COMPLETE_CONFIDENCE_VALUES as readonly string[]).includes(value);
}

export function parseCodingComplete(input: string): ParseCodingCompleteResult {
  const result = validateSeamArtifactContent<CodingComplete>('coding-complete', input);
  return result.ok ? { ok: true, value: result.value } : { ok: false, errors: result.errors };
}

export function serializeCodingComplete(input: CodingComplete): string {
  return `${JSON.stringify(input, null, 2)}\n`;
}

export function validateCodingArtifacts(input: unknown): ValidateCodingArtifactsResult {
  return validateSeamSubschemaValue<CodingArtifacts>(
    'stage-result.schema.json',
    '/$defs/codingArtifacts',
    input,
  );
}

export function validateWholeFileWriteAllowlistInput(
  input: unknown,
): ValidateWholeFileWriteAllowlistResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [{ code: 'invalid_allowlist', path: '$', message: 'Whole-file allowlist input must be an object.' }],
    };
  }

  const errors: WholeFileAllowlistValidationError[] = [];
  const generatedPaths = validateAllowlistPaths(input.generatedPaths, '$.generatedPaths', errors);
  const wavemillOwnedPaths = validateAllowlistPaths(input.wavemillOwnedPaths, '$.wavemillOwnedPaths', errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      generatedPaths,
      wavemillOwnedPaths,
    },
  };
}

function validateAllowlistPaths(
  input: unknown,
  pathKey: string,
  errors: WholeFileAllowlistValidationError[],
): string[] {
  if (input === undefined) {
    return [];
  }

  if (!Array.isArray(input)) {
    errors.push({
      code: 'invalid_allowlist',
      path: pathKey,
      message: `${pathKey} must be an array of repo-relative POSIX paths when provided.`,
    });
    return [];
  }

  const normalizedPaths: string[] = [];
  for (const [index, value] of input.entries()) {
    if (typeof value !== 'string') {
      errors.push({
        code: 'invalid_allowlist',
        path: `${pathKey}[${index}]`,
        message: `${pathKey}[${index}] must be a string.`,
      });
      continue;
    }

    const normalized = normalizePatchPath(value);
    if (!normalized) {
      errors.push({
        code: 'invalid_allowlist',
        path: `${pathKey}[${index}]`,
        message: `${pathKey}[${index}] must be a repo-relative POSIX path without traversal.`,
      });
      continue;
    }

    normalizedPaths.push(normalized);
  }

  return normalizedPaths;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
