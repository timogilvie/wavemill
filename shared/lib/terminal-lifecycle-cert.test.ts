import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildCertificationArtifact,
  collectShadowDecisionAudit,
  evaluateShadowGate,
  evaluateSoakGate,
  renderCertificationMarkdown,
} from './terminal-lifecycle-cert.ts';

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-lifecycle-cert-test-'));
  mkdirSync(join(dir, '.wavemill', 'incidents', 'cleanup-decisions'), { recursive: true });
  return dir;
}

test('shadow audit passes decisions with authority and final-head proof', () => {
  const repo = tempRepo();
  try {
    writeFileSync(join(repo, '.wavemill/incidents/cleanup-decisions/task__safe.json'), JSON.stringify({
      branch: 'task/safe',
      classification: 'safe_terminal_pr_head',
      safeToDelete: true,
      mode: 'shadow',
      wouldDelete: true,
      authority: 'PR #1 merged into auto/integration with headRefOid exactly equal to local head abc',
      finalCheckPassed: true,
      finalHeadSha: 'abc',
    }));
    const decisions = collectShadowDecisionAudit(repo);
    assert.equal(decisions.length, 1);
    assert.deepEqual(decisions[0].unsafeReasons, []);
    assert.equal(evaluateShadowGate(decisions).pass, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('shadow audit flags missing authority, head proof, and observer disagreement', () => {
  const repo = tempRepo();
  try {
    writeFileSync(join(repo, '.wavemill/incidents/cleanup-decisions/task__unsafe.json'), JSON.stringify({
      branch: 'task/unsafe',
      classification: 'safe_exact_remote',
      safeToDelete: true,
      mode: 'shadow',
      wouldDelete: true,
      finalCheckPassed: false,
      observerDisposition: 'retained',
    }));
    const gate = evaluateShadowGate(collectShadowDecisionAudit(repo));
    assert.equal(gate.pass, false);
    assert.match(gate.failures.join('\n'), /missing_authority/);
    assert.match(gate.failures.join('\n'), /missing_final_head_verification/);
    assert.match(gate.failures.join('\n'), /observer_disagreement/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

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
    assert.match(markdown, /Shadow/);
    assert.match(markdown, /Budgets/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
