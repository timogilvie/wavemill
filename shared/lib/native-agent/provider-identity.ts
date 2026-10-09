/**
 * Provider identity primitive (HOK-3143).
 *
 * Pure helpers for recording and verifying the provider-reported model on
 * each native assistant turn, so stage results and challenge attribution
 * can trust an executed-model value instead of the requested one, and so a
 * silent provider substitution (or an alias retarget) invalidates the
 * certification identity instead of being treated as success.
 *
 * No I/O lives here: the loop extracts and verifies per turn; the launcher
 * decides what to do on `mismatch` (invalidate the certificate on disk).
 *
 * See plan.md Phase 1.
 */
import type { AssistantMessage } from './messages.ts';

/**
 * What the loop (via the launcher) expects to see on each assistant turn.
 *
 * For an alias subject (e.g. OpenRouter rolling alias prefixed `~`), the
 * `expectedModel` is the certified pinned target (`artifact.resolvedTarget.model`).
 * For a non-alias subject it is the provider-native id itself (the
 * `subject.providerNativeId`).
 */
export interface ProviderIdentityExpectation {
  /** The wire id Pi actually sends in `model` (e.g. `~google/gemini-pro-latest`). */
  requestedWireId: string;
  /** The model the certification pins — alias target, or the non-alias wire id. */
  expectedModel: string;
  /** True iff the requested wire id is a rolling provider alias. */
  isAlias: boolean;
  /** Registry key for diagnostics (not required for the comparison itself). */
  registryKey?: string;
  /** Absolute path of the certification artifact; used by the launcher to
   *  rewrite it on mismatch. The primitive never touches disk. */
  certificationPath?: string;
  /** Provider segment of the artifact (`subject.providerId`). */
  certificationProvider?: string;
  /** Model segment of the artifact (`subject.providerModelId`). */
  certificationModel?: string;
  /** Certification suite version. */
  suiteVersion?: string;
}

/** Shape of the per-turn extracted identity. */
export interface ProviderReportedIdentity {
  /**
   * The model id the provider claims served the response.
   * `null` only when `kind === 'absent'`.
   */
  reportedModel: string | null;
  /** The provider's response id for linking back to the request. */
  responseId: string | null;
  /**
   * - `reported`: Pi set `responseModel` because it differed from the requested id.
   * - `echo`: Pi returned a `responseId` but no `responseModel`, meaning the
   *   provider echoed the requested id. For an alias (which the provider
   *   never echoes verbatim) this means the identity cannot be verified.
   * - `absent`: no provider evidence at all — happens with scripted or
   *   test transports, or on an error turn.
   */
  kind: 'reported' | 'echo' | 'absent';
}

/** The verdict for one assistant turn, used for both tracking and failure. */
export type ProviderIdentityVerdict =
  | 'match'
  | 'alias-resolved'
  | 'mismatch'
  | 'unverifiable';

export interface ProviderIdentityDecision {
  verdict: ProviderIdentityVerdict;
  /**
   * The id to record as `executedModel` for the stage result.
   * - `match`: the requested wire id (provider echoed it).
   * - `alias-resolved`: the reported model (the alias's resolved target).
   * - `mismatch`: the reported model (the substituted model id).
   * - `unverifiable`: `null`.
   */
  executedModel: string | null;
  /** Human-readable short detail; redaction-safe. */
  detail: string;
}

/** Reasons `verifyProviderIdentity` fails closed. */
export type ProviderIdentityFailureReason = 'identity_mismatch' | 'identity_unverifiable';

/**
 * Thrown by the loop when a turn's provider-reported identity does not match
 * the certified identity (either a hard mismatch, or an alias with no reported
 * target). Follows the `ProviderToolMenuDriftError` pattern (loop.ts) so the
 * launcher catch block can key off the class.
 */
export class ProviderIdentityMismatchError extends Error {
  readonly reason: ProviderIdentityFailureReason;
  readonly expectedModel: string;
  readonly reportedModel: string | null;
  readonly requestedWireId: string;
  readonly turnIndex: number;
  readonly isAlias: boolean;
  readonly responseId: string | null;

  constructor(input: {
    reason: ProviderIdentityFailureReason;
    expectedModel: string;
    reportedModel: string | null;
    requestedWireId: string;
    turnIndex: number;
    isAlias: boolean;
    responseId: string | null;
  }) {
    const reported = input.reportedModel ?? '(none)';
    super(
      `provider-identity ${input.reason}: turn=${input.turnIndex} expected=${input.expectedModel} reported=${reported} requested=${input.requestedWireId}`,
    );
    this.name = 'ProviderIdentityMismatchError';
    this.reason = input.reason;
    this.expectedModel = input.expectedModel;
    this.reportedModel = input.reportedModel;
    this.requestedWireId = input.requestedWireId;
    this.turnIndex = input.turnIndex;
    this.isAlias = input.isAlias;
    this.responseId = input.responseId;
  }
}

