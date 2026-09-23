/**
 * Unit tests for the tool-choice signal analyzer (HOK-2080).
 *
 * Fixtures are built programmatically (small local makeRow/makeEval helpers
 * plus session-level planted-signal builders) so the tests never depend on a
 * real corpus file. Gate thresholds are overridden on small fixtures; the
 * production thresholds themselves are asserted verbatim.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  TOOL_CHOICE_GATES,
  analyzeSignal,
  computeMinimumCapture,
  createSeededRandom,
  deriveRecommendation,
  generateReport,
  joinOutcomes,
  loadCorpusTolerant,
  loadEvalOutcomes,
  parseDecisionSessionId,
  validateDataQuality,
} from './tool-choice-analyzer.ts';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let counter = 0;

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  counter += 1;
  const menuTools = ['ReadFile', 'SearchText'];
  const base: Record<string, unknown> = {
    schemaVersion: '1',
    decisionId: `d-${counter}`,
    sessionId: 'run-1-coding-HOK-100',
    traceId: 'trace-1',
    phase: 'coding',
    turnIndex: 0,
    stepIndex: 0,
    sourceEventIds: ['e1'],
    provider: 'anthropic',
    model: 'model-a',
    runtime: 'native',
    toolMenu: { digest: 'menu-a', toolNames: menuTools },
    availableTools: menuTools,
    kind: 'tool_call',
    chosenTool: 'ReadFile',
    state: {
      priorToolCallCount: 0,
      priorErrorFlag: false,
      priorErrorCount: 0,
      priorPolicyDenials: 0,
      terminalSynthesis: false,
    },
    propensity: { provenance: 'surrogate', alternatives: ['SearchText'] },
    timestamp: 1_759_000_000_000 + counter * 1_000,
    causalEventIds: ['e1'],
  };
  return { ...base, ...overrides };
}

function makeEval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  counter += 1;
  const base: Record<string, unknown> = {
    id: `eval-${counter}`,
    schemaVersion: '1.47.0',
    modelId: 'model-a',
    score: 0.9,
    interventionRequired: false,
    interventionCount: 0,
    issueId: 'HOK-100',
    challengeSide: 'primary',
    taskContext: { taskType: 'bugfix', changeKind: 'modify', complexity: 0.5 },
    timestamp: '2026-09-20T10:00:00.000Z',
  };
  return { ...base, ...overrides };
}

function writeFixture(name: string, lines: Array<Record<string, unknown> | string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tool-choice-analyzer-'));
  const path = join(dir, name);
  const content =
    lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n';
  writeFileSync(path, content);
  return path;
}

function corpusFrom(rows: Array<Record<string, unknown> | string>): string {
  return writeFixture('corpus.jsonl', rows);
}

function evalsFrom(records: Array<Record<string, unknown> | string>): string {
  return writeFixture('evals.jsonl', records);
}

interface SessionSpec {
  model: string;
  issue: string;
  tool: 'ReadFile' | 'SearchText';
  score: number;
  provenance: 'exact' | 'surrogate';
}

function rowsFromSessions(
  sessions: SessionSpec[],
  rowsPerSession = 4,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  sessions.forEach((session, sessionIndex) => {
    for (let i = 0; i < rowsPerSession; i += 1) {
      const timestamp =
        1_759_000_000_000 + ((sessionIndex * 7) % sessions.length) * 60_000 + i * 1_000;
      const other = session.tool === 'ReadFile' ? 'SearchText' : 'ReadFile';
      rows.push(
        makeRow({
          sessionId: `run-${sessionIndex}-coding-${session.issue}`,
          model: session.model,
          chosenTool: session.tool,
          timestamp,
          propensity:
            session.provenance === 'exact'
              ? { provenance: 'exact', distribution: { ReadFile: 0.5, SearchText: 0.5 } }
              : { provenance: 'surrogate', alternatives: [other] },
        }),
      );
    }
  });
  return rows;
}

function evalsFromSessions(sessions: SessionSpec[]): Array<Record<string, unknown>> {
  return sessions.map((session, index) =>
    makeEval({
      issueId: session.issue,
      modelId: session.model,
      score: session.score,
      timestamp: `2026-09-20T10:00:${String(index % 60).padStart(2, '0')}.000Z`,
    }),
  );
}

/**
 * Heterogeneous planted signal: the ReadFile→success / SearchText→failure
 * effect exists for model-a only; model-b shows no effect.
 */
