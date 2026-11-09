/**
 * Claude CLI stdout interpreter (HOK-3448).
 *
 * Parses Claude CLI output in both standard object envelope format and verbose array format.
 * Extracts and validates ReportFindings tool reports when present.
 */

export interface ReviewToolReport {
  source: 'claude-cli:ReportFindings';
  sessionId: string;
  toolUseId: string;
  findings: ReportedReviewFinding[];
}

export interface ReportedReviewFinding {
  file: string;
  line?: number;
  severity: 'blocker' | 'warning';
  category: string;
  short_summary?: string;
  summary: string;
  failure_scenario: string;
  verdict?: 'CONFIRMED' | 'PLAUSIBLE';
}

export interface ClaudeCliOutput {
  text: string;                       // result element's `result` (trimmed); raw stdout if not JSON
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };   // same arithmetic as today (input + cache_creation + cache_read)
  costUsd?: number;
  reportedModel?: string;             // reportedModelFromEnvelope (moved here, llm-cli's most-output-tokens rule)
  sessionId?: string;                 // result element's session_id
  error?: string;                     // is_error message (object or result element)
  toolReport?: ReviewToolReport;      // validated ReportFindings report (see below)
  toolReportError?: string;           // a report was present but rejected (why)
}

/**
 * Parse Claude CLI output, handling both object envelope and verbose array formats.
 * Extracts ReportFindings tool reports when present and validates them.
 */
export function parseClaudeCliOutput(stdout: string, opts?: { expectedSessionId?: string }): ClaudeCliOutput {
  // Handle non-JSON output
  if (!stdout.trim().startsWith('{') && !stdout.trim().startsWith('[')) {
    return { text: stdout.trim() };
  }

  let data: any;
  try {
    data = JSON.parse(stdout);
  } catch {
    // If JSON parse fails, treat the entire output as text (fallback)
    return { text: stdout.trim() };
  }

  // Handle array format (--verbose output)
  if (Array.isArray(data)) {
    return parseVerboseArray(data, opts?.expectedSessionId);
  }

  // Handle object envelope format
  return parseObjectEnvelope(data);
}

function parseObjectEnvelope(data: any): ClaudeCliOutput {
  // Check for is_error envelope and return error
  if (data.is_error === true) {
    const errorMsg = data.error || 'Unknown error';
    return { text: '', error: `claude CLI returned is_error: ${errorMsg}` };
  }

  // Extract text from data.result if present
  const text = (data.result || '').trim();

  // Extract usage if present
  let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
  if (data.usage) {
    const u = data.usage;
    const inputTokens =
      (u.input_tokens || 0) +
      (u.cache_creation_input_tokens || 0) +
      (u.cache_read_input_tokens || 0);
    const outputTokens = u.output_tokens || 0;
    usage = {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }

  // Extract cost if present
  const costUsd = data.total_cost_usd;
  const reportedModel = reportedModelFromEnvelope(data.modelUsage);
  const sessionId = data.session_id;

  const result: ClaudeCliOutput = { text };
  if (usage) result.usage = usage;
  if (costUsd !== undefined) result.costUsd = costUsd;
  if (reportedModel) result.reportedModel = reportedModel;
  if (sessionId) result.sessionId = sessionId;
  
  return result;
}

function parseVerboseArray(data: any[], expectedSessionId?: string): ClaudeCliOutput {
  // Find the last result element
  let resultElement: any = null;
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i].type === 'result') {
      resultElement = data[i];
      break;
    }
  }

  if (!resultElement) {
    return { text: '', error: 'claude CLI verbose output had no result element' };
  }

  // Check for is_error in result element
  if (resultElement.is_error === true) {
    const errorMsg = resultElement.error || 'Unknown error';
    return { text: '', error: errorMsg };
  }

  // Parse the result element as an object envelope
  const result = parseObjectEnvelope(resultElement);
  
  // Extract ReportFindings if present
  const reportResult = extractReportFindings(data, expectedSessionId || resultElement.session_id);
  if (reportResult.toolReport) {
    result.toolReport = reportResult.toolReport;
  }
  if (reportResult.toolReportError) {
    result.toolReportError = reportResult.toolReportError;
  }
  
  return result;
}

function extractReportFindings(messages: any[], sessionId: string): { toolReport?: ReviewToolReport; toolReportError?: string } {
  const toolUses: Array<{ id: string; input: any; parent_tool_use_id: string | null; session_id: string }> = [];
  const toolResults: Record<string, { is_error?: boolean }> = {};
  
  // Collect tool_use and tool_result blocks
  for (const message of messages) {
    if (message.type === 'assistant' && Array.isArray(message.content)) {
      for (const content of message.content) {
        if (content.type === 'tool_use' && content.name === 'ReportFindings') {
          toolUses.push({
            id: content.id,
            input: content.input,
            parent_tool_use_id: content.parent_tool_use_id || null,
            session_id: message.session_id
          });
        }
      }
    } else if (message.type === 'user' && message.content?.tool_result) {
      toolResults[message.content.tool_result.tool_use_id] = {
        is_error: message.content.tool_result.is_error
      };
    }
  }
  
  // No ReportFindings calls
  if (toolUses.length === 0) {
    return {};
  }
  
  // Too many ReportFindings calls
  if (toolUses.length > 1) {
    return { toolReportError: `ambiguous: ${toolUses.length} ReportFindings calls` };
  }
  
  const toolUse = toolUses[0];
  
  // Check session binding
  if (toolUse.session_id !== sessionId) {
    return { toolReportError: 'foreign-session' };
  }
  
  // Check parent_tool_use_id (must be null for main thread)
  if (toolUse.parent_tool_use_id !== null) {
    return { toolReportError: 'subagent-report' };
  }
  
  // Check for matching tool_result
  const toolResult = toolResults[toolUse.id];
  if (!toolResult) {
    return { toolReportError: 'missing-tool-result' };
  }
  
  // Check if tool_result has error
  if (toolResult.is_error) {
    return { toolReportError: 'tool-result-error' };
  }
  
  // Validate input
  try {
    const findings = validateReportFindingsInput(toolUse.input);
    return {
      toolReport: {
        source: 'claude-cli:ReportFindings',
        sessionId: toolUse.session_id,
        toolUseId: toolUse.id,
        findings
      }
    };
  } catch (error) {
    return { toolReportError: (error as Error).message };
  }
}

