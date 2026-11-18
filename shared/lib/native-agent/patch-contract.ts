import path from 'node:path';
import { compileSchemaValidator, type SchemaValidatorFunction } from '../schema-validators.ts';

export const NATIVE_PATCH_VERSION = 1 as const;

export type NativePatchValidationErrorCode =
  | 'invalid_type'
  | 'schema_validation'
  | 'invalid_path'
  | 'identical_old_new';

export interface NativePatchValidationError {
  code: NativePatchValidationErrorCode;
  path: string;
  message: string;
  operationIndex?: number;
  keyword?: string;
  params?: Record<string, unknown>;
}

export interface NativePatchContextAnchors {
  anchorBefore?: string;
  anchorAfter?: string;
  expectedOccurrences?: number;
}

export interface NativePatchFuzzyMatch {
  minSimilarity?: number;
  maxMatchCandidates?: number;
  maxContextLines?: number;
  ignoreWhitespace?: boolean;
  requireAnchorOverlap?: boolean;
}

export interface NativePatchEditOperation extends NativePatchContextAnchors {
  op: 'edit';
  path: string;
  oldText: string;
  newText: string;
}

export interface NativePatchEditDiffOperation extends NativePatchContextAnchors {
  op: 'edit-diff';
  path: string;
  diff: string;
}

export type NativePatchOperation = NativePatchEditOperation | NativePatchEditDiffOperation;

export interface NativePatch {
  version: typeof NATIVE_PATCH_VERSION;
  atomic: true;
  operations: NativePatchOperation[];
  fuzzyMatch?: NativePatchFuzzyMatch;
}

export const NATIVE_PATCH_EXAMPLE: NativePatch = {
  version: NATIVE_PATCH_VERSION,
  atomic: true,
  operations: [
    {
      op: 'edit',
      path: 'src/example.ts',
      oldText: 'export const value = "before";\n',
      newText: 'export const value = "after";\n',
    },
  ],
};

export const NATIVE_PATCH_CONTRACT_SUMMARY = [
  'NativePatch envelope: version must be 1, atomic must be true, and operations must be a non-empty array.',
  'Operation variants:',
  '- edit: requires path, oldText, and newText.',
  '- edit-diff: requires path and diff.',
  'Paths are repo-relative POSIX paths. Operations may include anchorBefore, anchorAfter, and expectedOccurrences.',
  'Optional fuzzyMatch supports minSimilarity, maxMatchCandidates, maxContextLines, ignoreWhitespace, and requireAnchorOverlap.',
].join('\n');

const NATIVE_PATCH_OPERATION_SCHEMA = {
  type: 'object',
  required: ['op', 'path'],
  properties: {
    op: {
      type: 'string',
      enum: ['edit', 'edit-diff'],
      description: 'Operation variant. "edit" requires oldText/newText; "edit-diff" requires diff.',
    },
    path: {
      type: 'string',
      description: 'Repo-relative POSIX path without traversal, for example "src/app.ts".',
    },
  },
  oneOf: [
    {
      properties: {
        op: { const: 'edit' },
        path: { type: 'string' },
        oldText: { type: 'string', minLength: 1, description: 'Required for op "edit": exact existing text to replace. Must be non-empty.' },
        newText: { type: 'string', description: 'Required for op "edit": replacement text. May be empty to delete oldText.' },
        anchorBefore: { type: 'string', minLength: 1, description: 'Optional non-empty context that should appear before the edit.' },
        anchorAfter: { type: 'string', minLength: 1, description: 'Optional non-empty context that should appear after the edit.' },
        expectedOccurrences: { type: 'integer', minimum: 1, description: 'Optional positive integer for the expected count of oldText matches.' },
      },
      required: ['op', 'path', 'oldText', 'newText'],
      additionalProperties: false,
    },
    {
      properties: {
        op: { const: 'edit-diff' },
        path: { type: 'string' },
        diff: { type: 'string', minLength: 1, description: 'Required for op "edit-diff": unified diff hunk text for this path.' },
        anchorBefore: { type: 'string', minLength: 1, description: 'Optional non-empty context that should appear before the edit.' },
        anchorAfter: { type: 'string', minLength: 1, description: 'Optional non-empty context that should appear after the edit.' },
        expectedOccurrences: { type: 'integer', minimum: 1, description: 'Optional positive integer for the expected count of oldText matches.' },
      },
      required: ['op', 'path', 'diff'],
      additionalProperties: false,
    },
  ],
} as const;

