/**
 * HOK-3254 / HOK-3315 — the one semantic dependency-install verdict.
 *
 * "Is node_modules what the lockfile says should be installed on this
 * platform?" Compares npm's hidden `node_modules/.package-lock.json`
 * (written by every `npm ci` / `npm install`) against `package-lock.json`,
 * entry by full install path, honouring npm's own platform/optional/link
 * semantics so a foreign-OS optional binary (e.g. `@esbuild/linux-x64` on
 * darwin) or a representation-only byte difference (formatting, the empty
 * root-package key) is never reported as drift. Byte-identity between the
 * two lockfiles is never consulted for the verdict — only
 * {@link depsLockfileFingerprint} uses it, as a retry/cache key.
 *
 * Verdicts:
 *   `ok`       — every package that should be installed on this platform is,
 *                at the version the lockfile expects (or no lockfile at all).
 *   `drift`    — a real mismatch: a required package missing, at the wrong
 *                version, or an install present that the lockfile never
 *                declared.
 *   `unknown`  — pnpm / yarn, or a lockfile we can't parse. Never degraded
 *                to `ok`, so callers never blind-reinstall on unreadable
 *                metadata.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type DepsDriftStatus = 'ok' | 'drift' | 'unknown';

export interface DepsDriftPackage {
  /** Full install path, e.g. `node_modules/foo/node_modules/bar`. */
  path: string;
  /** Package name without the `node_modules/` prefix. */
  name: string;
  lockVersion: string | null;
  installedVersion: string | null;
  reason: 'missing' | 'version-mismatch' | 'unexpected-extra';
}

export interface DepsDriftResult {
  status: DepsDriftStatus;
  reason: string;
  packages: DepsDriftPackage[];
  platform: NodeJS.Platform;
  arch: string;
}

export interface DepsDriftOptions {
  /** Explicit input, not read from an envvar — tests inject fixed values. */
  platform?: NodeJS.Platform;
  arch?: string;
}

interface LockPackageEntry {
  version?: string;
  os?: string[];
  cpu?: string[];
  optional?: boolean;
  link?: boolean;
}
type NpmLockfilePackages = Record<string, LockPackageEntry | undefined>;
type NpmLockfileDependencies = Record<string, { version?: string } | undefined>;
interface NpmLockfile {
  packages?: NpmLockfilePackages;
  dependencies?: NpmLockfileDependencies;
}

type ReadResult<T> = { ok: true; value: T } | { ok: false; exists: boolean };

function readJson<T = unknown>(path: string): ReadResult<T> {
  if (!existsSync(path)) return { ok: false, exists: false };
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) as T };
  } catch {
    return { ok: false, exists: true };
  }
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * npm's `os`/`cpu` field semantics: an empty/absent list means unrestricted.
 * A list of negated entries (`!win32`) excludes only those; a list with at
 * least one non-negated entry restricts to that allow-list (negated entries
 * in the same list still exclude).
 */
function platformValueApplies(values: string[] | undefined, current: string): boolean {
  if (!values || values.length === 0) return true;
  const negated = values.filter((v) => v.startsWith('!'));
  const positive = values.filter((v) => !v.startsWith('!'));
  if (negated.some((v) => v.slice(1) === current)) return false;
  if (positive.length > 0) return positive.includes(current);
  return true;
}

function appliesToPlatform(entry: LockPackageEntry, platform: string, arch: string): boolean {
  return platformValueApplies(entry.os, platform) && platformValueApplies(entry.cpu, arch);
}

function packageNameFromPath(key: string): string {
  const idx = key.lastIndexOf('node_modules/');
  return idx === -1 ? key : key.slice(idx + 'node_modules/'.length);
}

/**
 * Semantic diff between the project lockfile and the hidden install-state
 * lockfile, entry by full install path. Platform-omitted and optional-absent
 * entries are skipped entirely; workspace links are checked for existence
 * only (version compare does not apply to a link).
 */
function diffSemanticLockfiles(
  dir: string,
  lock: NpmLockfile,
  hidden: NpmLockfile,
  platform: string,
  arch: string,
): DepsDriftPackage[] {
  const lockPackages = lock.packages ?? {};
  const hiddenPackages = hidden.packages ?? {};
  const drifted: DepsDriftPackage[] = [];

  for (const [key, entry] of Object.entries(lockPackages)) {
    if (!key || !entry || !key.startsWith('node_modules/')) continue; // '' is the root package
    if (!appliesToPlatform(entry, platform, arch)) continue; // correctly omitted on this platform

    const name = packageNameFromPath(key);

    if (entry.link) {
      // A workspace link's target existing on disk is enough; its version
      // (there isn't one in the usual sense) is never drift.
      if (!existsSync(join(dir, key))) {
        drifted.push({ path: key, name, lockVersion: null, installedVersion: null, reason: 'missing' });
      }
      continue;
    }

    const hiddenEntry = hiddenPackages[key];
    if (!hiddenEntry) {
      if (entry.optional) continue; // correctly omitted
      drifted.push({ path: key, name, lockVersion: entry.version ?? null, installedVersion: null, reason: 'missing' });
      continue;
    }

    const lockVersion = entry.version ?? null;
    const installedVersion = hiddenEntry.version ?? null;
    if (lockVersion !== installedVersion) {
      drifted.push({ path: key, name, lockVersion, installedVersion, reason: 'version-mismatch' });
    }
  }

  // Hidden has strictly more than the lockfile declares: an install the
  // lockfile never named at all (not merely platform/optional-omitted).
  const declaredKeys = new Set(
    Object.keys(lockPackages).filter((key) => key && key.startsWith('node_modules/')),
  );
  for (const [key, hiddenEntry] of Object.entries(hiddenPackages)) {
    if (!key || !key.startsWith('node_modules/') || declaredKeys.has(key)) continue;
    drifted.push({
      path: key,
      name: packageNameFromPath(key),
      lockVersion: null,
      installedVersion: hiddenEntry?.version ?? null,
      reason: 'unexpected-extra',
    });
  }

  drifted.sort((a, b) => a.path.localeCompare(b.path));
  return drifted;
}

