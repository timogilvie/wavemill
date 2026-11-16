import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isValidCertificationPathSegment, resolveCertificationStorageIdentity, endpointIdentity } from './identity.ts';
import type { CertificationEndpoint } from './schema.ts';
import { CERTIFICATION_BASE_PATH } from './schema.ts';

export type CertificationStorageScope = 'global' | 'legacy-repo';

export interface CertificationStorageLocation {
  scope: CertificationStorageScope;
  root: string;
}

export interface CertificationStorageOptions {
  repoDir?: string;
  root?: string;
  scope?: CertificationStorageScope;
  endpoint?: CertificationEndpoint;
}

export const GLOBAL_CERTIFICATION_ROOT_ENV = 'WAVEMILL_NATIVE_CERTIFICATION_ROOT';

/**
 * Resolve the process-wide default global certification root.
 *
 * This reads process environment (`WAVEMILL_NATIVE_CERTIFICATION_ROOT`);
 * prefer accepting an explicit `certificationRoot` at API boundaries when
 * correctness depends on the selected store.
 */
export function resolveGlobalCertificationRoot(): string {
  const override = process.env[GLOBAL_CERTIFICATION_ROOT_ENV]?.trim();
  if (override) {
    return resolve(override);
  }
  return join(homedir(), '.wavemill', 'native-agent-certifications');
}

export function resolveLegacyCertificationRoot(repoDir: string): string {
  return join(repoDir, CERTIFICATION_BASE_PATH);
}

export function resolveCertificationStorage(
  options: CertificationStorageOptions = {},
): CertificationStorageLocation {
  if (options.root) {
    return {
      scope: options.scope ?? 'global',
      root: resolve(options.root),
    };
  }

  if (options.scope === 'legacy-repo') {
    if (!options.repoDir) {
      throw new Error('resolveCertificationStorage: repoDir is required for legacy-repo storage');
    }
    return {
      scope: 'legacy-repo',
      root: resolveLegacyCertificationRoot(options.repoDir),
    };
  }

  return {
    scope: 'global',
    root: resolveGlobalCertificationRoot(),
  };
}

export function buildCertificationPathFromRoot(
  root: string,
  provider: string,
  model: string,
  suiteVersion: string,
  endpoint?: CertificationEndpoint,
): string {
  const identity = resolveCertificationStorageIdentity(provider, model);

  for (const [name, value] of [
    ['provider', identity.provider],
    ['model', identity.model],
    ['suiteVersion', suiteVersion],
  ] as const) {
    if (!isValidCertificationPathSegment(value)) {
      throw new Error(`Invalid certification path segment for ${name}: ${JSON.stringify(value)}`);
    }
  }

  return join(root, identity.provider, identity.model, `${suiteVersion}${endpoint ? `--endpoint-${endpointIdentity(endpoint)}` : ''}.json`);
}

export function buildScopedCertificationPath(
  options: CertificationStorageOptions,
  provider: string,
  model: string,
  suiteVersion: string,
): string {
  return buildCertificationPathFromRoot(
    resolveCertificationStorage(options).root,
    provider,
    model,
    suiteVersion,
    options.endpoint,
  );
}

export function buildLegacyRepoCertificationPath(repoDir: string, provider: string, model: string, suiteVersion: string, endpoint?: CertificationEndpoint): string {
  return buildScopedCertificationPath({ repoDir, scope: 'legacy-repo', endpoint }, provider, model, suiteVersion);
}
