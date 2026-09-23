import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StateLockTimeoutError, StateParseError, mutateJsonState } from './state-mutex.ts';
import { resolveProviderNativeModelId } from './model-registry.ts';
import type { ArmFaultClass, TerminalFailureKind } from './arm-failure-taxonomy.ts';
import type { ChallengeStage } from './challenge-scheduler.ts';
import type { ChallengeConfig } from './config.ts';

export const CHALLENGE_SELECTION_HEALTH_FILENAME = 'challenge-selection-health.json';

const SCHEMA_VERSION = 1;
const DEFAULT_SELECTION_TTL_SECONDS = 900;
const DEFAULT_INFLIGHT_TTL_SECONDS = 7200;
const DEFAULT_TRANSIENT_FAILURE_THRESHOLD = 3;
const DEFAULT_WINDOW_SECONDS = 1800;
const DEFAULT_COOLDOWN_SECONDS = 900;

export interface SelectionHealthOwner {
  issueId: string;
  pairId: string;
}

export interface SelectionReservationRecord {
  owner: SelectionHealthOwner;
  status: 'selected' | 'launched';
  claimedAt: string;
  expiresAt: string;
}

export interface SelectionCircuitRecord {
  state: 'closed' | 'open' | 'half-open';
  recentTransientAt: string[];
  lastFailureKind?: string;
  openedAt?: string;
  cooldownUntil?: string;
  probeOwner?: SelectionHealthOwner & {
    grantedAt: string;
    expiresAt: string;
  };
  updatedAt: string;
}

export interface SelectionHealthState {
  schemaVersion: 1;
  reservations: Record<string, SelectionReservationRecord>;
  circuits: Record<string, SelectionCircuitRecord>;
}

export interface SelectionHealthConfig {
  enabled: boolean;
  reservation: {
    selectionTtlSeconds: number;
    inflightTtlSeconds: number;
  };
  circuit: {
    transientFailureThreshold: number;
    windowSeconds: number;
    cooldownSeconds: number;
  };
}

export interface SelectionHealthKey {
  provider: string;
  canonicalModel: string;
}

export interface ReservationExclusion {
  model: string;
  provider: string;
  canonicalModel: string;
  stage: ChallengeStage;
  ownerIssueId: string;
  ownerPairId: string;
  expiresAt: string;
  status: SelectionReservationRecord['status'];
  reason: 'reserved';
}

export interface CircuitExclusion {
  model: string;
  provider: string;
  canonicalModel: string;
  state: SelectionCircuitRecord['state'];
  cooldownUntil?: string;
  recentTransientCount: number;
  reason: 'circuit-open';
}

export interface SelectionHealthEvidence {
  enabled: boolean;
  excludedByReservation: ReservationExclusion[];
  excludedByCircuit: CircuitExclusion[];
  probeGranted: { model: string; provider: string; canonicalModel: string } | null;
  thresholds: {
    selectionTtlSeconds: number;
    inflightTtlSeconds: number;
    transientFailureThreshold: number;
    windowSeconds: number;
    cooldownSeconds: number;
  };
}

export interface SelectionHealthDiagnostic {
  code: 'selection-health-corrupt' | 'selection-health-lock-timeout';
  path: string;
  repair: string;
}

export class SelectionHealthCorruptError extends Error {
  path: string;

  constructor(path: string, cause: unknown) {
    super(`Challenge selection health state is corrupt: ${path}`);
    this.name = 'SelectionHealthCorruptError';
    this.path = path;
    this.cause = cause;
  }
}

export class SelectionHealthLockTimeoutError extends Error {
  path: string;

  constructor(path: string, cause: unknown) {
    super(`Timed out acquiring challenge selection health lock: ${path}`);
    this.name = 'SelectionHealthLockTimeoutError';
    this.path = path;
    this.cause = cause;
  }
}

export interface SelectionHealthOptions {
  repoDir?: string;
  statePath?: string;
  now?: () => number;
  config?: ChallengeConfig['selectionHealth'] | SelectionHealthConfig;
}

