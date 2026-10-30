import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditManualEditAttribution } from './manual-edit-attribution-audit.ts';
import type { PrCommit } from './intervention-detector.ts';

function writeEvalsJsonl(repoDir: string, records: unknown[]): void {
  const evalsDir = join(repoDir, '.wavemill', 'evals');
  mkdirSync(evalsDir, { recursive: true });
  writeFileSync(
    join(evalsDir, 'evals.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );
}

function writeArchivedCodingResult(repoDir: string, issueId: string, startedAt: string, finishedAt: string | null): void {
  const archiveDir = join(repoDir, '.wavemill', 'evals', 'artifacts', issueId);
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(join(archiveDir, '.coding-result.json'), JSON.stringify({
    stage: 'coding',
    status: finishedAt ? 'completed' : 'running',
    startedAt,
    finishedAt,
    agent: 'native-openrouter',
    model: 'devstral-small',
    notes: '',
  }));
}

describe('auditManualEditAttribution (HOK-2894 backfill)', () => {
  it('classifies a record with an out-of-window commit as suspect', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'audit-suspect-'));
    try {
      writeEvalsJsonl(repoDir, [
        { id: 'rec-1', issueId: 'HOK-1001', prUrl: 'https://github.com/acme/repo/pull/42', agentType: 'native-openrouter' },
      ]);
      writeArchivedCodingResult(repoDir, 'HOK-1001', '2026-08-27T10:00:00Z', '2026-08-27T10:30:00Z');

      const commits: PrCommit[] = [
        {
          sha: 'aaa1111000000000000',
          message: 'commit long after coding finished',
          author: 'timogilvie',
          date: '2026-08-27T14:00:00Z',
        },
      ];

      const report = auditManualEditAttribution(
        { repoDir },
        { fetchPrCommits: () => commits },
      );

      assert.equal(report.audited, 1);
      assert.equal(report.suspectRecords, 1);
      assert.equal(report.cleanRecords, 0);
      assert.equal(report.unknownRecords, 0);
      assert.equal(report.operatorCommits, 1);
      assert.equal(report.findings[0].classification, 'suspect');
      assert.deepEqual(report.findings[0].operatorCommitShas, ['aaa1111']);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('classifies a record with only in-window commits as clean', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'audit-clean-'));
    try {
      writeEvalsJsonl(repoDir, [
        { id: 'rec-2', issueId: 'HOK-1002', prUrl: 'https://github.com/acme/repo/pull/43', agentType: 'native-openrouter' },
      ]);
      writeArchivedCodingResult(repoDir, 'HOK-1002', '2026-08-27T10:00:00Z', '2026-08-27T10:30:00Z');

      const commits: PrCommit[] = [
        {
          sha: 'bbb2222000000000000',
          message: 'commit inside the coding window',
          author: 'timogilvie',
          date: '2026-08-27T10:10:00Z',
        },
      ];

      const report = auditManualEditAttribution(
        { repoDir },
        { fetchPrCommits: () => commits },
      );

      assert.equal(report.audited, 1);
      assert.equal(report.cleanRecords, 1);
      assert.equal(report.suspectRecords, 0);
      assert.equal(report.operatorCommits, 0);
      assert.equal(report.findings[0].classification, 'clean');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('classifies a record with no archived stage results as unknown, never guessing', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'audit-unknown-'));
    try {
      writeEvalsJsonl(repoDir, [
        { id: 'rec-3', issueId: 'HOK-1003', prUrl: 'https://github.com/acme/repo/pull/44', agentType: 'codex' },
      ]);
      // No archived stage results written for HOK-1003 — worktree and its
      // route-artifact archive are both gone.

      const commits: PrCommit[] = [
        {
          sha: 'ccc3333000000000000',
          message: 'commit with no attribution evidence available',
          author: 'timogilvie',
          date: '2026-08-27T10:10:00Z',
        },
      ];

      const report = auditManualEditAttribution(
        { repoDir },
        { fetchPrCommits: () => commits },
      );

      assert.equal(report.audited, 1);
      assert.equal(report.unknownRecords, 1);
      assert.equal(report.suspectRecords, 0);
      assert.equal(report.operatorCommits, 0);
      assert.equal(report.findings[0].classification, 'unknown');
      assert.deepEqual(report.findings[0].unknownCommitShas, ['ccc3333']);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('skips records with no PR url or no issueId', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'audit-skip-'));
    try {
      writeEvalsJsonl(repoDir, [
        { id: 'rec-4', issueId: 'HOK-1004' }, // no prUrl
        { id: 'rec-5', prUrl: 'https://github.com/acme/repo/pull/45' }, // no issueId
      ]);

      const report = auditManualEditAttribution({ repoDir }, { fetchPrCommits: () => [] });

      assert.equal(report.audited, 0);
      assert.deepEqual(report.findings, []);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('respects the issueId filter and the limit option', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'audit-filter-'));
    try {
      writeEvalsJsonl(repoDir, [
        { id: 'rec-6', issueId: 'HOK-2001', prUrl: 'https://github.com/acme/repo/pull/1', agentType: 'codex' },
        { id: 'rec-7', issueId: 'HOK-2002', prUrl: 'https://github.com/acme/repo/pull/2', agentType: 'codex' },
      ]);

      const filtered = auditManualEditAttribution({ repoDir, issueId: 'HOK-2002' }, { fetchPrCommits: () => [] });
      assert.equal(filtered.audited, 1);
      assert.equal(filtered.findings[0].issueId, 'HOK-2002');

      const limited = auditManualEditAttribution({ repoDir, limit: 1 }, { fetchPrCommits: () => [] });
      assert.equal(limited.audited, 1);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
