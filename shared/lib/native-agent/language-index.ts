// ---------------------------------------------------------------------------
// Language intelligence substrate for the native `code_search` tool family
// (HOK-3059).
//
// Provides a worktree-scoped, in-process, deterministic index built with the
// TypeScript compiler API. Anything outside the TypeScript/JavaScript family
// is reported as `unsupported_language`; callers may explicitly fall back to
// plain text search at the tool layer.
//
// Design invariants:
//   * No shared daemon and no filesystem-persistent cache. The index lives
//     only in the returned instance.
//   * All emitted paths are worktree-relative.
//   * `indexRevision` depends only on `(relPath, mtimeMs, size)` so it does
//     not leak commit identity and stays stable across processes.
//   * Every filesystem read is passed the caller's AbortSignal and the
//     iteration budgets are checked before each expensive operation.
//   * Budget overflow terminates the build; no partial index is returned.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import * as ts from 'typescript';

import { resolveInsideWorktree } from './tools/read-only.ts';

// ---------------------------------------------------------------------------
// Node 22 fs.glob typing (mirrors read-only.ts)
// ---------------------------------------------------------------------------

interface GlobDirent {
  name: string;
  parentPath: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface GlobOptions {
  cwd?: string;
  withFileTypes?: boolean;
  follow?: boolean;
  exclude?: (path: string) => boolean;
}

const { glob: nodeGlob } = fsPromises as unknown as {
  glob(pattern: string, options: GlobOptions & { withFileTypes: true }): AsyncIterable<GlobDirent>;
  glob(pattern: string, options?: GlobOptions): AsyncIterable<string>;
};

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_FILES = 2000;
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024; // 32 MiB
export const DEFAULT_MAX_SYMBOLS = 20_000;
export const DEFAULT_MAX_RESULTS = 200;

export const TS_EXTENSIONS = Object.freeze([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);
const TS_EXTENSION_SET: ReadonlySet<string> = new Set(TS_EXTENSIONS);

// Common non-source directories to skip. The TypeScript engine is not intended
// to descend into vendored trees or the git working area.
const DEFAULT_EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '.wavemill',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'property'
  | 'import'
  | 'unknown';

export type ReferenceKind = 'definition' | 'reference' | 'call' | 'import' | 'export';

export interface LanguageIndexLocation {
  path: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  symbol: string;
  kind: SymbolKind;
  referenceKind: ReferenceKind;
  container?: string;
}

export interface LanguageIndexMeta {
  language: 'typescript';
  engine: 'typescript';
  engineVersion: string;
  indexRevision: string;
  staleness: boolean;
  truncated: boolean;
  totalMatches: number;
  indexedFiles: number;
  scannedBytes: number;
}

export interface LanguageIndexResultSet {
  matches: LanguageIndexLocation[];
  meta: LanguageIndexMeta;
}

export interface BuildLanguageIndexOptions {
  maxFiles?: number;
  maxBytes?: number;
  maxSymbols?: number;
  signal?: AbortSignal;
}

export interface QueryOptions {
  maxResults?: number;
  path?: string;
  signal?: AbortSignal;
}

export class IndexAborted extends Error {
  constructor(message = 'Language index build aborted by signal') {
    super(message);
    this.name = 'IndexAborted';
  }
}

export class IndexBudgetExceeded extends Error {
  readonly kind: 'maxFiles' | 'maxBytes' | 'maxSymbols';
  constructor(kind: 'maxFiles' | 'maxBytes' | 'maxSymbols', message: string) {
    super(message);
    this.name = 'IndexBudgetExceeded';
    this.kind = kind;
  }
}

interface FileIndexEntry {
  relPath: string;
  mtimeMs: number;
  size: number;
}

// ---------------------------------------------------------------------------
// Language dispatch
// ---------------------------------------------------------------------------

/**
 * Detect language identifier from a file extension. Returns `null` for
 * anything that is not covered by the TypeScript compiler engine.
 */
export function detectLanguage(filePath: string): 'typescript' | null {
  const ext = path.extname(filePath).toLowerCase();
  return TS_EXTENSION_SET.has(ext) ? 'typescript' : null;
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

async function collectSourceFiles(
  worktreeAbsolute: string,
  maxFiles: number,
  signal: AbortSignal | undefined,
): Promise<FileIndexEntry[]> {
  const entries: FileIndexEntry[] = [];
  let realWorktree: string;
  try {
    realWorktree = await realpath(worktreeAbsolute);
  } catch {
    realWorktree = worktreeAbsolute;
  }

  for await (const entry of nodeGlob('**', {
    cwd: worktreeAbsolute,
    withFileTypes: true,
    follow: false,
  })) {
    if (signal?.aborted) throw new IndexAborted();
    if (entry.isDirectory()) continue;
    if (entry.isSymbolicLink()) continue;

    const absPath = path.join(entry.parentPath, entry.name);
    const rel = path.relative(realWorktree, absPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;

    // Skip excluded top-level segments — cheap and stable.
    const firstSegment = rel.split(path.sep)[0];
    if (firstSegment && DEFAULT_EXCLUDE_DIRS.has(firstSegment)) continue;

    if (!TS_EXTENSION_SET.has(path.extname(rel).toLowerCase())) continue;

    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(absPath);
    } catch {
      continue;
    }
    if (!s.isFile()) continue;

    entries.push({ relPath: rel, mtimeMs: s.mtimeMs, size: s.size });

    if (entries.length > maxFiles) {
      throw new IndexBudgetExceeded(
        'maxFiles',
        `Language index build exceeded maxFiles=${maxFiles}`,
      );
    }
  }

  // Deterministic ordering — the caller relies on `indexRevision` being stable.
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return entries;
}

// ---------------------------------------------------------------------------
// Index revision hash
// ---------------------------------------------------------------------------

function computeIndexRevision(files: FileIndexEntry[]): string {
  const hash = createHash('sha1');
  for (const file of files) {
    hash.update(file.relPath);
    hash.update('\0');
    hash.update(String(Math.trunc(file.mtimeMs)));
    hash.update('\0');
    hash.update(String(file.size));
    hash.update('\n');
  }
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// TypeScript AST walker
// ---------------------------------------------------------------------------

function scriptKindFor(filePath: string): ts.ScriptKind {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.mts':
    case '.cts':
      return ts.ScriptKind.TS;
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.JS;
  }
}

function nodeSymbolKind(node: ts.Node): SymbolKind {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    return 'function';
  }
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return 'method';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (
    ts.isVariableDeclaration(node) ||
    ts.isVariableStatement(node) ||
    ts.isVariableDeclarationList(node)
  ) {
    return 'variable';
  }
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isPropertyAssignment(node)) {
    return 'property';
  }
  if (ts.isImportDeclaration(node) || ts.isImportSpecifier(node) || ts.isImportClause(node)) {
    return 'import';
  }
  return 'unknown';
}

function nearestNamedContainer(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) {
      if (current.name && ts.isIdentifier(current.name)) return current.name.text;
    }
    if (ts.isClassDeclaration(current) || ts.isInterfaceDeclaration(current)) {
      if (current.name) return current.name.text;
    }
    current = current.parent;
  }
  return undefined;
}