export function normalizeSelectionHealthConfig(
  config?: ChallengeConfig['selectionHealth'] | SelectionHealthConfig,
): SelectionHealthConfig {
  const input = config as Partial<SelectionHealthConfig> | undefined;
  return {
    enabled: input?.enabled !== false,
    reservation: {
      selectionTtlSeconds: normalizePositiveInteger(
        input?.reservation?.selectionTtlSeconds,
        DEFAULT_SELECTION_TTL_SECONDS,
        60,
      ),
      inflightTtlSeconds: normalizeNonNegativeInteger(
        input?.reservation?.inflightTtlSeconds,
        DEFAULT_INFLIGHT_TTL_SECONDS,
      ),
    },
    circuit: {
      transientFailureThreshold: normalizePositiveInteger(
        input?.circuit?.transientFailureThreshold,
        DEFAULT_TRANSIENT_FAILURE_THRESHOLD,
        1,
      ),
      windowSeconds: normalizePositiveInteger(input?.circuit?.windowSeconds, DEFAULT_WINDOW_SECONDS, 60),
      cooldownSeconds: normalizePositiveInteger(input?.circuit?.cooldownSeconds, DEFAULT_COOLDOWN_SECONDS, 60),
    },
  };
}

export function resolveSelectionHealthPath(opts: SelectionHealthOptions = {}): string {
  if (opts.statePath) {
    return resolve(opts.statePath);
  }
  return join(resolve(opts.repoDir ?? process.cwd()), '.wavemill', CHALLENGE_SELECTION_HEALTH_FILENAME);
}

/**
 * Split a model selector into an optional provider hint and the bare model id,
 * tolerating the `provider/model`, `native-provider/model`, and bare `model`
 * forms observed across challenge routing, stage results, and abort markers
 * (HOK-3064). Mirrors `parseRequestedNativeModel` in native-agent/review.ts so
 * both sides normalize identity the same way.
 */
function parseModelSelector(model: string): { providerHint?: string; bareModel: string } {
  const trimmed = model.trim();
  const separatorIndex = trimmed.indexOf('/');
  if (separatorIndex <= 0) {
    return { bareModel: trimmed };
  }
  const rawProvider = trimmed.slice(0, separatorIndex);
  const bareModel = trimmed.slice(separatorIndex + 1) || trimmed;
  const providerHint = rawProvider.startsWith('native-') ? rawProvider.slice('native-'.length) : rawProvider;
  return { providerHint: providerHint || undefined, bareModel };
}

/**
 * Resolve a model selector to its canonical `{provider, canonicalModel}` health
 * key. The registry is tried on the full selector first, then on the parsed
 * bare id, so `kimi-k2`, `openrouter/kimi-k2`, and `native-openrouter/kimi-k2`
 * all key to `openrouter|<alias>` — one OpenRouter execution never splits
 * across `native` and `native-openrouter` health rows (HOK-3064). When the
 * registry cannot resolve but the selector carried a provider hint, that hint
 * (stripped of any `native-` prefix) is used instead of `'unknown'`.
 */
export function resolveSelectionHealthKey(model: string): SelectionHealthKey {
  const trimmed = model.trim();
  const { providerHint, bareModel } = parseModelSelector(trimmed);
  const resolved = resolveProviderNativeModelId(trimmed) ?? resolveProviderNativeModelId(bareModel);
  return {
    provider: resolved?.provider ?? providerHint ?? 'unknown',
    canonicalModel: resolved?.wavemillAlias ?? bareModel,
  };
}

export function reservationKeyFor(model: string, stage: ChallengeStage): string {
  const key = resolveSelectionHealthKey(model);
  return `${key.provider}|${key.canonicalModel}|${stage}`;
}

export function circuitKeyFor(model: string): string {
  const key = resolveSelectionHealthKey(model);
  return `${key.provider}|${key.canonicalModel}`;
}

export function emptySelectionHealthState(): SelectionHealthState {
  return {
    schemaVersion: SCHEMA_VERSION,
    reservations: {},
    circuits: {},
  };
}

export function readSelectionHealth(opts: SelectionHealthOptions = {}): SelectionHealthState {
  const statePath = resolveSelectionHealthPath(opts);
  if (!existsSync(statePath)) {
    return emptySelectionHealthState();
  }
  try {
    return pruneSelectionHealthState(
      normalizeState(JSON.parse(readFileSync(statePath, 'utf-8'))),
      currentMs(opts),
      normalizeSelectionHealthConfig(opts.config),
    );
  } catch (error) {
    throw new SelectionHealthCorruptError(statePath, error);
  }
}

