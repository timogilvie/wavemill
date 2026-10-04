export type RiskLevel = 'low' | 'medium' | 'high';

export const PR_METADATA_SCHEMA_VERSION = '1';
/**
 * `route_schema` version written by current wavemill installs.
 *
 * - 1 (HOK-2945): `executed_route` only.
 * - 2 (HOK-3098): adds the optional `route_decision` sibling. `executed_route`
 *   is unchanged, so its own payload `schema` stays at
 *   {@link EXECUTED_ROUTE_SCHEMA_VERSION}.
 */
export const PR_ROUTE_METADATA_SCHEMA_VERSION = 2;
/** Every `route_schema` value readers accept; older PR bodies keep parsing. */
export const SUPPORTED_PR_ROUTE_METADATA_SCHEMA_VERSIONS: readonly PrRouteSchemaVersion[] = [1, 2];
/** Payload version inside `executed_route` (independent of `route_schema`). */
export const EXECUTED_ROUTE_SCHEMA_VERSION = 1;
export const MAX_EXECUTED_ROUTE_BYTES = 6_000;
/** Independent byte cap for the `route_decision` payload. */
export const MAX_ROUTE_DECISION_BYTES = 1_500;

export type PrRouteSchemaVersion = 1 | 2;

/**
 * Where the router's decision came from (HOK-3098).
 * `fallback` means Hokusai was attempted and rejected; see `fallback_reason`.
 */
export type RouteDecisionSource = 'hokusai' | 'local' | 'fallback';
export const ROUTE_DECISION_SOURCES: readonly RouteDecisionSource[] = ['hokusai', 'local', 'fallback'];

/** Typed reason a Hokusai attempt was rejected in favour of local routing. */
export type RouteFallbackReason = 'null_response' | 'disabled_model';
export const ROUTE_FALLBACK_REASONS: readonly RouteFallbackReason[] = ['null_response', 'disabled_model'];

/**
 * What the router decided for a task (HOK-3098), as published in the
 * `route_decision` field of the `wavemill-meta` block. Recorded once at
 * routing time and never rewritten; `executed_route` records what ran.
 *
 * Contains ids, model names, versions and enums only — no raw content.
 */
export interface PrRouteDecision {
  /** Stable id for this decision: the task traceId when unused, else a UUID. */
  decision_id: string;
  /** Task traceId (HOK-2259) when it differs from `decision_id`. */
  trace_id?: string;
  source: RouteDecisionSource;
  /** Present only when `source === 'fallback'`. */
  fallback_reason?: RouteFallbackReason;
  /** Hokusai Model 30 version when exposed, else the local router version. */
  policy_version: string;
  /** Route as decided, before any later escalation or override. */
  recommended: {
    planner: string;
    coder: string;
    reviewer: string;
  };
  /** ISO 8601 timestamp of the decision. */
  decided_at: string;
  /** Prior `decision_id` when this decision is a genuine re-route. */
  supersedes?: string;
}

export type PrRouteStageStatus = 'executed' | 'inherited' | 'not_run' | 'unknown';
export type PrRouteEvidenceStatus = 'direct' | 'missing' | 'contradicted' | 'inherited';

export interface PrRouteEvidence {
  source: string;
  status?: PrRouteEvidenceStatus;
  stage?: 'planning' | 'coding' | 'review';
  head_sha?: string;
  reason?: string;
  source_issue?: string;
  source_head_sha?: string;
}

export interface PrRouteIdentity {
  requested_selector?: string;
  resolved_model?: string;
  adapter?: string;
  source?: 'route' | 'artifact' | 'inherited' | 'derived' | 'unknown';
  fallback_reason?: string;
  pinned?: boolean;
  conflict?: {
    other_source: string;
    other_resolved_model: string;
    detail: string;
  };
}

export interface PrRouteRole extends PrRouteIdentity {
  status: PrRouteStageStatus;
  evidence: PrRouteEvidence;
}

export interface PrRouteReviewerRole {
  status: PrRouteStageStatus;
  evidence: PrRouteEvidence;
  orchestrator?: PrRouteIdentity;
  substantiveAnalysis?: PrRouteIdentity;
  remediation?: PrRouteIdentity | null;
}