function validateReportFindingsInput(input: any): ReportedReviewFinding[] {
  // Check top-level keys
  const allowedTopLevelKeys = new Set(['findings', 'level']);
  for (const key of Object.keys(input)) {
    if (!allowedTopLevelKeys.has(key)) {
      throw new Error(`unknown-top-level-key: ${key}`);
    }
  }
  
  // Check findings array
  if (!Array.isArray(input.findings)) {
    throw new Error('findings-not-array');
  }
  
  const findings: ReportedReviewFinding[] = [];
  
  for (const finding of input.findings) {
    // Check required fields
    if (!finding.file || typeof finding.file !== 'string' || finding.file.trim() === '') {
      throw new Error('missing-or-invalid-file');
    }
    
    if (!finding.summary || typeof finding.summary !== 'string' || finding.summary.trim() === '') {
      throw new Error('missing-or-invalid-summary');
    }
    
    if (!finding.failure_scenario || typeof finding.failure_scenario !== 'string' || finding.failure_scenario.trim() === '') {
      throw new Error('missing-or-invalid-failure-scenario');
    }
    
    if (!finding.category || typeof finding.category !== 'string' || finding.category.trim() === '') {
      throw new Error('missing-or-invalid-category');
    }
    
    // Check severity
    if (!finding.severity || typeof finding.severity !== 'string') {
      throw new Error('missing-severity');
    }
    
    if (finding.severity !== 'blocker' && finding.severity !== 'warning') {
      throw new Error(`invalid-severity: ${finding.severity}`);
    }
    
    // Check line if present
    if (finding.line !== undefined && (!Number.isInteger(finding.line) || finding.line < 0)) {
      throw new Error('invalid-line-number');
    }
    
    // Check verdict if present
    if (finding.verdict !== undefined && finding.verdict !== 'CONFIRMED' && finding.verdict !== 'PLAUSIBLE') {
      throw new Error('invalid-verdict');
    }
    
    // Check for outcome (reject if present)
    if (finding.outcome !== undefined) {
      throw new Error('outcome-present');
    }
    
    // Check for unknown keys
    const allowedKeys = new Set([
      'file', 'line', 'severity', 'category', 
      'short_summary', 'summary', 'failure_scenario', 'verdict'
    ]);
    
    for (const key of Object.keys(finding)) {
      if (!allowedKeys.has(key)) {
        throw new Error(`unknown-finding-key: ${key}`);
      }
    }
    
    // Build validated finding
    const validatedFinding: ReportedReviewFinding = {
      file: finding.file,
      severity: finding.severity as 'blocker' | 'warning',
      category: finding.category,
      summary: finding.summary,
      failure_scenario: finding.failure_scenario
    };
    
    if (typeof finding.line === 'number') {
      validatedFinding.line = finding.line;
    }
    
    if (typeof finding.short_summary === 'string') {
      validatedFinding.short_summary = finding.short_summary;
    }
    
    if (finding.verdict === 'CONFIRMED' || finding.verdict === 'PLAUSIBLE') {
      validatedFinding.verdict = finding.verdict;
    }
    
    findings.push(validatedFinding);
  }
  
  return findings;
}

/**
 * Extract error from Claude CLI stdout, handling both object and array formats.
 */
export function claudeCliErrorFromStdout(stdout: string): string | undefined {
  if (!stdout.trim().startsWith('{')) {
    return undefined;
  }

  let data: any;
  try {
    data = JSON.parse(stdout);
  } catch {
    return undefined;
  }

  // Handle array format (--verbose output)
  if (Array.isArray(data)) {
    // Find the last result element
    let resultElement: any = null;
    for (let i = data.length - 1; i >= 0; i--) {
      if (data[i].type === 'result') {
        resultElement = data[i];
        break;
      }
    }

    if (resultElement && resultElement.is_error === true) {
      return resultElement.error || 'Unknown error';
    }
    
    return undefined;
  }

  // Handle object envelope format
  if (data.is_error === true) {
    return data.error || 'Unknown error';
  }

  return undefined;
}

/**
 * Pick the model the claude CLI reports as having served the turn from its
 * `modelUsage` map (HOK-3247). The map can hold helper models next to the main
 * one, so the entry with the most output tokens wins; `canonicalModel` is
 * preferred over the map key when present. Returns undefined when the
 * envelope reports no model — callers must then treat identity as unverified.
 */
export function reportedModelFromEnvelope(modelUsage: unknown): string | undefined {
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) {
    return undefined;
  }
  let best: { model: string; outputTokens: number } | undefined;
  for (const [key, usage] of Object.entries(modelUsage as Record<string, { outputTokens?: number; canonicalModel?: string } | undefined>)) {
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