export function computeSelectionExclusions(input: {
  stage: ChallengeStage;
  candidates: string[];
  snapshot: SelectionHealthState;
  owner: SelectionHealthOwner;
  now?: number;
  config?: ChallengeConfig['selectionHealth'] | SelectionHealthConfig;
  additionallyExcludedModels?: Set<string>;
}): {
  eligible: string[];
  excludedByReservation: ReservationExclusion[];
  excludedByCircuit: CircuitExclusion[];
} {
  const now = input.now ?? Date.now();
  const config = normalizeSelectionHealthConfig(input.config);
  const snapshot = pruneSelectionHealthState(input.snapshot, now, config);
  const excludedByReservation: ReservationExclusion[] = [];
  const excludedByCircuit: CircuitExclusion[] = [];
  const seen = new Set<string>();
  const eligible: string[] = [];

  for (const rawModel of input.candidates) {
    const model = rawModel.trim();
    if (!model || seen.has(model)) {
      continue;
    }
    seen.add(model);
    if (input.additionallyExcludedModels?.has(model)) {
      continue;
    }

    const modelKey = resolveSelectionHealthKey(model);
    const reservation = snapshot.reservations[`${modelKey.provider}|${modelKey.canonicalModel}|${input.stage}`];
    if (reservation && !sameOwner(reservation.owner, input.owner) && isFuture(reservation.expiresAt, now)) {
      excludedByReservation.push({
        model,
        provider: modelKey.provider,
        canonicalModel: modelKey.canonicalModel,
        stage: input.stage,
        ownerIssueId: reservation.owner.issueId,
        ownerPairId: reservation.owner.pairId,
        expiresAt: reservation.expiresAt,
        status: reservation.status,
        reason: 'reserved',
      });
      continue;
    }

    const circuit = snapshot.circuits[`${modelKey.provider}|${modelKey.canonicalModel}`];
    if (isCircuitSelectionBlocked(circuit, now)) {
      excludedByCircuit.push({
        model,
        provider: modelKey.provider,
        canonicalModel: modelKey.canonicalModel,
        state: circuit.state,
        ...(circuit.cooldownUntil ? { cooldownUntil: circuit.cooldownUntil } : {}),
        recentTransientCount: circuit.recentTransientAt.length,
        reason: 'circuit-open',
      });
      continue;
    }

    eligible.push(model);
  }

  return { eligible, excludedByReservation, excludedByCircuit };
}

export async function claimReservation(input: SelectionHealthOptions & {
  model: string;
  stage: ChallengeStage;
  owner: SelectionHealthOwner;
}): Promise<
  | { claimed: true; probeGranted?: { model: string; provider: string; canonicalModel: string } }
  | { claimed: false; conflict: 'reserved' | 'circuit-open' }
> {
  const statePath = resolveSelectionHealthPath(input);
  const now = currentMs(input);
  const config = normalizeSelectionHealthConfig(input.config);
  const modelKey = resolveSelectionHealthKey(input.model);
  const reservationKey = `${modelKey.provider}|${modelKey.canonicalModel}|${input.stage}`;
  const circuitKey = `${modelKey.provider}|${modelKey.canonicalModel}`;
  let claimed = false;
  let conflict: 'reserved' | 'circuit-open' | undefined;
  let probeGranted = false;

  await mutateHealthState(statePath, (current) => {
    const state = pruneSelectionHealthState(current, now, config);
    const existing = state.reservations[reservationKey];
    if (existing && !sameOwner(existing.owner, input.owner) && isFuture(existing.expiresAt, now)) {
      conflict = 'reserved';
      return state;
    }

    const circuit = state.circuits[circuitKey];
    if (circuit && !canSelectThroughCircuit(circuit, input.owner, now)) {
      conflict = 'circuit-open';
      return state;
    }

    const expiresAt = isoAt(now + config.reservation.selectionTtlSeconds * 1000);
    state.reservations[reservationKey] = {
      owner: input.owner,
      status: existing?.status === 'launched' && sameOwner(existing.owner, input.owner) ? 'launched' : 'selected',
      claimedAt: existing?.claimedAt && sameOwner(existing.owner, input.owner) ? existing.claimedAt : isoAt(now),
      expiresAt,
    };

    if (circuit && circuit.state === 'open' && !circuit.probeOwner && !isFuture(circuit.cooldownUntil, now)) {
      circuit.state = 'half-open';
      circuit.probeOwner = {
        ...input.owner,
        grantedAt: isoAt(now),
        expiresAt: isoAt(now + probeTtlMs(config)),
      };
      circuit.updatedAt = isoAt(now);
      probeGranted = true;
    }

    claimed = true;
    return state;
  });

  if (!claimed) {
    return { claimed: false, conflict: conflict ?? 'reserved' };
  }
  return {
    claimed: true,
    ...(probeGranted ? { probeGranted: { model: input.model, ...modelKey } } : {}),
  };
}

