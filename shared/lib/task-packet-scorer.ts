/**
 * Task Packet Scorer v1
 *
 * Deterministic, dependency-free model that predicts whether a task packet
 * is ready for autonomous execution. Produces a decision, confidence score,
 * and human-readable explanation.
 *
 * Coefficients are static constants derived from historical packet-outcome
 * analysis. The model version is bumped whenever coefficients change.
 *
 * @module task-packet-scorer
 */

import type { PacketFeatures, CanonicalSection } from './task-packet-feature-extractor.ts';
import { CANONICAL_SECTIONS } from './task-packet-feature-extractor.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export type TaskScorerDecision = 'run' | 'expand' | 'split' | 'return';

export interface TaskScorerResult {
  decision: TaskScorerDecision;
  confidence: number;
  explanation: string;
  model_version: string;
}

// ────────────────────────────────────────────────────────────────
// v1 Model Constants
// ────────────────────────────────────────────────────────────────

const MODEL_VERSION = 'v1.0.0-heuristic';

const REQUIRED_SECTIONS: CanonicalSection[] = [
  'objective',
  'success_criteria',
  'implementation_approach',
];

const IMPORTANT_SECTIONS: CanonicalSection[] = [
  'technical_context',
  'implementation_constraints',
  'validation_steps',
  'definition_of_done',
];

const MIN_OBJECTIVE_LENGTH = 100;
const MIN_TOTAL_CHARS = 500;
const MAX_VAGUE_PHRASE_RATE = 0.005; // per char
const MIN_FILE_COUNT = 1;
const MIN_REQ_TAGS = 1;

// ────────────────────────────────────────────────────────────────
// Scoring Logic
// ────────────────────────────────────────────────────────────────

interface ScoringSignal {
  weight: number;
  present: boolean;
  label: string;
}

function computeSignals(features: PacketFeatures): ScoringSignal[] {
  const signals: ScoringSignal[] = [];

  // Required sections present
  for (const section of REQUIRED_SECTIONS) {
    signals.push({
      weight: 0.15,
      present: features.section_lengths[section] > 0,
      label: `required section '${section}' present`,
    });
  }

  // Important sections present
  for (const section of IMPORTANT_SECTIONS) {
    signals.push({
      weight: 0.05,
      present: features.section_lengths[section] > 0,
      label: `section '${section}' present`,
    });
  }

  // Objective length
  signals.push({
    weight: 0.1,
    present: features.section_lengths.objective >= MIN_OBJECTIVE_LENGTH,
    label: 'objective section has sufficient detail',
  });

  // Total content length
  signals.push({
    weight: 0.05,
    present: features.total_chars >= MIN_TOTAL_CHARS,
    label: 'packet has sufficient total content',
  });

  // Key files declared
  signals.push({
    weight: 0.1,
    present: features.file_count >= MIN_FILE_COUNT,
    label: 'key files are declared',
  });

  // Requirement tags
  signals.push({
    weight: 0.05,
    present: features.req_tag_count >= MIN_REQ_TAGS,
    label: 'requirement tags [REQ-*] present',
  });

  // Low vagueness
  const vagueRate = features.total_chars > 0
    ? features.vague_phrase_count / features.total_chars
    : 1;
  signals.push({
    weight: 0.05,
    present: vagueRate <= MAX_VAGUE_PHRASE_RATE,
    label: 'low vague-phrase density',
  });

  return signals;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function scoreTaskPacket(features: PacketFeatures): TaskScorerResult {
  const signals = computeSignals(features);

  let readinessScore = 0;
  let maxScore = 0;
  const missing: string[] = [];

  for (const signal of signals) {
    maxScore += signal.weight;
    if (signal.present) {
      readinessScore += signal.weight;
    } else {
      missing.push(signal.label);
    }
  }

  const normalizedScore = maxScore > 0 ? readinessScore / maxScore : 0;

  // Determine decision based on score thresholds
  let decision: TaskScorerDecision;
  if (normalizedScore >= 0.7) {
    decision = 'run';
  } else if (normalizedScore >= 0.5) {
    decision = 'expand';
  } else if (normalizedScore >= 0.3) {
    decision = 'split';
  } else {
    decision = 'return';
  }

  // Difficulty adjustment: harder tasks get more benefit-of-the-doubt
  // (difficulty 1-5 from classifier; higher = more complex)
  if (features.difficulty >= 4 && decision === 'expand') {
    // High-complexity tasks often look sparse but are viable; nudge toward run
    decision = 'run';
  }

  const confidence = clamp01(normalizedScore);

  const explanation = decision === 'run'
    ? `Packet is ready: ${signals.filter(s => s.present).length}/${signals.length} quality signals met.`
    : `Packet needs work: missing ${missing.slice(0, 3).join('; ')}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ''}.`;

  return {
    decision,
    confidence,
    explanation,
    model_version: MODEL_VERSION,
  };
}