interface FileWalkAccumulators {
  definitions: LanguageIndexLocation[];
  references: LanguageIndexLocation[];
  calls: LanguageIndexLocation[];
  symbolTable: LanguageIndexLocation[];
}

function positionAt(sourceFile: ts.SourceFile, pos: number): { line: number; column: number } {
  const lc = sourceFile.getLineAndCharacterOfPosition(pos);
  return { line: lc.line + 1, column: lc.character + 1 };
}

function makeLocation(
  sourceFile: ts.SourceFile,
  relPath: string,
  node: ts.Node,
  symbol: string,
  kind: SymbolKind,
  referenceKind: ReferenceKind,
  container?: string,
): LanguageIndexLocation {
  const start = positionAt(sourceFile, node.getStart(sourceFile));
  const end = positionAt(sourceFile, node.getEnd());
  const location: LanguageIndexLocation = {
    path: relPath,
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
    symbol,
    kind,
    referenceKind,
  };
  if (container) location.container = container;
  return location;
}

function walkSourceFile(
  sourceFile: ts.SourceFile,
  relPath: string,
  acc: FileWalkAccumulators,
): void {
  const importedNames = new Set<string>();

  function recordDefinition(
    node: ts.Node,
    symbol: string,
    kind: SymbolKind,
    container?: string,
  ): void {
    const loc = makeLocation(sourceFile, relPath, node, symbol, kind, 'definition', container);
    acc.definitions.push(loc);
    acc.symbolTable.push(loc);
  }

  function recordReference(
    node: ts.Node,
    symbol: string,
    kind: SymbolKind,
    referenceKind: ReferenceKind,
    container?: string,
  ): void {
    const loc = makeLocation(sourceFile, relPath, node, symbol, kind, referenceKind, container);
    acc.references.push(loc);
    acc.symbolTable.push(loc);
    if (referenceKind === 'call') acc.calls.push(loc);
  }

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      recordDefinition(node.name, node.name.text, 'function');
    } else if (ts.isClassDeclaration(node) && node.name) {
      recordDefinition(node.name, node.name.text, 'class');
    } else if (ts.isInterfaceDeclaration(node)) {
      recordDefinition(node.name, node.name.text, 'interface');
    } else if (ts.isTypeAliasDeclaration(node)) {
      recordDefinition(node.name, node.name.text, 'type');
    } else if (ts.isEnumDeclaration(node)) {
      recordDefinition(node.name, node.name.text, 'enum');
    } else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      const container = nearestNamedContainer(node);
      recordDefinition(node.name, node.name.text, 'method', container);
    } else if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
      const container = nearestNamedContainer(node);
      recordDefinition(node.name, node.name.text, 'property', container);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      recordDefinition(node.name, node.name.text, 'variable');
    } else if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      if (clause.name) {
        importedNames.add(clause.name.text);
        recordReference(clause.name, clause.name.text, 'import', 'import');
      }
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          importedNames.add(clause.namedBindings.name.text);
          recordReference(
            clause.namedBindings.name,
            clause.namedBindings.name.text,
            'import',
            'import',
          );
        } else if (ts.isNamedImports(clause.namedBindings)) {
          for (const spec of clause.namedBindings.elements) {
            importedNames.add(spec.name.text);
            recordReference(spec.name, spec.name.text, 'import', 'import');
          }
        }
      }
    } else if (ts.isExportSpecifier(node)) {
      recordReference(node.name, node.name.text, 'import', 'export');
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        const container = nearestNamedContainer(node);
        recordReference(callee, callee.text, 'function', 'call', container);
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
        const container = nearestNamedContainer(node);
        recordReference(callee.name, callee.name.text, 'method', 'call', container);
      }
    } else if (
      ts.isIdentifier(node) &&
      node.parent &&
      !ts.isVariableDeclaration(node.parent) &&
      !ts.isFunctionDeclaration(node.parent) &&
      !ts.isClassDeclaration(node.parent) &&
      !ts.isInterfaceDeclaration(node.parent) &&
      !ts.isTypeAliasDeclaration(node.parent) &&
      !ts.isEnumDeclaration(node.parent) &&
      !ts.isMethodDeclaration(node.parent) &&
      !ts.isPropertyDeclaration(node.parent) &&
      !ts.isPropertyAssignment(node.parent) &&
      !ts.isImportSpecifier(node.parent) &&
      !ts.isImportClause(node.parent) &&
      !ts.isNamespaceImport(node.parent) &&
      !ts.isExportSpecifier(node.parent) &&
      !ts.isParameter(node.parent) &&
      !ts.isBindingElement(node.parent) &&
      !ts.isPropertyAccessExpression(node.parent)
    ) {
      const parent = node.parent;
      // Skip identifiers that are just the property name in `.name` accesses
      // (those are captured on the container node's callee case).
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
        // no-op
      } else {
        const container = nearestNamedContainer(node);
        recordReference(node, node.text, nodeSymbolKind(node), 'reference', container);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

// ---------------------------------------------------------------------------
// Deterministic sort key
// ---------------------------------------------------------------------------

function compareLocations(a: LanguageIndexLocation, b: LanguageIndexLocation): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.startLine !== b.startLine) return a.startLine - b.startLine;
  if (a.startColumn !== b.startColumn) return a.startColumn - b.startColumn;
  if (a.symbol !== b.symbol) return a.symbol < b.symbol ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.referenceKind !== b.referenceKind) return a.referenceKind < b.referenceKind ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// LanguageIndex class
