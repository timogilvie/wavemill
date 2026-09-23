import type { ChallengeStage } from './challenge-scheduler.ts';
import { loadLaunchPriorityList, type ModelFamily } from './openrouter-catalog.ts';

export type ChallengeSelectionReason =
  | 'least-used-zero-record'
  | 'least-used-nonzero'
  | 'least-used-fallforward'
  | 'recommendation-honored'
  | 'tie-break-family-rotation'
  | 'least-attempted'
  | 'cooldown-fallback'
  | 'last-resort-incumbent';

export interface ChallengeLaunchPriorityMetadata {
  family: ModelFamily | string;
  priorityTier: number;
  isIncumbent: boolean;
}

/**
 * Per-candidate terminal-attempt evidence consumed by ranking (HOK-3066).
 * Attempts never convert into coverage; they only order candidates whose
 * successful coverage is already tied.
 */
export interface ChallengeAttemptRankingInput {
  attemptCount: number;
  lastAttemptAt?: string;
  cooldownActive?: boolean;
}

export interface ChallengeCoverageSelectionInput {
  stage: ChallengeStage;
  primaryModel: string;
  candidates: string[];
  coverage: (model: string, stage: ChallengeStage) => number;
  /**
   * Recent terminal-attempt evidence per model. Optional: callers without it
   * (zero-traffic reporting, legacy paths, attemptRanking disabled) keep the
   * exact pre-HOK-3066 coverage/priority/rotation behavior.
   */
  attemptEvidence?: (model: string) => ChallengeAttemptRankingInput | undefined;
  recommendedChallenger?: string;
  rotationSeed: string;
  launchPriorityByAlias?: Map<string, ChallengeLaunchPriorityMetadata>;
}

export interface ChallengeCoverageSelectionResult {
  model: string | null;
  selectionReason: ChallengeSelectionReason | 'no-eligible-candidate';
  coverageCount: number;
  attemptCount: number;
  lastAttemptAt?: string;
  cooldownActive: boolean;
  priorityTier: number | null;
  eligibleCandidates: string[];
}

interface RankedCandidate {
  model: string;
  count: number;
  attemptCount: number;
  lastAttemptAtMs: number;
  lastAttemptAt?: string;
  cooldownActive: boolean;
  family: string;
  priorityTier: number;
  isIncumbent: boolean;
}

let launchPriorityByAliasCache: Map<string, ChallengeLaunchPriorityMetadata> | null = null;

/**
 * Launch-priority metadata keyed by wavemill alias.
 *
 * This is the single definition of "incumbent" (the `claude` and `gpt`
 * families) used by every challenger-ranking path, so the coverage selector
 * and the challenge scheduler cannot drift apart on which families exploration
 * should favour.
 */
export function getLaunchPriorityByAlias(): Map<string, ChallengeLaunchPriorityMetadata> {
  if (!launchPriorityByAliasCache) {
    launchPriorityByAliasCache = new Map(
      loadLaunchPriorityList().map((entry) => [
        entry.wavemillAlias,
        {
          family: entry.family,
          priorityTier: entry.priorityTier,
          isIncumbent: entry.family === 'claude' || entry.family === 'gpt',
        },
      ]),
    );
  }
  return launchPriorityByAliasCache;
}

