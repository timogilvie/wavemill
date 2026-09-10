/**
 * Multi-hour soak report generator (HOK-2957 Phase 6).
 *
 * Consumes durable state written during a live session:
 *   - STATE_DIR/monitor-timing.json  (per-iteration p95 samples)
 *   - workflow-state.json cleanup episodes (lifecycle.cleanupEpisode[])
 *   - .wavemill/shadow/cleanup-decisions.jsonl (shadow ledger)
 *   - .wavemill/incidents/preserved-branches/*.json (retained work markers)
 *
 * Emits a soak verdict against the packet's success criteria:
 *   * monitor p95 idle iteration < pollSeconds
 *   * zero terminal resource leaks (retained-work count / repeated episodes)
 *   * no unsafe shadow disagreements
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadMonitorTiming } from './lifecycle-budgets.ts';
import { auditShadowLedger } from './shadow-cleanup-audit.ts';

export interface CleanupEpisode {
  attemptCount?: number;
  fingerprint?: string;
  disposition?: string;
  failureClass?: string;
  outcome?: string;
  nextRetryAt?: string;
  lastAttemptAt?: string;
}

export interface SoakReport {
  windowStart?: string;
  windowEnd: string;
  monitor: {
    p95Ms?: number;
    pollSeconds?: number;
    samples?: number;
    withinBudget?: boolean;
  };
  cleanup: {
    totalEpisodes: number;
    repeatedEpisodes: number;
    exhaustedEpisodes: number;
    retainedBranchCount: number;
  };
  shadow: {
    totalEntries: number;
    proposedDeletes: number;
    disagreements: number;
    agreementRate: number;
    ready: boolean;
  };
  pass: boolean;
  failures: string[];
}

function readWorkflowStateEpisodes(workflowStatePath: string): CleanupEpisode[] {
  if (!existsSync(workflowStatePath)) return [];
  try {
    const raw = readFileSync(workflowStatePath, 'utf-8');
    const state = JSON.parse(raw) as { tasks?: Record<string, unknown> };
    const tasks = state.tasks || {};
    const episodes: CleanupEpisode[] = [];
    for (const value of Object.values(tasks)) {
      const lifecycle = (value as { lifecycle?: { cleanupEpisode?: CleanupEpisode | CleanupEpisode[] } }).lifecycle;
      if (!lifecycle?.cleanupEpisode) continue;
      const list = Array.isArray(lifecycle.cleanupEpisode) ? lifecycle.cleanupEpisode : [lifecycle.cleanupEpisode];
      for (const ep of list) {
        if (ep) episodes.push(ep);
      }
    }
    return episodes;
  } catch {
    return [];
  }
}

function countPreservedBranches(repoDir: string): number {
  const dir = join(repoDir, '.wavemill', 'incidents', 'preserved-branches');
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

export interface SoakOptions {
  repoDir: string;
  stateDir?: string;             // defaults to $repoDir/.wavemill
  workflowStatePath?: string;    // defaults to $stateDir/workflow-state.json
  maxRepeatedAttempts?: number;  // default 3 — an episode with attemptCount > this is a repeat leak
}

export function generateSoakReport(options: SoakOptions): SoakReport {
  const stateDir = options.stateDir || join(options.repoDir, '.wavemill');
  const workflowStatePath = options.workflowStatePath || join(stateDir, 'workflow-state.json');
  const monitorTimingPath = join(stateDir, 'monitor-timing.json');
  const timing = loadMonitorTiming(monitorTimingPath);
  const episodes = readWorkflowStateEpisodes(workflowStatePath);
  const shadow = auditShadowLedger(options.repoDir);
  const preservedCount = countPreservedBranches(options.repoDir);
  const repeatedThreshold = options.maxRepeatedAttempts ?? 3;

  const failures: string[] = [];
  const monitorPollMs = typeof timing?.pollSeconds === 'number' ? timing.pollSeconds * 1000 : undefined;
  const withinBudget =
    timing && typeof timing.p95Ms === 'number' && monitorPollMs !== undefined
      ? timing.p95Ms < monitorPollMs
      : undefined;
  if (withinBudget === false) {
    failures.push(`monitor p95 ${timing?.p95Ms}ms >= pollSeconds*1000 = ${monitorPollMs}ms`);
  }

  const repeated = episodes.filter((ep) => (ep.attemptCount ?? 0) > repeatedThreshold).length;
  if (repeated > 0) failures.push(`${repeated} cleanup episode(s) exceeded ${repeatedThreshold} attempts`);
  const exhausted = episodes.filter((ep) => (ep.outcome ?? '').includes('exhausted')).length;
  if (exhausted > 0) failures.push(`${exhausted} cleanup episode(s) reached the terminal exhaustion state`);
  if (preservedCount > 0) failures.push(`${preservedCount} preserved-branch marker(s) remain — retained work exists`);
  if (shadow.disagreements.length > 0) failures.push(`${shadow.disagreements.length} shadow ledger disagreement(s)`);

  const windowEnd = new Date().toISOString();
  let windowStart: string | undefined;
  if (existsSync(monitorTimingPath)) {
    try {
      windowStart = new Date(statSync(monitorTimingPath).mtimeMs - 3600_000).toISOString();
    } catch {
      // ignore
    }
  }

  return {
    windowStart,
    windowEnd,
    monitor: {
      p95Ms: timing?.p95Ms,
      pollSeconds: timing?.pollSeconds,
      samples: Array.isArray(timing?.samples) ? timing?.samples.length : 0,
      withinBudget,
    },
    cleanup: {
      totalEpisodes: episodes.length,
      repeatedEpisodes: repeated,
      exhaustedEpisodes: exhausted,
      retainedBranchCount: preservedCount,
    },
    shadow: {
      totalEntries: shadow.totalEntries,
      proposedDeletes: shadow.proposedDeletes,
      disagreements: shadow.disagreements.length,
      agreementRate: shadow.agreementRate,
      ready: shadow.ready,
    },
    pass: failures.length === 0,
    failures,
  };
}

export function formatSoakReport(report: SoakReport): string {
  const lines: string[] = [];
  lines.push('=== Wavemill Lifecycle Soak Report ===');
  lines.push(`Window end          : ${report.windowEnd}`);
  if (report.windowStart) lines.push(`Window start (est.) : ${report.windowStart}`);
  lines.push('');
  lines.push('Monitor');
  lines.push(`  p95 iteration ms  : ${report.monitor.p95Ms ?? '?'}`);
  lines.push(`  pollSeconds       : ${report.monitor.pollSeconds ?? '?'}`);
  lines.push(`  samples           : ${report.monitor.samples ?? 0}`);
  lines.push(`  within budget     : ${report.monitor.withinBudget ?? 'unknown'}`);
  lines.push('');
  lines.push('Cleanup episodes');
  lines.push(`  total             : ${report.cleanup.totalEpisodes}`);
  lines.push(`  repeated          : ${report.cleanup.repeatedEpisodes}`);
  lines.push(`  exhausted         : ${report.cleanup.exhaustedEpisodes}`);
  lines.push(`  retained branches : ${report.cleanup.retainedBranchCount}`);
  lines.push('');
  lines.push('Shadow ledger');
  lines.push(`  total entries     : ${report.shadow.totalEntries}`);
  lines.push(`  proposed deletes  : ${report.shadow.proposedDeletes}`);
  lines.push(`  disagreements     : ${report.shadow.disagreements}`);
  lines.push(`  agreement rate    : ${(report.shadow.agreementRate * 100).toFixed(1)}%`);
  lines.push(`  ready for enforce : ${report.shadow.ready ? 'YES' : 'NO'}`);
  lines.push('');
  lines.push(`Verdict             : ${report.pass ? 'PASS' : 'FAIL'}`);
  if (report.failures.length > 0) {
    lines.push('Failures:');
    for (const f of report.failures) lines.push(`  - ${f}`);
  }
  return lines.join('\n');
}
