/**
 * One interpreter of Claude CLI stdout (HOK-3448).
 *
 * Handles:
 * - the object envelope from `-p --output-format json`;
 * - the verbose JSON array from `-p --output-format json --verbose`;
 * - `is_error`, usage/cost/model/session extraction;
 * - extraction and validation of the built-in `ReportFindings` tool report.
 *
 * No other module is allowed to parse Claude CLI stdout or a tool report.
 */

import type { ReportedReviewFinding, ReviewToolReport } from './transport-adapter.ts';

/** Canonical source value for a ReportFindings report (HOK-3448). */
export type ReportFindingsSource = 'claude-cli:ReportFindings';
export const REPORT_FINDINGS_SOURCE: ReportFindingsSource = 'claude-cli:ReportFindings';

export interface ClaudeCliOutput {
  /** Result element's `result` (trimmed); raw stdout if not JSON. */
  text: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  costUsd?: number;
  /** Model id reported by the CLI in the result element's `modelUsage`. */
  reportedModel?: string;
  /** Result element's `session_id`. */
  sessionId?: string;
  /** `is_error` message from the result element. */
  error?: string;
  /** Validated `ReportFindings` report (verbose array only). */
  toolReport?: ReviewToolReport;
  /** A report was present but rejected; consumers must fail closed. */
  toolReportError?: string;
}

interface EnvelopeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ResultEnvelope {
  type?: string;
  result?: string;
  usage?: EnvelopeUsage;
  total_cost_usd?: number;
  modelUsage?: Record<string, { outputTokens?: number; canonicalModel?: string } | undefined>;
  session_id?: string;
  is_error?: boolean;
  error?: string;
}

/** Pick the dominant model from the claude CLI's `modelUsage` map (HOK-3247). */
export function reportedModelFromEnvelope(modelUsage: unknown): string | undefined {
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) {
    return undefined;
  }
  let best: { model: string; outputTokens: number } | undefined;
  for (const [key, usage] of Object.entries(modelUsage as NonNullable<ResultEnvelope['modelUsage']>)) {
    const canonical = typeof usage?.canonicalModel === 'string' && usage.canonicalModel.trim()
      ? usage.canonicalModel.trim()
      : key.trim();
    if (!canonical) continue;
    const outputTokens = typeof usage?.outputTokens === 'number' && Number.isFinite(usage.outputTokens)
      ? usage.outputTokens
      : 0;
    if (!best || outputTokens > best.outputTokens) {
      best = { model: canonical, outputTokens };
    }
  }
  return best?.model;
}

function usageFromEnvelope(u: EnvelopeUsage | undefined) {
  if (!u) return undefined;
  const inputTokens =
    (u.input_tokens || 0) +
    (u.cache_creation_input_tokens || 0) +
    (u.cache_read_input_tokens || 0);
  const outputTokens = u.output_tokens || 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function resultEnvelopeFromArray(arr: unknown[]): ResultEnvelope | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    const el = arr[i];
    if (el && typeof el === 'object' && (el as { type?: string }).type === 'result') {
      return el as ResultEnvelope;
    }
  }
  return undefined;
}

interface VerboseElement {
  type?: string;
  session_id?: string;
  role?: string;
  content?: unknown;
}

interface ToolUseBlock {
  type: 'tool_use';
  name?: string;
  id?: string;
  input?: unknown;
  parent_tool_use_id?: string | null;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id?: string;
  is_error?: boolean;
}

function isToolUseBlock(block: unknown): block is ToolUseBlock {
  return (
    block !== null &&
    typeof block === 'object' &&
    (block as { type?: string }).type === 'tool_use'
  );
}

function isToolResultBlock(block: unknown): block is ToolResultBlock {
  return (
    block !== null &&
    typeof block === 'object' &&
    (block as { type?: string }).type === 'tool_result'
  );
}

function contentBlocks(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (content !== null && typeof content === 'object' && Array.isArray((content as { content?: unknown[] }).content)) {
    return (content as { content: unknown[] }).content;
  }
  return [];
}

