import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type SeamArtifactName =
  | 'coding-complete'
  | 'blocked-completion'
  | 'planning-rejected'
  | 'stage-result'
  | 'plan-approved'
  | 'workflow-aborted'
  | 'migration-detected';

export type SeamArtifactKind = 'json' | 'touch';
export type SeamArtifactWriter = 'agent' | 'orchestrator' | 'agent-or-user';
export type SeamArtifactPhase = 'planning' | 'coding' | 'review' | 'ready' | 'any';
export type SeamLegacyFormat = 'key-value' | 'fenced-json' | 'flat-yaml';
export type SeamStageName = 'planning' | 'coding' | 'review' | 'ready';

export const SEAM_VALIDATION_ERROR_CODES = [
  'MALFORMED_JSON',
  'MISSING_REQUIRED_FIELD',
  'INVALID_FIELD_TYPE',
  'INVALID_ENUM_VALUE',
  'INVALID_STAGE',
  'INVALID_VALUE',
  'NO_VERIFICATION_EVIDENCE',
  'ARTIFACT_NOT_FOUND',
] as const;

export type SeamValidationErrorCode = (typeof SEAM_VALIDATION_ERROR_CODES)[number];

export interface SeamValidationError {
  code: SeamValidationErrorCode;
  path: string;
  message: string;
}

export type SeamValidationResult<T = Record<string, unknown>> =
  | {
    ok: true;
    artifact: SeamArtifactName;
    value: T;
    canonicalContent: string;
    warnings: string[];
    changed: boolean;
  }
  | { ok: false; artifact: SeamArtifactName; errors: SeamValidationError[] };

export interface SeamArtifactSpec {
  name: SeamArtifactName;
  filename: string;
  kind: SeamArtifactKind;
  writer: SeamArtifactWriter;
  phase: SeamArtifactPhase;
  schema?: string;
  legacyFormats?: readonly SeamLegacyFormat[];
  semanticRules?: readonly SeamSemanticRule[];
  describe(): string;
}

export interface ValidateContentOptions {
  coerceUnverifiedClaim?: boolean;
}

type SeamSemanticRule = (value: Record<string, unknown>, options: ValidateContentOptions) => {
  error?: SeamValidationError;
  value?: Record<string, unknown>;
  warning?: string;
  changed?: boolean;
} | null;

export type LenientSourceFormat = 'json' | 'fenced-json' | 'yaml';

export type ParseLenientObjectResult =
  | { ok: true; value: Record<string, unknown>; sourceFormat: LenientSourceFormat }
  | { ok: false };

const schemaCache = new Map<string, unknown>();
const validatorCache = new Map<string, ValidateFunction>();
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });

const BLOCKING_REASONS = [
  'repo_verification_blocked',
  'environment_blocked',
  'baseline_tests_failing',
  'model_at_capacity',
] as const;

const RECOMMENDED_ACTIONS = ['advance_to_review', 'relaunch_coding'] as const;
const CONFIDENCE_VALUES = ['high', 'medium', 'low'] as const;

