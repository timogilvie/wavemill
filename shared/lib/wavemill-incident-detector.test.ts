import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DependencyHealthDetector,
  detectIncidentsForRepo,
  JobFailureDetector,
  PlanningFailureDetector,
  StalledLifecycleCorrelator,
  WorkflowStateDetector,
} from './wavemill-incident-detector.ts';
import { canonicalizeRootCauseClass, INCIDENT_ROOT_CAUSE_CLASSES, validateRemediationProposal, type IncidentRecord } from './wavemill-incident-model.ts';
import { IncidentStore } from './wavemill-incident-store.ts';

const now = new Date('2026-08-03T12:00:00.000Z');

test('planning detector classifies turn_limit as model/task/harness outcome', () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-planning-'));
  try {
    writeFileSync(join(dir, '.planning-result.json'), JSON.stringify({
      status: 'failed',
      failureReason: 'turn_limit',
      agent: 'codex',
      model: 'gpt-5',
      finishedAt: now.toISOString(),
    }));

    const incidents = new PlanningFailureDetector().detect(dir, 'HOK-1234_c', { repoDir: dir, now });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].category, 'model_task_harness_outcome');
    assert.equal(incidents[0].rootCauseClass, 'turn_limit');
    assert.equal(incidents[0].confidence, 'definite');
    assert.match(incidents[0].evidence[0].redactedData, /planner=codex/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow detector reports orphaned completion marker without result', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-workflow-'));
  const feature = join(repo, 'features', 'example');
  try {
    mkdirSync(feature, { recursive: true });
    mkdirSync(join(repo, '.wavemill'), { recursive: true });
    writeFileSync(join(feature, '.coding-complete'), '');
    writeFileSync(join(repo, '.wavemill', 'workflow-state.json'), JSON.stringify({
      tasks: { 'HOK-1_c': { phase: 'coding' } },
    }));

    const incidents = new WorkflowStateDetector().detect(feature, 'HOK-1_c', { repoDir: repo, now });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].category, 'stale_orphaned_state');
    assert.equal(incidents[0].rootCauseClass, 'orphaned_completion_marker');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('job detector distinguishes missing eval records for failed comparison', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-jobs-'));
  try {
    mkdirSync(join(repo, '.wavemill', 'jobs'), { recursive: true });
    writeFileSync(join(repo, '.wavemill', 'jobs', 'comparison.json'), JSON.stringify({
      id: 'comparison-HOK-1_c-123',
      kind: 'comparison',
      status: 'failed',
      issueId: 'HOK-1_c',
      reason: 'missing eval records',
      finishedAt: now.toISOString(),
    }));

    const incidents = new JobFailureDetector().detect(repo, 'HOK-1_c', { repoDir: repo, now });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].category, 'stale_orphaned_state');
    assert.equal(incidents[0].rootCauseClass, 'missing_eval_records_for_comparison');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('job detector attributes comparison failures from job subject instead of active task', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-jobs-subject-'));
  try {
    mkdirSync(join(repo, '.wavemill', 'jobs'), { recursive: true });
    writeFileSync(join(repo, '.wavemill', 'jobs', 'comparison.json'), JSON.stringify({
      id: 'comparison-HOK-2607-1046-1048',
      kind: 'comparison',
      status: 'failed',
      issueId: 'HOK-2841',
      reason: 'missing eval records',
      finishedAt: now.toISOString(),
    }));

    const activeTaskIncidents = new JobFailureDetector().detect(repo, 'HOK-2841', { repoDir: repo, now });
    const repoIncidents = new JobFailureDetector().detect(repo, null, { repoDir: repo, now });
    assert.equal(activeTaskIncidents.length, 0);
    assert.equal(repoIncidents.length, 1);
    assert.equal(repoIncidents[0].taskId, 'HOK-2607');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('root cause canonicalization is bounded and merges same-class parse errors', () => {
  const offsetA = canonicalizeRootCauseClass('error_failed_to_parse_backlog_json_from_stdin_unexpected_token_h_this_is_loa_is_');
  const offsetB = canonicalizeRootCauseClass('error_failed_to_parse_backlog_json_from_stdin_unexpected_token_i_in_tools_is_not');
  assert.equal(offsetA, 'local_parse_failure');
  assert.equal(offsetA, offsetB);

  // Typed native completion-protocol reasons (HOK-2933) route local, not remote.
  assert.equal(canonicalizeRootCauseClass('native-completion-protocol'), 'native_completion_protocol_failure');
  assert.equal(canonicalizeRootCauseClass('native_coding_completed_without_coding_complete_or_coding_blocked_completion_jso'), 'native_completion_protocol_failure');
  assert.equal(canonicalizeRootCauseClass('blocked_completion_auto_advance_refused_because_a_live_blocking_command_is_still'), 'harness_liveness_deadlock');
  assert.equal(canonicalizeRootCauseClass('github ssh probe failed'), 'remote_ssh_failure');
  assert.equal(canonicalizeRootCauseClass('some brand new failure text'), 'unclassified_local_failure');

  const classes = new Set<string>(INCIDENT_ROOT_CAUSE_CLASSES);
  for (const raw of ['turn_limit', 'orphaned_completion_marker', 'gibberish %% error', 'timed out talking upstream']) {
    assert.ok(classes.has(canonicalizeRootCauseClass(raw)));
  }
});

test('queue detector routes local parse failures to configuration, not external dependency', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-deps-local-'));
  try {
    mkdirSync(join(repo, '.wavemill'), { recursive: true });
    writeFileSync(join(repo, '.wavemill', 'queue-health.json'), JSON.stringify({
      status: 'degraded',
      degradationReason: 'dependency_planning_failed',
      failureCount: 3,
      diagnostics: { structuredReason: 'error failed to parse backlog JSON from stdin unexpected token h' },
      lastAttemptAt: now.toISOString(),
    }));

    const incidents = new DependencyHealthDetector({ thresholdConsecutiveFailures: 3 }).detectRepo(repo, { repoDir: repo, now });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].category, 'configuration_operator_condition');
    assert.equal(incidents[0].rootCauseClass, 'local_parse_failure');
    assert.doesNotMatch(incidents[0].summary, /remote/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('queue detector falls back to bounded queue_planner_degraded class for unknown diagnostics', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-deps-unknown-'));
  try {
    mkdirSync(join(repo, '.wavemill'), { recursive: true });
    writeFileSync(join(repo, '.wavemill', 'queue-health.json'), JSON.stringify({
      status: 'degraded',
      degradationReason: 'dependency_planning_failed',
      failureCount: 1,
      diagnostics: { structuredReason: 'some novel failure text nobody classified' },
      lastAttemptAt: now.toISOString(),
    }));

    const incidents = new DependencyHealthDetector({ thresholdConsecutiveFailures: 3 }).detectRepo(repo, { repoDir: repo, now });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].rootCauseClass, 'queue_planner_degraded');
    assert.equal(incidents[0].category, 'configuration_operator_condition');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('queue detector escalates repeated inference_unavailable by consecutive inference failures (HOK-3130)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-deps-inference-'));
  try {
    mkdirSync(join(repo, '.wavemill'), { recursive: true });
    const writeHealth = (consecutiveFailures: number) => writeFileSync(join(repo, '.wavemill', 'queue-health.json'), JSON.stringify({
      status: 'degraded',
      degradationReason: 'inference_unavailable',
      failureStep: 'queue_inference',
      failureCount: 0,
      inferenceStatus: 'failed',
      inference: { consecutiveFailures, error: 'LLM fallback deadline exhausted before claude-sonnet-5' },
      diagnostics: { inputSnapshot: {}, stdoutExcerpt: '', stderrExcerpt: '' },
      lastAttemptAt: now.toISOString(),
    }));

    writeHealth(3);
    const repeated = new DependencyHealthDetector({ thresholdConsecutiveFailures: 3 }).detectRepo(repo, { repoDir: repo, now });
    assert.equal(repeated.length, 1);
    assert.equal(repeated[0].severity, 'medium');
    assert.match(repeated[0].summary, /inference_unavailable/);
    assert.match(repeated[0].operatorAction, /explicit Linear relations only/);
    assert.equal(repeated[0].metadata?.failureCount, 3);

    writeHealth(1);
    const first = new DependencyHealthDetector({ thresholdConsecutiveFailures: 3 }).detectRepo(repo, { repoDir: repo, now });
    assert.equal(first[0].severity, 'low');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('job detector keeps a stable terminal event timestamp for un-reaped failures', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-jobs-stable-'));
  try {
    mkdirSync(join(repo, '.wavemill'), { recursive: true });
    writeFileSync(join(repo, '.wavemill', 'workflow-state.json'), JSON.stringify({
      jobs: [{
        id: 'eval-HOK-2893-primary-1265',
        kind: 'eval',
        status: 'failed',
        issueId: 'HOK-2893',
        finishedAt: '2026-08-27T23:58:01.000Z',
        reason: 'exit 1',
      }],
    }));

    const first = new JobFailureDetector().detect(repo, null, { repoDir: repo, now });
    const later = new JobFailureDetector().detect(repo, null, { repoDir: repo, now: new Date(now.getTime() + 120_000) });
    assert.equal(first.length, 1);
    // Evidence identity is the terminal event time, so repeated polls of the
    // same dead job describe the same source event.
    assert.equal(first[0].evidence[0].timestamp, '2026-08-27T23:58:01.000Z');
    assert.equal(later[0].evidence[0].timestamp, first[0].evidence[0].timestamp);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('dependency detector preserves structured queue fallback reason', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-deps-'));
  try {
    mkdirSync(join(repo, '.wavemill'), { recursive: true });
    writeFileSync(join(repo, '.wavemill', 'queue-health.json'), JSON.stringify({
      status: 'degraded',
      degradationReason: 'dependency_planning_failed',
      failureCount: 3,
      diagnostics: { structuredReason: 'github_ssh_probe_failed' },
      lastAttemptAt: now.toISOString(),
    }));

    const incidents = new DependencyHealthDetector({ thresholdConsecutiveFailures: 3 }).detect(repo, 'HOK-1_c', { repoDir: repo, now });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].taskId, null);
    assert.equal(incidents[0].category, 'external_transient_dependency');
    assert.equal(incidents[0].severity, 'medium');
    assert.match(incidents[0].evidence[0].redactedData, /github_ssh_probe_failed/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('job detector enriches failed job with module_export_contract_mismatch from log file (HOK-2845 fixture)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-jobs-module-export-'));
  try {
    mkdirSync(join(repo, '.wavemill', 'jobs'), { recursive: true });
    const logPath = join(repo, '.wavemill', 'jobs', 'HOK-2845_c.log');
    writeFileSync(logPath, [
      '[info] starting eval',
      "SyntaxError: The requested module '@hokusai/core' does not provide an export named 'deriveTaskDescriptor'",
      '  at file.js:12:5',
    ].join('\n'));
    writeFileSync(join(repo, '.wavemill', 'jobs', 'eval.json'), JSON.stringify({
      id: 'eval-HOK-2845_c-1',
      kind: 'eval',
      status: 'failed',
      issueId: 'HOK-2845_c',
      reason: 'no_result_file',
      finishedAt: now.toISOString(),
      logPath,
    }));

    const incidents = new JobFailureDetector().detect(repo, null, { repoDir: repo, now });
    assert.equal(incidents.length, 1);
    const incident = incidents[0];
    assert.equal(incident.rootCauseClass, 'module_export_contract_mismatch');
    assert.equal(incident.category, 'product_defect');
    assert.equal(incident.metadata.observedSymptom, 'failed_job_no_result');
    assert.equal(incident.metadata.diagnosedClass, 'module_export_contract_mismatch');
    assert.equal(incident.metadata.logExcerptSource, 'log_head_tail');

    const logExcerpt = incident.evidence.find((item) => item.type === 'log_excerpt');
    assert.ok(logExcerpt, 'expected a log_excerpt evidence item');
    assert.equal(logExcerpt!.key, 'diag:module_export_contract_mismatch');
    assert.match(logExcerpt!.redactedData, /does not provide an export named/);
    assert.doesNotMatch(logExcerpt!.redactedData, /supersecret|Bearer\s+[A-Za-z0-9]/);

    const jobEvidence = incident.evidence.find((item) => item.type === 'job_state');
    assert.ok(jobEvidence, 'expected job_state evidence to be preserved as observed symptom');
    assert.equal(jobEvidence!.key, 'observed:failed_job_no_result');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('job detector prefers persisted job.error over reading the log file', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-jobs-persisted-error-'));
  try {
    mkdirSync(join(repo, '.wavemill', 'jobs'), { recursive: true });
    // logPath deliberately points to a nonexistent file: persisted error path must be used.
    writeFileSync(join(repo, '.wavemill', 'jobs', 'eval.json'), JSON.stringify({
      id: 'eval-HOK-2845_c-2',
      kind: 'eval',
      status: 'failed',
      issueId: 'HOK-2845_c',
      reason: 'no_result_file',
      finishedAt: now.toISOString(),
      excerpt: "SyntaxError: The requested module '@hokusai/core' does not provide an export named 'deriveTaskDescriptor'",
      logPath: join(repo, 'does-not-exist.log'),
    }));

    const incidents = new JobFailureDetector().detect(repo, null, { repoDir: repo, now });
    assert.equal(incidents[0].rootCauseClass, 'module_export_contract_mismatch');
    assert.equal(incidents[0].metadata.logExcerptSource, 'persisted_error');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('job detector fingerprint is stable across stack-frame drift for the same diagnosed class', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-jobs-fingerprint-'));
  try {
    mkdirSync(join(repo, '.wavemill', 'jobs'), { recursive: true });
    const jobPath = join(repo, '.wavemill', 'jobs', 'eval.json');
    writeFileSync(jobPath, JSON.stringify({
      id: 'eval-HOK-2845_c-3',
      kind: 'eval',
      status: 'failed',
      issueId: 'HOK-2845_c',
      reason: 'no_result_file',
      finishedAt: now.toISOString(),
      excerpt: "SyntaxError: does not provide an export named 'x'\n  at foo.js:12:5",
    }));
    const first = new JobFailureDetector().detect(repo, null, { repoDir: repo, now })[0];

    // Simulate a re-run with a shifted stack frame but the same class.
    writeFileSync(jobPath, JSON.stringify({
      id: 'eval-HOK-2845_c-3',
      kind: 'eval',
      status: 'failed',
      issueId: 'HOK-2845_c',
      reason: 'no_result_file',
      finishedAt: now.toISOString(),
      excerpt: "SyntaxError: does not provide an export named 'x'\n  at bar.js:987:3",
    }));
    const second = new JobFailureDetector().detect(repo, null, { repoDir: repo, now })[0];

    const store = new IncidentStore(mkdtempSync(join(tmpdir(), 'incident-fp-store-')));
    assert.equal(store.computeFingerprint(first), store.computeFingerprint(second));

    // Repeated poll (identical inputs, later `now`) yields identical event key.
    const later = new JobFailureDetector().detect(repo, null, { repoDir: repo, now: new Date(now.getTime() + 60_000) })[0];
    assert.equal(store.computeEventKey(second), store.computeEventKey(later));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('job detector degrades to generic failed_job_no_result when logPath is missing and no persisted error', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-jobs-degrade-'));
  try {
    mkdirSync(join(repo, '.wavemill', 'jobs'), { recursive: true });
    writeFileSync(join(repo, '.wavemill', 'jobs', 'eval.json'), JSON.stringify({
      id: 'eval-HOK-2845_c-4',
      kind: 'eval',
      status: 'failed',
      issueId: 'HOK-2845_c',
      reason: 'no_result_file',
      finishedAt: now.toISOString(),
    }));

    const incidents = new JobFailureDetector().detect(repo, null, { repoDir: repo, now });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].rootCauseClass, 'failed_job_no_result');
    assert.equal(incidents[0].category, 'stale_orphaned_state');
    assert.equal(incidents[0].metadata.observedSymptom, 'failed_job_no_result');
    assert.equal(incidents[0].metadata.diagnosedClass, null);
    assert.equal(incidents[0].metadata.logExcerptSource, 'unavailable');
    assert.equal(incidents[0].evidence.some((item) => item.type === 'log_excerpt'), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('job detector degrades safely when logPath is binary', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-jobs-binary-'));
  try {
    mkdirSync(join(repo, '.wavemill', 'jobs'), { recursive: true });
    const logPath = join(repo, '.wavemill', 'jobs', 'HOK.log');
    writeFileSync(logPath, Buffer.from([0, 1, 2, 3, 4, 5]));
    writeFileSync(join(repo, '.wavemill', 'jobs', 'eval.json'), JSON.stringify({
      id: 'eval-HOK-2845_c-5',
      kind: 'eval',
      status: 'failed',
      issueId: 'HOK-2845_c',
      reason: 'no_result_file',
      finishedAt: now.toISOString(),
      logPath,
    }));

    const incidents = new JobFailureDetector().detect(repo, null, { repoDir: repo, now });
    assert.equal(incidents[0].rootCauseClass, 'failed_job_no_result');
    assert.equal(incidents[0].metadata.logExcerptSource, 'unavailable');
    assert.equal(incidents[0].evidence.some((item) => item.type === 'log_excerpt'), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── Original-scope residual gaps (HOK-2595 Phase 6) ──────────────────────────

test('queue fallback carries the structured producer reason, step and planner exit', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-queue-structured-'));
  try {
    mkdirSync(join(repo, '.wavemill'), { recursive: true });
    // Shape written by queue_health_record_failure (queue-health.sh).
    writeFileSync(join(repo, '.wavemill', 'queue-health.json'), JSON.stringify({
      schemaVersion: 1,
      status: 'degraded',
      lastAttemptAt: now.toISOString(),
      degradationReason: 'timeout',
      failureStep: 'plan_queue_failed',
      failureCount: 1,
      planner: { pid: 123, pgid: 123, timeoutSeconds: 60, exitCode: 124, signal: null, cancellationOwner: 'watchdog' },
      diagnostics: { inputSnapshot: { taskCount: 12 }, stdoutExcerpt: '', stderrExcerpt: 'Killed: 9 something about github ssh' },
    }));
    const [incident] = new DependencyHealthDetector({ thresholdConsecutiveFailures: 3 }).detectRepo(repo, { repoDir: repo, now });
    assert.ok(incident);
    // The explicit mapping wins over stderr text that mentions github/ssh.
    assert.equal(incident.rootCauseClass, 'queue_planner_degraded');
    assert.equal(incident.category, 'configuration_operator_condition');
    assert.equal(incident.summary, 'Queue planner fallback is active: timeout (step=plan_queue_failed, exit=124, cancelledBy=watchdog).');
    assert.equal(incident.metadata.failureStep, 'plan_queue_failed');
    assert.equal(incident.metadata.plannerExitCode, 124);
    assert.equal(incident.metadata.diagnosticReason, 'timeout (step=plan_queue_failed, exit=124, cancelledBy=watchdog)');
    assert.notEqual(incident.metadata.diagnosticReason, 'dependency_planning_failed');
    assert.match(incident.evidence[0].redactedData, /step=plan_queue_failed exit=124/);

    writeFileSync(join(repo, '.wavemill', 'queue-health.json'), JSON.stringify({
      status: 'degraded',
      degradationReason: 'malformed_graph',
      failureStep: 'validation_failed',
      failureCount: 4,
      planner: { exitCode: 0 },
      diagnostics: { stderrExcerpt: '' },
    }));
    const [malformed] = new DependencyHealthDetector({ thresholdConsecutiveFailures: 3 }).detectRepo(repo, { repoDir: repo, now });
    assert.equal(malformed.rootCauseClass, 'local_parse_failure');
    assert.equal(malformed.severity, 'medium');

    writeFileSync(join(repo, '.wavemill', 'queue-health.json'), JSON.stringify({
      status: 'degraded',
      degradationReason: 'planner_input_missing',
      failureStep: 'planner_input_missing',
      failureCount: 1,
      planner: { exitCode: 1 },
    }));
    const [missingInput] = new DependencyHealthDetector().detectRepo(repo, { repoDir: repo, now });
    assert.equal(missingInput.rootCauseClass, 'local_config_failure');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a malformed planning result becomes one low-severity coverage incident without content', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-planning-malformed-'));
  try {
    const taskPath = join(repo, 'features', 'broken-plan');
    mkdirSync(taskPath, { recursive: true });
    writeFileSync(join(taskPath, '.planning-result.json'), '{"status": "failed", "prompt": "SECRET PLAN TEXT"');
    const context = { repoDir: repo, now };
    const first = new PlanningFailureDetector().detect(taskPath, 'HOK-77', context);
    assert.equal(first.length, 1);
    assert.equal(first[0].rootCauseClass, 'malformed_stage_artifact');
    assert.equal(first[0].category, 'configuration_operator_condition');
    assert.equal(first[0].severity, 'low');
    assert.doesNotMatch(JSON.stringify(first[0]), /SECRET PLAN TEXT/);

    const store = new IncidentStore(join(repo, '.wavemill', 'incidents'));
    await store.upsert(first[0]);
    await store.upsert(new PlanningFailureDetector().detect(taskPath, 'HOK-77', context)[0]);
    const stored = await store.getIncidents();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].occurrenceCount, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('backstage service probe failures are observed below threshold and degraded at it', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-backstage-threshold-'));
  try {
    mkdirSync(join(repo, '.wavemill'), { recursive: true });
    const writeHealth = (failureCount: number, at: string) => writeFileSync(join(repo, '.wavemill', 'backstage-health.json'), JSON.stringify({
      services: {
        tend: {
          status: failureCount > 0 ? 'degraded' : 'healthy',
          detail: 'backstage tend loop poll failed (transient)',
          failureCount,
          lastError: `transient: git ls-remote origin failed: ssh: connect to host github.com port 22: Operation timed out GH_TOKEN=ghp_${'x'.repeat(30)}`,
          lastErrorAt: at,
          updatedAt: at,
        },
      },
    }));
    const store = new IncidentStore(join(repo, '.wavemill', 'incidents'), { escalationThreshold: 3 });
    const detector = new DependencyHealthDetector({ thresholdConsecutiveFailures: 3 });

    writeHealth(1, '2026-08-03T12:00:00.000Z');
    const [observation] = detector.detectRepo(repo, { repoDir: repo, now });
    assert.equal(observation.rootCauseClass, 'remote_ssh_failure');
    assert.equal(observation.category, 'external_transient_dependency');
    assert.equal(observation.severity, 'low');
    assert.equal(observation.metadata.escalated, false);
    await store.upsert(observation);

    writeHealth(3, '2026-08-03T12:03:00.000Z');
    const [degraded] = detector.detectRepo(repo, { repoDir: repo, now });
    assert.equal(degraded.severity, 'medium');
    assert.equal(degraded.metadata.escalated, true);
    assert.match(degraded.summary, /3 consecutive probe failures/);
    assert.doesNotMatch(JSON.stringify(degraded), /ghp_x{20}/);
    assert.ok(String(degraded.metadata.lastErrorSummary).length <= 260);
    const stored = await store.upsert(degraded);
    // Same record, now medium severity: one-off observation and escalation share identity.
    assert.equal((await store.getIncidents()).length, 1);
    assert.equal(stored.severity, 'medium');
    assert.equal(stored.occurrenceCount, 2);

    writeHealth(0, '2026-08-03T12:05:00.000Z');
    assert.deepEqual(detector.detectRepo(repo, { repoDir: repo, now }), []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── Stalled lifecycle correlation (HOK-2595 reopened) ─────────────────────────
//
// Fixtures write the *real* review StageResult shape produced by
// review-flow.ts buildStageArtifacts + review-runner.ts withDiffBaseMetadata:
// everything nested under `artifacts`, scope under
// `artifacts.diagnostics.metadata.diffBase`.

const SHA = (char: string) => char.repeat(40);

interface RealReviewOptions {
  status?: string;
  verdict?: string;
  failureCategory?: string;
  reviewHeadSha?: string;
  prNumber?: number;
  finishedAt?: string;
  executedModel?: string;
  diffBase?: {
    reviewedBase?: string;
    mergeBaseSha?: string;
    reviewedHead?: string;
    reviewedFileCount?: number;
    kind?: string;
    fetch?: string;
    ref?: string;
  };
}

function writeRealReviewResult(featureDir: string, options: RealReviewOptions): void {
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, '.review-result.json'), JSON.stringify({
    stage: 'review',
    status: options.status ?? 'failed',
    startedAt: '2026-09-04T09:00:00.000Z',
    finishedAt: options.finishedAt ?? '2026-09-04T09:30:00.000Z',
    agent: 'native-openrouter',
    model: 'kimi-k2',
    ...(options.executedModel ? { executedModel: options.executedModel } : {}),
    notes: 'Native review flow failed after 0 findings',
    artifacts: {
      type: 'review',
      ...(options.prNumber ? { prNumber: options.prNumber } : {}),
      verdict: options.verdict ?? 'not_ready',
      ...(options.failureCategory ? { failureCategory: options.failureCategory } : {}),
      ...(options.reviewHeadSha ? { reviewHeadSha: options.reviewHeadSha } : {}),
      ...(options.diffBase ? {
        diagnostics: {
          reviewToolError: 'review failed',
          metadata: { diffBase: { requestedRef: 'auto/integration', ref: options.diffBase.ref ?? 'auto/integration', ...options.diffBase } },
        },
      } : {}),
      review: { status: options.status ?? 'failed', verdict: options.verdict ?? 'not_ready', failureCategory: options.failureCategory },
    },
  }));
}

function writeEnvelope(featureDir: string, envelope: { cause: string; providerErrorKind?: string; provider?: string; model?: string; createdAt?: string }): void {
  writeFileSync(join(featureDir, '.review-failure-envelope.json'), JSON.stringify({
    schemaVersion: '1.0',
    stage: 'review',
    cause: envelope.cause,
    ...(envelope.providerErrorKind ? { providerErrorKind: envelope.providerErrorKind } : {}),
    provider: envelope.provider ?? 'openrouter',
    model: envelope.model ?? 'kimi-k2',
    agent: 'native-openrouter',
    evidence: { source: 'native-loop', detail: 'HTTP 402: Insufficient credits. RAW PROMPT SHOULD NOT LEAK', transcriptPath: '/abs/sessions/review-1329.jsonl' },
    createdAt: envelope.createdAt ?? '2026-09-05T01:00:00.000Z',
  }));
}

function writePrFixture(repo: string, pr: number, options: { head: string; base: string; changedFiles?: number; labels?: string[] }): void {
  mkdirSync(join(repo, '.wavemill', 'prs'), { recursive: true });
  writeFileSync(join(repo, '.wavemill', 'prs', `${pr}.json`), JSON.stringify({
    number: pr,
    headRefOid: options.head,
    baseRefOid: options.base,
    headRefName: `task/pr-${pr}`,
    baseRefName: 'auto/integration',
    ...(options.changedFiles !== undefined ? { changedFiles: options.changedFiles } : {}),
    labels: (options.labels ?? ['wavemill']).map((name) => ({ name })),
  }));
}

function writeWorkflowTasks(repo: string, tasks: Record<string, Record<string, unknown>>, jobs?: Record<string, unknown>): void {
  mkdirSync(join(repo, '.wavemill'), { recursive: true });
  writeFileSync(join(repo, '.wavemill', 'workflow-state.json'), JSON.stringify({ tasks, ...(jobs ? { jobs } : {}) }));
}

/** #1324: native context overflow against a stale local base; PR diff is much smaller. */
function write1324Fixture(repo: string, overrides: Partial<RealReviewOptions> = {}, pr: { changedFiles?: number } = {}): string {
  const featureDir = join(repo, 'features', 'hok-1324');
  writeWorkflowTasks(repo, { 'HOK-1324': { issue: 'HOK-1324', slug: 'hok-1324', worktree: repo, phase: 'ready', pr: '1324' } });
  writeRealReviewResult(featureDir, {
    failureCategory: 'native-context-window-exceeded',
    reviewHeadSha: SHA('a'),
    prNumber: 1324,
    diffBase: { reviewedBase: SHA('0'), mergeBaseSha: SHA('0'), reviewedHead: SHA('a'), reviewedFileCount: 84, kind: 'local', fetch: 'failed', ref: 'main' },
    ...overrides,
  });
  writePrFixture(repo, 1324, { head: SHA('a'), base: SHA('b'), changedFiles: 'changedFiles' in pr ? pr.changedFiles : 12, labels: ['wavemill', 'wm:blocked'] });
  return featureDir;
}

function stallCandidate(pr: number, gate: string, extra: Record<string, unknown> = {}) {
  return {
    pr,
    markerKind: 'merge-lane-idle-stall',
    firstBlockedGate: gate,
    source: 'backstage-health' as const,
    labels: ['wavemill', 'wm:blocked'],
    blockedStreak: 31,
    ...extra,
  };
}

function assertValidProposals(incidents: IncidentRecord[]): void {
  for (const incident of incidents) {
    const result = validateRemediationProposal(incident.metadata.proposal);
    assert.equal(result.ok, true, `invalid proposal for ${incident.rootCauseClass}: ${JSON.stringify(result)}`);
  }
}

test('#1324 real StageResult shape: context overflow on a stale base yields one stale-base incident', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-stalled-1324-'));
  try {
    const featureDir = write1324Fixture(repo);
    const incidents = new StalledLifecycleCorrelator().detect(repo, {
      repoDir: repo,
      now,
      tendCandidates: [stallCandidate(1324, 'ready-failed:not-ready', { taskId: 'HOK-1324' })],
    });

    assert.equal(incidents.length, 1);
    const [incident] = incidents;
    assert.equal(incident.rootCauseClass, 'review_context_overflow_stale_base');
    assert.equal(incident.confidence, 'high');
    assert.equal(incident.taskId, 'HOK-1324');
    const metadata = incident.metadata;
    assert.equal(metadata.prNumber, 1324);
    assert.equal(metadata.taskId, 'HOK-1324');
    assert.equal(metadata.tendGate, 'ready-failed:not-ready');
    assert.equal(metadata.failureCategory, 'native-context-window-exceeded');
    assert.equal(metadata.recordedHead, SHA('a'));
    assert.equal(metadata.recordedBase, SHA('0'));
    assert.equal(metadata.currentHead, SHA('a'));
    assert.equal(metadata.currentBase, SHA('b'));
    assert.equal(metadata.reviewedFileCount, 84);
    assert.equal(metadata.authoritativeFileCount, 12);
    assert.equal(metadata.diffBaseKind, 'local');
    const paths = metadata.artifactPaths as string[];
    assert.ok(paths.includes(join(featureDir, '.review-result.json')));
    assert.ok(paths.includes(join(repo, '.wavemill', 'prs', '1324.json')));
    assert.ok(paths.includes(join(repo, '.wavemill', 'backstage-health.json')));
    assert.deepEqual(metadata.causalChain?.map((entry) => entry.cause), [
      'context_window_exceeded',
      'stale_review_scope',
      'review_not_ready',
      'no_wm_ready',
      'tend_blocked(ready-failed:not-ready)',
    ]);

    assert.match(incident.operatorAction, /^Refresh authoritative base, invalidate stale review evidence, rerun review\./);
    assert.doesNotMatch(incident.operatorAction.replace(/Do not add wm:ready[^.]*\./, ''), /wm:ready|merge/i);

    const proposal = metadata.proposal!;
    assert.equal(proposal.schemaVersion, '1.2');
    assert.equal(proposal.kind, 'refresh_base_and_rereview');
    assert.deepEqual(proposal.allowedActions, ['refresh_authoritative_base', 'invalidate_stale_review_evidence', 'rerun_review']);
    assert.ok(proposal.forbiddenActions.includes('add_ready_label'));
    assert.ok(proposal.forbiddenActions.includes('merge'));
    assert.ok(proposal.forbiddenActions.includes('destructive_git'));
    assert.deepEqual(proposal.target, { issueId: 'HOK-1324', prNumber: 1324, headSha: SHA('a'), baseSha: SHA('b') });
    assert.equal(proposal.retryKey, `refresh-base-rereview:pr:1324:head:${SHA('a')}:base:${SHA('b')}`);
    assert.equal(proposal.recoveryPredicate?.kind, 'review_now_ready');
    assertValidProposals(incidents);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('#1325 matching base/head: context overflow downgrades to a low-confidence inspection', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-stalled-1325-'));
  try {
    const featureDir = join(repo, 'features', 'hok-1325');
    writeWorkflowTasks(repo, { 'HOK-1325': { issue: 'HOK-1325', slug: 'hok-1325', worktree: repo, pr: '1325' } });
    writeRealReviewResult(featureDir, {
      failureCategory: 'native-context-window-exceeded',
      reviewHeadSha: SHA('c'),
      diffBase: { reviewedBase: SHA('d'), mergeBaseSha: SHA('d'), reviewedHead: SHA('c'), reviewedFileCount: 40, kind: 'remote', fetch: 'ok' },
    });
    writePrFixture(repo, 1325, { head: SHA('c'), base: SHA('d'), changedFiles: 40 });

    const incidents = new StalledLifecycleCorrelator().detect(repo, {
      repoDir: repo,
      now,
      tendCandidates: [stallCandidate(1325, 'ready-failed:not-ready', { taskId: 'HOK-1325' })],
    });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].rootCauseClass, 'inspection_required');
    assert.equal(incidents[0].confidence, 'low');
    assert.equal(incidents[0].metadata.inspectionReason, 'contradictory_context_scope_evidence');
    assert.equal(incidents[0].metadata.proposal?.kind, 'inspection_only');
    assert.doesNotMatch(incidents[0].summary, /stale base\b(?!-)/i);
    assertValidProposals(incidents);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('missing PR identity lowers to inspection and never claims stale base', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-stalled-nopr-'));
  try {
    write1324Fixture(repo);
    rmSync(join(repo, '.wavemill', 'prs'), { recursive: true, force: true });
    const incidents = new StalledLifecycleCorrelator().detect(repo, {
      repoDir: repo,
      now,
      tendCandidates: [stallCandidate(1324, 'ready-failed:not-ready', { taskId: 'HOK-1324' })],
    });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].rootCauseClass, 'inspection_required');
    assert.equal(incidents[0].confidence, 'low');
    assert.deepEqual(incidents[0].metadata.missingEvidence, ['pr_identity']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('missing reviewed/authoritative file counts lowers to inspection', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-stalled-nocounts-'));
  try {
    write1324Fixture(repo, {
      diffBase: { reviewedBase: SHA('0'), reviewedHead: SHA('a'), kind: 'local', fetch: 'failed' },
    });
    const incidents = new StalledLifecycleCorrelator().detect(repo, {
      repoDir: repo,
      now,
      tendCandidates: [stallCandidate(1324, 'ready-failed:not-ready', { taskId: 'HOK-1324' })],
    });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].rootCauseClass, 'inspection_required');
    assert.deepEqual(incidents[0].metadata.missingEvidence, ['file_counts']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('review-scope-unverifiable alone is an inspection, not a context overflow', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-stalled-unverifiable-'));
  try {
    write1324Fixture(repo, { failureCategory: 'review-scope-unverifiable' });
    const incidents = new StalledLifecycleCorrelator().detect(repo, {
      repoDir: repo,
      now,
      tendCandidates: [stallCandidate(1324, 'ready-failed:not-ready', { taskId: 'HOK-1324' })],
    });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].rootCauseClass, 'inspection_required');
    assert.equal(incidents[0].metadata.inspectionReason, 'review_scope_unverifiable');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a running review is waiting-for-work, not a stall cause', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-stalled-running-'));
  try {
    write1324Fixture(repo, { status: 'running' });
    const incidents = new StalledLifecycleCorrelator().detect(repo, {
      repoDir: repo,
      now,
      tendCandidates: [stallCandidate(1324, 'ready-failed:not-ready', { taskId: 'HOK-1324' })],
    });
    assert.deepEqual(incidents, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('legacy flat review shape still diagnoses stale-base overflow', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-stalled-legacy-'));
  try {
    const featureDir = join(repo, 'features', 'legacy');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, 'selected-task.json'), JSON.stringify({ taskId: 'HOK-1324' }));
    writeFileSync(join(featureDir, '.review-result.json'), JSON.stringify({
      status: 'not_ready',
      failureCategory: 'context-window-exceeded',
      reviewedHead: 'old-head',
      reviewedBase: 'old-base',
      reviewedFileCount: 40,
      reviewedAt: now.toISOString(),
    }));
    writePrFixture(repo, 1324, { head: 'current-head', base: 'current-base', changedFiles: 12 });
    const incidents = new StalledLifecycleCorrelator().detect(repo, {
      repoDir: repo,
      now,
      tendCandidates: [{ taskId: 'HOK-1324', pr: 1324, markerKind: 'merge-lane-idle-stalled', firstBlockedGate: 'review:not-ready' }],
    });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].rootCauseClass, 'review_context_overflow_stale_base');
    assert.equal(incidents[0].metadata.authoritativeBase, 'current-base');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a candidate with no owning task records missing task evidence', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-stalled-notask-'));
  try {
    writePrFixture(repo, 900, { head: SHA('e'), base: SHA('f'), changedFiles: 3 });
    const incidents = new StalledLifecycleCorrelator().detect(repo, {
      repoDir: repo,
      now,
      tendCandidates: [stallCandidate(900, 'missing-metadata', { headBranch: 'feature/manual' })],
    });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].rootCauseClass, 'inspection_required');
    assert.deepEqual(incidents[0].metadata.missingEvidence, ['task', 'review_result']);
    assert.equal(incidents[0].metadata.tendGate, 'missing-metadata');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// HOK-2934 / PRs #1328 (primary, green) and #1329 (challenger, review failed on 402).
function writeHok2934Pair(repo: string, options: { challengerEnvelope?: boolean; challengerCategory?: string; jobs?: Record<string, unknown> } = {}): void {
  writeWorkflowTasks(repo, {
    'HOK-2934': { issue: 'HOK-2934', slug: 'hok-2934', worktree: repo, phase: 'ready', pr: '1328', challengePairId: 'HOK-2934' },
    'HOK-2934_c': { issue: 'HOK-2934_c', slug: 'hok-2934-challenger', worktree: repo, phase: 'ready', pr: '1329', challengePairId: 'HOK-2934', challengeRole: 'challenger' },
  }, options.jobs);
  writeRealReviewResult(join(repo, 'features', 'hok-2934'), {
    status: 'completed',
    verdict: 'ready',
    reviewHeadSha: SHA('1'),
    prNumber: 1328,
  });
  const challengerDir = join(repo, 'features', 'hok-2934-challenger');
  writeRealReviewResult(challengerDir, {
    status: 'failed',
    verdict: 'error',
    failureCategory: options.challengerCategory ?? 'native-review-failed',
    reviewHeadSha: SHA('2'),
    prNumber: 1329,
    finishedAt: '2026-09-05T01:00:05.000Z',
  });
  if (options.challengerEnvelope !== false) {
    writeEnvelope(challengerDir, { cause: 'provider-credit-exhausted', providerErrorKind: 'insufficient_credits' });
  }
  writePrFixture(repo, 1328, { head: SHA('1'), base: SHA('9'), changedFiles: 6, labels: ['wavemill', 'wm:ready'] });
  writePrFixture(repo, 1329, { head: SHA('2'), base: SHA('9'), changedFiles: 7, labels: ['wavemill'] });
}

const PAIR_GATE = 'challenge:pair-unresolved:no-comparison';

test('HOK-2934 pair: provider 402 on the challenger review yields one root-cause chain', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-pair-2934-'));
  try {
    writeHok2934Pair(repo);
    const incidents = new StalledLifecycleCorrelator().detect(repo, {
      repoDir: repo,
      now,
      tendCandidates: [stallCandidate(1328, PAIR_GATE, { taskId: 'HOK-2934' })],
    });
    assert.equal(incidents.length, 1);
    const [incident] = incidents;
    assert.equal(incident.rootCauseClass, 'provider_quota_exhaustion_blocking_review');
    assert.equal(incident.category, 'external_transient_dependency');
    assert.equal(incident.taskId, 'HOK-2934_c');
    const metadata = incident.metadata;
    assert.equal(metadata.failedSide, 'challenger');
    assert.equal(metadata.failedIssueId, 'HOK-2934_c');
    assert.equal(metadata.failedPrNumber, 1329);
    assert.equal(metadata.blockedIssueId, 'HOK-2934');
    assert.equal(metadata.blockedPrNumber, 1328);
    assert.equal(metadata.pairState, 'blocked_on_provider_recovery');
    assert.equal(metadata.earliestActionableCause, 'provider_credit_exhausted');
    assert.deepEqual(metadata.causalChain?.map((entry) => entry.cause), [
      'provider_credit_exhausted',
      'review_not_ready(native-review-failed)',
      'no_wm_ready(challenger)',
      'no_current_head_eval',
      'no_comparison',
      `tend_blocked(${PAIR_GATE})`,
    ]);
    const proposal = metadata.proposal!;
    assert.deepEqual(proposal.allowedActions, ['retry_same_reviewer_after_provider_recovery', 'terminalize_forfeit_after_policy_exhaustion']);
    for (const action of ['synthesize_winner', 'force_comparison', 'add_ready_label', 'merge'] as const) {
      assert.ok(proposal.forbiddenActions.includes(action), action);
    }
    assert.equal(proposal.recoveryPredicate?.kind, 'review_attempt_progressed');
    assert.equal(proposal.target?.failedSide, 'challenger');
    assert.match(incident.operatorAction, /cannot start until openrouter recovers/);
    assert.doesNotMatch(JSON.stringify(incident), /RAW PROMPT SHOULD NOT LEAK|\/abs\/sessions/);
    assertValidProposals(incidents);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('HOK-2934 pair: primary and challenger candidates dedupe into the same fingerprint', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-pair-dedupe-'));
  try {
    writeHok2934Pair(repo);
    const store = new IncidentStore(join(repo, '.wavemill', 'incidents'));
    const fromPrimary = new StalledLifecycleCorrelator().detect(repo, { repoDir: repo, now, tendCandidates: [stallCandidate(1328, PAIR_GATE, { taskId: 'HOK-2934' })] });
    const fromChallenger = new StalledLifecycleCorrelator().detect(repo, { repoDir: repo, now, tendCandidates: [stallCandidate(1329, PAIR_GATE, { taskId: 'HOK-2934_c' })] });
    const both = new StalledLifecycleCorrelator().detect(repo, {
      repoDir: repo,
      now,
      tendCandidates: [stallCandidate(1328, PAIR_GATE, { taskId: 'HOK-2934' }), stallCandidate(1329, PAIR_GATE, { taskId: 'HOK-2934_c' })],
    });
    assert.equal(fromPrimary.length, 1);
    assert.equal(fromChallenger.length, 1);
    assert.equal(both.length, 1);
    assert.equal(store.computeFingerprint(fromPrimary[0]), store.computeFingerprint(fromChallenger[0]));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('HOK-2934 pair without provider evidence names the failed arm review', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-pair-rereview-'));
  try {
    writeHok2934Pair(repo, { challengerEnvelope: false });
    const incidents = new StalledLifecycleCorrelator().detect(repo, { repoDir: repo, now, tendCandidates: [stallCandidate(1328, PAIR_GATE, { taskId: 'HOK-2934' })] });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].rootCauseClass, 'challenge_arm_review_failed_blocking_pair');
    assert.equal(incidents[0].metadata.pairState, 'blocked_on_rereview');
    assert.equal(incidents[0].metadata.proposal?.kind, 'rereview_failed_challenge_arm');
    assert.equal(incidents[0].metadata.earliestActionableCause, 'review_not_ready(native-review-failed)');
    assertValidProposals(incidents);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('HOK-2934 pair with a running comparison job is waiting for work (no incident)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-pair-waiting-'));
  try {
    writeHok2934Pair(repo, {
      jobs: { 'comparison-HOK-2934': { id: 'comparison-HOK-2934', kind: 'comparison', status: 'running', pairId: 'HOK-2934' } },
    });
    const incidents = new StalledLifecycleCorrelator().detect(repo, { repoDir: repo, now, tendCandidates: [stallCandidate(1328, PAIR_GATE, { taskId: 'HOK-2934' })] });
    assert.deepEqual(incidents, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('HOK-2934 pair with a succeeded comparison clears (no incident)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-pair-compared-'));
  try {
    writeHok2934Pair(repo, {
      jobs: { 'comparison-HOK-2934': { id: 'comparison-HOK-2934', kind: 'comparison', status: 'succeeded', pairId: 'HOK-2934' } },
    });
    const incidents = new StalledLifecycleCorrelator().detect(repo, { repoDir: repo, now, tendCandidates: [stallCandidate(1328, PAIR_GATE, { taskId: 'HOK-2934' })] });
    assert.deepEqual(incidents, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('HOK-2934 pair: provider recovered after the failure means ready for re-review', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-pair-recovered-'));
  try {
    writeHok2934Pair(repo);
    writeFileSync(join(repo, '.wavemill', 'quota-state.json'), JSON.stringify({
      models: { 'kimi-k2': { status: 'healthy', lastSuccessAt: '2026-09-05T04:00:00.000Z' } },
      providers: { openrouter: { balanceUsd: 20, updatedAt: '2026-09-05T04:00:00.000Z' } },
    }));
    const incidents = new StalledLifecycleCorrelator().detect(repo, { repoDir: repo, now, tendCandidates: [stallCandidate(1328, PAIR_GATE, { taskId: 'HOK-2934' })] });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].metadata.pairState, 'ready_for_rereview');
    assert.match(incidents[0].operatorAction, /^Provider has recovered: retry the same reviewer on HOK-2934_c/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('pair with a missing arm is a low-confidence inspection', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-pair-missing-arm-'));
  try {
    writeHok2934Pair(repo);
    writeWorkflowTasks(repo, { 'HOK-2934': { issue: 'HOK-2934', slug: 'hok-2934', worktree: repo, pr: '1328', challengePairId: 'HOK-2934' } });
    const incidents = new StalledLifecycleCorrelator().detect(repo, { repoDir: repo, now, tendCandidates: [stallCandidate(1328, PAIR_GATE, { taskId: 'HOK-2934' })] });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].rootCauseClass, 'inspection_required');
    assert.equal(incidents[0].confidence, 'low');
    assert.deepEqual(incidents[0].metadata.missingEvidence, ['pair_state']);
    assertValidProposals(incidents);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('stalled lifecycle correlator is deterministic for identical snapshots', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-stalled-deterministic-'));
  try {
    writeHok2934Pair(repo);
    const pairTasks = JSON.parse(readFileSync(join(repo, '.wavemill', 'workflow-state.json'), 'utf-8')).tasks;
    write1324Fixture(repo);
    const tasks = JSON.parse(readFileSync(join(repo, '.wavemill', 'workflow-state.json'), 'utf-8')).tasks;
    writeWorkflowTasks(repo, { ...pairTasks, ...tasks });
    const context = {
      repoDir: repo,
      now,
      tendCandidates: [
        stallCandidate(1324, 'ready-failed:not-ready', { taskId: 'HOK-1324' }),
        stallCandidate(1328, PAIR_GATE, { taskId: 'HOK-2934' }),
      ],
    };
    const store = new IncidentStore(join(repo, '.wavemill', 'incidents'));
    const first = new StalledLifecycleCorrelator().detect(repo, context);
    const second = new StalledLifecycleCorrelator().detect(repo, context);
    assert.deepEqual(first.map((incident) => incident.rootCauseClass), ['review_context_overflow_stale_base', 'provider_quota_exhaustion_blocking_review']);
    assert.deepEqual(first, second);
    assert.deepEqual(first.map((incident) => store.computeFingerprint(incident)), second.map((incident) => store.computeFingerprint(incident)));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
