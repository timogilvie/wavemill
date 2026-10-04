#!/usr/bin/env npx tsx
/**
 * HOK-2970 legacy reviewer-forfeit quarantine sweep.
 *
 * Rewrites `challenge-records.jsonl` rows where:
 *   - `comparisonOutcome === 'forfeit'`
 *   - `terminalReason` ∈ {primary_challenge_aborted, challenger_challenge_aborted, both_challenge_aborted}
 *   - The aborted arm's latest eval record has `invalidChallenge: true`
 * ...into `invalid_challenge` rows with no winner. Preserves `forkStage`
 * and other retention fields; adds a `quarantined` marker with reason
 * `aborted-arm-was-invalid` and ticket `HOK-2970`.
 *
 * The sweep is offline, atomic, and idempotent: a second run touches
 * nothing. A `.bak.<ISO>` backup is created before any rewrite.
 *
 * Usage:
 *   npx tsx tools/quarantine-legacy-reviewer-forfeits.ts --dry-run
 *   npx tsx tools/quarantine-legacy-reviewer-forfeits.ts --apply
 *   npx tsx tools/quarantine-legacy-reviewer-forfeits.ts --dry-run --repo-dir /path/to/repo
 */

import { existsSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, exit, cwd, env } from 'node:process';
import type { StoredChallengeComparison } from '../shared/lib/challenge-comparison.ts';
import type { EvalRecord } from '../shared/lib/eval-schema.ts';
import { readEvalRecords } from '../shared/lib/eval-persistence.ts';

const QUARANTINE_TICKET = 'HOK-2970';
const QUARANTINE_REASON = 'aborted-arm-was-invalid';

const TARGET_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  'primary_challenge_aborted',
  'challenger_challenge_aborted',
  'both_challenge_aborted',
]);

interface CliOptions {
  repoDir: string;
  dryRun: boolean;
  apply: boolean;
}

function parseArgs(): CliOptions {
  const args = argv.slice(2);
  let repoDir = cwd();
  let dryRun = false;
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--repo-dir' && i + 1 < args.length) {
      repoDir = args[++i];
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--apply') {
      apply = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsageAndExit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printUsageAndExit(2);
    }
  }
  return { repoDir, dryRun, apply };
}

function printUsageAndExit(code: number): never {
  const usage = [
    'Usage: npx tsx tools/quarantine-legacy-reviewer-forfeits.ts [--repo-dir <dir>] (--dry-run | --apply)',
    '',
    'Rewrites HOK-2958-shaped rows in .wavemill/evals/challenge-records.jsonl:',
    "  forfeit rows whose aborted arm's latest eval was invalidChallenge:true",
    '  become invalid_challenge rows with no winner and a quarantined marker.',
    '',
    'One of --dry-run or --apply is required. --apply writes atomically after',
    'creating a .bak.<ISO> backup.',
  ].join('\n');
  console.error(usage);
  exit(code);
}

function abortedRoleForTerminalReason(
  reason: string,
): Array<'primary' | 'challenger'> {
  if (reason === 'primary_challenge_aborted') return ['primary'];
  if (reason === 'challenger_challenge_aborted') return ['challenger'];
  if (reason === 'both_challenge_aborted') return ['primary', 'challenger'];
  return [];
}

interface EvalIndex {
  byPairAndSide: Map<string, EvalRecord[]>;
}

