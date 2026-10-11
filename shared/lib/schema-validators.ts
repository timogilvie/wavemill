/**
 * Precompiled (Ajv standalone) schema validators and content-hash validation
 * stamps (HOK-3205).
 *
 * Compiling the hot schemas with Ajv costs ~1.7 s per TS tool spawn, and the
 * monitor makes ~20 such spawns per pass. This module removes that cost in
 * two layers:
 *
 * 1. **Standalone validators**: `tools/generate-schema-validators.ts` writes
 *    Ajv standalone code for each schema in {@link PRECOMPILED_SCHEMAS} to
 *    `shared/validators/<name>.validator.cjs`, plus a `.meta.json` recording
 *    the schema's sha256 and the Ajv options. {@link loadPrecompiledValidator}
 *    only serves the artifact when the schema bytes and options match the
 *    meta; any mismatch returns null so callers fall back to `ajv.compile`.
 *    `tools/check-schema-validators.ts` (in `test:preflight`) fails when an
 *    artifact drifts from its schema.
 * 2. **Validation stamps**: read-only loaders record an empty sentinel under
 *    `~/.wavemill/cache/schema-stamps/<scope>/<key>` once content with a given
 *    hash has passed full validation, so later spawns skip validation of the
 *    same bytes. `WAVEMILL_DISABLE_SCHEMA_STAMP=1` forces full validation.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** Repo root of this wavemill install. */
export const DEFAULT_REPO_ROOT = join(moduleDir, '..', '..');
/** Directory holding the committed standalone validator artifacts. */
export const DEFAULT_VALIDATORS_DIR = join(moduleDir, '..', 'validators');

export type AjvOptions = Record<string, unknown>;

/** Ajv entry point: draft-07 (`ajv`) or draft 2020-12 (`ajv/dist/2020`). */
export type AjvModuleId = 'ajv' | 'ajv/dist/2020';

export interface ValidationErrorLike {
  instancePath: string;
  keyword: string;
  message?: string;
  params?: Record<string, unknown>;
}

export type SchemaValidatorFunction = ((data: unknown) => boolean) & {
  errors?: ValidationErrorLike[] | null;
};

export interface PrecompiledSchemaSpec {
  /** Artifact basename under `shared/validators/`. */
  name: string;
  /** Schema path relative to the repo root. */
  schemaPath: string;
  /** Ajv options used at generation; runtime callers must request the same. */
  ajvOptions: AjvOptions;
  /** Ajv entry point; defaults to `ajv`. */
  ajvModule?: AjvModuleId;
}

export interface PrecompiledValidatorMeta {
  name: string;
  schemaPath: string;
  schemaSha256: string;
  codeSha256: string;
  ajvOptions: AjvOptions;
  ajvModule: AjvModuleId;
}

export const MODEL_REGISTRY_AJV_OPTIONS: AjvOptions = { allErrors: true };
export const WAVEMILL_CONFIG_AJV_OPTIONS: AjvOptions = { allErrors: true, strict: false };
export const EVAL_RECORD_AJV_OPTIONS: AjvOptions = { allErrors: true, strict: false, validateFormats: false };

/** Schemas on the TS tool hot path that ship a precompiled validator. */
export const PRECOMPILED_SCHEMAS: readonly PrecompiledSchemaSpec[] = [
  {
    name: 'model-registry',
    schemaPath: 'shared/schemas/model-registry.schema.json',
    ajvOptions: MODEL_REGISTRY_AJV_OPTIONS,
  },
  {
    name: 'wavemill-config',
    schemaPath: 'wavemill-config.schema.json',
    ajvOptions: WAVEMILL_CONFIG_AJV_OPTIONS,
  },
  {
    name: 'eval-record',
    schemaPath: 'shared/lib/eval-schema.json',
    ajvOptions: EVAL_RECORD_AJV_OPTIONS,
    ajvModule: 'ajv/dist/2020',
  },
];

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeOptions(options: AjvOptions): string {
  return JSON.stringify(Object.keys(options).sort().map((key) => [key, options[key]]));
}

function sameOptions(a: AjvOptions, b: AjvOptions): boolean {
  return normalizeOptions(a) === normalizeOptions(b);
}

