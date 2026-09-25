// ---------------------------------------------------------------------------
// Native `ast` advanced-tool family (HOK-3060).
//
// Policy-bound, previewable structured source transforms. The family reuses
// the TypeScript-compiler language-intelligence substrate (`../language-index.ts`,
// HOK-3059) to locate symbol occurrences, but it NEVER writes files itself.
// Every mutation is delegated to the existing atomic NativePatch runtime
// (`../patch-runtime.ts`) so it inherits patch validation, atomicity, snapshot
// recovery, and transcript semantics.
//
// Two tools:
//   * `ast_transform_preview` (read-only) — resolves matches, computes the
//     exact NativePatch that would be applied, and returns an immutable,
//     versioned, digest-sealed preview. It performs zero file writes.
//   * `ast_transform_apply` (mutation) — accepts exactly one preview, revalidates
//     live source/index state against the sealed digest, and, only when nothing
//     drifted, hands the already-bound patch to `applyNativePatch`.
//
// Design invariants:
//   * A preview is required before an apply; the apply constructs no new edits.
//   * Every value that leaves an executor is byte-stable: canonical JSON with
//     sorted keys, no timestamps, no per-run randomness.
//   * Unsupported languages, out-of-worktree targets, ambiguous symbols, zero
//     matches, tampered previews, and source/index drift all fail closed with
//     an explicit code and leave the tree unchanged.
//   * Redaction and output caps run over both content and details.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as ts from 'typescript';

import type { ResolvedNativeAstConfig } from '../../config.ts';
import { redactSecrets, redactSecretsInValue } from '../../redaction-profiles.ts';
import type { MutationRecorder } from '../cleanup.ts';
import {
  buildLanguageIndex,
  detectLanguage,
  IndexAborted,
  IndexBudgetExceeded,
  type LanguageIndex,
  type LanguageIndexLocation,
} from '../language-index.ts';
import {
  NATIVE_PATCH_VERSION,
  validateNativePatch,
  type NativePatch,
  type NativePatchEditDiffOperation,
} from '../patch-contract.ts';
import { applyNativePatch, type NativePatchAppliedResult } from '../patch-runtime.ts';
import { buildTrustMetadata } from '../provenance.ts';
import { resolveInsideWorktree } from './read-only.ts';
import type { ToolDescriptor, ToolPhase, WavemillToolResult } from './types.ts';

// ---------------------------------------------------------------------------
// Contract version and public types
// ---------------------------------------------------------------------------

/**
 * Versioned AST-transform preview/apply contract. Bump whenever the preview
 * shape or the digest inputs change in a way that invalidates previously
 * emitted previews. `ast_transform_apply` rejects any preview whose version
 * does not match this constant.
 */
export const AST_TRANSFORM_CONTRACT_VERSION = 1 as const;

/** Deterministic, name-bounded transform kinds. */
export type AstTransformKind = 'rename_symbol' | 'rewrite_symbol';

export const AST_TRANSFORM_KINDS: readonly AstTransformKind[] = Object.freeze([
  'rename_symbol',
  'rewrite_symbol',
]);

/** A single occurrence that the transform would rewrite. */
export interface AstTransformMatch {
  path: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  symbol: string;
  kind: LanguageIndexLocation['kind'];
  referenceKind: LanguageIndexLocation['referenceKind'];
  oldText: string;
  newText: string;
}

/** Per-file content revision captured at preview time. */
export interface AstSourceRevision {
  path: string;
  /** SHA-256 over the exact on-disk bytes at preview time. */
  digest: string;
  bytes: number;
}

/** Formatter interaction record. */
export interface AstFormatterOutcome {
  /** Whether a formatter changed any transformed file's content. */
  applied: boolean;
  /** Stable formatter identifier when one is configured. */
  formatter?: string;
}

/**
 * Immutable, digest-sealed preview for exactly one proposed transform. The
 * `previewDigest` is computed over the canonical serialization of every other
 * field, so any tampering (including with the embedded patch) is detected at
 * apply time.
 */
export interface AstTransformPreview {
  version: typeof AST_TRANSFORM_CONTRACT_VERSION;
  transform: AstTransformKind;
  symbol: string;
  replacement: string;
  language: 'typescript';
  engine: 'typescript';
  engineVersion: string;
  indexRevision: string;
  scope: string | null;
  sourceRevisions: AstSourceRevision[];
  patch: NativePatch;
  patchDigest: string;
  matches: AstTransformMatch[];
  matchCount: number;
  truncated: boolean;
  formatter: AstFormatterOutcome;
  /** Bounded, redacted human-readable summary of the intended change. */
  summary: string;
  /** SHA-256 over the canonical form of every field above. Tamper seal. */
  previewDigest: string;
}

