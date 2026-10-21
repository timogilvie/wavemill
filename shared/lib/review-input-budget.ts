/**
 * Budgeted review input (HOK-3249).
 *
 * The review prompt is built to fit the reviewer instead of sending the whole
 * diff and recovering after an overflow. The budget comes from the reviewer's
 * `TransportAdapter` (HOK-3248): context window, hard character cap, reserved
 * output, harness overhead and the transport-calibrated token count.
 *
 * Files fill the budget in priority order — source, tests, docs/config, then
 * data/fixture/generated files — and stay verbatim while they fit. Source and
 * test files are never summarised: when they alone cannot fit, the result is
 * over budget and the adapter's preflight refuses with a typed
 * `context-exceeded` that the failure policy (HOK-3176) treats as terminal.
 * Docs/config and data files that do not fit — and data files above
 * {@link DATA_FILE_SUMMARY_THRESHOLD_BYTES} regardless — are replaced by a
 * deterministic summary: path, size, sha256, the result of validating the file
 * against its JSON schema when one is declared or discoverable, and, for
 * near-copies, a structural diff against the nearest sibling.
 *
 * The builder is pure and deterministic (no clocks, no randomness, sorted
 * iteration), so challenge arms with the same reviewer budget see
 * byte-identical review input (HOK-3156 route invariant).
 *
 * @module review-input-budget
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import type { TransportAdapter } from './model-adapters/transport-adapter.ts';
import { CONTEXT_WINDOW_SAFETY_MARGIN } from './native-agent/context-window-guard.ts';

/** 1 source, 2 tests, 3 docs/config, 4 data/fixture/generated. */
export type ReviewInputTier = 1 | 2 | 3 | 4;

/** Data/fixture/generated files whose diff exceeds this are always summarised. */
export const DATA_FILE_SUMMARY_THRESHOLD_BYTES = 50 * 1024;

/**
 * Headroom kept free below the computed budget for prompt text added after
 * the input is built (the stricter-JSON retry wrapper, the summary notice).
 */
export const REVIEW_INPUT_SLACK = 2_048;

const MAX_STRUCTURAL_CHANGES = 20;
const MAX_SCHEMA_ERRORS = 10;
const MAX_VALUE_CHARS = 80;
/** A sibling is a near-copy when at most this share of its leaves differ. */
const NEAR_COPY_MAX_CHANGED_SHARE = 0.25;

const TIER_LABELS: Record<ReviewInputTier, string> = {
  1: 'source',
  2: 'test',
  3: 'docs/config',
  4: 'data/fixture/generated',
};

export interface ReviewInputBudget {
  /** Tokens the review input may use; undefined = no token limit. */
  maxTokens?: number;
  /** Characters the review input may use; undefined = no character cap. */
  maxChars?: number;
  /** The reviewer transport's own token count. */
  countTokens(text: string): number;
}

export interface ReviewInputFile {
  path: string;
  tier: ReviewInputTier;
  mode: 'verbatim' | 'summarised';
  /** Why a file was summarised: above the size threshold, or out of budget. */
  reason?: 'size' | 'budget';
  diffBytes: number;
}

export interface ReviewInputResult {
  /** The text that fills the prompt's DIFF slot. */
  text: string;
  files: ReviewInputFile[];
  summarisedCount: number;
  /** False when even the summarised input exceeds the budget (code too large). */
  withinBudget: boolean;
}

export interface BuildReviewInputOptions {
  /**
   * Post-change content of a repo path (null when absent). Used for modified
   * files, whose full content the diff does not carry, and for `$schema`
   * references outside the diff. Must be deterministic for a given head.
   */
  readFile?: (path: string) => string | null;
  thresholdBytes?: number;
}

interface FileDiff {
  path: string;
  chunk: string;
  status: 'added' | 'deleted' | 'modified';
  tier: ReviewInputTier;
  /** Full post-change content (pre-change for deleted files), when known. */
  content: string | null;
}

// ── Diff parsing ────────────────────────────────────────────────────────────

/** Split a unified git diff into per-file chunks, each kept byte-for-byte. */
export function splitDiffByFile(diff: string): Array<{ path: string; chunk: string }> {
  return diff
    .split(/(?=^diff --git )/m)
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => ({ path: chunkPath(chunk), chunk }));
}