function heterogeneousPlantedSessions(): SessionSpec[] {
  const sessions: SessionSpec[] = [];
  const modelA: Array<[string, 'ReadFile' | 'SearchText', number]> = [
    ['HOK-200', 'SearchText', 0.4],
    ['HOK-201', 'SearchText', 0.4],
    ['HOK-202', 'SearchText', 0.9],
    ['HOK-203', 'SearchText', 0.4],
    ['HOK-204', 'SearchText', 0.4],
    ['HOK-205', 'ReadFile', 0.9],
    ['HOK-206', 'ReadFile', 0.9],
    ['HOK-207', 'ReadFile', 0.9],
    ['HOK-208', 'ReadFile', 0.9],
    ['HOK-209', 'ReadFile', 0.4],
  ];
  modelA.forEach(([issue, tool, score], index) => {
    sessions.push({
      model: 'model-a',
      issue,
      tool,
      score,
      provenance: index % 2 === 0 ? 'exact' : 'surrogate',
    });
  });
  const modelB: Array<[string, 'ReadFile' | 'SearchText', 'exact' | 'surrogate']> = [
    ['HOK-210', 'SearchText', 'exact'],
    ['HOK-211', 'SearchText', 'exact'],
    ['HOK-212', 'ReadFile', 'exact'],
    ['HOK-213', 'ReadFile', 'exact'],
    ['HOK-214', 'SearchText', 'exact'],
    ['HOK-215', 'SearchText', 'surrogate'],
    ['HOK-216', 'SearchText', 'surrogate'],
    ['HOK-217', 'ReadFile', 'surrogate'],
    ['HOK-218', 'ReadFile', 'surrogate'],
    ['HOK-219', 'ReadFile', 'surrogate'],
  ];
  for (const [issue, tool, provenance] of modelB) {
    sessions.push({ model: 'model-b', issue, tool, score: 0.9, provenance });
  }
  const modelC: Array<[string, 'ReadFile' | 'SearchText', 'exact' | 'surrogate']> = [
    ['HOK-220', 'SearchText', 'exact'],
    ['HOK-221', 'SearchText', 'exact'],
    ['HOK-222', 'ReadFile', 'exact'],
    ['HOK-223', 'ReadFile', 'exact'],
    ['HOK-224', 'SearchText', 'exact'],
    ['HOK-225', 'SearchText', 'surrogate'],
    ['HOK-226', 'SearchText', 'surrogate'],
    ['HOK-227', 'ReadFile', 'surrogate'],
    ['HOK-228', 'ReadFile', 'surrogate'],
    ['HOK-229', 'ReadFile', 'surrogate'],
  ];
  for (const [issue, tool, provenance] of modelC) {
    sessions.push({ model: 'model-c', issue, tool, score: 0.9, provenance });
  }
  return sessions;
}

/** Homogeneous planted signal across three models (drives the Go path). */
function homogeneousPlantedSessions(): SessionSpec[] {
  const sessions: SessionSpec[] = [];
  const tools: Array<'ReadFile' | 'SearchText'> = [
    'SearchText',
    'SearchText',
    'SearchText',
    'ReadFile',
    'ReadFile',
    'ReadFile',
    'SearchText',
    'ReadFile',
  ];
  for (const model of ['model-a', 'model-b', 'model-c']) {
    tools.forEach((tool, index) => {
      const noisyFailure =
        (tool === 'SearchText' && index === 6) || (tool === 'ReadFile' && index === 7);
      const noisySuccess =
        (tool === 'SearchText' && index === 2) || (tool === 'ReadFile' && index === 3);
      sessions.push({
        model,
        issue: `HOK-3${model.slice(-1)}${index}`,
        tool,
        score: noisySuccess ? 0.9 : noisyFailure ? 0.4 : tool === 'ReadFile' ? 0.9 : 0.4,
        provenance: 'exact',
      });
    });
  }
  return sessions;
}

/** Pure-noise fixture: outcomes uncorrelated with tool choice. */
function noiseSessions(): SessionSpec[] {
  const sessions: SessionSpec[] = [];
  for (const model of ['model-a', 'model-b', 'model-c']) {
    for (let index = 0; index < 8; index += 1) {
      const globalIndex = sessions.length;
      sessions.push({
        model,
        issue: `HOK-4${globalIndex}`,
        tool: globalIndex % 2 === 0 ? 'SearchText' : 'ReadFile',
        score: globalIndex % 4 < 2 ? 0.9 : 0.4,
        provenance: 'exact',
      });
    }
  }
  return sessions;
}

const FIXTURE_GATES = {
  minCodingToolRows: 50,
  minJoinedModels: 3,
  minJoinedSessions: 5,
  minTierJoinedRows: 10,
  bootstrapMinRows: 10,
  smallCellFloor: 5,
} as const;

const FIXTURE_ANALYZE_OPTIONS = {
  gates: FIXTURE_GATES,
  minStratumRows: 10,
  holdoutMinRows: 10,
  bootstrapReplicates: 25,
  seed: 1234,
};

interface PipelineResult {
  load: ReturnType<typeof loadCorpusTolerant>;
  evalIndex: ReturnType<typeof loadEvalOutcomes>;
  join: ReturnType<typeof joinOutcomes>;
  quality: ReturnType<typeof validateDataQuality>;
  analysis: ReturnType<typeof analyzeSignal>;
  recommendation: ReturnType<typeof deriveRecommendation>;
}

