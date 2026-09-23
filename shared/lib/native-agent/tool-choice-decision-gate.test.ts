import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  KILL_CONDITION,
  decideToolChoice,
  formatDecision,
} from './tool-choice-decision-gate.ts';
import type { AnalysisResult } from './tool-choice-signal-stats.ts';
import type { QualityGateReport } from './tool-choice-quality-gate.ts';

function baseQuality(overrides: Partial<QualityGateReport> = {}): QualityGateReport {
  return {
    thresholds: {
      minJoinedTracesPerCell: 30,
      minMenuPresenceFraction: 0.8,
      minExactPropensityRows: 1,
      minTotalDecisions: 100,
      minDistinctTraces: 20,
    },
    coverage: {
      totalDecisions: 0,
      distinctTraces: 0,
      distinctSessions: 0,
      perPhase: {},
      perModel: {},
      perProvider: {},
      perIssue: {},
      perKind: {},
      rowsWithTerminalResult: 0,
      rowsWithSkippedResult: 0,
    },
    menu: {
      rowsWithMenu: 0,
      rowsWithoutMenuNonTerminal: 0,
      menuPresenceFraction: 0,
      distinctMenuDigests: 0,
      perTurnDigestConsistent: true,
    },
    outcome: {
      joined: 0,
      unjoinable: 0,
      pending: 0,
      reasons: {},
      joinedTraceIds: [],
    },
    propensity: { exact: 0, provider_reported: 0, surrogate: 0, unavailable: 0 },
    hygiene: {
      path: 'x',
      totalRows: 0,
      malformedRows: { count: 0, examples: [] },
      duplicateDecisionIds: { count: 0, examples: [] },
      missingLogicalMenu: { count: 0, examples: [] },
      missingProviderMenu: { count: 0, examples: [] },
      unknownModel: { count: 0, examples: [] },
      unknownTool: { count: 0, examples: [] },
      unavailablePropensity: { count: 0, examples: [] },
      missingOutcome: { count: 0, examples: [] },
      unjoinableOutcome: { count: 0, examples: [] },
      rowsWithAnyIssue: { count: 0, examples: [] },
    },
    checks: {
      totalDecisionsPass: false,
      distinctTracesPass: false,
      menuPresencePass: false,
      offPolicyEligible: false,
      outcomeJoinsAdequate: false,
    },
    observationalGatePass: false,
    offPolicyGatePass: false,
    notes: [],
    ...overrides,
  };
}

function baseAnalysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    stratified: { cells: [], contrasts: [], minCellSize: 30 },
    offPolicy: {
      ips: { eligibleRows: 0, refused: true, reason: 'no_exact_propensity_rows', basis: 'mixed' },
      targetTool: '',
    },
    covariateNotes: { modelCount: 0, phaseCount: 0, toolCount: 0, n: 0, tracesJoined: 0 },
    ...overrides,
  };
}

describe('decideToolChoice', () => {
  it('inconclusive when quality gate fails, with computed additional-capture guidance', () => {
    const dec = decideToolChoice({ quality: baseQuality(), analysis: baseAnalysis() });
    assert.equal(dec.decision, 'inconclusive');
    assert.ok(dec.minimumAdditionalCapture);
    assert.ok(dec.minimumAdditionalCapture!.additionalJoinedTraces >= 30);
    assert.ok(dec.minimumAdditionalCapture!.guidance.length > 0);
  });

  it('no-go when quality passes but every contrast is null', () => {
    const dec = decideToolChoice({
      quality: baseQuality({
        observationalGatePass: true,
        checks: {
          totalDecisionsPass: true,
          distinctTracesPass: true,
          menuPresencePass: true,
          offPolicyEligible: false,
          outcomeJoinsAdequate: true,
        },
      }),
      analysis: baseAnalysis(),
    });
    assert.equal(dec.decision, 'no-go');
  });

  it('inconclusive when quality passes but sensitivity destroys the signal', () => {
    const dec = decideToolChoice({
      quality: baseQuality({ observationalGatePass: true, checks: {
        totalDecisionsPass: true,
        distinctTracesPass: true,
        menuPresencePass: true,
        offPolicyEligible: false,
        outcomeJoinsAdequate: true,
      } }),
      analysis: baseAnalysis({
        stratified: {
          cells: [],
          contrasts: [
            {
              label: 'coding|m|menu|e0',
              treatmentKey: 'read',
              controlKey: 'edit',
              treatment: { key: 'read', n: 50, successes: 40, successRate: 0.8, ci95: [0.7, 0.9] },
              control: { key: 'edit', n: 50, successes: 30, successRate: 0.6, ci95: [0.5, 0.7] },
              diff: 0.2,
              diffCi95: [0.05, 0.35],
              significant: true,
            },
          ],
          minCellSize: 30,
        },
        sensitivity: {
          perModel: [{ leftOut: 'm', contrastMean: 0, sig: 0 }],
          perIssue: [{ leftOut: 'HOK-1', contrastMean: 0, sig: 0 }],
        },
      }),
    });
    assert.equal(dec.decision, 'inconclusive');
  });

  it('go when signal survives sensitivity and off-policy is eligible', () => {
    const dec = decideToolChoice({
      quality: baseQuality({
        observationalGatePass: true,
        offPolicyGatePass: true,
        checks: {
          totalDecisionsPass: true,
          distinctTracesPass: true,
          menuPresencePass: true,
          offPolicyEligible: true,
          outcomeJoinsAdequate: true,
        },
      }),
      analysis: baseAnalysis({
        stratified: {
          cells: [],
          contrasts: [
            {
              label: 'coding|m|menu|e0',
              treatmentKey: 'read',
              controlKey: 'edit',
              treatment: { key: 'read', n: 50, successes: 40, successRate: 0.8, ci95: [0.7, 0.9] },
              control: { key: 'edit', n: 50, successes: 30, successRate: 0.6, ci95: [0.5, 0.7] },
              diff: 0.2,
              diffCi95: [0.05, 0.35],
              significant: true,
            },
          ],
          minCellSize: 30,
        },
        sensitivity: {
          perModel: [{ leftOut: 'm', contrastMean: 0.2, sig: 1 }],
          perIssue: [{ leftOut: 'HOK-1', contrastMean: 0.2, sig: 1 }],
        },
      }),
    });
    assert.equal(dec.decision, 'go');
    assert.equal(dec.minimumAdditionalCapture, undefined);
  });

  it('records operator override alongside the computed decision', () => {
    const dec = decideToolChoice({
      quality: baseQuality(),
      analysis: baseAnalysis(),
      operatorOverride: { decision: 'no-go', reason: 'reviewed 2026-09-23; killing early' },
    });
    assert.equal(dec.decision, 'no-go');
    assert.equal(dec.computed, 'inconclusive');
    assert.equal(dec.operatorOverride?.decision, 'no-go');
  });

  it('always attaches the kill condition and formats a human-readable summary', () => {
    const dec = decideToolChoice({ quality: baseQuality(), analysis: baseAnalysis() });
    assert.equal(dec.killCondition, KILL_CONDITION);
    const printed = formatDecision(dec);
    assert.match(printed, /Decision: Inconclusive/);
    assert.match(printed, /Kill condition/);
  });
});