export async function ackLaunch(input: SelectionHealthOptions & {
  model: string;
  stage: ChallengeStage;
  owner: SelectionHealthOwner;
}): Promise<void> {
  const statePath = resolveSelectionHealthPath(input);
  const now = currentMs(input);
  const config = normalizeSelectionHealthConfig(input.config);
  const key = reservationKeyFor(input.model, input.stage);
  await mutateHealthState(statePath, (current) => {
    const state = pruneSelectionHealthState(current, now, config);
    const existing = state.reservations[key];
    if (!existing || !sameOwner(existing.owner, input.owner)) {
      return state;
    }
    if (config.reservation.inflightTtlSeconds <= 0) {
      delete state.reservations[key];
      return state;
    }
    state.reservations[key] = {
      ...existing,
      status: 'launched',
      expiresAt: isoAt(now + config.reservation.inflightTtlSeconds * 1000),
    };
    return state;
  });
}

export async function releaseReservation(input: SelectionHealthOptions & {
  owner: SelectionHealthOwner;
  model?: string;
  stage?: ChallengeStage;
}): Promise<void> {
  const statePath = resolveSelectionHealthPath(input);
  const now = currentMs(input);
  const config = normalizeSelectionHealthConfig(input.config);
  await mutateHealthState(statePath, (current) => {
    const state = pruneSelectionHealthState(current, now, config);
    for (const [key, reservation] of Object.entries(state.reservations)) {
      if (!sameOwner(reservation.owner, input.owner)) {
        continue;
      }
      if (input.model && input.stage && key !== reservationKeyFor(input.model, input.stage)) {
        continue;
      }
      delete state.reservations[key];
    }
    return state;
  });
}

export async function recordSelectionOutcome(input: SelectionHealthOptions & {
  owner: SelectionHealthOwner;
  model: string;
  stage: ChallengeStage;
  success?: boolean;
  failureKind?: TerminalFailureKind | string | null;
  faultClass?: ArmFaultClass | null;
}): Promise<void> {
  const statePath = resolveSelectionHealthPath(input);
  const now = currentMs(input);
  const config = normalizeSelectionHealthConfig(input.config);
  const modelKey = resolveSelectionHealthKey(input.model);
  const reservationKey = `${modelKey.provider}|${modelKey.canonicalModel}|${input.stage}`;
  const circuitKey = `${modelKey.provider}|${modelKey.canonicalModel}`;

  await mutateHealthState(statePath, (current) => {
    const state = pruneSelectionHealthState(current, now, config);
    const reservation = state.reservations[reservationKey];
    if (reservation && sameOwner(reservation.owner, input.owner)) {
      delete state.reservations[reservationKey];
    }

    const circuit = state.circuits[circuitKey];
    const probeOwned = Boolean(circuit?.probeOwner && sameProbeOwner(circuit.probeOwner, input.owner));
    if (input.success) {
      if (circuit && probeOwned) {
        delete state.circuits[circuitKey];
      }
      return state;
    }

    if (input.faultClass === 'provider-fault') {
      const existing = state.circuits[circuitKey] ?? {
        state: 'closed' as const,
        recentTransientAt: [],
        updatedAt: isoAt(now),
      };
      const recent = pruneTimestamps([...existing.recentTransientAt, isoAt(now)], now, config);
      existing.recentTransientAt = recent;
      existing.lastFailureKind = input.failureKind ?? 'provider-transient-error';
      existing.updatedAt = isoAt(now);

      if (probeOwned || recent.length >= config.circuit.transientFailureThreshold) {
        existing.state = 'open';
        existing.openedAt = isoAt(now);
        existing.cooldownUntil = isoAt(now + config.circuit.cooldownSeconds * 1000);
        delete existing.probeOwner;
      }
      state.circuits[circuitKey] = existing;
      return state;
    }

    if (circuit && probeOwned) {
      delete circuit.probeOwner;
      circuit.state = 'open';
      circuit.updatedAt = isoAt(now);
    }
    return state;
  });
}

