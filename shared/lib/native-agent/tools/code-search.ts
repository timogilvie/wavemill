// ---------------------------------------------------------------------------
// Native `code_search` family tool descriptors (HOK-3059).
//
// Opt-in, read-only, worktree-scoped structured code search backed by the
// TypeScript-compiler-API language index (`../language-index.ts`). Non-TS
// languages either surface a structured `unsupported_language` state or, when
// the caller passes `fallback: true`, delegate to the injected `search_text`
// executor verbatim.
//
// Every output is byte-stable: canonical JSON, sorted keys, no timestamps and
// no per-run randomness. Redaction runs over both the returned content and
// the details payload before it leaves the executor.
// ---------------------------------------------------------------------------

import path from 'node:path';

import type { ResolvedNativeCodeSearchConfig } from '../../config.ts';
import { redactSecrets, redactSecretsInValue } from '../../redaction-profiles.ts';
import {
  buildLanguageIndex,
  detectLanguage,
  IndexAborted,
  IndexBudgetExceeded,
  type LanguageIndex,
  type LanguageIndexResultSet,
} from '../language-index.ts';
import { buildTrustMetadata } from '../provenance.ts';
import { resolveInsideWorktree } from './read-only.ts';
import type { ToolDescriptor, ToolExecutor, WavemillToolResult } from './types.ts';

// ---------------------------------------------------------------------------
// Public factory input
// ---------------------------------------------------------------------------

export interface CreateCodeSearchToolsInput {
  config: ResolvedNativeCodeSearchConfig | null;
  worktreePath: string;
  /**
   * When a caller passes `fallback: true` on an unsupported language, we
   * delegate to the injected `search_text` executor and return its result
   * verbatim (with `details.fallback: true` for observability).
   */
  searchTextExecutor?: ToolExecutor<SearchTextFallbackParams, unknown>;
}

// ---------------------------------------------------------------------------
// Parameter and detail types
// ---------------------------------------------------------------------------

export interface CodeSearchSymbolsParams {
  symbol?: string;
  pattern?: string;
  path?: string;
  language?: string;
  maxResults?: number;
  fallback?: boolean;
}

export interface CodeSearchDefinitionParams {
  symbol: string;
  path?: string;
  language?: string;
  maxResults?: number;
  fallback?: boolean;
}

export interface CodeSearchReferencesParams {
  symbol: string;
  path?: string;
  language?: string;
  maxResults?: number;
  fallback?: boolean;
}

export interface CodeSearchCallSitesParams {
  symbol: string;
  path?: string;
  language?: string;
  maxResults?: number;
  fallback?: boolean;
}

export interface SearchTextFallbackParams {
  query: string;
  path?: string;
  glob?: string;
  caseSensitive?: boolean;
  maxResults?: number;
}

export interface CodeSearchDetails {
  action: 'symbols' | 'definition' | 'references' | 'call_sites';
  symbol: string | null;
  pattern?: string;
  path?: string;
  language?: string;
  status: 'ok' | 'unsupported_language' | 'stale_index';
  fallback: false;
  matches: LanguageIndexResultSet['matches'];
  meta: LanguageIndexResultSet['meta'];
  maxResults: number;
}

export interface CodeSearchFallbackDetails {
  action: 'symbols' | 'definition' | 'references' | 'call_sites';
  fallback: true;
  status: 'ok';
  underlying: unknown;
}

export interface CodeSearchErrorDetails {
  error: string;
  message: string;
  language?: string;
  indexRevision?: string;
  currentRevision?: string;
}

// ---------------------------------------------------------------------------
// Canonical JSON helpers
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

// ---------------------------------------------------------------------------
// Result envelope helpers
// ---------------------------------------------------------------------------

function makeError(
  code: string,
  message: string,
  extra: Partial<CodeSearchErrorDetails> = {},
): WavemillToolResult<CodeSearchErrorDetails> {
  const details: CodeSearchErrorDetails = { error: code, message, ...extra };
  const text = canonicalJson(details);
  return {
    content: [{ type: 'text', text }],
    details,
    metadata: { trust: buildTrustMetadata({ sourceKind: 'file', details }) },
  };
}