// ---------------------------------------------------------------------------

export class LanguageIndex {
  private readonly definitionsBySymbol = new Map<string, LanguageIndexLocation[]>();
  private readonly referencesBySymbol = new Map<string, LanguageIndexLocation[]>();
  private readonly callsBySymbol = new Map<string, LanguageIndexLocation[]>();
  private readonly symbols = new Map<string, LanguageIndexLocation[]>();
  private readonly files: FileIndexEntry[];

  readonly worktreeAbsolute: string;
  readonly indexRevision: string;
  readonly indexedFiles: number;
  readonly scannedBytes: number;

  constructor(
    worktreeAbsolute: string,
    files: FileIndexEntry[],
    definitions: LanguageIndexLocation[],
    references: LanguageIndexLocation[],
    calls: LanguageIndexLocation[],
    symbolTable: LanguageIndexLocation[],
    scannedBytes: number,
  ) {
    this.worktreeAbsolute = worktreeAbsolute;
    this.files = files;
    this.indexRevision = computeIndexRevision(files);
    this.indexedFiles = files.length;
    this.scannedBytes = scannedBytes;

    for (const location of definitions) {
      push(this.definitionsBySymbol, location.symbol, location);
    }
    for (const location of references) {
      push(this.referencesBySymbol, location.symbol, location);
    }
    for (const location of calls) {
      push(this.callsBySymbol, location.symbol, location);
    }
    for (const location of symbolTable) {
      push(this.symbols, location.symbol, location);
    }

    for (const bucket of this.definitionsBySymbol.values()) bucket.sort(compareLocations);
    for (const bucket of this.referencesBySymbol.values()) bucket.sort(compareLocations);
    for (const bucket of this.callsBySymbol.values()) bucket.sort(compareLocations);
    for (const bucket of this.symbols.values()) bucket.sort(compareLocations);
  }