export interface ExecutedPrRoute {
  schema: typeof EXECUTED_ROUTE_SCHEMA_VERSION;
  issue: string;
  head_sha: string;
  planner: PrRouteRole;
  coder: PrRouteRole;
  reviewer: PrRouteReviewerRole;
}

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
  route_schema?: PrRouteSchemaVersion;
  executed_route?: ExecutedPrRoute;
  route_decision?: PrRouteDecision;
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
const STRING_FIELDS = new Set<keyof PrMetadata>(['task', 'stack', 'challengePairId']);
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
  'route_decision',
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortedRecord(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item !== undefined) {
      out[key] = normalizeJsonValue(item);
    }
  }
  return out;
}

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item));
  }
  if (isRecord(value)) {
    return sortedRecord(value);
  }
  return value;
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value));
}

function isSafePublicString(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false;
  if (/[\r\n\t\0]/.test(value)) return false;
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return false;
  if (value.includes('/Users/') || value.includes('/tmp/') || value.includes('\\Users\\')) return false;
  if (/(token|secret|password|api[_-]?key)=/i.test(value)) return false;
  return true;
}

function validatePublicStrings(
  value: unknown,
  path: string,
  errors: PrMetadataError[],
  field = 'executed_route',
): void {
  if (typeof value === 'string') {
    if (!isSafePublicString(value)) {
      errors.push({
        field,
        code: 'wrong-type',
        message: `Unsafe public value in ${field} at ${path}`,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validatePublicStrings(item, `${path}[${index}]`, errors, field));
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      validatePublicStrings(item, `${path}.${key}`, errors, field);
    }
  }
}

function isSupportedRouteSchema(value: unknown): value is PrRouteSchemaVersion {
  return (SUPPORTED_PR_ROUTE_METADATA_SCHEMA_VERSIONS as readonly unknown[]).includes(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedSet.has(key));
}

function pushUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  fieldPath: string,
  errors: PrMetadataError[],
): void {
  for (const key of unknownKeys(value, allowed)) {
    errors.push({
      field: 'executed_route',
      code: 'unknown-field',
      message: `Unknown executed_route field at ${fieldPath}.${key}`,
    });
  }
}

function validateEvidence(value: unknown, fieldPath: string, errors: PrMetadataError[]): void {
  if (!isRecord(value)) {
    errors.push({ field: 'executed_route', code: 'wrong-type', message: `Expected evidence object at ${fieldPath}` });
    return;
  }
  pushUnknownKeys(value, ['source', 'status', 'stage', 'head_sha', 'reason', 'source_issue', 'source_head_sha'], fieldPath, errors);
  if (typeof value.source !== 'string' || !value.source.trim()) {
    errors.push({ field: 'executed_route', code: 'empty-value', message: `Expected non-empty evidence source at ${fieldPath}.source` });
  }
  if (
    value.status !== undefined
    && value.status !== 'direct'
    && value.status !== 'missing'
    && value.status !== 'contradicted'
    && value.status !== 'inherited'
  ) {
    errors.push({ field: 'executed_route', code: 'wrong-type', message: `Expected valid evidence status at ${fieldPath}.status` });
  }
  if (
    value.stage !== undefined
    && value.stage !== 'planning'
    && value.stage !== 'coding'
    && value.stage !== 'review'
  ) {
    errors.push({ field: 'executed_route', code: 'wrong-type', message: `Expected valid evidence stage at ${fieldPath}.stage` });
  }
}

