/**
 * Execution-economics corpus-quality report (HOK-2958).
 *
 * Reads the local eval corpus and summarizes the normalized
 * `executionEconomics` blocks: coverage by harness × harness version,
 * unknown models, unjoinable records (unattributed stage role or route
 * conflict), and unavailable field classes. Informational only — the
 * report is not a gate.
 *
 * @module execution-economics-report
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readEvalRecordsFromFile } from './eval-persistence.ts';
import { resolveEvalsDir } from './evals-paths.ts';
import { getEffectiveRegistry, resolveModelRegistryKey } from './model-registry.ts';
import type {
  EvalExecutionEconomics,
  ExecutionEconomicsSession,
  WorkflowCostAttributionCoverage,
} from './eval-schema.ts';

export interface ExecutionEconomicsHarnessVersionSummary {
  harness: string;
  harnessVersion: string;
  records: number;
  sessions: number;
  turns: number;
  coverage: Record<WorkflowCostAttributionCoverage, number>;
}

export interface ExecutionEconomicsReport {
  evalsPath: string;
  totalEvalRecords: number;
  recordsWithEconomics: number;
  blocks: number;
  sessions: number;
  turns: number;
  byHarnessVersion: ExecutionEconomicsHarnessVersionSummary[];
  /** Executed models not resolvable against the model registry. */
  unknownModels: string[];
  /** Sessions with no stage attribution (join failed or ambiguous). */
  unjoinableSessions: number;
  /** Sessions where route intent and executed telemetry disagree. */
  conflictSessions: number;
  /** Count of unavailable occurrences per field class across sessions. */
  unavailableFieldClasses: Record<string, number>;
  status: 'ok' | 'no_records';
}

export interface BuildExecutionEconomicsReportOptions {
  repoDir?: string;
  /** Explicit evals.jsonl path; overrides repo resolution. */
  evalsPath?: string;
}

function emptyCoverage(): Record<WorkflowCostAttributionCoverage, number> {
  return { complete: 0, partial: 0, unavailable: 0, known_zero: 0 };
}

function sessionCoverageKey(session: ExecutionEconomicsSession): WorkflowCostAttributionCoverage {
  return session.coverage;
}

export function buildExecutionEconomicsReport(
  options: BuildExecutionEconomicsReportOptions = {},
): ExecutionEconomicsReport {
  const evalsPath = options.evalsPath
    ?? join(resolveEvalsDir(undefined, options.repoDir).dir, 'evals.jsonl');
  const records = existsSync(evalsPath) ? readEvalRecordsFromFile(evalsPath) : [];
  const registry = getEffectiveRegistry(options.repoDir);

  const byVersion = new Map<string, ExecutionEconomicsHarnessVersionSummary>();
  const unknownModels = new Set<string>();
  const unavailableFieldClasses: Record<string, number> = {};
  let recordsWithEconomics = 0;
  let blocks = 0;
  let sessions = 0;
  let turns = 0;
  let unjoinableSessions = 0;
  let conflictSessions = 0;

  for (const record of records) {
    const economics = record.executionEconomics;
    if (!Array.isArray(economics) || economics.length === 0) continue;
    recordsWithEconomics++;

    for (const block of economics as EvalExecutionEconomics[]) {
      blocks++;
      for (const session of block.sessions) {
        sessions++;
        turns += session.turnCount;

        const versionKey = `${block.harness}\0${session.harnessVersion ?? 'unknown'}`;
        let summary = byVersion.get(versionKey);
        if (!summary) {
          summary = {
            harness: block.harness,
            harnessVersion: session.harnessVersion ?? 'unknown',
            records: 0,
            sessions: 0,
            turns: 0,
            coverage: emptyCoverage(),
          };
          byVersion.set(versionKey, summary);
        }
        summary.sessions++;
        summary.turns += session.turnCount;
        summary.coverage[sessionCoverageKey(session)]++;

        if (session.stageRole.value === null) {
          unjoinableSessions++;
        }
        if (session.models.conflict) {
          conflictSessions++;
        }

        for (const segment of session.modelSegments) {
          const key = resolveModelRegistryKey(registry, segment.model);
          if (!registry.models[key]) {
            unknownModels.add(segment.model);
          }
        }

        for (const [field, availability] of Object.entries(session.fieldAvailability)) {
          if (availability === 'unavailable') {
            unavailableFieldClasses[field] = (unavailableFieldClasses[field] ?? 0) + 1;
          }
        }
      }
      // Count the record once per harness/version pair it contributed to.
      const seenVersions = new Set(
        block.sessions.map((session) => `${block.harness}\0${session.harnessVersion ?? 'unknown'}`),
      );
      for (const key of seenVersions) {
        const summary = byVersion.get(key);
        if (summary) summary.records++;
      }
    }
  }

  return {
    evalsPath,
    totalEvalRecords: records.length,
    recordsWithEconomics,
    blocks,
    sessions,
    turns,
    byHarnessVersion: [...byVersion.values()].sort((a, b) =>
      a.harness === b.harness
        ? a.harnessVersion.localeCompare(b.harnessVersion)
        : a.harness.localeCompare(b.harness)),
    unknownModels: [...unknownModels].sort(),
    unjoinableSessions,
    conflictSessions,
    unavailableFieldClasses,
    status: recordsWithEconomics > 0 ? 'ok' : 'no_records',
  };
}

export function renderExecutionEconomicsReport(report: ExecutionEconomicsReport): string {
  const lines: string[] = [];
  lines.push('Execution Economics Corpus Report (HOK-2958)');
  lines.push(`  Corpus: ${report.evalsPath}`);
  lines.push(`  Eval records: ${report.totalEvalRecords} (${report.recordsWithEconomics} with execution economics)`);
  lines.push(`  Blocks: ${report.blocks}  Sessions: ${report.sessions}  Turns: ${report.turns}`);
  lines.push('');

  if (report.status === 'no_records') {
    lines.push('  No execution-economics records found.');
    return lines.join('\n');
  }

  lines.push('  Coverage by harness / version:');
  for (const summary of report.byHarnessVersion) {
    const coverage = Object.entries(summary.coverage)
      .filter(([, count]) => count > 0)
      .map(([key, count]) => `${key}=${count}`)
      .join(', ') || 'none';
    lines.push(
      `    ${summary.harness}@${summary.harnessVersion}: ${summary.records} record(s), `
      + `${summary.sessions} session(s), ${summary.turns} turn(s) — ${coverage}`,
    );
  }

  lines.push('');
  lines.push(`  Unjoinable sessions (no stage attribution): ${report.unjoinableSessions}`);
  lines.push(`  Route/executed conflicts: ${report.conflictSessions}`);
  lines.push(
    report.unknownModels.length > 0
      ? `  Unknown models (not in registry): ${report.unknownModels.join(', ')}`
      : '  Unknown models (not in registry): none',
  );

  const unavailable = Object.entries(report.unavailableFieldClasses)
    .sort(([a], [b]) => a.localeCompare(b));
  lines.push('  Unavailable field classes:');
  if (unavailable.length === 0) {
    lines.push('    none');
  } else {
    for (const [field, count] of unavailable) {
      lines.push(`    ${field}: ${count} session(s)`);
    }
  }

  return lines.join('\n');
}