export function buildSelectionHealthEvidence(input: {
  config?: ChallengeConfig['selectionHealth'] | SelectionHealthConfig;
  excludedByReservation?: ReservationExclusion[];
  excludedByCircuit?: CircuitExclusion[];
  probeGranted?: { model: string; provider: string; canonicalModel: string } | null;
}): SelectionHealthEvidence {
  const config = normalizeSelectionHealthConfig(input.config);
  return {
    enabled: config.enabled,
    excludedByReservation: input.excludedByReservation ?? [],
    excludedByCircuit: input.excludedByCircuit ?? [],
    probeGranted: input.probeGranted ?? null,
    thresholds: {
      selectionTtlSeconds: config.reservation.selectionTtlSeconds,
      inflightTtlSeconds: config.reservation.inflightTtlSeconds,
      transientFailureThreshold: config.circuit.transientFailureThreshold,
      windowSeconds: config.circuit.windowSeconds,
      cooldownSeconds: config.circuit.cooldownSeconds,
    },
  };
}

export function buildSelectionHealthDiagnostic(
  error: unknown,
  opts: SelectionHealthOptions,
): SelectionHealthDiagnostic | undefined {
  const path = resolveSelectionHealthPath(opts);
  if (error instanceof SelectionHealthCorruptError || error instanceof StateParseError) {
    return {
      code: 'selection-health-corrupt',
      path,
      repair: 'npx tsx tools/challenge-selection-health.ts clear --all',
    };
  }
  if (error instanceof SelectionHealthLockTimeoutError || error instanceof StateLockTimeoutError) {
    return {
      code: 'selection-health-lock-timeout',
      path,
      repair: 'retry after the active selector finishes or remove a demonstrably stale .lock file',
    };
  }
  return undefined;
}

export async function clearSelectionHealth(input: SelectionHealthOptions & {
  all?: boolean;
  provider?: string;
  model?: string;
  stage?: ChallengeStage;
}): Promise<SelectionHealthState> {
  const statePath = resolveSelectionHealthPath(input);
  const now = currentMs(input);
  const config = normalizeSelectionHealthConfig(input.config);
  const modelKey = input.model ? resolveSelectionHealthKey(input.model) : undefined;
  const provider = input.provider ?? modelKey?.provider;
  const canonicalModel = modelKey?.canonicalModel ?? input.model?.trim();
  return mutateHealthState(statePath, (current) => {
    const state = pruneSelectionHealthState(current, now, config);
    if (input.all) {
      return emptySelectionHealthState();
    }
    if (!provider || !canonicalModel) {
      return state;
    }
    const circuitKey = `${provider}|${canonicalModel}`;
    delete state.circuits[circuitKey];
    const reservationPrefix = `${provider}|${canonicalModel}|`;
    for (const key of Object.keys(state.reservations)) {
      if (!key.startsWith(reservationPrefix)) {
        continue;
      }
      if (input.stage && key !== `${reservationPrefix}${input.stage}`) {
        continue;
      }
      delete state.reservations[key];
    }
    return state;
  });
}

export function formatSelectionHealthStatus(state: SelectionHealthState): Record<string, unknown> {
  return {
    schemaVersion: state.schemaVersion,
    reservations: Object.entries(state.reservations).map(([key, value]) => {
      const [provider, model, stage] = key.split('|');
      return { key, provider, model, stage, ...value };
    }),
    circuits: Object.entries(state.circuits).map(([key, value]) => {
      const [provider, model] = key.split('|');
      return { key, provider, model, ...value, recentTransientCount: value.recentTransientAt.length };
    }),
  };
}

