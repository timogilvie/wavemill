/**
 * Tool-decision corpus quality reporter (HOK-2076).
 *
 * Walks a corpus JSONL and returns bounded counts + examples of:
 *   - missing logical menus (`available_tools` absent),
 *   - missing provider menus (`providerMenu` absent),
 *   - unknown model / tool identities (against a caller-supplied allowlist),
 *   - unavailable propensity provenance,
 *   - malformed rows or duplicate decisionIds,
 *   - absent / unjoinable outcome joins.
 *
 * Every counter comes with up to three example decisionIds so an operator
 * can spot-check the corpus without reading the whole file.
 */

import { readFileSync } from 'node:fs';

import {
  parseToolDecisionJsonl,
  validateToolDecisionRow,
  ToolDecisionParseError,
  type ToolDecisionRow,
} from './tool-decision-schema.ts';

const EXAMPLE_LIMIT = 3;

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

export interface CounterWithExamples {
  count: number;
  examples: string[];
}

export interface ToolDecisionCorpusReport {
  path: string;
  totalRows: number;
  malformedRows: CounterWithExamples;
  duplicateDecisionIds: CounterWithExamples;
  missingLogicalMenu: CounterWithExamples;
  missingProviderMenu: CounterWithExamples;
  unknownModel: CounterWithExamples;
  unknownTool: CounterWithExamples;
  unavailablePropensity: CounterWithExamples;
  missingOutcome: CounterWithExamples;
  unjoinableOutcome: CounterWithExamples;
  /** Roll-up: any row with at least one caution flag. */
  rowsWithAnyIssue: CounterWithExamples;
}

export interface ReportOptions {
  /** Known/expected model identities. Missing → all models pass through. */
  knownModels?: string[];
  /** Known/expected tool names. Missing → all tools pass through. */
  knownTools?: string[];
}

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

export function reportToolDecisionCorpusFile(
  path: string,
  options: ReportOptions = {},
): ToolDecisionCorpusReport {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyReport(path);
    }
    throw err;
  }
  return reportToolDecisionCorpusString(raw, path, options);
}

export function reportToolDecisionCorpusString(
  content: string,
  path: string,
  options: ReportOptions = {},
): ToolDecisionCorpusReport {
  const report = emptyReport(path);
  const knownModels = options.knownModels ? new Set(options.knownModels) : undefined;
  const knownTools = options.knownTools ? new Set(options.knownTools) : undefined;
  const seenDecisionIds = new Set<string>();

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      addExample(report.malformedRows, `line:${i + 1}`);
      report.malformedRows.count += 1;
      continue;
    }
    const check = validateToolDecisionRow(parsed);
    if (!check.ok) {
      const id =
        typeof (parsed as { decisionId?: unknown }).decisionId === 'string'
          ? (parsed as { decisionId: string }).decisionId
          : `line:${i + 1}`;
      addExample(report.malformedRows, `${id}:${check.reason}`);
      report.malformedRows.count += 1;
      continue;
    }
    const row: ToolDecisionRow = check.row;
    report.totalRows += 1;
    inspectRow(row, report, { knownModels, knownTools, seenDecisionIds });
  }

  // Roll-up.
  const anyIssueIds = new Set<string>();
  for (const bucket of [
    report.malformedRows,
    report.duplicateDecisionIds,
    report.missingLogicalMenu,
    report.missingProviderMenu,
    report.unknownModel,
    report.unknownTool,
    report.unavailablePropensity,
    report.missingOutcome,
    report.unjoinableOutcome,
  ]) {
    for (const ex of bucket.examples) anyIssueIds.add(ex);
  }
  report.rowsWithAnyIssue.count = anyIssueIds.size;
  report.rowsWithAnyIssue.examples = [...anyIssueIds].slice(0, EXAMPLE_LIMIT);

  return report;
}

/**
 * Parse and inspect a corpus already in memory. Throws
 * {@link ToolDecisionParseError} on malformed lines the same way the
 * parser does — for scripts that want fail-fast semantics.
 */
export function inspectParsedCorpus(
  content: string,
  path: string,
  options: ReportOptions = {},
): ToolDecisionCorpusReport {
  const rows = parseToolDecisionJsonl(content);
  const report = emptyReport(path);
  const knownModels = options.knownModels ? new Set(options.knownModels) : undefined;
  const knownTools = options.knownTools ? new Set(options.knownTools) : undefined;
  const seen = new Set<string>();
  for (const row of rows) {
    report.totalRows += 1;
    inspectRow(row, report, { knownModels, knownTools, seenDecisionIds: seen });
  }
  return report;
}

