import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claudeCliErrorFromStdout,
  parseClaudeCliOutput,
  reportedModelFromEnvelope,
} from './claude-cli-output.ts';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '../../../tests/fixtures/claude-cli');

function fixture(name: string): string {
  return readFileSync(join(fixtureDir, name), 'utf8');
}

describe('parseClaudeCliOutput', () => {
  // protects: object envelope keeps the same text/usage/cost/model contract
  // that unwrapJsonEnvelope provided (HOK-3448).
  it('parses a successful object envelope', () => {
    const stdout = JSON.stringify({
      result: 'done',
      usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 },
      total_cost_usd: 0.00123,
      modelUsage: { 'claude-haiku-4-5': { requests: 1 } },
    });
    const out = parseClaudeCliOutput(stdout);
    assert.equal(out.text, 'done');
    assert.equal(out.usage?.inputTokens, 15);
    assert.equal(out.usage?.outputTokens, 3);
    assert.equal(out.usage?.totalTokens, 18);
    assert.equal(out.costUsd, 0.00123);
    assert.equal(out.reportedModel, 'claude-haiku-4-5');
    assert.equal(out.error, undefined);
    assert.equal(out.toolReport, undefined);
  });

  // protects: the verbose array form is supported and the result element wins.
  it('parses a verbose array and returns the result session id', () => {
    const stdout = JSON.stringify([
      { type: 'system', session_id: '01367a57-7b0a-439d-83a9-bc35579a7a33' },
      { type: 'assistant', session_id: '01367a57-7b0a-439d-83a9-bc35579a7a33', content: [{ type: 'text', text: 'hi' }] },
      {
        type: 'result',
        session_id: '01367a57-7b0a-439d-83a9-bc35579a7a33',
        result: 'ready',
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: { 'claude-sonnet-5': { outputTokens: 1 } },
      },
    ]);
    const out = parseClaudeCliOutput(stdout);
    assert.equal(out.text, 'ready');
    assert.equal(out.sessionId, '01367a57-7b0a-439d-83a9-bc35579a7a33');
    assert.equal(out.reportedModel, 'claude-sonnet-5');
  });

  // protects: non-JSON stdout falls back to trimmed text.
  it('falls back to raw stdout when it is not JSON', () => {
    const out = parseClaudeCliOutput('  plain text  ');
    assert.equal(out.text, 'plain text');
    assert.equal(out.error, undefined);
  });

  // protects: HOK-3325 fixture replays exactly three validated findings.
  it('extracts the HOK-3325 ReportFindings report', () => {
    const stdout = fixture('hok3325-report-findings.verbose.json');
    const out = parseClaudeCliOutput(stdout, { expectedSessionId: '01367a57-7b0a-439d-83a9-bc35579a7a33' });
    assert.equal(out.error, undefined);
    assert.ok(out.toolReport);
    assert.equal(out.toolReport?.source, 'claude-cli:ReportFindings');
    assert.equal(out.toolReport?.sessionId, '01367a57-7b0a-439d-83a9-bc35579a7a33');
    assert.equal(out.toolReport?.toolUseId, 'toolu_01HOK3325');
    assert.equal(out.toolReport?.findings.length, 3);
    const [f1, f2, f3] = out.toolReport!.findings;
    assert.equal(f1.file, 'src/review/engine.ts');
    assert.equal(f1.line, 42);
    assert.equal(f1.severity, 'warning');
    assert.equal(f1.category, 'error_handling');
    assert.equal(f1.verdict, 'CONFIRMED');
    assert.equal(f2.file, 'src/review/formatter.ts');
    assert.equal(f2.line, 88);
    assert.equal(f3.file, 'tests/review/engine.test.ts');
    assert.equal(f3.line, 155);
    assert.equal(out.toolReportError, undefined);
  });

  // protects: a verbose array with no result element is reported as an error.
  it('reports an error when the verbose array has no result element', () => {
    const stdout = JSON.stringify([{ type: 'assistant', content: [] }]);
    const out = parseClaudeCliOutput(stdout);
    assert.equal(out.error, 'claude CLI verbose output had no result element');
  });
});