function runPipeline(
  corpusPath: string,
  evalsPath: string,
  options: {
    qualityGates?: Partial<typeof TOOL_CHOICE_GATES>;
    analyzeOptions?: Parameters<typeof analyzeSignal>[2];
  } = {},
): PipelineResult {
  const load = loadCorpusTolerant(corpusPath);
  const evalIndex = loadEvalOutcomes(evalsPath);
  const join = joinOutcomes(load, evalIndex);
  const quality = validateDataQuality(load, join, {
    evalIndex,
    ...(options.qualityGates ? { gates: options.qualityGates } : {}),
  });
  const analysis = analyzeSignal(join, quality, options.analyzeOptions ?? {});
  const recommendation = deriveRecommendation(quality, analysis);
  return { load, evalIndex, join, quality, analysis, recommendation };
}

function plantedPipeline(
  sessions: SessionSpec[],
  rowsPerSession = 4,
): PipelineResult {
  const corpusPath = corpusFrom(rowsFromSessions(sessions, rowsPerSession));
  const evalsPath = evalsFrom(evalsFromSessions(sessions));
  return runPipeline(corpusPath, evalsPath, {
    qualityGates: FIXTURE_GATES,
    analyzeOptions: FIXTURE_ANALYZE_OPTIONS,
  });
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

describe('loadCorpusTolerant', () => {
  it('loads a good corpus file', () => {
    const rows = Array.from({ length: 10 }, () => makeRow());
    const load = loadCorpusTolerant(corpusFrom(rows));
    assert.equal(load.fileMissing, false);
    assert.equal(load.rows.length, 10);
    assert.equal(load.entries.length, 10);
    assert.equal(load.malformed.length, 0);
    assert.equal(load.duplicates.length, 0);
  });

  it('counts malformed lines with line numbers and recovers joinable invalid rows', () => {
    const good = makeRow();
    const missingModel = makeRow();
    delete missingModel.model;
    const another = makeRow();
    const load = loadCorpusTolerant(
      corpusFrom([good, '{not json', missingModel, another]),
    );
    assert.equal(load.rows.length, 2);
    assert.equal(load.invalidRows.length, 1);
    assert.equal(load.malformed.length, 2);
    assert.deepEqual(
      load.malformed.map((issue) => [issue.lineNumber, issue.reason]),
      [
        [2, 'malformed_json'],
        [3, 'missing_field:model'],
      ],
    );
    // The schema-invalid row still participates in join accounting.
    assert.equal(load.entries.length, 3);
  });

  it('reports a missing file without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-choice-analyzer-'));
    const load = loadCorpusTolerant(join(dir, 'absent.jsonl'));
    assert.equal(load.fileMissing, true);
    assert.equal(load.rows.length, 0);
    assert.equal(load.entries.length, 0);
  });

  it('detects duplicate decisionIds and keeps the first occurrence', () => {
    const row = makeRow();
    const load = loadCorpusTolerant(corpusFrom([row, { ...row }, makeRow()]));
    assert.equal(load.rows.length, 2);
    assert.equal(load.duplicates.length, 1);
    assert.equal(load.duplicates[0].decisionId, row.decisionId);
    assert.equal(load.duplicates[0].lineNumber, 2);
  });
});

// ---------------------------------------------------------------------------
// Session-id parsing
// ---------------------------------------------------------------------------

describe('parseDecisionSessionId', () => {
  it('parses coding and planning sessions with the primary side', () => {
    assert.deepEqual(parseDecisionSessionId('run-1-coding-HOK-100'), {
      ok: true,
      phase: 'coding',
      issue: 'HOK-100',
      side: 'primary',
    });
    assert.deepEqual(parseDecisionSessionId('run-1-planning-HOK-100'), {
      ok: true,
      phase: 'planning',
      issue: 'HOK-100',
      side: 'primary',
    });
  });

  it('maps a trailing _c issue slot to the challenger side', () => {
    const parse = parseDecisionSessionId('run-1-coding-HOK-100_c');
    assert.equal(parse.ok, true);
    assert.equal(parse.issue, 'HOK-100');
    assert.equal(parse.side, 'challenger');
  });

  it('treats review sessions as branch-keyed (unjoinable by construction)', () => {
    const parse = parseDecisionSessionId('run-1-review-task-some-branch');
    assert.equal(parse.ok, true);
    assert.equal(parse.phase, 'review');
    assert.equal(parse.issue, undefined);
  });

  it('rejects unrecognized session ids', () => {
    const parse = parseDecisionSessionId('expansion-wavemill');
    assert.equal(parse.ok, false);
    assert.equal(parse.reason, 'unrecognized_session_id');
  });
});

// ---------------------------------------------------------------------------
// Eval outcome index + join
// ---------------------------------------------------------------------------