const registry: readonly SeamArtifactSpec[] = [
  {
    name: 'coding-complete',
    filename: '.coding-complete',
    kind: 'json',
    writer: 'agent',
    phase: 'coding',
    schema: 'coding-complete.schema.json',
    legacyFormats: ['key-value', 'fenced-json', 'flat-yaml'],
    describe: () => [
      '.coding-complete must be a JSON object.',
      'Required fields: "stage": "coding", "confidence": "high" | "medium" | "low".',
      'Optional fields include "commit", "notes", "source", and "createdAt".',
      'Example: {"stage":"coding","confidence":"high"}',
    ].join('\n'),
  },
  {
    name: 'blocked-completion',
    filename: '.coding-blocked-completion.json',
    kind: 'json',
    writer: 'agent',
    phase: 'coding',
    schema: 'blocked-completion.schema.json',
    legacyFormats: ['fenced-json', 'flat-yaml'],
    semanticRules: [blockedCompletionEvidenceRule],
    describe: () => [
      '.coding-blocked-completion.json must be valid JSON.',
      'Required fields: stage, implementationComplete, committed, passingChecks, blockingChecks, blockingReason, evidence, recommendedAction.',
      `blockingReason values: ${BLOCKING_REASONS.join(', ')}.`,
      `recommendedAction values: ${RECOMMENDED_ACTIONS.join(', ')}.`,
      'If no verification ran or passingChecks is empty, set implementationComplete to false.',
      'Example:',
      JSON.stringify({
        stage: 'coding',
        implementationComplete: true,
        committed: true,
        commit: 'abc1234',
        passingChecks: ['node --test shared/lib/example.test.ts'],
        blockingChecks: ['npm test'],
        blockingReason: 'baseline_tests_failing',
        evidence: 'Scoped checks passed; repo-level failures are unrelated.',
        recommendedAction: 'advance_to_review',
      }, null, 2),
    ].join('\n'),
  },
  {
    name: 'planning-rejected',
    filename: '.planning-rejected.json',
    kind: 'json',
    writer: 'orchestrator',
    phase: 'planning',
    schema: 'planning-rejected.schema.json',
    describe: () => 'Orchestrator-written planning rejection JSON artifact.',
  },
  {
    name: 'stage-result',
    filename: '.{stage}-result.json',
    kind: 'json',
    writer: 'orchestrator',
    phase: 'any',
    schema: 'stage-result.schema.json',
    describe: () => 'Orchestrator-written stage result JSON artifact with required stage and status fields.',
  },
  {
    name: 'plan-approved',
    filename: '.plan-approved',
    kind: 'touch',
    writer: 'agent-or-user',
    phase: 'planning',
    describe: () => '.plan-approved is a touch-file seam; existence is the whole signal.',
  },
  {
    name: 'workflow-aborted',
    filename: '.workflow-aborted',
    kind: 'touch',
    writer: 'agent-or-user',
    phase: 'any',
    describe: () => '.workflow-aborted is a touch-file seam; existence is the whole signal.',
  },
  {
    name: 'migration-detected',
    filename: '.migration-detected',
    kind: 'touch',
    writer: 'agent',
    phase: 'any',
    describe: () => '.migration-detected is a touch-file seam; existence is the whole signal.',
  },
];

export function listSeamArtifacts(): SeamArtifactSpec[] {
  return [...registry];
}

export function getSeamArtifactSpec(name: SeamArtifactName): SeamArtifactSpec {
  const spec = registry.find((entry) => entry.name === name);
  if (!spec) {
    throw new Error(`Unknown seam artifact: ${name}`);
  }
  return spec;
}

export function getSeamArtifactPath(
  name: SeamArtifactName,
  featureDir: string,
  stage?: SeamStageName,
): string {
  const spec = getSeamArtifactSpec(name);
  const filename = spec.filename.includes('{stage}')
    ? spec.filename.replace('{stage}', requireStage(name, stage))
    : spec.filename;
  return path.join(featureDir, filename);
}

export function validateSeamArtifactValue<T = Record<string, unknown>>(
  name: SeamArtifactName,
  value: unknown,
  options: ValidateContentOptions = {},
): SeamValidationResult<T> {
  const spec = getSeamArtifactSpec(name);
  if (spec.kind === 'touch') {
    return {
      ok: false,
      artifact: name,
      errors: [{ code: 'INVALID_VALUE', path: '$', message: `${name} is a touch-file seam and has no JSON value.` }],
    };
  }

  const validation = validateValueAgainstSchema(name, value, options);
  if (!validation.ok) {
    return validation as SeamValidationResult<T>;
  }
  return {
    ok: true,
    artifact: name,
    value: validation.value as T,
    canonicalContent: JSON.stringify(validation.value, null, 2) + '\n',
    warnings: validation.warnings,
    changed: validation.changed,
  };
}