export function pruneSelectionHealthState(
  state: SelectionHealthState,
  now: number,
  config: SelectionHealthConfig,
): SelectionHealthState {
  const next = normalizeState(state);
  for (const [key, reservation] of Object.entries(next.reservations)) {
    if (!isFuture(reservation.expiresAt, now)) {
      delete next.reservations[key];
    }
  }
  for (const [key, circuit] of Object.entries(next.circuits)) {
    circuit.recentTransientAt = pruneTimestamps(circuit.recentTransientAt, now, config);
    if (circuit.probeOwner && !isFuture(circuit.probeOwner.expiresAt, now)) {
      delete circuit.probeOwner;
      circuit.state = 'open';
      circuit.updatedAt = isoAt(now);
    }
    if (circuit.state === 'closed' && circuit.recentTransientAt.length === 0 && !circuit.probeOwner) {
      delete next.circuits[key];
    }
  }
  return next;
}

async function mutateHealthState(
  statePath: string,
  transform: (current: SelectionHealthState) => SelectionHealthState,
): Promise<SelectionHealthState> {
  try {
    return await mutateJsonState<SelectionHealthState>(
      statePath,
      (current) => transform(normalizeState(current)),
      {
        createIfMissing: true,
        initial: emptySelectionHealthState(),
      },
    );
  } catch (error) {
    if (error instanceof StateParseError) {
      throw new SelectionHealthCorruptError(statePath, error);
    }
    if (error instanceof StateLockTimeoutError) {
      throw new SelectionHealthLockTimeoutError(statePath, error);
    }
    throw error;
  }
}

function normalizeState(value: unknown): SelectionHealthState {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<SelectionHealthState>
    : {};
  return {
    schemaVersion: SCHEMA_VERSION,
    reservations: sanitizeRecord(input.reservations),
    circuits: sanitizeRecord(input.circuits),
  };
}

function sanitizeRecord<T>(value: unknown): Record<string, T> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, T>
    : {};
}

function currentMs(opts: SelectionHealthOptions): number {
  return opts.now?.() ?? Date.now();
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function parseMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isFuture(value: string | undefined, now: number): boolean {
  return parseMs(value) > now;
}

function pruneTimestamps(values: string[], now: number, config: SelectionHealthConfig): string[] {
  const cutoff = now - config.circuit.windowSeconds * 1000;
  return values
    .filter((value) => {
      const parsed = parseMs(value);
      return Number.isFinite(parsed) && parsed > cutoff && parsed <= now + 1000;
    })
    .sort();
}

function isCircuitSelectionBlocked(circuit: SelectionCircuitRecord | undefined, now: number): circuit is SelectionCircuitRecord {
  if (!circuit) {
    return false;
  }
  if (circuit.probeOwner && isFuture(circuit.probeOwner.expiresAt, now)) {
    return true;
  }
  if (circuit.state !== 'open' && circuit.state !== 'half-open') {
    return false;
  }
  return isFuture(circuit.cooldownUntil, now);
}

function canSelectThroughCircuit(
  circuit: SelectionCircuitRecord,
  owner: SelectionHealthOwner,
  now: number,
): boolean {
  if (circuit.probeOwner && isFuture(circuit.probeOwner.expiresAt, now)) {
    return sameProbeOwner(circuit.probeOwner, owner);
  }
  if (circuit.state === 'closed') {
    return true;
  }
  return !isFuture(circuit.cooldownUntil, now);
}

function sameOwner(left: SelectionHealthOwner, right: SelectionHealthOwner): boolean {
  return left.issueId === right.issueId && left.pairId === right.pairId;
}

function sameProbeOwner(
  left: SelectionCircuitRecord['probeOwner'],
  right: SelectionHealthOwner,
): boolean {
  return Boolean(left && left.issueId === right.issueId && left.pairId === right.pairId);
}

function probeTtlMs(config: SelectionHealthConfig): number {
  return (config.reservation.selectionTtlSeconds + config.reservation.inflightTtlSeconds) * 1000;
}

function normalizePositiveInteger(value: unknown, fallback: number, minimum: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum ? value : fallback;
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}