describe('loadEvalOutcomes', () => {
  it('normalizes literal _c issueIds to the challenger side', () => {
    const index = loadEvalOutcomes(
      evalsFrom([
        makeEval({ issueId: 'HOK-100_c', challengeSide: undefined }),
        makeEval({ issueId: 'HOK-101_c', challengeSide: 'challenger' }),
        makeEval({ issueId: 'HOK-102_c', challengeSide: 'primary' }),
        makeEval({ issueId: 'HOK-103', challengeSide: 'primary' }),
      ]),
    );
    assert.equal(index.records.length, 4);
    // Three issueIds literally carried the `_c` suffix.
    assert.equal(index.literalSuffixNormalizations, 3);
    assert.deepEqual(
      index.records.map((record) => [record.normalizedIssue, record.challengeSide]),
      [
        // Side derived from the suffix when challengeSide is absent.
        ['HOK-100', 'challenger'],
        // Explicit side agrees with the suffix.
        ['HOK-101', 'challenger'],
        // An explicit challengeSide wins over the literal suffix.
        ['HOK-102', 'primary'],
        ['HOK-103', 'primary'],
      ],
    );
    assert.equal(index.records[0].sideFromIssueSuffix, true);
    assert.equal(index.records[1].sideFromIssueSuffix, false);
  });

  it('counts malformed lines and rows without issueId', () => {
    const index = loadEvalOutcomes(
      evalsFrom(['{bad json', makeEval(), { id: 'no-issue', score: 1 }]),
    );
    assert.equal(index.malformed, 1);
    assert.equal(index.withoutIssueId, 1);
    assert.equal(index.records.length, 1);
  });

  it('reports a missing evals file without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-choice-analyzer-'));
    const index = loadEvalOutcomes(join(dir, 'absent-evals.jsonl'));
    assert.equal(index.fileMissing, true);
    assert.equal(index.records.length, 0);
  });
});

describe('joinOutcomes', () => {
  it('joins a coding row by issue, side, and model with the pre-registered outcome', () => {
    const load = loadCorpusTolerant(corpusFrom([makeRow()]));
    const index = loadEvalOutcomes(evalsFrom([makeEval()]));
    const join = joinOutcomes(load, index);
    assert.equal(join.decisions.length, 1);
    const decision = join.decisions[0];
    assert.equal(decision.joinStatus, 'joined');
    assert.equal(decision.issue, 'HOK-100');
    assert.equal(decision.challengeSide, 'primary');
    assert.equal(decision.modelMatched, true);
    assert.equal(decision.success, true);
    assert.equal(decision.taskType, 'bugfix');
    assert.equal(join.diagnostics.joinedPct, 100);
  });

  it('marks scores below the threshold as failure and honors explicit outcomes.success', () => {
    const rows = [makeRow(), makeRow({ sessionId: 'run-1-coding-HOK-101' })];
    const index = loadEvalOutcomes(
      evalsFrom([
        makeEval({ score: 0.5 }),
        makeEval({ issueId: 'HOK-101', score: 0.1, outcomes: { success: true } }),
      ]),
    );
    const join = joinOutcomes(loadCorpusTolerant(corpusFrom(rows)), index);
    assert.equal(join.decisions[0].success, false);
    assert.equal(join.decisions[1].success, true);
  });

  it('prefers the latest matching eval record by timestamp', () => {
    const index = loadEvalOutcomes(
      evalsFrom([
        makeEval({ id: 'older', timestamp: '2026-09-01T00:00:00.000Z', score: 0.2 }),
        makeEval({ id: 'newer', timestamp: '2026-09-10T00:00:00.000Z', score: 0.95 }),
      ]),
    );
    const join = joinOutcomes(loadCorpusTolerant(corpusFrom([makeRow()])), index);
    assert.equal(join.decisions[0].evalRecord?.id, 'newer');
    assert.equal(join.decisions[0].success, true);
  });

  it('joins a single candidate even when the model differs, and flags the mismatch', () => {
    const index = loadEvalOutcomes(evalsFrom([makeEval({ modelId: 'other-model' })]));
    const join = joinOutcomes(loadCorpusTolerant(corpusFrom([makeRow()])), index);
    assert.equal(join.decisions[0].joinStatus, 'joined');
    assert.equal(join.decisions[0].modelMatched, false);
    assert.equal(join.diagnostics.modelMismatched, 1);
  });

  it('matches models ignoring the provider prefix', () => {
    const index = loadEvalOutcomes(evalsFrom([makeEval({ modelId: 'model-a' })]));
    const join = joinOutcomes(
      loadCorpusTolerant(corpusFrom([makeRow({ model: 'anthropic/model-a' })])),
      index,
    );
    assert.equal(join.decisions[0].modelMatched, true);
  });

  it('reports ambiguity when several evals match the key but none the model', () => {
    const index = loadEvalOutcomes(
      evalsFrom([
        makeEval({ id: 'e1', modelId: 'other-model' }),
        makeEval({ id: 'e2', modelId: 'third-model' }),
      ]),
    );
    const join = joinOutcomes(loadCorpusTolerant(corpusFrom([makeRow()])), index);
    assert.equal(join.decisions[0].joinStatus, 'unjoinable_ambiguous');
    assert.equal(join.diagnostics.ambiguous, 1);
  });

  it('counts missing evals, review sessions, and unrecognized session ids separately', () => {
    const rows = [
      makeRow({ sessionId: 'run-1-coding-HOK-999' }),
      makeRow({ sessionId: 'run-1-review-task-branch' }),
      makeRow({ sessionId: 'expansion-wavemill' }),
      makeRow(),
    ];
    const index = loadEvalOutcomes(evalsFrom([makeEval()]));
    const join = joinOutcomes(loadCorpusTolerant(corpusFrom(rows)), index);
    assert.equal(join.decisions[0].joinStatus, 'unjoinable_missing_eval');
    assert.equal(join.decisions[1].joinStatus, 'unjoinable_by_construction');
    assert.equal(
      join.decisions[1].joinReason,
      'review_session_branch_keyed',
    );
    assert.equal(join.decisions[2].joinStatus, 'unjoinable_by_construction');
    assert.equal(join.decisions[3].joinStatus, 'joined');
    assert.equal(join.diagnostics.missingEval, 1);
    assert.equal(join.diagnostics.byConstruction, 2);
    assert.equal(join.diagnostics.reviewSessions, 1);
    assert.equal(join.diagnostics.unparsedSessionIds, 1);
    assert.equal(join.diagnostics.joinedPct, 25);
  });

  it('joins challenger rows to challenger evals across _c normalization', () => {
    const rows = [makeRow({ sessionId: 'run-1-coding-HOK-100_c' })];
    const index = loadEvalOutcomes(
      evalsFrom([makeEval({ issueId: 'HOK-100', challengeSide: 'challenger' })]),
    );
    const join = joinOutcomes(loadCorpusTolerant(corpusFrom(rows)), index);
    assert.equal(join.decisions[0].joinStatus, 'joined');
    assert.equal(join.decisions[0].challengeSide, 'challenger');
  });
});