export function validateSeamSubschemaValue<T = Record<string, unknown>>(
  schemaFile: string,
  schemaPointer: string,
  value: unknown,
): { ok: true; value: T } | { ok: false; errors: SeamValidationError[] } {
  const validate = getValidator(`${schemaFile}#${schemaPointer}`);
  if (validate(value)) {
    return { ok: true, value: value as T };
  }
  return {
    ok: false,
    errors: mapAjvErrors(validate.errors ?? [], resolveJsonPointer(getSchema(schemaFile), schemaPointer)),
  };
}

export function validateSeamArtifactContent<T = Record<string, unknown>>(
  name: SeamArtifactName,
  raw: string,
  options: ValidateContentOptions = {},
): SeamValidationResult<T> {
  const spec = getSeamArtifactSpec(name);
  if (spec.kind === 'touch') {
    return {
      ok: false,
      artifact: name,
      errors: [{ code: 'INVALID_VALUE', path: '$', message: `${name} is a touch-file seam and has no JSON content.` }],
    };
  }

  const parsed = parseStrictJson(raw);
  if (parsed.ok) {
    const result = validateParsedContent<T>(name, parsed.value, [], false, options);
    if (result.ok && raw !== result.canonicalContent) {
      return { ...result, changed: true };
    }
    return result;
  }

  const legacy = parseLegacyContent(spec, raw);
  if (!legacy.ok) {
    return {
      ok: false,
      artifact: name,
      errors: [{ code: 'MALFORMED_JSON', path: '$', message: `${spec.filename} must contain valid JSON.` }],
    };
  }

  return validateParsedContent<T>(
    name,
    legacy.value,
    [`normalized ${legacy.sourceFormat} payload to canonical ${spec.filename}`],
    true,
    options,
  );
}

export async function readSeamArtifact<T = Record<string, unknown>>(
  name: SeamArtifactName,
  featureDir: string,
  opts: { stage?: SeamStageName; canonicalize?: boolean; coerceUnverifiedClaim?: boolean } = {},
): Promise<SeamValidationResult<T>> {
  const artifactPath = getSeamArtifactPath(name, featureDir, opts.stage);
  const spec = getSeamArtifactSpec(name);
  if (spec.kind === 'touch') {
    if (existsSync(artifactPath)) {
      return {
        ok: true,
        artifact: name,
        value: {} as T,
        canonicalContent: '',
        warnings: [],
        changed: false,
      };
    }
    return {
      ok: false,
      artifact: name,
      errors: [{ code: 'ARTIFACT_NOT_FOUND', path: '$', message: `${spec.filename} was not found.` }],
    };
  }

  let raw: string;
  try {
    raw = await readFile(artifactPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ok: false,
        artifact: name,
        errors: [{ code: 'ARTIFACT_NOT_FOUND', path: '$', message: `${spec.filename} was not found.` }],
      };
    }
    throw error;
  }

  const result = validateSeamArtifactContent<T>(name, raw, {
    coerceUnverifiedClaim: opts.coerceUnverifiedClaim,
  });
  if (result.ok && opts.canonicalize && result.changed) {
    await writeFile(artifactPath, result.canonicalContent, 'utf-8');
  }
  return result;
}

export function describeSeamArtifactContract(name: SeamArtifactName): string {
  return getSeamArtifactSpec(name).describe();
}

export function buildSeamArtifactRetryGuidance(
  name: SeamArtifactName,
  errors: readonly SeamValidationError[],
): string {
  const formattedErrors = errors.map((error) => (
    `- ${error.code} at ${error.path}: ${error.message}`
  )).join('\n');
  return [
    `Rewrite ${getSeamArtifactSpec(name).filename} to match the shared seam contract.`,
    formattedErrors,
    'Required contract:',
    describeSeamArtifactContract(name),
  ].join('\n');
}

