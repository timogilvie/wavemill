import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { auditHokusaiContributions } from './hokusai-audit.ts';
import type { TechnicalTaskRouterContributionRowV1 } from './hokusai-contribution-schema.ts';
import { TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION } from './hokusai-contribution-schema.ts';
import type { HokusaiQueueEnvelope } from './hokusai-queue.ts';
import type { HokusaiTaskDescriptor } from './hokusai-schema.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(__dirname, '..', '..');
const hokusaiManageTool = resolve(repoDir, 'tools', 'hokusai-manage.ts');

function makeDescriptor(overrides: Partial<HokusaiTaskDescriptor> = {}): HokusaiTaskDescriptor {
  return {
    task_type: 'feature',
    language: 'typescript',
    domain: 'frontend',
    complexity: 5,
    repo_size_bucket: 'medium',
    files_touched_bucket: '2_5',
    description_length_bucket: 'medium',
    is_greenfield: false,
    is_migration: false,
    requires_tests: true,
    cross_service: false,
    ui_heavy: true,
    risk_level: 'medium',
    ...overrides,
  };
}

function makeBenchmarkRow(
  overrides: Partial<TechnicalTaskRouterContributionRowV1 & Record<string, unknown>> = {},
): TechnicalTaskRouterContributionRowV1 & Record<string, unknown> {
  return {
    schema_version: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION,
    task_descriptor: makeDescriptor(),
    allowed_models: ['planner-a', 'coder-a', 'coder-b', 'reviewer-a'],
    selected_models: {
      planner: 'planner-a',
      coder: 'coder-a',
      reviewer: 'reviewer-a',
    },
    budget_usd: 10,
    actual_cost_usd: 2,
    wall_clock_seconds: 120,
    success_under_budget: true,
    completion_result: 'success',
    scorer_ref: 'technical_task_router.success_under_budget/v1',
    observed_at: '2026-06-16T12:00:00.000Z',
    task_id: 'task-1',
    harness: 'wavemill',
    ...overrides,
  };
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hokusai-audit-'));
  writeFileSync(join(dir, '.wavemill-config.json'), '{}\n', 'utf-8');
  return dir;
}

function writeJsonl(path: string, lines: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf-8');
}

function stripConformanceLocation<T extends { source: unknown; path: unknown }>(value: T): Omit<T, 'source' | 'path'> {
  const { source: _source, path: _path, ...rest } = value;
  return rest;
}