function validateIdentity(
  value: unknown,
  fieldPath: string,
  errors: PrMetadataError[],
  extraAllowed: readonly string[] = [],
): void {
  if (!isRecord(value)) {
    errors.push({ field: 'executed_route', code: 'wrong-type', message: `Expected identity object at ${fieldPath}` });
    return;
  }
  pushUnknownKeys(
    value,
    ['requested_selector', 'resolved_model', 'adapter', 'source', 'fallback_reason', 'pinned', 'conflict', ...extraAllowed],
    fieldPath,
    errors,
  );
  if (value.pinned !== undefined && typeof value.pinned !== 'boolean') {
    errors.push({ field: 'executed_route', code: 'wrong-type', message: `Expected boolean at ${fieldPath}.pinned` });
  }
  if (
    value.source !== undefined
    && value.source !== 'route'
    && value.source !== 'artifact'
    && value.source !== 'inherited'
    && value.source !== 'derived'
    && value.source !== 'unknown'
  ) {
    errors.push({ field: 'executed_route', code: 'wrong-type', message: `Expected valid identity source at ${fieldPath}.source` });
  }
  if (value.source === 'derived' && value.pinned === true) {
    errors.push({ field: 'executed_route', code: 'wrong-type', message: `Derived identity cannot be pinned at ${fieldPath}` });
  }
  if (value.conflict !== undefined) {
    if (!isRecord(value.conflict)) {
      errors.push({ field: 'executed_route', code: 'wrong-type', message: `Expected conflict object at ${fieldPath}.conflict` });
    } else {
      pushUnknownKeys(value.conflict, ['other_source', 'other_resolved_model', 'detail'], `${fieldPath}.conflict`, errors);
    }
  }
}

function validateRole(value: unknown, role: 'planner' | 'coder', errors: PrMetadataError[]): void {
  if (!isRecord(value)) {
    errors.push({ field: 'executed_route', code: 'wrong-type', message: `Expected ${role} route object` });
    return;
  }
  pushUnknownKeys(
    value,
    ['status', 'evidence', 'requested_selector', 'resolved_model', 'adapter', 'source', 'fallback_reason', 'pinned', 'conflict'],
    role,
    errors,
  );
  if (value.status !== 'executed' && value.status !== 'inherited' && value.status !== 'not_run' && value.status !== 'unknown') {
    errors.push({ field: 'executed_route', code: 'wrong-type', message: `Expected valid status for ${role}` });
  }
  validateEvidence(value.evidence, `${role}.evidence`, errors);
  validateIdentity(value, role, errors, ['status', 'evidence']);
  if ((value.status === 'executed' || value.status === 'inherited') && typeof value.resolved_model !== 'string') {
    errors.push({ field: 'executed_route', code: 'wrong-type', message: `Expected resolved_model for ${role} ${value.status}` });
  }
}

function validateReviewer(value: unknown, errors: PrMetadataError[]): void {
  if (!isRecord(value)) {
    errors.push({ field: 'executed_route', code: 'wrong-type', message: 'Expected reviewer route object' });
    return;
  }
  pushUnknownKeys(value, ['status', 'evidence', 'orchestrator', 'substantiveAnalysis', 'remediation'], 'reviewer', errors);
  if (value.status !== 'executed' && value.status !== 'inherited' && value.status !== 'not_run' && value.status !== 'unknown') {
    errors.push({ field: 'executed_route', code: 'wrong-type', message: 'Expected valid status for reviewer' });
  }
  validateEvidence(value.evidence, 'reviewer.evidence', errors);
  if (value.status === 'executed') {
    if (value.orchestrator === undefined) {
      errors.push({ field: 'executed_route', code: 'empty-value', message: 'Expected reviewer.orchestrator for executed review' });
    }
    if (value.substantiveAnalysis === undefined) {
      errors.push({ field: 'executed_route', code: 'empty-value', message: 'Expected reviewer.substantiveAnalysis for executed review' });
    }
  }
  if (value.orchestrator !== undefined) validateIdentity(value.orchestrator, 'reviewer.orchestrator', errors);
  if (value.substantiveAnalysis !== undefined) validateIdentity(value.substantiveAnalysis, 'reviewer.substantiveAnalysis', errors);
  if (value.remediation !== undefined && value.remediation !== null) validateIdentity(value.remediation, 'reviewer.remediation', errors);
}

