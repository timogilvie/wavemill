import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runSourceGuard } from './lib/source-guard.ts';
import { REVIEW_REPORT_BOUNDARY_GUARD } from './check-review-report-boundary.ts';

function write(repo: string, relPath: string, contents: string): void {
  const fullPath = join(repo, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

function track(repo: string): void {
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' });
}

describe('REVIEW_REPORT_BOUNDARY_GUARD', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'review-report-boundary-'));
    execFileSync('git', ['init', '-q', repo]);
    write(repo, 'tools/review-report-boundary-allowlist.txt', '');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  // protects: retired text-completion helpers must not reappear.
  it('reports looksLikeJson and unwrapJsonEnvelope', () => {
    write(repo, 'shared/lib/review-engine.ts', 'export function looksLikeJson() {}\n');
    track(repo);
    const findings = runSourceGuard(REVIEW_REPORT_BOUNDARY_GUARD, repo).findings;
    assert.deepEqual(findings.map((f) => `${f.file}:${f.pattern}`).sort(), [
      'shared/lib/review-engine.ts:retired-text-completion',
    ]);
  });

  // protects: the ReportFindings literal is scoped to the boundary module.
  it('reports ReportFindings outside the boundary module', () => {
    write(repo, 'shared/lib/review-engine.ts', 'if (x.name === "ReportFindings") {}\n');
    track(repo);
    const findings = runSourceGuard(REVIEW_REPORT_BOUNDARY_GUARD, repo).findings;
    assert.deepEqual(findings.map((f) => `${f.file}:${f.pattern}`).sort(), [
      'shared/lib/review-engine.ts:private-report-findings',
    ]);
  });

  // protects: envelope member reads outside the boundary are forbidden.
  it('reports private claude envelope reads', () => {
    write(repo, 'shared/lib/model-adapters/claude-cli-adapter.ts', 'const x = data.modelUsage; const y = data.total_cost_usd; if (z.is_error) {}\n');
    track(repo);
    const findings = runSourceGuard(REVIEW_REPORT_BOUNDARY_GUARD, repo).findings.map((f) => `${f.file}:${f.pattern}`).sort();
    assert.ok(findings.includes('shared/lib/model-adapters/claude-cli-adapter.ts:private-claude-envelope-is_error'));
    assert.ok(findings.includes('shared/lib/model-adapters/claude-cli-adapter.ts:private-claude-envelope-total_cost_usd'));
    assert.ok(findings.includes('shared/lib/model-adapters/claude-cli-adapter.ts:private-claude-envelope-modelUsage'));
  });

  // protects: a suppression marker silences a finding.
  it('honours an inline allow-review-report-boundary marker', () => {
    write(repo, 'shared/lib/widget.ts', [
      '# allow-review-report-boundary: fixture intentionally names ReportFindings',
      'const x = "ReportFindings";',
      '',
    ].join('\n'));
    track(repo);
    assert.deepEqual(runSourceGuard(REVIEW_REPORT_BOUNDARY_GUARD, repo).findings, []);
  });

  // protects: the guard runs clean against the real tree (ratchet: empty allowlist).
  it('runs clean on the current repository', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    const result = runSourceGuard(REVIEW_REPORT_BOUNDARY_GUARD, repoRoot);
    assert.deepEqual(result.findings, []);
  });
});