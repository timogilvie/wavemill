/**
 * Tool-decision offline labeler (HOK-2076).
 *
 * Versioned, rerunnable materializer that joins projected decision
 * rows to feature state, stage results, operator interventions,
 * eval records, and delivery/merge outcomes. Produces labeled rows
 * with reversion, survival, and test-failure delta signals.
 *
 * Labels are kept separate from captured rows and versioned for
 * deterministic reruns.
 *
 * @module tool-decision-labeler
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ToolDecisionRow,
  OutcomeLabel,
  LabeledDecisionRow,
  StageOutcome,
  TerminalOutcome,
  SurvivalLabel,
  TestDelta,
  OutcomeJoinConfidence,
} from './tool-decision-schema.ts';
import {
  OUTCOME_LABEL_VERSION,
} from './tool-decision-schema.ts';
import type { FeatureOutcomeReconstruction } from './feature-outcome-consumer.ts';

export const LABELER_NORMALIZATION_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Inputs for labeling
// ---------------------------------------------------------------------------

export interface LabelerInputs {
  featureDir?: string;
  featureOutcome?: FeatureOutcomeReconstruction;
  stageResults?: StageResultInput[];
  interventionCount?: number;
  evalScore?: number;
  testEvidence?: TestEvidenceInput;
}

export interface StageResultInput {
  stageName: string;
  status?: string;
  score?: number;
  costUsd?: number;
}

export interface TestEvidenceInput {
  beforeFailures?: number;
  afterFailures?: number;
}

// ---------------------------------------------------------------------------
// Label materialization
// ---------------------------------------------------------------------------

export function materializeLabels(
  rows: ToolDecisionRow[],
  inputs: LabelerInputs,
): LabeledDecisionRow[] {
  const outcome = inputs.featureOutcome;

  const stageOutcomeMap = new Map<string, StageOutcome>();
  if (inputs.stageResults) {
    for (const sr of inputs.stageResults) {
      stageOutcomeMap.set(sr.stageName, {
        stageName: sr.stageName,
        status: sr.status,
        score: sr.score,
        costUsd: sr.costUsd,
        interventionCount: inputs.interventionCount ?? 0,
      });
    }
  }

  const terminalOutcome: TerminalOutcome | null = outcome
    ? {
        evalScore: outcome.evalScore ?? undefined,
        merged: outcome.merged ?? false,
        reverted: outcome.reverted ?? false,
        ciPassed: outcome.ciPassed ?? undefined,
        reviewPassed: outcome.reviewPassed ?? undefined,
      }
    : null;

  const survivalLabel: SurvivalLabel | null = outcome
    ? {
        reversionDetected: outcome.reverted === true,
        humanUndo: false,
        agentUndo: false,
        eligibleForSurvival: outcome.completed === true && outcome.merged === true,
      }
    : null;

  const testDelta: TestDelta | null = inputs.testEvidence
    ? {
        beforeFailures: inputs.testEvidence.beforeFailures,
        afterFailures: inputs.testEvidence.afterFailures,
        delta:
          inputs.testEvidence.beforeFailures !== undefined &&
          inputs.testEvidence.afterFailures !== undefined
            ? inputs.testEvidence.afterFailures - inputs.testEvidence.beforeFailures
            : undefined,
        comparable:
          inputs.testEvidence.beforeFailures !== undefined &&
          inputs.testEvidence.afterFailures !== undefined,
      }
    : null;

  const joinConfidence: OutcomeJoinConfidence = outcome
    ? 'session_match'
    : 'unavailable';

  return rows.map((decision) => {
    const stageOutcome = stageOutcomeMap.get(decision.phase) ?? null;

    const label: OutcomeLabel = {
      labelVersion: OUTCOME_LABEL_VERSION,
      normalizationVersion: LABELER_NORMALIZATION_VERSION,
      joinConfidence,
      stageOutcome,
      terminalOutcome,
      survivalLabel,
      testDelta,
      localResultStatus: decision.resultStatus,
    };

    return { decision, outcome: label };
  });
}

// ---------------------------------------------------------------------------
// Feature outcome loading helper
// ---------------------------------------------------------------------------

export function loadFeatureOutcomeFromDir(featureDir: string): FeatureOutcomeReconstruction | null {
  const candidates = ['feature-state.json', 'feature-outcome.json'];
  for (const filename of candidates) {
    const path = join(featureDir, filename);
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        return raw.outcome ?? raw;
      } catch {
        continue;
      }
    }
  }
  return null;
}