export function parseLenientObject(raw: string): ParseLenientObjectResult {
  const json = parseJsonObject(raw);
  if (json.ok) return { ...json, sourceFormat: 'json' };

  const fenced = stripMarkdownJsonFence(raw);
  if (fenced !== null) {
    const fencedJson = parseJsonObject(fenced);
    if (fencedJson.ok) return { ...fencedJson, sourceFormat: 'fenced-json' };
  }

  const yaml = parseFlatYamlObject(raw);
  if (yaml.ok) return { ...yaml, sourceFormat: 'yaml' };

  return { ok: false };
}

function validateParsedContent<T>(
  name: SeamArtifactName,
  value: unknown,
  warnings: string[],
  changed: boolean,
  options: ValidateContentOptions,
): SeamValidationResult<T> {
  const validation = validateValueAgainstSchema(name, value, options);
  if (!validation.ok) return validation as SeamValidationResult<T>;
  return {
    ok: true,
    artifact: name,
    value: validation.value as T,
    canonicalContent: JSON.stringify(validation.value, null, 2) + '\n',
    warnings: [...warnings, ...validation.warnings],
    changed: changed || validation.changed,
  };
}

function validateValueAgainstSchema(
  name: SeamArtifactName,
  value: unknown,
  options: ValidateContentOptions,
): SeamValidationResult<Record<string, unknown>> {
  const spec = getSeamArtifactSpec(name);
  const validate = getValidator(spec.schema ?? '');
  if (!validate(value)) {
    return { ok: false, artifact: name, errors: mapAjvErrors(validate.errors ?? [], getSchema(spec.schema ?? '')) };
  }

  let current = value as Record<string, unknown>;
  const warnings: string[] = [];
  let changed = false;
  for (const rule of spec.semanticRules ?? []) {
    const result = rule(current, options);
    if (!result) continue;
    if (result.error) {
      return { ok: false, artifact: name, errors: [result.error] };
    }
    if (result.value) current = result.value;
    if (result.warning) warnings.push(result.warning);
    if (result.changed) changed = true;
  }

  return {
    ok: true,
    artifact: name,
    value: current,
    canonicalContent: JSON.stringify(current, null, 2) + '\n',
    warnings,
    changed,
  };
}

function parseStrictJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown };
  } catch {
    return { ok: false };
  }
}

function parseLegacyContent(
  spec: SeamArtifactSpec,
  raw: string,
): { ok: true; value: Record<string, unknown>; sourceFormat: string } | { ok: false } {
  if (spec.legacyFormats?.includes('key-value')) {
    const keyValue = parseKeyValueLines(raw);
    if (keyValue.ok) {
      return { ok: true, value: { stage: 'coding', ...keyValue.value }, sourceFormat: 'key=value' };
    }
  }

  const lenient = parseLenientObject(raw);
  if (!lenient.ok) return { ok: false };
  if (lenient.sourceFormat === 'fenced-json' && spec.legacyFormats?.includes('fenced-json')) {
    return { ok: true, value: lenient.value, sourceFormat: 'fenced JSON' };
  }
  if (lenient.sourceFormat === 'yaml' && spec.legacyFormats?.includes('flat-yaml')) {
    return { ok: true, value: lenient.value, sourceFormat: 'flat YAML' };
  }
  return { ok: false };
}

function parseKeyValueLines(raw: string): { ok: true; value: Record<string, string> } | { ok: false } {
  const fields: Record<string, string> = {};
  let sawField = false;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) return { ok: false };
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.length === 0) return { ok: false };
    fields[key] = value;
    sawField = true;
  }
  return sawField ? { ok: true, value: fields } : { ok: false };
}

