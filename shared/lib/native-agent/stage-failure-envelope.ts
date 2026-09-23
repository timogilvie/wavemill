import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { TerminalFailureKind } from '../arm-failure-taxonomy.ts';

/**
 * Typed native stage-failure envelope (HOK-3064).
 *
 * Every terminal native stage attempt that already knows its cause records one
 * execution-truthful envelope before cleanup can erase process/session context.
 * The envelope survives into the monitor's terminal-failure classification and
 * challenge selection-health accounting so a timed-out or provider-faulted
 * model/provider is not left immediately reselectable, and it never relies on
 * log substring matching to recover the cause.
 *
 * Modeled on `coding-failure-handoff.ts`: same atomic tmp+rename write, same
 * validate-on-read discriminated result, same fail-closed posture. The envelope
 * is *defined* for all three native stages; this task wires the review producer.
 * Coding keeps its existing `.coding-failure-handoff.json` writer, and the
 * monitor's reader precedence covers both.
 */

export const STAGE_FAILURE_ENVELOPE_SCHEMA_VERSION = '1.0';

export const STAGE_FAILURE_ENVELOPE_STAGES = ['planning', 'coding', 'review'] as const;
export type StageFailureStage = (typeof STAGE_FAILURE_ENVELOPE_STAGES)[number];

/**
 * Typed terminal cause of a native stage attempt. Maps one-to-one (via
 * {@link terminalFailureKindForEnvelope}) onto the {@link TerminalFailureKind}
 * taxonomy so retry, challenge-resolution, and selection-health logic can act
 * on the cause without substring inference.
 */
export const STAGE_FAILURE_CAUSES = [
  // Wall-clock / turn / tool-call / token budget exhaustion.
  'stage-timeout',
  'provider-rate-limited',
  // Transient upstream failure (5xx, stalls, dropped streams).
  'provider-outage',
  'provider-credit-exhausted',
  'provider-config-error',
  // Malformed/empty final response or protocol violation.
  'model-protocol',
  'context-exhausted',
  'context-window-exceeded',
  // Mutation/network policy rejection.
  'policy-denied',
  // Explicit abort.
  'cancelled',
  'unknown',
] as const;
export type StageFailureCause = (typeof STAGE_FAILURE_CAUSES)[number];

export interface StageFailureEvidence {
  source: string;
  detail: string;
  transcriptPath?: string;
}

export interface StageFailureEnvelope {
  schemaVersion: typeof STAGE_FAILURE_ENVELOPE_SCHEMA_VERSION;
  stage: StageFailureStage;
  cause: StageFailureCause;
  /** Raw LoopStopReason when a budget/abort caused the failure. */
  stopReason?: string;
  /** Raw ProviderErrorKind when a classified provider error caused the failure. */
  providerErrorKind?: string;
  /** Bounded-retry attempt number for this stage (e.g. nativeTimeoutAttempt). */
  retryAttempt?: number;
  /** Configured timeout budget in ms (e.g. effectiveNativeTimeoutMs). */
  configuredTimeoutMs?: number;
  /** Canonical provider name, e.g. 'openrouter'. */
  provider: string;
  /** Canonical bare model id (wavemill alias). */
  model: string;
  /** Pinned challenge model selector, when a specific model was requested. */
  requestedModel?: string;
  /** Canonical agent, e.g. 'native-openrouter'. */
  agent: string;
  evidence: StageFailureEvidence;
  createdAt: string;
}

export type StageFailureEnvelopeValidationResult =
  | { ok: true; value: StageFailureEnvelope }
  | {
      ok: false;
      code: 'MALFORMED_JSON' | 'MISSING_REQUIRED_FIELD' | 'INVALID_FIELD_TYPE' | 'INVALID_ENUM_VALUE';
      field?: string;
      message: string;
    };

/**
 * Upper bound on `evidence.detail` written to disk. Unknown causes stay visible
 * (a bounded diagnostic is a success criterion), but an unbounded transcript
 * excerpt must never bloat the envelope.
 */