function wrapSuccess(details: CodeSearchDetails): WavemillToolResult<CodeSearchDetails> {
  const redactedDetails = redactSecretsInValue(details) as {
    value: CodeSearchDetails;
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
        categories: [
          ...new Set([...redactedText.categories, ...redactedDetails.categories]),
        ],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Language-index cache — one instance per executor invocation stack
// ---------------------------------------------------------------------------

interface IndexCache {
  index: LanguageIndex | null;
  revision: string | null;
}

async function ensureIndex(
  cache: IndexCache,
  worktreeAbsolute: string,
  config: ResolvedNativeCodeSearchConfig,
  signal?: AbortSignal,
): Promise<LanguageIndex> {
  if (cache.index) return cache.index;
  const index = await buildLanguageIndex(worktreeAbsolute, {
    maxFiles: config.limits.maxFiles,
    maxBytes: config.limits.maxBytes,
    maxSymbols: config.limits.maxSymbols,
    signal,
  });
  cache.index = index;
  cache.revision = index.indexRevision;
  return index;
}

// ---------------------------------------------------------------------------
// Parameter validation
// ---------------------------------------------------------------------------

function requireSymbol(
  action: CodeSearchDetails['action'],
  symbol: unknown,
): WavemillToolResult<CodeSearchErrorDetails> | string {
  if (typeof symbol !== 'string' || symbol.trim() === '') {
    return makeError('invalid_params', `${action} requires a non-empty symbol`);
  }
  return symbol.trim();
}

function extractLanguageHint(params: { path?: string; language?: string }): {
  language: string | null;
  isTs: boolean;
} {
  const hint = params.language?.toLowerCase();
  if (hint === 'typescript' || hint === 'ts' || hint === 'javascript' || hint === 'js') {
    return { language: 'typescript', isTs: true };
  }
  if (hint) return { language: hint, isTs: false };
  if (params.path) {
    const lang = detectLanguage(params.path);
    if (lang === 'typescript') return { language: 'typescript', isTs: true };
    const ext = path.extname(params.path).toLowerCase();
    // Best-effort surface label for unsupported languages.
    const map: Record<string, string> = {
      '.py': 'python',
      '.rb': 'ruby',
      '.go': 'go',
      '.rs': 'rust',
      '.java': 'java',
      '.kt': 'kotlin',
      '.md': 'markdown',
      '.txt': 'text',
    };
    return { language: map[ext] ?? ext.replace(/^\./, '') ?? null, isTs: false };
  }
  // No hint at all: treat as typescript engine (whole-worktree index).
  return { language: 'typescript', isTs: true };
}

async function pathInsideWorktree(
  worktreeAbsolute: string,
  candidate: string | undefined,
): Promise<WavemillToolResult<CodeSearchErrorDetails> | null> {
  if (!candidate) return null;
  const resolved = await resolveInsideWorktree(worktreeAbsolute, candidate);
  if (resolved.kind === 'error') {
    return makeError(resolved.code, resolved.message);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Executor bodies
// ---------------------------------------------------------------------------

interface ExecutorCtx {
  worktreeAbsolute: string;
  config: ResolvedNativeCodeSearchConfig;
  searchTextExecutor?: ToolExecutor<SearchTextFallbackParams, unknown>;
  cache: IndexCache;
}

async function runOrError<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; result: WavemillToolResult<CodeSearchErrorDetails> }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof IndexAborted) {
      return { ok: false, result: makeError('aborted', err.message) };
    }
    if (err instanceof IndexBudgetExceeded) {
      return { ok: false, result: makeError('index_budget_exceeded', err.message) };
    }
    const message = (err as Error).message ?? String(err);
    return { ok: false, result: makeError('index_error', message) };
  }
}

