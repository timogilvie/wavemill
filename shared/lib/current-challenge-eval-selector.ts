/**
 * Select the evidence for one challenge arm at its *current* pull-request
 * head.  JSONL is append-only, so record position is never evidence of
 * currentness.  Both comparison and recovery use this module to avoid
 * independently reintroducing append-order selection.
 */

import type { EvalRecord } from './eval-schema.ts';

export type ChallengeEvalSide = 'primary' | 'challenger';

export type CurrentChallengeEvalRefusalReason =
  | 'no_pair_records'
  | 'no_matching_pr'
  | 'side_mismatch'
  | 'missing_current_head'
  | 'legacy_head_ambiguous'
  | 'old_head_only'
  | 'invalid_score'
  | 'invalid_timestamp'
  | 'ineligible_evidence'
  | 'ambiguous_current_head';

export interface CurrentChallengeEvalIdentity {
  pairId: string;
  side: ChallengeEvalSide;
  /** Canonical PR URL resolved from the live GitHub PR metadata. */
  prUrl: string;
  /** Optional PR number retained for operator diagnostics. */
  prNumber?: string;
  /** The current GitHub PR head SHA. Evidence must match it exactly. */
  currentHeadSha?: string;
  /** Comparisons that need an overall score set this false for unscored paths. */
  requireScore?: boolean;
  /** Optional future-proof harness constraint; omitted means any harness. */
  harnessId?: string;
}

export interface ChallengeEvalCandidateDiagnostic {
  evalId?: string;
  prUrl?: string;
  prNumber?: string;
  side?: string;
  evaluatedPrHeadSha?: string;
  timestamp?: string;
  rejection?: string;
  divergenceReason?: string;
}

export interface CurrentChallengeEvalDiagnostics {
  pairId: string;
  side: ChallengeEvalSide;
  prUrl: string;
  prNumber?: string;
  currentHeadSha?: string;
  candidates: ChallengeEvalCandidateDiagnostic[];
}

export interface CurrentChallengeEvalSelection {
  ok: true;
  record: EvalRecord;
  evalId: string;
  evaluatedPrHeadSha: string;
  canonicalPrUrl: string;
  canonicalPrNumber?: string;
  diagnostics: CurrentChallengeEvalDiagnostics;
}

export interface CurrentChallengeEvalRefusal {
  ok: false;
  reason: CurrentChallengeEvalRefusalReason;
  diagnostics: CurrentChallengeEvalDiagnostics;
}

