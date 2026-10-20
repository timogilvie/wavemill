/**
 * Build a reverse-dependency index of TS/JS files in the repo via regex scan.
 *
 * Only intra-repo relative imports (`./`, `../`) and extensionless specifiers
 * are resolved — package imports are ignored. The result is cached under
 * `.wavemill/cache/related-test-graph.json`, keyed by a hash of the scanned
 * files' mtimes and sizes, so a stale cache is rebuilt automatically.
 *
 * This is deliberately lightweight — regex, not `tsc --listFiles` — because
 * the selector runs on every coding-phase verify and must stay sub-second
 * cold for a mid-size repo.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface TsGraph {
  /** Repo-relative imported path → list of repo-relative files that import it. */
  reverse: Record<string, string[]>;
  /** Scanned file paths. */
  files: string[];
  /** Hash key the cache was built from. */
  hash: string;
}

const SCAN_DIRS = ['shared', 'tools', 'src', 'tests'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'worktrees', '.wavemill', 'dist', 'build', 'coverage']);
const TS_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];
const RESOLVE_SUFFIXES = ['.ts', '.tsx', '/index.ts', '/index.tsx', '.js', '.mjs', '.cjs', '/index.js', '/index.mjs'];
const IMPORT_RE = /(?:import\s+(?:[^'"]+?\s+from\s+)?|import\s*\(\s*|require\s*\(\s*|export\s+(?:\*|\{[^}]*\})\s+from\s+)['"]([^'"]+)['"]/g;

function listScanRoots(repoRoot: string): string[] {
  const override = process.env.WAVEMILL_RUN_RELATED_SCAN_ROOTS;
  if (override) {
    return override.split(':').filter(Boolean).map((p) => path.resolve(repoRoot, p));
  }
  return SCAN_DIRS.map((d) => path.join(repoRoot, d)).filter((p) => existsSync(p));
}

function walk(dir: string, repoRoot: string, out: string[]): void {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, repoRoot, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name);
    if (!TS_EXTENSIONS.includes(ext)) continue;
    out.push(path.relative(repoRoot, full));
  }
}

export function collectTsFiles(repoRoot: string): string[] {
  const files: string[] = [];
  for (const root of listScanRoots(repoRoot)) {
    walk(root, repoRoot, files);
  }
  files.sort();
  return files;
}

function hashFiles(repoRoot: string, files: string[]): string {
  const h = createHash('sha1');
  for (const rel of files) {
    const abs = path.join(repoRoot, rel);
    try {
      const st = statSync(abs);
      h.update(rel);
      h.update('|');
      h.update(String(st.mtimeMs));
      h.update('|');
      h.update(String(st.size));
      h.update('\n');
    } catch {
      // deleted between walk and stat — skip
    }
  }
  return h.digest('hex');
}

/**
 * Try to resolve `./foo` or `../foo/bar` against `fromFile` to a repo-relative
 * path, respecting extensionless imports. Returns null for package specifiers.
 */
export function resolveSpecifier(fromFile: string, specifier: string, repoRoot: string): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return null;
  }
  let base: string;
  if (specifier.startsWith('/')) {
    base = specifier;
  } else {
    base = path.join(path.dirname(fromFile), specifier);
  }
  // Normalize to repo-relative POSIX path
  const abs = path.resolve(repoRoot, base);
  const relBase = path.relative(repoRoot, abs).split(path.sep).join('/');
  // Try as-is first (handles explicit extension in specifier)
  if (path.extname(relBase) && existsSync(path.join(repoRoot, relBase))) {
    return relBase;
  }
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = relBase + suffix;
    if (existsSync(path.join(repoRoot, candidate))) {
      return candidate;
    }
  }
  // Allow explicit .ts suffix in specifier (TS extension-less convention)
  const explicit = relBase;
  if (existsSync(path.join(repoRoot, explicit))) {
    return explicit;
  }
  return null;
}

function extractSpecifiers(source: string): string[] {
  const found: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPORT_RE.exec(source)) !== null) {
    if (match[1]) found.push(match[1]);
  }
  return found;
}

export function buildReverseIndex(repoRoot: string, files: string[]): Record<string, string[]> {
  const reverse: Record<string, Set<string>> = {};
  for (const rel of files) {
    let source: string;
    try {
      source = readFileSync(path.join(repoRoot, rel), 'utf8');
    } catch {
      continue;
    }
    const specifiers = extractSpecifiers(source);
    for (const spec of specifiers) {
      const target = resolveSpecifier(rel, spec, repoRoot);
      if (!target) continue;
      if (!reverse[target]) reverse[target] = new Set();
      reverse[target].add(rel);
    }
  }
  const out: Record<string, string[]> = {};
  const keys = Object.keys(reverse).sort();
  for (const key of keys) {
    out[key] = Array.from(reverse[key]!).sort();
  }
  return out;
}

function cachePath(repoRoot: string): string {
  return path.join(repoRoot, '.wavemill', 'cache', 'related-test-graph.json');
}

function tryReadCache(repoRoot: string): TsGraph | null {
  const p = cachePath(repoRoot);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as TsGraph;
    if (parsed && typeof parsed === 'object' && typeof parsed.hash === 'string' && parsed.reverse && Array.isArray(parsed.files)) {
      return parsed;
    }
    return null;
  } catch {
    // Corrupt JSON — remove so a future write doesn't fail
    try { renameSync(p, p + '.bad'); } catch { /* ignore */ }
    return null;
  }
}

function writeCache(repoRoot: string, graph: TsGraph): void {
  const p = cachePath(repoRoot);
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(graph), 'utf8');
  renameSync(tmp, p);
}

/**
 * Build or load the reverse-dependency graph. Rebuilds in place when the
 * cache hash is stale.
 */
export function loadOrBuildGraph(repoRoot: string): TsGraph {
  const files = collectTsFiles(repoRoot);
  const hash = hashFiles(repoRoot, files);
  const cached = tryReadCache(repoRoot);
  if (cached && cached.hash === hash) {
    return cached;
  }
  const reverse = buildReverseIndex(repoRoot, files);
  const graph: TsGraph = { reverse, files, hash };
  try {
    writeCache(repoRoot, graph);
  } catch {
    // Cache write is best-effort; the graph is still usable.
  }
  return graph;
}

/**
 * BFS the reverse index from `seeds` and return all transitive dependents.
 * The seeds themselves are included. Bounded at `maxNodes` to avoid runaway
 * fan-out in pathological cases.
 */
export function transitiveDependents(
  graph: Pick<TsGraph, 'reverse'>,
  seeds: readonly string[],
  maxNodes = 2000,
): string[] {
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const seed of seeds) {
    if (!visited.has(seed)) {
      visited.add(seed);
      queue.push(seed);
    }
  }
  while (queue.length > 0 && visited.size < maxNodes) {
    const node = queue.shift()!;
    const parents = graph.reverse[node];
    if (!parents) continue;
    for (const parent of parents) {
      if (!visited.has(parent)) {
        visited.add(parent);
        queue.push(parent);
      }
    }
  }
  return Array.from(visited).sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repoRoot = process.cwd();
  const graph = loadOrBuildGraph(repoRoot);
  process.stdout.write(JSON.stringify({ files: graph.files.length, edges: Object.keys(graph.reverse).length, cache: cachePath(repoRoot) }, null, 2) + '\n');
}
