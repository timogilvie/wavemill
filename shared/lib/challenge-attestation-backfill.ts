import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EvalRecord } from './eval-schema.ts';
import {
  attestEvalRecordChallengeExecution,
  enforceChallengeIntentPresence,
} from './challenge-execution-contract.ts';
import { attachChallengeExecutionMetadata, attachEligibility } from './eval-record-builder.ts';

export type ChallengeAttestationBackfillAction =
  | 'quarantined'
  | 're-derived'
  | 'missing-intent'
  | 'unchanged'
  | 'skipped-no-pair'
  | 'malformed';

export interface ChallengeAttestationBackfillRecordSummary {
  id?: string;
  issueId?: string;
  pairId?: string;
  action: ChallengeAttestationBackfillAction;
  reason?: string;
}

export interface ChallengeAttestationBackfillSummary {
  file: string;
  apply: boolean;
  scanned: number;
  attested: number;
  quarantined: number;
  reDerived: number;
  missingIntent: number;
  unchanged: number;
  skippedNoPair: number;
  malformed: number;
  changed: number;
  records: ChallengeAttestationBackfillRecordSummary[];
}

export interface ChallengeAttestationBackfillOptions {
  file: string;
  apply?: boolean;
  /** Repo root used for scoped model-registry lookups (HOK-3321). */
  repoDir?: string;
}

function cloneRecord(record: EvalRecord): EvalRecord {
  return JSON.parse(JSON.stringify(record)) as EvalRecord;
}

function recordsEqual(left: EvalRecord, right: EvalRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function summarizeRecord(
  record: EvalRecord,
  action: ChallengeAttestationBackfillAction,
  reason?: string,
): ChallengeAttestationBackfillRecordSummary {
  return {
    ...(record.id ? { id: record.id } : {}),
    ...(record.issueId ? { issueId: record.issueId } : {}),
    ...(record.challengePairId ? { pairId: record.challengePairId } : {}),
    action,
    ...(reason ? { reason } : {}),
  };
}

function clearStaleChallengeDivergence(record: EvalRecord): void {
  delete record.invalidChallenge;
  delete record.challengeDivergenceReason;
  if (record.nonRewardReason?.code === 'INVALID_CHALLENGE') {
    delete record.nonRewardReason;
  }
}

function processRecord(
  record: EvalRecord,
  repoDir?: string,
): {
  record: EvalRecord;
  changed: boolean;
  summary: ChallengeAttestationBackfillRecordSummary;
  attested: boolean;
} {
  const before = cloneRecord(record);

  if (record.challengeIntent && record.challengeSide) {
    const attestation = attestEvalRecordChallengeExecution(record, repoDir);
    if (attestation?.invalidReason) {
      attachChallengeExecutionMetadata(record, {
        side: record.challengeSide,
        intent: record.challengeIntent,
        evidence: attestation,
      });
      return {
        record,
        changed: !recordsEqual(before, record),
        summary: summarizeRecord(record, 'quarantined', attestation.invalidReason),
        attested: true,
      };
    }

    if (attestation) {
      if (record.invalidChallenge || record.challengeDivergenceReason) {
        clearStaleChallengeDivergence(record);
        attachChallengeExecutionMetadata(record, {
          side: record.challengeSide,
          intent: record.challengeIntent,
          evidence: attestation,
        });
        attachEligibility(record);
        return {
          record,
          changed: !recordsEqual(before, record),
          summary: summarizeRecord(record, 're-derived'),
          attested: true,
        };
      }

      return {
        record,
        changed: false,
        summary: summarizeRecord(record, 'unchanged'),
        attested: true,
      };
    }
  }

  if (record.challengePairId) {
    const changed = enforceChallengeIntentPresence(record, record.challengePairId);
    return {
      record,
      changed,
      summary: summarizeRecord(record, changed ? 'missing-intent' : 'unchanged', changed ? 'missing_challenge_intent' : undefined),
      attested: false,
    };
  }

  return {
    record,
    changed: false,
    summary: summarizeRecord(record, 'skipped-no-pair'),
    attested: false,
  };
}

function writeAtomic(file: string, content: string): void {
  const tmp = join(dirname(file), `.challenge-attestation-${randomUUID()}.tmp`);
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, file);
}

export function backfillChallengeAttestation(
  options: ChallengeAttestationBackfillOptions,
): ChallengeAttestationBackfillSummary {
  const file = resolve(options.file);
  if (!existsSync(file)) {
    throw new Error(`Eval file not found: ${file}`);
  }

  const content = readFileSync(file, 'utf-8');
  const hasTrailingNewline = content.endsWith('\n');
  const lines = content.split('\n');
  if (hasTrailingNewline) {
    lines.pop();
  }

  const output: string[] = [];
  const summary: ChallengeAttestationBackfillSummary = {
    file,
    apply: options.apply === true,
    scanned: 0,
    attested: 0,
    quarantined: 0,
    reDerived: 0,
    missingIntent: 0,
    unchanged: 0,
    skippedNoPair: 0,
    malformed: 0,
    changed: 0,
    records: [],
  };

  for (const line of lines) {
    if (!line.trim()) {
      output.push(line);
      continue;
    }

    let record: EvalRecord;
    try {
      record = JSON.parse(line) as EvalRecord;
    } catch {
      summary.malformed += 1;
      summary.records.push({ action: 'malformed', reason: 'malformed_json' });
      output.push(line);
      continue;
    }

    summary.scanned += 1;
    const result = processRecord(record, options.repoDir);
    if (result.attested) summary.attested += 1;
    if (result.changed) summary.changed += 1;
    if (result.summary.action === 'quarantined') summary.quarantined += 1;
    if (result.summary.action === 're-derived') summary.reDerived += 1;
    if (result.summary.action === 'missing-intent') summary.missingIntent += 1;
    if (result.summary.action === 'unchanged') summary.unchanged += 1;
    if (result.summary.action === 'skipped-no-pair') summary.skippedNoPair += 1;
    summary.records.push(result.summary);
    output.push(result.changed ? JSON.stringify(result.record) : line);
  }

  if (summary.changed > 0 && options.apply === true) {
    writeAtomic(file, `${output.join('\n')}${hasTrailingNewline ? '\n' : ''}`);
  }

  return summary;
}
