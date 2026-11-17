import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  evaluateLaunchPriorityPersistence,
  getCertificationPersistBlockers,
  runCertifyLaunchPriorityModelCommand,
} from './certify-launch-priority-model.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'certify-launch-priority-'));
  tempDirs.push(dir);
  return dir;
}

function captureOutput() {
  const originalLog = console.log;
  const stdout: string[] = [];
  console.log = (...args: unknown[]) => stdout.push(args.join(' '));
  return {
    stdout,
    restore() {
      console.log = originalLog;
    },
  };
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('certify-launch-priority-model', () => {
  it('writes a report and audit without persisting eval rows by default', async () => {
    const tmp = makeTempDir();
    const reportPath = join(tmp, 'glm-report.json');
    const auditPath = join(tmp, 'audit.json');
    const cwd = process.cwd();
    const output = captureOutput();

    try {
      const report = await runCertifyLaunchPriorityModelCommand({
        model: 'glm-5.3',
        target: '3',
        live: false,
        persist: false,
        issue: 'HOK-2529',
        out: reportPath,
        'audit-out': auditPath,
        prompt: 'ping',
        json: false,
        'repo-dir': cwd,
      });

      assert.equal(report.persist, false);
      assert.equal(report.eval.executedRuns, 0);
      assert.equal(report.model.wavemillAlias, 'glm-5.3');
      assert.equal(existsSync(reportPath), true);
      assert.equal(existsSync(auditPath), true);
      const written = JSON.parse(readFileSync(reportPath, 'utf-8'));
      assert.equal(written.issue, 'HOK-2529');
    } finally {
      output.restore();
      process.chdir(cwd);
    }
  });

  it('reports blockers that must be cleared before persisting eval evidence', () => {
    const blockers = getCertificationPersistBlockers({
      checks: [
        { name: 'fixture', status: 'ok', detail: 'present' },
        { name: 'router-pools', status: 'blocker', detail: 'missing from coder pool' },
      ],
      dryRun: [
        { modelId: 'blocked-model', family: 'gpt', status: 'blocker', category: 'provider_unavailable', detail: 'not reachable' },
      ],
      live: { skipped: true, message: 'live smoke skipped' },
    });

    assert.deepEqual(blockers, [
      'router-pools: missing from coder pool',
      'dry-smoke blocked-model: not reachable',
      'live-smoke: live smoke skipped',
    ]);
  });

  it('uses provisional-observation-only to block launch-priority persistence for held aliases', () => {
    const decision = evaluateLaunchPriorityPersistence('ox-alpha');

    assert.equal(decision.eligible, false);
    assert.deepEqual(decision.reasons, ['provisional-observation-only']);
  });
});