// ---------------------------------------------------------------------------
// Data quality (REQ-F1)
// ---------------------------------------------------------------------------

describe('validateDataQuality', () => {
  it('reports 100% schema adherence and 100% join rate on the good fixture', () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      makeRow({ turnIndex: index }),
    );
    const corpusPath = corpusFrom(rows);
    const evalsPath = evalsFrom([makeEval()]);
    const { quality } = runPipeline(corpusPath, evalsPath);
    assert.equal(quality.schemaAdherencePct, 100);
    assert.equal(quality.join.joinedPct, 100);
    assert.equal(quality.malformed.count, 0);
    assert.equal(quality.codingCohort.toolRows, 10);
    assert.equal(quality.codingCohort.joinedToolRows, 10);
    assert.equal(quality.codingCohort.perTierJoined.surrogate, 10);
  });

  it('reports 80% adherence and 70% join rate on the packet bad fixture', () => {
    const missingModel1 = makeRow();
    delete missingModel1.model;
    const missingModel2 = makeRow();
    delete missingModel2.model;
    const rows = [
      missingModel1,
      missingModel2,
      makeRow(),
      makeRow(),
      makeRow(),
      makeRow(),
      makeRow(),
      makeRow({ sessionId: 'run-2-coding-HOK-999' }),
      makeRow({ sessionId: 'run-3-review-task-x' }),
      makeRow({ sessionId: 'expansion-wavemill' }),
    ];
    const corpusPath = corpusFrom(rows);
    const evalsPath = evalsFrom([makeEval()]);
    const { quality } = runPipeline(corpusPath, evalsPath);
    // 8 of 10 lines are schema-valid → 80% adherence.
    assert.equal(quality.schemaAdherencePct, 80);
    assert.equal(quality.validRows, 8);
    assert.equal(quality.invalidRows, 2);
    // 7 of 10 records join an eval outcome → 70% join rate.
    assert.equal(quality.join.joinedPct, 70);
    assert.equal(quality.join.joined, 7);
    assert.equal(quality.join.missingEval, 1);
    assert.equal(quality.join.byConstruction, 2);
    // Failure reasons are listed with line numbers.
    assert.ok(quality.malformed.examples.length > 0);
    assert.ok(quality.malformed.examples.every((issue) => issue.lineNumber > 0));
    assert.ok(quality.join.examples.missingEval.length > 0);
    assert.ok(quality.join.examples.byConstruction.length > 0);
  });

  it('reports confounder coverage including never-filled budget fields', () => {
    const rows = [makeRow(), makeRow()];
    const corpusPath = corpusFrom(rows);
    const evalsPath = evalsFrom([makeEval()]);
    const { quality } = runPipeline(corpusPath, evalsPath);
    assert.equal(quality.confounderCoverage.model?.pct, 100);
    assert.equal(quality.confounderCoverage.menu_digest?.pct, 100);
    assert.equal(quality.confounderCoverage.turn_budget_remaining?.pct, 0);
    assert.equal(quality.confounderCoverage.tool_call_budget_remaining?.pct, 0);
    assert.equal(quality.confounderCoverage.task_class_via_eval_join?.pct, 100);
    assert.equal(quality.outcomeFieldFilled, 0);
    assert.equal(quality.menuIntegrity.mirrorConsistencyPct, 100);
  });

  it('fails all gates on an absent corpus', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-choice-analyzer-'));
    const { quality, analysis, recommendation } = runPipeline(
      join(dir, 'absent.jsonl'),
      evalsFrom([makeEval()]),
    );
    assert.equal(quality.corpusFileMissing, true);
    assert.equal(quality.coverageGatesPassed, false);
    assert.ok(quality.gates.every((gate) => !gate.passed));
    assert.equal(
      quality.gates.find((gate) => gate.id === 'G1')?.shortfall,
      '500 more coding-stage tool-call rows',
    );
    // Estimation is suppressed and the recommendation is inconclusive.
    assert.equal(analysis.skipped, true);
    assert.match(analysis.skipReason ?? '', /G1/);
    assert.equal(analysis.tiers.length, 0);
    assert.equal(recommendation.decision, 'inconclusive');
  });

  it('quantifies the G1 shortfall from observed rows (120 rows → 380 more needed)', () => {
    const models = ['model-a', 'model-b', 'model-c'];
    const sessions: SessionSpec[] = [];
    for (let index = 0; index < 20; index += 1) {
      sessions.push({
        model: models[index % models.length],
        issue: `HOK-7${index}`,
        tool: 'ReadFile',
        score: 0.9,
        provenance: 'surrogate',
      });
    }
    // 20 sessions × 6 rows = 120 coding tool rows over 3 models, all joined.
    const rows: Array<Record<string, unknown>> = [];
    sessions.forEach((session, sessionIndex) => {
      for (let row = 0; row < 6; row += 1) {
        rows.push(
          makeRow({
            sessionId: `run-${sessionIndex}-coding-${session.issue}`,
            model: session.model,
          }),
        );
      }
    });
    const corpusPath = corpusFrom(rows);
    const evalsPath = evalsFrom(
      sessions.map((session, index) =>
        makeEval({
          issueId: session.issue,
          modelId: session.model,
          timestamp: `2026-09-20T10:01:${String(index % 60).padStart(2, '0')}.000Z`,
        }),
      ),
    );
    const { quality, recommendation } = runPipeline(corpusPath, evalsPath);
    assert.equal(quality.codingCohort.toolRows, 120);
    const g1 = quality.gates.find((gate) => gate.id === 'G1');
    assert.equal(g1?.passed, false);
    assert.equal(g1?.shortfall, '380 more coding-stage tool-call rows');
    assert.equal(recommendation.decision, 'inconclusive');
    const capture = recommendation.minimumAdditionalCapture;
    assert.ok(capture);
    assert.equal(capture.codingToolRowsNeeded, 380);
    assert.equal(capture.joinedCodingRowsNeeded, 180);
    assert.equal(capture.modelsNeeded, 0);
    assert.equal(capture.sessionsNeeded, 0);
    assert.equal(capture.exactProvenanceRowsNeeded, 200);
    assert.ok(capture.targets.some((target) => target.includes('380 more')));
    const direct = computeMinimumCapture(quality);
    assert.equal(direct.codingToolRowsNeeded, 380);
  });
});

