import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildCertificationArtifact,
  evaluateSoakGate,
  renderCertificationMarkdown,
} from './terminal-lifecycle-cert.ts';

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-lifecycle-cert-test-'));
  mkdirSync(join(dir, '.wavemill', 'incidents', 'cleanup-decisions'), { recursive: true });
  return dir;
}

test('soak gate rejects leak growth and repeated episodes', () => {
  const gate = evaluateSoakGate([
    { cycle: 1, timestamp: '2026-09-10T00:00:00.000Z', tmuxPanes: 0, worktrees: 1, branches: 1, tempEntries: 0, repeatedEpisodesBeforeRetry: 0 },
    { cycle: 2, timestamp: '2026-09-10T00:01:00.000Z', tmuxPanes: 1, worktrees: 1, branches: 2, tempEntries: 0, repeatedEpisodesBeforeRetry: 1 },
  ]);
  assert.equal(gate.pass, false);
  assert.match(gate.failures.join('\n'), /tmuxPanes_grew/);
  assert.match(gate.failures.join('\n'), /branches_grew/);
  assert.match(gate.failures.join('\n'), /repeated cleanup episodes/);
});

test('artifact and markdown include all gate verdicts', () => {
  const repo = tempRepo();
  try {
    const artifact = buildCertificationArtifact({
      repoDir: repo,
      runId: 'unit-cert',
      budgets: [{ name: 'idle-iteration', measured: 10, limit: 20, pass: true }],
    });
    assert.equal(artifact.schemaVersion, 1);
    assert.equal(artifact.gates.budgets.pass, true);
    const markdown = renderCertificationMarkdown(artifact);
    assert.match(markdown, /Terminal Lifecycle Certification Report/);
    assert.match(markdown, /Budgets/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