export const STAGE_FAILURE_EVIDENCE_DETAIL_MAX_BYTES = 8 * 1024;

const REQUIRED_FIELDS = [
  'schemaVersion',
  'stage',
  'cause',
  'provider',
  'model',
  'agent',
  'evidence',
  'createdAt',
] as const;

export function getStageFailureEnvelopePath(featureDir: string, stage: StageFailureStage): string {
  return path.join(featureDir, `.${stage}-failure-envelope.json`);
}

/**
 * Atomically write the envelope for `stage` into `featureDir`. The
 * `evidence.detail` is truncated to {@link STAGE_FAILURE_EVIDENCE_DETAIL_MAX_BYTES}
 * so diagnostics stay bounded.
 */
export function writeStageFailureEnvelope(featureDir: string, envelope: StageFailureEnvelope): void {
  const filePath = getStageFailureEnvelopePath(featureDir, envelope.stage);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const bounded: StageFailureEnvelope = {
    ...envelope,
    evidence: {
      ...envelope.evidence,
      detail: truncateDetail(envelope.evidence.detail),
    },
  };
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(bounded, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, filePath);
}

/**
 * Remove a stale envelope so a later success (or a non-terminal outcome) is not
 * misread as a failure. Missing file is a no-op.
 */
export function deleteStageFailureEnvelope(featureDir: string, stage: StageFailureStage): void {
  try {
    unlinkSync(getStageFailureEnvelopePath(featureDir, stage));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

export function validateStageFailureEnvelope(value: unknown): StageFailureEnvelopeValidationResult {
  if (!isRecord(value)) {
    return err('INVALID_FIELD_TYPE', 'Stage failure envelope must be a JSON object.', 'artifact');
  }

  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field) || value[field] === undefined) {
      return err('MISSING_REQUIRED_FIELD', `Stage failure envelope is missing required field "${field}".`, field);
    }
  }

  if (value.schemaVersion !== STAGE_FAILURE_ENVELOPE_SCHEMA_VERSION) {
    return err(
      'INVALID_ENUM_VALUE',
      `Stage failure envelope schemaVersion must be "${STAGE_FAILURE_ENVELOPE_SCHEMA_VERSION}".`,
      'schemaVersion',
    );
  }
  if (typeof value.stage !== 'string' || !isStageFailureStage(value.stage)) {
    return err(
      'INVALID_ENUM_VALUE',
      `Stage failure envelope stage must be one of: ${STAGE_FAILURE_ENVELOPE_STAGES.map((stage) => `"${stage}"`).join(', ')}.`,
      'stage',
    );
  }
  if (typeof value.cause !== 'string' || !isStageFailureCause(value.cause)) {
    return err(
      'INVALID_ENUM_VALUE',
      `Stage failure envelope cause must be one of: ${STAGE_FAILURE_CAUSES.map((cause) => `"${cause}"`).join(', ')}.`,
      'cause',
    );
  }
  for (const field of ['provider', 'model', 'agent', 'createdAt'] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      return err('INVALID_FIELD_TYPE', `Stage failure envelope ${field} must be a non-empty string.`, field);
    }
  }
  for (const field of ['stopReason', 'providerErrorKind', 'requestedModel'] as const) {
    if (Object.prototype.hasOwnProperty.call(value, field) && value[field] !== undefined && typeof value[field] !== 'string') {
      return err('INVALID_FIELD_TYPE', `Stage failure envelope ${field} must be a string when present.`, field);
    }
  }
  for (const field of ['retryAttempt', 'configuredTimeoutMs'] as const) {
    if (
      Object.prototype.hasOwnProperty.call(value, field)
      && value[field] !== undefined
      && (typeof value[field] !== 'number' || !Number.isInteger(value[field]) || (value[field] as number) < 0)
    ) {
      return err('INVALID_FIELD_TYPE', `Stage failure envelope ${field} must be a non-negative integer when present.`, field);
    }
  }
  const evidence = validateEvidence(value.evidence);
  if (!evidence.ok) {
    return evidence;
  }

  return { ok: true, value: value as unknown as StageFailureEnvelope };
}

