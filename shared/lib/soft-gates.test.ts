/**
 * Tests for soft-gates module (HOK-2263)
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { evaluateSoftGates, emitSoftGates, checkAndEmitSoftGates } from './soft-gates.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTempRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'soft-gates-test-'));
  mkdirSync(join(repoDir, 'features'), { recursive: true });
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  mkdirSync(join(repoDir, '.wavemill', 'logs'), { recursive: true });
  return repoDir;
}

function makeFeatureDir(repoDir: string, slug: string): string {
  const featureDir = join(repoDir, 'features', slug);
  mkdirSync(featureDir, { recursive: true });
  return featureDir;
}

function writeSelectedTask(featureDir: string, taskId: string, slug: string): void {
  writeFileSync(
    join(featureDir, 'selected-task.json'),
    JSON.stringify({ taskId, featureName: slug, workflowType: 'feature' }),
    'utf-8',
  );
}

function writeFeatureState(featureDir: string, overrides: Record<string, unknown> = {}): void {
  const defaults = {
    schemaVersion: '1.0',
    derivedAt: new Date().toISOString(),
    issueId: 'HOK-9999',
    slug: 'test-feature',
    branch: null,
    prNumber: null,
    prUrl: null,
    currentPhase: 'coding',
    normalizedState: 'running',
    contract: null,
    route: null,
    stages: { planning: null, coding: null, review: null, ready: null },
    evidence: [],
    blockers: [],
    failureReason: null,
    outcome: {
      completed: false,
      merged: null,
      ciPassed: null,
      reviewPassed: null,
      readyPassed: null,
      manualIntervention: null,
      interventionCount: null,
      reverted: null,
      evalScore: null,
      costUsd: null,
      durationSeconds: null,
    },
    artifactSources: {
      stagesFromWorktree: false,
      stagesFromArchive: false,
      routeFromWorktree: false,
      routeFromArchive: false,
      evalRecordUsed: false,
    },
  };
  const merged = deepMerge(defaults, overrides);
  writeFileSync(
    join(featureDir, 'feature-state.json'),
    JSON.stringify(merged, null, 2),
    'utf-8',
  );
}

function deepMerge(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, val] of Object.entries(overrides)) {
    if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, val as Record<string, unknown>);
    } else {
      result[key] = val;
    }
  }
  return result;
}

function writeTaskContract(featureDir: string, overrides: Record<string, unknown> = {}): void {
  const defaults = {
    schemaVersion: '1.0.0',
    issueId: 'HOK-9999',
    slug: 'test-feature',
    sources: [],
    fields: {},
    routingHints: {},
    warnings: [],
  };
  writeFileSync(
    join(featureDir, 'task-contract.json'),
    JSON.stringify({ ...defaults, ...overrides }, null, 2),
    'utf-8',
  );
}

function writeCodingCompleteMarker(featureDir: string): void {
  writeFileSync(join(featureDir, '.coding-complete'), '', 'utf-8');
}

function writeTraceContext(featureDir: string, traceId = 'trc_test_1234'): void {
  writeFileSync(
    join(featureDir, '.trace-context.json'),
    JSON.stringify({
      schemaVersion: '1.0',
      traceId,
      issueId: 'HOK-9999',
      slug: 'test-feature',
      createdAt: new Date().toISOString(),
    }),
    'utf-8',
  );
}

function writeTraceEvent(featureDir: string, overrides: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    schemaVersion: '1.0',
    traceId: 'trc_test_1234',
    issueId: 'HOK-9999',
    slug: 'test-feature',
    timestamp: new Date().toISOString(),
    phase: 'coding',
    event: 'phase_started',
    ...overrides,
  });
  writeFileSync(join(featureDir, 'trace.jsonl'), line + '\n', { flag: 'a' });
}

function writeEvalRecord(repoDir: string, record: Record<string, unknown>): void {
  const evalsPath = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
  const defaults = {
    id: `eval-${Date.now()}`,
    schemaVersion: '1.30.0',
    originalPrompt: 'task prompt',
    modelId: 'claude-sonnet-4-6',
    modelVersion: 'claude-sonnet-4-6',
    score: 0.8,
    scoreBand: 'good',
    timeSeconds: 120,
    timestamp: new Date().toISOString(),
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'good work',
  };
  const line = JSON.stringify({ ...defaults, ...record });
  writeFileSync(evalsPath, line + '\n', { flag: 'a' });
}

function writeReadyResult(featureDir: string, verdict: 'pass' | 'fail'): void {
  writeFileSync(
    join(featureDir, '.ready-result.json'),
    JSON.stringify({
      status: 'completed',
      artifacts: { type: 'ready', verdict, checksRun: 3, checksPassed: verdict === 'pass' ? 3 : 2 },
    }),
    'utf-8',
  );
}

function writeRouteArtifact(featureDir: string, filename: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    join(featureDir, filename),
    JSON.stringify({
      model: 'claude-sonnet-4-6',
      provenance: { source: 'router', routerMode: 'live', inputHash: 'abc123' },
      ...overrides,
    }),
    'utf-8',
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('soft-gates', () => {
  let repoDir: string;
  const cleanupDirs: string[] = [];

  before(() => {
    repoDir = makeTempRepo();
    cleanupDirs.push(repoDir);
  });

  after(() => {
    for (const d of cleanupDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  describe('no-warning happy path', () => {
    it('returns zero warnings when artifacts are absent (legacy task)', () => {
      const tmpRepo = makeTempRepo();
      cleanupDirs.push(tmpRepo);
      // No feature dir, no artifacts at all
      const warnings = evaluateSoftGates({ repoDir: tmpRepo });
      assert.equal(warnings.length, 0, 'should produce no warnings for a repo with no features');
    });

    it('returns zero warnings when all artifacts are consistent', () => {
      const tmpRepo = makeTempRepo();
      cleanupDirs.push(tmpRepo);
      const slug = 'happy-feature';
      const featureDir = makeFeatureDir(tmpRepo, slug);
      writeSelectedTask(featureDir, 'HOK-1000', slug);

      const taskPacketContent = '# Task Packet\n## Objective\nDo something.\n';
      writeFileSync(join(featureDir, 'task-packet.md'), taskPacketContent, 'utf-8');
      const hash = createHash('sha256').update(Buffer.from(taskPacketContent)).digest('hex');

      writeTaskContract(featureDir, {
        issueId: 'HOK-1000',
        slug,
        sources: [{ path: 'task-packet.md', exists: true, sha256: hash }],
      });
      writeFeatureState(featureDir, {
        issueId: 'HOK-1000',
        slug,
        currentPhase: 'done',
        normalizedState: 'completed',
        evidence: [{ kind: 'stage_completion', label: 'coding_done', status: 'pass' }],
        outcome: {
          completed: true,
          merged: true,
          ciPassed: true,
          reviewPassed: true,
          readyPassed: true,
          manualIntervention: false,
          interventionCount: 0,
          reverted: false,
          evalScore: 0.9,
          costUsd: 1.0,
          durationSeconds: 3600,
        },
      });
      writeTraceContext(featureDir, 'trc_happy_01');
      writeCodingCompleteMarker(featureDir);

      const warnings = evaluateSoftGates({ repoDir: tmpRepo, slug });
      // Filter to only warn/error severity (info is ok for trace_linkage_missing when no traceId in artifacts)
      const warnOrError = warnings.filter(w => w.severity === 'warn' || w.severity === 'error');
      assert.equal(warnOrError.length, 0, `expected no warn/error warnings, got: ${JSON.stringify(warnOrError)}`);
    });
  });

  describe('completion_without_evidence gate', () => {
    it('emits completion_without_evidence when .coding-complete exists but no passing evidence', () => {
      const tmpRepo = makeTempRepo();
      cleanupDirs.push(tmpRepo);
      const slug = 'no-evidence-feature';
      const featureDir = makeFeatureDir(tmpRepo, slug);
      writeSelectedTask(featureDir, 'HOK-2000', slug);
      writeFeatureState(featureDir, {
        issueId: 'HOK-2000',
        slug,
        evidence: [],
        outcome: {
          completed: false,
          merged: null,
          ciPassed: null,
          reviewPassed: null,
          readyPassed: null,
          manualIntervention: null,
          interventionCount: null,
          reverted: null,
          evalScore: null,
          costUsd: null,
          durationSeconds: null,
        },
      });
      writeCodingCompleteMarker(featureDir);

      const warnings = evaluateSoftGates({ repoDir: tmpRepo, slug });
      const gate = warnings.find(w => w.gate === 'completion_without_evidence');
      assert.ok(gate, 'should emit completion_without_evidence warning');
      assert.equal(gate.severity, 'warn');
      assert.ok(gate.detail.length > 0);
      assert.ok(gate.recommendedAction.length > 0);
    });

    it('does not emit completion_without_evidence when passing evidence exists', () => {
      const tmpRepo = makeTempRepo();
      cleanupDirs.push(tmpRepo);
      const slug = 'with-evidence-feature';
      const featureDir = makeFeatureDir(tmpRepo, slug);
      writeSelectedTask(featureDir, 'HOK-2001', slug);
      writeFeatureState(featureDir, {
        issueId: 'HOK-2001',
        slug,
        evidence: [{ kind: 'stage_completion', label: 'coding_done', status: 'pass' }],
        outcome: {
          completed: true,
          merged: false,
          ciPassed: null,
          reviewPassed: null,
          readyPassed: null,
          manualIntervention: null,
          interventionCount: null,
          reverted: null,
          evalScore: null,
          costUsd: null,
          durationSeconds: null,
        },
      });
      writeCodingCompleteMarker(featureDir);

      const warnings = evaluateSoftGates({ repoDir: tmpRepo, slug });
      const gate = warnings.find(w => w.gate === 'completion_without_evidence');
      assert.equal(gate, undefined, 'should not emit completion_without_evidence when evidence is present');
    });
  });

  describe('contract_source_hash_mismatch gate', () => {
    it('emits contract_source_hash_mismatch when source file hash has changed', () => {
      const tmpRepo = makeTempRepo();
      cleanupDirs.push(tmpRepo);
      const slug = 'hash-drift-feature';
      const featureDir = makeFeatureDir(tmpRepo, slug);
      writeSelectedTask(featureDir, 'HOK-3000', slug);

      const originalContent = '# Task Packet\n## Objective\nOriginal content.\n';
      writeFileSync(join(featureDir, 'task-packet.md'), originalContent, 'utf-8');
      const originalHash = createHash('sha256').update(Buffer.from(originalContent)).digest('hex');

      writeTaskContract(featureDir, {
        issueId: 'HOK-3000',
        slug,
        sources: [{ path: 'task-packet.md', exists: true, sha256: originalHash }],
      });

      // Now modify the file to cause hash drift
      writeFileSync(join(featureDir, 'task-packet.md'), originalContent + '\n## New Section\nModified.\n', 'utf-8');

      writeFeatureState(featureDir, { issueId: 'HOK-3000', slug });

      const warnings = evaluateSoftGates({ repoDir: tmpRepo, slug });
      const gate = warnings.find(w => w.gate === 'contract_source_hash_mismatch');
      assert.ok(gate, 'should emit contract_source_hash_mismatch warning');
      assert.equal(gate.severity, 'warn');
      assert.ok(gate.expected.includes(originalHash.slice(0, 8)) || gate.expected.includes('stored'), 'expected should reference stored hash');
    });

    it('does not emit contract_source_hash_mismatch when hashes match', () => {
      const tmpRepo = makeTempRepo();
      cleanupDirs.push(tmpRepo);
      const slug = 'hash-ok-feature';
      const featureDir = makeFeatureDir(tmpRepo, slug);
      writeSelectedTask(featureDir, 'HOK-3001', slug);

      const content = '# Task Packet\n## Objective\nStable content.\n';
      writeFileSync(join(featureDir, 'task-packet.md'), content, 'utf-8');
      const hash = createHash('sha256').update(Buffer.from(content)).digest('hex');

      writeTaskContract(featureDir, {
        issueId: 'HOK-3001',
        slug,
        sources: [{ path: 'task-packet.md', exists: true, sha256: hash }],
      });
      writeFeatureState(featureDir, { issueId: 'HOK-3001', slug });

      const warnings = evaluateSoftGates({ repoDir: tmpRepo, slug });
      const gate = warnings.find(w => w.gate === 'contract_source_hash_mismatch');
      assert.equal(gate, undefined, 'should not emit hash mismatch when hashes match');
    });
  });

  describe('trace_linkage_missing gate', () => {
    it('emits trace_linkage_missing when trace context exists but route artifacts lack traceId', () => {
      const tmpRepo = makeTempRepo();
      cleanupDirs.push(tmpRepo);
      const slug = 'trace-missing-feature';
      const featureDir = makeFeatureDir(tmpRepo, slug);
      writeSelectedTask(featureDir, 'HOK-4000', slug);
      writeTraceContext(featureDir, 'trc_abc_001');

      // Write a route artifact WITHOUT traceId
      writeRouteArtifact(featureDir, '.initial-route.json', {
        model: 'claude-sonnet-4-6',
        provenance: { source: 'router', inputHash: 'deadbeef01' },
        // no traceId field
      });

      writeFeatureState(featureDir, { issueId: 'HOK-4000', slug });

      const warnings = evaluateSoftGates({ repoDir: tmpRepo, slug });
      const gate = warnings.find(w => w.gate === 'trace_linkage_missing');
      assert.ok(gate, 'should emit trace_linkage_missing warning');
      assert.equal(gate.severity, 'info');
    });

    it('does not emit trace_linkage_missing when no trace context exists', () => {
      const tmpRepo = makeTempRepo();
      cleanupDirs.push(tmpRepo);
      const slug = 'no-trace-feature';
      const featureDir = makeFeatureDir(tmpRepo, slug);
      writeSelectedTask(featureDir, 'HOK-4001', slug);
      writeFeatureState(featureDir, { issueId: 'HOK-4001', slug });
      // No trace context, no trace.jsonl

      const warnings = evaluateSoftGates({ repoDir: tmpRepo, slug });
      const gate = warnings.find(w => w.gate === 'trace_linkage_missing');
      assert.equal(gate, undefined, 'should not emit trace_linkage_missing when there is no trace');
    });
  });

  describe('eval_export_inconsistency gate', () => {
    it('emits eval_export_inconsistency when eval is training eligible but featureOutcomeDiagnostics has missingFields', () => {
      const tmpRepo = makeTempRepo();
      cleanupDirs.push(tmpRepo);
      const slug = 'eval-inconsistency-feature';
      const featureDir = makeFeatureDir(tmpRepo, slug);
      writeSelectedTask(featureDir, 'HOK-5000', slug);
      writeFeatureState(featureDir, { issueId: 'HOK-5000', slug });

      writeEvalRecord(tmpRepo, {
        issueId: 'HOK-5000',
        trainingEligible: true,
        featureOutcomeDiagnostics: {
          present: true,
          valid: true,
          used: false,
          reason: 'missing_required_fields',
          missingFields: ['merged', 'ciPassed'],
        },
      });

      const warnings = evaluateSoftGates({ repoDir: tmpRepo, slug });
      const gate = warnings.find(w => w.gate === 'eval_export_inconsistency');
      assert.ok(gate, 'should emit eval_export_inconsistency warning');
      assert.equal(gate.severity, 'warn');
      assert.ok(gate.detail.includes('missing fields'), 'detail should mention missing fields');
    });

    it('emits eval_export_inconsistency when eligibilityErrors include missing_feature_outcome', () => {
      const tmpRepo = makeTempRepo();
      cleanupDirs.push(tmpRepo);
      const slug = 'eval-elig-error-feature';
      const featureDir = makeFeatureDir(tmpRepo, slug);
      writeSelectedTask(featureDir, 'HOK-5001', slug);
      writeFeatureState(featureDir, { issueId: 'HOK-5001', slug });

      writeEvalRecord(tmpRepo, {
        issueId: 'HOK-5001',
        trainingEligible: true,
        eligibilityErrors: ['missing_feature_outcome'],
        featureOutcomeDiagnostics: {
          present: false,
          valid: false,
          used: false,
          reason: 'artifact_absent',
        },
      });

      const warnings = evaluateSoftGates({ repoDir: tmpRepo, slug });
      const gate = warnings.find(w => w.gate === 'eval_export_inconsistency');
      assert.ok(gate, 'should emit eval_export_inconsistency when eligibilityErrors include feature outcome errors');
    });

    it('does not emit eval_export_inconsistency when eval is not training eligible', () => {
      const tmpRepo = makeTempRepo();
      cleanupDirs.push(tmpRepo);
      const slug = 'eval-not-eligible-feature';
      const featureDir = makeFeatureDir(tmpRepo, slug);
      writeSelectedTask(featureDir, 'HOK-5002', slug);
      writeFeatureState(featureDir, { issueId: 'HOK-5002', slug });

      writeEvalRecord(tmpRepo, {
        issueId: 'HOK-5002',
        trainingEligible: false,
        eligibilityErrors: ['missing_routing'],
      });

      const warnings = evaluateSoftGates({ repoDir: tmpRepo, slug });
      const gate = warnings.find(w => w.gate === 'eval_export_inconsistency');
      assert.equal(gate, undefined, 'should not emit when eval is not training eligible');
    });

    it('does not emit eval_export_inconsistency when featureOutcomeDiagnostics is fully valid', () => {
      const tmpRepo = makeTempRepo();
      cleanupDirs.push(tmpRepo);
      const slug = 'eval-ok-feature';
      const featureDir = makeFeatureDir(tmpRepo, slug);
      writeSelectedTask(featureDir, 'HOK-5003', slug);
      writeFeatureState(featureDir, { issueId: 'HOK-5003', slug });

      writeEvalRecord(tmpRepo, {
        issueId: 'HOK-5003',
        trainingEligible: true,
        eligibilityErrors: [],
        featureOutcomeDiagnostics: {
          present: true,
          valid: true,
          used: true,
          reason: 'loaded',
          missingFields: [],
          eligibilityDiagnostic: 'eligible',
        },
      });

      const warnings = evaluateSoftGates({ repoDir: tmpRepo, slug });
      const gate = warnings.find(w => w.gate === 'eval_export_inconsistency');
      assert.equal(gate, undefined, 'should not emit when featureOutcomeDiagnostics is valid and used');
    });

    // HOK-3116: challenger evals record the base issue ID as challengePairId
    // (and usually as issueId); the gate used to look for `<id>_c` and missed them.
    it('matches a challenger arm eval through the base pair ID', () => {
      const tmpRepo = makeTempRepo();
      cleanupDirs.push(tmpRepo);
      const slug = 'eval-challenger-feature-challenger';
      const featureDir = makeFeatureDir(tmpRepo, slug);
      writeSelectedTask(featureDir, 'HOK-5004_c', slug);
      writeFeatureState(featureDir, { issueId: 'HOK-5004_c', slug });

      writeEvalRecord(tmpRepo, {
        issueId: 'HOK-5004',
        challengePairId: 'HOK-5004',
        challengeSide: 'challenger',
        trainingEligible: true,
        eligibilityErrors: ['missing_feature_outcome'],
      });

      const warnings = evaluateSoftGates({ repoDir: tmpRepo, slug });
      const gate = warnings.find(w => w.gate === 'eval_export_inconsistency');
      assert.ok(gate, 'challenger arm eval should match via its base pair ID');
    });

    it('does not attribute the primary arm eval to the challenger task', () => {
      const tmpRepo = makeTempRepo();
      cleanupDirs.push(tmpRepo);
      const slug = 'eval-primary-only-feature-challenger';
      const featureDir = makeFeatureDir(tmpRepo, slug);
      writeSelectedTask(featureDir, 'HOK-5005_c', slug);
      writeFeatureState(featureDir, { issueId: 'HOK-5005_c', slug });

      writeEvalRecord(tmpRepo, {
        issueId: 'HOK-5005',
        challengePairId: 'HOK-5005',
        challengeSide: 'primary',
        trainingEligible: true,
        eligibilityErrors: ['missing_feature_outcome'],
      });

      const warnings = evaluateSoftGates({ repoDir: tmpRepo, slug });
      const gate = warnings.find(w => w.gate === 'eval_export_inconsistency');
      assert.equal(gate, undefined, 'pair-mate eval must not match the challenger task');
    });
  });

  describe('dedup / emission', () => {
    it('suppresses repeat warnings with the same fingerprint', async () => {
      const tmpRepo = makeTempRepo();
      cleanupDirs.push(tmpRepo);
      const slug = 'dedup-feature';
      const featureDir = makeFeatureDir(tmpRepo, slug);
      writeSelectedTask(featureDir, 'HOK-6000', slug);
      writeFeatureState(featureDir, { issueId: 'HOK-6000', slug, evidence: [] });
      writeCodingCompleteMarker(featureDir);

      const warnings = evaluateSoftGates({ repoDir: tmpRepo, slug });
      assert.ok(warnings.length > 0, 'should have at least one warning');

      // First emission — should write all
      const first = await emitSoftGates(warnings, { repoDir: tmpRepo });
      assert.ok(first.written > 0, 'first emission should write warnings');
      assert.equal(first.suppressed, 0, 'first emission should not suppress anything');

      // Second emission with same warnings — should suppress all
      const second = await emitSoftGates(warnings, { repoDir: tmpRepo });
      assert.equal(second.written, 0, 'second emission should write nothing');
      assert.equal(second.suppressed, warnings.length, 'second emission should suppress all');
    });

    it('--no-emit skips writing but returns correct counts', async () => {
      const tmpRepo = makeTempRepo();
      cleanupDirs.push(tmpRepo);
      const slug = 'noemit-feature';
      const featureDir = makeFeatureDir(tmpRepo, slug);
      writeSelectedTask(featureDir, 'HOK-6001', slug);
      writeFeatureState(featureDir, { issueId: 'HOK-6001', slug, evidence: [] });
      writeCodingCompleteMarker(featureDir);

      const warnings = evaluateSoftGates({ repoDir: tmpRepo, slug });
      assert.ok(warnings.length > 0, 'should have at least one warning');

      const result = await emitSoftGates(warnings, { repoDir: tmpRepo, noEmit: true });
      assert.equal(result.written, warnings.length, '--no-emit should count detections as written');
      assert.equal(result.suppressed, 0, '--no-emit has no prior seen state');

      // Log file should NOT exist because noEmit=true
      const logPath = join(tmpRepo, '.wavemill', 'logs', 'soft-gates.jsonl');
      assert.equal(existsSync(logPath), false, 'log file should not be created with --no-emit');
      const seenPath = join(tmpRepo, '.wavemill', 'logs', '.soft-gates-seen.json');
      assert.equal(existsSync(seenPath), false, 'seen fingerprints should not be created with --no-emit');
    });

    it('never throws on malformed or missing artifacts', () => {
      const tmpRepo = makeTempRepo();
      cleanupDirs.push(tmpRepo);
      const slug = 'malformed-feature';
      const featureDir = makeFeatureDir(tmpRepo, slug);
      writeSelectedTask(featureDir, 'HOK-6002', slug);

      // Write malformed JSON files
      writeFileSync(join(featureDir, 'feature-state.json'), 'not valid json {{{', 'utf-8');
      writeFileSync(join(featureDir, 'task-contract.json'), '', 'utf-8');
      writeFileSync(join(featureDir, 'trace.jsonl'), 'bad line\n{"traceId": "ok"}\n', 'utf-8');

      assert.doesNotThrow(() => {
        evaluateSoftGates({ repoDir: tmpRepo, slug });
      }, 'evaluateSoftGates should never throw');
    });
  });

  describe('ready_inconsistency gate', () => {
    it('emits ready_inconsistency when ready-result.json passes but feature-state lacks passing ready evidence', () => {
      const tmpRepo = makeTempRepo();
      cleanupDirs.push(tmpRepo);
      const slug = 'ready-inconsistency-feature';
      const featureDir = makeFeatureDir(tmpRepo, slug);
      writeSelectedTask(featureDir, 'HOK-7000', slug);

      writeReadyResult(featureDir, 'pass');
      writeFeatureState(featureDir, {
        issueId: 'HOK-7000',
        slug,
        evidence: [], // no ready_check evidence
        outcome: { readyPassed: true },
      });

      const warnings = evaluateSoftGates({ repoDir: tmpRepo, slug });
      const gate = warnings.find(w => w.gate === 'ready_inconsistency');
      assert.ok(gate, 'should emit ready_inconsistency when evidence is missing');
      assert.equal(gate.severity, 'warn');
    });

    it('does not emit ready_inconsistency when ready passed with matching evidence', () => {
      const tmpRepo = makeTempRepo();
      cleanupDirs.push(tmpRepo);
      const slug = 'ready-ok-feature';
      const featureDir = makeFeatureDir(tmpRepo, slug);
      writeSelectedTask(featureDir, 'HOK-7001', slug);

      writeReadyResult(featureDir, 'pass');
      writeFeatureState(featureDir, {
        issueId: 'HOK-7001',
        slug,
        evidence: [{ kind: 'ready_check', label: 'ready_verdict', status: 'pass' }],
        outcome: { readyPassed: true },
      });

      const warnings = evaluateSoftGates({ repoDir: tmpRepo, slug });
      const gate = warnings.find(w => w.gate === 'ready_inconsistency');
      assert.equal(gate, undefined, 'should not emit ready_inconsistency when evidence is present');
    });
  });

  describe('checkAndEmitSoftGates convenience wrapper', () => {
    it('returns warnings + emission counts and never throws', async () => {
      const tmpRepo = makeTempRepo();
      cleanupDirs.push(tmpRepo);
      const slug = 'wrapper-feature';
      const featureDir = makeFeatureDir(tmpRepo, slug);
      writeSelectedTask(featureDir, 'HOK-8000', slug);
      writeFeatureState(featureDir, { issueId: 'HOK-8000', slug, evidence: [] });
      writeCodingCompleteMarker(featureDir);

      const result = await checkAndEmitSoftGates({ repoDir: tmpRepo, slug, noEmit: true });
      assert.ok(Array.isArray(result.warnings), 'should return warnings array');
      assert.ok(typeof result.written === 'number', 'should return written count');
      assert.ok(typeof result.suppressed === 'number', 'should return suppressed count');
    });
  });
});