// ---------------------------------------------------------------------------
// Row-level checks
// ---------------------------------------------------------------------------

function inspectRow(
  row: ToolDecisionRow,
  report: ToolDecisionCorpusReport,
  ctx: {
    knownModels?: Set<string>;
    knownTools?: Set<string>;
    seenDecisionIds: Set<string>;
  },
): void {
  if (ctx.seenDecisionIds.has(row.decisionId)) {
    addExample(report.duplicateDecisionIds, row.decisionId);
    report.duplicateDecisionIds.count += 1;
  } else {
    ctx.seenDecisionIds.add(row.decisionId);
  }

  if (!row.toolMenu || row.toolMenu.toolNames.length === 0) {
    // Empty menu is legitimate for terminal synthesis; only tally when we
    // *also* have no provider menu — that's the ambiguous "missing" case.
    if (!row.state.terminalSynthesis) {
      addExample(report.missingLogicalMenu, row.decisionId);
      report.missingLogicalMenu.count += 1;
    }
  }
  if (!row.providerMenu) {
    if (!row.state.terminalSynthesis) {
      addExample(report.missingProviderMenu, row.decisionId);
      report.missingProviderMenu.count += 1;
    }
  }

  if (ctx.knownModels && !ctx.knownModels.has(row.model)) {
    addExample(report.unknownModel, row.decisionId);
    report.unknownModel.count += 1;
  }
  if (ctx.knownTools && row.chosenTool && !ctx.knownTools.has(row.chosenTool)) {
    addExample(report.unknownTool, row.decisionId);
    report.unknownTool.count += 1;
  }

  if (row.propensity.provenance === 'unavailable') {
    addExample(report.unavailablePropensity, row.decisionId);
    report.unavailablePropensity.count += 1;
  }

  if (!row.outcome) {
    addExample(report.missingOutcome, row.decisionId);
    report.missingOutcome.count += 1;
  } else if (row.outcome.status === 'unjoinable') {
    addExample(report.unjoinableOutcome, row.decisionId);
    report.unjoinableOutcome.count += 1;
  }
}

function addExample(counter: CounterWithExamples, id: string): void {
  if (counter.examples.length < EXAMPLE_LIMIT) counter.examples.push(id);
}

function emptyReport(path: string): ToolDecisionCorpusReport {
  return {
    path,
    totalRows: 0,
    malformedRows: { count: 0, examples: [] },
    duplicateDecisionIds: { count: 0, examples: [] },
    missingLogicalMenu: { count: 0, examples: [] },
    missingProviderMenu: { count: 0, examples: [] },
    unknownModel: { count: 0, examples: [] },
    unknownTool: { count: 0, examples: [] },
    unavailablePropensity: { count: 0, examples: [] },
    missingOutcome: { count: 0, examples: [] },
    unjoinableOutcome: { count: 0, examples: [] },
    rowsWithAnyIssue: { count: 0, examples: [] },
  };
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

export function formatCorpusReport(report: ToolDecisionCorpusReport): string {
  const lines: string[] = [];
  lines.push(`Tool-decision corpus report: ${report.path}`);
  lines.push(`  totalRows                  : ${report.totalRows}`);
  lines.push(`  malformedRows              : ${report.malformedRows.count}`);
  lines.push(`  duplicateDecisionIds       : ${report.duplicateDecisionIds.count}`);
  lines.push(`  missingLogicalMenu         : ${report.missingLogicalMenu.count}`);
  lines.push(`  missingProviderMenu        : ${report.missingProviderMenu.count}`);
  lines.push(`  unknownModel               : ${report.unknownModel.count}`);
  lines.push(`  unknownTool                : ${report.unknownTool.count}`);
  lines.push(`  unavailablePropensity      : ${report.unavailablePropensity.count}`);
  lines.push(`  missingOutcome             : ${report.missingOutcome.count}`);
  lines.push(`  unjoinableOutcome          : ${report.unjoinableOutcome.count}`);
  lines.push(`  rowsWithAnyIssue           : ${report.rowsWithAnyIssue.count}`);
  return lines.join('\n');
}

/** Exported for CLI parsers. */
export { ToolDecisionParseError };