export const NATIVE_PATCH_PARAMETERS_SCHEMA = {
  type: 'object',
  description: 'NativePatch payload. Required envelope: version: 1, atomic: true, operations: non-empty array. Use op "edit" with path/oldText/newText or op "edit-diff" with path/diff.',
  additionalProperties: false,
  required: ['version', 'atomic', 'operations'],
  properties: {
    version: {
      type: 'number',
      enum: [NATIVE_PATCH_VERSION],
      description: 'Required NativePatch contract version. Must be 1.',
    },
    atomic: {
      type: 'boolean',
      enum: [true],
      description: 'Required. Must be true; all operations apply atomically or none are applied.',
    },
    operations: {
      type: 'array',
      minItems: 1,
      description: 'Required non-empty array of edit operations. For op "edit", include path, oldText, newText. For op "edit-diff", include path and diff.',
      items: NATIVE_PATCH_OPERATION_SCHEMA,
    },
    fuzzyMatch: {
      type: 'object',
      description: 'Optional fuzzy matching settings used when exact oldText matching needs controlled recovery.',
      additionalProperties: false,
      properties: {
        minSimilarity: { type: 'number', minimum: 0, maximum: 1, description: 'Optional number between 0 and 1.' },
        maxMatchCandidates: { type: 'integer', minimum: 1, description: 'Optional positive integer.' },
        maxContextLines: { type: 'integer', minimum: 0, description: 'Optional integer greater than or equal to 0.' },
        ignoreWhitespace: { type: 'boolean', description: 'Optional boolean.' },
        requireAnchorOverlap: { type: 'boolean', description: 'Optional boolean.' },
      },
    },
  },
} as const;

export function buildNativePatchGuidance(): string {
  return [
    NATIVE_PATCH_CONTRACT_SUMMARY,
    '',
    'Valid NativePatch example:',
    '```json',
    JSON.stringify(NATIVE_PATCH_EXAMPLE, null, 2),
    '```',
  ].join('\n');
}

export type NativePatchRuntimeRejectionCode =
  | 'path_denied'
  | 'old_text_not_found'
  | 'ambiguous_anchor'
  | 'anchor_mismatch'
  | 'phase_denied'
  | 'fuzzy_below_threshold';

export interface NativePatchRuntimeRejectionContext {
  path: string;
  excerpt: string;
  startLine?: number;
  endLine?: number;
}

export interface NativePatchRuntimeRejection {
  operationIndex: number;
  code: NativePatchRuntimeRejectionCode;
  message: string;
  requestedContext: {
    oldText?: string;
    diff?: string;
    anchorBefore?: string;
    anchorAfter?: string;
    normalizedOldText?: string;
  };
  liveContext?: NativePatchRuntimeRejectionContext;
  hint: string;
}

export interface NativePatchRejectedResult {
  ok: false;
  atomic: true;
  appliedOperations: 0;
  rejection: NativePatchRuntimeRejection;
}

export type ValidateNativePatchResult =
  | { ok: true; value: NativePatch }
  | { ok: false; errors: NativePatchValidationError[] };

/**
 * Normalize a candidate patch path into a repo-relative POSIX path.
 *
 * Inputs must already be strings. This helper rejects absolute, traversal,
 * Windows-style, and empty paths so validation can fail before any file I/O.
 */
export function normalizePatchPath(input: string): string | null {
  if (input.length === 0 || input.includes('\0') || input.includes('\\')) {
    return null;
  }

  if (path.posix.isAbsolute(input)) {
    return null;
  }

  const segments = input.split('/');
  if (segments.some((segment) => segment === '..')) {
    return null;
  }

  const normalized = path.posix.normalize(input);
  if (normalized === '.' || normalized.length === 0 || normalized.startsWith('../')) {
    return null;
  }

  return normalized.replace(/^(?:\.\/)+/, '');
}