export function validateExecutedRoute(value: unknown): PrMetadataError[] {
  const errors: PrMetadataError[] = [];
  if (!isRecord(value)) {
    return [{ field: 'executed_route', code: 'wrong-type', message: 'Expected executed_route JSON object' }];
  }
  pushUnknownKeys(value, ['schema', 'issue', 'head_sha', 'planner', 'coder', 'reviewer'], 'executed_route', errors);
  if (value.schema !== EXECUTED_ROUTE_SCHEMA_VERSION) {
    errors.push({
      field: 'executed_route',
      code: 'unsupported-version',
      message: 'Unsupported executed_route schema',
    });
  }
  if (typeof value.issue !== 'string' || !value.issue.trim()) {
    errors.push({ field: 'executed_route', code: 'empty-value', message: 'Expected executed_route issue' });
  }
  if (typeof value.head_sha !== 'string' || !value.head_sha.trim()) {
    errors.push({ field: 'executed_route', code: 'empty-value', message: 'Expected executed_route head_sha' });
  }
  validateRole(value.planner, 'planner', errors);
  validateRole(value.coder, 'coder', errors);
  validateReviewer(value.reviewer, errors);
  validatePublicStrings(value, 'executed_route', errors);
  const bytes = Buffer.byteLength(stableJsonStringify(value), 'utf-8');
  if (bytes > MAX_EXECUTED_ROUTE_BYTES) {
    errors.push({
      field: 'executed_route',
      code: 'wrong-type',
      message: `executed_route exceeds ${MAX_EXECUTED_ROUTE_BYTES} bytes`,
    });
  }
  return errors;
}

const ROUTE_DECISION_KEYS = [
  'decision_id',
  'trace_id',
  'source',
  'fallback_reason',
  'policy_version',
  'recommended',
  'decided_at',
  'supersedes',
] as const;
const ROUTE_DECISION_ROLES = ['planner', 'coder', 'reviewer'] as const;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function routeDecisionError(
  code: PrMetadataError['code'],
  message: string,
): PrMetadataError {
  return { field: 'route_decision', code, message };
}

/**
 * Validates a `route_decision` payload (HOK-3098). Mirrors
 * {@link validateExecutedRoute}: closed key set, enum checks, public-string
 * safety (no paths, tokens or free text) and an independent byte budget.
 * Recommended model ids may be empty strings when the router had no viable
 * candidate for a stage; every other string must be non-empty.
 */
