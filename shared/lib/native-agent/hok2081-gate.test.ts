/**
 * Tests for the HOK-2081 runtime gate.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isCounterfactualExplorationEnabled,
  readGateArtifact,
  resolveGateArtifactPath,
} from './hok2081-gate.ts';

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), 'hok2081-gate-'));
}

function writeGateArtifact(repoDir: string, body: unknown): string {
  const path = join(repoDir, '.wavemill', 'gates', 'HOK-2080.json');
  mkdirSync(join(repoDir, '.wavemill', 'gates'), { recursive: true });
  writeFileSync(path, JSON.stringify(body));
  return path;
}

describe('hok2081-gate: resolveGateArtifactPath', () => {
  it('returns the default path under the repo dir', () => {
    const repo = makeRepo();
    try {
      const path = resolveGateArtifactPath(repo);
      assert.ok(path.endsWith('.wavemill/gates/HOK-2080.json'));
      assert.ok(path.startsWith(repo));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('honours the WAVEMILL_HOK2080_GATE_PATH env override', () => {
    const previous = process.env.WAVEMILL_HOK2080_GATE_PATH;
    process.env.WAVEMILL_HOK2080_GATE_PATH = '/tmp/custom/gate.json';
    try {
      assert.equal(resolveGateArtifactPath(), '/tmp/custom/gate.json');
    } finally {
      if (previous === undefined) delete process.env.WAVEMILL_HOK2080_GATE_PATH;
      else process.env.WAVEMILL_HOK2080_GATE_PATH = previous;
    }
  });
});

describe('hok2081-gate: refusal reasons', () => {
  it('refuses when the artifact is missing', () => {
    const repo = makeRepo();
    try {
      const result = isCounterfactualExplorationEnabled(repo);
      assert.equal(result.enabled, false);
      if (!result.enabled) {
        assert.equal(result.reason, 'gate_artifact_missing');
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('refuses on malformed JSON', () => {
    const repo = makeRepo();
    try {
      const path = join(repo, '.wavemill', 'gates', 'HOK-2080.json');
      mkdirSync(join(repo, '.wavemill', 'gates'), { recursive: true });
      writeFileSync(path, '{not-json');
      const result = isCounterfactualExplorationEnabled(repo);
      assert.equal(result.enabled, false);
      if (!result.enabled) {
        assert.equal(result.reason, 'gate_artifact_malformed');
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('refuses when decision is not go', () => {
    const repo = makeRepo();
    try {
      writeGateArtifact(repo, {
        issueId: 'HOK-2080',
        decision: 'inconclusive',
        decidedAt: '2026-09-24T00:00:00Z',
      });
      const result = isCounterfactualExplorationEnabled(repo);
      assert.equal(result.enabled, false);
      if (!result.enabled) {
        assert.equal(result.reason, 'gate_decision_not_go');
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('refuses on issueId mismatch', () => {
    const repo = makeRepo();
    try {
      writeGateArtifact(repo, {
        issueId: 'HOK-1234',
        decision: 'go',
        decidedAt: '2026-09-24T00:00:00Z',
      });
      const result = isCounterfactualExplorationEnabled(repo);
      assert.equal(result.enabled, false);
      if (!result.enabled) {
        assert.equal(result.reason, 'gate_issue_id_mismatch');
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('refuses when report hash does not match', () => {
    const repo = makeRepo();
    try {
      const reportPath = join(repo, 'docs', 'report.md');
      mkdirSync(join(repo, 'docs'), { recursive: true });
      writeFileSync(reportPath, 'actual content');
      writeGateArtifact(repo, {
        issueId: 'HOK-2080',
        decision: 'go',
        decidedAt: '2026-09-24T00:00:00Z',
        reportPath: 'docs/report.md',
        reportSha256: 'deadbeef'.repeat(8),
      });
      const result = isCounterfactualExplorationEnabled(repo);
      assert.equal(result.enabled, false);
      if (!result.enabled) {
        assert.equal(result.reason, 'gate_report_hash_mismatch');
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('enables when every check passes', () => {
    const repo = makeRepo();
    try {
      const reportBody = '# report\n';
      const reportPath = join(repo, 'docs', 'report.md');
      mkdirSync(join(repo, 'docs'), { recursive: true });
      writeFileSync(reportPath, reportBody);
      const sha = createHash('sha256').update(reportBody).digest('hex');
      writeGateArtifact(repo, {
        issueId: 'HOK-2080',
        decision: 'go',
        decidedAt: '2026-09-24T00:00:00Z',
        reportPath: 'docs/report.md',
        reportSha256: sha,
      });
      const result = isCounterfactualExplorationEnabled(repo);
      assert.equal(result.enabled, true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('hok2081-gate: readGateArtifact', () => {
  it('returns the parsed artifact when present', () => {
    const repo = makeRepo();
    try {
      writeGateArtifact(repo, {
        issueId: 'HOK-2080',
        decision: 'go',
        decidedAt: '2026-09-24T00:00:00Z',
      });
      const { artifact } = readGateArtifact(repo);
      assert.ok(artifact);
      assert.equal(artifact?.decision, 'go');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
