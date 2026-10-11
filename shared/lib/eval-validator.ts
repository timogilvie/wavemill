import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { BUDGET_MISSING, SCHEMA_VERSION, type EvalRecord } from './eval-schema.ts';
import { resolveEvalsDir } from './evals-paths.ts';
import { getEffectiveRegistry, normalizeReviewerModelId } from './model-registry.ts';
import {
  EVAL_ERROR_CODES,
  EVAL_ERROR_SEVERITY_ORDER,
  type EvalErrorCode,
} from './eval-error-codes.ts';
import {
  compileSchemaValidator,
  EVAL_RECORD_AJV_OPTIONS,
  loadPrecompiledValidator,
  type SchemaValidatorFunction,
} from './schema-validators.ts';

const require = createRequire(import.meta.url);

let evalSchemaValidator: SchemaValidatorFunction | null = null;

/**
 * Eval record schema validator, resolved on first use (HOK-3205): the
 * committed standalone artifact when it matches eval-schema.json, otherwise a
 * runtime compile. Importing this module no longer pays the ~375 ms compile.
 */
function getEvalSchemaValidator(): SchemaValidatorFunction {
  if (!evalSchemaValidator) {
    const schemaPath = require.resolve('./eval-schema.json');
    const schemaText = readFileSync(schemaPath, 'utf-8');
    evalSchemaValidator =
      loadPrecompiledValidator('eval-record', schemaText, EVAL_RECORD_AJV_OPTIONS, 'ajv/dist/2020') ??
      compileSchemaValidator(JSON.parse(schemaText), EVAL_RECORD_AJV_OPTIONS, 'ajv/dist/2020');
  }
  return evalSchemaValidator;
}

export { BUDGET_MISSING };

const REQUIRED_FIELDS = [
  'id',
  'schemaVersion',
  'originalPrompt',
  'modelId',
  'modelVersion',
  'score',
  'scoreBand',
  'timeSeconds',
  'timestamp',
  'interventionRequired',
  'interventionCount',
  'interventionDetails',
  'rationale',
] as const;

const TRAINING_REQUIRED_FIELDS = ['modelId', 'modelVersion', 'timestamp'] as const;

export interface ValidationIssue {
  code: EvalErrorCode;
  detail?: string;
  value?: string;
  file: string;
  line: number;
  recordId?: string;
  message: string;
}

export interface ValidationReport {
  totalLines: number;
  validRecords: number;
  issues: ValidationIssue[];
  countsByCode: Record<string, number>;
  files: string[];
}

export interface VerificationTelemetryDiagnostic {
  field: string;
  message: string;
  severity: 'warning' | 'error';
}

interface ValidationLocation {
  file: string;
  line: number;
  repoDir?: string;
}

