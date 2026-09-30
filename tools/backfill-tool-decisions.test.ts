import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach } from 'node:test';

import { buildPlanningWithToolCall } from '../shared/lib/native-agent/fixtures/tool-decision/build.ts';
import {
  readToolDecisionCorpus,
  resolveToolDecisionCorpusPath,
} from '../shared/lib/native-agent/tool-decision-corpus.ts';
import { backfillToolDecisions } from './backfill-tool-decisions.ts';

function tempDir(): string {
  const dir = join(tmpdir(), `backfill-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch {
    // best-effort
  }
}

function writeSessionStream(dir: string, events: unknown[], filename: string): string {
  const path = join(dir, filename);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return path;
}

function setFileTime(path: string, date: Date): void {
  const time = date.getTime() / 1000;
  utimesSync(path, time, time);
}

describe('backfillToolDecisions', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) cleanup(d);
  });

  it('harvests rows from a worktree corpus into the main repo', () => {
    const mainDir = tempDir(); dirs.push(mainDir);
    const worktreeDir = join(mainDir, 'worktrees/test-wt');
    const worktreeCorpusDir = join(worktreeDir, '.wavemill/tool-decisions');
    mkdirSync(worktreeCorpusDir, { recursive: true });

    writeSessionStream(
      worktreeCorpusDir,
      [
        JSON.parse('{"schemaVersion":"1","decisionId":"d1","sessionId":"s1","traceId":"t1","phase":"planning","turnIndex":0,"stepIndex":0,"sourceEventIds":[],"provider":"claude","model":"claude-3-5-sonnet","runtime":"native","kind":"tool_call","state":{"priorToolCallCount":0,"priorErrorFlag":false,"priorErrorCount":0,"terminalSynthesis":false,"priorPolicyDenials":0},"propensity":{"provenance":"surrogate"},"timestamp":0,"causalEventIds":[]}'),
        JSON.parse('{"schemaVersion":"1","decisionId":"d2","sessionId":"s1","traceId":"t1","phase":"planning","turnIndex":0,"stepIndex":0,"sourceEventIds":[],"provider":"claude","model":"claude-3-5-sonnet","runtime":"native","kind":"tool_call","state":{"priorToolCallCount":0,"priorErrorFlag":false,"priorErrorCount":0,"terminalSynthesis":false,"priorPolicyDenials":0},"propensity":{"provenance":"surrogate"},"timestamp":0,"causalEventIds":[]}'),
      ],
      'corpus.jsonl',
    );

    const summary = backfillToolDecisions({
      repoDir: mainDir,
      harvestOnly: true,
      dryRun: false,
    });

    assert.equal(summary.harvest?.attempted, 1);
    assert.equal(summary.harvest?.processed, 1);
    assert.equal(summary.harvest?.rows, 2);

    // Side effect: rows appended to main corpus
    const mainCorpusPath = resolveToolDecisionCorpusPath({ repoDir: mainDir });
    assert.equal(existsSync(mainCorpusPath), true);
    const mainRows = readToolDecisionCorpus(mainCorpusPath);
    const harvestedIds = new Set(mainRows.map((r) => r.decisionId));
    assert.equal(harvestedIds.has('d1'), true);
    assert.equal(harvestedIds.has('d2'), true);

    // Side effect: worktree-local corpus directory removed
    assert.equal(existsSync(worktreeCorpusDir), false);
  });

  it('skips session streams older than the --since date', () => {
    const mainDir = tempDir(); dirs.push(mainDir);
    const eventsDir = join(mainDir, '.wavemill/session-events');
    mkdirSync(eventsDir, { recursive: true });

    const oldDate = new Date('2026-09-21T00:00:00Z');
    const newDate = new Date('2026-09-23T00:00:00Z');

    const oldPath = writeSessionStream(
      eventsDir,
      buildPlanningWithToolCall(),
      'wavemill-old.jsonl',
    );
    const newPath = writeSessionStream(
      eventsDir,
      buildPlanningWithToolCall(),
      'wavemill-new.jsonl',
    );

    setFileTime(oldPath, oldDate);
    setFileTime(newPath, newDate);

    const since = new Date('2026-09-22T00:00:00Z');
    const summary = backfillToolDecisions({
      repoDir: mainDir,
      harvestOnly: false,
      backfillOnly: true,
      since,
      dryRun: true, // dry-run to just count
    });

    assert.equal(summary.backfill?.skipped, 1);
    assert.equal(summary.backfill?.processed, 1);
  });

  it('respects --dry-run and does not mutate corpus', () => {
    const mainDir = tempDir(); dirs.push(mainDir);
    const eventsDir = join(mainDir, '.wavemill/session-events');
    mkdirSync(eventsDir, { recursive: true });

    const streamPath = writeSessionStream(
      eventsDir,
      buildPlanningWithToolCall(),
      'wavemill-test.jsonl',
    );
    setFileTime(streamPath, new Date('2026-09-23T00:00:00Z'));

    const summary1 = backfillToolDecisions({
      repoDir: mainDir,
      dryRun: true,
    });

    const mainCorpusPath = resolveToolDecisionCorpusPath({ repoDir: mainDir });
    assert.equal(existsSync(mainCorpusPath), false);

    // Actual run should produce a corpus
    const summary2 = backfillToolDecisions({
      repoDir: mainDir,
      dryRun: false,
    });

    assert.ok((summary2.backfill?.appended ?? 0) > 0);
    assert.ok(existsSync(mainCorpusPath));
  });

  it('is idempotent: second run appends zero rows', () => {
    const mainDir = tempDir(); dirs.push(mainDir);
    const eventsDir = join(mainDir, '.wavemill/session-events');
    mkdirSync(eventsDir, { recursive: true });

    const streamPath = writeSessionStream(
      eventsDir,
      buildPlanningWithToolCall(),
      'wavemill-test.jsonl',
    );
    setFileTime(streamPath, new Date('2026-09-23T00:00:00Z'));

    const first = backfillToolDecisions({
      repoDir: mainDir,
      dryRun: false,
    });

    const second = backfillToolDecisions({
      repoDir: mainDir,
      dryRun: false,
    });

    assert.ok((first.backfill?.appended ?? 0) > 0);
    assert.equal(second.backfill?.appended, 0);
  });

  it('handles harvest-only mode', () => {
    const mainDir = tempDir(); dirs.push(mainDir);
    const worktreeDir = join(mainDir, 'worktrees/harvest-wt');
    const worktreeCorpusDir = join(worktreeDir, '.wavemill/tool-decisions');
    mkdirSync(worktreeCorpusDir, { recursive: true });

    writeSessionStream(
      worktreeCorpusDir,
      [
        JSON.parse('{"schemaVersion":"1","decisionId":"hw1","sessionId":"s1","traceId":"t1","phase":"planning","turnIndex":0,"stepIndex":0,"sourceEventIds":[],"provider":"claude","model":"claude-3-5-sonnet","runtime":"native","kind":"tool_call","state":{"priorToolCallCount":0,"priorErrorFlag":false,"priorErrorCount":0,"terminalSynthesis":false,"priorPolicyDenials":0},"propensity":{"provenance":"surrogate"},"timestamp":0,"causalEventIds":[]}'),
      ],
      'corpus.jsonl',
    );

    // Also create a session stream that would be picked up if backfill ran
    const eventsDir = join(mainDir, '.wavemill/session-events');
    mkdirSync(eventsDir, { recursive: true });
    const streamPath = writeSessionStream(
      eventsDir,
      buildPlanningWithToolCall(),
      'wavemill-should-be-ignored.jsonl',
    );
    setFileTime(streamPath, new Date('2026-09-23T00:00:00Z'));

    const summary = backfillToolDecisions({
      repoDir: mainDir,
      harvestOnly: true,
      dryRun: false,
    });

    assert.ok(summary.harvest);
    assert.equal(summary.backfill, undefined);

    // Side effect: harvested row landed in main corpus, and only the harvested row
    const mainCorpusPath = resolveToolDecisionCorpusPath({ repoDir: mainDir });
    assert.equal(existsSync(mainCorpusPath), true);
    const mainRows = readToolDecisionCorpus(mainCorpusPath);
    const ids = new Set(mainRows.map((r) => r.decisionId));
    assert.equal(ids.has('hw1'), true);

    // Side effect: worktree-local corpus directory removed
    assert.equal(existsSync(worktreeCorpusDir), false);
  });

  it('handles backfill-only mode', () => {
    const mainDir = tempDir(); dirs.push(mainDir);
    const eventsDir = join(mainDir, '.wavemill/session-events');
    mkdirSync(eventsDir, { recursive: true });

    const streamPath = writeSessionStream(
      eventsDir,
      buildPlanningWithToolCall(),
      'wavemill-test.jsonl',
    );
    setFileTime(streamPath, new Date('2026-09-23T00:00:00Z'));

    const summary = backfillToolDecisions({
      repoDir: mainDir,
      backfillOnly: true,
      dryRun: false,
    });

    assert.equal(summary.harvest, undefined);
    assert.ok(summary.backfill);
  });
});