function normalizeEligibleCandidates(primaryModel: string, candidates: string[]): string[] {
  const primary = primaryModel.trim();
  const seen = new Set<string>();
  const eligible: string[] = [];

  for (const candidate of candidates) {
    const model = candidate.trim();
    if (!model || model === primary || seen.has(model)) {
      continue;
    }
    seen.add(model);
    eligible.push(model);
  }

  return eligible;
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function rankCandidate(
  model: string,
  input: ChallengeCoverageSelectionInput,
  launchPriorityByAlias: Map<string, ChallengeLaunchPriorityMetadata>,
): RankedCandidate {
  const metadata = launchPriorityByAlias.get(model);
  const attempts = input.attemptEvidence?.(model);
  const lastAttemptAtMs = attempts?.lastAttemptAt ? Date.parse(attempts.lastAttemptAt) : Number.NaN;
  return {
    model,
    count: input.coverage(model, input.stage),
    attemptCount: attempts?.attemptCount ?? 0,
    // A never-attempted candidate sorts as the oldest possible attempt so it
    // wins the "oldest last attempt" comparison over any attempted peer.
    lastAttemptAtMs: Number.isFinite(lastAttemptAtMs) ? lastAttemptAtMs : Number.NEGATIVE_INFINITY,
    ...(attempts?.lastAttemptAt ? { lastAttemptAt: attempts.lastAttemptAt } : {}),
    cooldownActive: attempts?.cooldownActive === true,
    family: metadata?.family ?? model,
    priorityTier: metadata?.priorityTier ?? Number.POSITIVE_INFINITY,
    isIncumbent: metadata?.isIncumbent ?? false,
  };
}

/**
 * Rank the already certified, stage-eligible, reservation- and circuit-filtered
 * candidate pool. Order (HOK-3066): lowest successful coverage, fewest recent
 * terminal attempts, oldest last attempt, then launch-priority tier and seeded
 * family rotation. Candidates in an active failed-attempt cooldown are removed
 * whenever a non-cooled candidate exists; when every candidate is cooled the
 * deterministic fallback still selects one and reports `cooldown-fallback`.
 */
export function selectLeastUsedChallenger(
  input: ChallengeCoverageSelectionInput,
): ChallengeCoverageSelectionResult {
  const eligibleCandidates = normalizeEligibleCandidates(input.primaryModel, input.candidates);
  if (eligibleCandidates.length === 0) {
    return {
      model: null,
      selectionReason: 'no-eligible-candidate',
      coverageCount: 0,
      attemptCount: 0,
      cooldownActive: false,
      priorityTier: null,
      eligibleCandidates,
    };
  }

  const launchPriorityByAlias = input.launchPriorityByAlias ?? getLaunchPriorityByAlias();
  const ranked = eligibleCandidates.map((model) => rankCandidate(model, input, launchPriorityByAlias));
  const preferred = ranked.filter((candidate) => !candidate.isIncumbent && launchPriorityByAlias.has(candidate.model));
  const familyPool = preferred.length > 0 ? preferred : ranked;

  const nonCooled = familyPool.filter((candidate) => !candidate.cooldownActive);
  const cooldownFallback = nonCooled.length === 0 && familyPool.some((candidate) => candidate.cooldownActive);
  const activePool = nonCooled.length > 0 ? nonCooled : familyPool;

  const minCount = activePool.reduce(
    (lowest, candidate) => Math.min(lowest, candidate.count),
    Number.POSITIVE_INFINITY,
  );
  const leastUsed = activePool.filter((candidate) => candidate.count === minCount);
  const minAttempts = leastUsed.reduce(
    (lowest, candidate) => Math.min(lowest, candidate.attemptCount),
    Number.POSITIVE_INFINITY,
  );
  const leastAttempted = leastUsed.filter((candidate) => candidate.attemptCount === minAttempts);
  const oldestAttemptMs = leastAttempted.reduce(
    (oldest, candidate) => Math.min(oldest, candidate.lastAttemptAtMs),
    Number.POSITIVE_INFINITY,
  );
  const oldestAttempted = leastAttempted.filter((candidate) => candidate.lastAttemptAtMs === oldestAttemptMs);
  const attemptsNarrowed = leastAttempted.length < leastUsed.length
    || oldestAttempted.length < leastAttempted.length;
  const minPriorityTier = oldestAttempted.reduce(
    (lowest, candidate) => Math.min(lowest, candidate.priorityTier),
    Number.POSITIVE_INFINITY,
  );
  const tierTied = oldestAttempted.filter((candidate) => candidate.priorityTier === minPriorityTier);
  const families = [...new Set(tierTied.map((candidate) => candidate.family))].sort((left, right) => left.localeCompare(right));
  const familyRotation = new Map<string, number>();
  if (families.length > 0) {
    const offset = fnv1a32(input.rotationSeed) % families.length;
    families.forEach((family, index) => {
      familyRotation.set(family, (index - offset + families.length) % families.length);
    });
  }

  const ordered = [...tierTied].sort((left, right) => {
    const leftRank = familyRotation.get(left.family) ?? 0;
    const rightRank = familyRotation.get(right.family) ?? 0;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return left.model.localeCompare(right.model);
  });
  const selected = ordered[0];

  let selectionReason: ChallengeCoverageSelectionResult['selectionReason'];
  if (cooldownFallback && selected.cooldownActive) {
    selectionReason = 'cooldown-fallback';
  } else if (preferred.length === 0 && selected.isIncumbent) {
    selectionReason = 'last-resort-incumbent';
  } else if (families.length > 1 && tierTied.length > 1) {
    selectionReason = 'tie-break-family-rotation';
  } else if (attemptsNarrowed) {
    selectionReason = 'least-attempted';
  } else if (minCount === 0) {
    selectionReason = 'least-used-zero-record';
  } else if (
    input.recommendedChallenger?.trim()
    && selected.model === input.recommendedChallenger.trim()
    && leastAttempted.some((candidate) => candidate.model === selected.model)
  ) {
    selectionReason = 'recommendation-honored';
  } else if (input.recommendedChallenger?.trim()) {
    selectionReason = 'least-used-fallforward';
  } else {
    selectionReason = 'least-used-nonzero';
  }

  return {
    model: selected.model,
    selectionReason,
    coverageCount: selected.count,
    attemptCount: selected.attemptCount,
    ...(selected.lastAttemptAt ? { lastAttemptAt: selected.lastAttemptAt } : {}),
    cooldownActive: selected.cooldownActive,
    priorityTier: Number.isFinite(selected.priorityTier) ? selected.priorityTier : null,
    eligibleCandidates,
  };
}