export function validatorCodePath(name: string, validatorsDir = DEFAULT_VALIDATORS_DIR): string {
  return join(validatorsDir, `${name}.validator.cjs`);
}

export function validatorMetaPath(name: string, validatorsDir = DEFAULT_VALIDATORS_DIR): string {
  return join(validatorsDir, `${name}.validator.meta.json`);
}

function readMeta(path: string): PrecompiledValidatorMeta | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as PrecompiledValidatorMeta;
  } catch {
    return null;
  }
}

/**
 * Compile a schema with Ajv at runtime. Ajv is required lazily so the
 * precompiled path never pays its module-load cost.
 */
export function compileSchemaValidator(
  schema: unknown,
  ajvOptions: AjvOptions,
  ajvModuleId: AjvModuleId = 'ajv',
): SchemaValidatorFunction {
  const ajvModule = require(ajvModuleId);
  const AjvCtor = (ajvModule.default || ajvModule) as new (options: AjvOptions) => {
    compile(schema: unknown): SchemaValidatorFunction;
  };
  return new AjvCtor(ajvOptions).compile(schema);
}

const loadedValidators = new Map<string, SchemaValidatorFunction>();

/**
 * Return the committed standalone validator for `name` when it was generated
 * from exactly `schemaText` with exactly `ajvOptions`; otherwise null.
 *
 * Never throws: a missing, stale, or unloadable artifact is a cache miss and
 * the caller compiles the schema itself.
 */
export function loadPrecompiledValidator(
  name: string,
  schemaText: string,
  ajvOptions: AjvOptions,
  ajvModuleId: AjvModuleId = 'ajv',
  validatorsDir = DEFAULT_VALIDATORS_DIR,
): SchemaValidatorFunction | null {
  const schemaSha256 = sha256(schemaText);
  const cacheKey = [validatorsDir, name, schemaSha256, ajvModuleId, normalizeOptions(ajvOptions)].join('\0');
  const cached = loadedValidators.get(cacheKey);
  if (cached) {
    return cached;
  }

  const meta = readMeta(validatorMetaPath(name, validatorsDir));
  if (
    !meta ||
    meta.schemaSha256 !== schemaSha256 ||
    (meta.ajvModule ?? 'ajv') !== ajvModuleId ||
    !sameOptions(meta.ajvOptions ?? {}, ajvOptions)
  ) {
    return null;
  }
  try {
    const loaded = require(validatorCodePath(name, validatorsDir));
    const validate = (typeof loaded === 'function' ? loaded : loaded?.default) as SchemaValidatorFunction | undefined;
    if (typeof validate !== 'function') {
      return null;
    }
    loadedValidators.set(cacheKey, validate);
    return validate;
  } catch {
    return null;
  }
}

/** Ajv standalone source and meta for one schema spec. */
export function generatePrecompiledValidator(
  spec: PrecompiledSchemaSpec,
  repoRoot = DEFAULT_REPO_ROOT,
): { code: string; meta: PrecompiledValidatorMeta } {
  const schemaText = readFileSync(join(repoRoot, spec.schemaPath), 'utf-8');
  const ajvModuleId = spec.ajvModule ?? 'ajv';
  const ajvModule = require(ajvModuleId);
  const AjvCtor = ajvModule.default || ajvModule;
  const standaloneModule = require('ajv/dist/standalone');
  const standaloneCode = standaloneModule.default || standaloneModule;

  const ajv = new AjvCtor({ ...spec.ajvOptions, code: { source: true } });
  const validate = ajv.compile(JSON.parse(schemaText));
  const header =
    `// GENERATED by tools/generate-schema-validators.ts from ${spec.schemaPath} — do not edit.\n` +
    `// schema sha256: ${sha256(schemaText)}\n`;
  const code = `${header}${standaloneCode(ajv, validate)}\n`;
  return {
    code,
    meta: {
      name: spec.name,
      schemaPath: spec.schemaPath,
      schemaSha256: sha256(schemaText),
      codeSha256: sha256(code),
      ajvOptions: spec.ajvOptions,
      ajvModule: ajvModuleId,
    },
  };
}