export function validateRouteDecision(value: unknown): PrMetadataError[] {
  if (!isRecord(value)) {
    return [routeDecisionError('wrong-type', 'Expected route_decision JSON object')];
  }
  const errors: PrMetadataError[] = [];
  for (const key of unknownKeys(value, ROUTE_DECISION_KEYS)) {
    errors.push(routeDecisionError('unknown-field', `Unknown route_decision field at route_decision.${key}`));
  }

  for (const key of ['decision_id', 'policy_version', 'decided_at'] as const) {
    if (typeof value[key] !== 'string' || !value[key].trim()) {
      errors.push(routeDecisionError('empty-value', `Expected non-empty route_decision.${key}`));
    }
  }
  for (const key of ['trace_id', 'supersedes'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key].trim())) {
      errors.push(routeDecisionError('wrong-type', `Expected non-empty string at route_decision.${key}`));
    }
  }
  if (typeof value.decided_at === 'string' && value.decided_at.trim()
    && (!ISO_TIMESTAMP_PATTERN.test(value.decided_at) || Number.isNaN(Date.parse(value.decided_at)))) {
    errors.push(routeDecisionError('wrong-type', 'Expected ISO 8601 timestamp at route_decision.decided_at'));
  }

  if (!(ROUTE_DECISION_SOURCES as readonly unknown[]).includes(value.source)) {
    errors.push(routeDecisionError('wrong-type', 'Expected route_decision.source to be one of hokusai, local, fallback'));
  }
  if (value.fallback_reason !== undefined
    && !(ROUTE_FALLBACK_REASONS as readonly unknown[]).includes(value.fallback_reason)) {
    errors.push(routeDecisionError('wrong-type', 'Expected valid route_decision.fallback_reason'));
  }
  if (value.source === 'fallback' && value.fallback_reason === undefined) {
    errors.push(routeDecisionError('empty-value', 'route_decision.source fallback requires fallback_reason'));
  }
  if (value.source !== 'fallback' && value.fallback_reason !== undefined) {
    errors.push(routeDecisionError('wrong-type', 'route_decision.fallback_reason is only valid for source fallback'));
  }

  const recommended = value.recommended;
  if (!isRecord(recommended)) {
    errors.push(routeDecisionError('wrong-type', 'Expected route_decision.recommended object'));
  } else {
    for (const key of unknownKeys(recommended, ROUTE_DECISION_ROLES)) {
      errors.push(routeDecisionError('unknown-field', `Unknown route_decision field at route_decision.recommended.${key}`));
    }
    for (const role of ROUTE_DECISION_ROLES) {
      if (typeof recommended[role] !== 'string') {
        errors.push(routeDecisionError('wrong-type', `Expected string at route_decision.recommended.${role}`));
      }
    }
  }

  // Empty recommended roles are legitimate (no viable candidate); every other
  // string goes through the shared public-value gate.
  const nonEmptyStrings = JSON.parse(JSON.stringify(value, (_key, item) => (item === '' ? undefined : item))) as unknown;
  validatePublicStrings(nonEmptyStrings, 'route_decision', errors, 'route_decision');

  const bytes = Buffer.byteLength(stableJsonStringify(value), 'utf-8');
  if (bytes > MAX_ROUTE_DECISION_BYTES) {
    errors.push(routeDecisionError('wrong-type', `route_decision exceeds ${MAX_ROUTE_DECISION_BYTES} bytes`));
  }
  return errors;
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

    if (field === 'route_schema') {
      if (!rawValue.trim()) {
        errors.push({
          field,
          code: 'empty-value',
          message: `Expected non-empty number for ${field}`,
        });
        continue;
      }

      const routeSchema = Number(rawValue.trim());
      if (!/^\d+$/.test(rawValue.trim()) || !isSupportedRouteSchema(routeSchema)) {
        errors.push({
          field,
          code: 'unsupported-version',
          message: 'Unsupported wavemill-meta route_schema',
        });
        continue;
      }

      metadata.route_schema = routeSchema;
      continue;
    }

    if (field === 'executed_route') {
      try {
        const parsed = JSON.parse(rawValue) as unknown;
        const routeErrors = validateExecutedRoute(parsed);
        if (routeErrors.length > 0) {
          errors.push(...routeErrors);
          continue;
        }
        metadata.executed_route = parsed as ExecutedPrRoute;
      } catch {
        errors.push({
          field,
          code: 'wrong-type',
          message: `Invalid JSON for ${field}`,
        });
      }
      continue;
    }

    if (field === 'route_decision') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawValue) as unknown;
      } catch {
        errors.push({
          field,
          code: 'wrong-type',
          message: `Invalid JSON for ${field}`,
        });
        continue;
      }
      const decisionErrors = validateRouteDecision(parsed);
      if (decisionErrors.length > 0) {
        errors.push(...decisionErrors);
        continue;
      }
      metadata.route_decision = parsed as PrRouteDecision;
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

      metadata[field as 'task' | 'stack' | 'challengePairId'] = rawValue.trim();
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

  errors.push(...validateMetadataFields(metadata));

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
  if (parsed.ok === false) {
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
  if (
    meta.route_schema !== undefined
    && !isSupportedRouteSchema(meta.route_schema)
  ) {
    errors.push({
      field: 'route_schema',
      code: 'unsupported-version',
      message: 'Unsupported wavemill-meta route_schema',
    });
  }
  if (meta.executed_route !== undefined && meta.route_schema === undefined) {
    errors.push({
      field: 'route_schema',
      code: 'empty-value',
      message: 'executed_route requires route_schema',
    });
  }
  if (meta.route_schema !== undefined && meta.executed_route === undefined) {
    errors.push({
      field: 'executed_route',
      code: 'empty-value',
      message: 'route_schema requires executed_route',
    });
  }
  if (meta.executed_route !== undefined) {
    errors.push(...validateExecutedRoute(meta.executed_route));
  }
  if (meta.route_decision !== undefined) {
    if (meta.route_schema === undefined || meta.route_schema < 2) {
      errors.push({
        field: 'route_decision',
        code: 'unsupported-version',
        message: 'route_decision requires route_schema 2',
      });
    }
    errors.push(...validateRouteDecision(meta.route_decision));
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

    if (field === 'executed_route' || field === 'route_decision') {
      return `${field}: ${stableJsonStringify(value)}`;
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
