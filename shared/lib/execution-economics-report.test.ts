/**
 * Tests for the execution-economics corpus-quality report (HOK-2958).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildExecutionEconomicsReport,
  renderExecutionEconomicsReport,
} from './execution-economics-report.ts';

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 's1',
    rootSessionId: null,
    harnessVersion: '2.1.270',
    triggerSource: { value: 'sdk', provenance: 'claude_code.promptSource', availability: 'available' },
    stageRole: { value: 'coding', confidence: 'timestamp_window', evidence: 'window' },
    models: {
      requested: null,
      forced: null,
      resolved: 'claude-opus-4-6',
      executed: 'claude-opus-4-6',
      provenance: { executed: 'session_telemetry' },
    },
    turnCount: 3,
    turns: [],
    turnsTruncated: false,
    modelSegments: [{ model: 'claude-opus-4-6', turnCount: 3 }],
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null },
    actualCostUsd: null,
    estimatedCostUsd: 0.5,
    costSource: 'local_estimate',
    pricingRevision: null,
    pricingTimestamp: '2026-09-01T10:00:00Z',
    coverage: 'partial',
    fieldAvailability: { actualCost: 'unavailable', reasoningTokens: 'unavailable' },
    diagnostics: [],
    ...overrides,
  };
}

function makeEvalLine(id: string, economics: unknown[]): string {
  return JSON.stringify({
    id,
    schemaVersion: '1.47.0',
    originalPrompt: 'p',
    modelId: 'claude-opus-4-6',
    modelVersion: 'claude-opus-4-6',
    score: 1,
    scoreBand: 'Full Success',
    timeSeconds: 1,
    timestamp: '2026-09-01T10:00:00Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'ok',
    ...(economics.length > 0 ? { executionEconomics: economics } : {}),
  });
}

function makeBlock(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0.0',
    providerContractVersion: 'claude-code/1',
    harness: 'claude-code',
    joinEvidence: { issueId: 'HOK-1', branch: 'task/a' },
    sessions: [makeSession()],
    sessionCount: 1,
    turnCount: 3,
    coverage: 'partial',
    collectedAt: '2026-09-01T10:00:00Z',
    ...overrides,
  };
}

describe('buildExecutionEconomicsReport', () => {
  it('reports coverage by harness/version, unknown models, unjoinable and unavailable classes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'econ-report-'));
    const evalsPath = join(dir, 'evals.jsonl');
    try {
      const lines = [
        makeEvalLine('r1', [makeBlock()]),
        makeEvalLine('r2', [makeBlock({
          providerContractVersion: 'codex/1',
          harness: 'codex',
          sessions: [makeSession({
            sessionId: 'codex-1',
            harnessVersion: '0.154.0',
            stageRole: { value: null, confidence: 'unattributed', evidence: null },
            models: {
              requested: null,
              forced: null,
              resolved: 'claude-opus-4-6',
              executed: 'totally-unknown-model',
              provenance: { executed: 'session_telemetry' },
              conflict: { otherSource: 'session_telemetry', otherResolvedModel: 'totally-unknown-model', detail: 'mismatch' },
            },
            modelSegments: [{ model: 'totally-unknown-model', turnCount: 1 }],
            turnCount: 1,
            coverage: 'unavailable',
            fieldAvailability: { actualCost: 'unavailable', cacheWriteTokens: 'unavailable' },
          })],
          turnCount: 1,
          coverage: 'unavailable',
        })]),
        makeEvalLine('r3', []),
      ];
      writeFileSync(evalsPath, lines.join('\n') + '\n');

      const report = buildExecutionEconomicsReport({ evalsPath });

      assert.equal(report.status, 'ok');
      assert.equal(report.totalEvalRecords, 3);
      assert.equal(report.recordsWithEconomics, 2);
      assert.equal(report.blocks, 2);
      assert.equal(report.sessions, 2);
      assert.equal(report.turns, 4);

      assert.equal(report.byHarnessVersion.length, 2);
      const claude = report.byHarnessVersion.find((s) => s.harness === 'claude-code');
      assert.equal(claude?.harnessVersion, '2.1.270');
      assert.equal(claude?.sessions, 1);
      assert.equal(claude?.coverage.partial, 1);
      const codex = report.byHarnessVersion.find((s) => s.harness === 'codex');
      assert.equal(codex?.harnessVersion, '0.154.0');
      assert.equal(codex?.coverage.unavailable, 1);

      assert.deepEqual(report.unknownModels, ['totally-unknown-model']);
      assert.equal(report.unjoinableSessions, 1);
      assert.equal(report.conflictSessions, 1);
      assert.equal(report.unavailableFieldClasses.actualCost, 2);
      assert.equal(report.unavailableFieldClasses.reasoningTokens, 1);
      assert.equal(report.unavailableFieldClasses.cacheWriteTokens, 1);

      const rendered = renderExecutionEconomicsReport(report);
      assert.ok(rendered.includes('claude-code@2.1.270'));
      assert.ok(rendered.includes('codex@0.154.0'));
      assert.ok(rendered.includes('totally-unknown-model'));
      assert.ok(rendered.includes('Unjoinable sessions (no stage attribution): 1'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports no_records for a corpus without execution economics', () => {
    const dir = mkdtempSync(join(tmpdir(), 'econ-report-empty-'));
    const evalsPath = join(dir, 'evals.jsonl');
    try {
      writeFileSync(evalsPath, makeEvalLine('r1', []) + '\n');
      const report = buildExecutionEconomicsReport({ evalsPath });
      assert.equal(report.status, 'no_records');
      assert.equal(report.totalEvalRecords, 1);
      assert.equal(report.recordsWithEconomics, 0);
      assert.ok(renderExecutionEconomicsReport(report).includes('No execution-economics records'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles a missing corpus file without throwing', () => {
    const report = buildExecutionEconomicsReport({ evalsPath: '/nonexistent/econ/evals.jsonl' });
    assert.equal(report.status, 'no_records');
    assert.equal(report.totalEvalRecords, 0);
  });
});