// isRollingProviderAlias lives in certification/identity.ts (the canonical
// source — see HOK-3143 Plan D1). Re-exported here for callers that already
// pull everything else from this module.
export { isRollingProviderAlias } from './certification/identity.ts';

/**
 * Extract the provider-reported identity from a Pi `AssistantMessage`.
 *
 * See pi-ai `openai-completions.js:201-204`: Pi sets `responseId ||= chunk.id`
 * on every chunk and `responseModel ||= chunk.model` only when `chunk.model`
 * differs from the requested id. OpenRouter always sends `chunk.model`, so a
 * `responseId` without a `responseModel` means the provider echoed the id
 * we requested verbatim.
 */
export function extractProviderReportedIdentity(
  message: Pick<AssistantMessage, 'responseModel' | 'responseId'>,
  requestedWireId: string,
): ProviderReportedIdentity {
  const responseModel = typeof message.responseModel === 'string' && message.responseModel.length > 0
    ? message.responseModel
    : null;
  const responseId = typeof message.responseId === 'string' && message.responseId.length > 0
    ? message.responseId
    : null;
  if (responseModel) {
    return { reportedModel: responseModel, responseId, kind: 'reported' };
  }
  if (responseId) {
    return { reportedModel: requestedWireId, responseId, kind: 'echo' };
  }
  return { reportedModel: null, responseId: null, kind: 'absent' };
}

const DATED_SNAPSHOT_SUFFIX = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;

/**
 * Return true when the reported model equals the expected model.
 *
 * Comparison is case-insensitive on the full id. Accepts a dated snapshot
 * of the expected slug (`<expected>-YYYYMMDD` or `<expected>-YYYY-MM-DD`),
 * because OpenRouter sometimes reports the canonical dated snapshot even
 * when the base slug was requested. Any other suffix (e.g. `-customtools`)
 * is NOT a snapshot and must mismatch.
 */
export function providerModelMatches(expected: string, reported: string): boolean {
  const e = expected.trim().toLowerCase();
  const r = reported.trim().toLowerCase();
  if (e === r) return true;
  if (!r.startsWith(`${e}-`)) return false;
  const suffix = r.slice(e.length + 1);
  return DATED_SNAPSHOT_SUFFIX.test(`-${suffix}`);
}

/**
 * Verify a turn's reported identity against the launcher's expectation.
 *
 * - Alias with `reported` kind: a `match` on the pinned target is `alias-resolved`.
 * - Alias with `echo` kind: `unverifiable` — the provider never echoes `~` ids,
 *   so an echo for an alias is diagnostic of a problem, not evidence.
 * - Alias with `absent` kind: `unverifiable` (handled upstream).
 * - Non-alias with `reported` kind: `match` or `mismatch` on the pinned id.
 * - Non-alias with `echo` kind: `match` (the provider echoed what we sent).
 * - Non-alias with `absent` kind: `unverifiable`.
 */
export function verifyProviderIdentity(
  expectation: ProviderIdentityExpectation,
  reported: ProviderReportedIdentity,
): ProviderIdentityDecision {
  const { expectedModel, requestedWireId, isAlias } = expectation;

  if (reported.kind === 'absent') {
    return {
      verdict: 'unverifiable',
      executedModel: null,
      detail: 'provider returned no responseModel or responseId',
    };
  }

  if (isAlias && reported.kind === 'echo') {
    return {
      verdict: 'unverifiable',
      executedModel: null,
      detail: `alias ${requestedWireId} echoed by provider; cannot verify resolved target`,
    };
  }

  // reportedModel is guaranteed non-null here (kind is 'reported' or 'echo').
  const reportedModel = reported.reportedModel as string;

  if (!providerModelMatches(expectedModel, reportedModel)) {
    return {
      verdict: 'mismatch',
      executedModel: reportedModel,
      detail: `expected ${expectedModel}, reported ${reportedModel}`,
    };
  }

  if (isAlias) {
    return {
      verdict: 'alias-resolved',
      executedModel: reportedModel,
      detail: `alias ${requestedWireId} resolved to ${reportedModel}`,
    };
  }

  return {
    verdict: 'match',
    executedModel: reportedModel,
    detail: `provider confirmed ${reportedModel}`,
  };
}

