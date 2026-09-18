import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { canonicalizeRootCauseClass, INCIDENT_ROOT_CAUSE_CLASSES } from './wavemill-incident-model.ts';
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

test('stalled lifecycle correlator diagnoses review context overflow on stale base', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-stalled-stale-base-'));
  try {
    writeStalledFixtureBase(repo, {
      taskId: 'HOK-1324',
      slug: 'stale-base-overflow',
      pr: 1324,
      prHead: 'current-head-1324',
      prBase: 'current-base-1324',
      reviewedHead: 'old-head-1324',
      reviewedBase: 'old-base-1324',
      reviewedFileCount: 40,
      currentFileCount: 12,
      failureCategory: 'context-window-exceeded',
    });

    const incidents = new StalledLifecycleCorrelator().detect(repo, {
      repoDir: repo,
      now,
      tendCandidates: [{
        taskId: 'HOK-1324',
        pr: 1324,
        markerKind: 'merge-lane-idle-stall',
        firstBlockedGate: 'review:not-ready',
      }],
    });

    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].rootCauseClass, 'review_context_overflow_stale_base');
    assert.equal(incidents[0].confidence, 'high');
    assert.equal(incidents[0].metadata.authoritativeHead, 'current-head-1324');
    assert.equal(incidents[0].metadata.authoritativeBase, 'current-base-1324');
    assert.equal(incidents[0].metadata.reviewedFileCount, 40);
    assert.equal(incidents[0].metadata.authoritativeFileCount, 12);
    assert.equal(incidents[0].metadata.proposal?.kind, 'refresh_base_and_rereview');
    assert.deepEqual(incidents[0].metadata.proposal?.forbiddenActions, [
      'add_ready_label',
      'merge',
      'destructive_git',
      'delete_branch',
    ]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('stalled lifecycle correlator downgrades contradictory stale-base evidence to inspection', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-stalled-inspection-'));
  try {
    writeStalledFixtureBase(repo, {
      taskId: 'HOK-1325',
      slug: 'stale-base-inspection',
      pr: 1325,
      prHead: 'same-head',
      prBase: 'same-base',
      reviewedHead: 'same-head',
      reviewedBase: 'same-base',
      reviewedFileCount: 12,
      currentFileCount: 12,
      failureCategory: 'context-window-exceeded',
    });

    const incidents = new StalledLifecycleCorrelator().detect(repo, {
      repoDir: repo,
      now,
      tendCandidates: [{
        taskId: 'HOK-1325',
        pr: 1325,
        markerKind: 'merge-lane-idle-stalled',
        firstBlockedGate: 'review:not-ready',
      }],
    });

    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].rootCauseClass, 'inspection_required');
    assert.equal(incidents[0].confidence, 'low');
    assert.equal(incidents[0].metadata.proposal?.kind, 'inspection_only');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('stalled lifecycle correlator identifies provider quota chain for challenge pair', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-stalled-challenge-'));
  try {
    writeChallengeQuotaFixture(repo);

    const incidents = detectIncidentsForRepo(repo, {
      repoDir: repo,
      now,
      tendCandidates: [{
        taskId: 'HOK-1328',
        pr: 1328,
        markerKind: 'merge-lane-idle-stall',
        firstBlockedGate: 'challenge:pair-unresolved',
        pairId: 'HOK-1328-pair',
      }],
    });
    const incident = incidents.find((item) => item.rootCauseClass === 'provider_quota_exhaustion_blocking_review');
    assert.ok(incident);
    assert.equal(incident.metadata.pairId, 'HOK-1328-pair');
    assert.equal(incident.metadata.failedPr, 1328);
    assert.equal(incident.metadata.proposal?.kind, 'provider_retry_or_forfeit_inspection');
    assert.deepEqual(incident.metadata.causalChain?.map((entry) => entry.cause), [
      'provider_quota_failure',
      'review_not_ready',
      'no_ready_label',
      'no_current_head_eval',
      'no_comparison',
    ]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('stalled lifecycle correlator clears when current comparison evidence progresses', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-stalled-recovered-'));
  try {
    writeChallengeQuotaFixture(repo);
    mkdirSync(join(repo, '.wavemill', 'jobs'), { recursive: true });
    writeFileSync(join(repo, '.wavemill', 'jobs', 'comparison-success.json'), JSON.stringify({
      id: 'comparison-HOK-1328-pair',
      kind: 'comparison',
      status: 'succeeded',
      pairId: 'HOK-1328-pair',
      finishedAt: now.toISOString(),
    }));

    const incidents = new StalledLifecycleCorrelator().detect(repo, {
      repoDir: repo,
      now,
      tendCandidates: [{
        taskId: 'HOK-1328',
        pr: 1328,
        markerKind: 'merge-lane-idle-stall',
        pairId: 'HOK-1328-pair',
      }],
    });

    assert.equal(incidents.length, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('stalled lifecycle correlator is deterministic for identical snapshots', () => {
  const repo = mkdtempSync(join(tmpdir(), 'incident-stalled-deterministic-'));
  try {
    writeStalledFixtureBase(repo, {
      taskId: 'HOK-1324',
      slug: 'deterministic-stale-base',
      pr: 1324,
      prHead: 'current-head',
      prBase: 'current-base',
      reviewedHead: 'old-head',
      reviewedBase: 'old-base',
      reviewedFileCount: 30,
      currentFileCount: 10,
      failureCategory: 'context-window-exceeded',
    });
    const context = {
      repoDir: repo,
      now,
      tendCandidates: [{
        taskId: 'HOK-1324',
        pr: 1324,
        markerKind: 'merge-lane-idle-stall',
        firstBlockedGate: 'review:not-ready',
      }],
    };

    const first = new StalledLifecycleCorrelator().detect(repo, context);
    const second = new StalledLifecycleCorrelator().detect(repo, context);
    assert.deepEqual(first, second);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

function writeStalledFixtureBase(repo: string, options: {
  taskId: string;
  slug: string;
  pr: number;
  prHead: string;
  prBase: string;
  reviewedHead: string;
  reviewedBase: string;
  reviewedFileCount: number;
  currentFileCount: number;
  failureCategory: string;
}): void {
  const featureDir = join(repo, 'features', options.slug);
  mkdirSync(featureDir, { recursive: true });
  mkdirSync(join(repo, '.wavemill', 'prs'), { recursive: true });
  writeFileSync(join(featureDir, 'selected-task.json'), JSON.stringify({
    taskId: options.taskId,
    featureName: options.slug,
  }));
  writeFileSync(join(featureDir, '.review-result.json'), JSON.stringify({
    status: 'not_ready',
    failureCategory: options.failureCategory,
    reviewedHead: options.reviewedHead,
    reviewedBase: options.reviewedBase,
    reviewedFileCount: options.reviewedFileCount,
    reviewedAt: now.toISOString(),
  }));
  writeFileSync(join(repo, '.wavemill', 'workflow-state.json'), JSON.stringify({
    tasks: {
      [options.taskId]: {
        issue: options.taskId,
        slug: options.slug,
        worktree: repo,
        phase: 'ready',
      },
    },
  }));
  writeFileSync(join(repo, '.wavemill', 'prs', `${options.pr}.json`), JSON.stringify({
    number: options.pr,
    headRefOid: options.prHead,
    baseRefOid: options.prBase,
    headRefName: `task/${options.taskId}`,
    baseRefName: 'auto/integration',
    files: Array.from({ length: options.currentFileCount }, (_, index) => ({
      path: `src/file-${index}.ts`,
      additions: 1,
      deletions: 0,
    })),
    labels: [{ name: 'wavemill' }],
  }));
}

function writeChallengeQuotaFixture(repo: string): void {
  writeStalledFixtureBase(repo, {
    taskId: 'HOK-1328',
    slug: 'challenge-provider-quota',
    pr: 1328,
    prHead: 'head-1328',
    prBase: 'base-1328',
    reviewedHead: 'head-1328',
    reviewedBase: 'base-1328',
    reviewedFileCount: 10,
    currentFileCount: 10,
    failureCategory: 'provider-credit-exhausted',
  });
  const workflowPath = join(repo, '.wavemill', 'workflow-state.json');
  writeFileSync(workflowPath, JSON.stringify({
    tasks: {
      'HOK-1328': {
        issue: 'HOK-1328',
        slug: 'challenge-provider-quota',
        worktree: repo,
        phase: 'ready',
        challengeRole: 'primary',
        challengePairId: 'HOK-1328-pair',
        comparisonState: 'manual_comparison_needed',
      },
      'HOK-1329': {
        issue: 'HOK-1329',
        slug: 'challenge-provider-quota-peer',
        worktree: repo,
        phase: 'ready',
        challengeRole: 'challenger',
        challengePairId: 'HOK-1328-pair',
        comparisonState: 'manual_comparison_needed',
      },
    },
  }));
  writeFileSync(join(repo, '.wavemill', 'quota-state.json'), JSON.stringify({
    models: {
      'openrouter/provider-model': {
        status: 'exhausted',
        lastLimitErrorAt: now.toISOString(),
      },
    },
  }));
  mkdirSync(join(repo, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(join(repo, '.wavemill', 'evals', 'evals.jsonl'), `${JSON.stringify({
    issueId: 'HOK-1328',
    challengePairId: 'HOK-1328-pair',
    timestamp: now.toISOString(),
    fallbackEvent: {
      outcome: 'all_exhausted',
      task_type: 'review',
      fallback_chain: [{ model: 'openrouter/provider-model', reason: 'quota' }],
    },
  })}\n`);
}
