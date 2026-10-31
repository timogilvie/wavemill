/**
 * Fresh-read integrity checks for wavemill config and schema files.
 *
 * This detector intentionally avoids loadWavemillConfig(): that loader caches a
 * successful config for the life of the process, while the observer needs to
 * detect a schema/config edit that happens after startup.
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage } from './error-utils.ts';

export type ConfigIntegrityKind = 'parse-error' | 'schema-compile-error' | 'schema-missing' | 'validation-error';

export interface ConfigIntegrityIssue {
  file: string;
  kind: ConfigIntegrityKind;
  message: string;
  position?: number;
  line?: number;
  column?: number;
  excerpt?: string;
}

interface ValidationError {
  instancePath?: string;
  message?: string;
  keyword?: string;
  params?: Record<string, unknown>;
}

type ValidatorFunction = ((data: unknown) => boolean) & {
  errors?: ValidationError[] | null;
};

type AjvCtor = new (options: { allErrors: boolean; strict: boolean }) => {
  compile(schema: unknown): ValidatorFunction;
};

interface CachedValidator {
  validator: ValidatorFunction;
  mtimeMs: number;
  size: number;
}

export interface LocatedJsonSyntaxError {
  position?: number;
  line?: number;
  column?: number;
}

const compiledValidators = new Map<string, CachedValidator>();
let ajvUnavailable = false;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMergeConfig(base: unknown, overlay: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay;
  const result: Record<string, unknown> = { ...base };
  for (const [key, overlayValue] of Object.entries(overlay)) {
    const baseValue = result[key];
    if (isPlainObject(baseValue) && isPlainObject(overlayValue)) {
      result[key] = deepMergeConfig(baseValue, overlayValue);
    } else {
      result[key] = overlayValue;
    }
  }
  return result;
}

function canonicalSchemaPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'wavemill-config.schema.json');
}

function resolveSchemaPath(repoDir: string): string {
  const worktreeSchemaPath = resolve(repoDir, 'wavemill-config.schema.json');
  return existsSync(worktreeSchemaPath) ? worktreeSchemaPath : canonicalSchemaPath();
}

function schemaFingerprint(schemaPath: string): { mtimeMs: number; size: number } | null {
  try {
    const stats = statSync(schemaPath);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
}

function loadAjvCtor(): AjvCtor | null {
  if (ajvUnavailable) {
    return null;
  }
  const require = createRequire(import.meta.url);
  try {
    const ajvModule = require('ajv');
    return (ajvModule.default || ajvModule) as AjvCtor;
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = errorMessage(err);
    if (
      code === 'MODULE_NOT_FOUND' ||
      code === 'ERR_MODULE_NOT_FOUND' ||
      /Cannot find package 'ajv'/.test(message) ||
      /Cannot find module 'ajv'/.test(message)
    ) {
      ajvUnavailable = true;
      return null;
    }
    throw err;
  }
}

/**
 * Extract position/line/column from a JSON.parse SyntaxError.
 *
 * Current Node includes both position and line/column in the message. The
 * fallback computes line/column from the position so older V8 messages still
 * point at the offending byte for operator repair.
 */
export function locateJsonSyntaxError(text: string, err: unknown): LocatedJsonSyntaxError {
  const message = errorMessage(err);
  const positionMatch = message.match(/\bposition\s+(\d+)\b/);
  const lineColumnMatch = message.match(/\(line\s+(\d+)\s+column\s+(\d+)\)/);
  const position = positionMatch ? Number.parseInt(positionMatch[1], 10) : undefined;
  if (lineColumnMatch) {
    return {
      position,
      line: Number.parseInt(lineColumnMatch[1], 10),
      column: Number.parseInt(lineColumnMatch[2], 10),
    };
  }
  if (position !== undefined && Number.isFinite(position)) {
    return { position, ...computeLineColumn(text, position) };
  }
  const tokenMatch = message.match(/Unexpected token '([^']+)'/);
  if (tokenMatch) {
    const tokenPosition = text.indexOf(tokenMatch[1]);
    if (tokenPosition >= 0) {
      return { position: tokenPosition, ...computeLineColumn(text, tokenPosition) };
    }
  }
  return {};
}