function mapAjvErrors(errors: readonly ErrorObject[], schema: unknown): SeamValidationError[] {
  return dedupeAjvErrors(errors).sort(compareAjvErrors(schema)).map((error) => {
    const pathValue = ajvErrorPath(error);
    const property = pathValue === '$' ? 'artifact' : pathValue.split('.').at(-1)?.replace(/\[\d+\]$/, '') ?? pathValue;
    switch (error.keyword) {
      case 'required': {
        const missing = String((error.params as { missingProperty?: unknown }).missingProperty);
        return {
          code: 'MISSING_REQUIRED_FIELD',
          path: appendJsonPath(pathValue, missing),
          message: `Missing required field "${missing}".`,
        };
      }
      case 'type':
        return {
          code: 'INVALID_FIELD_TYPE',
          path: pathValue,
          message: `${property} must have the expected JSON type.`,
        };
      case 'const':
        return {
          code: pathValue === '$.stage' ? 'INVALID_STAGE' : 'INVALID_ENUM_VALUE',
          path: pathValue,
          message: `${property} must be ${JSON.stringify((error.params as { allowedValue?: unknown }).allowedValue)}.`,
        };
      case 'enum':
        return {
          code: 'INVALID_ENUM_VALUE',
          path: pathValue,
          message: `${property} must be one of: ${((error.params as { allowedValues?: unknown[] }).allowedValues ?? []).join(', ')}.`,
        };
      default:
        return {
          code: 'INVALID_VALUE',
          path: pathValue,
          message: `${property} is not a valid seam artifact value.`,
        };
    }
  });
}

function dedupeAjvErrors(errors: readonly ErrorObject[]): ErrorObject[] {
  const pathsWithTypeError = new Set(
    errors
      .filter((error) => error.keyword === 'type')
      .map((error) => error.instancePath),
  );
  return errors.filter((error) => {
    if (!pathsWithTypeError.has(error.instancePath)) return true;
    return !['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'].includes(error.keyword);
  });
}

function compareAjvErrors(schema: unknown): (left: ErrorObject, right: ErrorObject) => number {
  const order = schemaFieldOrder(schema);
  return (left, right) => {
    const leftKey = sortKey(left, order);
    const rightKey = sortKey(right, order);
    return leftKey.localeCompare(rightKey);
  };
}

function sortKey(error: ErrorObject, order: Map<string, number>): string {
  if (error.keyword === 'type' && error.instancePath === '') return '0000';
  const pathValue = error.keyword === 'required'
    ? appendJsonPath(ajvErrorPath(error), String((error.params as { missingProperty?: unknown }).missingProperty))
    : ajvErrorPath(error);
  const field = pathValue.replace(/^\$\./, '').split(/[.[\]]/)[0] ?? '';
  const fieldOrder = String(order.get(field) ?? 9999).padStart(4, '0');
  const keywordOrder = error.keyword === 'required' ? '0' : '1';
  return `${fieldOrder}:${keywordOrder}:${pathValue}:${error.keyword}`;
}

function schemaFieldOrder(schema: unknown): Map<string, number> {
  const order = new Map<string, number>();
  if (isRecord(schema) && Array.isArray(schema.required)) {
    schema.required.forEach((field, index) => {
      if (typeof field === 'string') order.set(field, index);
    });
  }
  if (isRecord(schema) && isRecord(schema.properties)) {
    Object.keys(schema.properties).forEach((field, index) => {
      if (!order.has(field)) order.set(field, 1000 + index);
    });
  }
  return order;
}

function ajvErrorPath(error: ErrorObject): string {
  if (!error.instancePath) return '$';
  return `$${error.instancePath.replace(/\/([^/]+)/g, (_, segment: string) => {
    const decoded = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    return /^\d+$/.test(decoded) ? `[${decoded}]` : `.${decoded}`;
  })}`;
}

function appendJsonPath(base: string, key: string): string {
  return base === '$' ? `$.${key}` : `${base}.${key}`;
}

function getValidator(schemaId: string): ValidateFunction {
  const cached = validatorCache.get(schemaId);
  if (cached) return cached;
  const [schemaFile, pointer] = schemaId.split('#');
  const root = getSchema(schemaFile);
  const schema = pointer ? withRootDefs(resolveJsonPointer(root, pointer), root) : root;
  const validate = ajv.compile(schema);
  validatorCache.set(schemaId, validate);
  return validate;
}