const ALLOWED_TOP_KEYS = new Set(['findings', 'level']);
const ALLOWED_FINDING_KEYS = new Set([
  'file',
  'line',
  'severity',
  'category',
  'short_summary',
  'summary',
  'failure_scenario',
  'verdict',
  'outcome',
]);
const SEVERITIES = new Set(['blocker', 'warning']);
const VERDICTS = new Set(['CONFIRMED', 'PLAUSIBLE']);

function validateFindings(input: unknown): { findings: ReportedReviewFinding[]; error?: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { findings: [], error: 'findings not an array' };
  }
  const obj = input as Record<string, unknown>;
  const unknownTop = Object.keys(obj).filter((k) => !ALLOWED_TOP_KEYS.has(k));
  if (unknownTop.length > 0) {
    return { findings: [], error: `unknown top-level key: ${unknownTop[0]}` };
  }
  if (!Array.isArray(obj.findings)) {
    return { findings: [], error: 'findings not an array' };
  }
  const findings: ReportedReviewFinding[] = [];
  for (const item of obj.findings) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { findings: [], error: 'finding is not an object' };
    }
    const f = item as Record<string, unknown>;
    const unknownKey = Object.keys(f).find((k) => !ALLOWED_FINDING_KEYS.has(k));
    if (unknownKey) {
      return { findings: [], error: `unknown finding key: ${unknownKey}` };
    }
    if (typeof f.file !== 'string' || f.file.trim() === '') {
      return { findings: [], error: 'missing or empty file' };
    }
    if (typeof f.summary !== 'string' || f.summary.trim() === '') {
      return { findings: [], error: 'missing or empty summary' };
    }
    if (typeof f.failure_scenario !== 'string' || f.failure_scenario.trim() === '') {
      return { findings: [], error: 'missing or empty failure_scenario' };
    }
    if (typeof f.category !== 'string' || f.category.trim() === '') {
      return { findings: [], error: 'missing or empty category' };
    }
    if (typeof f.severity !== 'string' || !SEVERITIES.has(f.severity)) {
      return { findings: [], error: `severity must be blocker or warning: ${String(f.severity)}` };
    }
    if (f.line !== undefined) {
      if (!Number.isInteger(f.line)) {
        return { findings: [], error: 'line must be an integer' };
      }
    }
    if (f.verdict !== undefined) {
      if (typeof f.verdict !== 'string' || !VERDICTS.has(f.verdict)) {
        return { findings: [], error: `verdict must be CONFIRMED or PLAUSIBLE: ${String(f.verdict)}` };
      }
    }
    if ('outcome' in f) {
      return { findings: [], error: 'outcome is not allowed in a review report' };
    }
    const finding: ReportedReviewFinding = {
      file: f.file,
      severity: f.severity as 'blocker' | 'warning',
      category: f.category,
      summary: f.summary,
      failure_scenario: f.failure_scenario,
    };
    if (f.line !== undefined) finding.line = f.line as number;
    if (typeof f.short_summary === 'string' && f.short_summary.trim() !== '') {
      finding.short_summary = f.short_summary;
    }
    if (f.verdict !== undefined) finding.verdict = f.verdict as 'CONFIRMED' | 'PLAUSIBLE';
    findings.push(finding);
  }
  return { findings };
}