async function executeAction(
  ctx: ExecutorCtx,
  action: CodeSearchDetails['action'],
  params: {
    symbol?: string;
    pattern?: string;
    path?: string;
    language?: string;
    maxResults?: number;
    fallback?: boolean;
  },
  toolCallId: string,
  signal: AbortSignal | undefined,
): Promise<WavemillToolResult<CodeSearchDetails | CodeSearchFallbackDetails | CodeSearchErrorDetails>> {
  if (signal?.aborted) return makeError('aborted', 'signal aborted before executor started');

  if (params.maxResults !== undefined && (!Number.isFinite(params.maxResults) || params.maxResults <= 0)) {
    return makeError('invalid_params', 'maxResults must be a positive integer');
  }

  const pathCheck = await pathInsideWorktree(ctx.worktreeAbsolute, params.path);
  if (pathCheck) return pathCheck;

  const lang = extractLanguageHint(params);

  if (!lang.isTs) {
    if (params.fallback === true) {
      if (!ctx.searchTextExecutor) {
        return makeError('fallback_unavailable', 'search_text executor was not injected');
      }
      const symbolOrPattern = params.symbol ?? params.pattern ?? '';
      if (!symbolOrPattern) {
        return makeError('invalid_params', 'fallback requires a symbol or pattern to search for');
      }
      const fallbackParams: SearchTextFallbackParams = {
        query: symbolOrPattern,
        ...(params.path ? { path: params.path } : {}),
        ...(params.maxResults ? { maxResults: params.maxResults } : {}),
      };
      const underlying = await ctx.searchTextExecutor(toolCallId, fallbackParams, signal);
      const fallbackDetails: CodeSearchFallbackDetails = {
        action,
        fallback: true,
        status: 'ok',
        underlying: underlying.details,
      };
      return {
        content: underlying.content,
        details: fallbackDetails,
        metadata: underlying.metadata,
      };
    }
    return makeError('unsupported_language', `language "${lang.language}" is not supported`, {
      language: lang.language ?? undefined,
    });
  }

  // TypeScript engine path.
  const indexResult = await runOrError(() => ensureIndex(ctx.cache, ctx.worktreeAbsolute, ctx.config, signal));
  if (indexResult.ok === false) return indexResult.result;
  const index = indexResult.value;

  const maxResults = clampMax(params.maxResults, ctx.config.limits.maxResults);

  let query: LanguageIndexResultSet;
  try {
    switch (action) {
      case 'symbols': {
        const q: { symbol?: string; pattern?: string } = {};
        if (params.symbol) q.symbol = params.symbol;
        if (params.pattern) q.pattern = params.pattern;
        query = await index.findSymbols(q, { ...(params.path ? { path: params.path } : {}), maxResults, ...(signal ? { signal } : {}) });
        break;
      }
      case 'definition':
        query = await index.findDefinition(params.symbol!, {
          ...(params.path ? { path: params.path } : {}),
          maxResults,
          ...(signal ? { signal } : {}),
        });
        break;
      case 'references':
        query = await index.findReferences(params.symbol!, {
          ...(params.path ? { path: params.path } : {}),
          maxResults,
          ...(signal ? { signal } : {}),
        });
        break;
      case 'call_sites':
        query = await index.findCallSites(params.symbol!, {
          ...(params.path ? { path: params.path } : {}),
          maxResults,
          ...(signal ? { signal } : {}),
        });
        break;
    }
  } catch (err) {
    if (err instanceof IndexAborted) return makeError('aborted', err.message);
    return makeError('index_error', (err as Error).message);
  }

  const status: CodeSearchDetails['status'] = query.meta.staleness ? 'stale_index' : 'ok';
  const details: CodeSearchDetails = {
    action,
    symbol: params.symbol ?? null,
    ...(params.pattern ? { pattern: params.pattern } : {}),
    ...(params.path ? { path: params.path } : {}),
    ...(lang.language ? { language: lang.language } : {}),
    status,
    fallback: false,
    matches: query.matches,
    meta: query.meta,
    maxResults,
  };
  return wrapSuccess(details);
}

function clampMax(candidate: number | undefined, limit: number): number {
  if (candidate === undefined) return limit;
  const n = Math.floor(candidate);
  if (!Number.isFinite(n) || n <= 0) return limit;
  return Math.min(n, limit);
}

// ---------------------------------------------------------------------------
// JSON Schema definitions
// ---------------------------------------------------------------------------

const CODE_SEARCH_SYMBOLS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    symbol: { type: 'string', description: 'Exact symbol name to look up.' },
    pattern: {
      type: 'string',
      description: 'Regular-expression pattern to match symbol names (JavaScript syntax).',
    },
    path: {
      type: 'string',
      description: 'Restrict results to a file or directory relative to the worktree root.',
    },
    language: {
      type: 'string',
      description: 'Optional hint (e.g. "typescript", "python") — used for language dispatch.',
    },
    maxResults: {
      type: 'integer',
      minimum: 1,
      maximum: 200,
      description: 'Maximum number of results to return (default: family limit).',
    },
    fallback: {
      type: 'boolean',
      description: 'When true and the language is unsupported, delegate to search_text.',
    },
  },
} as const;

