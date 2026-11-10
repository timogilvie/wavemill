// wavemill-test-suite: custom
/**
 * Unit tests for eval-export — flatten, redact, CSV, and JSONL output.
 */

import assert from 'node:assert/strict';
import type { EvalRecord } from './eval-schema.ts';
import {
  flattenRecord,
  redactText,
  toCsv,
  toJsonl,
  exportEvalDataset,
} from './eval-export.ts';
import { redactVerificationTelemetry } from './text-redaction.ts';
import type { ExportRow } from './eval-export.ts';

// ────────────────────────────────────────────────────────────────
// Test Harness
// ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

function makeRecord(overrides?: Partial<EvalRecord>): EvalRecord {
  return {
    id: '550e8400-e29b-41d4-a716-446655440001',
    schemaVersion: '1.0.0',
    originalPrompt: 'Add a logout button to the header',
    modelId: 'claude-opus-4-6',
    modelVersion: 'claude-opus-4-6-20250514',
    score: 0.9,
    scoreBand: 'Minor Feedback',
    timeSeconds: 245,
    timestamp: '2026-02-14T10:30:00Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'Task completed with minor feedback.',
    issueId: 'HOK-500',
    prUrl: 'https://github.com/org/repo/pull/42',
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────
// Flatten Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- Flatten Tests ---\n');

test('flattenRecord produces correct flat row', () => {
  const record = makeRecord();
  const row = flattenRecord(record);

  assert.equal(row.id, record.id);
  assert.equal(row.timestamp, record.timestamp);
  assert.equal(row.prompt_text, record.originalPrompt);
  assert.equal(row.model_id, record.modelId);
  assert.equal(row.model_version, record.modelVersion);
  assert.equal(row.score, record.score);
  assert.equal(row.score_band, record.scoreBand);
  assert.equal(row.time_seconds, record.timeSeconds);
  assert.equal(row.planning_time_seconds, null);
  assert.equal(row.coding_time_seconds, null);
  assert.equal(row.review_time_seconds, null);
  assert.equal(row.intervention_required, false);
  assert.equal(row.intervention_count, 0);
  assert.equal(row.intervention_details, '[]');
  assert.equal(row.issue_id, 'HOK-500');
  assert.equal(row.pr_url, 'https://github.com/org/repo/pull/42');
});

test('flattenRecord preserves null timeSeconds for unknown duration', () => {
  const row = flattenRecord(makeRecord({ timeSeconds: null }));
  assert.equal(row.time_seconds, null);
});

test('flattenRecord computes prompt features correctly', () => {
  const record = makeRecord({
    originalPrompt: 'Hello world\nSecond line\nThird line with more words',
  });
  const row = flattenRecord(record);

  assert.equal(row.prompt_line_count, 3);
  assert.equal(row.prompt_word_count, 9);
  assert.equal(row.prompt_length, record.originalPrompt.length);
});

test('flattenRecord extracts complexity signals from metadata', () => {
  const record = makeRecord({
    metadata: { filesChanged: 5, linesAdded: 120, linesRemoved: 30 },
  });
  const row = flattenRecord(record);

  assert.equal(row.files_changed, 5);
  assert.equal(row.lines_added, 120);
  assert.equal(row.lines_removed, 30);
});

test('flattenRecord returns null for missing complexity signals', () => {
  const record = makeRecord({ metadata: {} });
  const row = flattenRecord(record);

  assert.equal(row.files_changed, null);
  assert.equal(row.lines_added, null);
  assert.equal(row.lines_removed, null);
});

test('flattenRecord handles missing optional fields', () => {
  const record = makeRecord({
    judgeModel: undefined,
    judgeProvider: undefined,
    issueId: undefined,
    prUrl: undefined,
    metadata: undefined,
  });
  const row = flattenRecord(record);

  assert.equal(row.judge_model, '');
  assert.equal(row.judge_provider, '');
  assert.equal(row.issue_id, '');
  assert.equal(row.pr_url, '');
  assert.equal(row.files_changed, null);
  assert.equal(row.planning_outcome_status, '');
  assert.equal(row.planning_outcome_failure_reason, '');
  assert.equal(row.planning_outcome_max_turns, null);
});

test('flattenRecord exports planning execution outcome fields', () => {
  const record = makeRecord({
    planningExecutionOutcome: {
      status: 'failed',
      failureReason: 'turn_limit',
      planArtifactValid: false,
      approvalReady: false,
      bounds: {
        maxTurns: 40,
        maxToolCalls: 120,
        maxWallClockMs: 1200000,
      },
      usage: {
        turnsCompleted: 40,
        toolCallsExecuted: 72,
        wallClockMs: 900000,
        totalInputTokens: 100000,
        totalOutputTokens: 20000,
        totalCostUsd: 0.32,
      },
      source: '.planning-result.json',
    },
  });
  const row = flattenRecord(record);

  assert.equal(row.planning_outcome_status, 'failed');
  assert.equal(row.planning_outcome_failure_reason, 'turn_limit');
  assert.equal(row.planning_outcome_plan_valid, false);
  assert.equal(row.planning_outcome_approval_ready, false);
  assert.equal(row.planning_outcome_max_turns, 40);
  assert.equal(row.planning_outcome_turns_completed, 40);
  assert.equal(row.planning_outcome_max_tool_calls, 120);
  assert.equal(row.planning_outcome_tool_calls_executed, 72);
  assert.equal(row.planning_outcome_max_wall_clock_ms, 1200000);
  assert.equal(row.planning_outcome_wall_clock_ms, 900000);
  assert.equal(row.planning_outcome_input_tokens, 100000);
  assert.equal(row.planning_outcome_output_tokens, 20000);
  assert.equal(row.planning_outcome_cost_usd, 0.32);
});

test('flattenRecord exports resource selection variants', () => {
  const record = makeRecord({
    resourceSelections: [
      {
        surface: 'router',
        variant: 'optimized',
        requestedVariant: 'optimized',
        resourceRef: { id: 'optimizer-artifact:optimized-selector@1.0.0', version: '1.0.0' },
        fallbackApplied: false,
      },
      {
        surface: 'planner',
        variant: 'baseline',
        requestedVariant: 'optimized',
        resourceRef: { id: 'prompt:planning-phase@sha256:abc', version: 'sha256:abc' },
        fallbackApplied: true,
        rejectionReason: 'policy disabled',
      },
    ],
  });
  const row = flattenRecord(record);

  assert.equal(row.router_resource_variant, 'optimized');
  assert.equal(row.planner_prompt_variant, 'baseline');
  assert.equal(row.reviewer_prompt_variant, '');
  assert.match(row.resource_variants, /"surface":"router"/);
});

test('flattenRecord exports rubric fields when present', () => {
  const record = makeRecord({
    rubric_provenance: 'judge',
    rubricEval: {
      schema_version: '1.0',
      rubric_version: '1.0',
      criteria: {
        completeness: { score: 0.91, rationale: 'Complete.' },
        correctness: { score: 0.82, rationale: 'Mostly correct.' },
        code_quality: { score: 0.88, rationale: 'Clean.' },
        intervention_impact: { score: 0.7, rationale: 'One follow-up.' },
        autonomy: { score: 0.74, rationale: 'Mostly autonomous.' },
      },
      determinative_boundary: 'functional_bug',
    },
  });
  const row = flattenRecord(record);

  assert.equal(row.rubric_provenance, 'judge');
  assert.equal(row.rubric_completeness, 0.91);
  assert.equal(row.rubric_correctness, 0.82);
  assert.equal(row.rubric_code_quality, 0.88);
  assert.equal(row.rubric_intervention_impact, 0.7);
  assert.equal(row.rubric_autonomy, 0.74);
  assert.equal(row.rubric_determinative_boundary, 'functional_bug');
});

test('flattenRecord preserves structured routing metadata in JSON export', () => {
  const row = flattenRecord(makeRecord({
    routingDecision: {
      candidates: [{ agentType: 'codex', modelId: 'gpt-5.4' }],
      chosen: 0,
      decisionPolicyVersion: 'stage-aware',
      routeMode: 'stage-aware',
      routeArtifactSchemaVersion: '1.0',
      policyResolverVersion: '1.0.0',
      operatingModeDependency: 'survival',
    },
  }));

  assert.match(row.routing_decision, /"routeMode":"stage-aware"/);
  assert.match(row.routing_decision, /"policyResolverVersion":"1.0.0"/);
});

test('flattenRecord exports route prediction and calibration JSON when present', () => {
  const row = flattenRecord(makeRecord({
    routePrediction: {
      expectedSuccess: 0.8,
      expectedCostUsd: 3.25,
    },
    routeCalibration: {
      costErrorUsd: 0.5,
      successDelta: 0.2,
    },
  }));

  assert.match(row.route_prediction, /"expectedSuccess":0.8/);
  assert.match(row.route_calibration, /"costErrorUsd":0.5/);
});

test('flattenRecord leaves rubric export fields blank when absent', () => {
  const row = flattenRecord(makeRecord());

  assert.equal(row.rubric_provenance, '');
  assert.equal(row.rubric_completeness, null);
  assert.equal(row.rubric_correctness, null);
  assert.equal(row.rubric_code_quality, null);
  assert.equal(row.rubric_intervention_impact, null);
  assert.equal(row.rubric_autonomy, null);
  assert.equal(row.rubric_determinative_boundary, '');
});

test('flattenRecord exports phase duration columns when present', () => {
  const row = flattenRecord(makeRecord({
    phaseDurationsSeconds: {
      planning: 120,
      coding: 480,
      review: 60,
      total: 660,
    },
  }));

  assert.equal(row.time_seconds, 245);
  assert.equal(row.planning_time_seconds, 120);
  assert.equal(row.coding_time_seconds, 480);
  assert.equal(row.review_time_seconds, 60);
});

test('flattenRecord exports verification telemetry columns when present', () => {
  const row = flattenRecord(makeRecord({
    verificationTelemetry: {
      schema_version: '1.0',
      local_verification: {
        ran: true,
        passed: true,
        total_duration_ms: 4200,
      },
      remote_ci_verdict: {
        ran: true,
        passed: false,
        remote_only_failure: true,
      },
      remediation: {
        local_remediation_outcome: 'none',
      },
      operator_override: {
        applied: false,
      },
    },
  }));

  assert.equal(row.verification_local_passed, true);
  assert.equal(row.verification_local_duration_ms, 4200);
  assert.equal(row.verification_local_failure_category, '');
  assert.equal(row.verification_remote_passed, false);
  assert.equal(row.verification_remote_only_failure, true);
  assert.equal(row.verification_remediation_outcome, 'none');
  assert.equal(row.verification_operator_override, false);
});

test('flattenRecord handles missing verification telemetry gracefully', () => {
  const row = flattenRecord(makeRecord());

  assert.equal(row.verification_local_passed, null);
  assert.equal(row.verification_local_duration_ms, null);
  assert.equal(row.verification_local_failure_category, '');
  assert.equal(row.verification_remote_passed, null);
  assert.equal(row.verification_remote_only_failure, false);
  assert.equal(row.verification_remediation_outcome, '');
  assert.equal(row.verification_operator_override, false);
});

// ────────────────────────────────────────────────────────────────
// Redaction Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- Redaction Tests ---\n');

test('redactText replaces email addresses', () => {
  const result = redactText('Contact user@example.com for details');
  assert.equal(result, 'Contact [EMAIL] for details');
});

test('redactText replaces URLs', () => {
  const result = redactText('See https://github.com/org/repo/pull/42 for the PR');
  assert.equal(result, 'See [URL] for the PR');
});

test('redactText replaces absolute file paths', () => {
  const result = redactText('Edit /Users/tim/project/src/index.ts to fix');
  assert.ok(result.includes('[PATH]'));
  assert.ok(!result.includes('/Users/tim'));
});

test('redactText handles multiple patterns in one string', () => {
  const input = 'Email joe@test.com, see https://example.com/page, file /src/lib/foo.ts';
  const result = redactText(input);
  assert.ok(result.includes('[EMAIL]'));
  assert.ok(result.includes('[URL]'));
  assert.ok(result.includes('[PATH]'));
  assert.ok(!result.includes('joe@test.com'));
  assert.ok(!result.includes('https://example.com'));
});

test('flattenRecord applies redaction when redact=true', () => {
  const record = makeRecord({
    originalPrompt: 'Fix bug reported by admin@company.com',
    rationale: 'See https://github.com/org/repo for details',
  });
  const row = flattenRecord(record, { redact: true });

  assert.ok(row.prompt_text.includes('[EMAIL]'));
  assert.ok(!row.prompt_text.includes('admin@company.com'));
  assert.ok(row.rationale.includes('[URL]'));
  assert.ok(!row.rationale.includes('https://github.com'));
});

test('flattenRecord preserves original prompt length even when redacted', () => {
  const record = makeRecord({
    originalPrompt: 'Fix bug reported by admin@company.com',
  });
  const row = flattenRecord(record, { redact: true });

  // prompt_length should reflect the original, not the redacted text
  assert.equal(row.prompt_length, record.originalPrompt.length);
});

test('redactVerificationTelemetry redacts operator override reasons only', () => {
  const telemetry = {
    schema_version: '1.0' as const,
    operator_override: {
      applied: true,
      reason: 'Manual approval from reviewer@example.com for /Users/tim/repo',
    },
    local_verification: {
      ran: true,
      passed: false,
      first_failure_fingerprint: 'a'.repeat(64),
    },
  };
  const redacted = redactVerificationTelemetry(telemetry);

  assert.equal(redacted.local_verification?.first_failure_fingerprint, 'a'.repeat(64));
  assert.ok(redacted.operator_override?.reason?.includes('[EMAIL]'));
  assert.ok(redacted.operator_override?.reason?.includes('[PATH]'));
  assert.ok(!redacted.operator_override?.reason?.includes('reviewer@example.com'));
});

// ────────────────────────────────────────────────────────────────
// CSV Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- CSV Tests ---\n');

test('toCsv emits blank cells for null time_seconds and preserves numeric durations', () => {
  const rows: ExportRow[] = [
    flattenRecord(makeRecord({ id: 'null-row', timeSeconds: null })),
    flattenRecord(makeRecord({ id: 'zero-row', timeSeconds: 0 })),
    flattenRecord(makeRecord({ id: 'positive-row', timeSeconds: 245 })),
  ];
  const csv = toCsv(rows).trimEnd().split('\n');
  const header = csv[0].split(',');
  const timeIndex = header.indexOf('time_seconds');
  const idIndex = header.indexOf('id');

  assert.ok(timeIndex >= 0);
  assert.equal(csv[1].split(',')[idIndex], 'null-row');
  assert.equal(csv[1].split(',')[timeIndex], '');
  assert.equal(csv[2].split(',')[idIndex], 'zero-row');
  assert.equal(csv[2].split(',')[timeIndex], '0');
  assert.equal(csv[3].split(',')[idIndex], 'positive-row');
  assert.equal(csv[3].split(',')[timeIndex], '245');
});

test('toCsv produces header and data rows', () => {
  const rows = [flattenRecord(makeRecord())];
  const csv = toCsv(rows);
  const lines = csv.trim().split('\n');

  assert.equal(lines.length, 2); // header + 1 data row
  assert.ok(lines[0].startsWith('id,'));
  assert.ok(lines[0].includes('prompt_text'));
  assert.ok(lines[0].includes('score'));
});

test('toCsv escapes fields with commas and quotes', () => {
  const record = makeRecord({
    originalPrompt: 'Fix "the bug", please',
    rationale: 'Done, with effort',
  });
  const rows = [flattenRecord(record)];
  const csv = toCsv(rows);

  // The prompt should be quoted and double-quotes escaped
  assert.ok(csv.includes('""the bug""'));
});

test('toCsv column count matches header count', () => {
  const rows = [flattenRecord(makeRecord()), flattenRecord(makeRecord({ id: 'id-2' }))];
  const csv = toCsv(rows);
  const lines = csv.trim().split('\n');
  const headerCols = lines[0].split(',').length;

  for (const line of lines.slice(1)) {
    assert.equal(line.split(',').length, headerCols);
  }
});

// ────────────────────────────────────────────────────────────────
// JSONL Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- JSONL Tests ---\n');

test('toJsonl produces valid JSON per line', () => {
  const rows = [
    flattenRecord(makeRecord({ id: 'r1' })),
    flattenRecord(makeRecord({ id: 'r2' })),
  ];
  const jsonl = toJsonl(rows);
  const lines = jsonl.trim().split('\n');

  assert.equal(lines.length, 2);
  const parsed1 = JSON.parse(lines[0]);
  const parsed2 = JSON.parse(lines[1]);
  assert.equal(parsed1.id, 'r1');
  assert.equal(parsed2.id, 'r2');
});

test('toJsonl includes all fields', () => {
  const row = flattenRecord(makeRecord());
  const jsonl = toJsonl([row]);
  const parsed = JSON.parse(jsonl.trim());

  assert.ok('id' in parsed);
  assert.ok('prompt_text' in parsed);
  assert.ok('prompt_length' in parsed);
  assert.ok('score' in parsed);
  assert.ok('score_band' in parsed);
  assert.ok('files_changed' in parsed);
  assert.ok('lines_added' in parsed);
  assert.ok('rubric_provenance' in parsed);
  assert.ok('rubric_completeness' in parsed);
});

test('flattenRecord includes workflow_cost_status (HOK-883)', () => {
  const recordWithStatus = makeRecord({
    workflowCost: 5.1234,
    workflowCostStatus: 'success' as any,
  });
  const row = flattenRecord(recordWithStatus);
  assert.equal(row.workflow_cost, 5.1234);
  assert.equal(row.workflow_cost_status, 'success');
});

test('flattenRecord handles missing workflow_cost_status', () => {
  const recordWithoutStatus = makeRecord({ workflowCost: 3.14 });
  const row = flattenRecord(recordWithoutStatus);
  assert.equal(row.workflow_cost, 3.14);
  assert.equal(row.workflow_cost_status, '');
});

test('flattenRecord does not export native workflow cost attribution', () => {
  const record = makeRecord({
    workflowCost: 0,
    workflowCostStatus: 'success' as any,
    workflowCostAttribution: {
      source: 'native',
      coverage: 'unavailable',
      reason: 'missing_token_usage',
      sessions: 1,
      turns: 1,
      pricedSessions: 0,
      unpricedSessions: 1,
      models: [{
        provider: 'pi',
        modelId: 'native-model',
        priced: false,
        reason: 'missing_token_usage',
      }],
    },
  });
  const row = flattenRecord(record) as Record<string, unknown>;
  assert.equal(row.workflow_cost, 0);
  assert.equal(row.workflow_cost_status, 'success');
  assert.equal('workflowCostAttribution' in row, false);
  assert.equal('workflow_cost_attribution' in row, false);
});

// ────────────────────────────────────────────────────────────────
// Export Function Tests
// ────────────────────────────────────────────────────────────────

console.log('\n--- Export Function Tests ---\n');

test('exportEvalDataset handles empty records', () => {
  const csv = exportEvalDataset({ format: 'csv', records: [] });
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 1); // header only

  const jsonl = exportEvalDataset({ format: 'jsonl', records: [] });
  assert.equal(jsonl.trim(), '');
});

test('exportEvalDataset respects format selection', () => {
  const records = [makeRecord()];

  const csv = exportEvalDataset({ format: 'csv', records });
  assert.ok(csv.startsWith('id,'));

  const jsonl = exportEvalDataset({ format: 'jsonl', records });
  assert.ok(jsonl.startsWith('{'));
});

test('exportEvalDataset applies redaction', () => {
  const records = [makeRecord({ originalPrompt: 'Email admin@test.com' })];

  const noRedact = exportEvalDataset({ format: 'jsonl', records, redact: false });
  assert.ok(noRedact.includes('admin@test.com'));

  const redacted = exportEvalDataset({ format: 'jsonl', records, redact: true });
  assert.ok(!redacted.includes('admin@test.com'));
  assert.ok(redacted.includes('[EMAIL]'));
});

// ────────────────────────────────────────────────────────────────
// featureOutcomeDiagnostics export columns (HOK-2262)
// ────────────────────────────────────────────────────────────────

test('flattenRecord with featureOutcomeDiagnostics populates all feature_outcome columns', () => {
  const record = makeRecord({
    featureOutcomeDiagnostics: {
      present: true,
      valid: true,
      used: true,
      sourceFile: 'feature-state.json',
      sourceHash: 'a'.repeat(64),
      reason: 'loaded',
      eligibilityDiagnostic: 'eligible',
      missingFields: [],
      invalidFields: [],
      conflictsWithReconstruction: false,
      conflictingFields: [],
    },
  } as unknown as Partial<EvalRecord>);

  const row = flattenRecord(record);
  assert.equal(row.feature_outcome_present, true);
  assert.equal(row.feature_outcome_valid, true);
  assert.equal(row.feature_outcome_used, true);
  assert.equal(row.feature_outcome_source_file, 'feature-state.json');
  assert.equal(row.feature_outcome_source_hash, 'a'.repeat(64));
  assert.equal(row.feature_outcome_reason, 'loaded');
  assert.equal(row.feature_outcome_eligibility_diagnostic, 'eligible');
  assert.equal(row.feature_outcome_missing_fields, '[]');
  assert.equal(row.feature_outcome_invalid_fields, '[]');
  assert.equal(row.feature_outcome_conflicts, false);
  assert.equal(row.feature_outcome_conflicting_fields, '[]');
});

test('flattenRecord without featureOutcomeDiagnostics emits safe defaults', () => {
  const record = makeRecord();
  delete (record as Record<string, unknown>).featureOutcomeDiagnostics;

  const row = flattenRecord(record);
  assert.equal(row.feature_outcome_present, false);
  assert.equal(row.feature_outcome_valid, false);
  assert.equal(row.feature_outcome_used, false);
  assert.equal(row.feature_outcome_source_file, '');
  assert.equal(row.feature_outcome_source_hash, '');
  assert.equal(row.feature_outcome_reason, '');
  assert.equal(row.feature_outcome_eligibility_diagnostic, '');
  assert.equal(row.feature_outcome_conflicts, false);
});

test('flattenRecord with eligibilityErrors and training eligibility', () => {
  const record = makeRecord({
    eligibilityErrors: ['missing_feature_outcome', 'missing_cost'],
    trainingEligible: false,
    budgetEvalEligible: true,
  });

  const row = flattenRecord(record);
  assert.ok(row.eligibility_errors.includes('missing_feature_outcome'));
  assert.equal(row.training_eligible, false);
  assert.equal(row.budget_eval_eligible, true);
});

test('exportEvalDataset omits held training evidence by default', () => {
  const verified = makeRecord({ id: 'verified' });
  const held = makeRecord({
    id: 'held',
    modelIdentityAttribution: {
      observedAt: '2026-08-01T00:00:00.000Z',
      roles: {},
      provisionalRoles: ['coder'],
      candidateOnlyProvisional: [],
    },
  });

  const defaultRows = exportEvalDataset({
    format: 'jsonl',
    records: [verified, held],
  }).trim().split('\n').map((line) => JSON.parse(line));
  const operationalRows = exportEvalDataset({
    format: 'jsonl',
    records: [verified, held],
    includeHeld: true,
  }).trim().split('\n').map((line) => JSON.parse(line));

  assert.deepEqual(defaultRows.map((row) => row.id), ['verified']);
  assert.deepEqual(operationalRows.map((row) => row.id), ['verified', 'held']);
  assert.equal(operationalRows[1].evidence_hold_reasons, '["provisional_model_identity"]');
});

// ────────────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────────────

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);

if (failed > 0) {
  process.exit(1);
}
