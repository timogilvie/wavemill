// protects: HOK-3513 — a passed Ready verdict that goes stale because the PR
// stopped being mergeable is withdrawn by the one invalidation and re-runs
// Ready; the watchdog observes and never parks it at needs-user.
//
// The incidents are replayed from the recorded evidence in
// tests/fixtures/ready-verdict-invalidation/hok-3513-post-pass-conflict.json:
// HOK-3493 (2026-11-16T18:01:02Z, ready-stale + pending CI) and HOK-3382
// (2026-11-15T20:01:46Z, merge-candidate + pass CI), both CONFLICTING/DIRTY.
// Each case is driven through the real planner and the real watchdog
// classifier, so the fixture's `expected` block is the oracle.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { planMergeQueueTick, type MergeQueueConfigResolved, type MergeQueueSelectPr } from './merge-queue.ts';
import { classifyReadyTask, type GitHubPRTruth, type ReadyTaskSnapshot } from './ready-watchdog.ts';
import type { ReadyArtifacts, StageResult } from './stage-result.ts';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'tests',
  'fixtures',
  'ready-verdict-invalidation',
  'hok-3513-post-pass-conflict.json',
);

interface IncidentCase {
  name: string;
  protects: string;
  watchdogRow: {
    issueId: string;
    prNumber: number;
    classification: string;
    action: string;
    detail: string;
    observedAt: string;
  };
  readyResult: {
    stage: 'ready';
    status: 'completed';
    agent: string;
    model: string;
    finishedAt: string;
    artifacts: ReadyArtifacts & { candidateSkipReason?: string };
  };
  livePr: {
    prNumber: number;
    state: string;
    baseRefName: string;
    mergeable: string;
    mergeStateStatus: string;
    ciConclusion: string;
    labels: string[];
    checks: unknown[];
  };
  expected: { invalidationCause: string; watchdogKind: string; operatorTouches: number };
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as { cases: IncidentCase[] };

const config: MergeQueueConfigResolved = {
  enabled: true,
  maxConcurrentCandidates: 2,
  stuckTimeoutSeconds: 900,
  conflictGroupingEnabled: true,
  skipCooldownSeconds: 60,
};

/** The planner input the monitor builds for a task with a saved Ready pass. */
function plannerInput(incident: IncidentCase): MergeQueueSelectPr {
  return {
    issue: incident.watchdogRow.issueId,
    slug: incident.watchdogRow.issueId.toLowerCase(),
    prNumber: incident.livePr.prNumber,
    branch: `task/${incident.watchdogRow.issueId.toLowerCase()}`,
    queueState: incident.readyResult.artifacts.queueState,
    readyAt: incident.readyResult.finishedAt,
    changedFiles: [],
    labels: incident.livePr.labels,
    ci: {
      // The planner only enforces the declared conclusion set; the incident's
      // recorded CI conclusion is transcribed in the fixture.
      conclusion: incident.livePr.ciConclusion as 'pass' | 'fail' | 'pending' | 'unknown' | 'none',
      mergeable: incident.livePr.mergeable,
      mergeStateStatus: incident.livePr.mergeStateStatus,
    },
  };
}

function snapshot(incident: IncidentCase): ReadyTaskSnapshot {
  const readyResult = {
    stage: 'ready',
    status: 'completed',
    startedAt: incident.readyResult.finishedAt,
    finishedAt: incident.readyResult.finishedAt,
    agent: incident.readyResult.agent,
    model: incident.readyResult.model,
    notes: null,
    artifacts: incident.readyResult.artifacts,
  } as StageResult;
  return {
    issueId: incident.watchdogRow.issueId,
    slug: incident.watchdogRow.issueId.toLowerCase(),
    branch: `task/${incident.watchdogRow.issueId.toLowerCase()}`,
    worktree: `/tmp/${incident.watchdogRow.issueId}`,
    prNumber: incident.livePr.prNumber,
    controllerPhase: 'ready',
    controllerUpdatedAt: incident.readyResult.finishedAt,
    currentAgent: incident.readyResult.agent,
    currentModel: incident.readyResult.model,
    challengePairId: null,
    readyStateDir: `/tmp/${incident.watchdogRow.issueId}/ready`,
    readyResult,
    readyArtifacts: incident.readyResult.artifacts,
    readyResultStatus: 'completed',
    readyVerdict: incident.readyResult.artifacts.verdict ?? null,
    readyAttentionDetail: null,
    hasNeedsAttention: false,
    hasConflictMarker: false,
    currentHead: null,
    remediationDisposition: {
      kind: 'inactive',
      reason: 'not-running',
      remediation: null,
      launchHead: null,
      currentHead: null,
      launchedAt: null,
    },
    worktreeMergeState: {
      mergeHead: null,
      unmergedPaths: [],
      stagedPaths: [],
      unstagedPaths: [],
      untrackedPaths: [],
      rawStatus: [],
    },
    relevantJobs: [],
    lastProgressAt: incident.watchdogRow.observedAt,
    idleMinutes: 30,
    backstageHealth: null,
  } as ReadyTaskSnapshot;
}

function githubTruth(incident: IncidentCase): GitHubPRTruth {
  return {
    state: incident.livePr.state,
    mergeable: incident.livePr.mergeable,
    mergeStateStatus: incident.livePr.mergeStateStatus,
    baseRefName: incident.livePr.baseRefName,
    checks: [],
  };
}

for (const incident of fixture.cases) {
  test(`replay: ${incident.name}`, (t) => {
    t.diagnostic(`protects: ${incident.protects}`);

    // (a) The one invalidation withdraws the verdict, before label exclusion,
    // so a conflicted wm:blocked PR is invalidated rather than merely excluded.
    const plan = planMergeQueueTick({
      readyPrs: [plannerInput(incident)],
      now: incident.watchdogRow.observedAt,
      config,
    });
    const invalidated = plan.invalidatedIssues.find((item) => item.issue === incident.watchdogRow.issueId);
    assert.ok(invalidated, `expected ${incident.watchdogRow.issueId} in invalidatedIssues`);
    assert.equal(invalidated.cause, incident.expected.invalidationCause);
    assert.equal(invalidated.prNumber, incident.livePr.prNumber);
    assert.deepEqual(plan.excludedIssues, [], 'an invalidated PR is not also reported as excluded');
    assert.deepEqual(plan.selectedIssues, [], 'a conflicted PR is never selected');
    assert.deepEqual(plan.stuckIssues, [], 'an invalidated candidate is not demoted as stuck');

    // (b) The watchdog observes: a conflict is a non-paging, monitor-owned wait,
    // never the needs-user park the incident recorded.
    const classification = classifyReadyTask(
      snapshot(incident),
      githubTruth(incident),
      new Date(incident.watchdogRow.observedAt),
      { enabled: true, thresholdMinutes: 10, autoRecover: true, timeoutSeconds: 30 },
    );
    assert.equal(classification.kind, incident.expected.watchdogKind);
    assert.notEqual(classification.kind, incident.watchdogRow.classification, 'the recorded park is unreachable');
    assert.equal(classification.autoRemediable, false);
    assert.match(classification.detail, /conflicts with its base/);
  });
}
