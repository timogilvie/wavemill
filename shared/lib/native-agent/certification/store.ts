import {
  mkdirSync,
  openSync,
  fsyncSync,
  closeSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import Ajv from 'ajv';
import {
  CERTIFICATION_SCHEMA_VERSION,
  type AnyNativeCertificationArtifact,
  type NativeCertificationArtifact,
} from './schema.ts';
import { buildLegacyRepoCertificationPath } from './loader.ts';
import {
  isRollingProviderAlias,
  isValidCertificationPathSegment,
  resolveCertificationStorageIdentity,
} from './identity.ts';
import {
  buildCertificationPathFromRoot,
  resolveCertificationStorage,
  type CertificationStorageOptions,
} from './storage.ts';

const CERTIFICATION_JSON_SCHEMA = JSON.parse(
  readFileSync(new URL('./schema.json', import.meta.url), 'utf-8'),
);

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const validateSchema = ajv.compile(CERTIFICATION_JSON_SCHEMA);
const SECRET_OR_PATH_PATTERN = /\b(?:api[_-]?key|token|secret|password|bearer|authorization|\/users\/|\/home\/|[a-z]:\\|\.wavemill\/|worktrees\/|dropbox\/)\b/i;
const MIN_CERTIFIED_AT = Date.parse('2024-01-01T00:00:00.000Z');
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export type StoreErrorCode = 'not-found' | 'unreadable' | 'invalid-json' | 'schema-mismatch';

export interface StoreError {
  code: StoreErrorCode;
  message: string;
  path: string;
  detail?: Record<string, unknown>;
}

export type ReadResult =
  | { ok: true; artifact: AnyNativeCertificationArtifact }
  | { ok: false; error: StoreError };

/**
 * Read a certification artifact from an absolute file path.
 * Returns finer-grained error codes than loader.ts's loadCertification().
 */
export function readCertification(filePath: string): ReadResult {
  // Stat first to distinguish not-found from unreadable (e.g. directory)
  let isFile: boolean;
  try {
    const s = statSync(filePath);
    isFile = s.isFile();
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return {
        ok: false,
        error: {
          code: 'not-found',
          message: `certification artifact not found: ${filePath}`,
          path: filePath,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'unreadable',
        message: `could not stat certification artifact: ${filePath}: ${e.message}`,
        path: filePath,
        detail: { errno: e.errno, code: e.code },
      },
    };
  }

  if (!isFile) {
    return {
      ok: false,
      error: {
        code: 'unreadable',
        message: `path is not a regular file: ${filePath}`,
        path: filePath,
      },
    };
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    return {
      ok: false,
      error: {
        code: 'unreadable',
        message: `could not read certification artifact: ${filePath}: ${e.message}`,
        path: filePath,
        detail: { errno: e.errno, code: e.code },
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const e = err as SyntaxError;
    return {
      ok: false,
      error: {
        code: 'invalid-json',
        message: `certification artifact contains invalid JSON: ${filePath}: ${e.message}`,
        path: filePath,
        detail: { parseError: e.message },
      },
    };
  }

  const valid = validateSchema(parsed);
  if (!valid) {
    return {
      ok: false,
      error: {
        code: 'schema-mismatch',
        message: `certification artifact does not match schema: ${filePath}`,
        path: filePath,
        detail: { errors: validateSchema.errors },
      },
    };
  }

  return { ok: true, artifact: parsed as AnyNativeCertificationArtifact };
}

/**
 * Deterministic JSON serializer: sorts keys at every depth, preserves array
 * order, uses 2-space indent, ends with a trailing newline.
 * Exported so callers can assert shape stability in tests.
 */
export function serializeCertification(record: NativeCertificationArtifact): string {
  return JSON.stringify(sortKeys(record), null, 2) + '\n';
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      sorted[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return v;
}

/**
 * Serialize the record deterministically and write atomically via
 * <finalPath>.tmp-<pid>-<rand> → rename → finalPath.
 * Creates the parent directory if missing. Returns the final path.
 *
 * Throws on invalid path segments, fs write/rename failures, or records
 * that fail schema validation (write-side guard against corrupt artifacts).
 */
export function writeCertification(repoDir: string, record: NativeCertificationArtifact): string {
  validateCertificationForWrite(record, 'writeCertification');

  // buildLegacyRepoCertificationPath throws on bad segment chars (path traversal, etc.)
  const finalPath = buildLegacyRepoCertificationPath(repoDir, record.provider, record.model, record.suiteVersion);

  mkdirSync(dirname(finalPath), { recursive: true });

  const serialized = serializeCertification(record);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;

  writeFileSync(tmpPath, serialized, 'utf-8');

  // Best-effort fsync: durability is the rename boundary, but sync reduces
  // data loss window on crash between write and rename.
  try {
    const fd = openSync(tmpPath, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Swallow — rename is the durability boundary
  }

  try {
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }

  try {
    const dirFd = openSync(dirname(finalPath), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Best-effort directory fsync for filesystems that permit it.
  }

  return finalPath;
}

/**
 * Serialize the record deterministically and write atomically to the given
 * absolute path. Used by the shared identity-invalidation module to rewrite
 * a specific artifact in place (HOK-3143). Callers are responsible for
 * supplying a valid storage path.
 */
export function writeCertificationToAbsolutePath(
  finalPath: string,
  record: NativeCertificationArtifact,
): string {
  validateCertificationForWrite(record, 'writeCertificationToAbsolutePath');
  return writeCertificationToPath(finalPath, record);
}

function writeCertificationToPath(finalPath: string, record: NativeCertificationArtifact): string {
  mkdirSync(dirname(finalPath), { recursive: true });

  const serialized = serializeCertification(record);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;

  writeFileSync(tmpPath, serialized, 'utf-8');

  try {
    const fd = openSync(tmpPath, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Swallow — rename is the durability boundary
  }

  try {
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }

  try {
    const dirFd = openSync(dirname(finalPath), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Best-effort directory fsync for filesystems that permit it.
  }

  return finalPath;
}

export function writeScopedCertification(
  record: NativeCertificationArtifact,
  options: CertificationStorageOptions = {},
): string {
  validateCertificationForWrite(record, 'writeScopedCertification');

  const storage = resolveCertificationStorage(options);
  const finalPath = buildCertificationPathFromRoot(
    storage.root,
    record.provider,
    record.model,
    record.suiteVersion,
  );
  return writeCertificationToPath(finalPath, record);
}

export function writeGlobalCertification(
  record: NativeCertificationArtifact,
  options: Omit<CertificationStorageOptions, 'scope' | 'repoDir'> = {},
): string {
  return writeScopedCertification(record, { ...options, scope: 'global' });
}

/**
 * Validate write-side invariants before any filesystem mutation.
 *
 * Atomic write contract: callers provide an already canonical current artifact.
 * The store serializes stable JSON to a sibling temporary file, fsyncs it,
 * renames over the final path, then best-effort fsyncs the parent directory.
 * Artifacts containing secrets, local paths, non-canonical identity, or
 * implausible timestamps are rejected before the temporary file is created.
 */
export function validateCertificationForWrite(
  record: NativeCertificationArtifact,
  label = 'writeCertification',
): void {
  const valid = validateSchema(record);
  if (!valid) {
    const summary = (validateSchema.errors ?? [])
      .map(e => `${e.instancePath || '(root)'} ${e.message}`)
      .join('; ');
    throw new Error(`${label}: record fails schema validation: ${summary}`);
  }

  if (record.schemaVersion !== CERTIFICATION_SCHEMA_VERSION) {
    throw new Error(`${label}: only schemaVersion ${CERTIFICATION_SCHEMA_VERSION} artifacts may be written`);
  }

  const storageIdentity = resolveCertificationStorageIdentity(record.provider, record.model);
  if (record.provider !== storageIdentity.provider || record.model !== storageIdentity.model) {
    throw new Error(
      `${label}: artifact identity must be canonical storage identity ${storageIdentity.provider}/${storageIdentity.model}`,
    );
  }
  if (record.provider !== record.subject.providerId || record.model !== record.subject.providerModelId) {
    throw new Error(
      `${label}: artifact storage identity must match subject provider/model ${record.subject.providerId}/${record.subject.providerModelId}`,
    );
  }

  const certifiedAtMs = Date.parse(record.certifiedAt);
  if (!Number.isFinite(certifiedAtMs)) {
    throw new Error(`${label}: certifiedAt must be a valid ISO timestamp`);
  }
  const now = Date.now();
  if (certifiedAtMs < MIN_CERTIFIED_AT || certifiedAtMs > now + MAX_FUTURE_SKEW_MS) {
    throw new Error(`${label}: certifiedAt is outside the accepted publication window`);
  }
  if (record.expiresAt) {
    const expiresAtMs = Date.parse(record.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= certifiedAtMs) {
      throw new Error(`${label}: expiresAt must be after certifiedAt`);
    }
  }

  for (const limitation of record.knownLimitations ?? []) {
    if (SECRET_OR_PATH_PATTERN.test(limitation)) {
      throw new Error(`${label}: knownLimitations must not contain secrets or local paths`);
    }
  }

  if (record.liveCanary) {
    validateLiveCanaryForWrite(record, label);
  }

  // HOK-3143: an alias subject must pin a concrete target before it may be
  // written as a launch-eligible certificate. The write validator is the
  // single gate against publishing an unpinned alias (dry-run cannot resolve
  // one; identity-invalidation preserves the field for audit).
  if (isRollingProviderAlias(record.subject.providerNativeId) && !record.resolvedTarget) {
    throw new Error(
      `${label}: rolling alias subject ${record.subject.providerNativeId} requires resolvedTarget to be launchable`,
    );
  }
  if (record.resolvedTarget) {
    validateResolvedTargetForWrite(record, label);
  }
  if (record.identityInvalidation) {
    validateIdentityInvalidationForWrite(record, label);
  }
}

function validateResolvedTargetForWrite(record: NativeCertificationArtifact, label: string): void {
  const r = record.resolvedTarget!;
  if (r.requestedWireId !== record.subject.providerNativeId) {
    throw new Error(
      `${label}: resolvedTarget.requestedWireId ${r.requestedWireId} must match subject.providerNativeId ${record.subject.providerNativeId}`,
    );
  }
  const observedAtMs = Date.parse(r.observedAt);
  if (!Number.isFinite(observedAtMs)) {
    throw new Error(`${label}: resolvedTarget.observedAt must be a valid ISO timestamp`);
  }
  if (observedAtMs < MIN_CERTIFIED_AT || observedAtMs > Date.now() + MAX_FUTURE_SKEW_MS) {
    throw new Error(`${label}: resolvedTarget.observedAt is outside the accepted publication window`);
  }
  if (isRollingProviderAlias(r.model)) {
    throw new Error(
      `${label}: resolvedTarget.model must be a concrete model id, not another rolling alias (${r.model})`,
    );
  }
}

function validateIdentityInvalidationForWrite(record: NativeCertificationArtifact, label: string): void {
  const inv = record.identityInvalidation!;
  if (inv.requestedWireId !== record.subject.providerNativeId) {
    throw new Error(
      `${label}: identityInvalidation.requestedWireId ${inv.requestedWireId} must match subject.providerNativeId ${record.subject.providerNativeId}`,
    );
  }
  const atMs = Date.parse(inv.invalidatedAt);
  if (!Number.isFinite(atMs)) {
    throw new Error(`${label}: identityInvalidation.invalidatedAt must be a valid ISO timestamp`);
  }
}

/**
 * Write-side invariants for embedded live canary evidence.
 *
 * The canary must belong to the artifact it rides in (same storage identity
 * and suite), carry plausible timestamps, and contain no secrets, local
 * absolute paths, or traversal segments in any free-text or path field.
 */
function validateLiveCanaryForWrite(record: NativeCertificationArtifact, label: string): void {
  const canary = record.liveCanary!;

  if (canary.provider !== record.provider || canary.model !== record.model) {
    throw new Error(
      `${label}: liveCanary identity ${canary.provider}/${canary.model} must match artifact identity ${record.provider}/${record.model}`,
    );
  }
  if (canary.suiteVersion !== record.suiteVersion) {
    throw new Error(`${label}: liveCanary.suiteVersion must match artifact suiteVersion ${record.suiteVersion}`);
  }
  if (
    canary.providerNativeId !== record.subject.providerNativeId
    || canary.identityFingerprint !== record.subject.identityFingerprint
    || canary.catalogHash !== record.subject.catalogHash
  ) {
    throw new Error(`${label}: liveCanary resolved identity must match the artifact subject`);
  }

  const ranAtMs = Date.parse(canary.ranAt);
  if (!Number.isFinite(ranAtMs)) {
    throw new Error(`${label}: liveCanary.ranAt must be a valid ISO timestamp`);
  }
  if (ranAtMs < MIN_CERTIFIED_AT || ranAtMs > Date.now() + MAX_FUTURE_SKEW_MS) {
    throw new Error(`${label}: liveCanary.ranAt is outside the accepted publication window`);
  }
  if (canary.expiresAt) {
    const expiresAtMs = Date.parse(canary.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= ranAtMs) {
      throw new Error(`${label}: liveCanary.expiresAt must be after liveCanary.ranAt`);
    }
  }

  const textFields: Array<[string, string | undefined]> = [
    ['liveCanary.detail', canary.detail],
    ['liveCanary.lastInconclusiveAttempt.detail', canary.lastInconclusiveAttempt?.detail],
  ];
  for (const [name, value] of textFields) {
    if (value !== undefined && SECRET_OR_PATH_PATTERN.test(value)) {
      throw new Error(`${label}: ${name} must not contain secrets or local paths`);
    }
  }

  const pathLists: Array<[string, readonly string[] | undefined]> = [
    ['liveCanary.evidence.changedPaths', canary.evidence?.changedPaths],
    ['liveCanary.evidence.mutationToolNames', canary.evidence?.mutationToolNames],
  ];
  for (const [name, values] of pathLists) {
    for (const value of values ?? []) {
      if (SECRET_OR_PATH_PATTERN.test(value)) {
        throw new Error(`${label}: ${name} must not contain secrets or local paths`);
      }
      if (value.startsWith('/') || /^[a-z]:[\\/]/i.test(value) || value.split(/[\\/]/).includes('..')) {
        throw new Error(`${label}: ${name} must contain repo-relative paths only`);
      }
    }
  }
}

/**
 * Return absolute paths of all global certification `.json` artifacts.
 * The repoDir parameter is retained for API compatibility and is ignored.
 */
export function listCertifications(repoDir: string): string[] {
  void repoDir;
  return listGlobalCertifications();
}

export function listScopedCertifications(options: CertificationStorageOptions = {}): string[] {
  return listCertificationFilesUnderRoot(resolveCertificationStorage(options).root);
}

export function listGlobalCertifications(options: Omit<CertificationStorageOptions, 'scope' | 'repoDir'> = {}): string[] {
  return listScopedCertifications({ ...options, scope: 'global' });
}

export function listGlobalCertificationSuiteVersions(
  options: Omit<CertificationStorageOptions, 'scope' | 'repoDir'> = {},
): Record<string, number> {
  const root = resolveCertificationStorage({ ...options, scope: 'global' }).root;
  const counts: Record<string, number> = {};
  for (const filePath of listCertificationFilesUnderRoot(root)) {
    const parsed = parseCertificationPathUnderRoot(root, filePath);
    if (!parsed) continue;
    counts[parsed.suiteVersion] = (counts[parsed.suiteVersion] ?? 0) + 1;
  }
  return counts;
}

export function deleteGlobalCertification(
  input: { provider: string; model: string; suiteVersion: string; root?: string },
): void {
  const storage = resolveCertificationStorage({ scope: 'global', root: input.root });
  const filePath = buildCertificationPathFromRoot(
    storage.root,
    input.provider,
    input.model,
    input.suiteVersion,
  );
  unlinkSync(filePath);
  try { rmdirSync(dirname(filePath)); } catch { /* non-empty or already gone */ }
  try { rmdirSync(dirname(dirname(filePath))); } catch { /* non-empty or already gone */ }
}

export function parseCertificationArtifactPath(
  root: string,
  filePath: string,
): { provider: string; model: string; suiteVersion: string; path: string } | undefined {
  const parsed = parseCertificationPathUnderRoot(root, filePath);
  return parsed ? { ...parsed, path: filePath } : undefined;
}

function listCertificationFilesUnderRoot(baseDir: string): string[] {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const paths: string[] = [];

  for (const entry of entries) {
    const entryPath = join(baseDir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...listCertificationFilesUnderRoot(entryPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.json')) continue;
    paths.push(entryPath);
  }

  return paths;
}

function parseCertificationPathUnderRoot(
  root: string,
  filePath: string,
): { provider: string; model: string; suiteVersion: string } | undefined {
  const relativePath = relative(root, filePath).replace(/\\/g, '/');
  if (relativePath.startsWith('../') || relativePath === '..' || relativePath.startsWith('/')) {
    return undefined;
  }
  const parts = relativePath.split('/');
  if (parts.length !== 3) return undefined;

  const [provider, model, filename] = parts;
  if (!provider || !model || !filename.endsWith('.json')) return undefined;

  const suiteVersion = filename.slice(0, -'.json'.length);
  if (
    !isValidCertificationPathSegment(provider)
    || !isValidCertificationPathSegment(model)
    || !isValidCertificationPathSegment(suiteVersion)
  ) {
    return undefined;
  }

  return { provider, model, suiteVersion };
}
