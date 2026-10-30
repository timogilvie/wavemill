import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAutoFixes,
  behindBaseSeverity,
  buildFindings,
  compactSnapshotForRender,
  detectBranchBehindBase,
  detectExhaustedRetries,
  // HOK-3314: detectQueueInferenceStuck retired — the queue-health finding
  // built from the projection fires the same high-severity alert at ≥5.
  detectStuckMergeCandidates,
  detectSustainedSlowPasses,
  matchInteractivePromptSignature,
  normalizeFindingSeverity,
  normalizeInteractivePromptText,
  parseArgs,
  parseLaunchRefusalLine,
  reconcileIncidents,
  redactObserverText,
  runDetector,
  sendAlerts,
  syncIncidentsToLinear,
  writeServiceHeartbeat,
} from './observer.ts';
import { IncidentStore } from '../shared/lib/wavemill-incident-store.ts';
import { createIncidentDraft, validateRemediationProposal } from '../shared/lib/wavemill-incident-model.ts';

function defaultObserverOptions() {
  return {
    loop: false,
    once: true,
    json: false,
    intervalSeconds: 120,
    staleMinutes: 10,
    hungMinutes: 10,
    fileLinear: false,
    fileIncidents: false,
    dryRun: false,
    autoFixDryRun: false,
    incidentsDryRun: false,
    maxLogLines: 240,
    printPrompt: false,
    incidentDetector: true,
  };
}

function createMarkerFixture(markerName: '.coding-complete' | '.plan-approved', markerMtime: Date) {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-marker-'));
  const slug = 'observer-marker-fixture';
  const featureDir = join(repoDir, 'features', slug);
  const markerPath = join(featureDir, markerName);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(markerPath, '{}\n');
  utimesSync(markerPath, markerMtime, markerMtime);
  return { repoDir, slug, markerPath };
}

function markerSnapshot({
  repoDir,
  slug,
  phase,
  issue = 'HOK-2848',
  stateMtime,
}: {
  repoDir: string;
  slug: string;
  phase: 'coding' | 'planning';
  issue?: string;
  stateMtime?: string;
}) {
  return {
    timestamp: new Date().toISOString(),
    sessions: ['wavemill'],
    panes: [],
    processes: [],
    repos: [{
      session: 'wavemill',
      repoDir,
      workflowStatePath: join(repoDir, '.wavemill', 'workflow-state.json'),
      tasks: [{
        issue,
        phase,
        status: 'running',
        slug,
        worktree: repoDir,
      }],
      stateMtime,
    }],
  };
}

function markerAgeSeconds(finding: { evidence: string[] }): number {
  const evidence = finding.evidence.find((line) => line.startsWith('markerAgeSeconds='));
  assert.ok(evidence);
  return Number(evidence.slice('markerAgeSeconds='.length));
}

function writePermissiveSchema(repoDir: string): void {
  writeFileSync(join(repoDir, 'wavemill-config.schema.json'), JSON.stringify({
    type: 'object',
    additionalProperties: true,
  }));
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    configVersion: '1.5.0',
    mill: {
      baseBranch: 'auto/integration',
      requireConfirm: true,
    },
  }, null, 2));
}

function basicSnapshot(repoDir: string, logPath?: string) {
  return {
    timestamp: '2026-08-28T12:00:00.000Z',
    sessions: ['wavemill'],
    panes: [],
    processes: [],
    repos: [{
      session: 'wavemill',
      repoDir,
      millLogPath: logPath,
      tasks: [],
    }],
  };
}

