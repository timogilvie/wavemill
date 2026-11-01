import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateBudgetExhaustedFact, type BudgetExhaustedFact } from './budget-exhaustion.ts';

export const CODING_FAILURE_HANDOFF_SCHEMA_VERSION = '1.0';
export const CODING_FAILURE_HANDOFF_FILENAME = '.coding-failure-handoff.json';
export const CODING_FAILURE_HANDOFF_STAGE = 'coding';
/**
 * `budget_exhausted` (HOK-3362) replaces `provider_error` and
 * `no_completion_artifact` when the run stopped on a budget reason; those two
 * remain for non-budget stops.
 */
export const CODING_FAILURE_HANDOFF_REASONS = [
  'no_completion_artifact',
  'invalid_completion_artifact',
  'provider_error',
  'budget_exhausted',
] as const;
export type CodingFailureHandoffReason = (typeof CODING_FAILURE_HANDOFF_REASONS)[number];

export interface CodingFailureToolError {
  tool: string;
  error: string;
  message: string;
  retryHint?: string;
  diagnostics?: unknown;
}

export interface CodingFailureValidationError {
  code: string;
  field?: string;
  message: string;
}

export interface CodingFailureHandoff {
  stage: typeof CODING_FAILURE_HANDOFF_STAGE;
  reason: CodingFailureHandoffReason;
  stopReason: string;
  mutationFailures: number;
  lastToolError: CodingFailureToolError | null;
  recoveryAttempted: boolean;
  suggestedAction: string;
  createdAt: string;
  schemaVersion: typeof CODING_FAILURE_HANDOFF_SCHEMA_VERSION;
  validationErrors?: CodingFailureValidationError[];
  quarantinedArtifacts?: string[];
  providerError?: {
    kind: string;
    errorMessage: string;
    turnsCompleted: number;
    toolCallsExecuted: number;
    attempts: number;
    transcriptPath?: string;
  };
  /** Required for `budget_exhausted` (HOK-3362). */
  budgetExhausted?: BudgetExhaustedFact;
}

export type CodingFailureHandoffValidationResult =
  | { ok: true; value: CodingFailureHandoff }
  | { ok: false; code: 'MALFORMED_JSON' | 'MISSING_REQUIRED_FIELD' | 'INVALID_FIELD_TYPE' | 'INVALID_ENUM_VALUE'; field?: string; message: string };

const REQUIRED_FIELDS = [
  'stage',
  'reason',
  'stopReason',
  'mutationFailures',
  'lastToolError',
  'recoveryAttempted',
  'suggestedAction',
  'createdAt',
  'schemaVersion',
] as const;

export function getCodingFailureHandoffPath(featureDir: string): string {
  return path.join(featureDir, CODING_FAILURE_HANDOFF_FILENAME);
}

export function writeCodingFailureHandoff(
  featureDir: string,
  handoff: CodingFailureHandoff,
): void {
  const filePath = getCodingFailureHandoffPath(featureDir);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(handoff, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, filePath);
}

export function validateCodingFailureHandoff(
  value: unknown,
): CodingFailureHandoffValidationResult {
  if (!isRecord(value)) {
    return error('INVALID_FIELD_TYPE', 'Coding failure handoff must be a JSON object.', 'artifact');
  }

  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field) || value[field] === undefined) {
      return error('MISSING_REQUIRED_FIELD', `Coding failure handoff is missing required field "${field}".`, field);
    }
  }

  if (value.stage !== CODING_FAILURE_HANDOFF_STAGE) {
    return error('INVALID_ENUM_VALUE', `Coding failure handoff stage must be "${CODING_FAILURE_HANDOFF_STAGE}".`, 'stage');
  }
  if (typeof value.reason !== 'string' || !isCodingFailureHandoffReason(value.reason)) {
    return error('INVALID_ENUM_VALUE', `Coding failure handoff reason must be one of: ${CODING_FAILURE_HANDOFF_REASONS.map((reason) => `"${reason}"`).join(', ')}.`, 'reason');
  }
  if (value.schemaVersion !== CODING_FAILURE_HANDOFF_SCHEMA_VERSION) {
    return error('INVALID_ENUM_VALUE', `Coding failure handoff schemaVersion must be "${CODING_FAILURE_HANDOFF_SCHEMA_VERSION}".`, 'schemaVersion');
  }
  if (typeof value.stopReason !== 'string') {
    return error('INVALID_FIELD_TYPE', 'Coding failure handoff stopReason must be a string.', 'stopReason');
  }
  if (typeof value.mutationFailures !== 'number' || !Number.isInteger(value.mutationFailures) || value.mutationFailures < 0) {
    return error('INVALID_FIELD_TYPE', 'Coding failure handoff mutationFailures must be a non-negative integer.', 'mutationFailures');
  }
  if (typeof value.recoveryAttempted !== 'boolean') {
    return error('INVALID_FIELD_TYPE', 'Coding failure handoff recoveryAttempted must be a boolean.', 'recoveryAttempted');
  }
  if (typeof value.suggestedAction !== 'string') {
    return error('INVALID_FIELD_TYPE', 'Coding failure handoff suggestedAction must be a string.', 'suggestedAction');
  }
  if (typeof value.createdAt !== 'string') {
    return error('INVALID_FIELD_TYPE', 'Coding failure handoff createdAt must be a string.', 'createdAt');
  }
  if (value.lastToolError !== null) {
    const toolError = validateToolError(value.lastToolError);
    if (!toolError.ok) {
      return toolError;
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, 'validationErrors') && value.validationErrors !== undefined) {
    const validationErrors = validateValidationErrors(value.validationErrors);
    if (!validationErrors.ok) {
      return validationErrors;
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, 'quarantinedArtifacts') && value.quarantinedArtifacts !== undefined) {
    if (!Array.isArray(value.quarantinedArtifacts) || !value.quarantinedArtifacts.every((artifact) => typeof artifact === 'string')) {
      return error('INVALID_FIELD_TYPE', 'Coding failure handoff quarantinedArtifacts must be an array of strings when present.', 'quarantinedArtifacts');
    }
  }
  if (
    value.reason === 'invalid_completion_artifact'
    && (!Array.isArray(value.validationErrors) || value.validationErrors.length === 0)
  ) {
    return error('MISSING_REQUIRED_FIELD', 'Coding failure handoff validationErrors must be present for invalid_completion_artifact.', 'validationErrors');
  }
  if (value.reason === 'provider_error') {
    const providerError = validateProviderError(value.providerError);
    if (!providerError.ok) {
      return providerError;
    }
  }
  if (value.reason === 'budget_exhausted' || value.budgetExhausted !== undefined) {
    if (value.budgetExhausted === undefined) {
      return error('MISSING_REQUIRED_FIELD', 'Coding failure handoff budgetExhausted must be present for budget_exhausted.', 'budgetExhausted');
    }
    const fact = validateBudgetExhaustedFact(value.budgetExhausted);
    if (fact.ok === false) {
      return error('INVALID_FIELD_TYPE', `Coding failure handoff ${fact.message}`, fact.field);
    }
  }

  return { ok: true, value: value as CodingFailureHandoff };
}

