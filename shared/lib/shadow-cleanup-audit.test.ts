/**
 * Tests for the shadow-cleanup ledger audit (HOK-2957).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditShadowLedger, formatAuditReport } from './shadow-cleanup-audit.ts';
import { appendShadowCleanupDecision, readShadowLedger, resolveShadowLedgerPath } from './shadow-cleanup-ledger.ts';

function withTempRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'wavemill-shadow-audit-'));
  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

test('resolveShadowLedgerPath defaults to .wavemill/shadow/cleanup-decisions.jsonl', () => {
  const p = resolveShadowLedgerPath('/tmp/repo');
  assert.equal(p, '/tmp/repo/.wavemill/shadow/cleanup-decisions.jsonl');
});

test('appendShadowCleanupDecision writes newline-delimited JSON', () => {
  const { repoDir, cleanup } = withTempRepo();
  try {
    appendShadowCleanupDecision(repoDir, {
      branch: 'task/x',
      classification: 'safe_ancestor',
      mode: 'shadow',
      wouldDelete: true,
      issue: 'HOK-1',
    });
    appendShadowCleanupDecision(repoDir, {
      branch: 'task/y',
      classification: 'retain_dirty',
      mode: 'shadow',
      wouldDelete: false,
      issue: 'HOK-2',
    });
    const entries = readShadowLedger(repoDir);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].branch, 'task/x');
    assert.equal(entries[0].wouldDelete, true);
    assert.equal(entries[1].wouldDelete, false);
  } finally {
    cleanup();
  }
});

test('auditShadowLedger flags a would-delete with missing PR evidence as a disagreement', () => {
  const { repoDir, cleanup } = withTempRepo();
  try {
    appendShadowCleanupDecision(repoDir, {
      branch: 'task/a',
      classification: 'safe_terminal_pr_head',
      mode: 'shadow',
      wouldDelete: true,
      issue: 'HOK-100',
      evidence: {
        prState: 'MERGED',
        prHeadSha: 'aaaa',
        localHead: 'bbbb', // mismatch
      },
    });
    const summary = auditShadowLedger(repoDir);
    assert.equal(summary.proposedDeletes, 1);
    assert.equal(summary.safeAgreements, 0);
    assert.equal(summary.disagreements.length, 1);
    assert.match(summary.disagreements[0].reason, /!= local head/);
    assert.equal(summary.ready, false);
  } finally {
    cleanup();
  }
});

test('auditShadowLedger accepts safe_ancestor without PR evidence', () => {
  const { repoDir, cleanup } = withTempRepo();
  try {
    appendShadowCleanupDecision(repoDir, {
      branch: 'task/a',
      classification: 'safe_ancestor',
      mode: 'shadow',
      wouldDelete: true,
      issue: 'HOK-101',
    });
    const summary = auditShadowLedger(repoDir);
    assert.equal(summary.proposedDeletes, 1);
    assert.equal(summary.safeAgreements, 1);
    assert.equal(summary.disagreements.length, 0);
    assert.equal(summary.ready, true);
  } finally {
    cleanup();
  }
});

test('auditShadowLedger accepts matching PR headRefOid == final head', () => {
  const { repoDir, cleanup } = withTempRepo();
  try {
    appendShadowCleanupDecision(repoDir, {
      branch: 'task/b',
      classification: 'safe_terminal_pr_head',
      mode: 'shadow',
      wouldDelete: true,
      issue: 'HOK-200',
      evidence: {
        prState: 'MERGED',
        prHeadSha: 'deadbeef',
        finalHead: 'deadbeef',
      },
    });
    const summary = auditShadowLedger(repoDir);
    assert.equal(summary.disagreements.length, 0);
    assert.equal(summary.ready, true);
  } finally {
    cleanup();
  }
});

test('auditShadowLedger flags an unrecognized classification as a disagreement', () => {
  const { repoDir, cleanup } = withTempRepo();
  try {
    appendShadowCleanupDecision(repoDir, {
      branch: 'task/c',
      classification: 'weird_new_class',
      mode: 'shadow',
      wouldDelete: true,
    });
    const summary = auditShadowLedger(repoDir);
    assert.equal(summary.disagreements.length, 1);
    assert.match(summary.disagreements[0].reason, /unrecognized classification/);
  } finally {
    cleanup();
  }
});

test('formatAuditReport is a plain-text summary', () => {
  const { repoDir, cleanup } = withTempRepo();
  try {
    appendShadowCleanupDecision(repoDir, {
      branch: 'task/z',
      classification: 'safe_ancestor',
      mode: 'shadow',
      wouldDelete: true,
    });
    const summary = auditShadowLedger(repoDir);
    const report = formatAuditReport(summary);
    assert.match(report, /Shadow Cleanup Ledger Audit/);
    assert.match(report, /safe_ancestor/);
    assert.match(report, /Ready for enforce/);
  } finally {
    cleanup();
  }
});

test('would-not-delete entries never contribute to the disagreement count', () => {
  const { repoDir, cleanup } = withTempRepo();
  try {
    appendShadowCleanupDecision(repoDir, {
      branch: 'task/d',
      classification: 'retain_dirty',
      mode: 'shadow',
      wouldDelete: false,
    });
    const summary = auditShadowLedger(repoDir);
    assert.equal(summary.proposedDeletes, 0);
    assert.equal(summary.disagreements.length, 0);
    assert.equal(summary.ready, false, 'no proposed deletes means not ready to enforce');
  } finally {
    cleanup();
  }
});
