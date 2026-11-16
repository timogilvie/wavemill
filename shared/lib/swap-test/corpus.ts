import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { StoredChallengeComparison } from '../challenge-comparison.ts';
import { LOSER_PATCH_MAX_BYTES } from '../pr-comparison.ts';
import { fetchPrDiff, type PrDiffFetchDeps } from '../pr-diff-provider.ts';
import { errorMessage } from '../error-utils.ts';
import { selectChallengeEvalScore } from '../challenge-score-selector.ts';
import type { EvalRecord } from '../eval-schema.ts';
import {
  deriveChallengeType,
  deriveDifficultyBucket,
  lookupPairEvals,
  readEvalRowsForPairs,
  type ChallengeTypeDerivation,
  type DifficultyDerivation,
} from './strata.ts';
import type { SelectedAdjudicatedPair } from './pair-selection.ts';

export type CorpusSide = 'primary' | 'challenger';
export type HydrationStatus = 'ok' | 'failed';

export interface PrHeadIdentity {
  head_sha: string | null;
  state?: string;
}

export interface SwapTestCorpusContext {
  pairId: string;
  hydrationStatus: HydrationStatus;
  hydrationErrors: string[];
  issuePrompt: string;
  issuePromptSource: 'primaryEval.originalPrompt' | 'challengerEval.originalPrompt' | 'placeholder';
  primaryPrUrl: string;
  challengerPrUrl: string;
  primaryHead?: PrHeadIdentity;
  challengerHead?: PrHeadIdentity;
  primaryRouting?: StoredChallengeComparison['primaryRouting'];
  challengerRouting?: StoredChallengeComparison['challengerRouting'];
  primaryExecution?: StoredChallengeComparison['primaryExecution'];
  challengerExecution?: StoredChallengeComparison['challengerExecution'];
  challengeType: ChallengeTypeDerivation;
  difficulty: DifficultyDerivation;
  primaryEvalScore?: ReturnType<typeof selectChallengeEvalScore>;
  challengerEvalScore?: ReturnType<typeof selectChallengeEvalScore>;
  primaryStageEval?: EvalRecord['challengeStageEval'];
  challengerStageEval?: EvalRecord['challengeStageEval'];
  evalProvenance: {
    primary?: string;
    challenger?: string;
  };
  degenerate: string[];
  originalVerdict: {
    winner?: 'primary' | 'challenger';
    dimensions?: StoredChallengeComparison['dimensions'];
    presentationOrder: string;
    timestamp: string;
    tiedOriginal: boolean;
  };
}

export interface CorpusPair {
  context: SwapTestCorpusContext;
  primaryDiff: string;
  challengerDiff: string;
}

export interface HydrateCorpusDeps {
  fetchDiff?: (prUrl: string) => Buffer | 'too_large';
  fetchPrHead?: (prUrl: string) => PrHeadIdentity;
}

export interface HydrateCorpusOptions {
  pairs: readonly SelectedAdjudicatedPair[];
  evalsDir: string;
  repoDir: string;
  maxBytes?: number;
  deps?: HydrateCorpusDeps;
}

export interface HydrationLedger {
  pairs: number;
  hydrated: number;
  reused: number;
  fetched: number;
  failed: number;
  empty: number;
  tooLarge: number;
}

function artifactDir(evalsDir: string, pairId: string): string {
  return join(evalsDir, 'artifacts', pairId);
}

function diffPath(evalsDir: string, pairId: string, side: CorpusSide): string {
  return join(artifactDir(evalsDir, pairId), `${side}.diff`);
}

function contextPath(evalsDir: string, pairId: string): string {
  return join(artifactDir(evalsDir, pairId), 'swap-test-context.json');
}

/**
 * The corpus' diff reader: a thin adapter over the one PR-diff reader
 * (HOK-3493). `deps` exists so the mapping is testable; production passes none.
 */
