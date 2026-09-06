import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFindings, compactSnapshotForRender, parseArgs, redactObserverText, syncIncidentsToLinear, writeServiceHeartbeat } from './observer.ts';
import { IncidentStore } from '../shared/lib/wavemill-incident-store.ts';
import { createIncidentDraft } from '../shared/lib/wavemill-incident-model.ts';

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

    const result = spawnSync('npx', ['tsx', join(process.cwd(), 'tools', 'observer.ts'), '--once', '--json', '--repo-dir', repoDir], {
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
    assert.ok(degraded.evidence.includes('failureCount=3'));
    assert.ok(degraded.evidence.includes('stderr=plan_queue_failed exit 143'));
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

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

function createResidueGitFixture({
  commits = 2,
  pushTaskBranch = false,
  slug = 'residue-fixture',
}: { commits?: number; pushTaskBranch?: boolean; slug?: string } = {}) {
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
  runGit(repoDir, ['commit', '-m', 'base commit']);
  runGit(repoDir, ['remote', 'add', 'origin', originDir]);
  runGit(repoDir, ['push', '-u', 'origin', 'auto/integration']);
  const branch = `task/${slug}`;
  runGit(repoDir, ['checkout', '-b', branch]);
  for (let i = 1; i <= commits; i += 1) {
    writeFileSync(join(repoDir, `work-${i}.txt`), `work ${i}\n`);
    runGit(repoDir, ['add', '.']);
    runGit(repoDir, ['commit', '-m', `task commit ${i}`]);
  }
  if (pushTaskBranch) {
    runGit(repoDir, ['push', '-u', 'origin', branch]);
  }
  runGit(repoDir, ['checkout', 'auto/integration']);
  writePermissiveSchema(repoDir);
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

    const parked = findings.find((finding) => finding.id === 'terminal-task-parked-wavemill-HOK-2845');
    assert.ok(parked);
    assert.equal(parked.severity, 'medium');
    assert.equal(parked.category, 'operational');
    assert.equal(parked.issue, 'HOK-2845');
    assert.match(parked.title, /terminal task parked for 30m with allocated residue/);
    assert.ok(parked.evidence.includes('status=closed'));
    assert.ok(parked.evidence.includes('tmuxWindow=absent'));
    assert.ok(parked.evidence.includes(`worktree=present:${fixture.repoDir}`));
    assert.ok(parked.evidence.includes(`branch=${fixture.branch} localBranch=present`));
    assert.ok(parked.evidence.includes('baseBranch=auto/integration'));
    assert.ok(parked.evidence.includes('aheadOfBase=0'));
    assert.ok(parked.evidence.includes('unpushedCommits=0'));
    assert.ok(parked.evidence.includes('pr=none'));
    assert.equal(parked.evidence.some((line) => line === 'potentialWorkLoss=true'), false);
    assert.match(parked.recommendation, /Nothing on the branch is at risk/);
    assert.match(parked.recommendation, /wavemill mill abort HOK-2845/);
    assert.match(parked.recommendation, /never remove the worktree manually/);

    assert.equal(findings.some((finding) => finding.id.startsWith('arm-died-with-unpushed-work-')), false);
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
      const parked = findings.find((finding) => finding.id === `terminal-task-parked-wavemill-${issue}`);
      assert.ok(parked, `expected terminal parked finding for ${issue}`);
      assert.ok(parked.evidence.includes('resourceDisposition=verification-required'));
      assert.ok(parked.evidence.includes('branchDeletionAuthorized=false'));
    }
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
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

    const parked = findings.find((finding) => finding.id === 'terminal-task-parked-wavemill-HOK-2866');
    assert.ok(parked);
    assert.equal(parked.severity, 'urgent');
    assert.match(parked.title, /parked for 90m with 2 unpushed commits at risk/);
    assert.ok(parked.evidence.includes('remoteBranch=absent'));
    assert.ok(parked.evidence.includes('unpushedCommits=2'));
    assert.ok(parked.evidence.includes('potentialWorkLoss=true'));
    assert.ok(parked.evidence.includes('commit=task commit 2'));
    assert.ok(parked.evidence.some((line) => /^pr=#1217 state=/.test(line)));
    assert.match(parked.recommendation, /Recover the work first: push task\/lossy-terminal/);
    assert.match(parked.recommendation, /wavemill mill abort HOK-2866/);

    const died = findings.find((finding) => finding.id === 'arm-died-with-unpushed-work-wavemill-HOK-2866');
    assert.ok(died);
    assert.equal(died.severity, 'urgent');
    assert.equal(died.category, 'crash');
    assert.match(died.title, /exited with 2 unpushed commits on task\/lossy-terminal/);
    assert.ok(died.evidence.includes('commitsAheadOfBase=2'));
    assert.ok(died.evidence.includes('remoteBranch=absent'));
    assert.ok(died.evidence.includes('commit=task commit 1'));
    assert.ok(died.evidence.includes('commit=task commit 2'));
    assert.ok(died.evidence.includes('liveExecutionEvidence=false'));
    assert.match(died.recommendation, /Push task\/lossy-terminal to origin and open a PR against auto\/integration/);
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

test('terminal-task-parked severity scales with parked age', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'observer-terminal-severity-'));
  try {
    writePermissiveSchema(repoDir);
    const severityFor = (minutes: number) => {
      const findings = buildFindings(residueSnapshot(repoDir, [{
        issue: 'HOK-2845',
        phase: 'closed',
        status: 'closed',
        worktree: repoDir,
        updated: agoIso(minutes),
      }]), defaultObserverOptions());
      const parked = findings.find((finding) => finding.id === 'terminal-task-parked-wavemill-HOK-2845');
      assert.ok(parked, `expected terminal-task-parked at age ${minutes}m`);
      return parked.severity;
    };

    assert.equal(severityFor(30), 'medium');
    assert.equal(severityFor(120), 'high');
    assert.equal(severityFor(25 * 60), 'urgent');
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

    assert.ok(findings.some((finding) => finding.id === 'terminal-task-parked-wavemill-HOK-2866'));
    assert.ok(findings.some((finding) => finding.id === 'terminal-task-parked-wavemill-HOK-2867'));
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

    const parked = findings.find((finding) => finding.id === 'terminal-task-parked-wavemill-HOK-2845');
    assert.ok(parked);
    assert.ok(parked.evidence.includes('tmuxWindow=present(exited) targets=wavemill:1.0'));
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
