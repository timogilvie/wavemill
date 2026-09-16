import { CANONICAL_PACKET_SECTIONS, type PacketFeatures } from './task-packet-feature-extractor.ts';

export type TaskScorerDecision = 'run' | 'expand' | 'split' | 'return';

export interface TaskScorerResult {
  decision: TaskScorerDecision;
  confidence: number;
  explanation: string;
  model_version: string;
}

export const TASK_PACKET_SCORER_MODEL_VERSION = 'task-packet-scorer-v1-heuristic-2026-09-15';

const MODEL = {
  version: TASK_PACKET_SCORER_MODEL_VERSION,
  intercept: -1.15,
  weights: {
    missingSectionRatio: 2.35,
    lowRequirementSignal: 1.15,
    lowValidationSignal: 1.35,
    vaguePhraseDensity: 7.5,
    overloadedFileCount: 0.22,
    shortPacket: 1.25,
    difficulty: 0.18,
  },
};

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function missingSectionRatio(features: PacketFeatures): number {
  const missing = CANONICAL_PACKET_SECTIONS.filter((section) => (features.section_lengths[section] ?? 0) === 0).length;
  return missing / CANONICAL_PACKET_SECTIONS.length;
}

export function scoreTaskPacket(features: PacketFeatures): TaskScorerResult {
  const missingRatio = missingSectionRatio(features);
  const lowRequirementSignal = features.req_tag_count === 0 ? 1 : features.req_tag_count < 3 ? 0.5 : 0;
  const lowValidationSignal = features.validation_scenario_count === 0 ? 1 : features.validation_scenario_count < 2 ? 0.45 : 0;
  const overloadedFileCount = Math.max(0, features.file_count - 8);
  const shortPacket = features.total_chars < 500 ? 1 : features.total_chars < 1500 ? 0.45 : 0;
  const difficulty = Math.max(0, Math.min(5, features.difficulty)) / 5;

  const logit =
    MODEL.intercept +
    MODEL.weights.missingSectionRatio * missingRatio +
    MODEL.weights.lowRequirementSignal * lowRequirementSignal +
    MODEL.weights.lowValidationSignal * lowValidationSignal +
    MODEL.weights.vaguePhraseDensity * features.vague_phrase_density +
    MODEL.weights.overloadedFileCount * overloadedFileCount +
    MODEL.weights.shortPacket * shortPacket +
    MODEL.weights.difficulty * difficulty;

  const risk = clamp01(sigmoid(logit));
  let decision: TaskScorerDecision;
  if (risk < 0.45) {
    decision = 'run';
  } else if (risk < 0.67) {
    decision = 'expand';
  } else if (risk < 0.84) {
    decision = overloadedFileCount > 0 ? 'split' : 'expand';
  } else {
    decision = missingRatio > 0.65 || features.total_chars < 250 ? 'return' : 'split';
  }

  const confidence = Number(Math.max(0.5, Math.abs(risk - 0.5) * 1.6 + 0.2).toFixed(3));
  const signals = [
    `${Math.round(missingRatio * 100)}% missing sections`,
    `${features.file_count} file signal(s)`,
    `${features.req_tag_count} requirement tag(s)`,
    `${features.validation_scenario_count} validation scenario(s)`,
    `difficulty=${features.difficulty}`,
  ];
  if (features.vague_phrase_density > 0) {
    signals.push(`vague_density=${features.vague_phrase_density.toFixed(4)}`);
  }

  return {
    decision,
    confidence: clamp01(confidence),
    explanation: `Shadow prediction ${decision} at risk=${risk.toFixed(3)} based on ${signals.join(', ')}.`,
    model_version: MODEL.version,
  };
}