/** Regenerate every artifact in `specs`. Returns the written file paths. */
export function writePrecompiledValidators(
  repoRoot = DEFAULT_REPO_ROOT,
  validatorsDir = DEFAULT_VALIDATORS_DIR,
  specs: readonly PrecompiledSchemaSpec[] = PRECOMPILED_SCHEMAS,
): string[] {
  mkdirSync(validatorsDir, { recursive: true });
  const written: string[] = [];
  for (const spec of specs) {
    const { code, meta } = generatePrecompiledValidator(spec, repoRoot);
    const codePath = validatorCodePath(spec.name, validatorsDir);
    const metaPath = validatorMetaPath(spec.name, validatorsDir);
    writeFileSync(codePath, code);
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    written.push(codePath, metaPath);
  }
  return written;
}

/**
 * Verify that each committed artifact matches its schema (sha256 + options)
 * and was not hand-edited (code sha256). Returns human-readable problems;
 * an empty array means every artifact is in sync.
 *
 * Generated code is deliberately not regenerated and diffed: its bytes depend
 * on the installed Ajv patch version, which `^8` lets drift across machines.
 */
export function checkPrecompiledValidators(
  repoRoot = DEFAULT_REPO_ROOT,
  validatorsDir = DEFAULT_VALIDATORS_DIR,
  specs: readonly PrecompiledSchemaSpec[] = PRECOMPILED_SCHEMAS,
): string[] {
  const problems: string[] = [];
  for (const spec of specs) {
    const schemaFile = join(repoRoot, spec.schemaPath);
    const metaPath = validatorMetaPath(spec.name, validatorsDir);
    const codePath = validatorCodePath(spec.name, validatorsDir);

    let schemaText: string;
    try {
      schemaText = readFileSync(schemaFile, 'utf-8');
      JSON.parse(schemaText);
    } catch (error) {
      problems.push(`${spec.schemaPath}: schema is unreadable or not valid JSON (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const meta = readMeta(metaPath);
    if (!meta) {
      problems.push(`${spec.name}: missing or unreadable ${metaPath}`);
      continue;
    }
    if (!existsSync(codePath)) {
      problems.push(`${spec.name}: missing ${codePath}`);
      continue;
    }
    if (meta.schemaSha256 !== sha256(schemaText)) {
      problems.push(`${spec.name}: ${spec.schemaPath} changed since the validator was generated (schema sha256 mismatch)`);
    }
    if (!sameOptions(meta.ajvOptions ?? {}, spec.ajvOptions) || (meta.ajvModule ?? 'ajv') !== (spec.ajvModule ?? 'ajv')) {
      problems.push(`${spec.name}: Ajv options or module in meta differ from PRECOMPILED_SCHEMAS`);
    }
    if (meta.codeSha256 !== sha256(readFileSync(codePath))) {
      problems.push(`${spec.name}: ${codePath} was modified after generation (code sha256 mismatch)`);
    }
  }
  return problems;
}

// ── Validation stamps ────────────────────────────────────────────────────────

export function schemaStampRoot(): string {
  return process.env.WAVEMILL_SCHEMA_STAMP_DIR || join(homedir(), '.wavemill', 'cache', 'schema-stamps');
}

function stampsDisabled(): boolean {
  return process.env.WAVEMILL_DISABLE_SCHEMA_STAMP === '1';
}

function stampPath(scope: string, key: string): string {
  return join(schemaStampRoot(), scope, key);
}

/** True when content identified by `key` already passed full validation. */
export function hasValidationStamp(scope: string, key: string): boolean {
  if (stampsDisabled()) {
    return false;
  }
  return existsSync(stampPath(scope, key));
}

/**
 * Record that content identified by `key` passed full validation. Written via
 * tmp + rename so a crashed writer never leaves a sentinel behind. Failures
 * are swallowed: a missing stamp only costs a re-validation.
 */
export function recordValidationStamp(scope: string, key: string): void {
  if (stampsDisabled()) {
    return;
  }
  const target = stampPath(scope, key);
  try {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, '');
    renameSync(tmp, target);
  } catch {
    // Best effort.
  }
}
