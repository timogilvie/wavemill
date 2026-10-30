/**
 * HOK-3315 — semantic npm-install verdict.
 *
 * One stateless primitive: compares expected lock entries against actual installed
 * packages, respecting npm platform/optional semantics. The hidden lockfile is
 * evidence only, never decides health. Physical package.json files are the
 * authority for what's actually installed.
 *
 * Verdicts:
 *   `ok`       — installation matches lockfile for this platform/options.
 *   `drift`    — required package missing, wrong version, or link broken.
 *   `unknown`  — pnpm/yarn, corrupt metadata, or unsupported package manager.
 *
 * Not checked: extraneous installed packages (scope is expected→actual).
 * Documented in result; inputs are explicit (omit), npm env vars, or process.platform.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export type DepsDriftStatus = 'ok' | 'drift' | 'unknown';

export interface DepsDriftPackage {
  name: string;
  path: string;
  kind: 'missing' | 'version' | 'link';
  lockVersion: string | null;
  installedVersion: string | null;
}

export interface DepsDriftResult {
  status: DepsDriftStatus;
  reason: string;
  packages: DepsDriftPackage[];
  optionalMissing?: string[];
  hiddenLockfile?: 'consistent' | 'stale' | 'missing' | 'unreadable';
  platform?: { os: string; cpu: string; libc: string | null; omit: string[] };
  expectedRevision?: string;
  lockfileHash?: string;
  conditionId?: string;
  installRevisionAt?: string;
}

export interface InstallPlatform {
  os: string;
  cpu: string;
  libc: string | null;
  omit: string[];
}

interface NpmLockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  optional?: boolean;
  dev?: boolean;
  devOptional?: boolean;
  peer?: boolean;
  os?: string[];
  cpu?: string[];
  libc?: string[];
}

interface NpmLockfile {
  packages?: Record<string, NpmLockEntry>;
  lockfileVersion?: number;
}

function readJsonFile<T = unknown>(path: string): T | null {
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function hashBytes(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return createHash('sha256').update(buf).digest('hex');
}

function fileHash(path: string): string | null {
  try {
    const buf = readFileSync(path);
    return hashBytes(buf);
  } catch {
    return null;
  }
}

function statMtime(path: string): string | null {
  try {
    const st = statSync(path);
    return st.mtimeMs.toFixed(0);
  } catch {
    return null;
  }
}

export function resolveInstallPlatform(options?: {
  os?: string;
  cpu?: string;
  libc?: string;
  omit?: string[];
}): InstallPlatform {
  let os = options?.os ?? process.env.npm_config_os ?? process.platform;
  let cpu = options?.cpu ?? process.env.npm_config_cpu ?? process.arch;
  let libc = options?.libc ?? process.env.npm_config_libc ?? null;
  const omit = options?.omit ?? (process.env.npm_config_omit?.split(',') ?? []);

  // Detect glibc on Linux if not overridden
  if (!libc && os === 'linux') {
    try {
      const report = (process as any).report?.getReport?.();
      if (report?.header?.glibcVersionRuntime) {
        libc = 'glibc';
      }
    } catch {
      // Ignore glibc detection errors
    }
  }

  return { os, cpu, libc, omit };
}

function isPlatformCompatible(entry: NpmLockEntry, platform: InstallPlatform): boolean {
  if (entry.os && !entry.os.includes(platform.os) && !entry.os.includes('!'+platform.os)) {
    return false;
  }
  if (entry.os?.some(o => o === '!' + platform.os)) {
    return false;
  }
  if (entry.cpu && !entry.cpu.includes(platform.cpu) && !entry.cpu.includes('!'+platform.cpu)) {
    return false;
  }
  if (entry.cpu?.some(c => c === '!' + platform.cpu)) {
    return false;
  }
  // libc constraint: only applies to linux. An entry with libc constraint
  // but running on a platform with no libc (non-linux) is incompatible.
  if (entry.libc) {
    if (platform.os !== 'linux' || !platform.libc) {
      return false; // libc constraint unsatisfiable
    }
    if (!entry.libc.includes(platform.libc)) {
      return false;
    }
  }
  return true;
}

function isOmitted(entry: NpmLockEntry, omit: string[]): boolean {
  if (omit.includes('dev') && entry.dev) return true;
  if (omit.includes('optional') && entry.optional) return true;
  if (omit.includes('dev') && omit.includes('optional') && entry.devOptional) return true;
  if (omit.includes('peer') && entry.peer) return true;
  return false;
}

function isExpected(entry: NpmLockEntry, platform: InstallPlatform): boolean {
  if (isOmitted(entry, platform.omit)) return false;
  const compatible = isPlatformCompatible(entry, platform);
  if (!compatible && (entry.optional || entry.devOptional || entry.peer)) {
    return false; // optional/peer incompatible entries are correctly omitted
  }
  return true;
}

function readInstalledVersion(nmDir: string, relPath: string): { state: 'present'; version: string } | { state: 'link'; target: string } | { state: 'missing' } | { state: 'unreadable' } {
  const fullPath = join(nmDir, relPath);
  try {
    const st = statSync(fullPath, { throwIfNoEntry: false });
    if (!st) {
      return { state: 'missing' };
    }
    if (st.isSymbolicLink()) {
      try {
        const target = realpathSync(fullPath);
        const pkgPath = join(target, 'package.json');
        const pkg = readJsonFile<{ version?: string }>(pkgPath);
        if (pkg?.version && typeof pkg.version === 'string') {
          return { state: 'link', target };
        }
        return { state: 'unreadable' };
      } catch {
        return { state: 'unreadable' }; // dangling or broken link
      }
    }
    if (st.isDirectory()) {
      const pkgPath = join(fullPath, 'package.json');
      const pkg = readJsonFile<{ version?: string }>(pkgPath);
      if (pkg?.version && typeof pkg.version === 'string') {
        return { state: 'present', version: pkg.version };
      }
      return { state: 'unreadable' };
    }
    return { state: 'missing' };
  } catch {
    return { state: 'missing' };
  }
}

function hiddenLockfileState(nmDir: string): 'missing' | 'unreadable' | 'consistent' | 'stale' {
  const hidden = join(nmDir, '.package-lock.json');
  if (!existsSync(hidden)) {
    return 'missing';
  }
  const hiddenLock = readJsonFile<NpmLockfile>(hidden);
  if (!hiddenLock?.packages || typeof hiddenLock.packages !== 'object') {
    return 'unreadable';
  }
  // Simplistic staleness check: if we can read it as valid JSON, treat as consistent
  // A full staleness check would compare hidden vs physical metadata, but that's expensive
  return 'consistent';
}

export function checkDepsDrift(
  dir: string,
  options?: { os?: string; cpu?: string; libc?: string; omit?: string[] },
): DepsDriftResult {
  if (!existsSync(dir)) {
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
  if (!existsSync(nmDir)) {
    return { status: 'drift', reason: 'node_modules-missing', packages: [] };
  }

  const lock = readJsonFile<NpmLockfile>(lockPath);
  if (!lock?.packages) {
    return { status: 'unknown', reason: 'lockfile-format-unsupported', packages: [] };
  }

  const platform = resolveInstallPlatform(options);

  // Expected entries: keys not under node_modules/ are workspace refs, skip them
  const expected: Record<string, { key: string; entry: NpmLockEntry }> = {};
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key || !key.startsWith('node_modules/')) continue;
    if (entry && isExpected(entry, platform)) {
      expected[key] = { key, entry };
    }
  }

  // Check actual install
  const drifted: DepsDriftPackage[] = [];
  const optionalMissing: string[] = [];

  for (const { key: lockKey, entry: lockEntry } of Object.values(expected)) {
    if (!lockEntry.version) continue; // skip entries without version

    const installPath = lockKey.slice('node_modules/'.length);
    const installed = readInstalledVersion(nmDir, installPath);
    const lastSegment = installPath.split('/').pop() || installPath;

    if (lockEntry.link) {
      // Link entry: must be a symlink to the resolved target
      if (installed.state === 'link') {
        // Link exists and resolves; don't strictly verify target path match
        // as it can vary (relative vs absolute), just check it resolves
        continue;
      }
      if (installed.state === 'missing') {
        drifted.push({
          name: lastSegment,
          path: installPath,
          kind: 'link',
          lockVersion: lockEntry.version,
          installedVersion: null,
        });
      } else {
        drifted.push({
          name: lastSegment,
          path: installPath,
          kind: 'link',
          lockVersion: lockEntry.version,
          installedVersion: installed.state === 'present' ? installed.version : null,
        });
      }
    } else if (lockEntry.optional && installed.state === 'missing') {
      // Optional package correctly omitted; record but don't flag as drift
      optionalMissing.push(installPath);
    } else if (installed.state === 'missing') {
      // Required package is missing
      drifted.push({
        name: lastSegment,
        path: installPath,
        kind: 'missing',
        lockVersion: lockEntry.version,
        installedVersion: null,
      });
    } else if (installed.state === 'unreadable') {
      // Can't read the installed package.json
      drifted.push({
        name: lastSegment,
        path: installPath,
        kind: 'missing',
        lockVersion: lockEntry.version,
        installedVersion: null,
      });
    } else if (installed.state === 'present' && installed.version !== lockEntry.version) {
      // Version mismatch
      drifted.push({
        name: lastSegment,
        path: installPath,
        kind: 'version',
        lockVersion: lockEntry.version,
        installedVersion: installed.version,
      });
    }
  }

  drifted.sort((a, b) => a.path.localeCompare(b.path));

  const result: DepsDriftResult = {
    status: drifted.length === 0 ? 'ok' : 'drift',
    reason: drifted.length === 0 ? 'install-matches-lockfile' : 'install-mismatch',
    packages: drifted,
    platform,
  };

  if (optionalMissing.length > 0) {
    result.optionalMissing = optionalMissing;
  }

  // Add metadata
  result.lockfileHash = fileHash(lockPath);
  result.expectedRevision = hashBytes(
    JSON.stringify(
      Object.entries(expected)
        .map(([path, entry]) => ({ path, version: entry.version, link: entry.link }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    ),
  ).slice(0, 16);

  // Condition ID for deduplication: hash of expected revision + platform + mismatches
  if (drifted.length > 0) {
    const mismatchSet = drifted
      .map(p => `${p.path}:${p.kind}:${p.lockVersion}->${p.installedVersion}`)
      .join('|');
    const conditionData = `${result.expectedRevision}|${platform.os}/${platform.cpu}/${platform.libc}/${platform.omit.join(',')}|${mismatchSet}`;
    result.conditionId = hashBytes(conditionData).slice(0, 16);
  }

  // Install revision timestamp (when the install was last updated)
  const hiddenMtime = statMtime(join(nmDir, '.package-lock.json'));
  const nmMtime = statMtime(nmDir);
  result.installRevisionAt = hiddenMtime || nmMtime || undefined;

  // Hidden lockfile metadata
  result.hiddenLockfile = hiddenLockfileState(nmDir);

  return result;
}

/** Compact fingerprint of the current lockfile — used as a bounded-retry key
 *  so a fresh dependency bump resets the attempt counter. */
export function depsLockfileFingerprint(dir: string): string | null {
  const lockPath = join(dir, 'package-lock.json');
  return fileHash(lockPath);
}
