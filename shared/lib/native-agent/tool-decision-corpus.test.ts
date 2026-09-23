import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach } from 'node:test';

import { buildPlanningWithToolCall } from './fixtures/tool-decision/build.ts';
import {
  appendToolDecisions,
  readToolDecisionCorpus,
  resolveToolDecisionCorpusPath,
} from './tool-decision-corpus.ts';
import { projectSessionEventsToDecisions } from './tool-decision-projector.ts';
import { TOOL_DECISION_SCHEMA_VERSION, type ToolDecisionRow } from './tool-decision-schema.ts';

function tempDir(): string {
  const dir = join(tmpdir(), `tool-decision-corpus-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch {
    // best-effort
  }
}

describe('tool-decision corpus writer', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) cleanup(d);
  });

  it('appends new rows and skips duplicates by decisionId', () => {
    const dir = tempDir(); dirs.push(dir);
    const path = resolveToolDecisionCorpusPath({ explicitDir: dir });
    const { rows } = projectSessionEventsToDecisions({
      events: buildPlanningWithToolCall(),
    });
    const first = appendToolDecisions(rows, path);
    assert.equal(first.appended, rows.length);
    assert.equal(first.skippedDuplicates, 0);
    assert.ok(existsSync(path));

    // Re-run projection → identical decisionIds → should skip.
    const second = appendToolDecisions(rows, path);
    assert.equal(second.appended, 0);
    assert.equal(second.skippedDuplicates, rows.length);

    // File contents survive round-trip.
    const readBack = readToolDecisionCorpus(path);
    assert.equal(readBack.length, rows.length);
    assert.equal(readBack[0].decisionId, rows[0].decisionId);
  });

  it('quarantines invalid rows without writing them', () => {
    const dir = tempDir(); dirs.push(dir);
    const path = resolveToolDecisionCorpusPath({ explicitDir: dir });
    const bogus: ToolDecisionRow = {
      schemaVersion: 'garbage',
      decisionId: 'x',
      sessionId: 's',
      traceId: 't',
      phase: 'coding',
      turnIndex: 0,
      stepIndex: 0,
      sourceEventIds: [],
      provider: 'p',
      model: 'm',
      runtime: 'native',
      kind: 'tool_call',
      state: {
        priorToolCallCount: 0,
        priorErrorFlag: false,
        priorErrorCount: 0,
        terminalSynthesis: false,
        priorPolicyDenials: 0,
      },
      propensity: { provenance: 'surrogate' },
      timestamp: 0,
      causalEventIds: [],
    };
    const res = appendToolDecisions([bogus], path);
    assert.equal(res.appended, 0);
    assert.equal(res.rejected.length, 1);
    assert.equal(res.rejected[0].decisionId, 'x');
    assert.equal(existsSync(path), false);
  });

  it('resolveToolDecisionCorpusPath honors namespace', () => {
    const dir = tempDir(); dirs.push(dir);
    const p1 = resolveToolDecisionCorpusPath({ explicitDir: dir });
    const p2 = resolveToolDecisionCorpusPath({ explicitDir: dir, namespace: 'planning' });
    assert.notEqual(p1, p2);
    assert.ok(p1.endsWith('/corpus.jsonl'));
    assert.ok(p2.endsWith('/planning.jsonl'));
  });

  it('writes bytes that reparse cleanly', () => {
    const dir = tempDir(); dirs.push(dir);
    const path = resolveToolDecisionCorpusPath({ explicitDir: dir });
    const { rows } = projectSessionEventsToDecisions({
      events: buildPlanningWithToolCall(),
    });
    appendToolDecisions(rows, path);
    const content = readFileSync(path, 'utf-8');
    assert.match(content, /"schemaVersion":"1"/);
    assert.equal(content.trim().split('\n').length, rows.length);
    // Version pinning sanity.
    assert.equal(TOOL_DECISION_SCHEMA_VERSION, '1');
  });
});