/**
 * Fallback when `node_modules/.package-lock.json` is missing (pre-npm-7
 * installs): compare each direct dependency declared in `package.json`
 * against the installed `node_modules/<name>/package.json` version.
 * Platform/optional omissions are honoured from the lockfile's own metadata
 * for that top-level entry when present.
 */
function diffDirectDeps(
  dir: string,
  lock: NpmLockfile,
  platform: string,
  arch: string,
): DepsDriftPackage[] {
  const pkgRead = readJson<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  }>(join(dir, 'package.json'));
  if (!pkgRead.ok) return [];
  const pkg = pkgRead.value;
  const lockPackages = lock.packages ?? {};
  const direct = new Set<string>([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);

  const drifted: DepsDriftPackage[] = [];
  for (const name of direct) {
    const key = `node_modules/${name}`;
    const lockEntry = lockPackages[key];
    if (lockEntry && !appliesToPlatform(lockEntry, platform, arch)) continue; // correctly omitted

    const isOptional = Boolean(lockEntry?.optional) || Boolean(pkg.optionalDependencies?.[name]);
    const expected = lockEntry?.version ?? lock.dependencies?.[name]?.version ?? null;

    const installedRead = readJson<{ version?: string }>(join(dir, 'node_modules', name, 'package.json'));
    const installedVersion = installedRead.ok && typeof installedRead.value.version === 'string'
      ? installedRead.value.version
      : null;

    if (installedVersion === null) {
      if (isOptional) continue; // correctly omitted
      drifted.push({ path: key, name, lockVersion: expected, installedVersion: null, reason: 'missing' });
      continue;
    }
    if (expected !== null && installedVersion !== expected) {
      drifted.push({ path: key, name, lockVersion: expected, installedVersion, reason: 'version-mismatch' });
    }
  }
  drifted.sort((a, b) => a.name.localeCompare(b.name));
  return drifted;
}

export function checkDepsDrift(dir: string, opts: DepsDriftOptions = {}): DepsDriftResult {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const empty = (status: DepsDriftStatus, reason: string): DepsDriftResult => (
    { status, reason, packages: [], platform, arch }
  );

  if (!directoryExists(dir)) return empty('ok', 'no-dir');
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return empty('unknown', 'pnpm-not-supported');
  if (existsSync(join(dir, 'yarn.lock'))) return empty('unknown', 'yarn-not-supported');

  const lockPath = join(dir, 'package-lock.json');
  if (!existsSync(lockPath)) return empty('ok', 'no-lockfile');

  const lockRead = readJson<NpmLockfile>(lockPath);
  if (!lockRead.ok) return empty('unknown', 'lockfile-parse-error');
  const lock = lockRead.value;

  const nmDir = join(dir, 'node_modules');
  if (!directoryExists(nmDir)) return empty('drift', 'node_modules-missing');

  const hiddenPath = join(nmDir, '.package-lock.json');
  const hiddenRead = readJson<NpmLockfile>(hiddenPath);

  if (hiddenRead.ok) {
    const packages = diffSemanticLockfiles(dir, lock, hiddenRead.value, platform, arch);
    if (packages.length === 0) return { status: 'ok', reason: 'hidden-lockfile-match', packages: [], platform, arch };
    return { status: 'drift', reason: 'hidden-lockfile-mismatch', packages, platform, arch };
  }
  if (hiddenRead.exists) {
    // Present but unparsable — never coerce a corrupt metadata file into ok.
    return empty('unknown', 'hidden-lockfile-parse-error');
  }

  // No hidden lockfile at all: fall back to the direct-dep scan.
  const packages = diffDirectDeps(dir, lock, platform, arch);
  if (packages.length === 0) {
    return { status: 'ok', reason: 'hidden-lockfile-missing-direct-deps-match', packages: [], platform, arch };
  }
  return { status: 'drift', reason: 'hidden-lockfile-missing', packages, platform, arch };
}

function hashFile(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/** Compact fingerprint of the current lockfile — used by callers as a
 *  bounded-retry key so a fresh dependency bump resets the attempt counter.
 *  Byte identity is deliberately never used for the drift verdict above. */
export function depsLockfileFingerprint(dir: string): string | null {
  return hashFile(join(dir, 'package-lock.json'));
}