function computeLineColumn(text: string, position: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const end = Math.min(Math.max(position, 0), text.length);
  for (let index = 0; index < end; index += 1) {
    if (text[index] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function buildExcerpt(text: string, located: LocatedJsonSyntaxError): string | undefined {
  if (located.line !== undefined) {
    const line = text.split(/\r?\n/)[located.line - 1];
    if (line !== undefined) return truncateExcerpt(line.trim());
  }
  if (located.position !== undefined) {
    const start = Math.max(0, located.position - 60);
    const end = Math.min(text.length, located.position + 100);
    return truncateExcerpt(text.slice(start, end).replace(/\s+/g, ' ').trim());
  }
  return undefined;
}

function truncateExcerpt(value: string): string {
  return value.length > 160 ? `${value.slice(0, 157)}...` : value;
}

function parseJsonFile(path: string): { ok: true; value: unknown } | { ok: false; issue: ConfigIntegrityIssue } {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    return {
      ok: false,
      issue: {
        file: path,
        kind: 'parse-error',
        message: `Failed to read JSON file: ${errorMessage(err)}`,
      },
    };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    const located = locateJsonSyntaxError(text, err);
    return {
      ok: false,
      issue: {
        file: path,
        kind: 'parse-error',
        message: errorMessage(err),
        position: located.position,
        line: located.line,
        column: located.column,
        excerpt: buildExcerpt(text, located),
      },
    };
  }
}

function compileSchema(schemaPath: string, schema: unknown): { validator?: ValidatorFunction; issue?: ConfigIntegrityIssue } {
  const AjvCtor = loadAjvCtor();
  if (!AjvCtor) return {};

  const fingerprint = schemaFingerprint(schemaPath);
  const cached = compiledValidators.get(schemaPath);
  if (
    cached &&
    fingerprint &&
    cached.mtimeMs === fingerprint.mtimeMs &&
    cached.size === fingerprint.size
  ) {
    return { validator: cached.validator };
  }

  try {
    const ajv = new AjvCtor({ allErrors: true, strict: false });
    const validator = ajv.compile(schema);
    if (fingerprint) {
      compiledValidators.set(schemaPath, { validator, ...fingerprint });
    } else {
      compiledValidators.delete(schemaPath);
    }
    return { validator };
  } catch (err) {
    compiledValidators.delete(schemaPath);
    return {
      issue: {
        file: schemaPath,
        kind: 'schema-compile-error',
        message: errorMessage(err),
      },
    };
  }
}

function validationMessage(errors: ValidationError[] | null | undefined): string {
  const rendered = (errors ?? []).slice(0, 5).map((err) => {
    const path = err.instancePath || '/';
    const detail = err.message || err.keyword || 'failed validation';
    return `${path}: ${detail}`;
  });
  if (rendered.length === 0) return 'Config validation failed';
  return `Config validation failed: ${rendered.join('; ')}`;
}

/**
 * Validate the repository schema and config files without using config cache.
 */
export function detectRepoConfigIntegrity(repoDir: string): ConfigIntegrityIssue[] {
  const issues: ConfigIntegrityIssue[] = [];
  const schemaPath = resolveSchemaPath(repoDir);
  if (!existsSync(schemaPath)) {
    return [{
      file: schemaPath,
      kind: 'schema-missing',
      message: `Config schema not found at ${schemaPath}`,
    }];
  }

  const schemaParse = parseJsonFile(schemaPath);
  if (!schemaParse.ok) return [schemaParse.issue];

  const compiled = compileSchema(schemaPath, schemaParse.value);
  if (compiled.issue) {
    issues.push(compiled.issue);
  }

  const basePath = resolve(repoDir, '.wavemill-config.json');
  const localPath = resolve(repoDir, '.wavemill-config.local.json');
  const baseExists = existsSync(basePath);
  const localExists = existsSync(localPath);
  let base: unknown = {};
  let local: unknown;
  let configParsed = true;

  if (baseExists) {
    const parsed = parseJsonFile(basePath);
    if (parsed.ok) {
      base = parsed.value;
    } else {
      issues.push(parsed.issue);
      configParsed = false;
    }
  }

  if (localExists) {
    const parsed = parseJsonFile(localPath);
    if (parsed.ok) {
      local = parsed.value;
    } else {
      issues.push(parsed.issue);
      configParsed = false;
    }
  }

  if (compiled.validator && configParsed && (baseExists || localExists)) {
    const merged = localExists ? deepMergeConfig(base, local) : base;
    if (!compiled.validator(merged)) {
      issues.push({
        file: baseExists ? basePath : localPath,
        kind: 'validation-error',
        message: validationMessage(compiled.validator.errors),
      });
    }
  }

  return issues;
}

/**
 * Parse-check the user-level wavemill config. This file is tolerated by its
 * current runtime consumer, but surfacing corruption here prevents it from
 * masquerading as unrelated observer noise.
 */
export function detectGlobalConfigIntegrity(options: { homeDir?: string } = {}): ConfigIntegrityIssue[] {
  const path = join(options.homeDir ?? homedir(), '.wavemill', 'config.json');
  if (!existsSync(path)) return [];
  const parsed = parseJsonFile(path);
  return parsed.ok ? [] : [parsed.issue];
}