// A subschema compiled on its own loses the root, so carry the root $defs along
// for its local `#/$defs/...` refs to resolve.
function withRootDefs(subschema: unknown, root: unknown): unknown {
  if (!isRecord(subschema) || !isRecord(root) || !isRecord(root.$defs)) return subschema;
  return { ...subschema, $defs: root.$defs };
}

function getSchema(schemaFile: string): unknown {
  const cached = schemaCache.get(schemaFile);
  if (cached) return cached;
  const schemaPath = new URL(`../schemas/${schemaFile}`, import.meta.url);
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8')) as unknown;
  schemaCache.set(schemaFile, schema);
  return schema;
}

function resolveJsonPointer(schema: unknown, pointer: string): unknown {
  let current = schema;
  for (const rawPart of pointer.replace(/^\//, '').split('/')) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isRecord(current)) throw new Error(`Invalid schema pointer: ${pointer}`);
    current = current[part];
  }
  return current;
}

function requireStage(name: SeamArtifactName, stage: SeamStageName | undefined): SeamStageName {
  if (stage) return stage;
  throw new Error(`Artifact ${name} requires a stage`);
}

function blockedCompletionEvidenceRule(
  value: Record<string, unknown>,
  options: ValidateContentOptions,
): ReturnType<SeamSemanticRule> {
  const implementationComplete = value.implementationComplete === true;
  const passingChecks = value.passingChecks;
  if (!implementationComplete || !Array.isArray(passingChecks) || passingChecks.length > 0) {
    return null;
  }
  if (options.coerceUnverifiedClaim) {
    return {
      value: { ...value, implementationComplete: false },
      warning: 'implementationComplete coerced to false: no verification evidence',
      changed: true,
    };
  }
  return {
    error: {
      code: 'NO_VERIFICATION_EVIDENCE',
      path: '$.passingChecks',
      message: 'Blocked completion cannot claim implementationComplete=true with no passingChecks evidence.',
    },
  };
}

function parseJsonObject(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown;
    if (isRecord(parsed)) {
      return { ok: true, value: parsed };
    }
  } catch {
    // Fall through.
  }
  return { ok: false };
}

function stripMarkdownJsonFence(raw: string): string | null {
  const trimmed = raw.trim();
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return match ? match[1] ?? '' : null;
}

function parseFlatYamlObject(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const result: Record<string, unknown> = {};
  let currentArrayKey: string | null = null;
  let sawField = false;

  for (const rawLine of lines) {
    const withoutComment = stripYamlComment(rawLine);
    if (withoutComment.trim() === '') continue;

    const indent = withoutComment.match(/^\s*/)?.[0].length ?? 0;
    const trimmed = withoutComment.trim();
    if (trimmed === '---' || trimmed === '...') return { ok: false };

    if (trimmed.startsWith('- ')) {
      if (currentArrayKey === null || indent === 0) return { ok: false };
      const current = result[currentArrayKey];
      if (!Array.isArray(current)) return { ok: false };
      current.push(parseYamlScalar(trimmed.slice(2).trim()));
      continue;
    }

    if (indent !== 0) return { ok: false };
    currentArrayKey = null;
    const separator = trimmed.indexOf(':');
    if (separator <= 0) return { ok: false };
    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { ok: false };
    if (rawValue === '') {
      result[key] = [];
      currentArrayKey = key;
    } else {
      result[key] = parseYamlScalar(rawValue);
    }
    sawField = true;
  }

  return sawField ? { ok: true, value: result } : { ok: false };
}

function parseYamlScalar(raw: string): unknown {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (inner === '') return [];
    return splitFlowSequence(inner).map((item) => parseYamlScalar(item.trim()));
  }
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

function splitFlowSequence(raw: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const char of raw) {
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
    } else if (char === quote) {
      quote = null;
    }
    if (char === ',' && quote === null) {
      items.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  items.push(current);
  return items;
}

function stripYamlComment(raw: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if ((char === '"' || char === "'") && quote === null) quote = char;
    else if (char === quote) quote = null;
    else if (char === '#' && quote === null) return raw.slice(0, index);
  }
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
