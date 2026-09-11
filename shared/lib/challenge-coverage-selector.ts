import type { ChallengeStage } from './challenge-scheduler.ts';
import { loadLaunchPriorityList, type ModelFamily } from './openrouter-catalog.ts';

export type ChallengeSelectionReason =
  | 'least-used-zero-record'
  | 'least-used-nonzero'
  | 'least-used-fallforward'
  | 'recommendation-honored'
  | 'tie-break-family-rotation'
  | 'last-resort-incumbent';

export interface ChallengeLaunchPriorityMetadata {
  family: ModelFamily | string;
  priorityTier: number;
  isIncumbent: boolean;
}

export interface ChallengeCoverageSelectionInput {
  stage: ChallengeStage;
  primaryModel: string;
  candidates: string[];
  coverage: (model: string, stage: ChallengeStage) => number;
  recommendedChallenger?: string;
  rotationSeed: string;
  launchPriorityByAlias?: Map<string, ChallengeLaunchPriorityMetadata>;
}

export interface ChallengeCoverageSelectionResult {
  model: string | null;
  selectionReason: ChallengeSelectionReason | 'no-eligible-candidate';
  coverageCount: number;
  eligibleCandidates: string[];
}

interface RankedCandidate {
  model: string;
  count: number;
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
  stage: ChallengeStage,
  coverage: (model: string, stage: ChallengeStage) => number,
  launchPriorityByAlias: Map<string, ChallengeLaunchPriorityMetadata>,
): RankedCandidate {
  const metadata = launchPriorityByAlias.get(model);
  return {
    model,
    count: coverage(model, stage),
    family: metadata?.family ?? model,
    priorityTier: metadata?.priorityTier ?? Number.POSITIVE_INFINITY,
    isIncumbent: metadata?.isIncumbent ?? false,
  };
}

export function selectLeastUsedChallenger(
  input: ChallengeCoverageSelectionInput,
): ChallengeCoverageSelectionResult {
  const eligibleCandidates = normalizeEligibleCandidates(input.primaryModel, input.candidates);
  if (eligibleCandidates.length === 0) {
    return {
      model: null,
      selectionReason: 'no-eligible-candidate',
      coverageCount: 0,
      eligibleCandidates,
    };
  }

  const launchPriorityByAlias = input.launchPriorityByAlias ?? getLaunchPriorityByAlias();
  const ranked = eligibleCandidates.map((model) => rankCandidate(
    model,
    input.stage,
    input.coverage,
    launchPriorityByAlias,
  ));
  const preferred = ranked.filter((candidate) => !candidate.isIncumbent && launchPriorityByAlias.has(candidate.model));
  const activePool = preferred.length > 0 ? preferred : ranked;

  const minCount = activePool.reduce(
    (lowest, candidate) => Math.min(lowest, candidate.count),
    Number.POSITIVE_INFINITY,
  );
  const leastUsed = activePool.filter((candidate) => candidate.count === minCount);
  const minPriorityTier = leastUsed.reduce(
    (lowest, candidate) => Math.min(lowest, candidate.priorityTier),
    Number.POSITIVE_INFINITY,
  );
  const tierTied = leastUsed.filter((candidate) => candidate.priorityTier === minPriorityTier);
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
  if (preferred.length === 0 && selected.isIncumbent) {
    selectionReason = 'last-resort-incumbent';
  } else if (families.length > 1 && tierTied.length > 1) {
    selectionReason = 'tie-break-family-rotation';
  } else if (minCount === 0) {
    selectionReason = 'least-used-zero-record';
  } else if (
    input.recommendedChallenger?.trim()
    && selected.model === input.recommendedChallenger.trim()
    && leastUsed.some((candidate) => candidate.model === selected.model)
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
    eligibleCandidates,
  };
}