export async function readStageFailureEnvelope(filePath: string): Promise<StageFailureEnvelopeValidationResult> {
  const content = await readFile(filePath, 'utf-8');
  try {
    return validateStageFailureEnvelope(JSON.parse(content));
  } catch {
    return err('MALFORMED_JSON', `Stage failure envelope at ${filePath} contains malformed JSON.`);
  }
}

/**
 * The single cause → {@link TerminalFailureKind} conversion (HOK-3064).
 *
 * `model-protocol` reuses `native-completion-protocol` (already classified
 * `model-fault`): the provider delivered output but the model violated the
 * stage's output protocol — a malformed/empty *review* response is the same
 * class of signal as a malformed coding completion artifact.
 */
export function terminalFailureKindForEnvelope(envelope: StageFailureEnvelope): TerminalFailureKind {
  return terminalFailureKindForCause(envelope.cause);
}

export function terminalFailureKindForCause(cause: StageFailureCause): TerminalFailureKind {
  switch (cause) {
    case 'stage-timeout':
      return 'native-stage-timeout';
    case 'provider-rate-limited':
      return 'provider-rate-limited';
    case 'provider-outage':
      return 'provider-transient-error';
    case 'provider-credit-exhausted':
      return 'provider-credit-exhausted';
    case 'provider-config-error':
      return 'provider-config-error';
    case 'model-protocol':
      return 'native-completion-protocol';
    case 'context-exhausted':
      return 'context-exhausted';
    case 'context-window-exceeded':
      return 'context-window-exceeded';
    case 'policy-denied':
      return 'policy-denied';
    case 'cancelled':
      return 'cancelled';
    case 'unknown':
      return 'native-unclassified';
  }
}

function truncateDetail(detail: string): string {
  if (Buffer.byteLength(detail, 'utf8') <= STAGE_FAILURE_EVIDENCE_DETAIL_MAX_BYTES) {
    return detail;
  }
  // Truncate on a byte boundary without splitting a multi-byte character.
  const buffer = Buffer.from(detail, 'utf8').subarray(0, STAGE_FAILURE_EVIDENCE_DETAIL_MAX_BYTES);
  return `${buffer.toString('utf8')}…[truncated]`;
}

function validateEvidence(value: unknown): StageFailureEnvelopeValidationResult {
  if (!isRecord(value)) {
    return err('INVALID_FIELD_TYPE', 'Stage failure envelope evidence must be an object.', 'evidence');
  }
  for (const field of ['source', 'detail'] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      return err('INVALID_FIELD_TYPE', `Stage failure envelope evidence.${field} must be a non-empty string.`, `evidence.${field}`);
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(value, 'transcriptPath')
    && value.transcriptPath !== undefined
    && typeof value.transcriptPath !== 'string'
  ) {
    return err('INVALID_FIELD_TYPE', 'Stage failure envelope evidence.transcriptPath must be a string when present.', 'evidence.transcriptPath');
  }
  return { ok: true, value: undefined as unknown as StageFailureEnvelope };
}

function isStageFailureStage(value: string): value is StageFailureStage {
  return STAGE_FAILURE_ENVELOPE_STAGES.includes(value as StageFailureStage);
}

function isStageFailureCause(value: string): value is StageFailureCause {
  return STAGE_FAILURE_CAUSES.includes(value as StageFailureCause);
}

function err(
  code: Exclude<StageFailureEnvelopeValidationResult, { ok: true }>['code'],
  message: string,
  field?: string,
): Exclude<StageFailureEnvelopeValidationResult, { ok: true }> {
  return field === undefined ? { ok: false, code, message } : { ok: false, code, message, field };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