export async function readCodingFailureHandoff(
  filePath: string,
): Promise<CodingFailureHandoffValidationResult> {
  const content = await readFile(filePath, 'utf-8');
  try {
    return validateCodingFailureHandoff(JSON.parse(content));
  } catch {
    return error('MALFORMED_JSON', `Coding failure handoff at ${filePath} contains malformed JSON.`);
  }
}

function validateToolError(value: unknown): CodingFailureHandoffValidationResult {
  if (!isRecord(value)) {
    return error('INVALID_FIELD_TYPE', 'Coding failure handoff lastToolError must be null or an object.', 'lastToolError');
  }
  for (const field of ['tool', 'error', 'message'] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      return error('INVALID_FIELD_TYPE', `Coding failure handoff lastToolError.${field} must be a non-empty string.`, `lastToolError.${field}`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, 'retryHint') && value.retryHint !== undefined && typeof value.retryHint !== 'string') {
    return error('INVALID_FIELD_TYPE', 'Coding failure handoff lastToolError.retryHint must be a string when present.', 'lastToolError.retryHint');
  }
  return { ok: true, value: undefined as unknown as CodingFailureHandoff };
}

function validateValidationErrors(value: unknown): CodingFailureHandoffValidationResult {
  if (!Array.isArray(value)) {
    return error('INVALID_FIELD_TYPE', 'Coding failure handoff validationErrors must be an array when present.', 'validationErrors');
  }
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      return error('INVALID_FIELD_TYPE', 'Coding failure handoff validationErrors entries must be objects.', `validationErrors.${index}`);
    }
    for (const field of ['code', 'message'] as const) {
      if (typeof item[field] !== 'string' || item[field].length === 0) {
        return error('INVALID_FIELD_TYPE', `Coding failure handoff validationErrors.${index}.${field} must be a non-empty string.`, `validationErrors.${index}.${field}`);
      }
    }
    if (Object.prototype.hasOwnProperty.call(item, 'field') && item.field !== undefined && typeof item.field !== 'string') {
      return error('INVALID_FIELD_TYPE', `Coding failure handoff validationErrors.${index}.field must be a string when present.`, `validationErrors.${index}.field`);
    }
  }
  return { ok: true, value: undefined as unknown as CodingFailureHandoff };
}

function validateProviderError(value: unknown): CodingFailureHandoffValidationResult {
  if (!isRecord(value)) {
    return error('MISSING_REQUIRED_FIELD', 'Coding failure handoff providerError must be present for provider_error.', 'providerError');
  }
  for (const field of ['kind', 'errorMessage'] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      return error('INVALID_FIELD_TYPE', `Coding failure handoff providerError.${field} must be a non-empty string.`, `providerError.${field}`);
    }
  }
  for (const field of ['turnsCompleted', 'toolCallsExecuted', 'attempts'] as const) {
    if (typeof value[field] !== 'number' || !Number.isInteger(value[field]) || value[field] < 0) {
      return error('INVALID_FIELD_TYPE', `Coding failure handoff providerError.${field} must be a non-negative integer.`, `providerError.${field}`);
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(value, 'transcriptPath')
    && value.transcriptPath !== undefined
    && typeof value.transcriptPath !== 'string'
  ) {
    return error('INVALID_FIELD_TYPE', 'Coding failure handoff providerError.transcriptPath must be a string when present.', 'providerError.transcriptPath');
  }
  return { ok: true, value: undefined as unknown as CodingFailureHandoff };
}

function isCodingFailureHandoffReason(value: string): value is CodingFailureHandoffReason {
  return CODING_FAILURE_HANDOFF_REASONS.includes(value as CodingFailureHandoffReason);
}

function error(
  code: Exclude<CodingFailureHandoffValidationResult, { ok: true }>['code'],
  message: string,
  field?: string,
): Exclude<CodingFailureHandoffValidationResult, { ok: true }> {
  return field === undefined ? { ok: false, code, message } : { ok: false, code, message, field };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