describe('ReportFindings validation', () => {
  function buildReport(overrides: Record<string, unknown> = {}) {
    return {
      findings: [
        {
          file: 'a.ts',
          line: 1,
          severity: 'warning',
          category: 'logic',
          short_summary: 'short',
          summary: 'summary',
          failure_scenario: 'fs',
          verdict: 'CONFIRMED',
          ...overrides,
        },
      ],
    };
  }

  function makeStdout(input: unknown, extra?: unknown) {
    return JSON.stringify([
      { type: 'assistant', session_id: 's1', content: [{ type: 'tool_use', name: 'ReportFindings', id: 't1', input, parent_tool_use_id: null }] },
      { type: 'user', session_id: 's1', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] },
      { type: 'result', session_id: 's1', result: 'ok' },
      ...(extra ? [extra] : []),
    ]);
  }

  // protects: each invalid shape produces a distinct toolReportError.
  it('rejects a missing severity', () => {
    const out = parseClaudeCliOutput(makeStdout(buildReport({ severity: undefined })));
    assert.ok(out.toolReportError);
    assert.equal(out.toolReport, undefined);
  });

  it('rejects an unknown severity', () => {
    const out = parseClaudeCliOutput(makeStdout(buildReport({ severity: 'info' })));
    assert.match(out.toolReportError ?? '', /severity must be blocker or warning/);
    assert.equal(out.toolReport, undefined);
  });

  it('rejects an unknown finding key', () => {
    const out = parseClaudeCliOutput(makeStdout(buildReport({ extra_field: 'x' })));
    assert.match(out.toolReportError ?? '', /unknown finding key/);
    assert.equal(out.toolReport, undefined);
  });

  it('rejects outcome in a finding', () => {
    const out = parseClaudeCliOutput(makeStdout(buildReport({ outcome: 'fixed' })));
    assert.match(out.toolReportError ?? '', /outcome is not allowed/);
    assert.equal(out.toolReport, undefined);
  });

  it('rejects ambiguous multiple calls', () => {
    const stdout = JSON.stringify([
      { type: 'assistant', session_id: 's1', content: [
        { type: 'tool_use', name: 'ReportFindings', id: 't1', input: buildReport(), parent_tool_use_id: null },
        { type: 'tool_use', name: 'ReportFindings', id: 't2', input: buildReport(), parent_tool_use_id: null },
      ] },
      { type: 'user', session_id: 's1', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] },
      { type: 'result', session_id: 's1', result: 'ok' },
    ]);
    const out = parseClaudeCliOutput(stdout);
    assert.match(out.toolReportError ?? '', /ambiguous/);
    assert.equal(out.toolReport, undefined);
  });

  it('rejects a subagent report', () => {
    const stdout = JSON.stringify([
      { type: 'assistant', session_id: 's1', content: [{ type: 'tool_use', name: 'ReportFindings', id: 't1', input: buildReport(), parent_tool_use_id: 'parent' }] },
      { type: 'user', session_id: 's1', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] },
      { type: 'result', session_id: 's1', result: 'ok' },
    ]);
    const out = parseClaudeCliOutput(stdout);
    assert.equal(out.toolReportError, 'subagent-report');
    assert.equal(out.toolReport, undefined);
  });

  it('rejects a foreign session id', () => {
    const stdout = JSON.stringify([
      { type: 'assistant', session_id: 'other-session', content: [{ type: 'tool_use', name: 'ReportFindings', id: 't1', input: buildReport(), parent_tool_use_id: null }] },
      { type: 'user', session_id: 'other-session', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] },
      { type: 'result', session_id: 's1', result: 'ok' },
    ]);
    const out = parseClaudeCliOutput(stdout, { expectedSessionId: 's1' });
    assert.equal(out.toolReportError, 'foreign-session');
    assert.equal(out.toolReport, undefined);
  });

  it('rejects an unbound report when an owned session is expected', () => {
    const stdout = JSON.stringify([
      { type: 'assistant', content: [{ type: 'tool_use', name: 'ReportFindings', id: 't1', input: buildReport(), parent_tool_use_id: null }] },
      { type: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] },
      { type: 'result', session_id: 's1', result: 'ok' },
    ]);
    const out = parseClaudeCliOutput(stdout, { expectedSessionId: 's1' });
    assert.equal(out.toolReportError, 'missing-session');
    assert.equal(out.toolReport, undefined);
  });

  it('rejects a tool_result with is_error', () => {
    const stdout = JSON.stringify([
      { type: 'assistant', session_id: 's1', content: [{ type: 'tool_use', name: 'ReportFindings', id: 't1', input: buildReport(), parent_tool_use_id: null }] },
      { type: 'user', session_id: 's1', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] },
      { type: 'result', session_id: 's1', result: 'ok' },
    ]);
    const out = parseClaudeCliOutput(stdout);
    assert.equal(out.toolReportError, 'tool_result.is_error');
    assert.equal(out.toolReport, undefined);
  });

  it('rejects a missing tool_result', () => {
    const stdout = JSON.stringify([
      { type: 'assistant', session_id: 's1', content: [{ type: 'tool_use', name: 'ReportFindings', id: 't1', input: buildReport(), parent_tool_use_id: null }] },
      { type: 'result', session_id: 's1', result: 'ok' },
    ]);
    const out = parseClaudeCliOutput(stdout);
    assert.equal(out.toolReportError, 'missing tool_result');
    assert.equal(out.toolReport, undefined);
  });

  it('rejects findings that are not an array', () => {
    const out = parseClaudeCliOutput(makeStdout({ findings: 'none' }));
    assert.match(out.toolReportError ?? '', /findings not an array/);
    assert.equal(out.toolReport, undefined);
  });

  // protects: an owned tool call riding with a foreign result element would
  // attribute another session's model/usage/cost to this invocation.
  it('fails closed when the result element belongs to a foreign session', () => {
    const stdout = JSON.stringify([
      { type: 'assistant', session_id: 's1', content: [{ type: 'tool_use', name: 'ReportFindings', id: 't1', input: buildReport(), parent_tool_use_id: null }] },
      { type: 'user', session_id: 's1', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] },
      { type: 'result', session_id: 'other-session', result: 'ok', total_cost_usd: 9, modelUsage: { 'claude-opus-5-5': { outputTokens: 5 } } },
    ]);
    const out = parseClaudeCliOutput(stdout, { expectedSessionId: 's1' });
    assert.ok(out.error);
    assert.equal(out.toolReportError, 'result-foreign-session');
    assert.equal(out.toolReport, undefined);
    assert.equal(out.costUsd, undefined);
    assert.equal(out.reportedModel, undefined);
    assert.equal(out.sessionId, undefined);
  });

  // protects: an owned invocation must not accept a result element with no session binding.
  it('fails closed when the result element has no session id for an owned session', () => {
    const stdout = JSON.stringify([
      { type: 'assistant', session_id: 's1', content: [{ type: 'tool_use', name: 'ReportFindings', id: 't1', input: buildReport(), parent_tool_use_id: null }] },
      { type: 'user', session_id: 's1', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] },
      { type: 'result', result: 'ok' },
    ]);
    const out = parseClaudeCliOutput(stdout, { expectedSessionId: 's1' });
    assert.ok(out.error);
    assert.equal(out.toolReportError, 'result-missing-session');
    assert.equal(out.toolReport, undefined);
  });

  // protects: the matching tool_result from a foreign session must not confirm an owned call.
  it('rejects a matching tool_result from a foreign session', () => {
    const stdout = JSON.stringify([
      { type: 'assistant', session_id: 's1', content: [{ type: 'tool_use', name: 'ReportFindings', id: 't1', input: buildReport(), parent_tool_use_id: null }] },
      { type: 'user', session_id: 'other-session', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] },
      { type: 'result', session_id: 's1', result: 'ok' },
    ]);
    const out = parseClaudeCliOutput(stdout, { expectedSessionId: 's1' });
    assert.equal(out.toolReportError, 'tool_result-foreign-session');
    assert.equal(out.toolReport, undefined);
  });

  // protects: an owned call whose tool_result element carries no session id is unbound.
  it('rejects a matching tool_result with no session id for an owned session', () => {
    const stdout = JSON.stringify([
      { type: 'assistant', session_id: 's1', content: [{ type: 'tool_use', name: 'ReportFindings', id: 't1', input: buildReport(), parent_tool_use_id: null }] },
      { type: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] },
      { type: 'result', session_id: 's1', result: 'ok' },
    ]);
    const out = parseClaudeCliOutput(stdout, { expectedSessionId: 's1' });
    assert.equal(out.toolReportError, 'tool_result-missing-session');
    assert.equal(out.toolReport, undefined);
  });

  // protects: real CLI stream messages nest blocks under `message.content` and
  // carry `parent_tool_use_id` on the element; a parser reading only
  // `element.content` would silently find no report in real output.
  it('reads the real CLI message shape (message.content, element-level parent link)', () => {
    const ok = JSON.stringify([
      { type: 'assistant', session_id: 's1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'ReportFindings', id: 't1', input: buildReport() }] } },
      { type: 'user', session_id: 's1', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } },
      { type: 'result', session_id: 's1', result: 'ok' },
    ]);
    const out = parseClaudeCliOutput(ok, { expectedSessionId: 's1' });
    assert.equal(out.toolReportError, undefined);
    assert.equal(out.toolReport?.toolUseId, 't1');
    assert.equal(out.toolReport?.findings.length, 1);

    const subagent = JSON.stringify([
      { type: 'assistant', session_id: 's1', parent_tool_use_id: 'toolu_parent', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'ReportFindings', id: 't1', input: buildReport() }] } },
      { type: 'user', session_id: 's1', parent_tool_use_id: 'toolu_parent', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } },
      { type: 'result', session_id: 's1', result: 'ok' },
    ]);
    assert.equal(parseClaudeCliOutput(subagent, { expectedSessionId: 's1' }).toolReportError, 'subagent-report');
  });
});

describe('claudeCliErrorFromStdout', () => {
  // protects: non-zero exits recover the real error text from both forms.
  it('extracts the error from an object envelope', () => {
    const err = claudeCliErrorFromStdout(JSON.stringify({ is_error: true, error: 'rate limit' }));
    assert.equal(err, 'rate limit');
  });

  it('extracts the error from a verbose array', () => {
    const err = claudeCliErrorFromStdout(JSON.stringify([
      { type: 'assistant', content: [] },
      { type: 'result', is_error: true, error: 'context window exceeded' },
    ]));
    assert.equal(err, 'context window exceeded');
  });

  it('returns undefined for non-error stdout', () => {
    const err = claudeCliErrorFromStdout(JSON.stringify({ result: 'ok' }));
    assert.equal(err, undefined);
  });
});

describe('reportedModelFromEnvelope', () => {
  // protects: the dominant-output-tokens rule from llm-cli is preserved.
  it('prefers the entry with the most output tokens', () => {
    assert.equal(
      reportedModelFromEnvelope({
        'claude-haiku-4-5': { outputTokens: 12 },
        'claude-opus-5-5': { outputTokens: 900, canonicalModel: 'claude-opus-5-5' },
      }),
      'claude-opus-5-5',
    );
  });
});
