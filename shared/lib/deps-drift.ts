/**
 * HOK-3254 — stale node_modules detector (TS twin of deps-drift.sh).
 *
 * One stateless primitive consumed by the observer repo detector. The shell
 * twin covers the worktree-startup and monitor-tick hot paths; this twin
 * matches its taxonomy so the two agree on verdicts.
 *
 * Verdicts:
 *   `ok`       — lockfile matches hidden lockfile, or no lockfile at all.
 *   `drift`    — package-lock.json ≠ node_modules/.package-lock.json (or the
 *                direct-dep fallback detected a mismatch).
 *   `unknown`  — pnpm / yarn, or a hash tool / parse error we can't disprove.
 *                Never degraded to `ok`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type DepsDriftStatus = 'ok' | 'drift' | 'unknown';

export interface DepsDriftPackage {
  name: string;
  lockVersion: string | null;
  installedVersion: string | null;
}

export interface DepsDriftResult {
  status: DepsDriftStatus;
  reason: string;
  packages: DepsDriftPackage[];
}

type NpmLockfilePackages = Record<string, { version?: string } | undefined>;
type NpmLockfileDependencies = Record<string, { version?: string } | undefined>;
interface NpmLockfile {
  packages?: NpmLockfilePackages;
  dependencies?: NpmLockfileDependencies;
}

function readJsonFile<T = unknown>(path: string): T | null {
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function versionMap(lockfile: NpmLockfile | null): Record<string, string> {
  if (!lockfile) return {};
  const out: Record<string, string> = {};
  if (lockfile.packages && typeof lockfile.packages === 'object') {
    for (const [key, entry] of Object.entries(lockfile.packages)) {
      if (!entry || typeof entry.version !== 'string') continue;
      if (!key) continue; // the root package has an empty key
      const name = key.startsWith('node_modules/') ? key.slice('node_modules/'.length) : key;
      // Skip nested dependency paths (contain another `node_modules/`) for
      // the direct-dep diff — a nested entry is noise against this check.
      if (name.includes('/node_modules/')) continue;
      out[name] = entry.version;
    }
    return out;
  }
  if (lockfile.dependencies && typeof lockfile.dependencies === 'object') {
    for (const [name, entry] of Object.entries(lockfile.dependencies)) {
      if (!entry || typeof entry.version !== 'string') continue;
      out[name] = entry.version;
    }
  }
  return out;
}

function diffLockfiles(lock: NpmLockfile, hidden: NpmLockfile): DepsDriftPackage[] {
  const lockMap = versionMap(lock);
  const hiddenMap = versionMap(hidden);
  const names = new Set<string>([...Object.keys(lockMap), ...Object.keys(hiddenMap)]);
  const drifted: DepsDriftPackage[] = [];
  for (const name of names) {
    const lockVersion = lockMap[name] ?? null;
    const installedVersion = hiddenMap[name] ?? null;
    if (lockVersion !== installedVersion) {
      drifted.push({ name, lockVersion, installedVersion });
    }
  }
  drifted.sort((a, b) => a.name.localeCompare(b.name));
  return drifted;
}

/**
 * Direct-dependency fallback: compare each top-level dep declared in
 * `package.json` against the installed `node_modules/<name>/package.json`
 * version. Lockfile is the "expected" source when it carries a resolved
 * version; otherwise fall back to the package.json range string.
 */
function diffDirectDeps(dir: string, lockfile: NpmLockfile | null): DepsDriftPackage[] {
  const pkg = readJsonFile<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(join(dir, 'package.json'));
  if (!pkg) return [];
  const lockMap = versionMap(lockfile);
  const direct = new Set<string>([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  const drifted: DepsDriftPackage[] = [];
  for (const name of direct) {
    const expected =
      lockMap[name] ?? pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? null;
    if (!expected) continue;
    const installedPkg = readJsonFile<{ version?: string }>(
      join(dir, 'node_modules', name, 'package.json'),
    );
    const installed = typeof installedPkg?.version === 'string' ? installedPkg.version : null;
    if (installed !== expected) {
      drifted.push({ name, lockVersion: expected, installedVersion: installed });
    }
  }
  drifted.sort((a, b) => a.name.localeCompare(b.name));
  return drifted;
}

function hashFile(path: string): string | null {
  try {
    const buf = readFileSync(path);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function checkDepsDrift(dir: string): DepsDriftResult {
  if (!directoryExists(dir)) {
    return { status: 'ok', reason: 'no-dir', packages: [] };
  }
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) {
    return { status: 'unknown', reason: 'pnpm-not-supported', packages: [] };
  }
  if (existsSync(join(dir, 'yarn.lock'))) {
    return { status: 'unknown', reason: 'yarn-not-supported', packages: [] };
  }
  const lockPath = join(dir, 'package-lock.json');
  if (!existsSync(lockPath)) {
    return { status: 'ok', reason: 'no-lockfile', packages: [] };
  }
  const nmDir = join(dir, 'node_modules');
  if (!directoryExists(nmDir)) {
    return { status: 'drift', reason: 'node_modules-missing', packages: [] };
  }
  const hiddenPath = join(nmDir, '.package-lock.json');
  if (existsSync(hiddenPath)) {
    const lockHash = hashFile(lockPath);
    const hiddenHash = hashFile(hiddenPath);
    if (!lockHash || !hiddenHash) {
      return { status: 'unknown', reason: 'hash-tool-missing', packages: [] };
    }
    if (lockHash === hiddenHash) {
      return { status: 'ok', reason: 'hidden-lockfile-match', packages: [] };
    }
    const lock = readJsonFile<NpmLockfile>(lockPath);
    const hidden = readJsonFile<NpmLockfile>(hiddenPath);
    const packages = lock && hidden ? diffLockfiles(lock, hidden) : [];
    return { status: 'drift', reason: 'hidden-lockfile-mismatch', packages };
  }
  // Fallback: no hidden lockfile. Compare top-level deps against installed
  // package.json versions.
  const lock = readJsonFile<NpmLockfile>(lockPath);
  const packages = diffDirectDeps(dir, lock);
  if (packages.length === 0) {
    return { status: 'ok', reason: 'hidden-lockfile-missing-direct-deps-match', packages: [] };
  }
  return { status: 'drift', reason: 'hidden-lockfile-missing', packages };
}

/** Compact fingerprint of the current lockfile — used by callers as a
 *  bounded-retry key so a fresh dependency bump resets the attempt counter. */
export function depsLockfileFingerprint(dir: string): string | null {
  const lockPath = join(dir, 'package-lock.json');
  return hashFile(lockPath);
}
