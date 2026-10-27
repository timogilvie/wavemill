#!/usr/bin/env -S npx tsx
/**
 * HOK-3313 recovery: re-attest eval records that were falsely invalidated by
 * the pre-HOK-3321 raw-string model comparison (`stage_override_lost` on two
 * spellings of the same registry entry).
 *
 * Safety properties (plan §3.8):
 * - Explicit eval IDs only; there is no recover-everything mode.
 * - Dry-run is the default; `--write` is the only way to persist.
 * - Writes are append-only: a corrected eval record and a superseding
 *   comparison record are appended, the originals are never rewritten.
 * - A record the migrated attestation still rejects is NOT recovered.
 * - Idempotent: a row whose correctionProvenance.supersedes.evalId matches a
 *   requested id is reported `already-recovered` and skipped.
 * - Never touches GitHub, labels, or the merge executor.
 *
 * Usage: npx tsx tools/recover-hok-3313.ts <eval-id> [<eval-id>...] [--repo-dir .] [--write]
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runTool } from '../shared/lib/tool-runner.ts';
import { resolveEvalsDir } from '../shared/lib/evals-paths.ts';
import type { EvalRecord } from '../shared/lib/eval-schema.ts';
import {
  attestEvalRecordChallengeExecution,
} from '../shared/lib/challenge-execution-contract.ts';
import { attachChallengeExecutionMetadata, attachEligibility } from '../shared/lib/eval-record-builder.ts';
import {
  buildSupersedingComparisonRecord,
} from '../shared/lib/challenge-pair-recovery.ts';
import type { ChallengeStage } from '../shared/lib/challenge-mode.ts';

export const CORRECTION_REASON = 'hok-3321-registry-equivalence';
export const RECOVERY_TOOL_NAME = 'recover-hok-3313';

export type RecoveryDisposition =
  | 're-attested'
  | 'ineligible-not-invalid'
  | 'ineligible-genuinely-invalid'
  | 'missing-intent'
  | 'not-found'
  | 'already-recovered';

export interface RecoveryEntry {
  evalId: string;
  disposition: RecoveryDisposition;
  reason?: string;
  pairId?: string;
  before: {
    invalidChallenge?: boolean;
    challengeDivergenceReason?: string;
    trainingEligible?: boolean;
  };
  after?: {
    validity: string;
    invalidChallenge: boolean;
    challengeDivergenceReason?: string;
    trainingEligible?: boolean;
  };
  /** New eval record id that will be (or was) appended; re-attested entries only. */
  newEvalId?: string;
}

export interface RecoverHok3313Summary {
  repoDir: string;
  evalsPath: string;
  challengeRecordsPath: string;
  write: boolean;
  requested: number;
  entries: RecoveryEntry[];
  evalsToAppend: number;
  comparisonsToAppend: number;
  evalsAppended: number;
  comparisonsAppended: number;
}

export interface RecoverHok3313Options {
  repoDir: string;
  evalIds: string[];
  write?: boolean;
  now?: () => string;
}

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {} as Record<string, unknown>;
      }
    });
}

/** Execution-evidence model for the challenge stage, preferring stage truth. */
function executedModelForStage(record: EvalRecord, stage: ChallengeStage | undefined): string | undefined {
  if (stage === 'plan') {
    return record.executedPlanning?.model ?? record.modelId;
  }
  return record.modelId;
}

function latestForPairAndSide(
  records: Array<Record<string, unknown>>,
  pairId: string,
  side: 'primary' | 'challenger',
): EvalRecord | undefined {
  const rows = records.filter((row) => row.challengePairId === pairId && row.challengeSide === side) as unknown as EvalRecord[];
  return rows[rows.length - 1];
}

/**
 * Re-attest the requested eval records with the migrated (registry-aware)
 * attestation and, for pairs whose comparison row was invalidated on the same
 * cause, plan/append a superseding comparison record.
 */
