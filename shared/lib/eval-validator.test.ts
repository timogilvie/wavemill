import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { SCHEMA_VERSION, type EvalRecord } from './eval-schema.ts';
import {
  deriveNonRewardReasonFromIssues,
  validateEvalRecord,
  validateEvalsFile,
  validateEvalsStore,
  validateVerificationTelemetry,
} from './eval-validator.ts';

function makeTaskDescriptor(overrides: Partial<NonNullable<EvalRecord['taskDescriptor']>> = {}): NonNullable<EvalRecord['taskDescriptor']> {
  return {
    schema_version: '1.0',
    signals: {
      heuristic: {
        task_type: 'feature',
        languages: ['typescript'],
        framework_tags: [],
        files_touched: 1,
        repo_size_loc: 100,
        description_tokens: 10,
        is_greenfield: false,
        has_migration: false,
        has_ui: false,
        has_tests: true,
        cross_service: false,
      },
      learned: {
        complexity: 3,
        domain: 'backend',
        risk_flags: [],
      },
    },
    constraints: {
      models_available: ['gpt-5.4'],
      objective: 'balanced',
    },
    stages: {},
    ...overrides,
  };
}

function makeRecord(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    id: 'eval-1',
    schemaVersion: SCHEMA_VERSION,
    originalPrompt: 'Ship the fix',
    modelId: 'gpt-5.4',
    modelVersion: 'gpt-5.4',
    score: 0.9,
    scoreBand: 'Minor Feedback',
    timeSeconds: 42,
    timestamp: '2026-05-01T12:00:00Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'Judge result is present.',
    taskDescriptor: makeTaskDescriptor(),
    ...overrides,
  };
}

