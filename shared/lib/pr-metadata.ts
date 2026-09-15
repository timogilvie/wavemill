export type RiskLevel = 'low' | 'medium' | 'high';

export const PR_METADATA_SCHEMA_VERSION = '1';

export interface PrMetadata {
  'schema-version'?: typeof PR_METADATA_SCHEMA_VERSION;
  task?: string;
  stack?: string;
  depends_on?: string[];
  depends_on_linear?: string[];
  requires?: string[];
  risk?: RiskLevel;
  challenge?: boolean;
  challengePairId?: string;
  route_schema?: string;
  executed_route?: string;
}

export interface PrMetadataError {
  field: string;
  code: 'unknown-field' | 'malformed-line' | 'wrong-type' | 'empty-value' | 'unsupported-version';
  message: string;
}

export type ParseResult =
  | { ok: true; metadata: PrMetadata; bodyWithoutBlock: string }
  | { ok: false; errors: PrMetadataError[]; bodyWithoutBlock: string };

export type MetadataValidation =
  | { status: 'absent' }
  | { status: 'valid'; metadata: PrMetadata }
  | { status: 'invalid'; errors: PrMetadataError[] };

const BLOCK_REGEX = /<!-- wavemill-meta\n([\s\S]*?)\n-->/g;
const LINE_REGEX = /^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/;
const ARRAY_FIELDS = new Set<keyof PrMetadata>(['depends_on', 'depends_on_linear', 'requires']);
const STRING_FIELDS = new Set<keyof PrMetadata>(['task', 'stack', 'challengePairId', 'route_schema']);
const FIELD_ORDER: Array<keyof PrMetadata> = [
  'schema-version',
  'task',
  'stack',
  'depends_on',
  'depends_on_linear',
  'requires',
  'risk',
  'challenge',
  'challengePairId',
  'route_schema',
  'executed_route',
];