  /**
   * Report whether any indexed file's on-disk mtime/size has drifted from the
   * captured snapshot. Cheap read-only check — the caller decides whether to
   * rebuild.
   */
  async isStale(signal?: AbortSignal): Promise<boolean> {
    for (const file of this.files) {
      if (signal?.aborted) throw new IndexAborted();
      let s: Awaited<ReturnType<typeof stat>>;
      try {
        s = await stat(path.join(this.worktreeAbsolute, file.relPath));
      } catch {
        return true;
      }
      if (Math.trunc(s.mtimeMs) !== Math.trunc(file.mtimeMs) || s.size !== file.size) return true;
    }
    return false;
  }

  private buildMeta(
    all: LanguageIndexLocation[],
    truncated: boolean,
    staleness: boolean,
  ): LanguageIndexMeta {
    return {
      language: 'typescript',
      engine: 'typescript',
      engineVersion: ts.version,
      indexRevision: this.indexRevision,
      staleness,
      truncated,
      totalMatches: all.length,
      indexedFiles: this.indexedFiles,
      scannedBytes: this.scannedBytes,
    };
  }

  private filterByPath(
    matches: LanguageIndexLocation[],
    relPathFilter: string | undefined,
  ): LanguageIndexLocation[] {
    if (!relPathFilter) return matches;
    const normalized = relPathFilter.replace(/\\/g, '/');
    if (normalized === '' || normalized === '.') return matches;
    // Match either exact file or prefix directory.
    return matches.filter((m) => {
      const mp = m.path.replace(/\\/g, '/');
      return (
        mp === normalized ||
        mp.startsWith(normalized.endsWith('/') ? normalized : `${normalized}/`)
      );
    });
  }

  private async computeStaleness(signal: AbortSignal | undefined): Promise<boolean> {
    try {
      return await this.isStale(signal);
    } catch (err) {
      if (err instanceof IndexAborted) throw err;
      return true;
    }
  }

  async findSymbols(
    query: { pattern?: string; symbol?: string },
    options: QueryOptions = {},
  ): Promise<LanguageIndexResultSet> {
    const maxResults = clampMaxResults(options.maxResults);
    const stale = await this.computeStaleness(options.signal);

    let matches: LanguageIndexLocation[] = [];
    if (query.symbol) {
      matches = [...(this.symbols.get(query.symbol) ?? [])];
    } else if (query.pattern) {
      const pattern = new RegExp(query.pattern);
      for (const [symbol, bucket] of this.symbols) {
        if (pattern.test(symbol)) matches.push(...bucket);
      }
    } else {
      for (const bucket of this.symbols.values()) matches.push(...bucket);
    }

    matches = this.filterByPath(matches, options.path);
    matches.sort(compareLocations);
    const total = matches.length;
    const truncated = total > maxResults;
    return {
      matches: truncated ? matches.slice(0, maxResults) : matches,
      meta: this.buildMeta(matches, truncated, stale),
    };
  }

  async findDefinition(
    symbol: string,
    options: QueryOptions = {},
  ): Promise<LanguageIndexResultSet> {
    const maxResults = clampMaxResults(options.maxResults);
    const stale = await this.computeStaleness(options.signal);

    let matches = [...(this.definitionsBySymbol.get(symbol) ?? [])];
    matches = this.filterByPath(matches, options.path);
    matches.sort(compareLocations);
    const total = matches.length;
    const truncated = total > maxResults;
    return {
      matches: truncated ? matches.slice(0, maxResults) : matches,
      meta: this.buildMeta(matches, truncated, stale),
    };
  }