function chunkPath(chunk: string): string {
  const plus = /^\+\+\+ b\/(.+)$/m.exec(chunk);
  if (plus) return plus[1];
  const minus = /^--- a\/(.+)$/m.exec(chunk);
  if (minus) return minus[1];
  const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
  return header ? header[2] : '';
}

/** Rebuild a whole file from an added (`+`) or deleted (`-`) file's hunks. */
function reconstructContent(chunk: string, sign: '+' | '-'): string {
  const lines = chunk.split('\n');
  const start = lines.findIndex((line) => line.startsWith('@@'));
  if (start < 0) return '';
  const body: string[] = [];
  let trailingNewline = true;
  for (const line of lines.slice(start)) {
    if (line.startsWith(sign)) body.push(line.slice(1));
    else if (line.startsWith('\\ No newline')) trailingNewline = false;
  }
  return body.length === 0 ? '' : body.join('\n') + (trailingNewline ? '\n' : '');
}

// ── Tiering ─────────────────────────────────────────────────────────────────

const CODE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|sh|bash|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|scala|sql|vue|svelte)$/i;
const FIXTURE_DIRS = /(?:^|\/)(?:fixtures|__fixtures__|testdata|test-data|__snapshots__)\//;
const GENERATED = /(?:^|\/)(?:dist|build|generated|vendor|node_modules)\/|\.generated\.|\.min\.(?:js|css)$|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum)$|\.snap$/;
const DATA_EXTENSIONS = /\.(?:jsonl|ndjson|csv|tsv|parquet|bin|png|jpe?g|gif|webp|pdf|zip|gz)$/i;
const FIXTURE_FILE = /\.fixtures?\.(?:json|ya?ml)$/i;
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[^/]+$|_test\.[^/]+$/;
const DOCS_OR_CONFIG = /\.(?:md|mdx|rst|txt|adoc|json|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss)$|(?:^|\/)(?:docs?)\/|(?:^|\/)\.[^/]+$/i;

/** Priority tier of a changed path. Fixture-directory code counts as test code. */
export function classifyTier(path: string): ReviewInputTier {
  if (GENERATED.test(path) || DATA_EXTENSIONS.test(path) || FIXTURE_FILE.test(path)) return 4;
  if (FIXTURE_DIRS.test(path)) return CODE_EXTENSIONS.test(path) ? 2 : 4;
  if (TEST_FILE.test(path) && CODE_EXTENSIONS.test(path)) return 2;
  if (DOCS_OR_CONFIG.test(path) || TEST_FILE.test(path)) return 3;
  return 1;
}

// ── Summaries ───────────────────────────────────────────────────────────────

type JsonLeaves = Map<string, string>;

function parseJson(file: FileDiff): unknown {
  if (file.content === null || !/\.json$/i.test(file.path)) return undefined;
  try {
    return JSON.parse(file.content);
  } catch {
    return undefined;
  }
}

/** Flatten JSON to `pointer → serialised leaf`; empty containers are leaves. */
function flattenJson(value: unknown, pointer = '', out: JsonLeaves = new Map()): JsonLeaves {
  if (value !== null && typeof value === 'object') {
    const entries = Array.isArray(value)
      ? value.map((item, index) => [String(index), item] as const)
      : Object.keys(value).sort().map((key) => [key, (value as Record<string, unknown>)[key]] as const);
    if (entries.length === 0) out.set(pointer, Array.isArray(value) ? '[]' : '{}');
    for (const [key, child] of entries) {
      flattenJson(child, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, out);
    }
    return out;
  }
  out.set(pointer, JSON.stringify(value));
  return out;
}

function changedPointers(a: JsonLeaves, b: JsonLeaves): string[] {
  const changed: string[] = [];
  for (const [pointer, value] of a) if (b.get(pointer) !== value) changed.push(pointer);
  for (const pointer of b.keys()) if (!a.has(pointer)) changed.push(pointer);
  return changed.sort();
}

function directoryDistance(a: string, b: string): number {
  const left = posix.dirname(a).split('/');
  const right = posix.dirname(b).split('/');
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared += 1;
  return left.length + right.length - 2 * shared;
}