function extractToolReport(
  arr: unknown[],
  expectedSessionId: string | undefined,
): { toolReport?: ReviewToolReport; toolReportError?: string } {
  const resultEnvelope = resultEnvelopeFromArray(arr);
  const sessionId = expectedSessionId ?? resultEnvelope?.session_id;

  const calls: Array<{ id: string; input: unknown; elementSessionId?: string; parentId: string | null }> = [];
  for (const el of arr) {
    if (el === null || typeof el !== 'object') continue;
    const element = el as VerboseElement;
    if (element.type !== 'assistant' && element.role !== 'assistant') continue;
    for (const block of contentBlocks(element.content)) {
      if (!isToolUseBlock(block)) continue;
      if (block.name !== 'ReportFindings') continue;
      const id = block.id;
      if (typeof id !== 'string' || id === '') continue;
      calls.push({
        id,
        input: block.input,
        elementSessionId: element.session_id,
        parentId: block.parent_tool_use_id ?? null,
      });
    }
  }

  if (calls.length === 0) return {};
  if (calls.length > 1) {
    return { toolReportError: `ambiguous: ${calls.length} ReportFindings calls` };
  }

  const call = calls[0];
  if (call.parentId !== null) {
    return { toolReportError: 'subagent-report' };
  }
  if (sessionId !== undefined && call.elementSessionId !== undefined && call.elementSessionId !== sessionId) {
    return { toolReportError: 'foreign-session' };
  }

  let toolResultFound = false;
  let toolResultErrored = false;
  for (const el of arr) {
    if (el === null || typeof el !== 'object') continue;
    const element = el as VerboseElement;
    if (element.type !== 'user' && element.role !== 'user') continue;
    for (const block of contentBlocks(element.content)) {
      if (!isToolResultBlock(block)) continue;
      if (block.tool_use_id !== call.id) continue;
      toolResultFound = true;
      if (block.is_error === true) toolResultErrored = true;
    }
  }

  if (!toolResultFound) {
    return { toolReportError: 'missing tool_result' };
  }
  if (toolResultErrored) {
    return { toolReportError: 'tool_result.is_error' };
  }

  const validated = validateFindings(call.input);
  if (validated.error) {
    return { toolReportError: validated.error };
  }

  return {
    toolReport: {
      source: REPORT_FINDINGS_SOURCE,
      sessionId: call.elementSessionId ?? resultEnvelope?.session_id,
      toolUseId: call.id,
      findings: validated.findings,
    },
  };
}

/**
 * Parse claude CLI stdout into a normalized output object.
 *
 * Accepts:
 * - non-JSON text (fallback);
 * - a single object envelope (`--output-format json`);
 * - a verbose JSON array (`--output-format json --verbose`), using the last
 *   `type: "result"` element as the envelope.
 *
 * When `expectedSessionId` is provided, any `ReportFindings` tool call must be
 * bound to that session and to the main thread (`parent_tool_use_id == null`).
 */
export function parseClaudeCliOutput(
  stdout: string,
  opts?: { expectedSessionId?: string },
): ClaudeCliOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { text: stdout.trim() };
  }

  if (parsed === null || typeof parsed !== 'object') {
    return { text: stdout.trim() };
  }

  let envelope: ResultEnvelope | undefined;
  let isArray = false;
  if (Array.isArray(parsed)) {
    isArray = true;
    envelope = resultEnvelopeFromArray(parsed);
    if (!envelope) {
      return { text: stdout.trim(), error: 'claude CLI verbose output had no result element' };
    }
  } else {
    envelope = parsed as ResultEnvelope;
  }

  if (envelope.is_error === true) {
    return { text: stdout.trim(), error: envelope.error ?? 'claude CLI returned is_error with no message' };
  }

  const text = (envelope.result ?? stdout).trim();
  const out: ClaudeCliOutput = { text };
  const usage = usageFromEnvelope(envelope.usage);
  if (usage) out.usage = usage;
  if (envelope.total_cost_usd !== undefined) out.costUsd = envelope.total_cost_usd;
  const reportedModel = reportedModelFromEnvelope(envelope.modelUsage);
  if (reportedModel) out.reportedModel = reportedModel;
  if (typeof envelope.session_id === 'string' && envelope.session_id) {
    out.sessionId = envelope.session_id;
  }

  if (isArray) {
    const report = extractToolReport(parsed as unknown[], opts?.expectedSessionId ?? out.sessionId);
    if (report.toolReport) out.toolReport = report.toolReport;
    if (report.toolReportError) out.toolReportError = report.toolReportError;
  }

  return out;
}

/**
 * Extract the real error text from claude CLI stdout on a non-zero exit.
 *
 * Handles both the object envelope and the verbose array form, so the CLI's
 * own error message is never lost (HOK-3248).
 */
export function claudeCliErrorFromStdout(stdout: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;

  let envelope: ResultEnvelope | undefined;
  if (Array.isArray(parsed)) {
    envelope = resultEnvelopeFromArray(parsed as unknown[]);
  } else {
    envelope = parsed as ResultEnvelope;
  }

  if (envelope?.is_error === true) {
    const message = envelope.error;
    return typeof message === 'string' && message.length > 0 ? message : undefined;
  }
  return undefined;
}