export function defaultFetchDiff(
  repoDir: string,
  maxBytes: number,
  deps?: PrDiffFetchDeps,
): (prUrl: string) => Buffer | 'too_large' {
  return (prUrl) => {
    const result = fetchPrDiff(prUrl, repoDir, { maxBytes, ...deps });
    if (result.kind === 'diff') return Buffer.from(result.text, 'utf8');
    if (result.reason === 'gh_too_large' || result.reason === 'buffer_overrun') return 'too_large';
    throw new Error(result.detail);
  };
}

function defaultFetchPrHead(repoDir: string): (prUrl: string) => PrHeadIdentity {
  return (prUrl) => {
    const raw = execFileSync('gh', ['pr', 'view', prUrl, '--json', 'headRefOid,state'], {
      cwd: repoDir,
      encoding: 'utf-8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(raw) as { headRefOid?: string; state?: string };
    return {
      head_sha: parsed.headRefOid ?? null,
      state: parsed.state,
    };
  };
}

function sidePrUrl(record: StoredChallengeComparison, side: CorpusSide): string {
  return side === 'primary' ? record.primaryPrUrl : record.challengerPrUrl;
}

function loserSide(record: StoredChallengeComparison): CorpusSide | undefined {
  if (record.winner === 'primary') return 'challenger';
  if (record.winner === 'challenger') return 'primary';
  return undefined;
}

function writeSideDiff(input: {
  record: StoredChallengeComparison;
  side: CorpusSide;
  evalsDir: string;
  maxBytes: number;
  fetchDiff: (prUrl: string) => Buffer | 'too_large';
}): { reused: boolean; fetched: boolean; empty: boolean; tooLarge: boolean } {
  const path = diffPath(input.evalsDir, input.record.challengePairId, input.side);
  if (existsSync(path)) {
    return { reused: true, fetched: false, empty: statSync(path).size === 0, tooLarge: false };
  }

  mkdirSync(artifactDir(input.evalsDir, input.record.challengePairId), { recursive: true });
  const loserPatch = join(artifactDir(input.evalsDir, input.record.challengePairId), 'loser.patch');
  if (loserSide(input.record) === input.side && existsSync(loserPatch)) {
    copyFileSync(loserPatch, path);
    return { reused: true, fetched: false, empty: statSync(path).size === 0, tooLarge: false };
  }

  const diff = input.fetchDiff(sidePrUrl(input.record, input.side));
  if (diff === 'too_large') {
    return { reused: false, fetched: true, empty: false, tooLarge: true };
  }
  writeFileSync(path, diff);
  return { reused: false, fetched: true, empty: diff.length === 0, tooLarge: false };
}

function originalIsTied(record: StoredChallengeComparison): boolean {
  const dimensions = record.dimensions as Record<string, { primary?: number; challenger?: number }>;
  const entries = Object.values(dimensions || {});
  return entries.length > 0 && entries.every((entry) => entry.primary === entry.challenger);
}

function promptFromEvals(primary?: EvalRecord, challenger?: EvalRecord): {
  issuePrompt: string;
  source: SwapTestCorpusContext['issuePromptSource'];
} {
  if (primary?.originalPrompt) {
    return { issuePrompt: primary.originalPrompt, source: 'primaryEval.originalPrompt' };
  }
  if (challenger?.originalPrompt) {
    return { issuePrompt: challenger.originalPrompt, source: 'challengerEval.originalPrompt' };
  }
  return { issuePrompt: 'Issue prompt unavailable in retained eval state.', source: 'placeholder' };
}

export function hydrateCorpus(options: HydrateCorpusOptions): HydrationLedger {
  const maxBytes = options.maxBytes ?? LOSER_PATCH_MAX_BYTES;
  const fetchDiff = options.deps?.fetchDiff ?? defaultFetchDiff(options.repoDir, maxBytes);
  const fetchPrHead = options.deps?.fetchPrHead ?? defaultFetchPrHead(options.repoDir);
  const evalIndex = readEvalRowsForPairs(options.evalsDir);
  const ledger: HydrationLedger = {
    pairs: options.pairs.length,
    hydrated: 0,
    reused: 0,
    fetched: 0,
    failed: 0,
    empty: 0,
    tooLarge: 0,
  };

  for (const pair of options.pairs) {
    const record = pair.record;
    const errors: string[] = [];
    const degenerate: string[] = [];
    const evals = lookupPairEvals(evalIndex, record);
    const prompt = promptFromEvals(evals.primary, evals.challenger);

    for (const side of ['primary', 'challenger'] as const) {
      try {
        const result = writeSideDiff({ record, side, evalsDir: options.evalsDir, maxBytes, fetchDiff });
        if (result.reused) ledger.reused++;
        if (result.fetched) ledger.fetched++;
        if (result.empty) {
          ledger.empty++;
          degenerate.push(`${side}_empty_diff`);
        }
        if (result.tooLarge) {
          ledger.tooLarge++;
          errors.push(`${side} diff exceeds ${maxBytes} bytes`);
        }
      } catch (error) {
        errors.push(`${side} diff: ${errorMessage(error)}`);
      }
    }

    let primaryHead: PrHeadIdentity | undefined;
    let challengerHead: PrHeadIdentity | undefined;
    try {
      primaryHead = fetchPrHead(record.primaryPrUrl);
    } catch (error) {
      errors.push(`primary head: ${errorMessage(error)}`);
    }
    try {
      challengerHead = fetchPrHead(record.challengerPrUrl);
    } catch (error) {
      errors.push(`challenger head: ${errorMessage(error)}`);
    }

    if (originalIsTied(record)) {
      degenerate.push('tied_original');
    }

    const challengeType = deriveChallengeType(record, evals);
    const context: SwapTestCorpusContext = {
      pairId: record.challengePairId,
      hydrationStatus: errors.length > 0 ? 'failed' : 'ok',
      hydrationErrors: errors,
      issuePrompt: prompt.issuePrompt,
      issuePromptSource: prompt.source,
      primaryPrUrl: record.primaryPrUrl,
      challengerPrUrl: record.challengerPrUrl,
      primaryHead,
      challengerHead,
      primaryRouting: record.primaryRouting,
      challengerRouting: record.challengerRouting,
      primaryExecution: record.primaryExecution,
      challengerExecution: record.challengerExecution,
      challengeType,
      difficulty: deriveDifficultyBucket(evals.primary, evals.challenger),
      primaryEvalScore: evals.primary ? selectChallengeEvalScore(evals.primary, challengeType.type === 'depth-varied' || challengeType.type === 'unrecoverable' ? undefined : challengeType.type) : undefined,
      challengerEvalScore: evals.challenger ? selectChallengeEvalScore(evals.challenger, challengeType.type === 'depth-varied' || challengeType.type === 'unrecoverable' ? undefined : challengeType.type) : undefined,
      primaryStageEval: evals.primary?.challengeStageEval,
      challengerStageEval: evals.challenger?.challengeStageEval,
      evalProvenance: evals.provenance,
      degenerate,
      originalVerdict: {
        winner: record.winner,
        dimensions: record.dimensions,
        presentationOrder: record.presentationOrder ?? 'primary-first-unblinded-legacy',
        timestamp: record.timestamp,
        tiedOriginal: degenerate.includes('tied_original'),
      },
    };

    mkdirSync(artifactDir(options.evalsDir, pair.pairId), { recursive: true });
    writeFileSync(contextPath(options.evalsDir, pair.pairId), `${JSON.stringify(context, null, 2)}\n`, 'utf-8');
    if (errors.length > 0) {
      ledger.failed++;
    } else {
      ledger.hydrated++;
    }
  }

  return ledger;
}

export function readCorpusPair(evalsDir: string, pairId: string): CorpusPair {
  const context = JSON.parse(readFileSync(contextPath(evalsDir, pairId), 'utf-8')) as SwapTestCorpusContext;
  return {
    context,
    primaryDiff: readFileSync(diffPath(evalsDir, pairId, 'primary'), 'utf-8'),
    challengerDiff: readFileSync(diffPath(evalsDir, pairId, 'challenger'), 'utf-8'),
  };
}
