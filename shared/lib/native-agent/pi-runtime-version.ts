/**
 * Pi runtime version provenance (HOK-3164).
 *
 * Native token and cost profiles shift across Pi upgrades (HOK-3161 moved
 * 0.79.8 → 1.0.2: OpenRouter reasoning-effort derivation, prompt-cache
 * breakpoints and cache pricing all changed). Stamping the resolved
 * `@earendil-works/pi-agent-core` / `pi-ai` versions onto `session_started`
 * and stage-result `executionEvidence` lets challenge comparisons, cost
 * analysis and the tool-decision corpus separate pre- and post-upgrade runs
 * without falling back to dates.
 *
 * The versions are read from the package that the running process actually
 * loads, not from the milled repo: `repoDir` is the repo being worked on (see
 * `install-paths.ts`), and a wavemill worktree typically has no
 * `node_modules` of its own, inheriting the parent checkout's through Node's
 * ancestor-directory lookup. We mirror that lookup by walking up from this
 * module's directory. `require.resolve('<pkg>/package.json')` is not an
 * option because both packages restrict `exports`.
 *
 * Distinct from `tools/check-pi-version.ts`, which checks for drift between
 * package.json, the lockfile and the install in CI/preflight. This module
 * only reports what is installed, and never throws.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pi packages whose versions affect native request shaping and cost. */
export const PI_RUNTIME_PACKAGES = {
  'pi-agent-core': '@earendil-works/pi-agent-core',
  'pi-ai': '@earendil-works/pi-ai',
} as const;

export type PiRuntimePackageKey = keyof typeof PI_RUNTIME_PACKAGES;

/**
 * Installed Pi package versions keyed by short package name. A key is
 * omitted when that package's `package.json` could not be found or read;
 * an entirely empty object means no Pi install was resolvable.
 */
export type PiRuntimeVersions = Partial<Record<PiRuntimePackageKey, string>>;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const cache = new Map<string, Readonly<PiRuntimeVersions>>();

/**
 * Find `node_modules/<packageName>/package.json` in `startDir` or its
 * nearest ancestor, following Node's package lookup order.
 */
function findInstalledPackageJson(startDir: string, packageName: string): string | undefined {
  const { root } = parse(startDir);
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', packageName, 'package.json');
    if (existsSync(candidate)) return candidate;
    if (dir === root) return undefined;
    dir = dirname(dir);
  }
}

function readPackageVersion(path: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const version = (parsed as { version?: unknown }).version;
    return typeof version === 'string' && version.trim() !== '' ? version.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the installed Pi runtime versions, memoized per start directory.
 *
 * Fail-soft: a missing or malformed `package.json` drops that key rather
 * than throwing, so provenance never blocks a native launch.
 *
 * @param startDir - Directory to begin the `node_modules` lookup from.
 *   Defaults to this module's directory, which resolves the same install
 *   the running process imports. Tests pass a temp dir.
 * @returns A frozen object; callers may share it without copying.
 */
export function resolvePiRuntimeVersions(startDir: string = MODULE_DIR): Readonly<PiRuntimeVersions> {
  const cached = cache.get(startDir);
  if (cached) return cached;

  const versions: PiRuntimeVersions = {};
  for (const [key, packageName] of Object.entries(PI_RUNTIME_PACKAGES) as Array<[PiRuntimePackageKey, string]>) {
    const path = findInstalledPackageJson(startDir, packageName);
    const version = path ? readPackageVersion(path) : undefined;
    if (version) versions[key] = version;
  }

  const frozen = Object.freeze(versions);
  cache.set(startDir, frozen);
  return frozen;
}

/**
 * Sanitize a persisted `piRuntimeVersions` value (stage result, event stream)
 * read back from disk. Keeps only known keys with non-empty string values so
 * downstream schemas with `additionalProperties: false` never see junk.
 *
 * @returns The sanitized versions; `{}` when nothing usable was present.
 */
export function parsePiRuntimeVersions(value: unknown): PiRuntimeVersions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const versions: PiRuntimeVersions = {};
  for (const key of Object.keys(PI_RUNTIME_PACKAGES) as PiRuntimePackageKey[]) {
    const version = raw[key];
    if (typeof version === 'string' && version.trim() !== '') versions[key] = version.trim();
  }
  return versions;
}

/**
 * Spread helper for evidence/event builders: `{ piRuntimeVersions }` when at
 * least one version resolved, otherwise `{}` so no empty object is persisted.
 */
export function piRuntimeVersionsField(
  versions: Readonly<PiRuntimeVersions> = resolvePiRuntimeVersions(),
): { piRuntimeVersions?: PiRuntimeVersions } {
  return Object.keys(versions).length > 0 ? { piRuntimeVersions: { ...versions } } : {};
}

/** Test-only: forget memoized lookups. */
export function clearPiRuntimeVersionCache(): void {
  cache.clear();
}
