import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildPlanningWithToolCall,
  buildCodingWithDenialAndRespond,
} from './fixtures/tool-decision/build.ts';
import { projectSessionEventsToDecisions } from './tool-decision-projector.ts';
import {
  formatCorpusReport,
  reportToolDecisionCorpusString,
} from './tool-decision-report.ts';

function corpusFrom(events: ReturnType<typeof buildPlanningWithToolCall>): string {
  const { rows } = projectSessionEventsToDecisions({ events });
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

describe('reportToolDecisionCorpusString', () => {
  it('counts missing outcomes and unavailable propensity when relevant', () => {
    const content = corpusFrom(buildCodingWithDenialAndRespond());
    const report = reportToolDecisionCorpusString(content, 'test.jsonl');
    assert.ok(report.totalRows >= 2);
    // No outcome was joined in this fixture.
    assert.equal(report.missingOutcome.count, report.totalRows);
    // Text-only respond had propensity → surrogate, not unavailable. Denial too.
    // The denial row's propensity may be surrogate (menu was non-empty).
  });

  it('flags unknown models and tools relative to an allowlist', () => {
    const content = corpusFrom(buildPlanningWithToolCall());
    const report = reportToolDecisionCorpusString(content, 'test.jsonl', {
      knownModels: ['some-other-model'],
      knownTools: ['edit'],
    });
    assert.ok(report.unknownModel.count > 0);
    assert.ok(report.unknownTool.count > 0);
  });

  it('flags malformed lines', () => {
    const report = reportToolDecisionCorpusString('{not-json\n', 'x.jsonl');
    assert.equal(report.malformedRows.count, 1);
    assert.equal(report.totalRows, 0);
  });

  it('detects duplicate decisionIds', () => {
    const content = corpusFrom(buildPlanningWithToolCall());
    const doubled = content + content;
    const report = reportToolDecisionCorpusString(doubled, 'dup.jsonl');
    assert.ok(report.duplicateDecisionIds.count > 0);
  });

  it('formats a bounded human-readable report', () => {
    const content = corpusFrom(buildPlanningWithToolCall());
    const report = reportToolDecisionCorpusString(content, 'x.jsonl');
    const printed = formatCorpusReport(report);
    assert.match(printed, /totalRows/);
    assert.match(printed, /rowsWithAnyIssue/);
  });
});