export function recoverHok3313(options: RecoverHok3313Options): RecoverHok3313Summary {
  const now = options.now ?? (() => new Date().toISOString());
  if (options.evalIds.length === 0) {
    throw new Error('recover-hok-3313 requires at least one eval ID; there is no recover-all mode');
  }

  const repoDir = resolve(options.repoDir);
  const evalsDir = resolveEvalsDir(undefined, repoDir).dir;
  const evalsPath = join(evalsDir, 'evals.jsonl');
  const challengeRecordsPath = join(evalsDir, 'challenge-records.jsonl');

  const allRecords = readJsonl(evalsPath);
  const recoveredIds = new Set(
    allRecords
      .map((row) => (row.correctionProvenance as { supersedes?: { evalId?: string } } | undefined)?.supersedes?.evalId)
      .filter((id): id is string => typeof id === 'string'),
  );

  const entries: RecoveryEntry[] = [];
  const correctedRecords: Array<{ record: EvalRecord; entry: RecoveryEntry }> = [];

  for (const evalId of options.evalIds) {
    const rows = allRecords.filter((row) => row.id === evalId) as unknown as EvalRecord[];
    const record = rows[rows.length - 1];
    if (!record) {
      entries.push({ evalId, disposition: 'not-found', before: {} });
      continue;
    }
    if (recoveredIds.has(evalId)) {
      entries.push({
        evalId,
        disposition: 'already-recovered',
        reason: 'a corrected record superseding this eval id already exists',
        pairId: record.challengePairId,
        before: {
          invalidChallenge: record.invalidChallenge,
          challengeDivergenceReason: record.challengeDivergenceReason,
          trainingEligible: record.trainingEligible,
        },
      });
      continue;
    }
    if (record.invalidChallenge !== true && !record.challengeDivergenceReason) {
      entries.push({
        evalId,
        disposition: 'ineligible-not-invalid',
        reason: 'record is not marked invalid; nothing to correct',
        pairId: record.challengePairId,
        before: {
          invalidChallenge: record.invalidChallenge,
          challengeDivergenceReason: record.challengeDivergenceReason,
          trainingEligible: record.trainingEligible,
        },
      });
      continue;
    }

    const attestation = attestEvalRecordChallengeExecution(record, repoDir);
    if (!attestation) {
      entries.push({
        evalId,
        disposition: 'missing-intent',
        reason: 'record carries no persisted challenge intent; it cannot be re-attested',
        pairId: record.challengePairId,
        before: {
          invalidChallenge: record.invalidChallenge,
          challengeDivergenceReason: record.challengeDivergenceReason,
          trainingEligible: record.trainingEligible,
        },
      });
      continue;
    }
    if (attestation.invalidReason) {
      entries.push({
        evalId,
        disposition: 'ineligible-genuinely-invalid',
        reason: attestation.invalidReason,
        pairId: record.challengePairId,
        before: {
          invalidChallenge: record.invalidChallenge,
          challengeDivergenceReason: record.challengeDivergenceReason,
          trainingEligible: record.trainingEligible,
        },
        after: {
          validity: attestation.validity,
          invalidChallenge: true,
          challengeDivergenceReason: record.challengeDivergenceReason,
          trainingEligible: record.trainingEligible,
        },
      });
      continue;
    }

    // Eligible: clone, correct, append. The original stays on disk untouched.
    const corrected: EvalRecord = JSON.parse(JSON.stringify(record)) as EvalRecord;
    corrected.id = randomUUID();
    corrected.timestamp = now();
    delete corrected.invalidChallenge;
    delete corrected.challengeDivergenceReason;
    if (corrected.nonRewardReason?.code === 'INVALID_CHALLENGE') {
      delete corrected.nonRewardReason;
    }
    corrected.correctionProvenance = {
      supersedes: {
        evalId: record.id!,
        reason: CORRECTION_REASON,
        correctedAt: now(),
        correctedBy: `tools/${RECOVERY_TOOL_NAME}.ts`,
      },
    };
    attachChallengeExecutionMetadata(corrected, {
      side: record.challengeSide,
      intent: record.challengeIntent,
      evidence: {
        ...attestation,
        evidence: [
          ...attestation.evidence,
          { stage: attestation.challengeStage, source: RECOVERY_TOOL_NAME },
        ],
      },
    });
    attachEligibility(corrected);

    const entry: RecoveryEntry = {
      evalId,
      disposition: 're-attested',
      pairId: record.challengePairId,
      before: {
        invalidChallenge: record.invalidChallenge,
        challengeDivergenceReason: record.challengeDivergenceReason,
        trainingEligible: record.trainingEligible,
      },
      after: {
        validity: attestation.validity,
        invalidChallenge: corrected.invalidChallenge === true,
        challengeDivergenceReason: corrected.challengeDivergenceReason,
        trainingEligible: corrected.trainingEligible,
      },
      newEvalId: corrected.id,
    };
    entries.push(entry);
    correctedRecords.push({ record: corrected, entry });
  }

  // Rebuild comparisons for pairs whose challenge-records row was invalidated
  // on the same cause. Only pairs with a re-attested arm are considered.
  const challengeRecords = readJsonl(challengeRecordsPath);
  const comparisons: Array<Record<string, unknown>> = [];
  for (const { record: corrected, entry } of correctedRecords) {
    const pairId = entry.pairId;
    if (!pairId) continue;
    const pairRows = challengeRecords.filter((row) => row.challengePairId === pairId);
    const previous = pairRows[pairRows.length - 1];
    if (!previous || previous.invalidChallenge !== true) continue;
    if (previous.invalidChallengeReason !== undefined
      && previous.invalidChallengeReason !== 'stage_override_lost'
      && previous.invalidChallengeReason !== 'native_launch_fallback') {
      continue;
    }

    const side = corrected.challengeSide === 'challenger' ? 'primary' : 'challenger';
    const counterpart = latestForPairAndSide(allRecords, pairId, side) ?? corrected;
    const primaryRecord = corrected.challengeSide === 'primary' ? corrected : counterpart;
    const challengerRecord = corrected.challengeSide === 'challenger' ? corrected : counterpart;
    const stage = (corrected.challengeStage ?? (corrected.challengeIntent as { selectedStage?: ChallengeStage } | undefined)?.selectedStage) as ChallengeStage | undefined;

    comparisons.push(buildSupersedingComparisonRecord({
      pairId,
      challengeStage: stage,
      primaryModel: executedModelForStage(primaryRecord, stage),
      challengerModel: executedModelForStage(challengerRecord, stage),
      primaryPrUrl: primaryRecord.prUrl,
      challengerPrUrl: challengerRecord.prUrl,
      primaryEvalScore: primaryRecord.score,
      challengerEvalScore: challengerRecord.score,
      selectedEvalEvidence: {
        primary: { evalId: primaryRecord.id, evaluatedPrHeadSha: primaryRecord.evaluatedPrHeadSha },
        challenger: { evalId: challengerRecord.id, evaluatedPrHeadSha: challengerRecord.evaluatedPrHeadSha },
      },
      intentCreatedAt: (corrected.challengeIntent as { createdAt?: string } | undefined)?.createdAt,
      evidence: [{
        side: corrected.challengeSide,
        evalId: entry.newEvalId,
        supersedesEvalId: entry.evalId,
        source: RECOVERY_TOOL_NAME,
      }],
      previous,
      assessedAt: now(),
      toolName: RECOVERY_TOOL_NAME,
    }));
  }

  let evalsAppended = 0;
  let comparisonsAppended = 0;
  if (options.write === true) {
    for (const { record: corrected } of correctedRecords) {
      appendFileSync(evalsPath, `${JSON.stringify(corrected)}\n`, 'utf8');
      evalsAppended += 1;
    }
    for (const comparison of comparisons) {
      appendFileSync(challengeRecordsPath, `${JSON.stringify(comparison)}\n`, 'utf8');
      comparisonsAppended += 1;
    }
  }

  return {
    repoDir,
    evalsPath,
    challengeRecordsPath,
    write: options.write === true,
    requested: options.evalIds.length,
    entries,
    evalsToAppend: correctedRecords.length,
    comparisonsToAppend: comparisons.length,
    evalsAppended,
    comparisonsAppended,
  };
}

export function runRecoverHok3313Cli(argv: string[] = process.argv.slice(2)): void {
  runTool({
    name: RECOVERY_TOOL_NAME,
    description: 'Re-attest eval records falsely invalidated by the HOK-3313 raw-string model comparison (dry-run by default, append-only with --write)',
    options: {
      'repo-dir': { type: 'string', description: 'Repository root (default: cwd)' },
      write: { type: 'boolean', description: 'Append corrected records; default is dry-run' },
    },
    positional: {
      name: 'eval-id',
      description: 'Eval record id to re-attest (from evals.jsonl)',
      multiple: true,
      required: true,
    },
    examples: [
      'npx tsx tools/recover-hok-3313.ts 8731fea1-ee09-4f30-aec9-00ac06011f4d',
      'npx tsx tools/recover-hok-3313.ts 8731fea1-ee09-4f30-aec9-00ac06011f4d --write',
    ],
    run({ args, positional }) {
      const summary = recoverHok3313({
        repoDir: (args['repo-dir'] as string) || process.cwd(),
        evalIds: positional,
        write: args.write === true,
      });
      console.log(JSON.stringify(summary, null, 2));
    },
  }, argv);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  runRecoverHok3313Cli();
}