  async findReferences(
    symbol: string,
    options: QueryOptions = {},
  ): Promise<LanguageIndexResultSet> {
    const maxResults = clampMaxResults(options.maxResults);
    const stale = await this.computeStaleness(options.signal);

    let matches = [...(this.referencesBySymbol.get(symbol) ?? [])];
    matches = this.filterByPath(matches, options.path);
    matches.sort(compareLocations);
    const total = matches.length;
    const truncated = total > maxResults;
    return {
      matches: truncated ? matches.slice(0, maxResults) : matches,
      meta: this.buildMeta(matches, truncated, stale),
    };
  }

  async findCallSites(
    symbol: string,
    options: QueryOptions = {},
  ): Promise<LanguageIndexResultSet> {
    const maxResults = clampMaxResults(options.maxResults);
    const stale = await this.computeStaleness(options.signal);

    let matches = [...(this.callsBySymbol.get(symbol) ?? [])];
    matches = this.filterByPath(matches, options.path);
    matches.sort(compareLocations);
    const total = matches.length;
    const truncated = total > maxResults;
    return {
      matches: truncated ? matches.slice(0, maxResults) : matches,
      meta: this.buildMeta(matches, truncated, stale),
    };
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = [];
    map.set(key, bucket);
  }
  bucket.push(value);
}

function clampMaxResults(candidate?: number): number {
  if (candidate === undefined) return DEFAULT_MAX_RESULTS;
  const n = Math.floor(candidate);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_RESULTS;
  return Math.min(n, DEFAULT_MAX_RESULTS);
}

// ---------------------------------------------------------------------------
// Public build entry point
// ---------------------------------------------------------------------------

/**
 * Build a language index for the TypeScript engine over the given worktree.
 *
 * On success the returned index is fully populated and every emitted path is
 * worktree-relative. Budget overflow rejects with `IndexBudgetExceeded`. An
 * aborted signal rejects with `IndexAborted` and yields no partial index.
 */
export async function buildLanguageIndex(
  worktreePath: string,
  options: BuildLanguageIndexOptions = {},
): Promise<LanguageIndex> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxSymbols = options.maxSymbols ?? DEFAULT_MAX_SYMBOLS;

  const resolved = await resolveInsideWorktree(worktreePath, '.');
  if (resolved.kind === 'error') {
    throw new Error(`invalid_worktree: ${resolved.message}`);
  }
  const worktreeAbsolute = resolved.absolutePath;

  if (options.signal?.aborted) throw new IndexAborted();
  const files = await collectSourceFiles(worktreeAbsolute, maxFiles, options.signal);

  const definitions: LanguageIndexLocation[] = [];
  const references: LanguageIndexLocation[] = [];
  const calls: LanguageIndexLocation[] = [];
  const symbolTable: LanguageIndexLocation[] = [];
  let scannedBytes = 0;

  for (const entry of files) {
    if (options.signal?.aborted) throw new IndexAborted();
    if (scannedBytes + entry.size > maxBytes) {
      throw new IndexBudgetExceeded(
        'maxBytes',
        `Language index build exceeded maxBytes=${maxBytes} at ${entry.relPath}`,
      );
    }

    let text: string;
    try {
      text = await readFile(path.join(worktreeAbsolute, entry.relPath), {
        encoding: 'utf8',
        signal: options.signal,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.name === 'AbortError' || e.code === 'ABORT_ERR') throw new IndexAborted();
      // Skip files we cannot read; do not blow up the whole build.
      continue;
    }

    scannedBytes += Buffer.byteLength(text, 'utf8');

    const sourceFile = ts.createSourceFile(
      entry.relPath,
      text,
      ts.ScriptTarget.Latest,
      false,
      scriptKindFor(entry.relPath),
    );

    const acc: FileWalkAccumulators = { definitions, references, calls, symbolTable };
    walkSourceFile(sourceFile, entry.relPath, acc);

    if (symbolTable.length > maxSymbols) {
      throw new IndexBudgetExceeded(
        'maxSymbols',
        `Language index build exceeded maxSymbols=${maxSymbols}`,
      );
    }
  }

  return new LanguageIndex(
    worktreeAbsolute,
    files,
    definitions,
    references,
    calls,
    symbolTable,
    scannedBytes,
  );
}