const CODE_SEARCH_SYMBOL_QUERY_SCHEMA = {
  type: 'object',
  required: ['symbol'],
  additionalProperties: false,
  properties: {
    symbol: {
      type: 'string',
      minLength: 1,
      description: 'Exact symbol name to look up.',
    },
    path: {
      type: 'string',
      description: 'Restrict results to a file or directory relative to the worktree root.',
    },
    language: {
      type: 'string',
      description: 'Optional hint (e.g. "typescript", "python") — used for language dispatch.',
    },
    maxResults: {
      type: 'integer',
      minimum: 1,
      maximum: 200,
      description: 'Maximum number of results to return (default: family limit).',
    },
    fallback: {
      type: 'boolean',
      description: 'When true and the language is unsupported, delegate to search_text.',
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the four code-search tool descriptors. Returns `[]` when config is
 * null or disabled, so the exposure engine sees no `code_search` family at
 * all.
 */
export function createCodeSearchTools(input: CreateCodeSearchToolsInput): ToolDescriptor[] {
  if (!input.config || !input.config.enabled) return [];

  const worktreeAbsolute = path.resolve(input.worktreePath);
  // A single shared cache means we build the index once per launch (the
  // executors close over it). Session cleanup drops the descriptor set and
  // therefore the closure and its index.
  const cache: IndexCache = { index: null, revision: null };
  const ctx: ExecutorCtx = {
    worktreeAbsolute,
    config: input.config,
    ...(input.searchTextExecutor ? { searchTextExecutor: input.searchTextExecutor } : {}),
    cache,
  };

  const baseMeta = {
    class: 'read-only' as const,
    allowedPhases: ['planning', 'coding', 'review'] as const,
    executionMode: 'parallel' as const,
    family: 'code_search' as const,
    exposure: 'opt-in' as const,
    certificationRequirement: 'read-only' as const,
    outputCapPolicy: { strategy: 'truncate' as const, maxItems: input.config.limits.maxResults },
  };

  return [
    {
      metadata: {
        ...baseMeta,
        name: 'code_search_symbols',
        logicalId: 'code_search.symbols',
        description:
          'Enumerate structured symbol occurrences (definitions and references) matching a symbol name or regular-expression pattern. Read-only; worktree-scoped; falls back to text search only when fallback: true and the language is unsupported.',
      },
      parameters: CODE_SEARCH_SYMBOLS_SCHEMA,
      async execute(toolCallId, params, signal) {
        const p = params as CodeSearchSymbolsParams;
        if (!p.symbol && !p.pattern) {
          return makeError('invalid_params', 'code_search_symbols requires symbol or pattern');
        }
        return executeAction(ctx, 'symbols', p, toolCallId, signal);
      },
    } as ToolDescriptor<CodeSearchSymbolsParams, CodeSearchDetails | CodeSearchFallbackDetails | CodeSearchErrorDetails>,
    {
      metadata: {
        ...baseMeta,
        name: 'code_search_definition',
        logicalId: 'code_search.definition',
        description:
          'Return the defining location(s) for a given symbol in the worktree. Read-only; worktree-scoped; supports language fallback to search_text.',
      },
      parameters: CODE_SEARCH_SYMBOL_QUERY_SCHEMA,
      async execute(toolCallId, params, signal) {
        const p = params as CodeSearchDefinitionParams;
        const check = requireSymbol('definition', p.symbol);
        if (typeof check !== 'string') return check;
        return executeAction(ctx, 'definition', { ...p, symbol: check }, toolCallId, signal);
      },
    } as ToolDescriptor<CodeSearchDefinitionParams, CodeSearchDetails | CodeSearchFallbackDetails | CodeSearchErrorDetails>,
    {
      metadata: {
        ...baseMeta,
        name: 'code_search_references',
        logicalId: 'code_search.references',
        description:
          'Return every reference site for a given symbol in the worktree. Read-only; worktree-scoped; supports language fallback to search_text.',
      },
      parameters: CODE_SEARCH_SYMBOL_QUERY_SCHEMA,
      async execute(toolCallId, params, signal) {
        const p = params as CodeSearchReferencesParams;
        const check = requireSymbol('references', p.symbol);
        if (typeof check !== 'string') return check;
        return executeAction(ctx, 'references', { ...p, symbol: check }, toolCallId, signal);
      },
    } as ToolDescriptor<CodeSearchReferencesParams, CodeSearchDetails | CodeSearchFallbackDetails | CodeSearchErrorDetails>,
    {
      metadata: {
        ...baseMeta,
        name: 'code_search_call_sites',
        logicalId: 'code_search.call_sites',
        description:
          'Return every call site for a callable symbol in the worktree. Read-only; worktree-scoped; supports language fallback to search_text.',
      },
      parameters: CODE_SEARCH_SYMBOL_QUERY_SCHEMA,
      async execute(toolCallId, params, signal) {
        const p = params as CodeSearchCallSitesParams;
        const check = requireSymbol('call_sites', p.symbol);
        if (typeof check !== 'string') return check;
        return executeAction(ctx, 'call_sites', { ...p, symbol: check }, toolCallId, signal);
      },
    } as ToolDescriptor<CodeSearchCallSitesParams, CodeSearchDetails | CodeSearchFallbackDetails | CodeSearchErrorDetails>,
  ];
}

// ---------------------------------------------------------------------------
// Path field config for policies.ts beforeToolCall enforcement
// ---------------------------------------------------------------------------

export const CODE_SEARCH_PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  code_search_symbols: ['path'],
  code_search_definition: ['path'],
  code_search_references: ['path'],
  code_search_call_sites: ['path'],
};