function trimBlockAdjacentWhitespace(body: string): string {
  return body
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
    .replace(/^\s*\n/, '')
    .replace(/\n\s*$/, '');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function extractMetadataBlock(body: string): { block: string | null; bodyWithoutBlock: string } {
  let block: string | null = null;
  let bodyWithoutBlock = body;

  for (const match of body.matchAll(BLOCK_REGEX)) {
    block = match[1] ?? '';
  }

  if (block === null) {
    return { block: null, bodyWithoutBlock: body };
  }

  bodyWithoutBlock = trimBlockAdjacentWhitespace(bodyWithoutBlock.replace(BLOCK_REGEX, ''));
  return { block, bodyWithoutBlock };
}

export function parsePrMetadata(body: string): ParseResult {
  const { block, bodyWithoutBlock } = extractMetadataBlock(body);

  if (block === null) {
    return { ok: true, metadata: {}, bodyWithoutBlock };
  }

  const metadata: PrMetadata = {};
  const errors: PrMetadataError[] = [];

  for (const line of block.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    const match = line.match(LINE_REGEX);
    if (!match) {
      errors.push({
        field: '(malformed)',
        code: 'malformed-line',
        message: 'Malformed wavemill-meta line',
      });
      continue;
    }

    const [, field, rawValue] = match;
    if (!FIELD_ORDER.includes(field as keyof PrMetadata)) {
      errors.push({
        field,
        code: 'unknown-field',
        message: `Unknown wavemill-meta field: ${field}`,
      });
      continue;
    }

    if (field === 'schema-version') {
      if (!rawValue.trim()) {
        errors.push({
          field,
          code: 'empty-value',
          message: `Expected non-empty string for ${field}`,
        });
        continue;
      }

      if (rawValue.trim() !== PR_METADATA_SCHEMA_VERSION) {
        errors.push({
          field,
          code: 'unsupported-version',
          message: 'Unsupported wavemill-meta schema-version',
        });
        continue;
      }

      metadata['schema-version'] = PR_METADATA_SCHEMA_VERSION;
      continue;
    }

    if (STRING_FIELDS.has(field as keyof PrMetadata)) {
      if (!rawValue.trim()) {
        errors.push({
          field,
          code: 'empty-value',
          message: `Expected non-empty string for ${field}`,
        });
        continue;
      }

      metadata[field as 'task' | 'stack' | 'challengePairId' | 'route_schema'] = rawValue.trim();
      continue;
    }

    if (field === 'executed_route') {
      if (!rawValue.trim()) {
        errors.push({
          field,
          code: 'empty-value',
          message: 'Expected non-empty JSON for executed_route',
        });
        continue;
      }
      try {
        const parsed = JSON.parse(rawValue) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          errors.push({
            field,
            code: 'wrong-type',
            message: 'Expected a JSON object for executed_route',
          });
          continue;
        }
        metadata.executed_route = JSON.stringify(parsed);
      } catch {
        errors.push({
          field,
          code: 'wrong-type',
          message: 'Invalid JSON for executed_route',
        });
      }
      continue;
    }

    if (ARRAY_FIELDS.has(field as keyof PrMetadata)) {
      try {
        const parsed = JSON.parse(rawValue) as unknown;
        if (!isStringArray(parsed)) {
          errors.push({
            field,
            code: 'wrong-type',
            message: `Expected JSON string array for ${field}`,
          });
          continue;
        }

        metadata[field as 'depends_on' | 'depends_on_linear' | 'requires'] = parsed;
      } catch {
        errors.push({
          field,
          code: 'wrong-type',
          message: `Invalid JSON for ${field}`,
        });
      }
      continue;
    }

    if (field === 'risk') {
      if (rawValue === 'low' || rawValue === 'medium' || rawValue === 'high') {
        metadata.risk = rawValue;
      } else {
        errors.push({
          field,
          code: 'wrong-type',
          message: `Expected one of low, medium, high for ${field}`,
        });
      }
      continue;
    }

    if (field === 'challenge') {
      if (rawValue === 'true' || rawValue === 'false') {
        metadata.challenge = rawValue === 'true';
      } else {
        errors.push({
          field,
          code: 'wrong-type',
          message: `Expected boolean true/false for ${field}`,
        });
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, bodyWithoutBlock };
  }

  return { ok: true, metadata, bodyWithoutBlock };
}

export function validatePrMetadata(body: string): MetadataValidation {
  const { block } = extractMetadataBlock(body);
  if (block === null) {
    return { status: 'absent' };
  }

  const parsed = parsePrMetadata(body);
  if (!parsed.ok) {
    return { status: 'invalid', errors: parsed.errors };
  }

  return { status: 'valid', metadata: parsed.metadata };
}

export function validateMetadataFields(meta: PrMetadata): PrMetadataError[] {
  const errors: PrMetadataError[] = [];
  for (const key of Object.keys(meta)) {
    if (!FIELD_ORDER.includes(key as keyof PrMetadata)) {
      errors.push({
        field: key,
        code: 'unknown-field',
        message: `Unknown wavemill-meta field: ${key}`,
      });
    }
  }
  if (
    meta['schema-version'] !== undefined
    && meta['schema-version'] !== PR_METADATA_SCHEMA_VERSION
  ) {
    errors.push({
      field: 'schema-version',
      code: 'unsupported-version',
      message: 'Unsupported wavemill-meta schema-version',
    });
  }
  if (meta.executed_route !== undefined) {
    try {
      const parsed = JSON.parse(meta.executed_route) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        errors.push({
          field: 'executed_route',
          code: 'wrong-type',
          message: 'executed_route must be a JSON object string',
        });
      }
    } catch {
      errors.push({
        field: 'executed_route',
        code: 'wrong-type',
        message: 'executed_route is not valid JSON',
      });
    }
  }
  return errors;
}

export function renderPrMetadata(meta: PrMetadata): string {
  const fieldErrors = validateMetadataFields(meta);
  if (fieldErrors.length > 0) {
    throw new Error(fieldErrors.map((error) => error.message).join('; '));
  }

  const lines = FIELD_ORDER.flatMap((field) => {
    const value = meta[field];
    if (value === undefined) {
      return [];
    }

    if (Array.isArray(value)) {
      return `${field}: ${JSON.stringify(value)}`;
    }

    if (typeof value === 'boolean') {
      return `${field}: ${value ? 'true' : 'false'}`;
    }

    return `${field}: ${value}`;
  });

  return lines.length > 0
    ? `<!-- wavemill-meta\n${lines.join('\n')}\n-->`
    : '<!-- wavemill-meta\n\n-->';
}

export function updatePrMetadata(body: string, meta: PrMetadata): string {
  const { bodyWithoutBlock } = extractMetadataBlock(body);
  const rendered = renderPrMetadata(meta);

  if (!bodyWithoutBlock.trim()) {
    return rendered;
  }

  return `${bodyWithoutBlock.trimEnd()}\n\n${rendered}`;
}