function makeIssue(
  code: EvalErrorCode,
  location: ValidationLocation,
  detail?: string,
  recordId?: string,
): ValidationIssue {
  return {
    code,
    detail,
    file: location.file,
    line: location.line,
    ...(recordId ? { recordId } : {}),
    message: EVAL_ERROR_CODES[code].message,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRecordId(record: Record<string, unknown>): string | undefined {
  return typeof record.id === 'string' && record.id.trim().length > 0
    ? record.id
    : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function compareSemver(a: string, b: string): number {
  const aParts = a.split('.').map(Number);
  const bParts = b.split('.').map(Number);
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const delta = (aParts[index] || 0) - (bParts[index] || 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

function toDetail(
  instancePath: string,
  missingProperty?: string,
  additionalProperty?: string,
): string | undefined {
  if (missingProperty) {
    return missingProperty;
  }

  if (additionalProperty) {
    const prefix = instancePath.replace(/^\//, '').replace(/\//g, '.');
    return prefix ? `${prefix}.${additionalProperty}` : additionalProperty;
  }

  const cleaned = instancePath.replace(/^\//, '').replace(/\//g, '.');
  return cleaned || undefined;
}

function isKnownSchemaVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
}

function buildCounts(issues: ValidationIssue[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const issue of issues) {
    counts[issue.code] = (counts[issue.code] || 0) + 1;
  }
  return counts;
}

function getTaskDescriptor(record: Record<string, unknown>): Record<string, unknown> | null {
  return isPlainObject(record.taskDescriptor) ? record.taskDescriptor : null;
}

function hasMissingTaskDescriptor(record: Record<string, unknown>): boolean {
  if (!Object.hasOwn(record, 'taskDescriptor')) {
    return true;
  }

  const descriptor = record.taskDescriptor;
  if (descriptor === null || descriptor === undefined) {
    return true;
  }

  if (typeof descriptor === 'string') {
    return descriptor.trim().length === 0;
  }

  return !isPlainObject(descriptor);
}

function getModelsAvailable(taskDescriptor: Record<string, unknown> | null): unknown {
  if (!taskDescriptor) {
    return undefined;
  }

  const constraints = taskDescriptor.constraints;
  return isPlainObject(constraints) ? constraints.models_available : undefined;
}

function collectStageModelIssues(
  record: Record<string, unknown>,
  opts: ValidationLocation,
  recordId?: string,
): ValidationIssue[] {
  const taskDescriptor = getTaskDescriptor(record);
  if (!taskDescriptor) {
    return [];
  }

  const stages = taskDescriptor.stages;
  if (!isPlainObject(stages)) {
    return [];
  }

  const registry = getEffectiveRegistry(opts.repoDir);
  const issues: ValidationIssue[] = [];

  for (const [stageName, stageValue] of Object.entries(stages)) {
    if (!isPlainObject(stageValue) || typeof stageValue.model !== 'string') {
      continue;
    }

    const modelId = stageValue.model.trim();
    if (!modelId) {
      continue;
    }

    if (stageName === 'reviewer') {
      if (normalizeReviewerModelId(modelId, registry) === null) {
        issues.push(
          makeIssue(
            'EVAL_NONCANONICAL_REVIEWER',
            opts,
            `taskDescriptor.stages.${stageName}.model`,
            recordId,
          ),
        );
      }
      continue;
    }

    if (!Object.hasOwn(registry.models, modelId)) {
      issues.push(
        makeIssue(
          'EVAL_UNKNOWN_STAGE_MODEL',
          opts,
          `taskDescriptor.stages.${stageName}.model`,
          recordId,
        ),
      );
    }
  }

  return issues;
}

export function validateVerificationTelemetry(
  record: Pick<EvalRecord, 'verificationTelemetry'>,
): VerificationTelemetryDiagnostic[] {
  const diagnostics: VerificationTelemetryDiagnostic[] = [];
  const telemetry = record.verificationTelemetry;

  if (!telemetry) {
    return diagnostics;
  }

  if (telemetry.schema_version && telemetry.schema_version !== '1.0') {
    diagnostics.push({
      field: 'verificationTelemetry.schema_version',
      message: `Invalid schema version: ${telemetry.schema_version}`,
      severity: 'error',
    });
  }

  if (
    telemetry.local_verification?.passed === false
    && !telemetry.local_verification.first_failure_category
  ) {
    diagnostics.push({
      field: 'verificationTelemetry.local_verification',
      message: 'Failed verification should include failure category.',
      severity: 'warning',
    });
  }

  return diagnostics;
}

export function validateEvalRecord(
  record: unknown,
  opts: ValidationLocation,
): ValidationIssue[] {
  if (!isPlainObject(record)) {
    return [makeIssue('NOT_AN_OBJECT', opts)];
  }

  const issues: ValidationIssue[] = [];
  const recordId = getRecordId(record);
  const taskDescriptor = getTaskDescriptor(record);

  for (const field of REQUIRED_FIELDS) {
    if (!(field in record)) {
      issues.push(makeIssue('MISSING_REQUIRED_FIELD', opts, field, recordId));
    }
  }

  const validateSchema = getEvalSchemaValidator();
  if (!validateSchema(record)) {
    for (const error of validateSchema.errors || []) {
      if (error.keyword === 'required') {
        continue;
      }
      const detail = toDetail(
        error.instancePath || '',
        typeof error.params?.missingProperty === 'string'
          ? error.params.missingProperty
          : undefined,
        typeof error.params?.additionalProperty === 'string'
          ? error.params.additionalProperty
          : undefined,
      );
      issues.push(makeIssue('SCHEMA_VIOLATION', opts, detail, recordId));
    }
  }

  if (isKnownSchemaVersion(record.schemaVersion) && compareSemver(record.schemaVersion, SCHEMA_VERSION) > 0) {
    issues.push(makeIssue('UNKNOWN_SCHEMA_VERSION', opts, 'schemaVersion', recordId));
  }

  if (hasMissingTaskDescriptor(record)) {
    issues.push(makeIssue('EVAL_MISSING_TASK_DESCRIPTOR', opts, 'taskDescriptor', recordId));
  }

  const modelsAvailable = getModelsAvailable(taskDescriptor);
  if (taskDescriptor && (!Array.isArray(modelsAvailable) || modelsAvailable.length === 0)) {
    issues.push(
      makeIssue(
        'EVAL_EMPTY_MODELS_AVAILABLE',
        opts,
        'taskDescriptor.constraints.models_available',
        recordId,
      ),
    );
  }

  issues.push(...collectStageModelIssues(record, opts, recordId));

  // Validate verification telemetry if present
  const telemetryDiagnostics = validateVerificationTelemetry({ verificationTelemetry: record.verificationTelemetry });
  for (const diagnostic of telemetryDiagnostics) {
    if (diagnostic.severity === 'error') {
      issues.push(makeIssue('SCHEMA_VIOLATION', opts, `${diagnostic.field}: ${diagnostic.message}`, recordId));
    }
  }

  if (
    record.score === null ||
    !isNonEmptyString(record.rationale)
  ) {
    issues.push(makeIssue('INELIGIBLE_REWARD_NO_JUDGE', opts, 'rationale', recordId));
  }

  if (!TRAINING_REQUIRED_FIELDS.every((field) => isNonEmptyString(record[field]))) {
    issues.push(
      makeIssue(
        'INELIGIBLE_TRAINING_INCOMPLETE_RUN',
        opts,
        TRAINING_REQUIRED_FIELDS.filter((field) => !isNonEmptyString(record[field])).join(','),
        recordId,
      ),
    );
  }

  return issues;
}

export function deriveNonRewardReasonFromIssues(
  issues: ValidationIssue[],
): { code: string; message: string } | null {
  if (issues.length === 0) {
    return null;
  }

  const highestSeverity = [...issues].sort(
    (a, b) =>
      EVAL_ERROR_SEVERITY_ORDER.indexOf(a.code) - EVAL_ERROR_SEVERITY_ORDER.indexOf(b.code),
  )[0];

  if (highestSeverity.code === 'SCHEMA_VIOLATION') {
    const paths = issues
      .filter((issue) => issue.code === 'SCHEMA_VIOLATION' && issue.detail)
      .map((issue) => issue.detail as string)
      .join(', ');

    return {
      code: highestSeverity.code,
      message: paths ? `${highestSeverity.message} Paths: ${paths}` : highestSeverity.message,
    };
  }

  return {
    code: highestSeverity.code,
    message: highestSeverity.message,
  };
}

export function isValidationNonRewardCode(code: string | undefined): code is EvalErrorCode {
  return !!code && (EVAL_ERROR_SEVERITY_ORDER as readonly string[]).includes(code);
}

export async function validateEvalsFile(filePath: string): Promise<ValidationReport> {
  const resolvedPath = resolve(filePath);
  try {
    await stat(resolvedPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to validate evals file ${resolvedPath}: ${message}`);
  }

  const issues: ValidationIssue[] = [];
  let totalLines = 0;
  let validRecords = 0;

  const rl = createInterface({
    input: createReadStream(resolvedPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const lineText of rl) {
    totalLines += 1;

    if (!lineText.trim()) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(lineText);
    } catch {
      issues.push(makeIssue('MALFORMED_JSON', { file: resolvedPath, line: totalLines }));
      continue;
    }

    const lineIssues = validateEvalRecord(parsed, {
      file: resolvedPath,
      line: totalLines,
    });
    issues.push(...lineIssues);
    if (lineIssues.length === 0) {
      validRecords += 1;
    }
  }

  issues.sort((a, b) => a.line - b.line || a.code.localeCompare(b.code));

  return {
    totalLines,
    validRecords,
    issues,
    countsByCode: buildCounts(issues),
    files: [resolvedPath],
  };
}

export async function validateEvalsStore(repoDir?: string): Promise<ValidationReport> {
  const evalsDir = resolveEvalsDir(undefined, repoDir).dir;
  const filePath = join(evalsDir, 'evals.jsonl');

  if (!existsSync(evalsDir) || !existsSync(filePath)) {
    return {
      totalLines: 0,
      validRecords: 0,
      issues: [],
      countsByCode: {},
      files: [filePath],
    };
  }

  return validateEvalsFile(filePath);
}