// ---------------------------------------------------------------------------
// Signal analysis (REQ-F2, REQ-F3)
// ---------------------------------------------------------------------------

describe('analyzeSignal', () => {
  it('suppresses estimation when gates fail and force is not set', () => {
    const corpusPath = corpusFrom([makeRow(), makeRow()]);
    const evalsPath = evalsFrom([makeEval()]);
    const { analysis } = runPipeline(corpusPath, evalsPath);
    assert.equal(analysis.skipped, true);
    assert.equal(analysis.signal.passesAll, false);
    assert.equal(analysis.tiers.length, 0);
  });

  it('localizes a heterogeneous planted effect to model-a and separates tiers', () => {
    const { quality, analysis } = plantedPipeline(heterogeneousPlantedSessions(), 8);
    assert.equal(quality.coverageGatesPassed, true);
    assert.equal(analysis.skipped, false);

    const exact = analysis.tiers.find((tier) => tier.provenance === 'exact');
    const surrogate = analysis.tiers.find((tier) => tier.provenance === 'surrogate');
    assert.ok(exact);
    assert.ok(surrogate);
    assert.ok(exact.rows > 0);
    assert.ok(surrogate.rows > 0);
    // REQ-F3: off-policy estimators exist only on the exact tier.
    assert.ok(exact.offPolicy.length >= 1);
    assert.equal(surrogate.offPolicy.length, 0);
    assert.match(surrogate.offPolicyNote ?? '', /exact-provenance/);

    // The planted effect shows up for model-a but not model-b.
    const modelAContrast = exact.contrasts.find(
      (contrast) => contrast.model === 'model-a' && contrast.tool === 'ReadFile',
    );
    const modelBContrast = exact.contrasts.find(
      (contrast) => contrast.model === 'model-b' && contrast.tool === 'ReadFile',
    );
    assert.ok(modelAContrast);
    assert.ok(modelAContrast.deltaPct !== null && modelAContrast.deltaPct > 50);
    assert.equal(modelAContrast.excludesZero, true);
    assert.ok(modelBContrast);
    assert.equal(modelBContrast.deltaPct, 0);
    assert.equal(modelBContrast.excludesZero, false);

    // The winning adjusted effect is attributed to model-a in the exact tier.
    assert.ok(analysis.signal.bestEffect);
    assert.equal(analysis.signal.bestEffect.tier, 'exact');
    assert.equal(analysis.signal.bestEffect.model, 'model-a');
    assert.equal(analysis.signal.bestEffect.tool, 'ReadFile');
    assert.ok((analysis.signal.bestEffect.coefficient ?? 0) > 0);
    assert.equal(analysis.signal.s1, true);
    assert.equal(analysis.signal.s4, true);
  });

  it('produces finite off-policy estimates on the exact tier', () => {
    const { analysis } = plantedPipeline(heterogeneousPlantedSessions(), 8);
    const exact = analysis.tiers.find((tier) => tier.provenance === 'exact');
    assert.ok(exact);
    const methods = exact.offPolicy.map((estimate) => estimate.method);
    assert.deepEqual(methods, ['ipw', 'aipw']);
    for (const estimate of exact.offPolicy) {
      assert.ok(typeof estimate.valueOfChoice === 'number');
      assert.ok(Number.isFinite(estimate.valueOfChoice));
      assert.ok(typeof estimate.baselineTool === 'string');
      assert.ok(estimate.n > 0);
    }
  });

  it('finds no signal in a pure-noise fixture', () => {
    const { quality, analysis, recommendation } = plantedPipeline(noiseSessions());
    assert.equal(quality.coverageGatesPassed, true);
    assert.equal(analysis.skipped, false);
    assert.equal(analysis.signal.s1, false);
    assert.equal(analysis.signal.passesAll, false);
    // Gates pass, no identifiable effect → No-go.
    assert.equal(recommendation.decision, 'no-go');
    assert.ok(recommendation.rationale.some((line) => line.includes('kill condition')));
  });

  it('recommends Go when gates pass and the homogeneous signal satisfies S1–S4', () => {
    const { quality, analysis, recommendation } = plantedPipeline(
      homogeneousPlantedSessions(),
      4,
    );
    assert.equal(quality.coverageGatesPassed, true);
    assert.equal(analysis.skipped, false);
    assert.equal(analysis.signal.s1, true);
    assert.equal(analysis.signal.s2, true);
    assert.equal(analysis.signal.s3, true);
    assert.equal(analysis.signal.s4, true);
    assert.equal(analysis.signal.passesAll, true);
    assert.equal(recommendation.decision, 'go');
    assert.equal(recommendation.minimumAdditionalCapture, undefined);
  });

  it('is deterministic for a fixed seed', () => {
    const sessions = heterogeneousPlantedSessions();
    const corpusPath = corpusFrom(rowsFromSessions(sessions));
    const evalsPath = evalsFrom(evalsFromSessions(sessions));
    const first = runPipeline(corpusPath, evalsPath, {
      qualityGates: FIXTURE_GATES,
      analyzeOptions: FIXTURE_ANALYZE_OPTIONS,
    });
    const second = runPipeline(corpusPath, evalsPath, {
      qualityGates: FIXTURE_GATES,
      analyzeOptions: FIXTURE_ANALYZE_OPTIONS,
    });
    assert.equal(
      JSON.stringify(first.analysis),
      JSON.stringify(second.analysis),
    );
    assert.equal(
      JSON.stringify(first.recommendation),
      JSON.stringify(second.recommendation),
    );
  });

  it('seeds the PRNG deterministically', () => {
    const first = createSeededRandom(42);
    const second = createSeededRandom(42);
    const valuesA = [first(), first(), first()];
    const valuesB = [second(), second(), second()];
    assert.deepEqual(valuesA, valuesB);
    assert.ok(valuesA.every((value) => value >= 0 && value < 1));
  });
});

