import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mutateJsonState } from '../../state-mutex.ts';
import {
  getEffectiveRegistry,
  resolveModelIdentity,
  type ModelRegistry,
  type NativeProviderName,
} from '../../model-registry.ts';
import { hashLaunchPriorityFixture } from '../../openrouter-catalog.ts';
import { resolveCertificationStorage } from './storage.ts';
import type { SuiteCoverageResult } from './coverage.ts';
import {
  certifySelectedNativeAgents,
  type CertifyAllEntry,
  type CertifyAllResult,
  type CertifySelectedTarget,
} from '../../../../tools/native-agent-certify.ts';

export interface AutoRemediationOptions {
  registry?: ModelRegistry;
  repoDir: string;
  coverage: SuiteCoverageResult;
  root?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  renewalWindowDays?: number;
  log?: (line: string) => void;
  certifyFn?: typeof certifySelectedNativeAgents;
  attemptCachePath?: string;
  processToken?: string;
}

export interface AutoRemediationResult {
  attempted: boolean;
  mode: 'republish-matrix' | 'reidentify' | 'renewal' | 'noop' | 'blocked-by-loop-guard';
  targets: string[];
  published: string[];
  failed: Array<{ provider: string; model: string; reason: string }>;
  skipped: Array<{ provider: string; model: string; reason: string }>;
  attemptKey: string;
}

interface AttemptCache {
  attempts: Record<string, {
    at: string;
    outcome: 'success' | 'failed-once' | 'blocked';
    failedModels: string[];
    processToken?: string;
  }>;
}

const EMPTY_ATTEMPT_CACHE: AttemptCache = { attempts: {} };
const ZERO_CATALOG_HASH = '0'.repeat(64);
const PROCESS_TOKEN = `${process.pid}:${randomUUID()}`;