describe('hokusai-audit', () => {
  it('reports passing conformance for valid benchmark rows', () => {
    const dir = makeTempRepo();
    try {
      const input = join(dir, 'rows.jsonl');
      writeJsonl(input, [JSON.stringify(makeBenchmarkRow({
        scorer_ref: 'technical_task_router.benchmark_score/v2',
        candidate_pools: {
          planner: ['planner-a'],
          coder: ['coder-a'],
          reviewer: ['reviewer-a'],
        },
      }))]);

      const report = auditHokusaiContributions({ repoDir: dir, inputPath: input, thresholdMode: 'fail' });

      assert.equal(report.conformance.valid, 1);
      assert.equal(report.conformance.invalid, 0);
      assert.equal(report.conformance.v2CompliantRows, 1);
      assert.equal(report.failures.length, 0);
      assert.equal(report.groupings.descriptor[0]?.taskType, 'feature');
      assert.equal(report.groupings.model30[0]?.taskType, 'feature');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts malformed JSON and schema-invalid rows with line diagnostics', () => {
    const dir = makeTempRepo();
    try {
      const input = join(dir, 'rows.jsonl');
      writeJsonl(input, [
        '{"schema_version":"technical_task_router_row/v1"',
        JSON.stringify({ success_under_budget: true, original_prompt: 'forbidden' }),
      ]);

      const report = auditHokusaiContributions({ repoDir: dir, inputPath: input });

      assert.equal(report.conformance.malformedJson, 1);
      assert.equal(report.conformance.invalid, 1);
      assert.deepEqual(
        report.conformance.diagnostics.map((entry) => entry.code),
        ['malformed_json', 'schema_validation_failed'],
      );
      assert.deepEqual(
        report.conformance.diagnostics.map((entry) => entry.line),
        [1, 2],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes zero-evidence current candidates in coverage cells', () => {
    const dir = makeTempRepo();
    try {
      const input = join(dir, 'rows.jsonl');
      const row = makeBenchmarkRow({
        candidate_pools: {
          planner: ['planner-a'],
          coder: ['coder-a', 'coder-b'],
          reviewer: ['reviewer-a'],
        },
      });
      writeJsonl(input, [JSON.stringify(row)]);

      const report = auditHokusaiContributions({ repoDir: dir, inputPath: input });
      const coderDescriptorCell = report.candidatePoolCoverage.cells.find((cell) =>
        cell.grouping === 'descriptor' && cell.role === 'coder' && cell.taskType === 'feature'
      );

      assert.ok(coderDescriptorCell);
      assert.deepEqual(coderDescriptorCell.zeroEvidenceCandidates, ['coder-b']);
      assert.equal(coderDescriptorCell.coverage, 0.5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('switches threshold failures between warn and fail modes', () => {
    const dir = makeTempRepo();
    try {
      const input = join(dir, 'rows.jsonl');
      const row = makeBenchmarkRow({
        candidate_pools: {
          planner: ['planner-a'],
          coder: ['coder-a', 'coder-b'],
          reviewer: ['reviewer-a'],
        },
      });
      writeJsonl(input, [JSON.stringify(row)]);

      const warnReport = auditHokusaiContributions({
        repoDir: dir,
        inputPath: input,
        coverageThreshold: 0.9,
        thresholdMode: 'warn',
      });
      const failReport = auditHokusaiContributions({
        repoDir: dir,
        inputPath: input,
        coverageThreshold: 0.9,
        thresholdMode: 'fail',
      });

      assert.equal(warnReport.warnings.length, 1);
      assert.equal(warnReport.failures.length, 0);
      assert.equal(failReport.warnings.length, 0);
      assert.equal(failReport.failures.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes all required scenario shares and infers low-budget plus sparse-cell deterministically', () => {
    const dir = makeTempRepo();
    try {
      const input = join(dir, 'rows.jsonl');
      writeJsonl(input, [
        JSON.stringify(makeBenchmarkRow({
          budget_usd: 4,
          scorer_ref: 'technical_task_router.benchmark_score/v2',
        })),
      ]);

      const report = auditHokusaiContributions({
        repoDir: dir,
        inputPath: input,
        sparseCellMinEvidence: 2,
      });

      assert.deepEqual(
        report.scenarioShares.map((entry) => entry.scenario),
        [
          'production',
          'challenger-present',
          'dominant-model-removed',
          'low-budget',
          'sparse-cell',
        ],
      );
      assert.equal(report.scenarioShares.find((entry) => entry.scenario === 'low-budget')?.numerator, 1);
      assert.equal(report.scenarioShares.find((entry) => entry.scenario === 'sparse-cell')?.numerator, 1);
      assert.equal(report.scenarioShares.find((entry) => entry.scenario === 'production')?.numerator, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('distinguishes descriptor grouping from normalized Model 30 grouping', () => {
    const dir = makeTempRepo();
    try {
      const input = join(dir, 'rows.jsonl');
      writeJsonl(input, [
        JSON.stringify(makeBenchmarkRow({
          task_descriptor: makeDescriptor({ task_type: 'docs', domain: 'devops', complexity: 3 }),
          scorer_ref: 'technical_task_router.benchmark_score/v2',
        })),
      ]);

      const report = auditHokusaiContributions({ repoDir: dir, inputPath: input });

      assert.equal(report.groupings.descriptor[0]?.taskType, 'docs');
      assert.equal(report.groupings.model30[0]?.taskType, 'maintenance');
      assert.equal(report.groupings.descriptor[0]?.complexity, '3');
      assert.equal(report.groupings.model30[0]?.complexity, 'medium');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes queue-envelope input and exported-row input equivalently', () => {
    const dir = makeTempRepo();
    try {
      const row = makeBenchmarkRow({
        scorer_ref: 'technical_task_router.benchmark_score/v2',
        scenario: 'challenger-present',
      });
      const exportInput = join(dir, 'rows.jsonl');
      const queueInput = join(dir, '.wavemill', 'hokusai', 'queue', 'pending.jsonl');
      const envelope: HokusaiQueueEnvelope = {
        schemaVersion: '1.0',
        entryId: 'entry-1',
        rowShape: 'technical_task_router_row/v1',
        row,
        idempotencyKey: 'abc123',
        enqueuedAt: '2026-06-16T12:00:00.000Z',
        attempts: 0,
        nextAttemptAt: '2026-06-16T12:00:00.000Z',
      };

      writeJsonl(exportInput, [JSON.stringify(row)]);
      writeJsonl(queueInput, [JSON.stringify(envelope)]);

      const exportReport = auditHokusaiContributions({ repoDir: dir, inputPath: exportInput });
      const queueReport = auditHokusaiContributions({ repoDir: dir, queue: true });

      assert.deepEqual(
        stripConformanceLocation(exportReport.conformance),
        stripConformanceLocation(queueReport.conformance),
      );
      assert.deepEqual(exportReport.groupings, queueReport.groupings);
      assert.deepEqual(exportReport.scenarioShares, queueReport.scenarioShares);
      assert.deepEqual(exportReport.candidatePoolCoverage, queueReport.candidatePoolCoverage);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns JSON from the CLI and exits non-zero in fail mode', () => {
    const dir = makeTempRepo();
    try {
      const input = join(dir, 'rows.jsonl');
      writeJsonl(input, [
        JSON.stringify(makeBenchmarkRow({
          candidate_pools: {
            planner: ['planner-a'],
            coder: ['coder-a', 'coder-b'],
            reviewer: ['reviewer-a'],
          },
          scorer_ref: 'technical_task_router.benchmark_score/v2',
        })),
      ]);

      const result = spawnSync(process.execPath, [
        hokusaiManageTool,
        'audit',
        '--input',
        input,
        '--json',
        '--coverage-threshold',
        '0.9',
        '--threshold-mode',
        'fail',
        '--repo-dir',
        dir,
      ], {
        cwd: repoDir,
        encoding: 'utf-8',
        env: { ...process.env },
      });

      assert.equal(result.status, 1);
      const parsed = JSON.parse(result.stdout) as ReturnType<typeof auditHokusaiContributions>;
      assert.equal(Array.isArray(parsed.failures), true);
      assert.equal(parsed.failures.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