/** Per-turn record kept by the tracker, used to build stage evidence. */
export interface ProviderIdentityTurnRecord {
  turnIndex: number;
  verdict: ProviderIdentityVerdict;
  reportedModel: string | null;
  responseId: string | null;
  kind: ProviderReportedIdentity['kind'];
}

/**
 * Stage evidence summary built from a run's turn records.
 *
 * `providerReportedModel` is the canonical executed id — the reported model
 * when every verified turn agreed on it, or `null` when no turn produced
 * direct evidence (test transports). `distinctReportedModels` surfaces
 * mid-session drift to the stage result for later auditing.
 */
export interface ProviderIdentitySummary {
  firstVerdict: ProviderIdentityVerdict | null;
  lastVerdict: ProviderIdentityVerdict | null;
  turnsVerified: number;
  turnsReported: number;
  distinctReportedModels: string[];
  providerReportedModel: string | null;
  executedModel: string | null;
  firstResponseId: string | null;
  lastResponseId: string | null;
  mismatchDetail?: string;
  identityVerdict:
    | 'match'
    | 'alias-resolved'
    | 'mismatch'
    | 'unverifiable'
    | 'absent';
}

/**
 * Accumulates per-turn provider identity records across a loop run.
 *
 * Behaviour notes:
 * - A single `record()` call must correspond to one verified assistant turn.
 * - The tracker never mutates the expectation; it only remembers verdicts.
 * - The resulting `summary()` is safe to call at any point (returns an
 *   empty-ish summary before the first record).
 */
export class ProviderIdentityTracker {
  private readonly turns: ProviderIdentityTurnRecord[] = [];
  private latestExecutedModel: string | null = null;
  private latestMismatchDetail: string | undefined;

  record(input: {
    turnIndex: number;
    decision: ProviderIdentityDecision;
    reported: ProviderReportedIdentity;
  }): void {
    this.turns.push({
      turnIndex: input.turnIndex,
      verdict: input.decision.verdict,
      reportedModel: input.reported.reportedModel,
      responseId: input.reported.responseId,
      kind: input.reported.kind,
    });
    if (input.decision.executedModel) {
      this.latestExecutedModel = input.decision.executedModel;
    }
    if (input.decision.verdict === 'mismatch') {
      this.latestMismatchDetail = input.decision.detail;
    }
  }

  summary(): ProviderIdentitySummary {
    if (this.turns.length === 0) {
      return {
        firstVerdict: null,
        lastVerdict: null,
        turnsVerified: 0,
        turnsReported: 0,
        distinctReportedModels: [],
        providerReportedModel: null,
        executedModel: null,
        firstResponseId: null,
        lastResponseId: null,
        identityVerdict: 'absent',
      };
    }

    const first = this.turns[0]!;
    const last = this.turns[this.turns.length - 1]!;
    const distinctSet = new Set<string>();
    let turnsReported = 0;
    let firstResponseId: string | null = null;
    let lastResponseId: string | null = null;
    for (const turn of this.turns) {
      if (turn.reportedModel) distinctSet.add(turn.reportedModel);
      if (turn.kind === 'reported') turnsReported += 1;
      if (turn.responseId) {
        if (!firstResponseId) firstResponseId = turn.responseId;
        lastResponseId = turn.responseId;
      }
    }
    const distinct = [...distinctSet];
    const anyMismatch = this.turns.some((t) => t.verdict === 'mismatch');
    const anyAliasResolved = this.turns.some((t) => t.verdict === 'alias-resolved');
    const anyUnverifiable = this.turns.some((t) => t.verdict === 'unverifiable');
    const providerReportedModel = distinct.length === 1 ? distinct[0]! : null;

    let identityVerdict: ProviderIdentitySummary['identityVerdict'];
    if (anyMismatch) identityVerdict = 'mismatch';
    else if (anyAliasResolved) identityVerdict = 'alias-resolved';
    else if (anyUnverifiable) identityVerdict = 'unverifiable';
    else identityVerdict = 'match';

    return {
      firstVerdict: first.verdict,
      lastVerdict: last.verdict,
      turnsVerified: this.turns.length,
      turnsReported,
      distinctReportedModels: distinct,
      providerReportedModel,
      executedModel: this.latestExecutedModel,
      firstResponseId,
      lastResponseId,
      identityVerdict,
      ...(this.latestMismatchDetail ? { mismatchDetail: this.latestMismatchDetail } : {}),
    };
  }
}