export type AstTransformErrorCode =
  | 'invalid_params'
  | 'unsupported_transform'
  | 'unsupported_language'
  | 'no_matches'
  | 'ambiguous_symbol'
  | 'path_denied'
  | 'index_error'
  | 'index_budget_exceeded'
  | 'aborted'
  | 'internal_error'
  // apply-only
  | 'preview_required'
  | 'invalid_preview'
  | 'version_mismatch'
  | 'engine_mismatch'
  | 'preview_tampered'
  | 'patch_digest_mismatch'
  | 'source_drift'
  | 'index_drift'
  | 'invalid_patch'
  | 'patch_rejected'
  | 'phase_denied'
  | 'io_error';

export interface AstTransformPreviewSuccessDetails {
  ok: true;
  tool: 'ast_transform_preview';
  status: 'ok';
  preview: AstTransformPreview;
}

export interface AstTransformApplySuccessDetails {
  ok: true;
  tool: 'ast_transform_apply';
  status: 'ok';
  transform: AstTransformKind;
  symbol: string;
  patchDigest: string;
  result: NativePatchAppliedResult;
}

export interface AstTransformErrorDetails {
  ok: false;
  tool: 'ast_transform_preview' | 'ast_transform_apply';
  error: AstTransformErrorCode;
  message: string;
  /** Optional structured drift/rejection evidence. */
  diagnostics?: Record<string, unknown>;
}

export type AstTransformPreviewDetails =
  | AstTransformPreviewSuccessDetails
  | AstTransformErrorDetails;
export type AstTransformApplyDetails =
  | AstTransformApplySuccessDetails
  | AstTransformErrorDetails;

// ---------------------------------------------------------------------------
// Factory input
// ---------------------------------------------------------------------------

/**
 * Optional deterministic formatter hook. Given a file's post-transform text
 * and its worktree-relative path, it returns the formatted text. It must be
 * pure and deterministic; any change it makes is folded into the SAME
 * NativePatch, never a separate write. When absent, the transform is applied
 * verbatim.
 */
export type AstFormatter = (text: string, relPath: string) => string;

export interface CreateAstTransformToolsInput {
  config: ResolvedNativeAstConfig | null;
  worktreePath: string;
  phase?: ToolPhase;
  recorder?: MutationRecorder;
  /** Deterministic formatter folded into the transform patch. */
  formatter?: AstFormatter;
  /** Stable identifier recorded in the preview when a formatter is supplied. */
  formatterName?: string;
}