// ---------------------------------------------------------------------------
// Recommendation + report (REQ-F4, REQ-F5)
// ---------------------------------------------------------------------------

describe('generateReport', () => {
  it('renders every required section on the real empty-corpus path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-choice-analyzer-'));
    const corpusPath = join(dir, 'absent.jsonl');
    const evalsPath = evalsFrom([makeEval()]);
    const { load, quality, analysis, recommendation } = runPipeline(corpusPath, evalsPath);
    const report = generateReport({
      load,
      quality,
      analysis,
      recommendation,
      decision: 'inconclusive',
      decisionReason: 'Coverage gate G1 failed: the corpus is empty.',
      evalsPath,
      now: '2026-09-23T00:00:00.000Z',
    });
    for (const section of [
      '# Tool-choice signal analysis (HOK-2080)',
      '## Executive Summary',
      '## Methodology',
      '## Data Quality Appendix',
      '### Corpus integrity',
      '### Confounder coverage',
      '### Propensity provenance histogram',
      '### Outcome join diagnostics',
      '### Coding-stage analysis cohort',
      '### Eval outcome index',
      '## Results',
      '## Uncertainty & Sensitivity',
      '## Minimum additional capture',
      '## Decision',
    ]) {
      assert.ok(report.includes(section), `missing section: ${section}`);
    }
    assert.ok(report.includes('corpus file absent'));
    // The quantified minimum-capture spec appears with the gate numbers.
    assert.ok(report.includes('500'));
    assert.ok(report.includes('200'));
    // Terminal block is byte-exact.
    assert.ok(
      report.endsWith(
        '## Decision\n\nDecision: Inconclusive\n\nCoverage gate G1 failed: the corpus is empty.\n',
      ),
    );
  });

  it('renders tier-separated results and the exact terminal block for a Go decision', () => {
    const { load, quality, analysis, recommendation } = plantedPipeline(
      homogeneousPlantedSessions(),
    );
    const report = generateReport({
      load,
      quality,
      analysis,
      recommendation,
      decision: 'go',
      decisionReason: 'Clear signal found.',
      evalsPath: 'evals.jsonl',
      now: '2026-09-23T00:00:00.000Z',
    });
    assert.ok(report.includes('### Tier: exact'));
    assert.ok(report.includes('### Off-policy estimates (exact-provenance tier only)'));
    assert.ok(report.includes('## Uncertainty & Sensitivity'));
    assert.ok(!report.includes('## Minimum additional capture'));
    assert.ok(
      report.endsWith('## Decision\n\nDecision: Go\n\nClear signal found.\n'),
    );
  });

  it('renders separate sections per propensity tier for REQ-F3', () => {
    const { load, quality, analysis, recommendation } = plantedPipeline(
      heterogeneousPlantedSessions(),
    );
    const report = generateReport({
      load,
      quality,
      analysis,
      recommendation,
      decision: 'inconclusive',
      decisionReason: 'Exploratory fixture report.',
      evalsPath: 'evals.jsonl',
      now: '2026-09-23T00:00:00.000Z',
    });
    assert.ok(report.includes('### Tier: exact'));
    assert.ok(report.includes('### Tier: surrogate'));
    assert.ok(report.includes('### Tier: provider_reported'));
    assert.ok(report.includes('### Tier: unavailable'));
  });

  it('flags divergence when the operator decision contradicts the computed recommendation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-choice-analyzer-'));
    const corpusPath = join(dir, 'absent.jsonl');
    const evalsPath = evalsFrom([makeEval()]);
    const { load, quality, analysis, recommendation } = runPipeline(corpusPath, evalsPath);
    assert.equal(recommendation.decision, 'inconclusive');
    const report = generateReport({
      load,
      quality,
      analysis,
      recommendation,
      decision: 'go',
      decisionReason: 'Operator override.',
      evalsPath,
      now: '2026-09-23T00:00:00.000Z',
    });
    assert.ok(report.includes('diverges from the computed recommendation'));
    assert.ok(report.includes('Divergence note:'));
    assert.ok(report.includes('Decision: Go'));
  });

  it('includes operator context notes in the appendix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-choice-analyzer-'));
    const corpusPath = join(dir, 'absent.jsonl');
    const evalsPath = evalsFrom([makeEval()]);
    const { load, quality, analysis, recommendation } = runPipeline(corpusPath, evalsPath);
    const report = generateReport({
      load,
      quality,
      analysis,
      recommendation,
      decision: 'inconclusive',
      decisionReason: 'Corpus absent.',
      evalsPath,
      now: '2026-09-23T00:00:00.000Z',
      notes: ['Capture live since 2026-09-23 (HOK-2076, 71543dc4).'],
    });
    assert.ok(report.includes('### Operator context notes'));
    assert.ok(report.includes('Capture live since 2026-09-23'));
  });

  it('documents the pre-registered gates and thresholds verbatim', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-choice-analyzer-'));
    const evalsPath = evalsFrom([makeEval()]);
    const { load, quality, analysis, recommendation } = runPipeline(
      join(dir, 'absent.jsonl'),
      evalsPath,
    );
    const report = generateReport({
      load,
      quality,
      analysis,
      recommendation,
      decision: 'inconclusive',
      decisionReason: 'Corpus absent.',
      evalsPath,
      now: '2026-09-23T00:00:00.000Z',
    });
    assert.ok(report.includes(`at least ${TOOL_CHOICE_GATES.minCodingToolRows} schema-valid`));
    assert.ok(
      report.includes(
        `provenance='exact' rows with a filled distribution`,
      ),
    );
    assert.ok(report.includes('- S1:'));
    assert.ok(report.includes('- S4:'));
    assert.ok(report.includes('Kill condition'));
  });
});