function clip(value: string | undefined): string {
  if (value === undefined) return '(absent)';
  return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…` : value;
}

/**
 * Structural diff against the nearest near-copy sibling: fewest changed
 * leaves, then the shallowest sibling (a base such as `fixtures/full.v1.json`
 * beats a peer under `fixtures/invalid/`), then directory distance, then path.
 */
function nearestSiblingLine(path: string, leaves: JsonLeaves, others: Array<[string, JsonLeaves]>): string | null {
  type Candidate = { path: string; changed: string[]; rank: number[]; other: JsonLeaves };
  let best: Candidate | null = null;
  for (const [otherPath, other] of others) {
    if (otherPath === path) continue;
    const changed = changedPointers(other, leaves);
    if (changed.length > NEAR_COPY_MAX_CHANGED_SHARE * Math.max(leaves.size, other.size)) continue;
    const rank = [changed.length, otherPath.split('/').length, directoryDistance(path, otherPath)];
    const order = best ? rank.findIndex((value, i) => value !== best!.rank[i]) : -1;
    if (!best || (order >= 0 ? rank[order] < best.rank[order] : otherPath < best.path)) {
      best = { path: otherPath, changed, rank, other };
    }
  }
  if (!best) return null;
  const { changed, other } = best;
  if (changed.length === 0) return `structure: identical to ${best.path}`;
  const shown = changed.slice(0, MAX_STRUCTURAL_CHANGES).map((pointer) =>
    `  ${pointer}: ${clip(other.get(pointer))} → ${clip(leaves.get(pointer))}`);
  return [
    `structure: = ${best.path} with ${changed.length} change(s)`,
    ...shown,
    ...(changed.length > shown.length ? [`  … and ${changed.length - shown.length} more`] : []),
  ].join('\n');
}

/** `$schema` reference first, else the nearest `*.schema.json` in the diff. */
function discoverSchema(
  file: FileDiff,
  parsed: unknown,
  byPath: Map<string, FileDiff>,
  readFile: BuildReviewInputOptions['readFile'],
): { path: string; text: string | null } | null {
  const ref = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).$schema : undefined;
  if (typeof ref === 'string' && !/^[a-z]+:/i.test(ref)) {
    const target = posix.normalize(posix.join(posix.dirname(file.path), ref.split('#')[0]));
    return { path: target, text: byPath.get(target)?.content ?? readFile?.(target) ?? null };
  }
  const candidates = [...byPath.values()]
    .filter((other) => other.path.endsWith('.schema.json') && other.content !== null)
    .filter((other) => {
      const dir = posix.dirname(other.path);
      return dir !== '.' && file.path.startsWith(`${dir}/`);
    })
    .sort((a, b) => posix.dirname(b.path).length - posix.dirname(a.path).length || (a.path < b.path ? -1 : 1));
  return candidates[0] ? { path: candidates[0].path, text: candidates[0].content } : null;
}

function schemaLine(schema: { path: string; text: string | null } | null, parsed: unknown): string {
  if (!schema) return 'schema: none declared or discoverable';
  if (schema.text === null) return `schema: ${schema.path} declared but not readable`;
  let validate;
  try {
    const { $schema: _draft, $id: _id, ...body } = JSON.parse(schema.text) as Record<string, unknown>;
    validate = new Ajv2020({ strict: false, allErrors: true, validateFormats: false }).compile(body);
  } catch (error) {
    return `schema: ${schema.path} could not be compiled (${(error as Error).message.split('\n')[0]})`;
  }
  if (validate(parsed)) return `schema: valid against ${schema.path}`;
  const errors = (validate.errors ?? [])
    .map((error) => `  ${error.instancePath || '/'} ${error.message ?? 'invalid'} (${error.schemaPath})`)
    .sort();
  return [
    `schema: INVALID against ${schema.path} (${errors.length} error(s))`,
    ...errors.slice(0, MAX_SCHEMA_ERRORS),
    ...(errors.length > MAX_SCHEMA_ERRORS ? [`  … and ${errors.length - MAX_SCHEMA_ERRORS} more`] : []),
  ].join('\n');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function summarise(
  file: FileDiff,
  reason: 'size' | 'budget',
  thresholdBytes: number,
  byPath: Map<string, FileDiff>,
  jsonLeaves: Array<[string, JsonLeaves]>,
  readFile: BuildReviewInputOptions['readFile'],
): string {
  const diffBytes = Buffer.byteLength(file.chunk, 'utf8');
  const lines = [
    `--- summarised ${TIER_LABELS[file.tier]} file: ${file.path} ` +
      `(reason: ${reason === 'size' ? `diff ${diffBytes} B > ${thresholdBytes} B threshold` : 'review budget exhausted'})`,
  ];
  if (file.content === null) {
    lines.push(`${file.status}; diff ${diffBytes} B; patch sha256 ${sha256(file.chunk)}`);
    return lines.join('\n');
  }
  const size = Buffer.byteLength(file.content, 'utf8');
  lines.push(`${file.status}; ${file.status === 'deleted' ? 'was ' : ''}${size} B; sha256 ${sha256(file.content)}`);
  const parsed = parseJson(file);
  if (parsed !== undefined && file.status !== 'deleted') {
    if (!file.path.endsWith('.schema.json')) {
      lines.push(schemaLine(discoverSchema(file, parsed, byPath, readFile), parsed));
    }
    const own = jsonLeaves.find(([path]) => path === file.path);
    const sibling = own ? nearestSiblingLine(file.path, own[1], jsonLeaves) : null;
    if (sibling) lines.push(sibling);
  }
  return lines.join('\n');
}

// ── Budget ──────────────────────────────────────────────────────────────────

/**
 * The input budget a reviewer's adapter leaves after `reservedPrompt` (the
 * filled template without the diff) and `reservedTokens` the transport adds
 * on top. Mirrors the adapter preflight:
 * `(prompt + harness) × (1 + margin) + output ≤ window`, and `prompt ≤ cap`.
 */
export function reviewInputBudgetFromAdapter(
  adapter: TransportAdapter,
  reservedPrompt: string,
  reservedTokens = 0,
): ReviewInputBudget {
  const { contextWindowTokens, maxInputChars, maxOutputTokens = 0, cliHarnessOverheadTokens = 0 } = adapter.limits;
  const tokenLimit = typeof contextWindowTokens === 'number' && contextWindowTokens > 0 ? contextWindowTokens : undefined;
  return {
    countTokens: (text) => adapter.countTokens(text),
    ...(tokenLimit !== undefined
      ? {
          maxTokens: Math.max(0, Math.floor((tokenLimit - maxOutputTokens) / (1 + CONTEXT_WINDOW_SAFETY_MARGIN))
            - cliHarnessOverheadTokens - adapter.countTokens(reservedPrompt) - reservedTokens - REVIEW_INPUT_SLACK),
        }
      : {}),
    ...(typeof maxInputChars === 'number'
      ? { maxChars: Math.max(0, maxInputChars - reservedPrompt.length - REVIEW_INPUT_SLACK) }
      : {}),
  };
}

/**
 * `readFile` for {@link buildReviewInput} over a checked-out worktree. Paths
 * that escape the worktree, and unreadable paths, read as null.
 */
export function worktreeFileReader(repoDir: string): (path: string) => string | null {
  return (path) => {
    const normalized = posix.normalize(path);
    if (normalized.startsWith('../') || posix.isAbsolute(normalized)) return null;
    try {
      return readFileSync(join(repoDir, normalized), 'utf8');
    } catch {
      return null;
    }
  };
}

// ── Builder ─────────────────────────────────────────────────────────────────

/**
 * Build the review input for `diff` within `budget`. Same diff, budget and
 * `readFile` answers → byte-identical output.
 */
export function buildReviewInput(
  diff: string,
  budget: ReviewInputBudget,
  options: BuildReviewInputOptions = {},
): ReviewInputResult {
  const thresholdBytes = options.thresholdBytes ?? DATA_FILE_SUMMARY_THRESHOLD_BYTES;
  const files: FileDiff[] = splitDiffByFile(diff)
    .map(({ path, chunk }): FileDiff => {
      const status = /^new file mode/m.test(chunk) ? 'added' : /^deleted file mode/m.test(chunk) ? 'deleted' : 'modified';
      const content = status === 'added'
        ? reconstructContent(chunk, '+')
        : status === 'deleted'
          ? reconstructContent(chunk, '-')
          : options.readFile?.(path) ?? null;
      return { path, chunk, status, tier: classifyTier(path), content };
    })
    .sort((a, b) => a.tier - b.tier || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const byPath = new Map(files.map((file) => [file.path, file]));
  const jsonLeaves: Array<[string, JsonLeaves]> = files
    .filter((file) => file.status !== 'deleted')
    .flatMap((file) => {
      const parsed = parseJson(file);
      return parsed === undefined ? [] : [[file.path, flattenJson(parsed)] as [string, JsonLeaves]];
    });

  const cost = (text: string) => ({ tokens: budget.countTokens(text), chars: text.length });
  const fits = (tokens: number, chars: number) =>
    (budget.maxTokens === undefined || tokens <= budget.maxTokens)
    && (budget.maxChars === undefined || chars <= budget.maxChars);

  // Every summarisable file's summary is reserved up front; admitting a file
  // verbatim releases its own reservation. Summaries never outgrow their
  // reservation, so admitted files cannot squeeze later summaries out.
  const summaries = new Map<string, { text: string; tokens: number; chars: number }>();
  let reserveTokens = 0;
  let reserveChars = 0;
  for (const file of files) {
    if (file.tier < 3) continue;
    const size = Buffer.byteLength(file.chunk, 'utf8');
    const reason = file.tier === 4 && size > thresholdBytes ? 'size' : 'budget';
    const text = summarise(file, reason, thresholdBytes, byPath, jsonLeaves, options.readFile);
    const { tokens, chars } = cost(text);
    summaries.set(file.path, { text, tokens, chars });
    reserveTokens += tokens;
    reserveChars += chars;
  }

  let usedTokens = 0;
  let usedChars = 0;
  let exhausted = false;
  const verbatim: string[] = [];
  const summarised: string[] = [];
  const entries: ReviewInputFile[] = [];
  for (const file of files) {
    const diffBytes = Buffer.byteLength(file.chunk, 'utf8');
    const summary = summaries.get(file.path);
    if (summary) {
      reserveTokens -= summary.tokens;
      reserveChars -= summary.chars;
    }
    const chunkCost = cost(file.chunk);
    const oversized = file.tier === 4 && diffBytes > thresholdBytes;
    const admit = !summary || (
      !oversized
      && !exhausted
      && fits(usedTokens + chunkCost.tokens + reserveTokens, usedChars + chunkCost.chars + reserveChars)
    );
    if (admit) {
      verbatim.push(file.chunk);
      usedTokens += chunkCost.tokens;
      usedChars += chunkCost.chars;
      entries.push({ path: file.path, tier: file.tier, mode: 'verbatim', diffBytes });
      continue;
    }
    if (!oversized) exhausted = true;
    summarised.push(summary.text);
    usedTokens += summary.tokens;
    usedChars += summary.chars;
    entries.push({ path: file.path, tier: file.tier, mode: 'summarised', reason: oversized ? 'size' : 'budget', diffBytes });
  }

  const text = summarised.length === 0
    ? verbatim.join('')
    : [
        `=== review input: ${entries.length - summarised.length} file(s) verbatim, ${summarised.length} summarised (listed at the end) ===\n`,
        verbatim.join(''),
        `\n=== ${summarised.length} file(s) summarised instead of shown verbatim ===\n`,
        'Every source and test file above is verbatim. Docs/config files that did not fit the reviewer budget,\n',
        `and data/fixture/generated files above ${thresholdBytes} B or beyond the budget, are summarised\n`,
        'deterministically: path, size, sha256 of the full content, the result of validating the file against its\n',
        'JSON schema (when declared via $schema or a *.schema.json in the diff), and, for near-copies, a structural\n',
        'diff (JSON pointer: sibling value → this value) against the nearest sibling. Read a file from the\n',
        'worktree if a finding depends on its full contents.\n\n',
        summarised.join('\n\n'),
        '\n',
      ].join('');
  const total = cost(text);
  return {
    text,
    files: entries,
    summarisedCount: summarised.length,
    withinBudget: fits(total.tokens, total.chars),
  };
}
