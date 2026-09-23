/**
 * Tool-decision corpus-quality report (HOK-2076).
 *
 * Reads projected decision rows and flags missing policy/provider
 * menus, unknown models/tools, absent propensity, and records that
 * cannot join to outcomes.
 *
 * Modeled on the execution-economics report pattern.
 *
 * @module tool-decision-report
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { listCorpusSessions, readDecisionRows, readOutcomeLabels } from './tool-decision-corpus.ts';
import type { ToolDecisionRow, LabeledDecisionRow } from './tool-decision-schema.ts';

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

export interface ToolDecisionReport {
  repoDir: string;
  totalSessions: number;
  totalRows: number;
  byPhase: Record<string, number>;
  byDecisionKind: Record<string, number>;
  missingPolicyMenu: number;
  missingProviderMenu: number;
  digestOnlyPolicyMenu: number;
  digestOnlyProviderMenu: number;
  unknownModels: string[];
  unknownTools: string[];
  absentPropensity: number;
  unjoinableOutcomes: number;
  labeledRows: number;
  status: 'ok' | 'no_records';
}

export interface BuildToolDecisionReportOptions {
  repoDir?: string;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildToolDecisionReport(
  options: BuildToolDecisionReportOptions = {},
): ToolDecisionReport {
  const repoDir = options.repoDir ?? process.cwd();
  const sessions = listCorpusSessions(repoDir);

  const byPhase: Record<string, number> = {};
  const byDecisionKind: Record<string, number> = {};
  const unknownModels = new Set<string>();
  const unknownTools = new Set<string>();
  let totalRows = 0;
  let missingPolicyMenu = 0;
  let missingProviderMenu = 0;
  let digestOnlyPolicyMenu = 0;
  let digestOnlyProviderMenu = 0;
  let absentPropensity = 0;
  let unjoinableOutcomes = 0;
  let labeledRows = 0;

  for (const sessionId of sessions) {
    const rows = readDecisionRows(repoDir, sessionId);
    const labels = readOutcomeLabels(repoDir, sessionId);
    labeledRows += labels.length;

    for (const row of rows) {
      totalRows++;
      byPhase[row.phase] = (byPhase[row.phase] ?? 0) + 1;
      byDecisionKind[row.decisionKind] = (byDecisionKind[row.decisionKind] ?? 0) + 1;

      if (!row.policyMenu) missingPolicyMenu++;
      else if (row.policyMenu.availability === 'digest_only') digestOnlyPolicyMenu++;

      if (!row.providerMenu) missingProviderMenu++;
      else if (row.providerMenu.availability === 'digest_only') digestOnlyProviderMenu++;

      if (row.propensity.source === 'unavailable') absentPropensity++;

      if (row.chosenTool && !KNOWN_NATIVE_TOOLS.has(row.chosenTool)) {
        unknownTools.add(row.chosenTool);
      }
    }

    // Check label join coverage
    const labeledCallIds = new Set(
      labels.map((l) => l.decision.toolCallEventId).filter(Boolean),
    );
    for (const row of rows) {
      if (row.toolCallEventId && !labeledCallIds.has(row.toolCallEventId)) {
        unjoinableOutcomes++;
      }
    }
  }

  return {
    repoDir,
    totalSessions: sessions.length,
    totalRows,
    byPhase,
    byDecisionKind,
    missingPolicyMenu,
    missingProviderMenu,
    digestOnlyPolicyMenu,
    digestOnlyProviderMenu,
    unknownModels: [...unknownModels].sort(),
    unknownTools: [...unknownTools].sort(),
    absentPropensity,
    unjoinableOutcomes,
    labeledRows,
    status: totalRows > 0 ? 'ok' : 'no_records',
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export function renderToolDecisionReport(report: ToolDecisionReport): string {
  const lines: string[] = [];
  lines.push('Tool Decision Corpus Report (HOK-2076)');
  lines.push(`  Repo: ${report.repoDir}`);
  lines.push(`  Sessions: ${report.totalSessions}  Rows: ${report.totalRows}  Labeled: ${report.labeledRows}`);
  lines.push('');

  if (report.status === 'no_records') {
    lines.push('  No decision rows found.');
    return lines.join('\n');
  }

  lines.push('  By phase:');
  for (const [phase, count] of Object.entries(report.byPhase).sort()) {
    lines.push(`    ${phase}: ${count}`);
  }

  lines.push('  By decision kind:');
  for (const [kind, count] of Object.entries(report.byDecisionKind).sort()) {
    lines.push(`    ${kind}: ${count}`);
  }

  lines.push('');
  lines.push('  Quality warnings:');
  if (report.missingPolicyMenu > 0) {
    lines.push(`    Missing policy menu: ${report.missingPolicyMenu}`);
  }
  if (report.missingProviderMenu > 0) {
    lines.push(`    Missing provider menu: ${report.missingProviderMenu}`);
  }
  if (report.digestOnlyPolicyMenu > 0) {
    lines.push(`    Digest-only policy menu (no artifact): ${report.digestOnlyPolicyMenu}`);
  }
  if (report.digestOnlyProviderMenu > 0) {
    lines.push(`    Digest-only provider menu (no artifact): ${report.digestOnlyProviderMenu}`);
  }
  if (report.absentPropensity > 0) {
    lines.push(`    Absent propensity: ${report.absentPropensity}`);
  }
  if (report.unjoinableOutcomes > 0) {
    lines.push(`    Unjoinable outcomes: ${report.unjoinableOutcomes}`);
  }
  if (report.unknownTools.length > 0) {
    lines.push(`    Unknown tools: ${report.unknownTools.join(', ')}`);
  }
  if (report.unknownModels.length > 0) {
    lines.push(`    Unknown models: ${report.unknownModels.join(', ')}`);
  }

  const warningCount =
    report.missingPolicyMenu + report.missingProviderMenu +
    report.digestOnlyPolicyMenu + report.digestOnlyProviderMenu +
    report.absentPropensity + report.unjoinableOutcomes +
    report.unknownTools.length + report.unknownModels.length;
  if (warningCount === 0) {
    lines.push('    (none)');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Known native tools (for unknown-tool detection)
// ---------------------------------------------------------------------------

const KNOWN_NATIVE_TOOLS = new Set([
  'Read', 'Edit', 'Write', 'MultiEdit', 'Bash', 'Grep', 'Glob', 'LS',
  'WebFetch', 'WebSearch',
  'TodoRead', 'TodoWrite',
  'NotebookRead', 'NotebookEdit',
  'Agent', 'Task', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskStop', 'TaskUpdate',
]);