export async function runCertificationAutoRemediation(
  opts: AutoRemediationOptions,
): Promise<AutoRemediationResult> {
  const registry = opts.registry ?? getEffectiveRegistry(opts.repoDir);
  const mode = remediationMode(opts.coverage);
  const targets = selectTargets(registry, opts.coverage, mode);
  const targetKeys = targets.map((target) => target.model).sort();
  const attemptKey = buildAttemptKey(opts.coverage.requiredSuiteVersion, targetKeys, opts.log);
  const processToken = opts.processToken ?? PROCESS_TOKEN;

  if (mode === 'noop' || targets.length === 0) {
    opts.log?.(`[certify-auto] coverage=${opts.coverage.status} reason=no-targets targets=0`);
    return emptyResult('noop', targetKeys, attemptKey);
  }

  const cachePath = opts.attemptCachePath
    ?? join(resolveCertificationStorage({ scope: 'global', root: opts.root }).root, '.auto-remediation-attempts.json');
  let existing: AttemptCache['attempts'][string] | undefined;
  try {
    existing = await readAttempt(cachePath, attemptKey);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    opts.log?.(`[certify-auto] BLOCKED by loop guard for key ${attemptKey} - ${reason}`);
    return {
      ...emptyResult('blocked-by-loop-guard', targetKeys, attemptKey),
      failed: targets.map((target) => ({
        provider: target.provider,
        model: target.model,
        reason: `auto-remediation attempt cache unavailable: ${reason}`,
      })),
    };
  }
  if (existing?.processToken === processToken && existing.outcome === 'success') {
    opts.log?.(`[certify-auto] coverage=${opts.coverage.status} reason=already-succeeded-this-process targets=${targets.length}`);
    return emptyResult('noop', targetKeys, attemptKey);
  }
  if (
    existing?.processToken === processToken
    && (existing.outcome === 'failed-once' || existing.outcome === 'blocked')
  ) {
    opts.log?.(`[certify-auto] BLOCKED by loop guard for key ${attemptKey} - models: ${targetKeys.join(',')}`);
    await safeMarkAttempt(cachePath, attemptKey, 'blocked', targetKeys, processToken, opts.now, opts.log);
    return {
      ...emptyResult('blocked-by-loop-guard', targetKeys, attemptKey),
      failed: targets.map((target) => ({
        provider: target.provider,
        model: target.model,
        reason: 'auto-remediation already failed once for this certification identity',
      })),
    };
  }

  opts.log?.(`[certify-auto] coverage=${opts.coverage.status} reason=${mode} targets=${targets.length}`);

  let result: CertifyAllResult;
  try {
    result = await (opts.certifyFn ?? certifySelectedNativeAgents)({
      targets,
      phase: 'workflow',
      repoDir: opts.repoDir,
      dryRun: false,
      registry,
      env: stripLiveSmoke(opts.env ?? process.env),
      now: opts.now,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await safeMarkAttempt(cachePath, attemptKey, 'failed-once', targetKeys, processToken, opts.now, opts.log);
    opts.log?.(`[certify-auto] published=0 failed=${targets.length} skipped=0`);
    return {
      attempted: true,
      mode,
      targets: targetKeys,
      published: [],
      skipped: [],
      failed: targets.map((target) => ({ provider: target.provider, model: target.model, reason })),
      attemptKey,
    };
  }

  const failedModels = result.failed.map(formatEntryKey);
  await safeMarkAttempt(
    cachePath,
    attemptKey,
    result.failed.length > 0 ? 'failed-once' : 'success',
    failedModels,
    processToken,
    opts.now,
    opts.log,
  );
  opts.log?.(`[certify-auto] published=${result.published.length} failed=${result.failed.length} skipped=${result.skipped.length}`);

  return {
    attempted: true,
    mode,
    targets: targetKeys,
    published: result.published.map(formatEntryKey),
    failed: result.failed.map(({ provider, model, reason }) => ({
      provider,
      model,
      reason: reason ?? 'certification failed',
    })),
    skipped: result.skipped.map(({ provider, model, reason }) => ({
      provider,
      model,
      reason: reason ?? 'certification skipped',
    })),
    attemptKey,
  };
}

function remediationMode(coverage: SuiteCoverageResult): AutoRemediationResult['mode'] {
  if (coverage.status === 'identity-drift'
    || coverage.status === 'stale'
    || coverage.status === 'bump-without-publish'
    || coverage.status === 'empty-store') {
    return 'republish-matrix';
  }
  // HOK-3159: catalog hashes are per-model, so a launch-priority row edit now
  // re-identifies only that model — below the fleet-wide `identity-drift`
  // threshold. Re-certify just the drifted models (plus any renewals).
  if (reidentifiedModelKeys(coverage).length > 0) {
    return 'reidentify';
  }
  if (coverage.modelsInRenewalWindow.length > 0) {
    return 'renewal';
  }
  return 'noop';
}

function reidentifiedModelKeys(coverage: SuiteCoverageResult): string[] {
  return coverage.ineligibleModels
    .filter((entry) => entry.reason === 'identity-reidentified' || entry.reason === 'identity-invalidated')
    .map((entry) => entry.registryKey);
}

function selectTargets(
  registry: ModelRegistry,
  coverage: SuiteCoverageResult,
  mode: AutoRemediationResult['mode'],
): CertifySelectedTarget[] {
  const renewals = coverage.modelsInRenewalWindow.map((model) => model.registryKey);
  const requested = mode === 'renewal'
    ? new Set(renewals)
    : mode === 'reidentify'
      ? new Set([...reidentifiedModelKeys(coverage), ...renewals])
      : null;
  const targets: CertifySelectedTarget[] = [];

  for (const [registryKey, model] of Object.entries(registry.models)) {
    const capability = model.nativeCapability;
    if (!capability || capability.readOnlyNative === 'unsupported') continue;
    if (requested && !requested.has(registryKey)) continue;
    if (resolveModelIdentity(registry, registryKey).status === 'provisional') continue;
    targets.push({
      provider: capability.nativeProvider as NativeProviderName,
      model: registryKey,
    });
  }

  return targets.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

function stripLiveSmoke(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  delete next.OPENROUTER_LIVE_SMOKE;
  return next;
}

function buildAttemptKey(
  suiteVersion: string,
  targetKeys: string[],
  log?: (line: string) => void,
): string {
  let catalogHash = ZERO_CATALOG_HASH;
  try {
    catalogHash = hashLaunchPriorityFixture();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log?.(`[certify-auto] catalogHash unavailable: ${message}`);
  }
  return createHash('sha256')
    .update(`${catalogHash}\n${suiteVersion}\n${targetKeys.join(',')}`, 'utf-8')
    .digest('hex');
}

async function readAttempt(cachePath: string, attemptKey: string): Promise<AttemptCache['attempts'][string] | undefined> {
  let attempt: AttemptCache['attempts'][string] | undefined;
  await mutateJsonState<AttemptCache>(
    cachePath,
    (cache) => {
      attempt = cache.attempts[attemptKey];
      return cache;
    },
    { createIfMissing: true, initial: EMPTY_ATTEMPT_CACHE },
  );
  return attempt;
}

async function markAttempt(
  cachePath: string,
  attemptKey: string,
  outcome: AttemptCache['attempts'][string]['outcome'],
  failedModels: string[],
  processToken: string,
  now?: () => Date,
): Promise<void> {
  await mutateJsonState<AttemptCache>(
    cachePath,
    (cache) => ({
      attempts: {
        ...cache.attempts,
        [attemptKey]: {
          at: (now ?? (() => new Date()))().toISOString(),
          outcome,
          failedModels,
          processToken,
        },
      },
    }),
    { createIfMissing: true, initial: EMPTY_ATTEMPT_CACHE },
  );
}

async function safeMarkAttempt(
  cachePath: string,
  attemptKey: string,
  outcome: AttemptCache['attempts'][string]['outcome'],
  failedModels: string[],
  processToken: string,
  now: (() => Date) | undefined,
  log: ((line: string) => void) | undefined,
): Promise<void> {
  try {
    await markAttempt(cachePath, attemptKey, outcome, failedModels, processToken, now);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log?.(`[certify-auto] attempt cache update failed: ${message}`);
  }
}

function emptyResult(
  mode: AutoRemediationResult['mode'],
  targets: string[],
  attemptKey: string,
): AutoRemediationResult {
  return {
    attempted: false,
    mode,
    targets,
    published: [],
    failed: [],
    skipped: [],
    attemptKey,
  };
}

function formatEntryKey(entry: CertifyAllEntry): string {
  return `${entry.provider}/${entry.model}`;
}

/**
 * True when the coverage result has work for auto-remediation: a fleet-wide
 * trigger status, models in the renewal window, or (HOK-3159) individually
 * re-identified models below the fleet-wide drift threshold.
 */
export function hasCertificationAutoRemediationWork(coverage: SuiteCoverageResult): boolean {
  return remediationMode(coverage) !== 'noop';
}
