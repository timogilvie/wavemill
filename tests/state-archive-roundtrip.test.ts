/**
 * tests/state-archive-roundtrip.test.ts (HOK-3190)
 *
 * Round-trip test: given a state file with history and tombstones that overflow
 * the configured cap, running the archive migration preserves every record
 * (hot ∪ archive == original), the archive is append-only JSONL, and a second
 * run is a no-op (idempotent).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  archiveFromHotState,
  archivePaths,
  readArchiveHistory,
  readArchiveTombstones,
  findArchivedTombstoneByIssue,
} from '../shared/lib/state-archive.ts';

function makeHistoryRecord(issue: string, idx: number, daysOld: number): Record<string, unknown> {
  const t = new Date(Date.now() - daysOld * 86_400_000).toISOString();
  return {
    issue,
    prNumber: String(1000 + idx),
    branch: `feat/${issue.toLowerCase()}`,
    worktree: `/tmp/wt/${issue.toLowerCase()}`,
    runEpoch: `epoch-${idx}`,
    attempt: `a${idx}`,
    createdAt: t,
    status: 'merged',
    slug: `slug-${idx}`,
  };
}

function makeTombstone(issue: string, idx: number, daysOld: number): Record<string, unknown> {
  return { ...makeHistoryRecord(issue, idx, daysOld), decisionStatus: 'reaped' };
}

test('archiveFromHotState preserves every record and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wavemill-archive-test-'));
  try {
    const state: Record<string, unknown> = {
      session: 'test',
      tasks: {},
      terminalTaskHistory: { tasks: {}, challengePairs: {} },
      terminalTaskTombstones: {},
    };

    const history = state.terminalTaskHistory as {
      tasks: Record<string, unknown>;
      challengePairs: Record<string, Record<string, unknown>>;
    };
    const tombs = state.terminalTaskTombstones as Record<string, unknown>;

    for (let i = 0; i < 20; i++) {
      const issue = `HOK-${100 + i}`;
      history.tasks[issue] = makeHistoryRecord(issue, i, i < 5 ? 1 : 30);
      tombs[`${issue}|${1000 + i}|${'epoch-' + i}|a${i}`] = makeTombstone(issue, i, i < 5 ? 1 : 30);
    }
    const originalHistoryKeys = Object.keys(history.tasks);
    const originalTombKeys = Object.keys(tombs);
    assert.equal(originalHistoryKeys.length, 20);
    assert.equal(originalTombKeys.length, 20);

    const first = archiveFromHotState(state, { stateDir: dir, keep: 5, maxAgeDays: 7 });
    assert.ok(first.archivedHistory > 0, 'first run archives something');
    assert.equal(first.hotHistoryAfter, 5, 'hot history trimmed to keep');
    assert.equal(first.hotTombstonesAfter, 5, 'hot tombstones trimmed to keep');

    // Archive files written and well-formed.
    const paths = archivePaths(dir);
    assert.ok(existsSync(paths.history));
    assert.ok(existsSync(paths.tombstones));
    const hArch = readArchiveHistory(dir);
    const tArch = readArchiveTombstones(dir);
    assert.equal(hArch.length + Object.keys(history.tasks).length, 20);
    assert.equal(tArch.length + Object.keys(tombs).length, 20);

    // Every original record appears in hot ∪ archive.
    const seenIssues = new Set<string>([
      ...Object.keys(history.tasks),
      ...hArch.map((r) => String(r.issue)),
    ]);
    for (const issue of originalHistoryKeys) {
      assert.ok(seenIssues.has(issue), `issue ${issue} must appear in hot or archive`);
    }

    // Second run is a no-op: nothing new archived.
    const historyBeforeSecond = Object.keys(history.tasks).length;
    const tombsBeforeSecond = Object.keys(tombs).length;
    const second = archiveFromHotState(state, { stateDir: dir, keep: 5, maxAgeDays: 7 });
    assert.equal(second.archivedHistory, 0, 'second run archives no history');
    assert.equal(second.archivedTombstones, 0, 'second run archives no tombstones');
    assert.equal(Object.keys(history.tasks).length, historyBeforeSecond);
    assert.equal(Object.keys(tombs).length, tombsBeforeSecond);

    // Archive-aware tombstone lookup works for an archived issue.
    const archivedIssue = hArch[0]?.issue as string | undefined;
    if (archivedIssue) {
      const found = findArchivedTombstoneByIssue(dir, archivedIssue);
      assert.ok(found, `findArchivedTombstoneByIssue(${archivedIssue}) returns a record`);
      assert.equal(found!.issue, archivedIssue);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archiveFromHotState writes compact JSONL (no pretty-printing)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wavemill-archive-compact-'));
  try {
    const state: Record<string, unknown> = {
      tasks: {},
      terminalTaskHistory: {
        tasks: {
          'HOK-A': makeHistoryRecord('HOK-A', 0, 30),
          'HOK-B': makeHistoryRecord('HOK-B', 1, 30),
          'HOK-C': makeHistoryRecord('HOK-C', 2, 30),
        },
        challengePairs: {},
      },
      terminalTaskTombstones: {},
    };
    archiveFromHotState(state, { stateDir: dir, keep: 0, maxAgeDays: 0 });
    const content = readFileSync(archivePaths(dir).history, 'utf-8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    for (const line of lines) {
      // compact means no leading indent, no multi-line objects
      assert.doesNotMatch(line, /^\s/);
      assert.doesNotMatch(line, /:\s{2,}/);
    }
    assert.equal(lines.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