// ---------------------------------------------------------------------------
// Canonical JSON + digest helpers
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = canonicalize((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Digest over the canonical patch — provenance for the sealed preview. */
export function computePatchDigest(patch: NativePatch): string {
  return sha256(canonicalJson(patch));
}

/** Digest over every preview field except `previewDigest` itself. */
export function computePreviewDigest(preview: Omit<AstTransformPreview, 'previewDigest'>): string {
  return sha256(canonicalJson(preview));
}

// ---------------------------------------------------------------------------
// Result envelope helpers
// ---------------------------------------------------------------------------

function makeError(
  tool: AstTransformErrorDetails['tool'],
  code: AstTransformErrorCode,
  message: string,
  diagnostics?: Record<string, unknown>,
): WavemillToolResult<AstTransformErrorDetails> {
  const details: AstTransformErrorDetails = {
    ok: false,
    tool,
    error: code,
    message,
    ...(diagnostics ? { diagnostics } : {}),
  };
  const text = redactSecrets(canonicalJson(details)).text;
  return {
    content: [{ type: 'text', text }],
    details,
    metadata: { trust: buildTrustMetadata({ sourceKind: 'file', details }) },
  };
}

function wrapPreviewSuccess(
  preview: AstTransformPreview,
): WavemillToolResult<AstTransformPreviewSuccessDetails> {
  const details: AstTransformPreviewSuccessDetails = {
    ok: true,
    tool: 'ast_transform_preview',
    status: 'ok',
    preview,
  };
  const redactedDetails = redactSecretsInValue(details) as {
    value: AstTransformPreviewSuccessDetails;
    redacted: boolean;
    matchCount: number;
    categories: string[];
  };
  const canonical = canonicalJson(redactedDetails.value);
  const redactedText = redactSecrets(canonical);
  return {
    content: [{ type: 'text', text: redactedText.text }],
    details: redactedDetails.value,
    metadata: {
      trust: buildTrustMetadata({
        sourceKind: 'file',
        content: [{ type: 'text', text: redactedText.text }],
        details: redactedDetails.value,
      }),
      redaction: {
        redacted: redactedText.redacted || redactedDetails.redacted,
        matchCount: redactedText.matchCount + redactedDetails.matchCount,
        categories: [...new Set([...redactedText.categories, ...redactedDetails.categories])],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Language / parameter helpers
// ---------------------------------------------------------------------------

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isSupportedLanguageHint(hint: string | undefined, scopePath: string | undefined): {
  supported: boolean;
  label: string | null;
} {
  const normalized = hint?.toLowerCase();
  if (normalized) {
    if (
      normalized === 'typescript' ||
      normalized === 'ts' ||
      normalized === 'javascript' ||
      normalized === 'js'
    ) {
      return { supported: true, label: 'typescript' };
    }
    return { supported: false, label: normalized };
  }
  if (scopePath) {
    const lang = detectLanguage(scopePath);
    if (lang === 'typescript') return { supported: true, label: 'typescript' };
    const ext = path.extname(scopePath).toLowerCase();
    return { supported: false, label: ext.replace(/^\./, '') || 'unknown' };
  }
  // No hint at all: the TypeScript engine indexes the whole worktree.
  return { supported: true, label: 'typescript' };
}

// ---------------------------------------------------------------------------
// Occurrence normalization
// ---------------------------------------------------------------------------

/** Normalize an index location into a stable match record. */
function toMatch(loc: LanguageIndexLocation, oldText: string, newText: string): AstTransformMatch {
  return {
    path: loc.path,
    startLine: loc.startLine,
    startColumn: loc.startColumn,
    endLine: loc.endLine,
    endColumn: loc.endColumn,
    symbol: loc.symbol,
    kind: loc.kind,
    referenceKind: loc.referenceKind,
    oldText,
    newText,
  };
}

function compareMatches(a: AstTransformMatch, b: AstTransformMatch): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.startLine !== b.startLine) return a.startLine - b.startLine;
  if (a.startColumn !== b.startColumn) return a.startColumn - b.startColumn;
  if (a.endLine !== b.endLine) return a.endLine - b.endLine;
  return a.endColumn - b.endColumn;
}

/** Convert a 1-based line/column location into a 0-based string offset. */
function offsetOf(lineStarts: number[], line: number, column: number): number {
  const base = lineStarts[line - 1] ?? 0;
  return base + (column - 1);
}

/** Precompute the byte offset at the start of each 1-based line. */
function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

// ---------------------------------------------------------------------------
// Unified-diff synthesis (line-scoped; never whole-file replacement)
// ---------------------------------------------------------------------------

/**
 * Build a zero-context unified diff between two texts. Renames only change
 * tokens inside existing lines, so this walks the lines pairwise and emits one
 * hunk per contiguous run of changed lines. The output is consumed by
 * `patch-runtime.ts`'s `edit-diff` applier, which matches each hunk's removed
 * lines at the hunk's declared position — so duplicate lines elsewhere never
 * cause ambiguity, and any positional drift is rejected at apply time.
 */
export function buildUnifiedDiff(originalText: string, newText: string): string | null {
  const oldLines = originalText.split('\n');
  const newLines = newText.split('\n');
  if (oldLines.length !== newLines.length) {
    // Structural line add/remove (e.g. formatter reflow). Fall back to a
    // full-range diff so the change still applies line-scoped, hunk by hunk.
    return buildFullRangeDiff(oldLines, newLines);
  }

  const hunks: string[] = [];
  let i = 0;
  while (i < oldLines.length) {
    if (oldLines[i] === newLines[i]) {
      i += 1;
      continue;
    }
    const runStart = i;
    while (i < oldLines.length && oldLines[i] !== newLines[i]) {
      i += 1;
    }
    const count = i - runStart;
    const header = `@@ -${runStart + 1},${count} +${runStart + 1},${count} @@`;
    const body: string[] = [];
    for (let k = runStart; k < i; k += 1) body.push(`-${oldLines[k]}`);
    for (let k = runStart; k < i; k += 1) body.push(`+${newLines[k]}`);
    hunks.push([header, ...body].join('\n'));
  }

  if (hunks.length === 0) return null;
  return hunks.join('\n');
}

/**
 * Emit a single hunk that replaces every line. Used only when the transform
 * (typically via a formatter) changed the line count. This is still a diff
 * hunk consumed by the patch runtime — not a whole-file write path.
 */
function buildFullRangeDiff(oldLines: string[], newLines: string[]): string {
  const header = `@@ -1,${oldLines.length} +1,${newLines.length} @@`;
  const body = [
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ];
  return [header, ...body].join('\n');
}

// ---------------------------------------------------------------------------
// Core preview computation
// ---------------------------------------------------------------------------

interface PreviewCtx {
  worktreeAbsolute: string;
  config: ResolvedNativeAstConfig;
  formatter?: AstFormatter;
  formatterName?: string;
}

async function computePreview(
  ctx: PreviewCtx,
  params: AstTransformPreviewParams,
  signal: AbortSignal | undefined,
): Promise<WavemillToolResult<AstTransformPreviewDetails>> {
  if (signal?.aborted) return makeError('ast_transform_preview', 'aborted', 'aborted before start');

  // --- Parameter validation --------------------------------------------------
  const transform = params.transform;
  if (typeof transform !== 'string' || !AST_TRANSFORM_KINDS.includes(transform as AstTransformKind)) {
    return makeError(
      'ast_transform_preview',
      'unsupported_transform',
      `transform must be one of: ${AST_TRANSFORM_KINDS.join(', ')}`,
    );
  }
  const kind = transform as AstTransformKind;

  if (typeof params.symbol !== 'string' || params.symbol.trim() === '') {
    return makeError('ast_transform_preview', 'invalid_params', 'symbol must be a non-empty string');
  }
  const symbol = params.symbol.trim();
  if (!IDENTIFIER_RE.test(symbol)) {
    return makeError(
      'ast_transform_preview',
      'invalid_params',
      'symbol must be a valid identifier (letters, digits, _ or $, not starting with a digit)',
    );
  }

  if (typeof params.replacement !== 'string' || params.replacement.length === 0) {
    return makeError('ast_transform_preview', 'invalid_params', 'replacement must be a non-empty string');
  }
  const replacement = params.replacement;
  if (kind === 'rename_symbol' && !IDENTIFIER_RE.test(replacement)) {
    return makeError(
      'ast_transform_preview',
      'invalid_params',
      'rename_symbol replacement must be a valid identifier',
    );
  }
  if (replacement === symbol) {
    return makeError('ast_transform_preview', 'invalid_params', 'replacement must differ from symbol');
  }

  // --- Language + scope gate -------------------------------------------------
  const scope = typeof params.path === 'string' && params.path.trim() !== '' ? params.path.trim() : undefined;
  const lang = isSupportedLanguageHint(params.language, scope);
  if (!lang.supported) {
    return makeError(
      'ast_transform_preview',
      'unsupported_language',
      `language "${lang.label}" is not supported by the AST transform engine`,
      { language: lang.label },
    );
  }

  if (scope) {
    const scopeResolved = await resolveInsideWorktree(ctx.worktreeAbsolute, scope);
    if (scopeResolved.kind === 'error') {
      return makeError('ast_transform_preview', 'path_denied', scopeResolved.message, {
        code: scopeResolved.code,
        path: scope,
      });
    }
  }

  // --- Build the language index ----------------------------------------------
  let index: LanguageIndex;
  try {
    index = await buildLanguageIndex(ctx.worktreeAbsolute, {
      maxFiles: ctx.config.limits.maxFiles,
      maxBytes: ctx.config.limits.maxBytes,
      maxSymbols: ctx.config.limits.maxSymbols,
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (err instanceof IndexAborted) return makeError('ast_transform_preview', 'aborted', err.message);
    if (err instanceof IndexBudgetExceeded) {
      return makeError('ast_transform_preview', 'index_budget_exceeded', err.message, { kind: err.kind });
    }
    return makeError('ast_transform_preview', 'index_error', (err as Error).message);
  }

  // --- Resolve occurrences ---------------------------------------------------
  const symbolResult = await index.findSymbols(
    { symbol },
    { maxResults: ctx.config.limits.maxSymbols, ...(scope ? { path: scope } : {}), ...(signal ? { signal } : {}) },
  );
  const occurrences = symbolResult.matches;
  if (occurrences.length === 0) {
    return makeError('ast_transform_preview', 'no_matches', `no occurrences of symbol "${symbol}" were found`, {
      symbol,
      ...(scope ? { scope } : {}),
    });
  }

  // Ambiguity gate: more than one distinct definition means renaming could
  // conflate independent symbols. A `path` scope that narrows to a single
  // definition disambiguates.
  const definitions = occurrences.filter((o) => o.referenceKind === 'definition');
  if (definitions.length > 1) {
    return makeError(
      'ast_transform_preview',
      'ambiguous_symbol',
      `symbol "${symbol}" has ${definitions.length} definitions; narrow with a path scope to disambiguate`,
      {
        symbol,
        definitionCount: definitions.length,
        definitions: definitions.map((d) => ({ path: d.path, startLine: d.startLine })),
      },
    );
  }

  // --- Group occurrences by file, deterministically --------------------------
  const sortedOccurrences = [...occurrences].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    return a.startColumn - b.startColumn;
  });

  const byFile = new Map<string, LanguageIndexLocation[]>();
  for (const occ of sortedOccurrences) {
    let bucket = byFile.get(occ.path);
    if (!bucket) {
      bucket = [];
      byFile.set(occ.path, bucket);
    }
    bucket.push(occ);
  }

  // --- Read each touched file and synthesize per-file text -------------------
  const perFile = new Map<string, { originalText: string; newText: string; bytes: number }>();
  let formatterApplied = false;
  for (const [relPath, locs] of byFile) {
    if (signal?.aborted) return makeError('ast_transform_preview', 'aborted', 'aborted during file read');
    const resolved = await resolveInsideWorktree(ctx.worktreeAbsolute, relPath);
    if (resolved.kind === 'error') {
      return makeError('ast_transform_preview', 'path_denied', resolved.message, {
        code: resolved.code,
        path: relPath,
      });
    }
    let originalText: string;
    try {
      originalText = await readFile(resolved.absolutePath, 'utf8');
    } catch (err) {
      return makeError('ast_transform_preview', 'io_error', `cannot read ${relPath}: ${(err as Error).message}`);
    }

    const lineStarts = computeLineStarts(originalText);
    // Apply replacements from the end of the file backwards so earlier offsets
    // stay valid. Verify each range's source text matches the index symbol.
    const ranges = locs
      .map((loc) => ({
        start: offsetOf(lineStarts, loc.startLine, loc.startColumn),
        end: offsetOf(lineStarts, loc.endLine, loc.endColumn),
      }))
      .sort((a, b) => b.start - a.start);

    let mutated = originalText;
    for (const range of ranges) {
      const actual = mutated.slice(range.start, range.end);
      if (actual !== symbol) {
        return makeError(
          'ast_transform_preview',
          'index_error',
          `index/source mismatch in ${relPath}: expected "${symbol}" at ${range.start}-${range.end}, found "${actual}"`,
          { path: relPath },
        );
      }
      mutated = `${mutated.slice(0, range.start)}${replacement}${mutated.slice(range.end)}`;
    }

    // Fold formatter output into the same file text before diffing.
    if (ctx.formatter) {
      const formatted = ctx.formatter(mutated, relPath);
      if (formatted !== mutated) formatterApplied = true;
      mutated = formatted;
    }

    if (mutated === originalText) continue;
    perFile.set(relPath, {
      originalText,
      newText: mutated,
      bytes: Buffer.byteLength(originalText, 'utf8'),
    });
  }

  if (perFile.size === 0) {
    return makeError('ast_transform_preview', 'no_matches', 'the transform produced no changes');
  }

  // --- Build the atomic NativePatch (edit-diff per file, sorted) -------------
  const relPathsSorted = [...perFile.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const operations: NativePatchEditDiffOperation[] = [];
  for (const relPath of relPathsSorted) {
    const entry = perFile.get(relPath)!;
    const diff = buildUnifiedDiff(entry.originalText, entry.newText);
    if (!diff) continue;
    operations.push({ op: 'edit-diff', path: relPath, diff });
  }
  const patch: NativePatch = {
    version: NATIVE_PATCH_VERSION,
    atomic: true,
    operations,
  };

  // Validate our own synthesis eagerly so a preview never seals an invalid patch.
  const validation = validateNativePatch(patch);
  if (!validation.ok) {
    return makeError('ast_transform_preview', 'internal_error', 'synthesized patch failed validation', {
      errors: validation.errors,
    });
  }

  // --- Match records (capped + provenance) -----------------------------------
  const allMatches: AstTransformMatch[] = sortedOccurrences.map((loc) => toMatch(loc, symbol, replacement));
  allMatches.sort(compareMatches);
  const matchCount = allMatches.length;
  const cap = ctx.config.limits.maxMatches;
  const truncated = matchCount > cap;
  const matches = truncated ? allMatches.slice(0, cap) : allMatches;

  // --- Source revisions (exact byte digests) ---------------------------------
  const sourceRevisions: AstSourceRevision[] = relPathsSorted.map((relPath) => {
    const entry = perFile.get(relPath)!;
    return {
      path: relPath,
      digest: sha256(entry.originalText),
      bytes: entry.bytes,
    };
  });

  const summary = buildSummary(
    kind,
    symbol,
    replacement,
    relPathsSorted,
    matchCount,
    formatterApplied,
    ctx.config.limits.maxSummaryBytes,
  );

  const formatter: AstFormatterOutcome = {
    applied: formatterApplied,
    ...(ctx.formatter && ctx.formatterName ? { formatter: ctx.formatterName } : {}),
  };

  const previewNoDigest: Omit<AstTransformPreview, 'previewDigest'> = {
    version: AST_TRANSFORM_CONTRACT_VERSION,
    transform: kind,
    symbol,
    replacement,
    language: 'typescript',
    engine: 'typescript',
    engineVersion: ts.version,
    indexRevision: index.indexRevision,
    scope: scope ?? null,
    sourceRevisions,
    patch: validation.value,
    patchDigest: computePatchDigest(validation.value),
    matches,
    matchCount,
    truncated,
    formatter,
    summary,
  };
  const previewDigest = computePreviewDigest(previewNoDigest);
  const preview: AstTransformPreview = { ...previewNoDigest, previewDigest };

  return wrapPreviewSuccess(preview);
}

function buildSummary(
  kind: AstTransformKind,
  symbol: string,
  replacement: string,
  files: string[],
  matchCount: number,
  formatterApplied: boolean,
  maxBytes: number,
): string {
  const verb = kind === 'rename_symbol' ? 'Rename' : 'Rewrite';
  const fileList = files.join(', ');
  const formatterNote = formatterApplied ? ' (formatter folded in)' : '';
  const summary =
    `${verb} "${symbol}" → "${replacement}" across ${matchCount} occurrence(s) in ${files.length} file(s)${formatterNote}: ${fileList}`;
  if (Buffer.byteLength(summary, 'utf8') <= maxBytes) return summary;
  return `${summary.slice(0, Math.max(0, maxBytes - 1))}…`;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

interface ApplyCtx {
  worktreeAbsolute: string;
  config: ResolvedNativeAstConfig;
  phase: ToolPhase;
  recorder?: MutationRecorder;
}

async function applyPreview(
  ctx: ApplyCtx,
  params: AstTransformApplyParams,
  signal: AbortSignal | undefined,
): Promise<WavemillToolResult<AstTransformApplyDetails>> {
  if (ctx.phase !== 'coding') {
    return makeError('ast_transform_apply', 'phase_denied', `ast_transform_apply is coding-only; refused in ${ctx.phase}`);
  }
  if (signal?.aborted) return makeError('ast_transform_apply', 'aborted', 'aborted before start');

  const preview = params.preview as AstTransformPreview | undefined;
  if (!preview || typeof preview !== 'object') {
    return makeError('ast_transform_apply', 'preview_required', 'apply requires the full preview object from ast_transform_preview');
  }

  const structural = validatePreviewStructure(preview);
  if (structural) return makeError('ast_transform_apply', 'invalid_preview', structural);

  if (preview.version !== AST_TRANSFORM_CONTRACT_VERSION) {
    return makeError('ast_transform_apply', 'version_mismatch', `preview version ${preview.version} != ${AST_TRANSFORM_CONTRACT_VERSION}`);
  }
  if (preview.engine !== 'typescript' || preview.language !== 'typescript') {
    return makeError('ast_transform_apply', 'engine_mismatch', 'preview engine/language is not supported by this runtime');
  }

  // --- Tamper seal -----------------------------------------------------------
  const { previewDigest, ...rest } = preview;
  const recomputed = computePreviewDigest(rest);
  if (recomputed !== previewDigest) {
    return makeError('ast_transform_apply', 'preview_tampered', 'preview digest does not match its contents', {
      expected: previewDigest,
      actual: recomputed,
    });
  }
  const recomputedPatchDigest = computePatchDigest(preview.patch);
  if (recomputedPatchDigest !== preview.patchDigest) {
    return makeError('ast_transform_apply', 'patch_digest_mismatch', 'embedded patch digest mismatch', {
      expected: preview.patchDigest,
      actual: recomputedPatchDigest,
    });
  }

  // --- Re-resolve every target inside the worktree ---------------------------
  for (const revision of preview.sourceRevisions) {
    const resolved = await resolveInsideWorktree(ctx.worktreeAbsolute, revision.path);
    if (resolved.kind === 'error') {
      return makeError('ast_transform_apply', 'path_denied', resolved.message, {
        code: resolved.code,
        path: revision.path,
      });
    }
  }

  // --- Source drift: exact per-target-file content digests -------------------
  for (const revision of preview.sourceRevisions) {
    if (signal?.aborted) return makeError('ast_transform_apply', 'aborted', 'aborted during revalidation');
    const resolved = await resolveInsideWorktree(ctx.worktreeAbsolute, revision.path);
    if (resolved.kind === 'error') {
      return makeError('ast_transform_apply', 'source_drift', `${revision.path} is no longer readable`, {
        path: revision.path,
        code: resolved.code,
      });
    }
    let current: string;
    try {
      current = await readFile(resolved.absolutePath, 'utf8');
    } catch (err) {
      return makeError('ast_transform_apply', 'source_drift', `cannot read ${revision.path}: ${(err as Error).message}`, {
        path: revision.path,
      });
    }
    const currentDigest = sha256(current);
    if (currentDigest !== revision.digest) {
      return makeError('ast_transform_apply', 'source_drift', `${revision.path} changed since preview`, {
        path: revision.path,
        expected: revision.digest,
        actual: currentDigest,
      });
    }
  }

  // --- Index drift: rebuild and compare the whole-worktree revision ----------
  let index: LanguageIndex;
  try {
    index = await buildLanguageIndex(ctx.worktreeAbsolute, {
      maxFiles: ctx.config.limits.maxFiles,
      maxBytes: ctx.config.limits.maxBytes,
      maxSymbols: ctx.config.limits.maxSymbols,
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (err instanceof IndexAborted) return makeError('ast_transform_apply', 'aborted', err.message);
    if (err instanceof IndexBudgetExceeded) {
      return makeError('ast_transform_apply', 'index_budget_exceeded', err.message, { kind: err.kind });
    }
    return makeError('ast_transform_apply', 'index_error', (err as Error).message);
  }
  if (index.indexRevision !== preview.indexRevision) {
    return makeError('ast_transform_apply', 'index_drift', 'the language index changed since preview', {
      expected: preview.indexRevision,
      actual: index.indexRevision,
    });
  }
  if (ts.version !== preview.engineVersion) {
    return makeError('ast_transform_apply', 'engine_mismatch', 'language engine version changed since preview', {
      expected: preview.engineVersion,
      actual: ts.version,
    });
  }

  // --- Delegate the already-bound patch to the NativePatch runtime -----------
  const validation = validateNativePatch(preview.patch);
  if (!validation.ok) {
    return makeError('ast_transform_apply', 'invalid_patch', 'sealed patch failed NativePatch validation', {
      errors: validation.errors,
    });
  }

  try {
    const result = await applyNativePatch(ctx.worktreeAbsolute, validation.value, { phase: ctx.phase });
    if (!result.ok) {
      ctx.recorder?.recordMutation({
        tool: 'ast_transform_apply',
        status: 'failed',
        path: validation.value.operations[0]?.path,
        reason: result.rejection.message,
      });
      return makeError('ast_transform_apply', 'patch_rejected', result.rejection.message, {
        rejection: result.rejection,
      });
    }

    for (const changedFile of result.changedFiles) {
      ctx.recorder?.recordMutation({ tool: 'ast_transform_apply', status: 'completed', path: changedFile });
    }
    ctx.recorder?.recordPatchSnapshots(result.snapshots);

    const details: AstTransformApplySuccessDetails = {
      ok: true,
      tool: 'ast_transform_apply',
      status: 'ok',
      transform: preview.transform,
      symbol: preview.symbol,
      patchDigest: preview.patchDigest,
      result,
    };
    return {
      content: [{ type: 'text', text: summarizeApply(details) }],
      details,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.recorder?.recordMutation({
      tool: 'ast_transform_apply',
      status: 'failed',
      path: validation.value.operations[0]?.path,
      reason: message,
    });
    return makeError('ast_transform_apply', 'io_error', `failed to apply transform: ${message}`);
  }
}

function summarizeApply(details: AstTransformApplySuccessDetails): string {
  const files = details.result.changedFiles.join(', ');
  return `Applied ${details.transform} of "${details.symbol}" to ${details.result.changedFiles.length} file(s); ` +
    `${details.result.linesAdded} line(s) added, ${details.result.linesRemoved} removed${files ? `: ${files}` : ''}.`;
}

function validatePreviewStructure(preview: unknown): string | null {
  if (typeof preview !== 'object' || preview === null) return 'preview must be an object';
  const p = preview as Record<string, unknown>;
  if (typeof p.previewDigest !== 'string' || p.previewDigest.length === 0) return 'preview.previewDigest is required';
  if (typeof p.patchDigest !== 'string') return 'preview.patchDigest is required';
  if (typeof p.indexRevision !== 'string') return 'preview.indexRevision is required';
  if (typeof p.engineVersion !== 'string') return 'preview.engineVersion is required';
  if (!Array.isArray(p.sourceRevisions) || p.sourceRevisions.length === 0) {
    return 'preview.sourceRevisions must be a non-empty array';
  }
  for (const rev of p.sourceRevisions) {
    if (
      typeof rev !== 'object' || rev === null ||
      typeof (rev as Record<string, unknown>).path !== 'string' ||
      typeof (rev as Record<string, unknown>).digest !== 'string'
    ) {
      return 'each preview.sourceRevisions entry needs a path and digest';
    }
  }
  if (typeof p.patch !== 'object' || p.patch === null) return 'preview.patch is required';
  return null;
}

// ---------------------------------------------------------------------------
// Parameter types + JSON schemas
// ---------------------------------------------------------------------------

export interface AstTransformPreviewParams {
  transform: AstTransformKind;
  symbol: string;
  replacement: string;
  path?: string;
  language?: string;
}

export interface AstTransformApplyParams {
  preview: AstTransformPreview;
}

const AST_TRANSFORM_PREVIEW_SCHEMA = {
  type: 'object',
  required: ['transform', 'symbol', 'replacement'],
  additionalProperties: false,
  properties: {
    transform: {
      type: 'string',
      enum: [...AST_TRANSFORM_KINDS],
      description: 'Named transform kind. rename_symbol requires an identifier replacement; rewrite_symbol accepts arbitrary replacement text.',
    },
    symbol: {
      type: 'string',
      minLength: 1,
      description: 'Exact identifier to transform (definition + every reference).',
    },
    replacement: {
      type: 'string',
      minLength: 1,
      description: 'New identifier (rename_symbol) or replacement text (rewrite_symbol).',
    },
    path: {
      type: 'string',
      description: 'Optional worktree-relative file or directory that scopes and disambiguates the transform.',
    },
    language: {
      type: 'string',
      description: 'Optional language hint. Only the TypeScript/JavaScript engine is supported; other languages fail closed.',
    },
  },
} as const;

const AST_TRANSFORM_APPLY_SCHEMA = {
  type: 'object',
  required: ['preview'],
  additionalProperties: false,
  properties: {
    preview: {
      type: 'object',
      description: 'The exact, unmodified preview object returned by ast_transform_preview. Any edit invalidates its digest and the apply is refused.',
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the AST-transform tool descriptors. Returns `[]` when config is null
 * or disabled so the exposure engine sees no `ast` family at all.
 */
export function createAstTransformTools(input: CreateAstTransformToolsInput): ToolDescriptor[] {
  if (!input.config || !input.config.enabled) return [];

  const worktreeAbsolute = path.resolve(input.worktreePath);
  const phase = input.phase ?? 'coding';

  const previewCtx: PreviewCtx = {
    worktreeAbsolute,
    config: input.config,
    ...(input.formatter ? { formatter: input.formatter } : {}),
    ...(input.formatterName ? { formatterName: input.formatterName } : {}),
  };
  const applyCtx: ApplyCtx = {
    worktreeAbsolute,
    config: input.config,
    phase,
    ...(input.recorder ? { recorder: input.recorder } : {}),
  };

  const baseMeta = {
    allowedPhases: ['coding'] as const,
    executionMode: 'sequential' as const,
    family: 'ast' as const,
    exposure: 'opt-in' as const,
    certificationRequirement: 'patch' as const,
  };

  return [
    {
      metadata: {
        ...baseMeta,
        name: 'ast_transform_preview',
        logicalId: 'ast.transform_preview',
        class: 'read-only',
        description:
          'Preview a policy-bound structured source transform (rename_symbol/rewrite_symbol) using the TypeScript language index. Performs ZERO file writes and returns a digest-sealed, versioned preview containing the exact NativePatch, matched ranges, and source/index revisions. Coding-only; worktree-scoped; unsupported languages and ambiguous symbols fail closed. Feed the returned preview verbatim to ast_transform_apply.',
        outputCapPolicy: { strategy: 'truncate' as const, maxItems: input.config.limits.maxMatches },
      },
      parameters: AST_TRANSFORM_PREVIEW_SCHEMA,
      async execute(_toolCallId, params, signal) {
        return computePreview(previewCtx, params as AstTransformPreviewParams, signal);
      },
    } as ToolDescriptor<AstTransformPreviewParams, AstTransformPreviewDetails>,
    {
      metadata: {
        ...baseMeta,
        name: 'ast_transform_apply',
        logicalId: 'ast.transform_apply',
        class: 'mutation',
        description:
          'Apply a previously previewed AST transform. Accepts only the unmodified preview from ast_transform_preview, revalidates live source content and index revision against the sealed digest, and — only when nothing drifted — applies the bound atomic NativePatch through the standard patch runtime. Rejects tampered previews and any source/index drift without touching the tree. Coding-only.',
        outputCapPolicy: { strategy: 'none' as const },
      },
      parameters: AST_TRANSFORM_APPLY_SCHEMA,
      async execute(_toolCallId, params, signal) {
        return applyPreview(applyCtx, params as AstTransformApplyParams, signal);
      },
    } as ToolDescriptor<AstTransformApplyParams, AstTransformApplyDetails>,
  ];
}

// ---------------------------------------------------------------------------
// after-tool-call hook + path-field policy config
// ---------------------------------------------------------------------------

interface AfterToolCallContext {
  toolCall: { name: string };
  result: { details: unknown };
}

/**
 * Surface a failed AST transform as a tool error to the loop, mirroring
 * `apply_patch`'s after-tool-call convention so mutation-failure tracking and
 * transcript evidence stay uniform.
 */
export async function astTransformAfterToolCall(
  context: AfterToolCallContext,
): Promise<{ isError?: boolean } | undefined> {
  if (context.toolCall.name !== 'ast_transform_preview' && context.toolCall.name !== 'ast_transform_apply') {
    return undefined;
  }
  const details = context.result.details as { ok?: unknown } | undefined;
  if (!details || typeof details !== 'object' || !('ok' in details)) {
    return undefined;
  }
  return details.ok ? undefined : { isError: true };
}

/** Path fields for policies.ts beforeToolCall enforcement. */
export const AST_TRANSFORM_PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  ast_transform_preview: ['path'],
};