export type CurrentChallengeEvalResult = CurrentChallengeEvalSelection | CurrentChallengeEvalRefusal;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Extract a PR number without resolving or inventing repository identity. */
export function challengePrNumber(value: unknown): string | undefined {
  const stringValue = nonEmptyString(value);
  if (!stringValue) return undefined;
  const match = stringValue.match(/\/pull\/(\d+)\/?(?:[?#].*)?$/);
  return match?.[1] ?? (/^\d+$/.test(stringValue) ? stringValue : undefined);
}

/** Remove syntactic URL noise only; repository/host identity remains intact. */
export function canonicalChallengePrUrl(value: unknown): string | undefined {
  const stringValue = nonEmptyString(value);
  if (!stringValue) return undefined;
  try {
    const url = new URL(stringValue);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    return stringValue.replace(/\/+$/, '');
  }
}

/**
 * New records carry the evaluated PR head directly.  Historical rows can use
 * the immutable verification artifact, but must never be upgraded by reading
 * the PR's present-day head.
 */
export function getAuthoritativeEvaluatedPrHeadSha(record: Pick<EvalRecord,
  'evaluatedPrHeadSha' | 'verificationTelemetry'>): string | undefined {
  return nonEmptyString(record.evaluatedPrHeadSha)
    ?? nonEmptyString(record.verificationTelemetry?.checked_shas?.head);
}

function samePr(record: EvalRecord, identity: CurrentChallengeEvalIdentity): boolean {
  const recordUrl = canonicalChallengePrUrl(record.prUrl);
  const identityUrl = canonicalChallengePrUrl(identity.prUrl);
  if (recordUrl && identityUrl) {
    if (recordUrl === identityUrl) return true;
    // URL spellings can differ while still naming the same PR (for example a
    // trailing API normalization). A number alone is not safe across repos,
    // so require the URL prefix through `/pull/` to agree as well.
    const recordPrefix = recordUrl.match(/^(.*\/pull\/)\d+$/)?.[1];
    const identityPrefix = identityUrl.match(/^(.*\/pull\/)\d+$/)?.[1];
    return Boolean(
      recordPrefix && identityPrefix
      && recordPrefix === identityPrefix
      && challengePrNumber(record.prUrl) === (identity.prNumber ?? challengePrNumber(identity.prUrl)),
    );
  }
  const recordNumber = challengePrNumber(record.prUrl);
  const identityNumber = identity.prNumber ?? challengePrNumber(identity.prUrl);
  return Boolean(recordNumber && identityNumber && recordNumber === identityNumber);
}

function candidateDiagnostic(record: EvalRecord, rejection?: string): ChallengeEvalCandidateDiagnostic {
  return {
    evalId: nonEmptyString(record.id),
    prUrl: canonicalChallengePrUrl(record.prUrl),
    prNumber: challengePrNumber(record.prUrl),
    side: nonEmptyString(record.challengeSide),
    evaluatedPrHeadSha: getAuthoritativeEvaluatedPrHeadSha(record),
    timestamp: nonEmptyString(record.timestamp),
    ...(rejection ? { rejection } : {}),
    ...(nonEmptyString(record.challengeDivergenceReason) ? { divergenceReason: nonEmptyString(record.challengeDivergenceReason) } : {}),
  };
}

function timestampMs(record: EvalRecord): number | undefined {
  const value = Date.parse(record.timestamp);
  return Number.isFinite(value) ? value : undefined;
}

function refusal(
  reason: CurrentChallengeEvalRefusalReason,
  identity: CurrentChallengeEvalIdentity,
  candidates: ChallengeEvalCandidateDiagnostic[],
): CurrentChallengeEvalRefusal {
  return {
    ok: false,
    reason,
    diagnostics: {
      pairId: identity.pairId,
      side: identity.side,
      prUrl: canonicalChallengePrUrl(identity.prUrl) ?? identity.prUrl,
      prNumber: identity.prNumber ?? challengePrNumber(identity.prUrl),
      currentHeadSha: nonEmptyString(identity.currentHeadSha),
      candidates,
    },
  };
}

/**
 * Return the newest valid exact-head record. Timestamp order is descending;
 * equal timestamps use descending eval ID as a stable tie-breaker. Duplicate
 * or absent IDs at the decisive timestamp are refused rather than guessed.
 */
export function selectCurrentChallengeEval(
  records: readonly EvalRecord[],
  identity: CurrentChallengeEvalIdentity,
): CurrentChallengeEvalResult {
  const pairRecords = records.filter((record) => record.challengePairId === identity.pairId);
  if (pairRecords.length === 0) return refusal('no_pair_records', identity, []);

  const prRecords = pairRecords.filter((record) => samePr(record, identity));
  if (prRecords.length === 0) {
    return refusal('no_matching_pr', identity, pairRecords.map((record) => candidateDiagnostic(record, 'pr_mismatch')));
  }

  const sideRecords = prRecords.filter((record) => record.challengeSide === identity.side);
  if (sideRecords.length === 0) {
    return refusal('side_mismatch', identity, prRecords.map((record) => candidateDiagnostic(record, 'side_mismatch')));
  }

  const currentHead = nonEmptyString(identity.currentHeadSha);
  if (!currentHead) {
    return refusal('missing_current_head', identity, sideRecords.map((record) => candidateDiagnostic(record, 'current_head_unavailable')));
  }

  const headRecords = sideRecords.filter((record) => getAuthoritativeEvaluatedPrHeadSha(record) === currentHead);
  if (headRecords.length === 0) {
    const hasMissingHead = sideRecords.some((record) => !getAuthoritativeEvaluatedPrHeadSha(record));
    const hasOldHead = sideRecords.some((record) => getAuthoritativeEvaluatedPrHeadSha(record));
    const reason = hasOldHead ? 'old_head_only' : hasMissingHead ? 'legacy_head_ambiguous' : 'old_head_only';
    return refusal(reason, identity, sideRecords.map((record) => candidateDiagnostic(
      record,
      getAuthoritativeEvaluatedPrHeadSha(record) ? 'head_mismatch' : 'missing_authoritative_head',
    )));
  }

  const eligible = headRecords.filter((record) => {
    if (record.invalidChallenge === true) return false;
    if (identity.harnessId && record.harnessId !== identity.harnessId) return false;
    return identity.requireScore === false || (typeof record.score === 'number' && Number.isFinite(record.score));
  });
  if (eligible.length === 0) {
    const hasInvalidScore = headRecords.some((record) =>
      identity.requireScore !== false && (typeof record.score !== 'number' || !Number.isFinite(record.score)));
    return refusal(
      hasInvalidScore ? 'invalid_score' : 'ineligible_evidence',
      identity,
      headRecords.map((record) => candidateDiagnostic(
        record,
        record.invalidChallenge === true ? 'invalid_challenge'
          : identity.harnessId && record.harnessId !== identity.harnessId ? 'harness_mismatch'
            : 'invalid_score',
      )),
    );
  }

  const dated = eligible.filter((record) => timestampMs(record) !== undefined);
  if (dated.length === 0) {
    return refusal('invalid_timestamp', identity, eligible.map((record) => candidateDiagnostic(record, 'invalid_timestamp')));
  }
  const newestTimestamp = Math.max(...dated.map((record) => timestampMs(record)!));
  const newest = dated.filter((record) => timestampMs(record) === newestTimestamp);
  const ids = newest.map((record) => nonEmptyString(record.id));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    return refusal('ambiguous_current_head', identity, newest.map((record) => candidateDiagnostic(record, 'ambiguous_timestamp_or_id')));
  }

  newest.sort((a, b) => nonEmptyString(b.id)!.localeCompare(nonEmptyString(a.id)!));
  const selected = newest[0];
  const canonicalPrUrl = canonicalChallengePrUrl(selected.prUrl) ?? canonicalChallengePrUrl(identity.prUrl) ?? identity.prUrl;
  return {
    ok: true,
    record: selected,
    evalId: nonEmptyString(selected.id)!,
    evaluatedPrHeadSha: getAuthoritativeEvaluatedPrHeadSha(selected)!,
    canonicalPrUrl,
    canonicalPrNumber: challengePrNumber(selected.prUrl) ?? identity.prNumber ?? challengePrNumber(identity.prUrl),
    diagnostics: {
      pairId: identity.pairId,
      side: identity.side,
      prUrl: canonicalChallengePrUrl(identity.prUrl) ?? identity.prUrl,
      prNumber: identity.prNumber ?? challengePrNumber(identity.prUrl),
      currentHeadSha: currentHead,
      candidates: sideRecords.map((record) => candidateDiagnostic(record,
        record === selected ? undefined
          : getAuthoritativeEvaluatedPrHeadSha(record) === currentHead ? 'superseded_by_newer_eval'
            : getAuthoritativeEvaluatedPrHeadSha(record) ? 'head_mismatch' : 'missing_authoritative_head')),
    },
  };
}