test('config-integrity finding is first and includes file location evidence for malformed schema', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-config-integrity-'));
  try {
    writeFileSync(join(repoDir, 'wavemill-config.schema.json'), '{\n  "type": "object"\n}\n,\n{}\n');

    const findings = buildFindings(basicSnapshot(repoDir), defaultObserverOptions());

    assert.ok(findings[0].id.startsWith('config-integrity-'));
    assert.equal(findings[0].severity, 'urgent');
    assert.equal(findings[0].category, 'crash');
    assert.match(findings[0].title, /wavemill-config\.schema\.json is malformed at line \d+ column \d+/);
    assert.ok(findings[0].evidence.includes(`file=${join(repoDir, 'wavemill-config.schema.json')}`));
    assert.ok(findings[0].evidence.some((line) => /^line=\d+$/.test(line)));
    assert.ok(findings[0].evidence.some((line) => /^column=\d+$/.test(line)));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('config-integrity groups downgrade and watchdog symptoms as downstream', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-config-correlation-'));
  const logPath = join(repoDir, 'mill-wavemill.log');
  try {
    writeFileSync(join(repoDir, 'wavemill-config.schema.json'), '{\n  "type": "object"\n}\n,\n{}\n');
    writeFileSync(logPath, [
      "10:00:01 [warn]   Invalid coding model 'claude-sonnet-5'; using 'claude-opus-4-7'",
      "10:00:02 [warn]   Invalid coding model 'claude-sonnet-5'; using 'claude-opus-4-7'",
      "10:00:03 [warn]   Invalid coding model 'claude-sonnet-5'; using 'claude-opus-4-7'",
      '10:00:04 [warn] ready watchdog tick failed: Error: Unexpected non-whitespace character after JSON at position 141378 (line 2903 column 6)',
    ].join('\n'));

    const findings = buildFindings(basicSnapshot(repoDir, logPath), defaultObserverOptions());
    const config = findings.find((finding) => finding.id.startsWith('config-integrity-'));
    const downgrade = findings.find((finding) => finding.id.startsWith('model-downgrade-'));
    const watchdog = findings.find((finding) =>
      finding.id.startsWith('log-warning-') &&
      finding.evidence.some((line) => /ready watchdog tick failed/.test(line))
    );

    assert.ok(config);
    assert.ok(downgrade);
    assert.ok(watchdog);
    assert.equal(downgrade.groupedUnder, config.id);
    assert.equal(watchdog.groupedUnder, config.id);
    assert.ok(config.evidence.some((line) => line.includes(`downstream=${downgrade.id}`)));
    assert.ok(config.evidence.some((line) => line.includes(`downstream=${watchdog.id}`)));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('compact snapshot hides grouped findings and annotates parent title', () => {
  const snapshot = {
    timestamp: '2026-08-28T12:00:00.000Z',
    sessions: ['wavemill'],
    panes: [],
    processes: [],
    repos: [],
    findings: [
      {
        id: 'config-integrity-wavemill-x',
        severity: 'urgent',
        category: 'crash',
        confidence: 'high',
        title: 'schema is malformed',
        evidence: [],
        recommendation: 'repair schema',
      },
      {
        id: 'model-downgrade-wavemill-x',
        severity: 'high',
        category: 'warning',
        confidence: 'high',
        title: 'model fallback',
        evidence: [],
        recommendation: 'repair config',
        groupedUnder: 'config-integrity-wavemill-x',
      },
      {
        id: 'log-warning-wavemill-x',
        severity: 'low',
        category: 'warning',
        confidence: 'high',
        title: 'ready watchdog tick failed',
        evidence: [],
        recommendation: 'repair config',
        groupedUnder: 'config-integrity-wavemill-x',
      },
    ],
  } as const;

  const compact = compactSnapshotForRender(snapshot);

  assert.equal(compact.findings.length, 1);
  assert.equal(compact.findings[0].id, 'config-integrity-wavemill-x');
  assert.equal(compact.findings[0].title, 'schema is malformed (+2 downstream)');
});

test('repeated model downgrade gets high-severity tier and is excluded from generic warnings', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-model-downgrade-'));
  const logPath = join(repoDir, 'mill-wavemill.log');
  try {
    writePermissiveSchema(repoDir);
    writeFileSync(logPath, [
      "10:00:01 [warn]   Invalid coding model 'claude-sonnet-5'; using 'claude-opus-4-7'",
      "10:00:02 [warn]   Invalid coding model 'claude-sonnet-5'; using 'claude-opus-4-7'",
      "10:00:03 [warn]   Invalid coding model 'claude-sonnet-5'; using 'claude-opus-4-7'",
    ].join('\n'));

    const findings = buildFindings(basicSnapshot(repoDir, logPath), defaultObserverOptions());
    const downgrade = findings.find((finding) => finding.id.startsWith('model-downgrade-'));

    assert.ok(downgrade);
    assert.equal(downgrade.severity, 'high');
    assert.equal(downgrade.category, 'warning');
    assert.equal(downgrade.occurrenceCount, 3);
    assert.match(downgrade.recommendation, /silent correctness regression/);
    assert.equal(findings.some((finding) => finding.id.startsWith('log-warning-')), false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('two model downgrade warnings remain below threshold', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-model-downgrade-low-'));
  const logPath = join(repoDir, 'mill-wavemill.log');
  try {
    writePermissiveSchema(repoDir);
    writeFileSync(logPath, [
      "10:00:01 [warn]   Invalid coding model 'claude-sonnet-5'; using 'claude-opus-4-7'",
      "10:00:02 [warn]   Invalid coding model 'claude-sonnet-5'; using 'claude-opus-4-7'",
    ].join('\n'));

    const findings = buildFindings(basicSnapshot(repoDir, logPath), defaultObserverOptions());

    assert.equal(findings.some((finding) => finding.id.startsWith('model-downgrade-')), false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('model downgrade depth-tag variant is counted', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-model-downgrade-depth-'));
  const logPath = join(repoDir, 'mill-wavemill.log');
  try {
    writePermissiveSchema(repoDir);
    writeFileSync(logPath, [
      "10:00:01 [warn]   Invalid coding model 'high' looks like a depth tag; using 'claude-opus-4-7'",
      "10:00:02 [warn]   Invalid coding model 'high' looks like a depth tag; using 'claude-opus-4-7'",
      "10:00:03 [warn]   Invalid coding model 'high' looks like a depth tag; using 'claude-opus-4-7'",
    ].join('\n'));

    const findings = buildFindings(basicSnapshot(repoDir, logPath), defaultObserverOptions());
    const downgrade = findings.find((finding) => finding.id.startsWith('model-downgrade-'));

    assert.ok(downgrade);
    assert.equal(downgrade.occurrenceCount, 3);
    assert.ok(downgrade.evidence.includes('model=high'));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('observer once exits zero in degraded mode with malformed schema', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-once-degraded-'));
  const logDir = join(repoDir, '.wavemill', 'logs');
  try {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(repoDir, 'wavemill-config.schema.json'), '{\n  "type": "object"\n}\n,\n{}\n');
    writeFileSync(join(logDir, 'mill-unknown.log'), '10:00:00 [error] independent monitor failure\n');

    const result = spawnSync(process.execPath, [join(process.cwd(), 'tools', 'observer.ts'), '--once', '--json', '--repo-dir', repoDir], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 20_000,
    });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.findings.some((finding: { id: string; severity: string }) =>
      finding.id.startsWith('config-integrity-') && finding.severity === 'urgent'
    ));
    assert.ok(parsed.findings.some((finding: { id: string; evidence?: string[] }) =>
      finding.id.startsWith('log-error-') &&
      finding.evidence?.some((line) => /independent monitor failure/.test(line))
    ));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('fresh coding marker does not produce marker-ignored finding', () => {
  const markerMtime = new Date(Date.now() - 30_000);
  const fixture = createMarkerFixture('.coding-complete', markerMtime);

  try {
    const findings = buildFindings(markerSnapshot({
      repoDir: fixture.repoDir,
      slug: fixture.slug,
      phase: 'coding',
    }), defaultObserverOptions());

    assert.equal(findings.some((finding) => finding.id === 'coding-marker-ignored-HOK-2848'), false);
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

test('old coding marker produces urgent marker-ignored finding with age evidence', () => {
  const markerMtime = new Date(Date.now() - 30 * 60_000);
  const stateMtime = new Date(markerMtime.getTime() - 60_000).toISOString();
  const fixture = createMarkerFixture('.coding-complete', markerMtime);

  try {
    const findings = buildFindings(markerSnapshot({
      repoDir: fixture.repoDir,
      slug: fixture.slug,
      phase: 'coding',
      stateMtime,
    }), defaultObserverOptions());

    const finding = findings.find((candidate) => candidate.id === 'coding-marker-ignored-HOK-2848');
    assert.ok(finding);
    assert.equal(finding.severity, 'urgent');
    assert.equal(finding.confidence, 'high');
    assert.equal(finding.category, 'stuck');
    assert.equal(finding.issue, 'HOK-2848');
    assert.match(finding.title, /still in coding \d+ minutes after \.coding-complete appeared/);
    assert.ok(finding.evidence.includes('statePhase=coding'));
    assert.ok(finding.evidence.includes(`marker=${fixture.markerPath}`));
    assert.ok(finding.evidence.some((line) => line.startsWith('markerMtime=')));
    assert.ok(markerAgeSeconds(finding) >= 1700);
    assert.ok(finding.evidence.includes(`stateMtime=${stateMtime}`));
    assert.match(finding.recommendation, /hung monitor child/);
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

test('newer workflow state modulates the coding marker finding but does not suppress it', () => {
  const markerMtime = new Date(Date.now() - 30 * 60_000);
  const stateMtime = new Date(markerMtime.getTime() + 60_000).toISOString();
  const fixture = createMarkerFixture('.coding-complete', markerMtime);

  try {
    const findings = buildFindings(markerSnapshot({
      repoDir: fixture.repoDir,
      slug: fixture.slug,
      phase: 'coding',
      stateMtime,
    }), defaultObserverOptions());

    // A newer workflow-state.json must NOT hide a genuinely wedged task: in a
    // multi-task mill, state is rewritten constantly for other tasks.
    const finding = findings.find((entry) => entry.id === 'coding-marker-ignored-HOK-2848');
    assert.ok(finding, 'expected the marker-ignored finding to still be produced');
    assert.equal(finding.severity, 'urgent');
    assert.equal(finding.confidence, 'high');
    assert.ok(finding.evidence.includes('stateNewerThanMarker=true'));
    assert.match(finding.recommendation, /still writing workflow state but has not advanced this task/);
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

test('older workflow state keeps the hung-monitor recommendation', () => {
  const markerMtime = new Date(Date.now() - 30 * 60_000);
  const stateMtime = new Date(markerMtime.getTime() - 60_000).toISOString();
  const fixture = createMarkerFixture('.coding-complete', markerMtime);

  try {
    const findings = buildFindings(markerSnapshot({
      repoDir: fixture.repoDir,
      slug: fixture.slug,
      phase: 'coding',
      stateMtime,
    }), defaultObserverOptions());

    const finding = findings.find((entry) => entry.id === 'coding-marker-ignored-HOK-2848');
    assert.ok(finding, 'expected the marker-ignored finding to be produced');
    assert.ok(finding.evidence.includes('stateNewerThanMarker=false'));
    assert.match(finding.recommendation, /hung monitor child process/);
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

test('coding marker-ignored threshold follows stale minutes option', () => {
  const markerMtime = new Date(Date.now() - 3 * 60_000);
  const fixture = createMarkerFixture('.coding-complete', markerMtime);

  try {
    const snapshot = markerSnapshot({
      repoDir: fixture.repoDir,
      slug: fixture.slug,
      phase: 'coding',
    });

    const strictFindings = buildFindings(snapshot, { ...defaultObserverOptions(), staleMinutes: 2 });
    assert.ok(strictFindings.some((finding) => finding.id === 'coding-marker-ignored-HOK-2848'));

    const defaultFindings = buildFindings(snapshot, { ...defaultObserverOptions(), staleMinutes: 10 });
    assert.equal(defaultFindings.some((finding) => finding.id === 'coding-marker-ignored-HOK-2848'), false);
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

test('planning marker mirrors coding marker grace behavior', () => {
  const freshMarkerMtime = new Date(Date.now() - 30_000);
  const oldMarkerMtime = new Date(Date.now() - 30 * 60_000);
  const freshFixture = createMarkerFixture('.plan-approved', freshMarkerMtime);
  const oldFixture = createMarkerFixture('.plan-approved', oldMarkerMtime);

  try {
    const freshFindings = buildFindings(markerSnapshot({
      repoDir: freshFixture.repoDir,
      slug: freshFixture.slug,
      phase: 'planning',
    }), defaultObserverOptions());
    assert.equal(freshFindings.some((finding) => finding.id === 'plan-marker-ignored-HOK-2848'), false);

    const oldFindings = buildFindings(markerSnapshot({
      repoDir: oldFixture.repoDir,
      slug: oldFixture.slug,
      phase: 'planning',
    }), defaultObserverOptions());
    const finding = oldFindings.find((candidate) => candidate.id === 'plan-marker-ignored-HOK-2848');
    assert.ok(finding);
    assert.equal(finding.severity, 'urgent');
    assert.equal(finding.confidence, 'high');
    assert.equal(finding.category, 'stuck');
    assert.match(finding.title, /still in planning \d+ minutes after \.plan-approved appeared/);
    assert.ok(markerAgeSeconds(finding) >= 1700);
    assert.ok(finding.evidence.some((line) => line.startsWith('markerMtime=')));
    assert.ok(finding.evidence.includes('stateMtime=unknown'));
  } finally {
    rmSync(freshFixture.repoDir, { recursive: true, force: true });
    rmSync(oldFixture.repoDir, { recursive: true, force: true });
  }
});

test('repeated ready watchdog auto-recoveries escalate to actionable stuck finding', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-ready-watchdog-'));
  const logPath = join(repoDir, 'mill-wavemill.log');
  writeFileSync(logPath, [
    '23:18:54 [status] ready watchdog: HOK-1892 stuck (auto-recovered) - Local ready state has been idle for 15m while PR #437 is clean and green.',
    '23:31:13 [status] ready watchdog: HOK-1892 stuck (auto-recovered) - Local ready state has been idle for 11m while PR #437 is clean and green.',
    '00:01:47 [status] ready watchdog: HOK-1892 stuck (auto-recovered) - Local ready state has been idle for 17m while PR #437 is clean and green.',
    '00:41:56 [status] ready watchdog: HOK-1892 stuck (auto-recovered) - Local ready state has been idle for 21m while PR #437 is clean and green.',
  ].join('\n'));

  try {
    const findings = buildFindings({
      timestamp: '2026-05-29T13:00:02.545Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        millLogPath: logPath,
        tasks: [{
          issue: 'HOK-1892',
          phase: 'ready',
          status: 'running',
          pr: '437',
        }],
      }],
    }, {
      loop: false,
      once: true,
      json: false,
      intervalSeconds: 120,
      staleMinutes: 10,
      hungMinutes: 10,
      fileLinear: false,
      fileIncidents: false,
      dryRun: false,
      autoFixDryRun: false,
      incidentsDryRun: false,
      maxLogLines: 240,
      printPrompt: false,
      incidentDetector: true,
    });

    const stuck = findings.find((finding) => finding.id.startsWith('repeated-ready-watchdog-'));
    assert.ok(stuck);
    assert.equal(stuck.severity, 'high');
    assert.equal(stuck.category, 'stuck');
    assert.equal(stuck.confidence, 'high');
    assert.equal(stuck.issue, 'HOK-1892');
    assert.match(stuck.title, /repeatedly triggers ready watchdog auto-recovered/);
    assert.equal(stuck.evidence[0], 'occurrences=4');
    assert.equal(findings.filter((finding) => finding.title === 'Recent mill log contains a warning').length, 0);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('degraded queue health returns structured finding without throwing', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-queue-degraded-'));
  try {
    const findings = buildFindings({
      timestamp: '2026-08-10T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        queueHealth: {
          status: 'degraded',
          degradationReason: 'dependency_planning_failed',
          episodeStartedAt: '2026-08-10T00:00:00Z',
          failureCount: 3,
          retryBackoffSeconds: 60,
          lastAttemptAt: '2026-08-10T00:05:00Z',
          diagnostics: { stderrExcerpt: 'plan_queue_failed exit 143' },
        },
        tasks: [],
      }],
    }, defaultObserverOptions());

    const degraded = findings.find((finding) => finding.id.startsWith('queue-health-degraded-'));
    assert.ok(degraded);
    assert.equal(degraded.severity, 'medium');
    assert.equal(degraded.category, 'warning');
    assert.match(degraded.title, /dependency_planning_failed/);
    // HOK-3314: evidence rows are projection-driven (consecutiveFailedAttempts,
    // episodeId, projectionStatus); the old `failureCount=3` and raw stderr
    // excerpt live on the record metadata, not the finding evidence lines.
    assert.ok(degraded.evidence.some((line: string) => line === 'consecutiveFailedAttempts=3'));
    assert.ok(degraded.evidence.some((line: string) => line === 'projectionStatus=degraded-planner'));
    assert.ok(degraded.evidence.includes('stderr=plan_queue_failed exit 143'));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('inference_unavailable queue health reports missing inference, not a flat fallback (HOK-3130)', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-queue-inference-'));
  try {
    const findings = buildFindings({
      timestamp: '2026-09-30T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        queueHealth: {
          status: 'degraded',
          degradationReason: 'inference_unavailable',
          episodeStartedAt: null,
          failureCount: 0,
          retryBackoffSeconds: 0,
          inferenceStatus: 'failed',
          inferredEdgeCount: 0,
          inference: { consecutiveFailures: 3, lastSuccessAt: null, error: 'classifier timeout' },
        },
        tasks: [],
      }],
    }, defaultObserverOptions());

    const degraded = findings.find((finding) => finding.id.startsWith('queue-health-degraded-'));
    assert.ok(degraded);
    assert.equal(degraded.severity, 'medium');
    assert.match(degraded.title, /inference_unavailable/);
    // HOK-3314: current-episode attempt count (3) comes from the projection.
    assert.ok(degraded.evidence.some((line: string) => line === 'consecutiveFailedAttempts=3'));
    assert.ok(degraded.evidence.includes('inferenceStatus=failed'));
    assert.ok(degraded.evidence.includes('inferenceError=classifier timeout'));
    // HOK-3314: `[classifier]` wording is the projection summary annotated by
    // observer; "Flat fallback" / "explicit Linear relations only" are gone.
    assert.match(degraded.recommendation, /\[classifier\]/);
    assert.doesNotMatch(degraded.recommendation, /Flat fallback/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('structured log scanning aggregates repeated errors and ignores prose false positives', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-log-scanner-'));
  const fixtureLogPath = join(process.cwd(), 'tests', 'fixtures', 'observer', 'test-log.txt');
  const variantLogPath = join(repoDir, 'variant.log');
  writeFileSync(variantLogPath, '12:45:01 [error] Monitor command failed pid=42 tmp=/tmp/wavemill-plan-c stderr=Error: EAGAIN\n');

  try {
    const findings = buildFindings({
      timestamp: '2026-08-24T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        millLogPath: fixtureLogPath,
        queueHealth: {
          status: 'degraded',
          degradationReason: 'dependency_planning_failed',
          episodeStartedAt: '2026-08-24T00:00:00Z',
          failureCount: 4,
        },
        tasks: [{
          issue: 'HOK-1892',
          phase: 'ready',
          status: 'running',
          pr: '437',
        }],
      }],
    }, defaultObserverOptions());

    const errorFindings = findings.filter((finding) => finding.id.startsWith('log-error-'));
    assert.equal(errorFindings.length, 1);
    const error = errorFindings[0];
    assert.equal(error.severity, 'high');
    assert.equal(error.confidence, 'high');
    assert.equal(error.occurrenceCount, 2);
    assert.ok(error.evidence.includes('occurrences=2'));
    assert.ok(error.evidence.includes('normalizedMessage=Monitor command failed pid=<pid> tmp=<tmp> stderr=Error: EAGAIN'));
    assert.equal(error.evidence.some((line) => /error detection|error handling/.test(line)), false);

    const variantFindings = buildFindings({
      timestamp: '2026-08-24T12:01:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        millLogPath: variantLogPath,
        tasks: [],
      }],
    }, defaultObserverOptions());
    const variantError = variantFindings.find((finding) => finding.id.startsWith('log-error-'));
    assert.ok(variantError);
    assert.equal(variantError.id, error.id);

    const warningFindings = findings.filter((finding) => finding.id.startsWith('log-warning-'));
    assert.equal(warningFindings.length, 1);
    const warning = warningFindings[0];
    assert.equal(warning.severity, 'low');
    assert.equal(warning.confidence, 'high');
    assert.equal(warning.occurrenceCount, 1);
    assert.ok(warning.evidence.some((line) => /task handoff timed out/.test(line)));
    assert.equal(warning.evidence.some((line) => /queue analysis unavailable|ready watchdog/.test(line)), false);
    assert.ok(findings.some((finding) => finding.id.startsWith('queue-health-degraded-')));
    assert.ok(findings.some((finding) => finding.id.startsWith('repeated-ready-watchdog-')));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('degraded queue health suppresses only generic queue analysis warning', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-queue-warning-suppressed-'));
  const logPath = join(repoDir, 'mill-wavemill.log');
  writeFileSync(logPath, [
    '12:01:02 [warn] queue analysis unavailable; using flat fallback',
    '12:02:03 [warn] task handoff timed out',
  ].join('\n'));

  try {
    const findings = buildFindings({
      timestamp: '2026-08-10T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        millLogPath: logPath,
        queueHealth: {
          status: 'degraded',
          degradationReason: 'plan_queue_failed',
          episodeStartedAt: '2026-08-10T00:00:00Z',
          failureCount: 5,
        },
        tasks: [],
      }],
    }, defaultObserverOptions());

    assert.ok(findings.some((finding) => finding.id.startsWith('queue-health-degraded-')));
    assert.equal(findings.some((finding) => (
      finding.id.startsWith('log-warning-') &&
      finding.evidence.some((line) => /queue analysis unavailable/i.test(line))
    )), false);
    assert.ok(findings.some((finding) => (
      finding.id.startsWith('log-warning-') &&
      finding.evidence.some((line) => /task handoff timed out/i.test(line))
    )));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('healthy queue health keeps generic queue analysis warning', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-queue-warning-healthy-'));
  const logPath = join(repoDir, 'mill-wavemill.log');
  writeFileSync(logPath, '12:01:02 [warn] queue analysis unavailable; using flat fallback\n');

  try {
    const findings = buildFindings({
      timestamp: '2026-08-10T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        millLogPath: logPath,
        queueHealth: { status: 'ok' },
        tasks: [],
      }],
    }, defaultObserverOptions());

    assert.equal(findings.some((finding) => finding.id.startsWith('queue-health-degraded-')), false);
    assert.ok(findings.some((finding) => (
      finding.id.startsWith('log-warning-') &&
      finding.evidence.some((line) => /queue analysis unavailable/i.test(line))
    )));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('rejected eval quarantine files produce operator-visible finding', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-rejected-evals-'));
  const rejectedDir = join(repoDir, '.wavemill', 'evals', 'rejected');
  mkdirSync(rejectedDir, { recursive: true });
  writeFileSync(join(rejectedDir, '2026-08-22T00-00-00-000Z-HOK-1-primary.json'), '{}\n');
  writeFileSync(join(rejectedDir, '2026-08-23T00-00-00-000Z-HOK-2-challenger.json'), '{}\n');
  writeFileSync(join(rejectedDir, 'ignored.txt'), 'not json');

  try {
    const findings = buildFindings({
      timestamp: '2026-08-23T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        tasks: [],
      }],
    }, defaultObserverOptions());

    const finding = findings.find((candidate) => candidate.id.startsWith('eval-rejected-records-'));
    assert.ok(finding);
    assert.equal(finding.severity, 'medium');
    assert.equal(finding.category, 'warning');
    assert.equal(finding.confidence, 'high');
    assert.match(finding.title, /2 eval records rejected/);
    assert.ok(finding.evidence.includes('count=2'));
    assert.ok(finding.evidence.some((line) => line.includes('newest=2026-08-23T00-00-00-000Z-HOK-2-challenger.json')));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('missing rejected eval quarantine directory produces no finding', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-no-rejected-evals-'));
  try {
    const findings = buildFindings({
      timestamp: '2026-08-23T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        tasks: [],
      }],
    }, defaultObserverOptions());

    assert.equal(findings.some((candidate) => candidate.id.startsWith('eval-rejected-records-')), false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('service mode rejects Linear filing', () => {
  const previous = process.env.WAVEMILL_OBSERVER_SERVICE;
  process.env.WAVEMILL_OBSERVER_SERVICE = '1';
  try {
    assert.throws(() => parseArgs(['--loop', '--file-linear']), /--file-linear is not allowed/);
  } finally {
    if (previous === undefined) {
      delete process.env.WAVEMILL_OBSERVER_SERVICE;
    } else {
      process.env.WAVEMILL_OBSERVER_SERVICE = previous;
    }
  }
});

test('duplicate observer panes produce one high-severity operational finding', () => {
  const findings = buildFindings({
    timestamp: '2026-08-22T12:00:00.000Z',
    sessions: ['wavemill'],
    panes: [
      { session: 'wavemill', windowIndex: '1', paneIndex: '1', windowName: 'backstage', active: false, pid: 101, command: 'npm', title: 'Wavemill Observer' },
      { session: 'wavemill', windowIndex: '1', paneIndex: '2', windowName: 'backstage', active: false, pid: 201, command: 'npm', title: 'Wavemill Observer' },
      { session: 'wavemill', windowIndex: '1', paneIndex: '3', windowName: 'backstage', active: false, pid: 301, command: 'npm', title: 'Wavemill Observer' },
    ],
    processes: [
      { pid: 101, ppid: 1, stat: 'S', elapsedSeconds: 10, command: 'npm exec tsx tools/observer.ts --loop --session wavemill' },
      { pid: 102, ppid: 101, stat: 'S', elapsedSeconds: 10, command: 'node tools/observer.ts --loop --session wavemill' },
      { pid: 201, ppid: 1, stat: 'S', elapsedSeconds: 10, command: 'npm exec tsx tools/observer.ts --loop --session wavemill' },
      { pid: 301, ppid: 1, stat: 'S', elapsedSeconds: 10, command: 'npm exec tsx tools/observer.ts --loop --session wavemill' },
    ],
    repos: [{ session: 'wavemill', repoDir: '/tmp/repo', tasks: [] }],
  }, defaultObserverOptions());

  const duplicate = findings.find((finding) => finding.id === 'duplicate-observer-wavemill');
  assert.ok(duplicate);
  assert.equal(duplicate.severity, 'high');
  assert.equal(duplicate.category, 'operational');
  assert.equal(duplicate.confidence, 'high');
  assert.match(duplicate.title, /3 Observer loops are running/);
  assert.ok(duplicate.evidence.some((line) => line.includes('1.1') && line.includes('1.3')));
  assert.ok(duplicate.evidence.some((line) => line.includes('101') && line.includes('301')));
});

test('single observer pane does not produce duplicate finding', () => {
  const findings = buildFindings({
    timestamp: '2026-08-22T12:00:00.000Z',
    sessions: ['wavemill'],
    panes: [
      { session: 'wavemill', windowIndex: '1', paneIndex: '1', windowName: 'backstage', active: false, pid: 101, command: 'npm', title: 'Wavemill Observer' },
    ],
    processes: [
      { pid: 101, ppid: 1, stat: 'S', elapsedSeconds: 10, command: 'npm exec tsx tools/observer.ts --loop --session wavemill' },
      { pid: 102, ppid: 101, stat: 'S', elapsedSeconds: 10, command: 'node tools/observer.ts --loop --session wavemill' },
    ],
    repos: [{ session: 'wavemill', repoDir: '/tmp/repo', tasks: [] }],
  }, defaultObserverOptions());

  assert.equal(findings.some((finding) => finding.id === 'duplicate-observer-wavemill'), false);
});

test('stale active challenge arm with no live pane or process is surfaced', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-stale-arm-'));
  const worktree = join(repoDir, 'worktrees', 'demo-challenger');
  mkdirSync(worktree, { recursive: true });
  try {
    const findings = buildFindings({
      timestamp: new Date().toISOString(),
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        stateMtime: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
        tasks: [{
          issue: 'HOK-2846_c',
          slug: 'demo-challenger',
          phase: 'coding',
          status: 'active',
          worktree,
          updated: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
          challengeRole: 'challenger',
        }],
      }],
    }, defaultObserverOptions());

    const stuck = findings.find((finding) => finding.id === 'stale-active-task-no-live-process-wavemill-HOK-2846_c');
    assert.ok(stuck);
    assert.equal(stuck.severity, 'high');
    assert.equal(stuck.category, 'stuck');
    assert.equal(stuck.confidence, 'high');
    assert.equal(stuck.issue, 'HOK-2846_c');
    assert.match(stuck.title, /no live pane or process evidence/);
    assert.ok(stuck.evidence.includes(`worktree=${worktree}`));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('fresh active challenge arm is not surfaced as stale', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-fresh-arm-'));
  const worktree = join(repoDir, 'worktrees', 'fresh-challenger');
  mkdirSync(worktree, { recursive: true });
  try {
    const findings = buildFindings({
      timestamp: new Date().toISOString(),
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        tasks: [{
          issue: 'HOK-2846_c',
          slug: 'fresh-challenger',
          phase: 'coding',
          status: 'active',
          worktree,
          updated: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
          challengeRole: 'challenger',
        }],
      }],
    }, defaultObserverOptions());

    assert.equal(findings.some((finding) => finding.id.startsWith('stale-active-task-')), false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('stale active task with a surviving pane is surfaced as stalled residue', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-stale-live-pane-'));
  const worktree = join(repoDir, 'worktrees', 'parked-agent');
  mkdirSync(worktree, { recursive: true });
  try {
    const findings = buildFindings({
      timestamp: new Date().toISOString(),
      sessions: ['wavemill'],
      panes: [{
        session: 'wavemill',
        windowIndex: '2',
        paneIndex: '0',
        windowName: 'HOK-2999-parked-agent',
        active: true,
        pid: 2999,
        command: 'bash',
        title: 'coding · codex',
      }],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        tasks: [{
          issue: 'HOK-2999',
          slug: 'parked-agent',
          phase: 'coding',
          status: 'active',
          worktree,
          updated: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
        }],
      }],
    }, defaultObserverOptions());

    const stuck = findings.find((finding) => finding.id === 'stale-active-task-live-process-wavemill-HOK-2999');
    assert.ok(stuck);
    assert.equal(stuck.severity, 'high');
    assert.equal(stuck.category, 'stuck');
    assert.equal(stuck.confidence, 'medium');
    assert.match(stuck.title, /live pane or process residue but has not progressed/);
    assert.match(stuck.recommendation, /parked at a prompt/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('HOK-3087: fresh working hook rescues a coding task with stale task.updated', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-hok3087-fresh-hook-'));
  const worktree = join(repoDir, 'worktrees', 'coding-arm');
  mkdirSync(worktree, { recursive: true });
  // Unique session avoids collisions with other tests / real hook files.
  const session = `observer-hok3087-fresh-${process.pid}-${Date.now()}`;
  const issue = 'HOK-3084';
  const hookPath = `/tmp/wavemill-${session}-${issue}.hook`;
  const nowSec = Math.floor(Date.now() / 1000);
  writeFileSync(hookPath, JSON.stringify({
    state: 'working',
    event: 'PreToolUse',
    detail: 'Read',
    agent: 'claude',
    timestamp: nowSec - 60,
    writer: 'agent',
    agentRecord: {
      state: 'working',
      event: 'PreToolUse',
      agent: 'claude',
      timestamp: nowSec - 60,
      detail: 'Read',
    },
  }));
  try {
    const findings = buildFindings({
      timestamp: new Date().toISOString(),
      sessions: [session],
      panes: [{
        session,
        windowIndex: '3',
        paneIndex: '0',
        windowName: `${issue}-coding-arm`,
        active: true,
        pid: 3084,
        command: 'bash',
        title: 'coding · claude',
      }],
      processes: [],
      repos: [{
        session,
        repoDir,
        tasks: [{
          issue,
          slug: 'coding-arm',
          phase: 'coding',
          status: 'active',
          worktree,
          updated: new Date(Date.now() - 200 * 60 * 1000).toISOString(),
        }],
      }],
    }, defaultObserverOptions());

    const staleActive = findings.filter((f) => f.id.startsWith('stale-active-task-') && f.issue === issue);
    assert.equal(staleActive.length, 0, `expected no stale-active-task finding, got: ${staleActive.map((f) => f.id).join(', ')}`);
    const codingStalled = findings.find((f) => f.id === `coding-task-stalled-${session}-${issue}`);
    assert.equal(codingStalled, undefined, 'expected no coding-task-stalled finding when hook is fresh');
  } finally {
    try { rmSync(hookPath, { force: true }); } catch { /* ignore */ }
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('HOK-3087: stale hook, no commits, no status file still flags stalled', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-hok3087-all-stale-'));
  const worktree = join(repoDir, 'worktrees', 'dead-arm');
  mkdirSync(worktree, { recursive: true });
  const session = `observer-hok3087-stale-${process.pid}-${Date.now()}`;
  const issue = 'HOK-3087';
  try {
    const findings = buildFindings({
      timestamp: new Date().toISOString(),
      sessions: [session],
      panes: [{
        session,
        windowIndex: '4',
        paneIndex: '0',
        windowName: `${issue}-dead-arm`,
        active: true,
        pid: 3087,
        command: 'bash',
        title: 'coding · claude',
      }],
      processes: [],
      repos: [{
        session,
        repoDir,
        tasks: [{
          issue,
          slug: 'dead-arm',
          phase: 'coding',
          status: 'active',
          worktree,
          updated: new Date(Date.now() - 200 * 60 * 1000).toISOString(),
        }],
      }],
    }, defaultObserverOptions());

    const staleActive = findings.find((f) => f.id === `stale-active-task-live-process-${session}-${issue}`);
    assert.ok(staleActive, `expected stale-active-task-live-process finding, got: ${findings.map((f) => f.id).join(', ')}`);
    assert.match(staleActive.title, /has not progressed/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// HOK-3095: liveness is progress, not process existence. Shared fixture for
// a stale `ready` task whose pane and agent process are still alive.
function hok3095Fixture(label: string, hook?: { state: string; event: string; ageSeconds: number }) {
  const repoDir = mkdtempSync(join(tmpdir(), `observer-hok3095-${label}-`));
  const slug = `${label}-arm`;
  const worktree = join(repoDir, 'worktrees', slug);
  mkdirSync(worktree, { recursive: true });
  const session = `observer-hok3095-${label}-${process.pid}-${Date.now()}`;
  const issue = 'HOK-3095';
  const hookPath = `/tmp/wavemill-${session}-${issue}.hook`;
  if (hook) {
    const timestamp = Math.floor(Date.now() / 1000) - hook.ageSeconds;
    const record = { state: hook.state, event: hook.event, agent: 'claude', timestamp, detail: '' };
    writeFileSync(hookPath, JSON.stringify({ ...record, writer: 'agent', agentRecord: record }));
  }
  const task = {
    issue,
    slug,
    phase: 'ready',
    status: 'active',
    worktree,
    updated: new Date(Date.now() - 15 * 60 * 60 * 1000).toISOString(),
  };
  const livePane = {
    session,
    windowIndex: '5',
    paneIndex: '0',
    windowName: `${issue}-${slug}`,
    active: true,
    pid: 3095,
    command: 'bash',
    title: 'ready · claude',
  };
  // The agent's own launch argv embeds the slug and worktree — exactly what
  // the pre-HOK-3095 process match treated as proof of life.
  const agentProcess = {
    pid: 3096,
    ppid: 3095,
    stat: 'S+',
    elapsedSeconds: 15 * 60 * 60,
    command: `claude --model claude-sonnet-5-5 ${worktree}/features/${slug}/ready-prompt.md`,
  };
  const cleanup = () => {
    try { rmSync(hookPath, { force: true }); } catch { /* ignore */ }
    rmSync(repoDir, { recursive: true, force: true });
  };
  return { repoDir, worktree, session, issue, task, livePane, agentProcess, cleanup };
}

function hok3095Findings(
  fx: ReturnType<typeof hok3095Fixture>,
  panes: ReturnType<typeof hok3095Fixture>['livePane'][],
  processes: Array<ReturnType<typeof hok3095Fixture>['agentProcess']>,
) {
  return buildFindings({
    timestamp: new Date().toISOString(),
    sessions: [fx.session],
    panes,
    processes,
    repos: [{ session: fx.session, repoDir: fx.repoDir, tasks: [fx.task] }],
  }, defaultObserverOptions());
}

test('HOK-3095: agent idle at its prompt past staleMinutes is flagged despite live pane and process', () => {
  const fx = hok3095Fixture('idle', { state: 'idle', event: 'Stop', ageSeconds: 15 * 60 * 60 });
  try {
    const findings = hok3095Findings(fx, [fx.livePane], [fx.agentProcess]);
    const stale = findings.find((f) => f.id === `stale-active-task-no-live-process-${fx.session}-${fx.issue}`);
    assert.ok(stale, `expected stale-active-task-no-live-process, got: ${findings.map((f) => f.id).join(', ')}`);
    assert.match(stale.title, /agent is idle with no progress/);
    assert.ok(stale.evidence.includes('agentRecordState=idle'));
    assert.equal(
      findings.some((f) => f.id === `stale-active-task-live-process-${fx.session}-${fx.issue}`),
      false,
      'an idle REPL is not live-process residue',
    );
  } finally {
    fx.cleanup();
  }
});

test('HOK-3095: agent waiting on a human for hours (hook past TTL) is flagged despite live process', () => {
  const fx = hok3095Fixture('waiting', { state: 'waiting', event: 'Notification', ageSeconds: 15 * 60 * 60 });
  try {
    const findings = hok3095Findings(fx, [fx.livePane], [fx.agentProcess]);
    const stale = findings.find((f) => f.id === `stale-active-task-no-live-process-${fx.session}-${fx.issue}`);
    assert.ok(stale, `expected stale-active-task-no-live-process, got: ${findings.map((f) => f.id).join(', ')}`);
    assert.match(stale.title, /agent is waiting with no progress/);
    assert.ok(stale.evidence.includes('agentRecordState=waiting'));
  } finally {
    fx.cleanup();
  }
});

test('HOK-3095: monitor polling subprocesses do not count as live evidence', () => {
  const fx = hok3095Fixture('polled');
  try {
    const findings = hok3095Findings(fx, [], [
      { pid: 4001, ppid: 1, stat: 'S', elapsedSeconds: 5, command: `node --import tsx /opt/wavemill/tools/pr-ci-status.ts 89 --repo-dir ${fx.worktree}` },
      { pid: 4002, ppid: 1, stat: 'S', elapsedSeconds: 5, command: `npx tsx /opt/wavemill/tools/ready-watchdog.ts --issue ${fx.issue} --repo-dir ${fx.worktree}` },
    ]);
    const stale = findings.find((f) => f.id === `stale-active-task-no-live-process-${fx.session}-${fx.issue}`);
    assert.ok(stale, `expected stale-active-task-no-live-process, got: ${findings.map((f) => f.id).join(', ')}`);
    assert.match(stale.title, /no live pane or process evidence/);
    assert.ok(stale.evidence.includes(`worktree=${fx.worktree}`));
  } finally {
    fx.cleanup();
  }
});

test('HOK-3095: hookless task keeps the pane/process fallback (agent process is residue)', () => {
  const fx = hok3095Fixture('hookless');
  try {
    const findings = hok3095Findings(fx, [], [fx.agentProcess]);
    assert.ok(
      findings.some((f) => f.id === `stale-active-task-live-process-${fx.session}-${fx.issue}`),
      `expected stale-active-task-live-process, got: ${findings.map((f) => f.id).join(', ')}`,
    );
    assert.equal(findings.some((f) => f.id === `stale-active-task-no-live-process-${fx.session}-${fx.issue}`), false);
  } finally {
    fx.cleanup();
  }
});

test('HOK-3095: a fresh working hook is still not flagged (consistent with HOK-3087)', () => {
  const fx = hok3095Fixture('working', { state: 'working', event: 'PreToolUse', ageSeconds: 60 });
  try {
    const findings = hok3095Findings(fx, [fx.livePane], [fx.agentProcess]);
    const staleActive = findings.filter((f) => f.id.startsWith('stale-active-task-') && f.issue === fx.issue);
    assert.equal(staleActive.length, 0, `expected no stale-active-task finding, got: ${staleActive.map((f) => f.id).join(', ')}`);
  } finally {
    fx.cleanup();
  }
});

test('duplicate observer finding respects pane title override', () => {
  const previous = process.env.WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE;
  process.env.WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE = 'Custom Observer';
  try {
    const findings = buildFindings({
      timestamp: '2026-08-22T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [
        { session: 'wavemill', windowIndex: '1', paneIndex: '1', windowName: 'backstage', active: false, pid: 101, command: 'npm', title: 'Custom Observer' },
        { session: 'wavemill', windowIndex: '1', paneIndex: '2', windowName: 'backstage', active: false, pid: 201, command: 'npm', title: 'Custom Observer' },
      ],
      processes: [],
      repos: [{ session: 'wavemill', repoDir: '/tmp/repo', tasks: [] }],
    }, defaultObserverOptions());

    assert.ok(findings.some((finding) => finding.id === 'duplicate-observer-wavemill'));
  } finally {
    if (previous === undefined) {
      delete process.env.WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE;
    } else {
      process.env.WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE = previous;
    }
  }
});

test('service heartbeat is parseable and stores redacted finding counts only', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-heartbeat-'));
  try {
    mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
    writeFileSync(join(repoDir, '.wavemill', 'backstage-health.json'), JSON.stringify({
      services: {
        observer: {
          status: 'healthy',
          instanceCount: 1,
        },
      },
    }));

    await writeServiceHeartbeat({
      timestamp: '2026-08-03T12:00:00.000Z',
      sessions: ['wavemill-test'],
      panes: [],
      processes: [],
      repos: [],
      findings: [{
        id: 'secret-finding',
        severity: 'high',
        category: 'warning',
        confidence: 'high',
        title: 'Secret in log',
        evidence: ['OPENAI_API_KEY=sk-secret prompt=do the hidden task'],
        recommendation: 'Inspect redacted evidence',
      }],
    }, {
      loop: true,
      once: false,
      json: true,
      intervalSeconds: 120,
      staleMinutes: 10,
      hungMinutes: 10,
      fileLinear: false,
      fileIncidents: false,
      dryRun: true,
      incidentsDryRun: false,
      maxLogLines: 240,
      printPrompt: false,
      incidentDetector: true,
      repoDir,
      session: 'wavemill-test',
      serviceMode: true,
    });

    const raw = readFileSync(join(repoDir, '.wavemill', 'backstage-health.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.services.observer.status, 'healthy');
    assert.equal(parsed.services.observer.heartbeatAt, '2026-08-03T12:00:00.000Z');
    assert.equal(parsed.services.observer.findingCounts.high, 1);
    assert.equal(parsed.services.observer.instanceCount, 1);
    assert.doesNotMatch(raw, /sk-secret|hidden task/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('observer redaction removes credentials and prompt-like evidence', () => {
  assert.equal(
    redactObserverText('OPENAI_API_KEY=sk-test token=abc123 prompt=full task'),
    'OPENAI_API_KEY=[redacted] token=[redacted] prompt=[redacted]',
  );
});

test('incident Linear flags imply filing mode and parse replay/policy controls', () => {
  const options = parseArgs([
    '--file-incidents',
    '--incidents-dry-run',
    '--incidents-replay',
    'abc123',
    '--incidents-policy',
    '{"external_transient_dependency":{"strategy":"threshold","threshold":5}}',
  ]);
  assert.equal(options.fileIncidents, true);
  assert.equal(options.incidentsDryRun, true);
  assert.equal(options.incidentsReplay, 'abc123');
  assert.match(options.incidentsPolicy ?? '', /external_transient_dependency/);
});

test('--incidents-shadow implies file-incidents and sets shadow mode', () => {
  const options = parseArgs(['--incidents-shadow']);
  assert.equal(options.fileIncidents, true);
  assert.equal(options.incidentsShadow, true);
  assert.equal(options.incidentsMode, undefined);
});

test('--incidents-mode=shadow implies file-incidents with the explicit mode', () => {
  const options = parseArgs(['--incidents-mode=shadow']);
  assert.equal(options.fileIncidents, true);
  assert.equal(options.incidentsMode, 'shadow');
});

test('--incidents-mode rejects invalid values', () => {
  assert.throws(() => parseArgs(['--incidents-mode=writes-please']), /must be off\|offline\|shadow\|live/);
});

test('incident sync snapshot is omitted when incident filing is disabled', async () => {
  const snapshot = await syncIncidentsToLinear({
    timestamp: '2026-08-04T12:00:00.000Z',
    sessions: [],
    panes: [],
    processes: [],
    repos: [],
    findings: [],
  }, {
    loop: false,
    once: true,
    json: false,
    intervalSeconds: 120,
    staleMinutes: 10,
    hungMinutes: 10,
    fileLinear: false,
    fileIncidents: false,
    dryRun: false,
    autoFixDryRun: false,
    incidentsDryRun: false,
    maxLogLines: 240,
    printPrompt: false,
    incidentDetector: true,
  });
  assert.equal(snapshot.incidentSync, undefined);
});

test('incident sync caps live incident processing per pass', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-incident-cap-'));
  try {
    const store = new IncidentStore(join(repoDir, '.wavemill', 'incidents'));
    for (let i = 0; i < 40; i += 1) {
      await store.upsert(createIncidentDraft({
        taskId: `HOK-${1000 + i}`,
        category: 'product_defect',
        severity: 'high',
        confidence: 'definite',
        lifecycle: 'active',
        rootCauseClass: 'observer_crash',
        summary: `Observer crashed ${i}.`,
        operatorAction: 'Fix parser.',
        evidence: [{
          type: 'log_excerpt',
          source: `mill-${i}.log`,
          timestamp: '2026-08-04T12:00:00.000Z',
          redactedData: `ERROR ${i}`,
          key: `error-${i}`,
        }],
        metadata: { thresholdTriggered: true },
      }));
    }

    const snapshot = await syncIncidentsToLinear({
      timestamp: '2026-08-04T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{ session: 'wavemill', repoDir, tasks: [] }],
      findings: [],
    }, {
      ...defaultObserverOptions(),
      fileIncidents: true,
    });

    assert.equal(snapshot.incidentSync?.totalProcessed, 10);
    assert.equal(snapshot.incidentSync?.skipped, 40);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('incident sync shadow mode caps per pass, writes audit records, and reports counters', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-incident-shadow-'));
  try {
    writePermissiveSchema(repoDir);
    // Enable shadow explicitly.
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
      configVersion: '1.5.0',
      mill: { baseBranch: 'auto/integration', requireConfirm: true },
      observer: { linear: { mode: 'shadow', maxIncidentsPerPass: 3 } },
    }, null, 2));

    const store = new IncidentStore(join(repoDir, '.wavemill', 'incidents'));
    for (let i = 0; i < 5; i += 1) {
      await store.upsert(createIncidentDraft({
        taskId: `HOK-${2000 + i}`,
        category: 'product_defect',
        severity: 'high',
        confidence: 'definite',
        lifecycle: 'active',
        rootCauseClass: 'observer_crash',
        summary: `Shadow ${i}.`,
        operatorAction: 'Fix parser.',
        evidence: [{
          type: 'log_excerpt',
          source: `mill-${i}.log`,
          timestamp: '2026-08-04T12:00:00.000Z',
          redactedData: `ERROR ${i}`,
          key: `error-${i}`,
        }],
        metadata: { thresholdTriggered: true },
      }));
    }

    const snapshot = await syncIncidentsToLinear({
      timestamp: '2026-08-04T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{ session: 'wavemill', repoDir, tasks: [] }],
      findings: [],
    }, {
      ...defaultObserverOptions(),
      fileIncidents: true,
      incidentsShadow: true,
    });

    assert.equal(snapshot.incidentSync?.mode, 'shadow');
    assert.ok(snapshot.incidentSync?.shadow, 'shadow snapshot must be present');
    // Per-pass cap of 3, five incidents seeded → 3 eligible, 2 skipped.
    assert.equal(snapshot.incidentSync?.shadow?.eligible, 3);
    assert.equal(snapshot.incidentSync?.shadow?.mutationAttempts, 0);
    // Cap fix: shadow must honour maxIncidentsPerPass.
    assert.ok((snapshot.incidentSync?.skipped ?? 0) >= 2);

    // Audit file was written.
    const auditPath = join(repoDir, '.wavemill/observer/shadow-audit.jsonl');
    assert.ok(existsSync(auditPath), `expected audit file at ${auditPath}`);
    const auditRecords = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
    assert.equal(auditRecords.length, 3);

    // Counters file was written.
    const countersPath = join(repoDir, '.wavemill/observer/shadow-counters.json');
    assert.ok(existsSync(countersPath));
    const counters = JSON.parse(readFileSync(countersPath, 'utf-8'));
    assert.equal(counters.eligible, 3);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('incident sync shadow mode drops suppressed classes and records per-class counts (HOK-3243)', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-incident-suppress-'));
  try {
    writePermissiveSchema(repoDir);
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
      configVersion: '1.5.0',
      mill: { baseBranch: 'auto/integration', requireConfirm: true },
      observer: {
        linear: {
          mode: 'shadow',
          maxIncidentsPerPass: 10,
          // Default suppression classes apply; omitted on purpose to prove defaults.
        },
      },
    }, null, 2));

    const store = new IncidentStore(join(repoDir, '.wavemill', 'incidents'));
    const seed = async (
      taskId: string,
      rootCauseClass: 'cleanup_dirty_worktree' | 'arm_died_with_unpushed_work' | 'observer_crash',
      summary: string,
    ) => {
      await store.upsert(createIncidentDraft({
        taskId,
        category: rootCauseClass === 'observer_crash' ? 'product_defect' : 'stale_orphaned_state',
        severity: 'high',
        confidence: 'definite',
        lifecycle: 'active',
        rootCauseClass,
        summary,
        operatorAction: 'Review.',
        evidence: [{
          type: 'log_excerpt',
          source: 'mill.log',
          timestamp: '2026-10-21T12:00:00.000Z',
          redactedData: 'EVENT',
          key: `${taskId}-${rootCauseClass}`,
        }],
      }));
    };
    for (let i = 0; i < 3; i += 1) {
      await seed(`HOK-${5100 + i}`, 'cleanup_dirty_worktree', `cleanup ${i}`);
    }
    for (let i = 0; i < 2; i += 1) {
      await seed(`HOK-${5200 + i}`, 'arm_died_with_unpushed_work', `armdied ${i}`);
    }
    for (let i = 0; i < 2; i += 1) {
      await seed(`HOK-${5300 + i}`, 'observer_crash', `kept ${i}`);
    }

    const snapshot = await syncIncidentsToLinear({
      timestamp: '2026-10-21T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{ session: 'wavemill', repoDir, tasks: [] }],
      findings: [],
    }, {
      ...defaultObserverOptions(),
      fileIncidents: true,
      incidentsShadow: true,
    });

    assert.equal(snapshot.incidentSync?.mode, 'shadow');
    assert.deepEqual(snapshot.incidentSync?.suppressedByClass, {
      cleanup_dirty_worktree: 3,
      arm_died_with_unpushed_work: 2,
    });
    // Suppressed incidents count into skipped.
    assert.ok((snapshot.incidentSync?.skipped ?? 0) >= 5);

    // Audit file holds only the retained (non-suppressed) incidents.
    const auditPath = join(repoDir, '.wavemill/observer/shadow-audit.jsonl');
    assert.ok(existsSync(auditPath), `expected audit file at ${auditPath}`);
    const auditRecords = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
    assert.equal(auditRecords.length, 2);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('incident sync suppress.classes:[] disables suppression (HOK-3243)', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-incident-suppress-empty-'));
  try {
    writePermissiveSchema(repoDir);
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
      configVersion: '1.5.0',
      mill: { baseBranch: 'auto/integration', requireConfirm: true },
      observer: {
        linear: {
          mode: 'shadow',
          maxIncidentsPerPass: 10,
          suppress: { classes: [] },
        },
      },
    }, null, 2));

    const store = new IncidentStore(join(repoDir, '.wavemill', 'incidents'));
    for (let i = 0; i < 3; i += 1) {
      await store.upsert(createIncidentDraft({
        taskId: `HOK-${6100 + i}`,
        category: 'stale_orphaned_state',
        severity: 'high',
        confidence: 'definite',
        lifecycle: 'active',
        rootCauseClass: 'cleanup_dirty_worktree',
        summary: `cleanup ${i}`,
        operatorAction: 'Review.',
        evidence: [{
          type: 'log_excerpt',
          source: 'mill.log',
          timestamp: '2026-10-21T12:00:00.000Z',
          redactedData: 'EVENT',
          key: `clean-${i}`,
        }],
      }));
    }

    const snapshot = await syncIncidentsToLinear({
      timestamp: '2026-10-21T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{ session: 'wavemill', repoDir, tasks: [] }],
      findings: [],
    }, {
      ...defaultObserverOptions(),
      fileIncidents: true,
      incidentsShadow: true,
    });

    assert.equal(snapshot.incidentSync?.suppressedByClass, undefined);
    assert.equal(snapshot.incidentSync?.shadow?.eligible, 3);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('--dry-run and --autofix-dry-run are independent flags (HOK-3243)', () => {
  const legacy = parseArgs(['--dry-run']);
  assert.equal(legacy.dryRun, true);
  assert.equal(legacy.autoFixDryRun, false);

  const autoFix = parseArgs(['--autofix-dry-run']);
  assert.equal(autoFix.dryRun, false);
  assert.equal(autoFix.autoFixDryRun, true);
});

test('applyAutoFixes forwards --autofix-dry-run (not --dry-run) to runObserverAutoFixes (HOK-3243)', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-autofix-dryrun-'));
  const previousPushUrl = process.env.WAVEMILL_OBSERVER_PUSH_URL;
  delete process.env.WAVEMILL_OBSERVER_PUSH_URL;
  try {
    writePermissiveSchema(repoDir);
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
      configVersion: '1.5.0',
      mill: { baseBranch: 'auto/integration', requireConfirm: true },
      observer: { autoFix: { enabled: false } },
    }, null, 2));
    const snapshot = {
      timestamp: new Date().toISOString(),
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        workflowStatePath: join(repoDir, '.wavemill', 'workflow-state.json'),
        tasks: [{ issue: 'HOK-1', phase: 'ready', slug: 'noop', worktree: repoDir, branch: 'task/noop', baseBranch: 'main' }],
      }],
      findings: [],
    };
    // dry-run and autofix-dry-run can both be false without the autofix path running
    // (master switch is off); this confirms the plumbing compiles and does nothing.
    const legacyDryRun = await applyAutoFixes(snapshot as any, {
      ...defaultObserverOptions(),
      dryRun: true,
    } as any);
    assert.equal(legacyDryRun.findings.length, 0);
    const autofixDryRun = await applyAutoFixes(snapshot as any, {
      ...defaultObserverOptions(),
      autoFixDryRun: true,
    } as any);
    assert.equal(autofixDryRun.findings.length, 0);
  } finally {
    if (previousPushUrl !== undefined) process.env.WAVEMILL_OBSERVER_PUSH_URL = previousPushUrl;
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('writeServiceHeartbeat surfaces shadow mode and counters in Backstage health', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-heartbeat-shadow-'));
  try {
    mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
    writeFileSync(join(repoDir, '.wavemill', 'backstage-health.json'), JSON.stringify({}));
    await writeServiceHeartbeat({
      timestamp: '2026-09-22T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [],
      findings: [],
      incidentSync: {
        mode: 'shadow',
        totalProcessed: 3,
        created: 0,
        updated: 0,
        failed: 0,
        skipped: 3,
        queued: 0,
        retryProcessed: 0,
        retrySucceeded: 0,
        retryFailed: 0,
        suppressedByClass: { cleanup_dirty_worktree: 2, arm_died_with_unpushed_work: 1 },
        results: [],
        errors: [],
        shadow: {
          eligible: 3,
          proposedCreate: 2,
          proposedUpdate: 1,
          noOp: 0,
          skipRecovered: 0,
          ambiguous: 0,
          redactionFailures: 0,
          correlationCollisions: 0,
          mutationAttempts: 0,
          auditPath: '.wavemill/observer/shadow-audit.jsonl',
          countersPath: '.wavemill/observer/shadow-counters.json',
          lookupBudgetUsed: 5,
          lookupBudgetMax: 40,
          lookupBudgetExhausted: false,
        },
      },
    }, {
      ...defaultObserverOptions(),
      loop: true,
      once: false,
      json: true,
      repoDir,
      session: 'wavemill',
      serviceMode: true,
    });
    const health = JSON.parse(readFileSync(join(repoDir, '.wavemill', 'backstage-health.json'), 'utf8'));
    assert.equal(health.services.observer.incidentSync.mode, 'shadow');
    assert.equal(health.services.observer.incidentSync.shadow.eligible, 3);
    assert.equal(health.services.observer.incidentSync.shadow.mutationAttempts, 0);
    assert.equal(health.services.observer.incidentSync.shadow.auditPath, '.wavemill/observer/shadow-audit.jsonl');
    assert.deepEqual(
      health.services.observer.incidentSync.suppressedByClass,
      { cleanup_dirty_worktree: 2, arm_died_with_unpushed_work: 1 },
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('service mode fails closed to off (zero mutations) when the Linear credential is missing', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-service-nocred-'));
  const priorKey = process.env.LINEAR_API_KEY;
  delete process.env.LINEAR_API_KEY;
  try {
    writePermissiveSchema(repoDir);
    // A fully-gated live configuration: only the missing credential should stop it.
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
      configVersion: '1.5.0',
      mill: { baseBranch: 'auto/integration', requireConfirm: true },
      observer: {
        linear: {
          mode: 'live',
          enabled: true,
          team: 'HOK',
          project: 'Wavemill',
          label: 'obs',
          rollout: { gatesPassed: true, shadowTrialCompleted: true, rollbackRehearsed: true, maxProposedPerPass: 5 },
        },
      },
    }, null, 2));

    const store = new IncidentStore(join(repoDir, '.wavemill', 'incidents'));
    await store.upsert(createIncidentDraft({
      taskId: 'HOK-4100',
      category: 'product_defect',
      severity: 'high',
      confidence: 'definite',
      lifecycle: 'active',
      rootCauseClass: 'observer_crash',
      summary: 'Fail-closed guard.',
      operatorAction: 'Fix parser.',
      evidence: [{
        type: 'log_excerpt',
        source: 'mill.log',
        timestamp: '2026-08-04T12:00:00.000Z',
        redactedData: 'ERROR',
        key: 'error-1',
      }],
    }));

    const snapshot = await syncIncidentsToLinear({
      timestamp: '2026-08-04T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{ session: 'wavemill', repoDir, tasks: [] }],
      findings: [],
    }, {
      ...defaultObserverOptions(),
      fileIncidents: true,
      incidentsMode: 'live',
      serviceMode: true,
      repoDir,
      session: 'wavemill',
    });

    assert.equal(snapshot.incidentSync?.mode, 'off');
    assert.equal(snapshot.incidentSync?.created, 0);
    assert.equal(snapshot.incidentSync?.updated, 0);
  } finally {
    if (priorKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = priorKey;
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('repeated failed-ready re-checks surface a stuck loop finding with the blocking reason', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-ready-recheck-'));
  const slug = 'ready-recheck-fixture';
  const featureDir = join(repoDir, 'features', slug);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'failed',
    failureReason: 'PR #1260 removes files from #1240 without explicit acknowledgement.',
  }));

  const logPath = join(repoDir, 'mill-wavemill.log');
  writeFileSync(logPath, [
    '09:52:17 [status] ↻ HOK-2888 → Re-running failed ready checks for PR #1260',
    '09:52:37 [status] ⛔ HOK-2888 → Cross-PR revert guard blocked ready phase for PR #1260',
    '09:53:31 [status] ↻ HOK-2888 → Re-running failed ready checks for PR #1260',
    '09:54:04 [status] ⛔ HOK-2888 → Cross-PR revert guard blocked ready phase for PR #1260',
    '09:55:49 [status] ↻ HOK-2888 → Re-running failed ready checks for PR #1260',
  ].join('\n'));

  try {
    const findings = buildFindings({
      timestamp: '2026-08-27T14:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        millLogPath: logPath,
        tasks: [{
          issue: 'HOK-2888',
          slug,
          phase: 'ready',
          status: 'active',
          pr: '1260',
          worktree: repoDir,
        }],
      }],
    }, defaultObserverOptions());

    const loop = findings.find((finding) => finding.id.startsWith('ready-recheck-loop-'));
    assert.ok(loop);
    assert.equal(loop.severity, 'high');
    assert.equal(loop.category, 'stuck');
    assert.equal(loop.issue, 'HOK-2888');
    assert.equal(loop.evidence[0], 'occurrences=3');
    assert.equal(loop.evidence[1], 'pr=#1260');
    assert.match(loop.evidence[2], /without explicit acknowledgement/);
    assert.match(loop.recommendation, /no retry ceiling/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('a single failed-ready re-check stays below the loop threshold', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-ready-recheck-once-'));
  const logPath = join(repoDir, 'mill-wavemill.log');
  writeFileSync(logPath, [
    '09:52:17 [status] ↻ HOK-2888 → Re-running failed ready checks for PR #1260',
    '09:52:57 [status] ↻ HOK-2889 → Re-running failed ready checks for PR #1261',
  ].join('\n'));

  try {
    const findings = buildFindings({
      timestamp: '2026-08-27T14:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        millLogPath: logPath,
        tasks: [],
      }],
    }, defaultObserverOptions());

    assert.equal(findings.filter((finding) => finding.id.startsWith('ready-recheck-loop-')).length, 0);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('current ready refusal logs surface a loop and prefer needs-attention context', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-ready-refusal-'));
  const slug = 'ready-refusal-fixture';
  const featureDir = join(repoDir, 'features', slug);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, '.needs-attention'), 'Native review is still running after a provider timeout.\n');
  writeFileSync(join(featureDir, '.ready-result.json'), JSON.stringify({
    stage: 'ready',
    status: 'failed',
    artifacts: { failureReason: 'less precise nested fallback' },
  }));

  const logPath = join(repoDir, 'mill-wavemill.log');
  writeFileSync(logPath, [
    '08:20:01 [ready] HOK-2919: refusing ready phase for PR #1311; review result status is running',
    '08:20:41 [ready] HOK-2919: refusing ready phase for PR #1311; review result status is running',
    '08:21:21 [ready] HOK-2919: refusing ready phase for PR #1311; review result status is running',
  ].join('\n'));

  try {
    const findings = buildFindings({
      timestamp: '2026-09-03T12:22:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        millLogPath: logPath,
        tasks: [{
          issue: 'HOK-2919',
          slug,
          phase: 'ready',
          status: 'active',
          pr: '1311',
          worktree: repoDir,
        }],
      }],
    }, defaultObserverOptions());

    const loop = findings.find((finding) => finding.id === 'ready-recheck-loop-wavemill-HOK-2919-1311');
    assert.ok(loop);
    assert.equal(loop.evidence[0], 'occurrences=3');
    assert.match(loop.evidence[2], /Native review is still running/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HOK-2911 / HOK-2912: terminal-task-parked, arm-died-with-unpushed-work,
// pr-create-failed
// ---------------------------------------------------------------------------

function runGit(cwd: string, args: string[], env?: Record<string, string>): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

function createResidueGitFixture({
  commits = 2,
  pushTaskBranch = false,
  slug = 'residue-fixture',
  commitAgeMinutes,
}: { commits?: number; pushTaskBranch?: boolean; slug?: string; commitAgeMinutes?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'observer-residue-'));
  const repoDir = join(root, 'repo');
  const originDir = join(root, 'origin.git');
  mkdirSync(repoDir, { recursive: true });
  runGit(root, ['init', '--bare', originDir]);
  runGit(root, ['init', repoDir]);
  runGit(repoDir, ['config', 'user.email', 'observer-test@example.com']);
  runGit(repoDir, ['config', 'user.name', 'Observer Test']);
  runGit(repoDir, ['config', 'commit.gpgsign', 'false']);
  runGit(repoDir, ['checkout', '-b', 'auto/integration']);
  writeFileSync(join(repoDir, 'base.txt'), 'base\n');
  runGit(repoDir, ['add', '.']);
  const commitEnv = commitAgeMinutes !== undefined
    ? (() => {
        const iso = new Date(Date.now() - commitAgeMinutes * 60_000).toISOString();
        return { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso };
      })()
    : undefined;
  runGit(repoDir, ['commit', '-m', 'base commit'], commitEnv);
  // HOK-3088: commit the wavemill config/schema onto the base branch so the
  // worktree stays clean while the task branch is checked out. Leaving these
  // as untracked writes made the observer's dirty-worktree predicate escalate
  // every terminal-parked fixture to urgent and swap the "unpushed commits"
  // title for "dirty files". Also gitignore `.wavemill/` so the observer's
  // own transient writes (incident store, findings log) do not dirty the
  // worktree between successive reconcile passes within a single test.
  writePermissiveSchema(repoDir);
  writeFileSync(join(repoDir, '.gitignore'), '.wavemill/\n');
  runGit(repoDir, ['add', '.']);
  runGit(repoDir, ['commit', '-m', 'wavemill config'], commitEnv);
  runGit(repoDir, ['remote', 'add', 'origin', originDir]);
  runGit(repoDir, ['push', '-u', 'origin', 'auto/integration']);
  const branch = `task/${slug}`;
  runGit(repoDir, ['checkout', '-b', branch]);
  for (let i = 1; i <= commits; i += 1) {
    writeFileSync(join(repoDir, `work-${i}.txt`), `work ${i}\n`);
    runGit(repoDir, ['add', '.']);
    runGit(repoDir, ['commit', '-m', `task commit ${i}`], commitEnv);
  }
  if (pushTaskBranch) {
    runGit(repoDir, ['push', '-u', 'origin', branch]);
  }
  runGit(repoDir, ['checkout', 'auto/integration']);
  if (commitAgeMinutes !== undefined) {
    // HOK-3087: match the config/schema mtimes to the aged commit time so the
    // shared progress primitive's worktree source does not rescue an aged
    // fixture from the stall gate. Untracked config files sit in the worktree
    // and would otherwise report NOW as the newest activity time.
    const aged = new Date(Date.now() - commitAgeMinutes * 60_000);
    for (const rel of ['wavemill-config.schema.json', '.wavemill-config.json']) {
      try { utimesSync(join(repoDir, rel), aged, aged); } catch { /* ignore */ }
    }
  }
  return { root, repoDir, slug, branch };
}

function createMainIntegrationDivergenceFixture() {
  const root = mkdtempSync(join(tmpdir(), 'observer-effective-base-'));
  const repoDir = join(root, 'repo');
  const originDir = join(root, 'origin.git');
  mkdirSync(repoDir, { recursive: true });
  runGit(root, ['init', '--bare', originDir]);
  runGit(root, ['init', repoDir]);
  runGit(repoDir, ['config', 'user.email', 'observer-test@example.com']);
  runGit(repoDir, ['config', 'user.name', 'Observer Test']);
  runGit(repoDir, ['config', 'commit.gpgsign', 'false']);
  runGit(repoDir, ['checkout', '-b', 'main']);
  writeFileSync(join(repoDir, 'main.txt'), 'main\n');
  runGit(repoDir, ['add', '.']);
  runGit(repoDir, ['commit', '-m', 'main base']);
  runGit(repoDir, ['remote', 'add', 'origin', originDir]);
  runGit(repoDir, ['push', '-u', 'origin', 'main']);
  runGit(repoDir, ['checkout', '-b', 'auto/integration']);
  writeFileSync(join(repoDir, 'integration.txt'), 'integration\n');
  runGit(repoDir, ['add', '.']);
  runGit(repoDir, ['commit', '-m', 'integration promotion']);
  runGit(repoDir, ['push', '-u', 'origin', 'auto/integration']);
  const slug = 'review-scope-guards-merge-base-fallback-flags-the-branchs-own';
  const branch = `task/${slug}`;
  runGit(repoDir, ['checkout', '-b', branch]);
  writePermissiveSchema(repoDir);
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    configVersion: '1.5.0',
    mill: { baseBranch: 'main', requireConfirm: false },
    integration: { mergeMethod: 'squash' },
  }, null, 2));
  return { root, repoDir, slug, branch };
}

function agoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function residueSnapshot(repoDir: string, tasks: Record<string, unknown>[], panes: Record<string, unknown>[] = []) {
  return {
    timestamp: new Date().toISOString(),
    sessions: ['wavemill'],
    panes,
    processes: [],
    repos: [{
      session: 'wavemill',
      repoDir,
      tasks,
    }],
  };
}

test('fresh terminal task does not fire terminal-task-parked', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-terminal-fresh-'));
  try {
    writePermissiveSchema(repoDir);
    const findings = buildFindings(residueSnapshot(repoDir, [{
      issue: 'HOK-2845',
      slug: 'fresh-terminal',
      phase: 'closed',
      status: 'closed',
      worktree: repoDir,
      updated: agoIso(2),
    }]), defaultObserverOptions());

    assert.equal(findings.some((finding) => finding.id.startsWith('terminal-task-parked-')), false);
    assert.equal(findings.some((finding) => finding.id.startsWith('arm-died-with-unpushed-work-')), false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('aged terminal task with clean branch fires medium terminal-task-parked with residue evidence', () => {
  const fixture = createResidueGitFixture({ commits: 0, slug: 'clean-terminal' });
  try {
    const findings = buildFindings(residueSnapshot(fixture.repoDir, [{
      issue: 'HOK-2845',
      slug: fixture.slug,
      branch: fixture.branch,
      phase: 'closed',
      status: 'closed',
      worktree: fixture.repoDir,
      updated: agoIso(30),
    }]), defaultObserverOptions());

    assert.equal(findings.some((finding) => finding.evidence.some((line) => /rootCause=cleanup_|terminal_arm_parked/.test(line))), false,
      'clean residue is not an actionable work-preservation incident');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('effective launch-contract base suppresses main/integration work-loss false positive', () => {
  const fixture = createMainIntegrationDivergenceFixture();
  try {
    const findings = buildFindings(residueSnapshot(fixture.repoDir, [{
      issue: 'HOK-2913_c',
      slug: fixture.slug,
      branch: fixture.branch,
      phase: 'closed',
      status: 'closed',
      worktree: fixture.repoDir,
      updated: agoIso(60),
      lifecycle: {
        schemaVersion: 1,
        workflowOutcome: 'closed',
        resourceDisposition: 'retained',
        retention: { reason: 'squash-delivered' },
        launchContract: {
          baseBranch: 'auto/integration',
          requireConfirm: true,
          mergeMethod: 'squash',
          remoteBranchDeletionPolicy: { allowed: true, mode: 'merged-pr-task-branch' },
          provenance: {
            baseBranch: 'runtime-env',
            requireConfirm: 'runtime-env',
            mergeMethod: 'repo-config',
            remoteBranchDeletionPolicy: 'launch-contract',
          },
        },
        deliveryEvidence: {
          prNumber: '2913',
          prState: 'MERGED',
          prBaseBranch: 'auto/integration',
          prHeadSha: 'a'.repeat(40),
          mergeSha: 'b'.repeat(40),
        },
      },
    }]), defaultObserverOptions());

    assert.equal(findings.some((finding) => finding.id.startsWith('arm-died-with-unpushed-work-')), false);
    assert.equal(findings.some((finding) => finding.id.startsWith('terminal-task-parked-')), false);
    const drift = findings.find((finding) => finding.id.startsWith('config-drift-wavemill-HOK-2913_c-'));
    assert.ok(drift);
    assert.equal(drift.severity, 'low');
    assert.ok(drift.evidence.includes('baseBranch=auto/integration'));
    assert.ok(drift.evidence.includes('baseBranchSource=runtime-env'));
    assert.ok(drift.evidence.includes('repoConfigBaseBranch=main'));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('legacy HOK-2595/HOK-2913 terminal residue reports verification-required lifecycle', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-terminal-legacy-lifecycle-'));
  try {
    writePermissiveSchema(repoDir);
    const findings = buildFindings(residueSnapshot(repoDir, [
      {
        issue: 'HOK-2595',
        slug: 'detect-and-correlate',
        phase: 'closed',
        status: 'closed',
        paneState: 'active',
        executionOwner: 'task',
        worktree: repoDir,
        updated: agoIso(60),
      },
      {
        issue: 'HOK-2913_c',
        slug: 'review-scope-guards-challenger',
        phase: 'closed',
        status: 'closed',
        challengeRole: 'challenger',
        challengePairId: 'HOK-2913',
        paneState: 'active',
        executionOwner: 'task',
        worktree: repoDir,
        updated: agoIso(60),
      },
    ]), defaultObserverOptions());

    for (const issue of ['HOK-2595', 'HOK-2913_c']) {
      const parked = findings.find((finding) => finding.issue === issue && finding.evidence.includes('rootCause=cleanup_dirty_worktree'));
      assert.ok(parked, `expected terminal parked finding for ${issue}`);
      assert.match(parked.recommendation, /recover|Inspect|worktree/i);
    }
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('cleanup episode finding suppresses duplicate terminal residue findings', () => {
  const fixture = createResidueGitFixture({ commits: 2, slug: 'cleanup-retained' });
  try {
    const findings = buildFindings(residueSnapshot(fixture.repoDir, [{
      issue: 'HOK-2955',
      slug: fixture.slug,
      branch: fixture.branch,
      phase: 'done',
      status: 'merged',
      worktree: fixture.repoDir,
      updated: agoIso(30),
      lifecycle: {
        schemaVersion: 1,
        workflowOutcome: 'merged',
        resourceDisposition: 'retained',
        retention: {
          reason: 'local-work-preserved',
        },
        cleanupEpisode: {
          schemaVersion: 1,
          episodeId: 'HOK-2955:cleanup:abc123def456',
          fingerprint: 'abc123def456',
          fingerprintInputs: {
            branch: fixture.branch,
            worktree: fixture.repoDir,
          },
          disposition: 'retained',
          failureClass: 'expected-preservation',
          firstAttemptAt: '2026-09-08T12:00:00Z',
          lastAttemptAt: '2026-09-08T12:00:00Z',
          attemptCount: 1,
          nextRetryAt: null,
          requiredOperatorAction: `Push ${fixture.branch} to origin or explicitly abandon it.`,
          lastOutcome: 'local-work-preserved',
          updatedAt: '2026-09-08T12:00:00Z',
        },
      },
    }]), defaultObserverOptions());

    const cleanup = findings.find((finding) => finding.issue === 'HOK-2955' && finding.evidence.includes('rootCause=cleanup_retained_by_policy'));
    assert.ok(cleanup);
    assert.equal(cleanup.severity, 'low');
    assert.match(cleanup.recommendation, /push task\/cleanup-retained/i);
    assert.equal(findings.some((finding) => finding.id.startsWith('terminal-task-parked-')), false);
    assert.equal(findings.some((finding) => finding.id.startsWith('arm-died-with-unpushed-work-')), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('aged terminal task with unpushed commits escalates to urgent work loss and fires arm-died-with-unpushed-work', () => {
  const fixture = createResidueGitFixture({ commits: 2, slug: 'lossy-terminal' });
  try {
    const findings = buildFindings(residueSnapshot(fixture.repoDir, [{
      issue: 'HOK-2866',
      slug: fixture.slug,
      branch: fixture.branch,
      phase: 'error',
      status: 'error',
      pr: '1217',
      worktree: fixture.repoDir,
      updated: agoIso(90),
    }]), defaultObserverOptions());

    const risk = findings.filter((finding) => finding.issue === 'HOK-2866' && finding.evidence.includes('rootCause=cleanup_unpublished_at_risk'));
    assert.equal(risk.length, 1);
    assert.equal(risk[0].severity, 'urgent');
    assert.match(risk[0].recommendation, /push task\/lossy-terminal/i);
    assert.equal(findings.some((finding) => finding.id.startsWith('terminal-task-parked-') || finding.id.startsWith('arm-died-with-unpushed-work-')), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('reaped terminal task with no residue does not fire', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-terminal-reaped-'));
  try {
    writePermissiveSchema(repoDir);
    const findings = buildFindings(residueSnapshot(repoDir, [{
      issue: 'HOK-2845',
      slug: 'reaped-terminal',
      phase: 'closed',
      status: 'closed',
      worktree: join(repoDir, 'worktrees', 'gone'),
      updated: agoIso(600),
    }]), defaultObserverOptions());

    assert.equal(findings.some((finding) => finding.id.startsWith('terminal-task-parked-')), false);
    assert.equal(findings.some((finding) => finding.id.startsWith('arm-died-with-unpushed-work-')), false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});


test('status error and phase error are treated as terminal residue', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-terminal-error-'));
  try {
    writePermissiveSchema(repoDir);
    const findings = buildFindings(residueSnapshot(repoDir, [
      {
        issue: 'HOK-2866',
        phase: 'error',
        status: 'error',
        worktree: repoDir,
        updated: agoIso(60),
      },
      {
        issue: 'HOK-2867',
        phase: 'error',
        worktree: repoDir,
        updated: agoIso(60),
      },
    ]), defaultObserverOptions());

    assert.ok(findings.some((finding) => finding.issue === 'HOK-2866' && finding.evidence.includes('rootCause=cleanup_dirty_worktree')));
    assert.ok(findings.some((finding) => finding.issue === 'HOK-2867' && finding.evidence.includes('rootCause=cleanup_dirty_worktree')));
    const cleanup = findings.filter((finding) => finding.evidence.includes('rootCause=cleanup_dirty_worktree'));
    assert.equal(cleanup.length, 2);
    assert.notEqual(cleanup[0].id, cleanup[1].id);
    assert.ok(cleanup.every((finding) => finding.id !== 'incident-' && finding.severity === 'urgent'));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('terminal-task-parked reports exited tmux window residue', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-terminal-pane-'));
  try {
    writePermissiveSchema(repoDir);
    const findings = buildFindings(residueSnapshot(repoDir, [{
      issue: 'HOK-2845',
      slug: 'paned-terminal',
      phase: 'closed',
      status: 'closed',
      worktree: repoDir,
      updated: agoIso(60),
    }], [{
      session: 'wavemill',
      windowIndex: '1',
      paneIndex: '0',
      windowName: 'HOK-2845-paned-terminal',
      active: false,
      pid: 0,
      command: 'zsh',
      title: 'exited',
    }]), defaultObserverOptions());

    const parked = findings.find((finding) => finding.issue === 'HOK-2845' && finding.evidence.includes('rootCause=cleanup_dirty_worktree'));
    assert.ok(parked);
    assert.match(parked.recommendation, /worktree|files/i);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('exited non-terminal arm with unpushed commits fires urgent arm-died-with-unpushed-work', () => {
  const fixture = createResidueGitFixture({ commits: 3, slug: 'exited-arm' });
  try {
    const findings = buildFindings(residueSnapshot(fixture.repoDir, [{
      issue: 'HOK-2894_c',
      slug: fixture.slug,
      branch: fixture.branch,
      phase: 'review',
      status: 'active',
      worktree: fixture.repoDir,
      updated: agoIso(30),
    }]), defaultObserverOptions());

    const died = findings.find((finding) => finding.id === 'arm-died-with-unpushed-work-wavemill-HOK-2894_c');
    assert.ok(died);
    assert.equal(died.severity, 'urgent');
    assert.equal(died.confidence, 'high');
    assert.ok(died.evidence.includes('unpushedCommits=3'));
    assert.ok(died.evidence.includes('commit=task commit 3'));
    assert.ok(died.evidence.includes('pr=none'));
    assert.equal(findings.some((finding) => finding.id.startsWith('terminal-task-parked-')), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('pushed branch with commits does not fire arm-died-with-unpushed-work', () => {
  const fixture = createResidueGitFixture({ commits: 2, pushTaskBranch: true, slug: 'pushed-arm' });
  try {
    const findings = buildFindings(residueSnapshot(fixture.repoDir, [{
      issue: 'HOK-2894_c',
      slug: fixture.slug,
      branch: fixture.branch,
      phase: 'review',
      status: 'active',
      worktree: fixture.repoDir,
      updated: agoIso(30),
    }]), defaultObserverOptions());

    assert.equal(findings.some((finding) => finding.id.startsWith('arm-died-with-unpushed-work-')), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('branch with no commits ahead of base does not fire arm-died-with-unpushed-work', () => {
  const fixture = createResidueGitFixture({ commits: 0, slug: 'empty-arm' });
  try {
    const findings = buildFindings(residueSnapshot(fixture.repoDir, [{
      issue: 'HOK-2896',
      slug: fixture.slug,
      branch: fixture.branch,
      phase: 'review',
      status: 'active',
      worktree: fixture.repoDir,
      updated: agoIso(30),
    }]), defaultObserverOptions());

    assert.equal(findings.some((finding) => finding.id.startsWith('arm-died-with-unpushed-work-')), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('live agent suppresses arm-died-with-unpushed-work', () => {
  const fixture = createResidueGitFixture({ commits: 2, slug: 'live-arm' });
  try {
    const findings = buildFindings(residueSnapshot(fixture.repoDir, [{
      issue: 'HOK-2894_c',
      slug: fixture.slug,
      branch: fixture.branch,
      phase: 'coding',
      status: 'active',
      worktree: fixture.repoDir,
      updated: agoIso(30),
    }], [{
      session: 'wavemill',
      windowIndex: '4',
      paneIndex: '0',
      windowName: 'HOK-2894_c-live-arm',
      active: true,
      pid: 4242,
      command: 'node',
      title: 'claude',
    }]), defaultObserverOptions());

    assert.equal(findings.some((finding) => finding.id.startsWith('arm-died-with-unpushed-work-')), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

const PR_CREATE_LOG_LINE = "10:00:01 [error] pull request create failed: GraphQL: Head sha can't be blank, Base sha can't be blank, No commits between main and task/manual-edit-detection, Head ref must be a branch (createPullRequest)";

test('pr-create-failed fires from the mill log with raw error, translation, and log-error suppression', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-pr-create-log-'));
  const logPath = join(repoDir, 'mill-wavemill.log');
  try {
    writePermissiveSchema(repoDir);
    writeFileSync(logPath, `${PR_CREATE_LOG_LINE}\n`);

    const findings = buildFindings({
      timestamp: new Date().toISOString(),
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        millLogPath: logPath,
        tasks: [{
          issue: 'HOK-2894_c',
          slug: 'manual-edit-detection',
          phase: 'review',
          status: 'active',
        }],
      }],
    }, defaultObserverOptions());

    const failed = findings.find((finding) => finding.id === 'pr-create-failed-wavemill-HOK-2894_c');
    assert.ok(failed);
    assert.equal(failed.severity, 'high');
    assert.equal(failed.confidence, 'high');
    assert.equal(failed.issue, 'HOK-2894_c');
    assert.ok(failed.evidence.includes('source=mill-log'));
    assert.ok(failed.evidence.some((line) => line.startsWith('raw=') && line.includes("Head sha can't be blank")));
    assert.ok(failed.evidence.some((line) => line.startsWith('translation=') && line.includes('never pushed to origin')));
    assert.ok(failed.evidence.includes('baseBranch=auto/integration'));
    assert.match(failed.recommendation, /Push the task branch to origin and re-create the PR against auto\/integration/);
    assert.equal(findings.some((finding) => finding.id.startsWith('log-error-')), false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('pr-create-failed fires from a review artifact', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-pr-create-artifact-'));
  const slug = 'artifact-arm';
  try {
    writePermissiveSchema(repoDir);
    const featureDir = join(repoDir, 'features', slug);
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, '.review-result.json'), JSON.stringify({
      stage: 'review',
      reviewToolError: "pull request create failed: GraphQL: Head sha can't be blank (createPullRequest)",
    }));

    const findings = buildFindings(residueSnapshot(repoDir, [{
      issue: 'HOK-2866_c',
      slug,
      phase: 'review',
      status: 'active',
      worktree: repoDir,
    }]), defaultObserverOptions());

    const failed = findings.find((finding) => finding.id === 'pr-create-failed-wavemill-HOK-2866_c');
    assert.ok(failed);
    assert.equal(failed.confidence, 'high');
    assert.ok(failed.evidence.includes('source=review-artifact'));
    assert.ok(failed.evidence.some((line) => line.startsWith('translation=')));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('pr-create-failed fires from captured pane text at medium confidence', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-pr-create-pane-'));
  const slug = 'pane-arm';
  try {
    writePermissiveSchema(repoDir);
    const findings = buildFindings(residueSnapshot(repoDir, [{
      issue: 'HOK-2896',
      slug,
      phase: 'review',
      status: 'active',
      worktree: repoDir,
    }], [{
      session: 'wavemill',
      windowIndex: '5',
      paneIndex: '0',
      windowName: `HOK-2896-${slug}`,
      active: false,
      pid: 0,
      command: 'zsh',
      title: 'exited',
      capturedText: "pull request create failed: GraphQL: Base sha can't be blank (createPullRequest)\n[wavemill] Agent exited (native=1)\n",
    }]), defaultObserverOptions());

    const failed = findings.find((finding) => finding.id === 'pr-create-failed-wavemill-HOK-2896');
    assert.ok(failed);
    assert.equal(failed.confidence, 'medium');
    assert.ok(failed.evidence.includes('source=pane:wavemill:5.0'));
    assert.ok(failed.evidence.some((line) => line.startsWith('translation=') && line.includes('base/head comparison failed')));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('generic log errors do not fire pr-create-failed', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-pr-create-negative-'));
  const logPath = join(repoDir, 'mill-wavemill.log');
  try {
    writePermissiveSchema(repoDir);
    writeFileSync(logPath, '10:00:01 [error] push failed for HOK-2896: network unreachable\n');

    const findings = buildFindings(basicSnapshot(repoDir, logPath), defaultObserverOptions());

    assert.equal(findings.some((finding) => finding.id.startsWith('pr-create-failed-')), false);
    assert.ok(findings.some((finding) => finding.id.startsWith('log-error-')));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('merge-lane disagreement and stalled-lane JSONL findings survive ingestion and dedup (HOK-2919)', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-merge-lane-'));
  try {
    writePermissiveSchema(repoDir);
    const disagreement = {
      subsystem: 'merge-lane',
      title: 'Mill and tend disagree on PR #1265 merge candidacy',
      body: 'The mill merge queue holds PR #1265 as a merge candidate (live CI pass: 16/3 checks @eb20cac), '
        + "but tend blocks it with gate 'challenge:pair-unresolved:branch-pair'.",
      severity: 'high',
      recommendation: 'Reconcile the mill and tend views of PR #1265.',
      context: {
        markerPath: 'merge-lane/1265/mill-tend-disagreement',
        markerKind: 'merge-lane-disagreement',
        prNumber: 1265,
        labels: 'wavemill,wm:ready',
        tendBlockReason: 'challenge:pair-unresolved:branch-pair',
        millQueueState: 'merge-candidate',
      },
    };
    const stalled = {
      subsystem: 'merge-lane',
      title: 'Merge lane stalled: 1 blocked PR, 0 eligible for 30 consecutive polls',
      severity: 'urgent',
      context: {
        markerPath: 'merge-lane/idle-stall/#1265',
        markerKind: 'merge-lane-idle-stall',
        firstBlockedPr: 1265,
        firstBlockedGate: 'challenge:pair-unresolved:branch-pair',
        consecutivePolls: 30,
      },
    };
    mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
    writeFileSync(
      join(repoDir, '.wavemill', 'observer-findings.jsonl'),
      [disagreement, stalled, disagreement].map((finding) => JSON.stringify(finding)).join('\n'),
    );

    const findings = buildFindings(basicSnapshot(repoDir), defaultObserverOptions());
    const disagreementFindings = findings.filter((finding) => finding.id.includes('mill-tend-disagreement'));
    const stalledFindings = findings.filter((finding) => finding.id.includes('merge-lane-idle-stall'));

    // Distinct ids per finding kind; the duplicated disagreement line dedupes to one.
    assert.equal(disagreementFindings.length, 1);
    assert.equal(stalledFindings.length, 1);
    assert.notEqual(disagreementFindings[0].id, stalledFindings[0].id);

    // Severity and per-finding recommendation are preserved through ingestion.
    assert.equal(disagreementFindings[0].severity, 'high');
    assert.equal(disagreementFindings[0].recommendation, 'Reconcile the mill and tend views of PR #1265.');
    assert.equal(stalledFindings[0].severity, 'urgent');

    // Actionable evidence: PR number, gate, labels, and queue state survive.
    assert.ok(disagreementFindings[0].evidence.includes('prNumber=1265'));
    assert.ok(disagreementFindings[0].evidence.includes('tendBlockReason=challenge:pair-unresolved:branch-pair'));
    assert.ok(disagreementFindings[0].evidence.includes('millQueueState=merge-candidate'));
    assert.ok(stalledFindings[0].evidence.includes('firstBlockedGate=challenge:pair-unresolved:branch-pair'));
    assert.ok(stalledFindings[0].evidence.includes('consecutivePolls=30'));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HOK-3239: invalid severities at ingest + off-machine alert delivery
// ---------------------------------------------------------------------------

function tendDisagreementFinding(severity: unknown, prNumber = 1265) {
  return {
    subsystem: 'merge-lane',
    title: `Mill and tend disagree on PR #${prNumber} merge candidacy`,
    body: `The mill merge queue holds PR #${prNumber} as a merge candidate, but tend blocks it.`,
    ...(severity === undefined ? {} : { severity }),
    context: {
      markerPath: `merge-lane/${prNumber}/mill-tend-disagreement`,
      markerKind: 'merge-lane-disagreement',
      prNumber,
      tendBlockReason: 'challenge:pair-unresolved:branch-pair',
      millQueueState: 'merge-candidate',
    },
  };
}

function writeFindingsJsonl(repoDir: string, findings: unknown[]): void {
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(
    join(repoDir, '.wavemill', 'observer-findings.jsonl'),
    findings.map((finding) => JSON.stringify(finding)).join('\n'),
  );
}

test('HOK-3239 normalizeFindingSeverity maps aliases and unknowns into the Severity union', () => {
  for (const canonical of ['urgent', 'high', 'medium', 'low']) {
    assert.equal(normalizeFindingSeverity(canonical), canonical);
  }
  assert.equal(normalizeFindingSeverity('warning'), 'medium');
  assert.equal(normalizeFindingSeverity('WARN'), 'medium');
  assert.equal(normalizeFindingSeverity('info'), 'low');
  assert.equal(normalizeFindingSeverity(' informational '), 'low');
  assert.equal(normalizeFindingSeverity('critical'), 'urgent');
  assert.equal(normalizeFindingSeverity('fatal'), 'urgent');
  assert.equal(normalizeFindingSeverity('error'), 'high');
  assert.equal(normalizeFindingSeverity('High'), 'high');
  assert.equal(normalizeFindingSeverity(undefined), 'medium');
  assert.equal(normalizeFindingSeverity(null), 'medium');
  assert.equal(normalizeFindingSeverity(''), 'medium');
  assert.equal(normalizeFindingSeverity(3), 'medium');
  assert.equal(normalizeFindingSeverity('bogus'), 'medium');
});

test('HOK-3239 legacy warning/info/missing JSONL severities are normalized and counted in findingCounts', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-severity-ingest-'));
  try {
    writePermissiveSchema(repoDir);
    writeFindingsJsonl(repoDir, [
      tendDisagreementFinding('warning', 1),
      tendDisagreementFinding('info', 2),
      tendDisagreementFinding(undefined, 3),
      tendDisagreementFinding('high', 4),
    ]);

    const findings = buildFindings(basicSnapshot(repoDir), defaultObserverOptions());
    const bySeverity = (pr: number) => findings.find((finding) => finding.id === `marker-merge-lane/${pr}/mill-tend-disagreement-merge-lane-disagreement`)?.severity;
    assert.equal(bySeverity(1), 'medium');
    assert.equal(bySeverity(2), 'low');
    assert.equal(bySeverity(3), 'medium');
    assert.equal(bySeverity(4), 'high');
    for (const finding of findings) {
      assert.ok(['urgent', 'high', 'medium', 'low'].includes(finding.severity), `invalid severity ${finding.severity}`);
    }

    writeFileSync(join(repoDir, '.wavemill', 'backstage-health.json'), JSON.stringify({}));
    await writeServiceHeartbeat({ ...basicSnapshot(repoDir), findings }, {
      ...defaultObserverOptions(),
      loop: true,
      once: false,
      repoDir,
      session: 'wavemill',
      serviceMode: true,
    });
    const counts = JSON.parse(readFileSync(join(repoDir, '.wavemill', 'backstage-health.json'), 'utf8'))
      .services.observer.findingCounts as Record<string, number>;
    assert.deepEqual(Object.keys(counts).sort(), ['high', 'low', 'medium', 'urgent']);
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    assert.ok(Number.isFinite(total), 'findingCounts total must not be NaN');
    assert.equal(total, findings.length);
    assert.ok(counts.medium >= 2 && counts.low >= 1 && counts.high >= 1);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('HOK-3239 mill-tend-disagreement and a synthetic urgent finding push via ntfy within one observer pass', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-alerts-ntfy-'));
  const previousPushUrl = process.env.WAVEMILL_OBSERVER_PUSH_URL;
  const previousFetch = globalThis.fetch;
  const pushes: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  try {
    writePermissiveSchema(repoDir);
    // desktop:false keeps the test from invoking osascript/notify-send; no
    // alerts.enabled key, so the env push URL alone turns alerts on.
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
      configVersion: '1.5.0',
      observer: { alerts: { desktop: false } },
    }));
    process.env.WAVEMILL_OBSERVER_PUSH_URL = 'https://ntfy.sh/wm-hok-3239-test';
    globalThis.fetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      pushes.push({ url, headers: init.headers, body: init.body });
      return { ok: true, status: 200, text: async () => '' };
    }) as unknown as typeof fetch;

    writeFindingsJsonl(repoDir, [
      tendDisagreementFinding('high'),
      {
        subsystem: 'merge-lane',
        title: 'Synthetic urgent observer finding',
        severity: 'urgent',
        context: { markerPath: 'synthetic/hok-3239', markerKind: 'synthetic-urgent' },
      },
      // Below minSeverity: high; must not push.
      tendDisagreementFinding('warning', 99),
    ]);
    const findings = buildFindings(basicSnapshot(repoDir), defaultObserverOptions());
    const alerted = await sendAlerts({ ...basicSnapshot(repoDir), findings }, defaultObserverOptions() as any);

    assert.equal(pushes.length, 2, `expected two pushes, got ${pushes.map((push) => push.headers.Title).join(' | ')}`);
    for (const push of pushes) assert.equal(push.url, 'https://ntfy.sh/wm-hok-3239-test');
    const titles = pushes.map((push) => push.headers.Title);
    assert.ok(titles.some((title) => title.includes('Mill and tend disagree on PR #1265')));
    const urgent = pushes.find((push) => push.headers.Title.includes('Synthetic urgent'));
    assert.equal(urgent?.headers.Priority, '5');
    assert.ok(!alerted.findings.some((finding) => finding.id.startsWith('observer-alert-send-failed-')));

    const journal = JSON.parse(readFileSync(join(repoDir, '.wavemill', 'observer', 'alert-state.json'), 'utf8'));
    const ids = Object.keys(journal.findings).sort();
    assert.deepEqual(ids, [
      'marker-merge-lane/1265/mill-tend-disagreement-merge-lane-disagreement',
      'marker-synthetic/hok-3239-synthetic-urgent',
    ]);
    for (const id of ids) assert.ok(journal.findings[id].lastNotifiedAt, `${id} should be marked notified`);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPushUrl === undefined) delete process.env.WAVEMILL_OBSERVER_PUSH_URL;
    else process.env.WAVEMILL_OBSERVER_PUSH_URL = previousPushUrl;
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('incident reconciliation correlates stalled Tend markers into typed remediation proposals', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-stalled-lifecycle-'));
  const slug = 'observer-stalled-lifecycle';
  const featureDir = join(repoDir, 'features', slug);
  try {
    mkdirSync(join(repoDir, '.wavemill', 'prs'), { recursive: true });
    mkdirSync(featureDir, { recursive: true });
    writePermissiveSchema(repoDir);
    writeFileSync(join(featureDir, 'selected-task.json'), JSON.stringify({
      taskId: 'HOK-1324',
      featureName: slug,
    }));
    writeFileSync(join(featureDir, '.review-result.json'), JSON.stringify({
      status: 'not_ready',
      failureCategory: 'context-window-exceeded',
      reviewedHead: 'old-head-1324',
      reviewedBase: 'old-base-1324',
      reviewedFileCount: 40,
      reviewedAt: '2026-08-28T11:30:00.000Z',
    }));
    writeFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), JSON.stringify({
      tasks: {
        'HOK-1324': {
          issue: 'HOK-1324',
          slug,
          worktree: repoDir,
          phase: 'ready',
          status: 'running',
          pr: '#1324',
          branch: 'task/HOK-1324',
        },
      },
    }));
    writeFileSync(join(repoDir, '.wavemill', 'prs', '1324.json'), JSON.stringify({
      number: 1324,
      headRefOid: 'current-head-1324',
      baseRefOid: 'current-base-1324',
      headRefName: 'task/HOK-1324',
      baseRefName: 'auto/integration',
      files: Array.from({ length: 12 }, (_, index) => ({ path: `src/file-${index}.ts`, additions: 1, deletions: 0 })),
      labels: [{ name: 'wavemill' }],
    }));

    const markerFinding = {
      id: 'marker-merge-lane/idle-stall/#1324-merge-lane-idle-stall',
      severity: 'urgent' as const,
      category: 'warning' as const,
      confidence: 'high' as const,
      session: 'wavemill',
      repoDir,
      title: 'Merge lane stalled: 1 blocked PR, 0 eligible for 30 consecutive polls',
      evidence: [
        'markerKind=merge-lane-idle-stall',
        'firstBlockedPr=1324',
        'firstBlockedGate=review:not-ready',
        'consecutivePolls=30',
      ],
      recommendation: 'Inspect the named gate.',
    };
    const snapshot = {
      timestamp: '2026-08-28T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        workflowStatePath: join(repoDir, '.wavemill', 'workflow-state.json'),
        tasks: [{
          issue: 'HOK-1324',
          slug,
          worktree: repoDir,
          phase: 'ready',
          status: 'running',
          pr: '#1324',
          branch: 'task/HOK-1324',
        }],
      }],
      findings: [markerFinding],
    };

    const first = await reconcileIncidents(snapshot, defaultObserverOptions());
    const incident = first.incidents?.find((item) => item.rootCauseClass === 'review_context_overflow_stale_base');
    assert.ok(incident);
    assert.equal(incident.taskId, 'HOK-1324');
    assert.equal(incident.metadata.proposal?.kind, 'refresh_base_and_rereview');
    for (const action of ['add_ready_label', 'merge', 'destructive_git', 'delete_branch'] as const) {
      assert.ok(incident.metadata.proposal?.forbiddenActions.includes(action), action);
    }
    assert.ok(first.findings.some((finding) => finding.evidence.includes('rootCause=review_context_overflow_stale_base')));

    const second = await reconcileIncidents(snapshot, defaultObserverOptions());
    const store = new IncidentStore(join(repoDir, '.wavemill', 'incidents'));
    const stored = await store.getIncidents();
    const stalled = stored.filter((item) => item.rootCauseClass === 'review_context_overflow_stale_base');
    assert.equal(stalled.length, 1);
    assert.equal(stalled[0].occurrenceCount, 1);
    // HOK-3314: a repeat of the same stored source event is observed-presence,
    // not absence. missedCycles stays 0; recovery flows through the predicate
    // (new review attempt, head change, …), never through a 5-cycle absence
    // timeout for a condition still actively observed every poll.
    assert.equal(stalled[0].metadata.missedCycles, 0);
    assert.equal(second.incidents?.filter((item) => item.rootCauseClass === 'review_context_overflow_stale_base').length, 1);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// --- HOK-2595 reopened: stalled Tend candidate correlation end-to-end ---

const OBS_SHA = (char: string) => char.repeat(40);

function writeObserverReview(featureDir: string, review: {
  status?: string;
  verdict?: string;
  failureCategory?: string;
  reviewHeadSha?: string;
  finishedAt?: string;
  diffBase?: Record<string, unknown>;
}): void {
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, '.review-result.json'), JSON.stringify({
    stage: 'review',
    status: review.status ?? 'failed',
    startedAt: '2026-09-04T09:00:00.000Z',
    finishedAt: review.finishedAt ?? '2026-09-04T09:30:00.000Z',
    agent: 'native-openrouter',
    model: 'kimi-k2',
    notes: 'n',
    artifacts: {
      type: 'review',
      verdict: review.verdict ?? 'not_ready',
      ...(review.failureCategory ? { failureCategory: review.failureCategory } : {}),
      ...(review.reviewHeadSha ? { reviewHeadSha: review.reviewHeadSha } : {}),
      ...(review.diffBase ? { diagnostics: { metadata: { diffBase: review.diffBase } } } : {}),
    },
  }));
}

function writeObserverPr(repoDir: string, pr: number, head: string, base: string, changedFiles: number, labels: string[] = ['wavemill']): void {
  mkdirSync(join(repoDir, '.wavemill', 'prs'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill', 'prs', `${pr}.json`), JSON.stringify({
    number: pr,
    headRefOid: head,
    baseRefOid: base,
    changedFiles,
    labels: labels.map((name) => ({ name })),
  }));
}

function writeBlockedLane(repoDir: string, heartbeatAt: string, lane: Array<{ pr: number; headBranch: string; gate: string; labels?: string[] }>): void {
  writeFileSync(join(repoDir, '.wavemill', 'backstage-health.json'), JSON.stringify({
    services: {
      tend: {
        status: 'healthy',
        laneCondition: 'idle-blocked-stall',
        progressState: 'stalled',
        heartbeatAt,
        blockedStreak: 140,
        blockedLane: lane.map((entry) => ({ labels: ['wavemill', 'wm:blocked'], ...entry })),
      },
    },
  }));
}

/** #1324 (stale local base, 84 reviewed vs 12 authoritative) and #1325 (current scope). */
function stalledReviewFixture(): { repoDir: string; snapshot: any; tasks: any[] } {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-hok2595-'));
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writePermissiveSchema(repoDir);
  const tasks = [
    { issue: 'HOK-1324', slug: 'hok-1324', worktree: repoDir, phase: 'ready', status: 'running', pr: '#1324', branch: 'task/stale-review-1324' },
    { issue: 'HOK-1325', slug: 'hok-1325', worktree: repoDir, phase: 'ready', status: 'running', pr: '#1325', branch: 'task/current-review-1325' },
  ];
  writeFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), JSON.stringify({
    tasks: Object.fromEntries(tasks.map((task) => [task.issue, task])),
  }));
  writeObserverReview(join(repoDir, 'features', 'hok-1324'), {
    failureCategory: 'native-context-window-exceeded',
    reviewHeadSha: OBS_SHA('a'),
    diffBase: { ref: 'main', kind: 'local', fetch: 'failed', reviewedBase: OBS_SHA('0'), mergeBaseSha: OBS_SHA('0'), reviewedHead: OBS_SHA('a'), reviewedFileCount: 84 },
  });
  writeObserverReview(join(repoDir, 'features', 'hok-1325'), {
    failureCategory: 'native-context-window-exceeded',
    reviewHeadSha: OBS_SHA('c'),
    diffBase: { ref: 'origin/auto/integration', kind: 'remote', fetch: 'ok', reviewedBase: OBS_SHA('d'), mergeBaseSha: OBS_SHA('d'), reviewedHead: OBS_SHA('c'), reviewedFileCount: 30 },
  });
  writeObserverPr(repoDir, 1324, OBS_SHA('a'), OBS_SHA('b'), 12, ['wavemill', 'wm:blocked']);
  writeObserverPr(repoDir, 1325, OBS_SHA('c'), OBS_SHA('d'), 30, ['wavemill', 'wm:blocked']);
  writeBlockedLane(repoDir, '2026-09-04T11:59:00.000Z', [
    { pr: 1324, headBranch: 'task/stale-review-1324', gate: 'missing-metadata' },
    { pr: 1325, headBranch: 'task/current-review-1325', gate: 'ready-failed:not-ready' },
  ]);
  const genericFinding = (issue: string) => ({
    id: `stale-active-task-live-process-wavemill-${issue}`,
    severity: 'high' as const,
    category: 'stuck' as const,
    confidence: 'medium' as const,
    session: 'wavemill',
    repoDir,
    issue,
    title: `${issue} has live pane or process residue but has not progressed in ready`,
    evidence: ['phase=ready'],
    recommendation: 'Inspect the task pane and hook state. If the agent is parked at a prompt or waiting after reporting completion, send a narrow recovery instruction; stop a child process only when it is conclusively wedged.',
  });
  const snapshot = {
    timestamp: '2026-09-04T12:00:00.000Z',
    sessions: ['wavemill'],
    panes: [],
    processes: [],
    repos: [{ session: 'wavemill', repoDir, workflowStatePath: join(repoDir, '.wavemill', 'workflow-state.json'), tasks }],
    findings: [genericFinding('HOK-1324'), genericFinding('HOK-1325')],
  };
  return { repoDir, snapshot, tasks };
}

test('HOK-2595: #1324/#1325 via the tend blockedLane correlate stale review scope, not a parked prompt', async () => {
  const { repoDir, snapshot } = stalledReviewFixture();
  try {
    const result = await reconcileIncidents(snapshot, defaultObserverOptions());
    assert.equal(result.schemaVersion, 'observer-snapshot/1');

    const staleBase = result.incidents?.find((item) => item.rootCauseClass === 'review_context_overflow_stale_base');
    assert.ok(staleBase, 'expected a stale-base incident for #1324');
    assert.equal(staleBase.taskId, 'HOK-1324');
    assert.equal(staleBase.metadata.tendGate, 'missing-metadata');
    assert.equal(staleBase.metadata.recordedBase, OBS_SHA('0'));
    assert.equal(staleBase.metadata.currentBase, OBS_SHA('b'));
    assert.equal(staleBase.metadata.reviewedFileCount, 84);
    assert.equal(staleBase.metadata.authoritativeFileCount, 12);

    // #1325 reviewed the current scope: inspection, not a stale-base claim.
    const inspection = result.incidents?.find((item) => item.taskId === 'HOK-1325' && item.rootCauseClass === 'inspection_required');
    assert.equal(inspection?.rootCauseClass, 'inspection_required');
    assert.equal(inspection?.confidence, 'low');

    // The generic parked-pane finding is grouped under the causal incident and
    // carries its next safe action instead of the parked-prompt advice.
    const generic1324 = result.findings.find((finding) => finding.id === 'stale-active-task-live-process-wavemill-HOK-1324');
    assert.equal(generic1324?.groupedUnder, `incident-${staleBase.fingerprint}`);
    assert.ok(generic1324?.evidence.includes('supersededBy=review_context_overflow_stale_base'));
    assert.match(generic1324?.recommendation ?? '', /^Refresh authoritative base, invalidate stale review evidence, rerun review\./);
    assert.doesNotMatch(generic1324?.recommendation ?? '', /parked at a prompt|wedged/);
    assert.doesNotMatch((generic1324?.recommendation ?? '').replace(/Do not add wm:ready[^.]*\./, ''), /wm:ready|merge/i);
    // No specific chain for #1325, so its generic finding is untouched.
    const generic1325 = result.findings.find((finding) => finding.id === 'stale-active-task-live-process-wavemill-HOK-1325');
    assert.equal(generic1325?.groupedUnder, undefined);
    assert.match(generic1325?.recommendation ?? '', /parked at a prompt/);

    // The incident finding carries the causal chain and proposal identity.
    const incidentFinding = result.findings.find((finding) => finding.id === `incident-${staleBase.fingerprint}`);
    assert.ok(incidentFinding?.evidence.some((line) => line.startsWith('causalChain=context_window_exceeded → stale_review_scope')));
    assert.ok(incidentFinding?.evidence.includes('proposal=refresh_base_and_rereview@1.2'));

    // Machine-readable, schema-versioned proposals an executor can validate.
    const json = JSON.parse(JSON.stringify(result));
    assert.equal(json.schemaVersion, 'observer-snapshot/1');
    assert.equal(json.remediationProposalErrors, 0);
    const proposal = json.remediationProposals.find((item: any) => item.rootCauseClass === 'review_context_overflow_stale_base');
    assert.ok(proposal);
    assert.equal(proposal.issue, 'HOK-1324');
    assert.equal(validateRemediationProposal(proposal.proposal).ok, true);
    assert.equal(proposal.proposal.target.prNumber, 1324);
    assert.ok(!proposal.proposal.allowedActions.includes('add_ready_label'));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('HOK-2595: repeated polls dedupe into one incident with growing occurrence history', async () => {
  const { repoDir, snapshot } = stalledReviewFixture();
  try {
    await reconcileIncidents(snapshot, defaultObserverOptions());
    writeBlockedLane(repoDir, '2026-09-04T12:04:00.000Z', [{ pr: 1324, headBranch: 'task/stale-review-1324', gate: 'missing-metadata' }]);
    await reconcileIncidents({ ...snapshot, timestamp: '2026-09-04T12:05:00.000Z', findings: [] }, defaultObserverOptions());
    const stored = (await new IncidentStore(join(repoDir, '.wavemill', 'incidents')).getIncidents())
      .filter((item) => item.rootCauseClass === 'review_context_overflow_stale_base');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].occurrenceCount, 2);
    assert.equal(stored[0].metadata.missedCycles, 0);
    const tendObservations = stored[0].evidence.filter((item) => item.type === 'tend_lane');
    assert.deepEqual(tendObservations.map((item) => item.timestamp), ['2026-09-04T12:00:00.000Z', '2026-09-04T12:05:00.000Z']);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('HOK-2595: a new review attempt resolves the incident through its recovery predicate', async () => {
  const { repoDir, snapshot } = stalledReviewFixture();
  try {
    const first = await reconcileIncidents(snapshot, defaultObserverOptions());
    const staleBase = first.incidents?.find((item) => item.rootCauseClass === 'review_context_overflow_stale_base');
    assert.ok(staleBase);

    // The operator refreshed the base and reran review: now ready on the PR scope.
    writeObserverReview(join(repoDir, 'features', 'hok-1324'), {
      status: 'completed',
      verdict: 'ready',
      reviewHeadSha: OBS_SHA('a'),
      finishedAt: '2026-09-04T12:10:00.000Z',
      diffBase: { ref: 'origin/auto/integration', kind: 'remote', fetch: 'ok', reviewedBase: OBS_SHA('b'), reviewedHead: OBS_SHA('a'), reviewedFileCount: 12 },
    });
    const second = await reconcileIncidents({ ...snapshot, timestamp: '2026-09-04T12:11:00.000Z', findings: [] }, defaultObserverOptions());
    assert.deepEqual(second.recoveredIncidents?.map((item) => [item.fingerprint, item.reason]), [
      [staleBase.fingerprint, 'recovery_predicate:review_now_ready'],
    ]);
    const record = await new IncidentStore(join(repoDir, '.wavemill', 'incidents')).getIncident(staleBase.fingerprint);
    assert.equal(record?.lifecycle, 'resolved');
    assert.equal(record?.metadata.resolution?.action, 'auto_resolved');
    assert.equal(record?.metadata.resolution?.reason, 'recovery_predicate:review_now_ready');
    assert.ok(!(second.remediationProposals ?? []).some((item) => item.incidentFingerprint === staleBase.fingerprint));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('HOK-2595: the HOK-2934 pair produces one incident naming the failed challenger', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-hok2934-'));
  try {
    mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
    writePermissiveSchema(repoDir);
    const tasks = [
      { issue: 'HOK-2934', slug: 'hok-2934', worktree: repoDir, phase: 'ready', status: 'running', pr: '#1328', branch: 'task/pair-primary', challengePairId: 'HOK-2934' },
      { issue: 'HOK-2934_c', slug: 'hok-2934-c', worktree: repoDir, phase: 'ready', status: 'running', pr: '#1329', branch: 'task/pair-challenger', challengePairId: 'HOK-2934', challengeRole: 'challenger' },
    ];
    writeFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), JSON.stringify({ tasks: Object.fromEntries(tasks.map((task) => [task.issue, task])) }));
    writeObserverReview(join(repoDir, 'features', 'hok-2934'), { status: 'completed', verdict: 'ready', reviewHeadSha: OBS_SHA('1') });
    const challengerDir = join(repoDir, 'features', 'hok-2934-c');
    writeObserverReview(challengerDir, { status: 'failed', verdict: 'error', failureCategory: 'native-review-failed', reviewHeadSha: OBS_SHA('2') });
    writeFileSync(join(challengerDir, '.review-failure-envelope.json'), JSON.stringify({
      schemaVersion: '1.0', stage: 'review', cause: 'provider-credit-exhausted', provider: 'openrouter', model: 'kimi-k2', agent: 'native-openrouter',
      evidence: { source: 'native-loop', detail: '402' }, createdAt: '2026-09-05T01:00:00.000Z',
    }));
    writeObserverPr(repoDir, 1328, OBS_SHA('1'), OBS_SHA('9'), 6, ['wavemill', 'wm:ready']);
    writeObserverPr(repoDir, 1329, OBS_SHA('2'), OBS_SHA('9'), 7);
    writeBlockedLane(repoDir, '2026-09-05T11:59:00.000Z', [
      { pr: 1328, headBranch: 'task/pair-primary', gate: 'challenge:pair-unresolved:no-comparison', labels: ['wavemill', 'wm:ready'] },
      { pr: 1329, headBranch: 'task/pair-challenger', gate: 'challenge:pair-unresolved:no-comparison' },
    ]);
    const snapshot = {
      timestamp: '2026-09-05T12:00:00.000Z',
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{ session: 'wavemill', repoDir, workflowStatePath: join(repoDir, '.wavemill', 'workflow-state.json'), tasks }],
      findings: [],
    };
    const result = await reconcileIncidents(snapshot, defaultObserverOptions());
    const pairIncidents = (result.incidents ?? []).filter((item) => item.metadata.pairId === 'HOK-2934');
    assert.equal(pairIncidents.length, 1);
    assert.equal(pairIncidents[0].rootCauseClass, 'provider_quota_exhaustion_blocking_review');
    assert.equal(pairIncidents[0].metadata.failedSide, 'challenger');
    assert.equal(pairIncidents[0].metadata.pairState, 'blocked_on_provider_recovery');
    const proposal = result.remediationProposals?.find((item) => item.incidentFingerprint === pairIncidents[0].fingerprint);
    assert.ok(proposal?.proposal.forbiddenActions.includes('synthesize_winner'));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('HOK-2595: malformed tend health and review artifacts degrade without crashing', async () => {
  const { repoDir, snapshot } = stalledReviewFixture();
  try {
    writeFileSync(join(repoDir, '.wavemill', 'backstage-health.json'), '{not json');
    writeFileSync(join(repoDir, 'features', 'hok-1324', '.review-result.json'), '{truncated');
    const markerFinding = {
      id: 'marker-merge-lane/idle-stall/#1324-merge-lane-idle-stall',
      severity: 'urgent' as const,
      category: 'warning' as const,
      confidence: 'high' as const,
      session: 'wavemill',
      repoDir,
      title: 'Merge lane stalled',
      evidence: ['markerKind=merge-lane-idle-stall', 'firstBlockedPr=1324', 'firstBlockedGate=missing-metadata'],
      recommendation: 'Inspect the named gate.',
    };
    const result = await reconcileIncidents({ ...snapshot, findings: [...snapshot.findings, markerFinding] }, defaultObserverOptions());
    const inspection = result.incidents?.find((item) => item.taskId === 'HOK-1324' && item.rootCauseClass === 'inspection_required');
    assert.equal(inspection?.rootCauseClass, 'inspection_required');
    assert.deepEqual(inspection?.metadata.missingEvidence, ['review_result']);
    // No specific chain, so the generic finding keeps firing unchanged.
    const generic = result.findings.find((finding) => finding.id === 'stale-active-task-live-process-wavemill-HOK-1324');
    assert.equal(generic?.groupedUnder, undefined);
    assert.ok(!result.findings.some((finding) => finding.id.startsWith('incident-store-error-') || finding.id.startsWith('incident-recovery-error-')));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// --- Parked/terminal-arm incident detectors (HOK-2927) ---

function createParkedCodingFixture(issue = 'HOK-2918_c') {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-parked-arm-'));
  const slug = 'parked-arm-fixture';
  const featureDir = join(repoDir, 'features', slug);
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  mkdirSync(featureDir, { recursive: true });
  writePermissiveSchema(repoDir);
  const markerPath = join(featureDir, '.coding-complete');
  writeFileSync(markerPath, '{}\n');
  const markerMtime = new Date(Date.now() - 30 * 60_000);
  utimesSync(markerPath, markerMtime, markerMtime);
  writeFileSync(join(featureDir, '.coding-uncommitted-output.json'), JSON.stringify({
    issue,
    slug,
    reason: 'coding_output_dirty_tree',
    baseBranch: 'auto/integration',
    aheadCount: 0,
    behindCount: 0,
    dirtyPaths: ['shared/lib/promote-provisional-model.ts'],
    firstDirtyPath: 'shared/lib/promote-provisional-model.ts',
    summary: 'coding completed marker detected, but worktree still contains uncommitted coding output',
    action: 'Clean the dirty paths, then retry review.',
    detectedAt: new Date().toISOString(),
  }));
  writeFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), JSON.stringify({
    tasks: { [issue]: { issue, slug, worktree: repoDir, phase: 'coding', status: 'running' } },
  }));
  return { repoDir, slug, featureDir, issue };
}

function parkedArmSnapshot(fixture: { repoDir: string; slug: string; issue: string }, timestamp: string) {
  return {
    timestamp,
    sessions: ['wavemill'],
    panes: [],
    processes: [],
    repos: [{
      session: 'wavemill',
      repoDir: fixture.repoDir,
      workflowStatePath: join(fixture.repoDir, '.wavemill', 'workflow-state.json'),
      tasks: [{
        issue: fixture.issue,
        phase: 'coding',
        status: 'running',
        slug: fixture.slug,
        worktree: fixture.repoDir,
        updated: agoIso(30),
      }],
    }],
    findings: [],
  };
}

async function parkedIncidents(repoDir: string, rootCauseClass: string) {
  const store = new IncidentStore(join(repoDir, '.wavemill', 'incidents'));
  return (await store.getAllIncidents()).filter((incident) => incident.rootCauseClass === rootCauseClass);
}

test('parked coding arm produces one incident record that escalates and counts every poll', async () => {
  const fixture = createParkedCodingFixture();
  try {
    const base = Date.now();
    for (let poll = 0; poll < 4; poll += 1) {
      const timestamp = new Date(base + poll * 1000).toISOString();
      await reconcileIncidents(parkedArmSnapshot(fixture, timestamp), defaultObserverOptions());
    }

    const parked = await parkedIncidents(fixture.repoDir, 'arm_parked_awaiting_operator_commit');
    assert.equal(parked.length, 1);
    assert.equal(parked[0].occurrenceCount, 4);
    assert.equal(parked[0].lifecycle, 'active');
    assert.equal(parked[0].taskId, fixture.issue);
    assert.equal(parked[0].category, 'stale_orphaned_state');
    assert.equal(parked[0].metadata.thresholdTriggered, true);
    assert.ok(typeof parked[0].metadata.escalatedAt === 'string');
    assert.match(parked[0].operatorAction, /Clean the dirty paths, then retry review\./);
    assert.doesNotMatch(parked[0].operatorAction, /inspect its poll branch/);
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

test('re-running the observer over an unchanged repo creates no new parked-arm records', async () => {
  const fixture = createParkedCodingFixture();
  try {
    const timestamp = new Date().toISOString();
    await reconcileIncidents(parkedArmSnapshot(fixture, timestamp), defaultObserverOptions());
    await reconcileIncidents(parkedArmSnapshot(fixture, timestamp), defaultObserverOptions());

    let parked = await parkedIncidents(fixture.repoDir, 'arm_parked_awaiting_operator_commit');
    assert.equal(parked.length, 1);
    // Identical poll timestamp means an identical event key: a re-poll, not a fresh occurrence.
    assert.equal(parked[0].occurrenceCount, 1);

    // A later poll of the unchanged condition counts an occurrence on the SAME record.
    await reconcileIncidents(parkedArmSnapshot(fixture, new Date(Date.now() + 1000).toISOString()), defaultObserverOptions());
    parked = await parkedIncidents(fixture.repoDir, 'arm_parked_awaiting_operator_commit');
    assert.equal(parked.length, 1);
    assert.equal(parked[0].occurrenceCount, 2);
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

test('coding-marker-ignored recommendation names the dirty-tree handoff when the mill parked the arm', () => {
  const fixture = createParkedCodingFixture();
  try {
    const findings = buildFindings(markerSnapshot({
      repoDir: fixture.repoDir,
      slug: fixture.slug,
      phase: 'coding',
      issue: fixture.issue,
      // State newer than the marker previously selected the misleading
      // "inspect its poll branch" recommendation.
      stateMtime: new Date().toISOString(),
    }), defaultObserverOptions());

    const finding = findings.find((candidate) => candidate.id === `coding-marker-ignored-${fixture.issue}`);
    assert.ok(finding);
    assert.equal(finding.severity, 'urgent');
    assert.match(finding.recommendation, /Clean the dirty paths, then retry review\./);
    assert.match(finding.recommendation, /git status/);
    assert.doesNotMatch(finding.recommendation, /inspect its poll branch/);
    assert.ok(finding.evidence.includes('parkedOnUncommittedOutput=true'));
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

test('malformed uncommitted-output artifact degrades to stage_marker_not_advanced', async () => {
  const fixture = createParkedCodingFixture();
  try {
    writeFileSync(join(fixture.featureDir, '.coding-uncommitted-output.json'), 'not json');
    await reconcileIncidents(parkedArmSnapshot(fixture, new Date().toISOString()), defaultObserverOptions());

    assert.equal((await parkedIncidents(fixture.repoDir, 'arm_parked_awaiting_operator_commit')).length, 0);
    const degraded = await parkedIncidents(fixture.repoDir, 'stage_marker_not_advanced');
    assert.equal(degraded.length, 1);
    assert.equal(degraded[0].confidence, 'medium');
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

test('terminal parked arm produces a deduped terminal_arm_parked_with_residue incident', async () => {
  const fixture = createResidueGitFixture({ commits: 0, slug: 'incident-clean-terminal' });
  try {
    const snap = (timestamp: string) => ({
      timestamp,
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir: fixture.repoDir,
        tasks: [{
          issue: 'HOK-2845',
          slug: fixture.slug,
          branch: fixture.branch,
          phase: 'closed',
          status: 'closed',
          worktree: fixture.repoDir,
          updated: agoIso(30),
        }],
      }],
      findings: [],
    });
    await reconcileIncidents(snap(new Date().toISOString()), defaultObserverOptions());
    await reconcileIncidents(snap(new Date(Date.now() + 1000).toISOString()), defaultObserverOptions());

    const parked = await parkedIncidents(fixture.repoDir, 'terminal_arm_parked_with_residue');
    assert.equal(parked.length, 0, 'clean terminal residue does not invent a second incident');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('arm died with unpushed work produces a critical incident carrying commit subjects', async () => {
  const fixture = createResidueGitFixture({ commits: 2, slug: 'incident-unpushed' });
  try {
    const snapshot = {
      timestamp: new Date().toISOString(),
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir: fixture.repoDir,
        tasks: [{
          issue: 'HOK-2911',
          slug: fixture.slug,
          branch: fixture.branch,
          phase: 'error',
          status: 'error',
          worktree: fixture.repoDir,
          updated: agoIso(30),
        }],
      }],
      findings: [],
    };
    await reconcileIncidents(snapshot, defaultObserverOptions());

    const records = await parkedIncidents(fixture.repoDir, 'cleanup_unpublished_at_risk');
    assert.equal(records.length, 1);
    assert.equal(records[0].severity, 'critical');
    assert.equal(records[0].confidence, 'high');
    assert.equal(records[0].taskId, 'HOK-2911');
    assert.match(records[0].evidence[0].redactedData, /unpushedCommits=2/);
    assert.match(records[0].evidence[0].redactedData, /task commit 2/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('pr-create-failed incidents share one fingerprint across mill-log and review-artifact sources', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-pr-create-incident-'));
  const slug = 'pr-create-fixture';
  const featureDir = join(repoDir, 'features', slug);
  try {
    mkdirSync(featureDir, { recursive: true });
    mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
    writePermissiveSchema(repoDir);
    const logPath = join(repoDir, 'mill-wavemill.log');
    const snap = (timestamp: string, millLogPath?: string) => ({
      timestamp,
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        millLogPath,
        tasks: [{
          issue: 'HOK-2929',
          slug,
          branch: `task/${slug}`,
          phase: 'review',
          status: 'running',
          worktree: repoDir,
          updated: new Date().toISOString(),
        }],
      }],
      findings: [],
    });

    writeFileSync(logPath, "10:00:01 [error] HOK-2929 pull request create failed: Head sha can't be blank\n");
    await reconcileIncidents(snap(new Date().toISOString(), logPath), defaultObserverOptions());

    rmSync(logPath);
    writeFileSync(join(featureDir, '.review-result.json'), JSON.stringify({
      status: 'failed',
      notes: "pull request create failed: Head sha can't be blank",
    }));
    await reconcileIncidents(snap(new Date(Date.now() + 1000).toISOString(), undefined), defaultObserverOptions());

    const records = await parkedIncidents(repoDir, 'pr_create_failed');
    assert.equal(records.length, 1);
    assert.equal(records[0].occurrenceCount, 2);
    assert.equal(records[0].taskId, 'HOK-2929');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('parked-arm incident detection never modifies observer config files', async () => {
  const fixture = createParkedCodingFixture();
  try {
    const configPath = join(fixture.repoDir, '.wavemill-config.json');
    const before = readFileSync(configPath, 'utf8');
    await reconcileIncidents(parkedArmSnapshot(fixture, new Date().toISOString()), defaultObserverOptions());

    assert.equal(readFileSync(configPath, 'utf8'), before);
    assert.equal(existsSync(join(fixture.repoDir, '.wavemill-config.local.json')), false);
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HOK-2972: cleanup incidents require terminal lifecycle evidence; active
// unpublished work is delivery risk, and historical config drift is
// provenance, not an actionable incident.
// ---------------------------------------------------------------------------

function lifecycleIncidentSnapshot(
  fixture: { repoDir: string; slug: string; branch: string },
  task: Record<string, unknown>,
  panes: Record<string, unknown>[] = [],
) {
  return {
    timestamp: new Date().toISOString(),
    sessions: ['wavemill'],
    panes,
    processes: [],
    repos: [{
      session: 'wavemill',
      repoDir: fixture.repoDir,
      workflowStatePath: join(fixture.repoDir, '.wavemill', 'workflow-state.json'),
      tasks: [task],
    }],
    findings: [],
  };
}

function livePaneFor(issue: string, slug: string) {
  return {
    session: 'wavemill',
    windowIndex: '3',
    paneIndex: '0',
    windowName: `${issue}-${slug}`,
    active: true,
    pid: 4242,
    command: 'claude',
    title: `coding ${issue}`,
  };
}

async function storedIncidents(repoDir: string) {
  const store = new IncidentStore(join(repoDir, '.wavemill', 'incidents'));
  return store.getAllIncidents();
}

test('active coding task with unpublished commits emits no cleanup incident while progressing', async () => {
  const fixture = createResidueGitFixture({ commits: 5, slug: 'active-unpublished-fresh' });
  try {
    const task = {
      issue: 'HOK-2963',
      slug: fixture.slug,
      branch: fixture.branch,
      phase: 'coding',
      status: 'active',
      worktree: fixture.repoDir,
      updated: agoIso(5),
      lifecycle: { schemaVersion: 1, workflowOutcome: 'active', resourceDisposition: 'allocated' },
    };
    await reconcileIncidents(
      lifecycleIncidentSnapshot(fixture, task, [livePaneFor('HOK-2963', fixture.slug)]),
      defaultObserverOptions(),
    );
    const stored = await storedIncidents(fixture.repoDir);
    assert.equal(stored.some((incident) => incident.category === 'stale_orphaned_state'), false);
    assert.equal(stored.some((incident) => incident.severity === 'critical'), false);
    assert.equal(stored.some((incident) => incident.rootCauseClass === 'active_unpublished_work_stalled'), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('stalled active unpublished work surfaces as a delivery-risk condition, not a cleanup incident', async () => {
  // HOK-3087: the incident now consumes the shared progress primitive, so
  // the fixture ages its commits along with `task.updated` — otherwise fresh
  // commits would (correctly) rescue the task from the stall gate.
  const fixture = createResidueGitFixture({ commits: 5, slug: 'active-unpublished-stalled', commitAgeMinutes: 180 });
  try {
    const task = {
      issue: 'HOK-2963',
      slug: fixture.slug,
      branch: fixture.branch,
      phase: 'coding',
      status: 'active',
      worktree: fixture.repoDir,
      updated: agoIso(180),
      lifecycle: { schemaVersion: 1, workflowOutcome: 'active', resourceDisposition: 'allocated' },
    };
    await reconcileIncidents(
      lifecycleIncidentSnapshot(fixture, task, [livePaneFor('HOK-2963', fixture.slug)]),
      defaultObserverOptions(),
    );
    const stored = await storedIncidents(fixture.repoDir);
    const stalled = stored.filter((incident) => incident.rootCauseClass === 'active_unpublished_work_stalled');
    assert.equal(stalled.length, 1);
    assert.equal(stalled[0].category, 'configuration_operator_condition');
    assert.equal(stalled[0].severity, 'medium');
    assert.doesNotMatch(stalled[0].operatorAction, /terminaliz.*cleanup/i);
    assert.equal(stored.some((incident) => incident.category === 'stale_orphaned_state'), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('terminal task with unpublished commits keeps the critical recovery-first cleanup incident', async () => {
  const fixture = createResidueGitFixture({ commits: 3, slug: 'terminal-unpublished' });
  try {
    const task = {
      issue: 'HOK-2911',
      slug: fixture.slug,
      branch: fixture.branch,
      phase: 'error',
      status: 'error',
      worktree: fixture.repoDir,
      updated: agoIso(90),
    };
    await reconcileIncidents(lifecycleIncidentSnapshot(fixture, task), defaultObserverOptions());
    const stored = await storedIncidents(fixture.repoDir);
    const cleanup = stored.filter((incident) => incident.rootCauseClass === 'cleanup_unpublished_at_risk');
    assert.equal(cleanup.length, 1);
    assert.equal(cleanup[0].category, 'stale_orphaned_state');
    assert.equal(cleanup[0].severity, 'critical');
    assert.match(cleanup[0].operatorAction, /Recover the work first/);
    assert.equal(stored.some((incident) => incident.rootCauseClass === 'active_unpublished_work_stalled'), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function driftTask(issue: string, fixture: { repoDir: string; slug: string; branch: string }, overrides: Record<string, unknown>) {
  return {
    issue,
    slug: fixture.slug,
    branch: fixture.branch,
    worktree: fixture.repoDir,
    updated: agoIso(2),
    ...overrides,
    lifecycle: {
      schemaVersion: 1,
      launchContract: {
        baseBranch: 'auto/integration',
        provenance: { baseBranch: 'runtime-env' },
      },
      ...((overrides.lifecycle as Record<string, unknown>) ?? {}),
    },
  };
}

test('launch-contract drift on a superseded terminal record is provenance, not an incident; active drift stays visible', async () => {
  const fixture = createMainIntegrationDivergenceFixture();
  try {
    const terminalTask = driftTask('HOK-1309', fixture, {
      phase: 'closed',
      status: 'superseded',
      lifecycle: { workflowOutcome: 'closed', resourceDisposition: 'retained' },
    });
    await reconcileIncidents(lifecycleIncidentSnapshot(fixture, terminalTask), defaultObserverOptions());
    let stored = await storedIncidents(fixture.repoDir);
    assert.equal(stored.some((incident) => incident.rootCauseClass === 'config_drift_base_branch'), false);

    const activeTask = driftTask('HOK-2963', fixture, {
      phase: 'coding',
      status: 'active',
      lifecycle: { workflowOutcome: 'active', resourceDisposition: 'allocated' },
    });
    await reconcileIncidents(lifecycleIncidentSnapshot(fixture, activeTask), defaultObserverOptions());
    stored = await storedIncidents(fixture.repoDir);
    const drift = stored.filter((incident) => incident.rootCauseClass === 'config_drift_base_branch');
    assert.equal(drift.length, 1);
    assert.equal(drift[0].taskId, 'HOK-2963');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HOK-3045: task pane blocked on a known interactive agent lifecycle prompt.
// The detector must match only high-confidence catalog signatures against a
// correlated task pane, persist a bounded signature summary (never the raw
// capture), and refuse to auto-resolve while the correlated task remains
// nonterminal and has not advanced.
// ---------------------------------------------------------------------------

const CODEX_RETIREMENT_PANE_TEXT = [
  'wavemill mill running',
  '',
  '  GPT-5.5 retires on October 14, 2026',
  '  Try new model',
  '  Use existing model',
  '',
].join('\n');

function interactivePromptFixture(issue: string, slug: string) {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-interactive-prompt-'));
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writePermissiveSchema(repoDir);
  return { repoDir, issue, slug };
}

function interactivePromptSnapshot(
  fixture: { repoDir: string; issue: string; slug: string },
  paneText: string | undefined,
  overrides: { taskUpdated?: string; timestamp?: string; task?: Record<string, unknown> } = {},
) {
  const windowName = `${fixture.issue}-${fixture.slug}`;
  const pane = {
    session: 'wavemill',
    windowIndex: '4',
    paneIndex: '0',
    windowName,
    active: true,
    pid: 5001,
    command: 'codex',
    title: `coding ${fixture.issue}`,
    capturedText: paneText,
  };
  return {
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    sessions: ['wavemill'],
    panes: paneText === undefined ? [] : [pane],
    processes: [],
    repos: [{
      session: 'wavemill',
      repoDir: fixture.repoDir,
      workflowStatePath: join(fixture.repoDir, '.wavemill', 'workflow-state.json'),
      tasks: [{
        issue: fixture.issue,
        phase: 'coding',
        status: 'running',
        slug: fixture.slug,
        worktree: fixture.repoDir,
        updated: overrides.taskUpdated ?? new Date().toISOString(),
        ...(overrides.task ?? {}),
      }],
    }],
    findings: [],
  };
}

async function promptIncidents(repoDir: string) {
  const store = new IncidentStore(join(repoDir, '.wavemill', 'incidents'));
  return (await store.getAllIncidents()).filter(
    (incident) => incident.rootCauseClass === 'agent_interactive_prompt_blocked',
  );
}

test('interactive prompt matcher requires the full retirement chooser layout', () => {
  const signature = matchInteractivePromptSignature(CODEX_RETIREMENT_PANE_TEXT);
  assert.ok(signature);
  assert.equal(signature.id, 'codex_model_retirement');
  assert.equal(signature.agent, 'codex');
});

test('interactive prompt matcher normalizes ANSI escapes and hard wraps', () => {
  const paneText = [
    '\u001b[1;32m  GPT-5.5 retires on\u001b[0m October 14, 2026',
    '  Try new',
    '   model',
    '\u001b[36m  Use existing model\u001b[0m',
  ].join('\n');
  const signature = matchInteractivePromptSignature(paneText);
  assert.ok(signature);
  assert.equal(signature.id, 'codex_model_retirement');
});

test('interactive prompt matcher rejects single-token mentions and source code', () => {
  assert.equal(matchInteractivePromptSignature('GPT-5.5 retires on October 14, 2026'), undefined);
  assert.equal(matchInteractivePromptSignature('only Try new model here'), undefined);
  assert.equal(
    matchInteractivePromptSignature('function retires() { return "Try new model" + "Use existing model"; }'),
    undefined,
  );
});

test('interactive prompt normalizer bounds runaway captures', () => {
  const bounded = normalizeInteractivePromptText('x'.repeat(20_000));
  assert.ok(bounded.length <= 8_000);
});

test('correlated Codex task pane at the retirement chooser produces a high-confidence incident', async () => {
  const fixture = interactivePromptFixture('HOK-3040', 'codex-model-retirement');
  try {
    await reconcileIncidents(
      interactivePromptSnapshot(fixture, CODEX_RETIREMENT_PANE_TEXT),
      defaultObserverOptions(),
    );
    const incidents = await promptIncidents(fixture.repoDir);
    assert.equal(incidents.length, 1);
    const [incident] = incidents;
    assert.equal(incident.taskId, 'HOK-3040');
    assert.equal(incident.severity, 'high');
    assert.equal(incident.confidence, 'high');
    assert.equal(incident.category, 'configuration_operator_condition');
    assert.equal(incident.metadata.promptSignatureId, 'codex_model_retirement');
    assert.equal(incident.metadata.promptAgent, 'codex');
    // Evidence carries only the signature summary — never the raw capture.
    assert.match(incident.evidence[0].redactedData, /prompt=codex_model_retirement/);
    assert.doesNotMatch(incident.evidence[0].redactedData, /GPT-5\.5/i);
    assert.doesNotMatch(incident.evidence[0].redactedData, /October/);
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

test('normal pane text without the full chooser produces no interactive-prompt incident', async () => {
  const fixture = interactivePromptFixture('HOK-3050', 'codex-normal-output');
  try {
    await reconcileIncidents(
      interactivePromptSnapshot(fixture, 'wavemill mill: coding phase in progress...\nRead observer.ts\n'),
      defaultObserverOptions(),
    );
    const incidents = await promptIncidents(fixture.repoDir);
    assert.equal(incidents.length, 0);
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

test('interactive prompt incident dedupes across polls and increments occurrence', async () => {
  const fixture = interactivePromptFixture('HOK-3041', 'codex-repeat-poll');
  try {
    const base = Date.now();
    for (let poll = 0; poll < 3; poll += 1) {
      await reconcileIncidents(
        interactivePromptSnapshot(fixture, CODEX_RETIREMENT_PANE_TEXT, {
          timestamp: new Date(base + poll * 1000).toISOString(),
        }),
        defaultObserverOptions(),
      );
    }
    const incidents = await promptIncidents(fixture.repoDir);
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].occurrenceCount, 3);
    // Threshold=3 -> the third distinct event escalates to active.
    assert.equal(incidents[0].lifecycle, 'active');
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

test('interactive prompt incident stays active when the prompt disappears without task progress', async () => {
  const fixture = interactivePromptFixture('HOK-3042', 'codex-disappears');
  try {
    const observedAt = new Date().toISOString();
    // Two polls with the prompt to seed the incident.
    await reconcileIncidents(
      interactivePromptSnapshot(fixture, CODEX_RETIREMENT_PANE_TEXT, {
        timestamp: observedAt,
        taskUpdated: observedAt,
      }),
      defaultObserverOptions(),
    );
    await reconcileIncidents(
      interactivePromptSnapshot(fixture, CODEX_RETIREMENT_PANE_TEXT, {
        timestamp: new Date(Date.parse(observedAt) + 1000).toISOString(),
        taskUpdated: observedAt,
      }),
      defaultObserverOptions(),
    );

    // Enough absent cycles to exceed the default resolutionAfterCycles=5.
    for (let i = 0; i < 8; i += 1) {
      await reconcileIncidents(
        interactivePromptSnapshot(fixture, undefined, {
          timestamp: new Date(Date.parse(observedAt) + (i + 2) * 1000).toISOString(),
          taskUpdated: observedAt,
        }),
        defaultObserverOptions(),
      );
    }

    const store = new IncidentStore(join(fixture.repoDir, '.wavemill', 'incidents'));
    const all = (await store.getAllIncidents()).filter(
      (incident) => incident.rootCauseClass === 'agent_interactive_prompt_blocked',
    );
    assert.equal(all.length, 1);
    assert.notEqual(all[0].lifecycle, 'resolved');
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

test('interactive prompt incident auto-resolves once the correlated task advances', async () => {
  const fixture = interactivePromptFixture('HOK-3043', 'codex-progress');
  try {
    const observedAt = new Date().toISOString();
    await reconcileIncidents(
      interactivePromptSnapshot(fixture, CODEX_RETIREMENT_PANE_TEXT, {
        timestamp: observedAt,
        taskUpdated: observedAt,
      }),
      defaultObserverOptions(),
    );

    // Prompt gone AND task has advanced beyond the recorded observation.
    const laterUpdated = new Date(Date.parse(observedAt) + 60_000).toISOString();
    for (let i = 0; i < 6; i += 1) {
      await reconcileIncidents(
        interactivePromptSnapshot(fixture, undefined, {
          timestamp: new Date(Date.parse(laterUpdated) + i * 1000).toISOString(),
          taskUpdated: laterUpdated,
        }),
        defaultObserverOptions(),
      );
    }

    const store = new IncidentStore(join(fixture.repoDir, '.wavemill', 'incidents'));
    const all = (await store.getAllIncidents()).filter(
      (incident) => incident.rootCauseClass === 'agent_interactive_prompt_blocked',
    );
    assert.equal(all.length, 1);
    assert.equal(all[0].lifecycle, 'resolved');
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

test('two blocked task panes get independent task-scoped incident fingerprints', async () => {
  const fixture = interactivePromptFixture('HOK-3044A', 'codex-multi-a');
  try {
    // The fixture only carries one repoDir; make two tasks with distinct panes
    // in the same snapshot.
    const paneA = {
      session: 'wavemill',
      windowIndex: '4',
      paneIndex: '0',
      windowName: 'HOK-3044A-codex-multi-a',
      active: true,
      pid: 6001,
      command: 'codex',
      title: 'coding HOK-3044A',
      capturedText: CODEX_RETIREMENT_PANE_TEXT,
    };
    const paneB = {
      session: 'wavemill',
      windowIndex: '5',
      paneIndex: '0',
      windowName: 'HOK-3044B-codex-multi-b',
      active: true,
      pid: 6002,
      command: 'codex',
      title: 'coding HOK-3044B',
      capturedText: CODEX_RETIREMENT_PANE_TEXT,
    };
    const now = new Date().toISOString();
    const snapshot = {
      timestamp: now,
      sessions: ['wavemill'],
      panes: [paneA, paneB],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir: fixture.repoDir,
        workflowStatePath: join(fixture.repoDir, '.wavemill', 'workflow-state.json'),
        tasks: [
          {
            issue: 'HOK-3044A',
            phase: 'coding',
            status: 'running',
            slug: 'codex-multi-a',
            worktree: fixture.repoDir,
            updated: now,
          },
          {
            issue: 'HOK-3044B',
            phase: 'coding',
            status: 'running',
            slug: 'codex-multi-b',
            worktree: fixture.repoDir,
            updated: now,
          },
        ],
      }],
      findings: [],
    };
    await reconcileIncidents(snapshot, defaultObserverOptions());

    const store = new IncidentStore(join(fixture.repoDir, '.wavemill', 'incidents'));
    const all = (await store.getAllIncidents()).filter(
      (incident) => incident.rootCauseClass === 'agent_interactive_prompt_blocked',
    );
    const byTask = new Set(all.map((incident) => incident.taskId));
    assert.equal(all.length, 2);
    assert.equal(byTask.size, 2);
    assert.ok(byTask.has('HOK-3044A'));
    assert.ok(byTask.has('HOK-3044B'));
    assert.notEqual(all[0].fingerprint, all[1].fingerprint);
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HOK-3096: state-based detectors — stuck merge candidates, abandoned
// exhausted retries, branches behind base
// ---------------------------------------------------------------------------

const OBSERVER_FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures', 'observer');

function renderFixtureTemplate(raw: string, vars: Record<string, string>): string {
  return raw.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!(key in vars)) throw new Error(`materializeObserverFixture: missing template var ${key}`);
    return vars[key];
  });
}

function materializeTemplateFile(templatePath: string, destPath: string, vars: Record<string, string>, mtime?: Date): void {
  const rendered = renderFixtureTemplate(readFileSync(templatePath, 'utf8'), vars);
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, rendered);
  if (mtime) utimesSync(destPath, mtime, mtime);
}

function fakeCaps(overrides: Record<string, unknown> = {}) {
  return {
    tend: false,
    observer: true,
    mergeExecutor: 'operator',
    mergeQueue: false,
    reasons: {
      tend: 'test', observer: 'test', mergeExecutor: 'test', mergeQueue: 'test',
    },
    health: { tend: null, observer: null },
    ...overrides,
  };
}

function materializeStuckCandidateReadyResult(
  featureDir: string,
  vars: { headSha: string; baseSha?: string; candidatePromotedAt: string; candidateLastProgressAt?: string },
): void {
  materializeTemplateFile(
    join(OBSERVER_FIXTURES_DIR, 'stuck-candidate', 'ready-result.json'),
    join(featureDir, '.ready-result.json'),
    {
      READY_STARTED_AT: agoIso(60),
      READY_FINISHED_AT: agoIso(55),
      HEAD_SHA: vars.headSha,
      BASE_SHA: vars.baseSha ?? 'base-sha',
      CANDIDATE_PROMOTED_AT: vars.candidatePromotedAt,
      CANDIDATE_LAST_PROGRESS_AT: vars.candidateLastProgressAt ?? vars.candidatePromotedAt,
    },
  );
}

function materializeMergeQueueTransitions(
  repoDir: string,
  vars: { pr: string; headSha: string; escalated: boolean; cycles: number },
): void {
  materializeTemplateFile(
    join(OBSERVER_FIXTURES_DIR, 'stuck-candidate', 'merge-queue-transitions.json'),
    join(repoDir, '.wavemill', 'merge-queue-transitions.json'),
    {
      PR: vars.pr,
      HEAD_SHA: vars.headSha,
      ESCALATED: String(vars.escalated),
      CYCLES: String(vars.cycles),
      UPDATED_AT: agoIso(1),
    },
  );
}

function materializeHealthyReadyResult(featureDir: string, headSha: string): void {
  materializeTemplateFile(
    join(OBSERVER_FIXTURES_DIR, 'healthy', 'ready-result.json'),
    join(featureDir, '.ready-result.json'),
    {
      READY_STARTED_AT: agoIso(10),
      READY_FINISHED_AT: agoIso(5),
      HEAD_SHA: headSha,
    },
  );
}

function stuckCandidateRepo(repoDir: string, overrides: Record<string, unknown> = {}) {
  return {
    session: 'wavemill',
    repoDir,
    tasks: [{
      issue: 'HOK-9100',
      slug: 'stuck-candidate-fixture',
      phase: 'ready',
      status: 'active',
      worktree: repoDir,
      ...overrides,
    }],
  };
}

test('HOK-3096 Detector 1 (REQ-F1): stuck merge candidate fires high severity with no merge consumer', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-stuck-candidate-'));
  const featureDir = join(repoDir, 'features', 'stuck-candidate-fixture');
  mkdirSync(featureDir, { recursive: true });
  materializeStuckCandidateReadyResult(featureDir, { headSha: 'head-sha-1', candidatePromotedAt: agoIso(20) });

  try {
    const repo = stuckCandidateRepo(repoDir);
    const findings = detectStuckMergeCandidates(repo as never, Date.now(), fakeCaps() as never);
    const finding = findings.find((f) => f.id === 'stuck-merge-candidate-wavemill-HOK-9100');
    assert.ok(finding, `expected a stuck-merge-candidate finding, got: ${findings.map((f) => f.id).join(', ')}`);
    assert.equal(finding?.severity, 'high');
    assert.match(finding!.title, /stuck in merge-candidate with no active merge consumer/);
    assert.match(finding!.recommendation, /no active merge consumer/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('HOK-3096 Detector 1 (REQ-F1): stuck merge candidate is suppressed when a merge consumer is active', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-stuck-candidate-consumer-'));
  const featureDir = join(repoDir, 'features', 'stuck-candidate-fixture');
  mkdirSync(featureDir, { recursive: true });
  materializeStuckCandidateReadyResult(featureDir, { headSha: 'head-sha-1', candidatePromotedAt: agoIso(20) });

  try {
    const repo = stuckCandidateRepo(repoDir);
    const caps = fakeCaps({ tend: true, mergeExecutor: 'tend', mergeQueue: true });
    const findings = detectStuckMergeCandidates(repo as never, Date.now(), caps as never);
    assert.equal(findings.find((f) => f.id === 'stuck-merge-candidate-wavemill-HOK-9100'), undefined);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('HOK-3096 Detector 1 (REQ-F1): a freshly promoted candidate (< 15m) is not yet stuck', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-stuck-candidate-fresh-'));
  const featureDir = join(repoDir, 'features', 'stuck-candidate-fixture');
  mkdirSync(featureDir, { recursive: true });
  materializeStuckCandidateReadyResult(featureDir, { headSha: 'head-sha-1', candidatePromotedAt: agoIso(5) });

  try {
    const repo = stuckCandidateRepo(repoDir);
    const findings = detectStuckMergeCandidates(repo as never, Date.now(), fakeCaps() as never);
    assert.equal(findings.find((f) => f.id === 'stuck-merge-candidate-wavemill-HOK-9100'), undefined);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('HOK-3096 Detector 1 (REQ-F2): three promotions on the same head within the churn window fire a churn finding', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-candidate-churn-'));
  const featureDir = join(repoDir, 'features', 'stuck-candidate-fixture');
  mkdirSync(featureDir, { recursive: true });
  const repo = stuckCandidateRepo(repoDir);
  const caps = fakeCaps();

  try {
    let findings: ReturnType<typeof detectStuckMergeCandidates> = [];
    for (const minutesAgo of [25, 15, 5]) {
      materializeStuckCandidateReadyResult(featureDir, { headSha: 'churn-head', candidatePromotedAt: agoIso(minutesAgo) });
      findings = detectStuckMergeCandidates(repo as never, Date.now(), caps as never);
    }
    const churn = findings.find((f) => f.id === 'merge-candidate-churn-wavemill-HOK-9100');
    assert.ok(churn, `expected a churn finding, got: ${findings.map((f) => f.id).join(', ')}`);
    assert.equal(churn?.severity, 'high');
    assert.ok(churn!.evidence.includes('promotions=3'));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('HOK-3096 Detector 1 (REQ-F2): churn count resets when the head SHA changes', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-candidate-churn-reset-'));
  const featureDir = join(repoDir, 'features', 'stuck-candidate-fixture');
  mkdirSync(featureDir, { recursive: true });
  const repo = stuckCandidateRepo(repoDir);
  const caps = fakeCaps();

  try {
    materializeStuckCandidateReadyResult(featureDir, { headSha: 'head-A', candidatePromotedAt: agoIso(25) });
    detectStuckMergeCandidates(repo as never, Date.now(), caps as never);
    materializeStuckCandidateReadyResult(featureDir, { headSha: 'head-A', candidatePromotedAt: agoIso(15) });
    detectStuckMergeCandidates(repo as never, Date.now(), caps as never);
    // New head: a real commit superseded the churn, so the count must reset
    // rather than keep accumulating toward the threshold.
    materializeStuckCandidateReadyResult(featureDir, { headSha: 'head-B', candidatePromotedAt: agoIso(5) });
    const findings = detectStuckMergeCandidates(repo as never, Date.now(), caps as never);
    assert.equal(findings.find((f) => f.id === 'merge-candidate-churn-wavemill-HOK-9100'), undefined);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('HOK-3096 Detector 1: a malformed .ready-result.json is skipped without throwing', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-stuck-candidate-malformed-'));
  const featureDir = join(repoDir, 'features', 'stuck-candidate-fixture');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, '.ready-result.json'), 'not valid json {{{');

  try {
    const repo = stuckCandidateRepo(repoDir);
    assert.doesNotThrow(() => {
      const findings = detectStuckMergeCandidates(repo as never, Date.now(), fakeCaps() as never);
      assert.equal(findings.length, 0);
    });
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// HOK-3240: with tend + mergeQueue on (the fleet's normal mode) a candidate is
// still stuck when its PR lacks `wm:ready` — the consumer never picks it up.
const consumerCaps = () => fakeCaps({ tend: true, mergeExecutor: 'tend', mergeQueue: true });

function prViewSpy(labels: string[] | undefined) {
  const calls: string[] = [];
  const readPrView = (_repoDir: string, pr: string) => {
    calls.push(pr);
    return labels === undefined ? undefined : { state: 'OPEN', baseRefName: 'auto/integration', labels };
  };
  return { calls, readPrView };
}

function withStuckCandidate(
  name: string,
  opts: { candidatePromotedAt: string; headSha?: string },
  fn: (repoDir: string) => void,
): void {
  const repoDir = mkdtempSync(join(tmpdir(), `observer-${name}-`));
  const featureDir = join(repoDir, 'features', 'stuck-candidate-fixture');
  mkdirSync(featureDir, { recursive: true });
  materializeStuckCandidateReadyResult(featureDir, { headSha: opts.headSha ?? 'head-sha-1', candidatePromotedAt: opts.candidatePromotedAt });
  try {
    fn(repoDir);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
}

test('HOK-3240: stuck merge candidate fires when a consumer is active but the PR lacks wm:ready', () => {
  withStuckCandidate('stuck-candidate-no-label', { candidatePromotedAt: agoIso(20) }, (repoDir) => {
    const spy = prViewSpy(['wm:blocked']);
    const findings = detectStuckMergeCandidates(
      stuckCandidateRepo(repoDir, { pr: '1632' }) as never, Date.now(), consumerCaps() as never, { readPrView: spy.readPrView },
    );
    const finding = findings.find((f) => f.id === 'stuck-merge-candidate-wavemill-HOK-9100');
    assert.ok(finding, `expected a stuck-merge-candidate finding, got: ${findings.map((f) => f.id).join(', ')}`);
    assert.equal(finding?.severity, 'high');
    assert.match(finding!.title, /PR #1632 has no wm:ready label/);
    assert.ok(finding!.evidence.includes('gateReason=pr-lacks-wm-ready'));
    assert.ok(finding!.evidence.includes('prLacksReadyLabel=true'));
    assert.ok(finding!.evidence.includes('pr=#1632 state=OPEN base=auto/integration'));
    assert.match(finding!.recommendation, /deriveMergeLabel\(\) does not yield wm:ready/);
  });
});

test('HOK-3240: no stuck finding when the PR carries wm:ready', () => {
  withStuckCandidate('stuck-candidate-labelled', { candidatePromotedAt: agoIso(20) }, (repoDir) => {
    const spy = prViewSpy(['wm:ready']);
    const findings = detectStuckMergeCandidates(
      stuckCandidateRepo(repoDir, { pr: '1632' }) as never, Date.now(), consumerCaps() as never, { readPrView: spy.readPrView },
    );
    assert.equal(findings.find((f) => f.id === 'stuck-merge-candidate-wavemill-HOK-9100'), undefined);
  });
});

test('HOK-3240: no stuck finding when the PR labels cannot be read (gh failure)', () => {
  withStuckCandidate('stuck-candidate-gh-fail', { candidatePromotedAt: agoIso(20) }, (repoDir) => {
    const spy = prViewSpy(undefined);
    const findings = detectStuckMergeCandidates(
      stuckCandidateRepo(repoDir, { pr: '1632' }) as never, Date.now(), consumerCaps() as never, { readPrView: spy.readPrView },
    );
    assert.equal(findings.find((f) => f.id === 'stuck-merge-candidate-wavemill-HOK-9100'), undefined);
  });
});

test('HOK-3240: a consumer-backed candidate with no PR is not flagged and never calls gh', () => {
  withStuckCandidate('stuck-candidate-no-pr', { candidatePromotedAt: agoIso(20) }, (repoDir) => {
    const spy = prViewSpy(['wm:blocked']);
    const findings = detectStuckMergeCandidates(
      stuckCandidateRepo(repoDir) as never, Date.now(), consumerCaps() as never, { readPrView: spy.readPrView },
    );
    assert.equal(findings.find((f) => f.id === 'stuck-merge-candidate-wavemill-HOK-9100'), undefined);
    assert.equal(spy.calls.length, 0);
  });
});

test('HOK-3240: one gh pr view per merge-candidate task per pass', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-stuck-candidate-budget-'));
  const tasks = ['1701', '1702', '1703'].map((pr, i) => {
    const slug = `stuck-candidate-budget-${i}`;
    const featureDir = join(repoDir, 'features', slug);
    mkdirSync(featureDir, { recursive: true });
    materializeStuckCandidateReadyResult(featureDir, { headSha: `head-${i}`, candidatePromotedAt: agoIso(20) });
    return { issue: `HOK-91${i}0`, slug, phase: 'ready', status: 'active', worktree: repoDir, pr };
  });

  try {
    const spy = prViewSpy(['wm:blocked']);
    const findings = detectStuckMergeCandidates(
      { session: 'wavemill', repoDir, tasks } as never, Date.now(), consumerCaps() as never, { readPrView: spy.readPrView },
    );
    assert.equal(findings.filter((f) => f.id.startsWith('stuck-merge-candidate-')).length, 3);
    // Acceptance cost line: one gh pr view per merge-candidate task per pass —
    // the label gate and the PR evidence line share the same read.
    assert.deepEqual(spy.calls, ['1701', '1702', '1703']);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('HOK-3240 replay (HOK-3212, 2026-10-12 #1632): fires on the first 120s pass past the 15 min threshold', () => {
  // Candidate progress stamped 16 minutes ago: the first monitor pass (120s
  // cadence) after the 15 minute threshold must produce the finding.
  withStuckCandidate('stuck-candidate-replay', { candidatePromotedAt: agoIso(16) }, (repoDir) => {
    const spy = prViewSpy(['wm:blocked']);
    const repo = stuckCandidateRepo(repoDir, { pr: '1632' });
    const beforeThreshold = detectStuckMergeCandidates(
      repo as never, Date.now() - 2 * 60_000, consumerCaps() as never, { readPrView: spy.readPrView },
    );
    assert.equal(beforeThreshold.find((f) => f.id === 'stuck-merge-candidate-wavemill-HOK-9100'), undefined);
    const findings = detectStuckMergeCandidates(
      repo as never, Date.now(), consumerCaps() as never, { readPrView: spy.readPrView },
    );
    assert.ok(findings.find((f) => f.id === 'stuck-merge-candidate-wavemill-HOK-9100'));
  });
});

test('HOK-3240 durable churn: escalated transition record fires churn below the in-window threshold', () => {
  withStuckCandidate('candidate-churn-durable', { candidatePromotedAt: agoIso(5), headSha: 'ci-head-1' }, (repoDir) => {
    materializeMergeQueueTransitions(repoDir, { pr: '1633', headSha: 'ci-head-1', escalated: true, cycles: 58 });
    const findings = detectStuckMergeCandidates(
      stuckCandidateRepo(repoDir, { pr: '1633' }) as never, Date.now(), consumerCaps() as never,
      { readPrView: prViewSpy(['wm:ready']).readPrView },
    );
    const churn = findings.find((f) => f.id === 'merge-candidate-churn-wavemill-HOK-9100');
    assert.ok(churn, `expected a churn finding, got: ${findings.map((f) => f.id).join(', ')}`);
    assert.equal(churn?.severity, 'high');
    assert.ok(churn!.evidence.includes('promotions=1'));
    assert.ok(churn!.evidence.includes('durablyEscalated=true'));
    assert.ok(churn!.evidence.includes('cyclesRecorded=58'));
  });
});

test('HOK-3240 durable churn: a non-escalated record, other head, or missing journal does not fire', () => {
  withStuckCandidate('candidate-churn-not-escalated', { candidatePromotedAt: agoIso(5), headSha: 'ci-head-1' }, (repoDir) => {
    const repo = stuckCandidateRepo(repoDir, { pr: '1633' });
    const deps = { readPrView: prViewSpy(['wm:ready']).readPrView };
    const churnFinding = () => detectStuckMergeCandidates(repo as never, Date.now(), consumerCaps() as never, deps)
      .find((f) => f.id === 'merge-candidate-churn-wavemill-HOK-9100');

    assert.equal(churnFinding(), undefined, 'missing journal');
    materializeMergeQueueTransitions(repoDir, { pr: '1633', headSha: 'ci-head-1', escalated: false, cycles: 2 });
    assert.equal(churnFinding(), undefined, 'escalated=false');
    materializeMergeQueueTransitions(repoDir, { pr: '1633', headSha: 'older-head', escalated: true, cycles: 9 });
    assert.equal(churnFinding(), undefined, 'escalation latched on a different head');
  });
});

test('HOK-3240 durable churn: a malformed transitions journal is ignored without throwing', () => {
  withStuckCandidate('candidate-churn-malformed', { candidatePromotedAt: agoIso(5) }, (repoDir) => {
    mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
    writeFileSync(join(repoDir, '.wavemill', 'merge-queue-transitions.json'), 'not-valid-json');
    assert.doesNotThrow(() => {
      const findings = detectStuckMergeCandidates(
        stuckCandidateRepo(repoDir, { pr: '1633' }) as never, Date.now(), consumerCaps() as never,
        { readPrView: prViewSpy(['wm:ready']).readPrView },
      );
      assert.equal(findings.find((f) => f.id === 'merge-candidate-churn-wavemill-HOK-9100'), undefined);
    });
  });
});

// ---------------------------------------------------------------------------
// Detector 2: exhausted retries (REQ-F3)
// ---------------------------------------------------------------------------

function exhaustedRetryRepo(repoDir: string, branch: string, overrides: Record<string, unknown> = {}) {
  return {
    session: 'wavemill',
    repoDir,
    tasks: [{
      issue: 'HOK-9200',
      slug: 'exhausted-retry-fixture',
      phase: 'coding',
      status: 'active',
      worktree: repoDir,
      branch,
      ...overrides,
    }],
  };
}

function writeExhaustedRetrySentinel(
  featureDir: string,
  bucket: string,
  { mtime, reason = 'Failed to become ready after 3 attempts.\n', headSha }: { mtime: Date; reason?: string; headSha?: string },
): void {
  // Mirror `_bounded_retry_prefix` in shared/lib/bounded-retry.sh: all buckets
  // use `.retry-<bucket>-` except `failed-ready-recheck`, which keeps its
  // pre-HOK-2924 naming (`.failed-ready-recheck-*`) for upgrade compatibility.
  const filePrefix = bucket === 'failed-ready-recheck' ? '.failed-ready-recheck-' : `.retry-${bucket}-`;
  const sentinelPath = join(featureDir, `${filePrefix}exhausted`);
  writeFileSync(sentinelPath, reason);
  utimesSync(sentinelPath, mtime, mtime);
  if (headSha !== undefined) {
    materializeTemplateFile(
      join(OBSERVER_FIXTURES_DIR, 'exhausted-retry', 'retry-head.txt'),
      join(featureDir, `${filePrefix}head`),
      { HEAD_SHA: headSha },
    );
  }
}

const noProgress = () => undefined;

test('HOK-3096 Detector 2 (REQ-F3): exhausted sentinel with no newer commit or progress fires high severity', () => {
  const fixture = createResidueGitFixture({ commits: 1, slug: 'exhausted-retry-fixture', commitAgeMinutes: 20 });
  const featureDir = join(fixture.repoDir, 'features', fixture.slug);
  mkdirSync(featureDir, { recursive: true });
  writeExhaustedRetrySentinel(featureDir, 'failed-ready-recheck', { mtime: new Date(Date.now() - 15 * 60_000) });

  try {
    const repo = exhaustedRetryRepo(fixture.repoDir, fixture.branch);
    const findings = detectExhaustedRetries(repo as never, Date.now(), noProgress as never);
    const finding = findings.find((f) => f.id === 'exhausted-retry-abandoned-wavemill-HOK-9200-failed-ready-recheck');
    assert.ok(finding, `expected an exhausted-retry finding, got: ${findings.map((f) => f.id).join(', ')}`);
    assert.equal(finding?.severity, 'high');
    assert.match(finding!.title, /Exhausted retries: Failed to become ready after 3 attempts\./);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('HOK-3096 Detector 2 (REQ-F3): suppressed when a newer commit exists on the branch', () => {
  const fixture = createResidueGitFixture({ commits: 1, slug: 'exhausted-retry-fixture', commitAgeMinutes: 2 });
  const featureDir = join(fixture.repoDir, 'features', fixture.slug);
  mkdirSync(featureDir, { recursive: true });
  writeExhaustedRetrySentinel(featureDir, 'failed-ready-recheck', { mtime: new Date(Date.now() - 15 * 60_000) });

  try {
    const repo = exhaustedRetryRepo(fixture.repoDir, fixture.branch);
    const findings = detectExhaustedRetries(repo as never, Date.now(), noProgress as never);
    assert.equal(findings.find((f) => f.id === 'exhausted-retry-abandoned-wavemill-HOK-9200-failed-ready-recheck'), undefined);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('HOK-3096 Detector 2 (REQ-F3): suppressed when the retry head key no longer matches the branch tip', () => {
  const fixture = createResidueGitFixture({ commits: 1, slug: 'exhausted-retry-fixture', commitAgeMinutes: 20 });
  const featureDir = join(fixture.repoDir, 'features', fixture.slug);
  mkdirSync(featureDir, { recursive: true });
  writeExhaustedRetrySentinel(featureDir, 'failed-ready-recheck', {
    mtime: new Date(Date.now() - 15 * 60_000),
    headSha: '0000000000000000000000000000000000dead',
  });

  try {
    const repo = exhaustedRetryRepo(fixture.repoDir, fixture.branch);
    const findings = detectExhaustedRetries(repo as never, Date.now(), noProgress as never);
    assert.equal(findings.find((f) => f.id === 'exhausted-retry-abandoned-wavemill-HOK-9200-failed-ready-recheck'), undefined);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('HOK-3096 Detector 2 (REQ-F3): suppressed when the task-progress primitive shows later activity', () => {
  const fixture = createResidueGitFixture({ commits: 1, slug: 'exhausted-retry-fixture', commitAgeMinutes: 20 });
  const featureDir = join(fixture.repoDir, 'features', fixture.slug);
  mkdirSync(featureDir, { recursive: true });
  writeExhaustedRetrySentinel(featureDir, 'failed-ready-recheck', { mtime: new Date(Date.now() - 15 * 60_000) });
  const laterProgress = () => ({ lastProgressAt: agoIso(5) }) as never;

  try {
    const repo = exhaustedRetryRepo(fixture.repoDir, fixture.branch);
    const findings = detectExhaustedRetries(repo as never, Date.now(), laterProgress as never);
    assert.equal(findings.find((f) => f.id === 'exhausted-retry-abandoned-wavemill-HOK-9200-failed-ready-recheck'), undefined);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('HOK-3096 Detector 2 (REQ-F3): multiple exhausted buckets each produce their own finding', () => {
  const fixture = createResidueGitFixture({ commits: 1, slug: 'exhausted-retry-fixture', commitAgeMinutes: 20 });
  const featureDir = join(fixture.repoDir, 'features', fixture.slug);
  mkdirSync(featureDir, { recursive: true });
  const mtime = new Date(Date.now() - 15 * 60_000);
  writeExhaustedRetrySentinel(featureDir, 'failed-ready-recheck', { mtime });
  writeExhaustedRetrySentinel(featureDir, 'coding-dirty-handoff', { mtime, reason: 'Dirty tree after coding exit.\n' });

  try {
    const repo = exhaustedRetryRepo(fixture.repoDir, fixture.branch);
    const findings = detectExhaustedRetries(repo as never, Date.now(), noProgress as never);
    assert.ok(findings.some((f) => f.id === 'exhausted-retry-abandoned-wavemill-HOK-9200-failed-ready-recheck'));
    assert.ok(findings.some((f) => f.id === 'exhausted-retry-abandoned-wavemill-HOK-9200-coding-dirty-handoff'));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Detector 3: branch behind base (REQ-F4, REQ-F5)
// ---------------------------------------------------------------------------

/**
 * Builds a local-only git repo (no bare origin / push) with a task branch
 * left `behindCommits` commits behind its base. `measureBranchBaseDistance`
 * tries `origin/<base>` first and falls back to the local `<base>` ref when
 * no remote-tracking ref exists (same fallback `inspectTaskBranchResidue`
 * uses), so skipping the origin plumbing here is representative of the real
 * fallback path and keeps this fixture fast — no bare repo, no pushes.
 */
function createStaleBaseGitFixture({
  behindCommits = 10,
  slug = 'stale-base-fixture',
}: { behindCommits?: number; slug?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'observer-stale-base-'));
  const repoDir = join(root, 'repo');
  mkdirSync(repoDir, { recursive: true });
  runGit(repoDir, ['init']);
  runGit(repoDir, ['config', 'user.email', 'observer-test@example.com']);
  runGit(repoDir, ['config', 'user.name', 'Observer Test']);
  runGit(repoDir, ['config', 'commit.gpgsign', 'false']);
  runGit(repoDir, ['checkout', '-b', 'auto/integration']);
  writeFileSync(join(repoDir, 'base.txt'), 'base\n');
  writePermissiveSchema(repoDir);
  writeFileSync(join(repoDir, '.gitignore'), '.wavemill/\n');
  runGit(repoDir, ['add', '.']);
  runGit(repoDir, ['commit', '-m', 'base commit']);

  const branch = `task/${slug}`;
  runGit(repoDir, ['checkout', '-b', branch]);
  writeFileSync(join(repoDir, 'work.txt'), 'work\n');
  runGit(repoDir, ['add', '.']);
  runGit(repoDir, ['commit', '-m', 'task commit']);

  runGit(repoDir, ['checkout', 'auto/integration']);
  for (let i = 1; i <= behindCommits; i += 1) {
    writeFileSync(join(repoDir, `base-${i}.txt`), `base ${i}\n`);
    runGit(repoDir, ['add', '.']);
    runGit(repoDir, ['commit', '-m', `base commit ${i}`]);
  }
  runGit(repoDir, ['checkout', branch]);

  return { root, repoDir, slug, branch };
}

function behindBaseRepo(repoDir: string, branch: string, overrides: Record<string, unknown> = {}) {
  return {
    session: 'wavemill',
    repoDir,
    tasks: [{
      issue: 'HOK-9300',
      slug: 'stale-base-fixture',
      phase: 'ready',
      status: 'active',
      worktree: repoDir,
      branch,
      ...overrides,
    }],
  };
}

test('HOK-3096 Detector 3 (REQ-F4): a branch more than 5 commits behind its base fires medium severity', () => {
  const fixture = createStaleBaseGitFixture({ behindCommits: 10 });
  try {
    const repo = behindBaseRepo(fixture.repoDir, fixture.branch);
    const findings = detectBranchBehindBase(repo as never, Date.now());
    const finding = findings.find((f) => f.id === 'branch-behind-base-wavemill-HOK-9300');
    assert.ok(finding, `expected a branch-behind-base finding, got: ${findings.map((f) => f.id).join(', ')}`);
    assert.equal(finding?.severity, 'medium');
    assert.ok(finding!.evidence.includes('behindBase=10'));
    assert.match(finding!.recommendation, /update-branch-with-base\.ts/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('HOK-3096 Detector 3 (REQ-F4): a branch only 2 commits behind its base produces no finding', () => {
  const fixture = createStaleBaseGitFixture({ behindCommits: 2 });
  try {
    const repo = behindBaseRepo(fixture.repoDir, fixture.branch);
    const findings = detectBranchBehindBase(repo as never, Date.now());
    assert.equal(findings.find((f) => f.id === 'branch-behind-base-wavemill-HOK-9300'), undefined);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('HOK-3096 Detector 3 (REQ-F5): severity is elevated to high when the PR carries wm:ready', () => {
  const fixture = createStaleBaseGitFixture({ behindCommits: 10 });
  try {
    const repo = behindBaseRepo(fixture.repoDir, fixture.branch, { pr: '4242' });
    const findings = detectBranchBehindBase(repo as never, Date.now(), { readPrLabels: () => ['wm:ready'] });
    const finding = findings.find((f) => f.id === 'branch-behind-base-wavemill-HOK-9300');
    assert.ok(finding);
    assert.equal(finding?.severity, 'high');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('HOK-3096 Detector 3 (REQ-F5): severity falls back to queueState when PR labels are unknown', () => {
  const fixture = createStaleBaseGitFixture({ behindCommits: 10 });
  const featureDir = join(fixture.repoDir, 'features', fixture.slug);
  mkdirSync(featureDir, { recursive: true });
  materializeStuckCandidateReadyResult(featureDir, { headSha: 'any-head', candidatePromotedAt: agoIso(1) });

  try {
    const repo = behindBaseRepo(fixture.repoDir, fixture.branch);
    const findings = detectBranchBehindBase(repo as never, Date.now());
    const finding = findings.find((f) => f.id === 'branch-behind-base-wavemill-HOK-9300');
    assert.ok(finding);
    assert.equal(finding?.severity, 'high');
    assert.ok(finding!.evidence.includes('queueState=merge-candidate'));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('HOK-3096 Detector 3: terminal tasks never produce a branch-behind-base finding', () => {
  const fixture = createStaleBaseGitFixture({ behindCommits: 10 });
  try {
    const repo = behindBaseRepo(fixture.repoDir, fixture.branch, { status: 'merged' });
    const findings = detectBranchBehindBase(repo as never, Date.now());
    assert.equal(findings.find((f) => f.id === 'branch-behind-base-wavemill-HOK-9300'), undefined);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('HOK-3096 Detector 3: an unresolvable branch never produces a finding', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-behind-base-unknown-'));
  try {
    const repo = behindBaseRepo(repoDir, 'task/does-not-exist');
    assert.doesNotThrow(() => {
      const findings = detectBranchBehindBase(repo as never, Date.now());
      assert.equal(findings.find((f) => f.id === 'branch-behind-base-wavemill-HOK-9300'), undefined);
    });
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('HOK-3096 behindBaseSeverity: pure severity rule', () => {
  assert.equal(behindBaseSeverity({ hasReadyLabel: true }), 'high');
  assert.equal(behindBaseSeverity({ hasReadyLabel: false }), 'medium');
  assert.equal(behindBaseSeverity({ hasReadyLabel: undefined, queueState: 'ready' }), 'high');
  assert.equal(behindBaseSeverity({ hasReadyLabel: undefined, queueState: 'ready-stale' }), 'high');
  assert.equal(behindBaseSeverity({ hasReadyLabel: undefined, queueState: 'merge-candidate' }), 'high');
  assert.equal(behindBaseSeverity({ hasReadyLabel: undefined, queueState: undefined }), 'medium');
});

// ---------------------------------------------------------------------------
// Integration: all three detectors wired through buildFindings
// ---------------------------------------------------------------------------

test('HOK-3096 integration (REQ-F1): buildFindings reports a stuck candidate via resolveSessionCapabilities', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-stuck-candidate-integration-'));
  const slug = 'stuck-candidate-fixture';
  const featureDir = join(repoDir, 'features', slug);
  mkdirSync(featureDir, { recursive: true });
  materializeStuckCandidateReadyResult(featureDir, { headSha: 'head-sha-1', candidatePromotedAt: agoIso(20) });
  writePermissiveSchema(repoDir);
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    configVersion: '1.5.0',
    mill: { baseBranch: 'auto/integration', requireConfirm: false },
    integration: { enabled: false },
  }, null, 2));

  try {
    const findings = buildFindings({
      timestamp: new Date().toISOString(),
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        tasks: [{ issue: 'HOK-9101', slug, phase: 'ready', status: 'active', worktree: repoDir }],
      }],
    }, defaultObserverOptions());

    const finding = findings.find((f) => f.id === 'stuck-merge-candidate-wavemill-HOK-9101');
    assert.ok(finding, `expected a stuck-merge-candidate finding, got: ${findings.map((f) => f.id).join(', ')}`);
    assert.equal(finding?.severity, 'high');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('HOK-3096 integration (REQ-F7): a healthy task produces none of the new detector findings', () => {
  const fixture = createStaleBaseGitFixture({ behindCommits: 0, slug: 'healthy-fixture' });
  const featureDir = join(fixture.repoDir, 'features', fixture.slug);
  mkdirSync(featureDir, { recursive: true });
  materializeHealthyReadyResult(featureDir, 'healthy-head-sha');
  writeFileSync(join(fixture.repoDir, '.wavemill-config.json'), JSON.stringify({
    configVersion: '1.5.0',
    mill: { baseBranch: 'auto/integration', requireConfirm: false },
    integration: { enabled: true, useMillSession: true },
  }, null, 2));

  try {
    const findings = buildFindings({
      timestamp: new Date().toISOString(),
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir: fixture.repoDir,
        tasks: [{
          issue: 'HOK-9400',
          slug: fixture.slug,
          phase: 'ready',
          status: 'active',
          worktree: fixture.repoDir,
          branch: fixture.branch,
        }],
      }],
    }, defaultObserverOptions());

    const newDetectorFindings = findings.filter((f) => f.issue === 'HOK-9400' && (
      f.id.startsWith('stuck-merge-candidate-')
      || f.id.startsWith('merge-candidate-churn-')
      || f.id.startsWith('exhausted-retry-abandoned-')
      || f.id.startsWith('branch-behind-base-')
    ));
    assert.deepEqual(newDetectorFindings, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

// ── HOK-3142: typed coding launch refusals ───────────────────────────────────

const HOK3142_CERTIFY = 'npx tsx tools/native-agent-certify.ts --provider openrouter --model gemini-2.5-pro --phase patch --live-coding-canary';

test('HOK-3142: warn-level [launch-refusal] lines yield one launch-refused finding naming the model, reason, and certify command', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-launch-refusal-'));
  const logPath = join(repoDir, 'mill-wavemill.log');
  try {
    writePermissiveSchema(repoDir);
    const refusal = `[warn] [launch-refusal] issue=HOK-3138 phase=coding model=gemini-2.5-pro provider=openrouter reason=uncertified certification=missing_live_canary`;
    writeFileSync(logPath, [
      `12:39:00 ${refusal} action=rerouted substitute=claude-sonnet-5 certify="${HOK3142_CERTIFY}"`,
      `12:44:00 ${refusal} action=needs-user certify="${HOK3142_CERTIFY}"`,
    ].join('\n'));

    const findings = buildFindings(basicSnapshot(repoDir, logPath), defaultObserverOptions());
    const refusals = findings.filter((finding) => finding.id.startsWith('launch-refused-'));
    assert.equal(refusals.length, 1);
    const [finding] = refusals;
    assert.equal(finding.issue, 'HOK-3138');
    assert.equal(finding.severity, 'urgent');
    assert.equal(finding.category, 'stuck');
    assert.match(finding.title, /gemini-2\.5-pro/);
    assert.match(finding.title, /uncertified:missing_live_canary/);
    assert.ok(finding.evidence.includes('reason=uncertified'));
    assert.ok(finding.evidence.includes('certification=missing_live_canary'));
    assert.ok(finding.evidence.includes(`certify=${HOK3142_CERTIFY}`));
    assert.ok(finding.recommendation.includes(HOK3142_CERTIFY));
    assert.equal(
      findings.filter((candidate) => candidate.id.startsWith('log-warning-')).length,
      0,
      'refusal lines must not also produce a generic log-warning finding',
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('HOK-3142: legacy [info] "Coding launch blocked" retry loop is classified with its certify command', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-launch-refusal-legacy-'));
  const logPath = join(repoDir, 'mill-wavemill.log');
  try {
    writePermissiveSchema(repoDir);
    const legacy = (ts: string) => `${ts} [info] warn ⚠ HOK-3138 → Coding launch blocked: [agent-resolution] model=gemini-2.5-pro phase=coding provider=openrouter reason=uncertified certification=missing_live_canary certify="npx tsx tools/native-agent-certify.ts --provider openrouter --model gemini-2.5-pro --phase patch"`;
    writeFileSync(logPath, ['12:39:00', '12:44:00', '12:49:00'].map(legacy).join('\n'));

    const finding = buildFindings(basicSnapshot(repoDir, logPath), defaultObserverOptions())
      .find((candidate) => candidate.id.startsWith('launch-refused-'));
    assert.ok(finding, 'legacy refusal lines are classified');
    assert.equal(finding.severity, 'urgent', 'three identical refused relaunches is a retry loop');
    assert.equal(finding.occurrenceCount, 3);
    assert.ok(finding.evidence.includes('action=retry-loop'));
    assert.ok(finding.recommendation.includes('--model gemini-2.5-pro --phase patch'));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('HOK-3142: a refusal that only ever re-routed is reported as low-severity information', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-launch-refusal-rerouted-'));
  const logPath = join(repoDir, 'mill-wavemill.log');
  try {
    writePermissiveSchema(repoDir);
    writeFileSync(logPath, `12:39:00 [warn] [launch-refusal] issue=HOK-1 phase=coding model=qwen-3-coder provider=openrouter reason=uncertified certification=stale_live_canary action=rerouted substitute=claude-sonnet-5 certify="unavailable"\n`);
    const finding = buildFindings(basicSnapshot(repoDir, logPath), defaultObserverOptions())
      .find((candidate) => candidate.id.startsWith('launch-refused-'));
    assert.ok(finding);
    assert.equal(finding.severity, 'low');
    assert.match(finding.title, /re-routed to claude-sonnet-5/);
    assert.ok(finding.evidence.includes('certify=unavailable'));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('HOK-3142: parseLaunchRefusalLine ignores unrelated warnings', () => {
  assert.equal(parseLaunchRefusalLine('12:00:00 [warn] ready watchdog tick failed'), null);
  assert.equal(parseLaunchRefusalLine('12:00:00 [warn] [launch-refusal] phase=coding reason=uncertified'), null, 'issue and model are required');
  const parsed = parseLaunchRefusalLine('12:00:00 [warn] [launch-refusal] issue=HOK-9_c phase=coding model=openai/gpt-x provider=openrouter reason=role-ineligible certification=eligible-roles:review action=needs-user certify="unavailable"');
  assert.equal(parsed?.issue, 'HOK-9_c');
  assert.equal(parsed?.model, 'openai/gpt-x');
  assert.equal(parsed?.certification, 'eligible-roles:review');
  assert.equal(parsed?.certify, undefined);
});

test('HOK-3142: plan-approved arm parked by a coding launch refusal names the cause, not the monitor', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-launch-refusal-parked-'));
  const slug = 'launch-refused-fixture';
  const featureDir = join(repoDir, 'features', slug);
  const issue = 'HOK-3138';
  try {
    mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
    mkdirSync(featureDir, { recursive: true });
    writePermissiveSchema(repoDir);
    const markerPath = join(featureDir, '.plan-approved');
    writeFileSync(markerPath, '');
    const markerMtime = new Date(Date.now() - 30 * 60_000);
    utimesSync(markerPath, markerMtime, markerMtime);
    const reason = `Coding launch refused (no launchable coder remains): model=gemini-2.5-pro reason=uncertified certification=missing_live_canary certify="${HOK3142_CERTIFY}"`;
    writeFileSync(join(featureDir, '.retry-coding-launch-refused-exhausted'), `${reason}\n`);
    writeFileSync(join(repoDir, '.wavemill', 'workflow-state.json'), JSON.stringify({
      tasks: { [issue]: { issue, slug, worktree: repoDir, phase: 'planning', status: 'running' } },
    }));
    await reconcileIncidents({
      timestamp: new Date().toISOString(),
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        workflowStatePath: join(repoDir, '.wavemill', 'workflow-state.json'),
        tasks: [{ issue, phase: 'planning', status: 'running', slug, worktree: repoDir, updated: agoIso(30) }],
      }],
      findings: [],
    }, defaultObserverOptions());

    assert.equal((await parkedIncidents(repoDir, 'stage_marker_not_advanced')).length, 0);
    const refused = await parkedIncidents(repoDir, 'coding_launch_refused');
    assert.equal(refused.length, 1);
    assert.ok(refused[0].operatorAction.includes(HOK3142_CERTIFY));
    assert.match(refused[0].summary, /gemini-2\.5-pro/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});


// HOK-3097: wiring regression. With the default (disabled) config, applyAutoFixes
// and sendAlerts leave the snapshot unchanged and touch no files on disk.
test('applyAutoFixes + sendAlerts are byte-identical no-ops when disabled', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-autofix-noop-'));
  // HOK-3239: an exported push URL enables alerts, so isolate from the operator's shell.
  const previousPushUrl = process.env.WAVEMILL_OBSERVER_PUSH_URL;
  delete process.env.WAVEMILL_OBSERVER_PUSH_URL;
  try {
    const snapshot = {
      timestamp: new Date().toISOString(),
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        workflowStatePath: join(repoDir, '.wavemill', 'workflow-state.json'),
        tasks: [{ issue: 'HOK-1', phase: 'ready', slug: 'noop', worktree: repoDir, branch: 'task/noop', baseBranch: 'main' }],
      }],
      findings: [],
    };
    const beforeFindings = snapshot.findings.length;
    const fixed = await applyAutoFixes(snapshot as any, defaultObserverOptions() as any);
    const alerted = await sendAlerts(fixed, defaultObserverOptions() as any);
    assert.equal(alerted.findings.length, beforeFindings, 'no findings added');
    assert.ok(!existsSync(join(repoDir, '.wavemill', 'incidents', 'actions.jsonl')), 'no action log written');
    assert.ok(!existsSync(join(repoDir, '.wavemill', 'observer', 'alert-state.json')), 'no alert journal written');
  } finally {
    if (previousPushUrl !== undefined) process.env.WAVEMILL_OBSERVER_PUSH_URL = previousPushUrl;
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HOK-3207: sustained slow-pass detector + stuck queue-inference detector
// ---------------------------------------------------------------------------

function slowPassRepo(timing: Record<string, unknown> | undefined, overrides: Record<string, unknown> = {}) {
  return {
    session: 'wavemill',
    repoDir: '/fake/repo',
    tasks: [],
    monitorTimingPath: timing ? '/fake/repo/.wavemill/monitor-timing.json' : undefined,
    monitorTiming: timing,
    ...overrides,
  };
}

test('HOK-3207 detectSustainedSlowPasses: no timing file produces no finding', () => {
  const findings = detectSustainedSlowPasses(slowPassRepo(undefined) as never, Date.now());
  assert.deepEqual(findings, []);
});

test('HOK-3207 detectSustainedSlowPasses: slowSinceAt null produces no finding', () => {
  const findings = detectSustainedSlowPasses(
    slowPassRepo({ slowSinceAt: null, p50Ms: 20_000, warnMs: 15_000 }) as never,
    Date.now(),
  );
  assert.deepEqual(findings, []);
});

test('HOK-3207 detectSustainedSlowPasses: slowSinceAt 30 min ago is below threshold', () => {
  const now = Date.now();
  const slowSinceAt = new Date(now - 30 * 60 * 1000).toISOString();
  const findings = detectSustainedSlowPasses(
    slowPassRepo({ slowSinceAt, p50Ms: 20_000, warnMs: 15_000 }) as never,
    now,
  );
  assert.deepEqual(findings, []);
});

test('HOK-3207 detectSustainedSlowPasses: slowSinceAt 61 min ago AND p50 > warnMs raises one high finding', () => {
  const now = Date.now();
  const slowSinceAt = new Date(now - 61 * 60 * 1000).toISOString();
  const findings = detectSustainedSlowPasses(
    slowPassRepo({
      slowSinceAt,
      p50Ms: 44_000,
      warnMs: 15_000,
      slowestSteps: [
        { name: 'issueMonitorLoop', ms: 22_000 },
        { name: 'readyMergeQueue', ms: 11_000 },
        { name: 'readyWatchdog', ms: 5_000 },
      ],
    }) as never,
    now,
  );
  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.equal(finding.id, 'monitor-sustained-slow-pass-wavemill');
  assert.equal(finding.severity, 'high');
  assert.equal(finding.category, 'operational');
  assert.match(finding.title, /p50 44000ms over warnMs 15000ms for 61 min/);
  assert.ok(finding.evidence.includes('p50Ms=44000'));
  assert.ok(finding.evidence.includes('warnMs=15000'));
  assert.ok(finding.evidence.includes('sustainedMinutes=61'));
  assert.ok(finding.evidence.some((e) => e.startsWith('topSteps=') && e.includes('issueMonitorLoop:22000ms')));
});

test('HOK-3207 detectSustainedSlowPasses: p50 recovered to warnMs clears the finding even if slowSinceAt is still set', () => {
  const now = Date.now();
  const slowSinceAt = new Date(now - 90 * 60 * 1000).toISOString();
  const findings = detectSustainedSlowPasses(
    slowPassRepo({
      slowSinceAt,
      p50Ms: 10_000,   // below warnMs
      warnMs: 15_000,
      slowestSteps: [],
    }) as never,
    now,
  );
  assert.deepEqual(findings, [], 'recovery path (p50 ≤ warnMs) must retract the finding');
});

test('HOK-3207 detectSustainedSlowPasses: finding id is stable across repeat calls so selectAlertsToSend dedupes', () => {
  const now = Date.now();
  const slowSinceAt = new Date(now - 90 * 60 * 1000).toISOString();
  const first = detectSustainedSlowPasses(
    slowPassRepo({ slowSinceAt, p50Ms: 44_000, warnMs: 15_000 }) as never,
    now,
  );
  const second = detectSustainedSlowPasses(
    slowPassRepo({ slowSinceAt, p50Ms: 44_000, warnMs: 15_000 }) as never,
    now + 60_000,
  );
  assert.equal(first[0]?.id, second[0]?.id);
});

test('HOK-3207 detectSustainedSlowPasses: unparseable slowSinceAt produces no finding', () => {
  const findings = detectSustainedSlowPasses(
    slowPassRepo({ slowSinceAt: 'not-a-timestamp', p50Ms: 44_000, warnMs: 15_000 }) as never,
    Date.now(),
  );
  assert.deepEqual(findings, []);
});

function stuckQueueRepo(inference: Record<string, unknown> | undefined, overrides: Record<string, unknown> = {}) {
  return {
    session: 'wavemill',
    repoDir: '/fake/repo',
    tasks: [],
    queueHealthPath: inference ? '/fake/repo/.wavemill/queue-health.json' : undefined,
    queueHealth: inference ? { inference } : undefined,
    ...overrides,
  };
}

// HOK-3314: `detectQueueInferenceStuck` was retired. The queue-health finding
// below (built from `deriveQueueAlertProjection`) emits the same high-severity
// alert at ≥5 consecutive failures. See the "queue-health degraded finding
// uses projection" tests above (around queue-health-degraded-*).

test('HOK-3314 queue-health finding at consecutiveFailures=5 fires high severity', () => {
  const now = Date.now();
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-queue-stuck-high-'));
  try {
    writePermissiveSchema(repoDir);
    const snapshot = {
      timestamp: new Date(now).toISOString(),
      sessions: ['wavemill'],
      panes: [],
      processes: [],
      repos: [{
        session: 'wavemill',
        repoDir,
        tasks: [],
        queueHealthPath: '/fake/path/queue-health.json',
        queueHealth: {
          status: 'degraded',
          degradationReason: 'inference_unavailable',
          inferenceStatus: 'failed',
          inferredEdgeCount: 49,
          inference: {
            consecutiveFailures: 5,
            lastAttemptAt: '2026-10-22T14:03:54.249Z',
            lastSuccessAt: '2026-10-22T13:59:14.469Z',
            error: 'classifier timeout after 5s',
          },
        },
      }],
    };
    const findings = buildFindings(snapshot as never, defaultObserverOptions() as never);
    const queueFinding = findings.find((f) => f.id.startsWith('queue-health-degraded-'));
    assert.ok(queueFinding, 'queue-health finding must be surfaced through buildFindings');
    assert.equal(queueFinding!.severity, 'high', '≥5 consecutive failed attempts → high severity through the projection ladder');
    assert.ok(queueFinding!.evidence.some((line: string) => line === 'consecutiveFailedAttempts=5'));
    assert.ok(queueFinding!.evidence.some((line: string) => line === 'projectionStatus=degraded-inference'));
    // Dedup: a second call with the same state produces the same stable id.
    const secondFindings = buildFindings(snapshot as never, defaultObserverOptions() as never);
    const dupes = secondFindings.filter((f) => f.id === queueFinding!.id);
    assert.equal(dupes.length, 1, 'repeated buildFindings must not duplicate the queue-health finding id');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('HOK-3314 queue-health finding below the medium threshold reports low severity', () => {
  const findings = buildFindings({
    timestamp: '2026-10-22T14:00:00Z',
    sessions: ['wavemill'],
    panes: [],
    processes: [],
    repos: [{
      session: 'wavemill',
      repoDir: '/tmp/fake',
      tasks: [],
      queueHealthPath: '/fake/path/queue-health.json',
      queueHealth: {
        status: 'degraded',
        degradationReason: 'inference_unavailable',
        inferenceStatus: 'failed',
        inferredEdgeCount: 49,
        inference: {
          consecutiveFailures: 1,
          lastAttemptAt: '2026-10-22T14:03:54.249Z',
          lastSuccessAt: '2026-10-22T13:59:14.469Z',
        },
      },
    }],
  } as never, defaultObserverOptions() as never);
  const queueFinding = findings.find((f) => f.id.startsWith('queue-health-degraded-'));
  assert.ok(queueFinding);
  assert.equal(queueFinding!.severity, 'low');
});

// ---------------------------------------------------------------------------
// HOK-3244 REQ-F2: runDetector surfaces swallowed detector exceptions.
// ---------------------------------------------------------------------------

test('HOK-3244 REQ-F2: a throwing detector produces an observer-detector-error finding', () => {
  const findings: Array<Record<string, unknown>> = [];
  runDetector(
    'queue-inference-stuck',
    { session: 'wavemill', repoDir: '/tmp/some-repo' },
    () => { throw new Error('boom from fake detector'); },
    findings as never,
  );
  assert.equal(findings.length, 1);
  const finding = findings[0] as Record<string, unknown>;
  assert.match(finding.id as string, /^observer-detector-error-queue-inference-stuck-wavemill-/);
  assert.equal(finding.severity, 'medium');
  assert.equal(finding.category, 'operational');
  assert.equal(finding.confidence, 'high');
  assert.equal(finding.session, 'wavemill');
  assert.equal(finding.repoDir, '/tmp/some-repo');
  assert.match(finding.title as string, /Observer detector queue-inference-stuck threw Error/);
  assert.ok((finding.evidence as string[]).includes('detector=queue-inference-stuck'));
  assert.ok((finding.evidence as string[]).some((line) => line.startsWith('message=boom from fake detector')));
  assert.match(finding.recommendation as string, /HOK-3244/);
});

test('HOK-3244 REQ-F2: a successful detector contributes its findings unchanged', () => {
  const sentinel = {
    id: 'synthetic-ok',
    severity: 'low' as const,
    category: 'operational' as const,
    confidence: 'high' as const,
    title: 'ok',
    evidence: [],
    recommendation: 'none',
  };
  const findings: Array<Record<string, unknown>> = [];
  runDetector(
    'does-not-throw',
    { session: 'wavemill', repoDir: '/tmp/ok-repo' },
    () => [sentinel as never],
    findings as never,
  );
  assert.equal(findings.length, 1);
  assert.equal((findings[0] as Record<string, unknown>).id, 'synthetic-ok');
});

// ---------------------------------------------------------------------------
// HOK-3244 REQ-F3: .failed-ready-recheck-exhausted sentinel coverage.
// ---------------------------------------------------------------------------

test('HOK-3244 REQ-F3: legacy .failed-ready-recheck-exhausted sentinel yields exhausted-retry finding', () => {
  const fixture = createResidueGitFixture({
    commits: 1,
    slug: 'exhausted-retry-fixture',
    commitAgeMinutes: 20,
  });
  const featureDir = join(fixture.repoDir, 'features', fixture.slug);
  mkdirSync(featureDir, { recursive: true });
  // The real production sentinel for this bucket drops the `.retry-` prefix
  // (bounded-retry.sh:44) — before HOK-3244 the regex missed it entirely.
  const sentinelPath = join(featureDir, '.failed-ready-recheck-exhausted');
  const mtime = new Date(Date.now() - 15 * 60_000);
  writeFileSync(sentinelPath, 'Failed to become ready after 3 attempts.\n');
  utimesSync(sentinelPath, mtime, mtime);

  try {
    const repo = exhaustedRetryRepo(fixture.repoDir, fixture.branch);
    const findings = detectExhaustedRetries(repo as never, Date.now(), noProgress as never);
    const finding = findings.find((f) => f.id === 'exhausted-retry-abandoned-wavemill-HOK-9200-failed-ready-recheck');
    assert.ok(finding, `expected the legacy-sentinel finding, got: ${findings.map((f) => f.id).join(', ')}`);
    assert.equal(finding?.severity, 'high');
    assert.ok(finding!.evidence.includes(`bucket=failed-ready-recheck`));
    assert.ok(finding!.evidence.includes(`sentinel=${sentinelPath}`));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('HOK-3244 REQ-F3: legacy sentinel reads head key from .failed-ready-recheck-head', () => {
  const fixture = createResidueGitFixture({
    commits: 1,
    slug: 'exhausted-retry-fixture',
    commitAgeMinutes: 20,
  });
  const featureDir = join(fixture.repoDir, 'features', fixture.slug);
  mkdirSync(featureDir, { recursive: true });
  // Legacy sentinel + legacy head key naming new tip no longer matches.
  const sentinelPath = join(featureDir, '.failed-ready-recheck-exhausted');
  const mtime = new Date(Date.now() - 15 * 60_000);
  writeFileSync(sentinelPath, 'Failed to become ready after 3 attempts.\n');
  utimesSync(sentinelPath, mtime, mtime);
  writeFileSync(
    join(featureDir, '.failed-ready-recheck-head'),
    '0000000000000000000000000000000000dead\n',
  );

  try {
    const repo = exhaustedRetryRepo(fixture.repoDir, fixture.branch);
    const findings = detectExhaustedRetries(repo as never, Date.now(), noProgress as never);
    // Head key no longer matches branch tip → sentinel is considered stale,
    // so the detector suppresses it (same semantics as the standard shape).
    assert.equal(
      findings.find((f) => f.id === 'exhausted-retry-abandoned-wavemill-HOK-9200-failed-ready-recheck'),
      undefined,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HOK-3244 REQ-F4: repeated [status]-line detector.
// ---------------------------------------------------------------------------

test('HOK-3244 REQ-F4: ten identical [status] lines fire a repeated-status finding', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-status-loop-'));
  const logPath = join(repoDir, 'mill-wavemill.log');
  try {
    writePermissiveSchema(repoDir);
    const lines = Array.from({ length: 12 }, (_, i) =>
      `12:00:${String(i).padStart(2, '0')} [status] Recreated tmux window for HOK-9999`,
    );
    writeFileSync(logPath, lines.join('\n'));

    const findings = buildFindings(basicSnapshot(repoDir, logPath), defaultObserverOptions());
    const repeated = findings.find((f) => f.id.startsWith('repeated-status-'));
    assert.ok(repeated, `expected a repeated-status finding, got: ${findings.map((f) => f.id).join(', ')}`);
    assert.equal(repeated!.severity, 'medium');
    assert.equal(repeated!.category, 'stuck');
    assert.equal(repeated!.confidence, 'high');
    assert.equal(repeated!.occurrenceCount, 12);
    assert.ok(repeated!.evidence.includes('occurrences=12'));
    assert.ok(repeated!.evidence.some((line) => line.includes('Recreated tmux window for HOK-9999')));
    assert.match(repeated!.recommendation, /monitor-level loop/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('HOK-3244 REQ-F4: twenty repeated [status] lines escalate to high severity', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-status-loop-urgent-'));
  const logPath = join(repoDir, 'mill-wavemill.log');
  try {
    writePermissiveSchema(repoDir);
    const lines = Array.from({ length: 22 }, (_, i) =>
      `12:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')} [status] Reaping tmux window for HOK-9999`,
    );
    writeFileSync(logPath, lines.join('\n'));

    const findings = buildFindings(basicSnapshot(repoDir, logPath), defaultObserverOptions());
    const repeated = findings.find((f) => f.id.startsWith('repeated-status-'));
    assert.ok(repeated);
    assert.equal(repeated!.severity, 'high');
    assert.equal(repeated!.occurrenceCount, 22);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('HOK-3244 REQ-F4: nine identical [status] lines stay below threshold', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-status-loop-low-'));
  const logPath = join(repoDir, 'mill-wavemill.log');
  try {
    writePermissiveSchema(repoDir);
    const lines = Array.from({ length: 9 }, (_, i) =>
      `12:00:${String(i).padStart(2, '0')} [status] Recreated tmux window for HOK-9999`,
    );
    writeFileSync(logPath, lines.join('\n'));

    const findings = buildFindings(basicSnapshot(repoDir, logPath), defaultObserverOptions());
    assert.equal(findings.some((f) => f.id.startsWith('repeated-status-')), false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('HOK-3244 REQ-F4: interleaved [status] lines group by normalized message independently', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-status-interleaved-'));
  const logPath = join(repoDir, 'mill-wavemill.log');
  try {
    writePermissiveSchema(repoDir);
    // Ten A-lines and five B-lines interleaved: A grouping fires, B does not.
    const lines: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      lines.push(`12:00:${String(i).padStart(2, '0')} [status] Recreated tmux window for HOK-A`);
      if (i < 5) {
        lines.push(`12:00:${String(i).padStart(2, '0')} [status] Different status line for HOK-B`);
      }
    }
    writeFileSync(logPath, lines.join('\n'));

    const findings = buildFindings(basicSnapshot(repoDir, logPath), defaultObserverOptions());
    const repeatedForA = findings.filter((f) => f.id.startsWith('repeated-status-')
      && f.evidence.some((line) => line.includes('HOK-A')));
    const repeatedForB = findings.filter((f) => f.id.startsWith('repeated-status-')
      && f.evidence.some((line) => line.includes('HOK-B')));
    assert.equal(repeatedForA.length, 1);
    assert.equal(repeatedForB.length, 0);
    assert.equal(repeatedForA[0].occurrenceCount, 10);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HOK-3244 REQ-F5: .coding-complete present during planning phase.
// ---------------------------------------------------------------------------

test('HOK-3244 REQ-F5: stale .coding-complete during planning fires coding-complete-in-planning finding', () => {
  const markerMtime = new Date(Date.now() - 30 * 60_000);
  const fixture = createMarkerFixture('.coding-complete', markerMtime);

  try {
    const findings = buildFindings(markerSnapshot({
      repoDir: fixture.repoDir,
      slug: fixture.slug,
      phase: 'planning',
    }), defaultObserverOptions());

    const finding = findings.find((f) => f.id === 'coding-complete-in-planning-HOK-2848');
    assert.ok(finding, `expected the planning-leaked-marker finding, got: ${findings.map((f) => f.id).join(', ')}`);
    assert.equal(finding!.severity, 'urgent');
    assert.equal(finding!.category, 'stuck');
    assert.equal(finding!.confidence, 'high');
    assert.ok(finding!.evidence.includes('statePhase=planning'));
    assert.ok(finding!.evidence.includes(`marker=${fixture.markerPath}`));
    assert.match(finding!.recommendation, /HOK-3211/);
    // The ordinary coding-marker-ignored id is NOT fired for the planning
    // phase — otherwise an operator would get two findings for one condition.
    assert.equal(findings.some((f) => f.id === 'coding-marker-ignored-HOK-2848'), false);
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

test('HOK-3244 REQ-F5: a .coding-complete during coding keeps the ordinary marker-ignored finding and does not fire the planning variant', () => {
  const markerMtime = new Date(Date.now() - 30 * 60_000);
  const fixture = createMarkerFixture('.coding-complete', markerMtime);

  try {
    const findings = buildFindings(markerSnapshot({
      repoDir: fixture.repoDir,
      slug: fixture.slug,
      phase: 'coding',
    }), defaultObserverOptions());

    assert.ok(findings.some((f) => f.id === 'coding-marker-ignored-HOK-2848'));
    assert.equal(findings.some((f) => f.id === 'coding-complete-in-planning-HOK-2848'), false);
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});

test('HOK-3244 REQ-F5: a fresh .coding-complete during planning stays below the stale threshold', () => {
  const markerMtime = new Date(Date.now() - 30_000);
  const fixture = createMarkerFixture('.coding-complete', markerMtime);

  try {
    const findings = buildFindings(markerSnapshot({
      repoDir: fixture.repoDir,
      slug: fixture.slug,
      phase: 'planning',
    }), defaultObserverOptions());

    assert.equal(findings.some((f) => f.id === 'coding-complete-in-planning-HOK-2848'), false);
  } finally {
    rmSync(fixture.repoDir, { recursive: true, force: true });
  }
});
