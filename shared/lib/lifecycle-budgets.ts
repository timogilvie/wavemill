/**
 * Lifecycle certification budgets (HOK-2957).
 *
 * Validates per-scenario evidence in certification-report.json against
 * hard budgets encoded here (or overridden via env), plus monitor timing
 * (STATE_DIR/monitor-timing.json) against the "monitor p95 idle iteration
 * stays below pollSeconds" packet criterion.
 *
 * Budgets returned as data (not thrown exceptions) so the caller can print
 * a full audit report and upload it as a CI artifact.
 */

import { existsSync, readFileSync } from 'node:fs';

export interface ScenarioRecord {
  id?: string;
  mergeMethod?: string;
  flags?: Record<string, unknown>;
  fault?: string | null;
  iterationMs?: number;
  paneAgeTicks?: number;
  paneReleaseExpected?: boolean;
  cleanupAttemptsBeforeNextRetry?: number;
  branchDeletionCount?: number;
  branchDeletionAuthorized?: boolean;
  finalHeadMatches?: boolean;
  slotAccountingConsistent?: boolean;
  agreement?: boolean;
  shadowMode?: string;
  [key: string]: unknown;
}

export interface CertificationReport {
  runId?: string;
  scenarios: ScenarioRecord[];
  meta?: Record<string, unknown>;
}

export interface MonitorTiming {
  lastIterationMs?: number;
  samples?: number[];
  p95Ms?: number;
  pollSeconds?: number;
  cleanupSkippedCount?: number;
  remoteCallAvoidedCount?: number;
  updatedAt?: string;
}

export interface BudgetOptions {
  paneAgeTickLimit?: number;      // default 1
  tickBudgetMs?: number;          // default 10_000
  timingToleranceMultiplier?: number; // default 1.0
}

export interface BudgetViolation {
  scenario?: string;
  budget: string;
  detail: string;
}

export interface BudgetVerdict {
  passed: boolean;
  violations: BudgetViolation[];
  scenariosChecked: number;
  monitorP95Ms?: number;
  monitorPollMs?: number;
}

export function defaultBudgetOptions(): Required<BudgetOptions> {
  const multiplier = Number(process.env.WAVEMILL_CERT_TIMING_TOLERANCE_MULTIPLIER ?? '1') || 1;
  return {
    paneAgeTickLimit: 1,
    tickBudgetMs: 10_000,
    timingToleranceMultiplier: multiplier,
  };
}

export function checkCertificationBudgets(
  report: CertificationReport,
  timing: MonitorTiming | null,
  options: BudgetOptions = {},
): BudgetVerdict {
  const cfg = { ...defaultBudgetOptions(), ...options };
  const violations: BudgetViolation[] = [];

  for (const scenario of report.scenarios ?? []) {
    const label = scenario.id ?? '<unnamed>';

    if (typeof scenario.iterationMs === 'number') {
      const budget = cfg.tickBudgetMs * cfg.timingToleranceMultiplier;
      if (scenario.iterationMs > budget) {
        violations.push({
          scenario: label,
          budget: 'iteration_ms',
          detail: `${scenario.iterationMs}ms > ${budget}ms tick budget`,
        });
      }
    }

    if (scenario.paneReleaseExpected && typeof scenario.paneAgeTicks === 'number') {
      if (scenario.paneAgeTicks > cfg.paneAgeTickLimit) {
        violations.push({
          scenario: label,
          budget: 'pane_age',
          detail: `pane still alive ${scenario.paneAgeTicks} ticks after terminal reason (limit ${cfg.paneAgeTickLimit})`,
        });
      }
    }

    if (typeof scenario.cleanupAttemptsBeforeNextRetry === 'number'
      && scenario.cleanupAttemptsBeforeNextRetry > 0) {
      violations.push({
        scenario: label,
        budget: 'cleanup_dedup',
        detail: `${scenario.cleanupAttemptsBeforeNextRetry} cleanup attempt(s) before nextRetryAt`,
      });
    }

    if ((scenario.branchDeletionCount ?? 0) > 0) {
      if (scenario.branchDeletionAuthorized !== true) {
        violations.push({
          scenario: label,
          budget: 'deletion_authority',
          detail: 'branch deleted without recorded authority',
        });
      }
      if (scenario.finalHeadMatches === false) {
        violations.push({
          scenario: label,
          budget: 'deletion_final_head',
          detail: 'branch deleted with final head mismatch',
        });
      }
      if (scenario.shadowMode && scenario.shadowMode !== 'enforce') {
        violations.push({
          scenario: label,
          budget: 'deletion_shadow_mode',
          detail: `branch deleted while branchDeletion.mode=${scenario.shadowMode}`,
        });
      }
    }

    if (scenario.slotAccountingConsistent === false) {
      violations.push({
        scenario: label,
        budget: 'slot_accounting',
        detail: 'slot accounting disagrees with lifecycle dispositions',
      });
    }

    if (scenario.agreement === false) {
      violations.push({
        scenario: label,
        budget: 'agreement',
        detail: 'controller / observer / dashboard disagreement',
      });
    }
  }

  let monitorP95Ms: number | undefined;
  let monitorPollMs: number | undefined;
  if (timing) {
    monitorP95Ms = typeof timing.p95Ms === 'number' ? timing.p95Ms : undefined;
    monitorPollMs = typeof timing.pollSeconds === 'number' ? timing.pollSeconds * 1000 : undefined;
    if (monitorP95Ms !== undefined && monitorPollMs !== undefined) {
      const budget = monitorPollMs * cfg.timingToleranceMultiplier;
      if (monitorP95Ms >= budget) {
        violations.push({
          budget: 'monitor_p95',
          detail: `monitor p95 iteration ${monitorP95Ms}ms >= pollSeconds*1000 = ${budget}ms`,
        });
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    scenariosChecked: (report.scenarios ?? []).length,
    monitorP95Ms,
    monitorPollMs,
  };
}

export function loadCertificationReport(path: string): CertificationReport {
  if (!existsSync(path)) throw new Error(`certification report not found: ${path}`);
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.scenarios)) {
    throw new Error(`certification report ${path} missing .scenarios[]`);
  }
  return parsed as CertificationReport;
}

export function loadMonitorTiming(path: string): MonitorTiming | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as MonitorTiming;
  } catch {
    return null;
  }
}

export function formatVerdict(verdict: BudgetVerdict): string {
  const lines: string[] = [];
  lines.push('=== Lifecycle Certification Budgets ===');
  lines.push(`Scenarios checked : ${verdict.scenariosChecked}`);
  if (verdict.monitorP95Ms !== undefined) {
    lines.push(`Monitor p95 (ms)  : ${verdict.monitorP95Ms} / pollBudget ${verdict.monitorPollMs ?? '?'} ms`);
  }
  lines.push(`Verdict           : ${verdict.passed ? 'PASS' : 'FAIL'}`);
  if (verdict.violations.length > 0) {
    lines.push('');
    lines.push('Violations:');
    for (const v of verdict.violations) {
      const prefix = v.scenario ? `  [${v.scenario}] ` : '  ';
      lines.push(`${prefix}${v.budget}: ${v.detail}`);
    }
  }
  return lines.join('\n');
}