function writeJsonlFile(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'eval-validator-'));
  tempDirs.push(dir);
  const filePath = join(dir, 'evals.jsonl');
  writeFileSync(filePath, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf-8');
  return filePath;
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('eval-validator', () => {
  it('accepts legacy and SDK lineage records', () => {
    const context = { file: 'evals.jsonl', line: 1 };
    const legacy = makeRecord();
    const lineage = makeRecord({ attemptLineage: { task_id: 'HOK-1', run_id: '018f0000-0000-7000-8000-000000000001', stage_attempt_id: '018f0000-0000-7000-8000-000000000002' } });
    assert.deepEqual(validateEvalRecord(legacy, context), []);
    assert.deepEqual(validateEvalRecord(lineage, context), []);
  });
  it('reports an all-valid file with no issues', async () => {
    const filePath = writeJsonlFile([
      JSON.stringify(makeRecord({ id: 'eval-1' })),
      JSON.stringify(makeRecord({ id: 'eval-2', timeSeconds: null })),
    ]);

    const report = await validateEvalsFile(filePath);
    assert.equal(report.totalLines, 2);
    assert.equal(report.validRecords, 2);
    assert.deepEqual(report.issues, []);
    assert.deepEqual(report.countsByCode, {});
  });

  it('reports malformed JSON lines with their source line', async () => {
    const filePath = writeJsonlFile([
      JSON.stringify(makeRecord()),
      '{"id": "broken"',
    ]);

    const report = await validateEvalsFile(filePath);
    assert.equal(report.issues.length, 1);
    assert.equal(report.issues[0].code, 'MALFORMED_JSON');
    assert.equal(report.issues[0].line, 2);
  });

  it('reports JSON values that are not objects', async () => {
    const filePath = writeJsonlFile(['[]']);
    const report = await validateEvalsFile(filePath);
    assert.equal(report.issues.length, 1);
    assert.equal(report.issues[0].code, 'NOT_AN_OBJECT');
  });

  it('reports missing required fields with the field name', async () => {
    const filePath = writeJsonlFile([
      JSON.stringify({
        ...makeRecord(),
        modelId: undefined,
      }),
    ]);

    const report = await validateEvalsFile(filePath);
    assert.ok(report.issues.some((issue) => issue.code === 'MISSING_REQUIRED_FIELD' && issue.detail === 'modelId'));
  });

  it('reports reward ineligibility when judge output is missing', async () => {
    const filePath = writeJsonlFile([
      JSON.stringify(makeRecord({ rationale: '   ' })),
    ]);

    const report = await validateEvalsFile(filePath);
    assert.ok(report.issues.some((issue) => issue.code === 'INELIGIBLE_REWARD_NO_JUDGE'));
  });

  it('handles an empty file without throwing', async () => {
    const filePath = writeJsonlFile([]);
    const report = await validateEvalsFile(filePath);
    assert.equal(report.totalLines, 0);
    assert.equal(report.validRecords, 0);
    assert.deepEqual(report.issues, []);
  });

  it('ignores trailing blank lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-validator-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'evals.jsonl');
    writeFileSync(filePath, `${JSON.stringify(makeRecord())}\n\n\n`, 'utf-8');

    const report = await validateEvalsFile(filePath);
    assert.equal(report.totalLines, 3);
    assert.equal(report.validRecords, 1);
    assert.deepEqual(report.issues, []);
  });

  it('wraps missing-file errors with the target path', async () => {
    await assert.rejects(
      () => validateEvalsFile('/definitely/missing/evals.jsonl'),
      /Unable to validate evals file .*ENOENT/,
    );
  });

  it('returns an empty report when the eval store is absent', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'eval-store-'));
    tempDirs.push(repoDir);
    const report = await validateEvalsStore(repoDir);
    assert.equal(report.validRecords, 0);
    assert.deepEqual(report.issues, []);
    assert.deepEqual(report.countsByCode, {});
  });

  it('groups countsByCode from the full issue set', async () => {
    const filePath = writeJsonlFile([
      '{"id": "broken"',
      JSON.stringify(makeRecord({ rationale: '' })),
      JSON.stringify(null),
    ]);

    const report = await validateEvalsFile(filePath);
    assert.deepEqual(report.countsByCode, {
      MALFORMED_JSON: 1,
      INELIGIBLE_REWARD_NO_JUDGE: 1,
      NOT_AN_OBJECT: 1,
    });
  });

  it('derives the highest-severity non-reward reason and returns null for empty issue lists', () => {
    const reason = deriveNonRewardReasonFromIssues([
      {
        code: 'INELIGIBLE_REWARD_NO_JUDGE',
        file: 'evals.jsonl',
        line: 1,
        message: 'Reward not paid: record has no judge evaluation result.',
      },
      {
        code: 'MISSING_REQUIRED_FIELD',
        file: 'evals.jsonl',
        line: 1,
        detail: 'modelId',
        message: 'Required field is absent.',
      },
    ]);

    assert.deepEqual(reason, {
      code: 'MISSING_REQUIRED_FIELD',
      message: 'Required field is absent.',
    });
    assert.equal(deriveNonRewardReasonFromIssues([]), null);
  });

  it('treats null and undefined records as not-an-object input', () => {
    assert.deepEqual(
      validateEvalRecord(null, { file: 'evals.jsonl', line: 1 }).map((issue) => issue.code),
      ['NOT_AN_OBJECT'],
    );
    assert.deepEqual(
      validateEvalRecord(undefined, { file: 'evals.jsonl', line: 1 }).map((issue) => issue.code),
      ['NOT_AN_OBJECT'],
    );
  });

  it('reports unknown future schema versions', () => {
    const issues = validateEvalRecord(
      makeRecord({ schemaVersion: '9.0.0' }),
      { file: 'evals.jsonl', line: 1 },
    );
    assert.ok(issues.some((issue) => issue.code === 'UNKNOWN_SCHEMA_VERSION'));
  });

  it('reports schema violations for invalid field values', () => {
    const issues = validateEvalRecord(
      makeRecord({ score: 2 }),
      { file: 'evals.jsonl', line: 1 },
    );
    assert.ok(issues.some((issue) => issue.code === 'SCHEMA_VIOLATION' && issue.detail === 'score'));
  });

  it('accepts null timeSeconds and still rejects invalid duration values', () => {
    const validIssues = validateEvalRecord(
      makeRecord({ timeSeconds: null }),
      { file: 'evals.jsonl', line: 1 },
    );
    assert.ok(!validIssues.some((issue) => issue.code === 'SCHEMA_VIOLATION' && issue.detail === 'timeSeconds'));

    const negativeIssues = validateEvalRecord(
      makeRecord({ timeSeconds: -1 }),
      { file: 'evals.jsonl', line: 1 },
    );
    assert.ok(negativeIssues.some((issue) => issue.code === 'SCHEMA_VIOLATION' && issue.detail === 'timeSeconds'));

    const stringIssues = validateEvalRecord(
      makeRecord({ timeSeconds: 'slow' as unknown as number }),
      { file: 'evals.jsonl', line: 1 },
    );
    assert.ok(stringIssues.some((issue) => issue.code === 'SCHEMA_VIOLATION' && issue.detail === 'timeSeconds'));
  });

  it('accepts historical records without verification telemetry', () => {
    const issues = validateEvalRecord(
      makeRecord(),
      { file: 'evals.jsonl', line: 1 },
    );
    assert.ok(!issues.some((issue) => issue.code === 'SCHEMA_VIOLATION' && issue.detail === 'verificationTelemetry'));
  });

  it('accepts additive verification telemetry and rejects invalid telemetry values', () => {
    const validIssues = validateEvalRecord(
      makeRecord({
        verificationTelemetry: {
          schema_version: '1.0',
          contract: {
            source: 'explicit',
            version: '1.0',
          },
          checked_shas: {
            head: 'a'.repeat(40),
            base: 'b'.repeat(40),
          },
          local_verification: {
            ran: true,
            passed: false,
            command_count: 1,
            first_failure_index: 0,
            first_failure_category: 'lint',
            first_failure_fingerprint: 'c'.repeat(64),
            total_duration_ms: 1200,
            command_durations_ms: [1200],
          },
          remote_ci_verdict: {
            ran: true,
            passed: false,
            check_count: 3,
            first_failure_check: 'test',
            first_failure_category: 'test',
            first_failure_fingerprint: 'd'.repeat(64),
            remote_only_failure: true,
          },
          remediation: {
            local_attempt_count: 1,
            local_remediation_outcome: 'fixed',
            remote_fix_required: true,
            remote_fix_commits: 1,
            remote_fix_outcome: 'fixed',
          },
          operator_override: {
            applied: false,
          },
          timeline: {
            local_start: '2026-08-03T12:00:00.000Z',
            local_end: '2026-08-03T12:02:00.000Z',
            pr_created: '2026-08-03T12:05:00.000Z',
            remote_ci_start: '2026-08-03T12:06:00.000Z',
            remote_ci_first_green: '2026-08-03T12:20:00.000Z',
          },
        },
      }),
      { file: 'evals.jsonl', line: 1 },
    );
    assert.ok(!validIssues.some((issue) => issue.code === 'SCHEMA_VIOLATION'));

    const invalidIssues = validateEvalRecord(
      makeRecord({
        verificationTelemetry: {
          local_verification: {
            ran: true,
            passed: false,
            first_failure_category: 'security' as 'lint',
          },
        },
      }),
      { file: 'evals.jsonl', line: 1 },
    );
    assert.ok(invalidIssues.some((issue) => issue.code === 'SCHEMA_VIOLATION' && issue.detail === 'verificationTelemetry.local_verification.first_failure_category'));
  });

  it('emits verification telemetry diagnostics without making warnings fatal', () => {
    const diagnostics = validateVerificationTelemetry({
      verificationTelemetry: {
        schema_version: '1.0',
        local_verification: {
          ran: true,
          passed: false,
        },
      },
    });

    assert.deepEqual(diagnostics, [
      {
        field: 'verificationTelemetry.local_verification',
        message: 'Failed verification should include failure category.',
        severity: 'warning',
      },
    ]);
  });

  it('reports missing taskDescriptor variants', () => {
    const missingIssues = validateEvalRecord(
      makeRecord({ taskDescriptor: undefined }),
      { file: 'evals.jsonl', line: 1 },
    );
    assert.ok(missingIssues.some((issue) => issue.code === 'EVAL_MISSING_TASK_DESCRIPTOR'));

    const nullIssues = validateEvalRecord(
      makeRecord({ taskDescriptor: null as unknown as EvalRecord['taskDescriptor'] }),
      { file: 'evals.jsonl', line: 1 },
    );
    assert.ok(nullIssues.some((issue) => issue.code === 'EVAL_MISSING_TASK_DESCRIPTOR'));

    const stringIssues = validateEvalRecord(
      { ...makeRecord(), taskDescriptor: '   ' },
      { file: 'evals.jsonl', line: 1 },
    );
    assert.ok(stringIssues.some((issue) => issue.code === 'EVAL_MISSING_TASK_DESCRIPTOR'));
  });

  it('reports empty models_available variants', () => {
    const missingIssues = validateEvalRecord(
      makeRecord({
        taskDescriptor: {
          ...makeTaskDescriptor(),
          constraints: {
            objective: 'balanced',
          } as NonNullable<EvalRecord['taskDescriptor']>['constraints'],
        },
      }),
      { file: 'evals.jsonl', line: 1 },
    );
    assert.ok(missingIssues.some((issue) => issue.code === 'EVAL_EMPTY_MODELS_AVAILABLE'));

    const nonArrayIssues = validateEvalRecord(
      {
        ...makeRecord(),
        taskDescriptor: {
          ...makeTaskDescriptor(),
          constraints: {
            ...makeTaskDescriptor().constraints,
            models_available: 'gpt-5.4' as unknown as string[],
          },
        },
      },
      { file: 'evals.jsonl', line: 1 },
    );
    assert.ok(nonArrayIssues.some((issue) => issue.code === 'EVAL_EMPTY_MODELS_AVAILABLE'));

    const emptyIssues = validateEvalRecord(
      makeRecord({
        taskDescriptor: {
          ...makeTaskDescriptor(),
          constraints: {
            ...makeTaskDescriptor().constraints,
            models_available: [],
          },
        },
      }),
      { file: 'evals.jsonl', line: 1 },
    );
    assert.ok(emptyIssues.some((issue) => issue.code === 'EVAL_EMPTY_MODELS_AVAILABLE'));
  });

  it('reports unknown non-reviewer stage models', () => {
    const issues = validateEvalRecord(
      makeRecord({
        taskDescriptor: {
          ...makeTaskDescriptor(),
          stages: {
            planner: { model: 'missing-model' },
          },
        },
      }),
      { file: 'evals.jsonl', line: 1 },
    );
    assert.ok(issues.some((issue) => issue.code === 'EVAL_UNKNOWN_STAGE_MODEL'));
  });

  it('accepts aliased and canonical reviewer models and rejects stray reviewer text', () => {
    const aliasedIssues = validateEvalRecord(
      makeRecord({
        taskDescriptor: {
          ...makeTaskDescriptor(),
          stages: {
            reviewer: { model: 'deep' },
          },
        },
      }),
      { file: 'evals.jsonl', line: 1 },
    );
    assert.ok(!aliasedIssues.some((issue) => issue.code === 'EVAL_NONCANONICAL_REVIEWER'));

    const canonicalIssues = validateEvalRecord(
      makeRecord({
        taskDescriptor: {
          ...makeTaskDescriptor(),
          stages: {
            reviewer: { model: 'gpt-5.4' },
          },
        },
      }),
      { file: 'evals.jsonl', line: 1 },
    );
    assert.ok(!canonicalIssues.some((issue) => issue.code === 'EVAL_NONCANONICAL_REVIEWER'));

    const strayIssues = validateEvalRecord(
      makeRecord({
        taskDescriptor: {
          ...makeTaskDescriptor(),
          stages: {
            reviewer: { model: 'some-reviewer' },
          },
        },
      }),
      { file: 'evals.jsonl', line: 1 },
    );
    assert.ok(strayIssues.some((issue) => issue.code === 'EVAL_NONCANONICAL_REVIEWER'));
  });

  it('SCHEMA_VIOLATION nonRewardReason message includes failing schema paths', () => {
    const issues = validateEvalRecord(
      makeRecord({
        routeProvenance: {
          bootstrapRoute: {
            coder: 1 as unknown as string,
            codeDepth: 'medium',
            reviewer: 'claude-opus-4-6',
            reviewMode: 'llm',
          },
        },
      }),
      { file: 'evals.jsonl', line: 1 },
    );

    const reason = deriveNonRewardReasonFromIssues(issues);
    assert.equal(reason?.code, 'SCHEMA_VIOLATION');
    assert.match(reason?.message ?? '', /routeProvenance\.bootstrapRoute\.coder/);
  });

  it('Record with valid full routeProvenance does not get SCHEMA_VIOLATION', () => {
    const issues = validateEvalRecord(
      makeRecord({
        routeProvenance: {
          decisionSource: 'expanded',
          bootstrapRoute: {
            coder: 'claude-sonnet-5',
            codeDepth: 'medium',
            reviewer: 'claude-opus-4-6',
            reviewMode: 'llm',
            planner: 'claude-sonnet-5',
            planDepth: 'deep',
            artifactPath: 'features/HOK-2071/.initial-route.json',
            artifactHash: 'a'.repeat(64),
            inputHash: 'b'.repeat(64),
            source: 'bootstrap',
            cacheHit: false,
            routeSource: 'batch',
            routerMode: 'normal',
            routingMode: 'stage-aware',
            expectedMetrics: { expectedSuccess: 0.92 },
          },
          expandedRoute: {
            coder: 'gpt-5.4',
            codeDepth: 'deep',
            reviewer: 'claude-sonnet-5',
            reviewMode: 'static',
            planner: 'gpt-5.4',
            planDepth: 'deep',
            artifactPath: 'features/HOK-2071/.post-expansion-route.json',
            artifactHash: 'c'.repeat(64),
            inputHash: 'd'.repeat(64),
            source: 'expanded',
            cacheHit: true,
            routeSource: 'cache',
            routerMode: 'survival',
            routingMode: 'stage-aware',
            expectedMetrics: { expectedSuccess: 0.97 },
          },
          activeRoute: {
            coder: 'gpt-5.4',
            codeDepth: 'deep',
            reviewer: 'claude-sonnet-5',
            reviewMode: 'static',
            planner: 'gpt-5.4',
            planDepth: 'deep',
            artifactPath: 'features/HOK-2071/.routing-complete.json',
            artifactHash: 'e'.repeat(64),
            inputHash: 'f'.repeat(64),
            source: 'active',
            cacheHit: true,
            routeSource: 'single',
            routerMode: 'constrained',
            routingMode: 'stage-aware',
            expectedMetrics: { expectedSuccess: 0.95 },
          },
          routeChanged: true,
          expandedCacheHit: true,
          packetHash: '1'.repeat(64),
          routeSource: 'cache',
          routerMode: 'survival',
          routingMode: 'stage-aware',
          artifactPath: 'features/HOK-2071',
          artifactHash: '2'.repeat(64),
        },
      }),
      { file: 'evals.jsonl', line: 1 },
    );

    assert.ok(!issues.some((issue) => issue.code === 'SCHEMA_VIOLATION'));
  });
});