function indexEvals(evalsDir: string): EvalIndex {
  const byPairAndSide = new Map<string, EvalRecord[]>();
  try {
    const records = readEvalRecords({ dir: evalsDir });
    for (const record of records) {
      if (!record.challengePairId || !record.challengeSide) continue;
      const key = `${record.challengePairId}|${record.challengeSide}`;
      const bucket = byPairAndSide.get(key) ?? [];
      bucket.push(record);
      byPairAndSide.set(key, bucket);
    }
  } catch (error) {
    console.warn(`[quarantine-legacy-reviewer-forfeits] Could not read evals: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { byPairAndSide };
}

function latestEvalFor(
  index: EvalIndex,
  pairId: string,
  side: 'primary' | 'challenger',
): EvalRecord | null {
  const key = `${pairId}|${side}`;
  const bucket = index.byPairAndSide.get(key);
  if (!bucket || bucket.length === 0) return null;
  return bucket[bucket.length - 1];
}

interface RewriteResult {
  rewritten: boolean;
  reason?: string;
  evidence?: Record<string, unknown>;
}

function evaluateRow(
  record: StoredChallengeComparison,
  index: EvalIndex,
): RewriteResult {
  if (record.comparisonOutcome !== 'forfeit') {
    return { rewritten: false };
  }
  const terminalReason = record.terminalReason ?? '';
  if (!TARGET_TERMINAL_REASONS.has(terminalReason)) {
    return { rewritten: false };
  }
  if (record.quarantined) {
    return { rewritten: false };
  }
  const abortedRoles = abortedRoleForTerminalReason(terminalReason);
  for (const role of abortedRoles) {
    const evalRecord = latestEvalFor(index, record.challengePairId, role);
    if (evalRecord?.invalidChallenge === true) {
      return {
        rewritten: true,
        reason: evalRecord.challengeDivergenceReason ?? 'missing_challenge_intent',
        evidence: {
          abortedSide: role,
          evalId: evalRecord.id,
          ...(evalRecord.evaluatedPrHeadSha ? { evaluatedPrHeadSha: evalRecord.evaluatedPrHeadSha } : {}),
          ...(evalRecord.challengeDivergenceReason ? { challengeDivergenceReason: evalRecord.challengeDivergenceReason } : {}),
        },
      };
    }
  }
  return { rewritten: false };
}

function applyRewrite(
  record: StoredChallengeComparison,
  outcome: RewriteResult,
  nowIso: string,
): StoredChallengeComparison {
  const rewritten: StoredChallengeComparison = {
    ...record,
    comparisonOutcome: 'invalid_challenge',
    invalidChallenge: true,
    ...(outcome.reason ? { invalidChallengeReason: outcome.reason as StoredChallengeComparison['invalidChallengeReason'] } : {}),
    noComparisonReason: 'missing_challenge_intent',
    quarantined: {
      reason: QUARANTINE_REASON,
      ticket: QUARANTINE_TICKET,
      at: nowIso,
      ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
    },
  };
  // Strip phantom winner attribution — new records must not carry these.
  delete rewritten.winner;
  delete rewritten.winnerModel;
  return rewritten;
}

interface SweepSummary {
  scanned: number;
  matched: number;
  rewrote: number;
  alreadyQuarantined: number;
  backupPath?: string;
  outputPath: string;
}

function sweep(options: CliOptions): SweepSummary {
  const evalsDir = join(options.repoDir, '.wavemill', 'evals');
  const recordsPath = join(evalsDir, 'challenge-records.jsonl');
  if (!existsSync(recordsPath)) {
    console.error(`No challenge records at ${recordsPath}; nothing to sweep.`);
    exit(0);
  }

  const nowIso = new Date().toISOString();
  const index = indexEvals(evalsDir);
  const rawContent = readFileSync(recordsPath, 'utf-8');
  const lines = rawContent.split('\n');

  let scanned = 0;
  let matched = 0;
  let rewrote = 0;
  let alreadyQuarantined = 0;

  const updatedLines = lines.map((line) => {
    if (!line.trim()) return line;
    let record: StoredChallengeComparison;
    try {
      record = JSON.parse(line) as StoredChallengeComparison;
    } catch {
      return line;
    }
    scanned++;
    if (record.quarantined && !record.invalidChallenge) {
      alreadyQuarantined++;
    }
    const outcome = evaluateRow(record, index);
    if (!outcome.rewritten) return line;
    matched++;
    const rewritten = applyRewrite(record, outcome, nowIso);
    rewrote++;
    if (options.dryRun) {
      console.log(`DRY-RUN would rewrite ${record.challengePairId} (${record.terminalReason}) → invalid_challenge`);
      return line;
    }
    return JSON.stringify(rewritten);
  });

  const summary: SweepSummary = {
    scanned,
    matched,
    rewrote,
    alreadyQuarantined,
    outputPath: recordsPath,
  };

  if (!options.dryRun && rewrote > 0) {
    const backupPath = `${recordsPath}.bak.${nowIso.replace(/[:.]/g, '-')}`;
    copyFileSync(recordsPath, backupPath);
    const tmpPath = `${recordsPath}.tmp.${process.pid}`;
    writeFileSync(tmpPath, updatedLines.join('\n'), 'utf-8');
    renameSync(tmpPath, recordsPath);
    summary.backupPath = backupPath;
  }

  return summary;
}

function main(): void {
  const options = parseArgs();
  if (!options.dryRun && !options.apply) {
    printUsageAndExit(2);
  }
  if (options.dryRun && options.apply) {
    console.error('Pass exactly one of --dry-run or --apply.');
    exit(2);
  }
  if (env.WAVEMILL_MILL_RUNNING === '1') {
    console.error('Refusing to run while WAVEMILL_MILL_RUNNING=1; stop the mill first.');
    exit(2);
  }
  const summary = sweep(options);
  console.log(`scanned ${summary.scanned}, matched ${summary.matched}, rewrote ${summary.rewrote}, already-quarantined ${summary.alreadyQuarantined}${summary.backupPath ? `, backup: ${summary.backupPath}` : ''}`);
}

main();