let nativePatchValidator: SchemaValidatorFunction | undefined;

function getNativePatchValidator(): SchemaValidatorFunction {
  if (!nativePatchValidator) {
    nativePatchValidator = compileSchemaValidator(NATIVE_PATCH_PARAMETERS_SCHEMA, { allErrors: true, strict: false });
  }
  return nativePatchValidator;
}

function ajvPath(instancePath: string): string {
  if (!instancePath) {
    return '$';
  }
  const segments = instancePath.slice(1).split('/');
  return segments
    .map((segment, index) => {
      if (/^\d+$/.test(segment)) {
        return `[${segment}]`;
      }
      return index === 0 ? `$.${segment}` : `.${segment}`;
    })
    .join('');
}

function operationIndexFromAjvPath(instancePath: string): number | undefined {
  const match = /^\/operations\/(\d+)(?:\/|$)/.exec(instancePath);
  return match ? Number(match[1]) : undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function extractAnchors(operation: Record<string, unknown>): NativePatchContextAnchors {
  const anchors: NativePatchContextAnchors = {};
  if (typeof operation.anchorBefore === 'string') {
    anchors.anchorBefore = operation.anchorBefore;
  }
  if (typeof operation.anchorAfter === 'string') {
    anchors.anchorAfter = operation.anchorAfter;
  }
  if (typeof operation.expectedOccurrences === 'number') {
    anchors.expectedOccurrences = operation.expectedOccurrences;
  }
  return anchors;
}

export function validateNativePatch(input: unknown): ValidateNativePatchResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [
        {
          code: 'invalid_type',
          path: '$',
          message: 'NativePatch must be an object.',
        },
      ],
    };
  }

  const validate = getNativePatchValidator();
  if (!validate(input)) {
    const errors: NativePatchValidationError[] = [];
    for (const ajvError of validate.errors ?? []) {
      const instancePath = ajvError.instancePath ?? '';
      errors.push({
        code: 'schema_validation',
        path: ajvPath(instancePath),
        message: ajvError.message ?? 'Invalid value',
        operationIndex: operationIndexFromAjvPath(instancePath),
        keyword: ajvError.keyword,
        params: ajvError.params && Object.keys(ajvError.params).length > 0 ? ajvError.params : undefined,
      });
    }
    return { ok: false, errors };
  }

  const envelope = input as Record<string, unknown>;
  const operationsInput = envelope.operations as unknown[];
  const normalizedOperations: NativePatchOperation[] = [];

  for (const [index, operation] of operationsInput.entries()) {
    const operationRecord = operation as Record<string, unknown>;
    const rawPath = operationRecord.path as string;
    const normalizedPath = normalizePatchPath(rawPath);
    if (!normalizedPath) {
      return {
        ok: false,
        errors: [
          {
            code: 'invalid_path',
            path: `$.operations[${index}].path`,
            message: 'NativePatch operation path must be a repo-relative POSIX path without traversal.',
            operationIndex: index,
          },
        ],
      };
    }

    if (operationRecord.op === 'edit') {
      const oldText = operationRecord.oldText as string;
      const newText = operationRecord.newText as string;
      if (oldText === newText) {
        return {
          ok: false,
          errors: [
            {
              code: 'identical_old_new',
              path: `$.operations[${index}].newText`,
              message: 'newText must differ from oldText.',
              operationIndex: index,
            },
          ],
        };
      }
      normalizedOperations.push({
        op: 'edit',
        path: normalizedPath,
        oldText,
        newText,
        ...extractAnchors(operationRecord),
      });
    } else {
      normalizedOperations.push({
        op: 'edit-diff',
        path: normalizedPath,
        diff: operationRecord.diff as string,
        ...extractAnchors(operationRecord),
      });
    }
  }

  const result: NativePatch = {
    version: NATIVE_PATCH_VERSION,
    atomic: true,
    operations: normalizedOperations,
  };

  if (isRecord(envelope.fuzzyMatch)) {
    result.fuzzyMatch = envelope.fuzzyMatch as NativePatchFuzzyMatch;
  }

  return { ok: true, value: result };
}
